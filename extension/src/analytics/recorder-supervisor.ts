import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';

import type {
  AnalyticsDetailCapture,
  AnalyticsDetailSink,
  AnalyticsObservation,
  AnalyticsSink,
} from '../../../shared/analytics/contracts.js';
import { analyticsProducerIdentity } from '../../../shared/analytics/transport.js';
import type { ProducerReconciliation } from './sqlite-recorder.js';
import { redactSensitiveText } from '../shared/sensitive-redaction.js';

export interface AnalyticsSubjectBindingReceipt {
  pendingOperationId: string;
  rootSessionId: string;
  movedObservationCount: number;
  movedPayloadCount: number;
  duplicate: boolean;
}

export interface AnalyticsDeleteReceipt {
  rootSessionId: string;
  deletedObservationCount: number;
  deletedPayloadCount: number;
  deletedContentCount: number;
  duplicate: boolean;
}

export interface AnalyticsRecorderProducerMeasurement {
  stage: 'ownership-preflight' | 'ownership-serialize' | 'ipc-send';
  records: number;
  retainedBytes: number;
  synchronousMs: number;
  /** Time until Node reports that the IPC message was handed to the channel.
   * This includes transport scheduling and is not mislabeled as CPU time. */
  callbackLatencyMs?: number;
}

export interface AnalyticsWorkerIdentity {
  readonly pid: number;
  /** Parent-observed spawn time. This is a worker-instance marker, not an OS
   * process creation timestamp. */
  readonly spawnedAtMs: number;
  readonly instanceId: string;
}

export type AnalyticsWorkerLifecycleEvent =
  | { state: 'spawned' | 'ready'; identity: AnalyticsWorkerIdentity }
  | { state: 'terminal'; identity: AnalyticsWorkerIdentity; code: number | null; signal: NodeJS.Signals | null };

export interface AnalyticsRecorderWriterAdmission {
  /** Acquire a durable lease that remains held until the queued write is
   * acknowledged or definitively discarded. */
  acquire(): () => void;
  /** Optional narrow startup lease for a successor recorder initializing its
   * storage after an analytics-activation fence. It is never used for capture
   * or control admission. */
  acquireStartup?(): () => void;
}

export interface AnalyticsRecorderSupervisorOptions {
  enabled: boolean;
  workerScript: string;
  databasePath: string;
  /** Optional durable lifecycle admission for every recorder persistence
   * operation. */
  writerAdmission?: AnalyticsRecorderWriterAdmission;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Bound on a single IPC control request before the supervisor treats the
   * worker as unresponsive and kills it. Configurable so qualification can
   * exercise that escalation quickly; production keeps the 30s default. */
  controlRequestTimeoutMs?: number;
  maxBatchSize?: number;
  maxQueueRecords?: number;
  maxQueueBytes?: number;
  /** Optional V8 old-space ceiling for the recorder child, in MiB.
   *
   * Leave unset in production: the recorder deliberately inherits **no**
   * `execArgv`, because an inherited loader/debug flag can turn the helper into
   * a wrapper process and break the sole IPC ownership channel (see
   * `recorder-supervisor-exec-argv.test.ts`). Setting this adds one owned
   * memory flag and is therefore an explicit operator decision, not a default.
   *
   * Rationale for having the lever at all: an unbounded child reserves idle
   * heap it never uses and reports it as RSS. Measured at 100,000 details the
   * worker pinned `heapTotal` at ~137 MB while `heapUsed` repeatedly fell back
   * to 6 MB, so the `recorderWorkerRss` gate was tracking V8's reservation
   * rather than retained analytics state. In isolated runs a 128 MiB ceiling
   * lowered the peak from 254 MB to 238 MB, but the evidence is **not**
   * sufficient to adopt a production default: peaks oscillate around the
   * gate and a 192 MiB ceiling measured worse (262 MB). */
  maxOldSpaceMb?: number;
  /** One bounded helper replacement is the default normal failover policy.
   * Further outages stay visible and retain accepted capture for an owner. */
  maxAutomaticRestarts?: number;
  /** Disposable qualification seam; production activation must omit it. */
  rehearsalAcknowledgementDelayMs?: number;
  onDeliveryAcknowledged?: (measurement: {
    records: number;
    bytes: number;
    latencyMs: number[];
    recordBytes: number[];
    /** Recorder-durable contiguous acknowledgements for producers represented
     * in this IPC batch. */
    producerReconciliation: ProducerReconciliation[];
    completeDetailWatermark: number | string;
  }) => void;
  onProducerWorkMeasured?: (measurement: AnalyticsRecorderProducerMeasurement) => void;
  /** Diagnostic lifecycle evidence for qualification and operations. The
   * child `exit` event is the terminal authority. */
  onWorkerLifecycle?: (event: AnalyticsWorkerLifecycleEvent) => void;
  /** Explicit fork exec args for source-mode tests or embedding. Packaged
   * production workers inherit no parent Node/Electron/test flags. */
  execArgv?: readonly string[];
}

interface PendingRequest {
  requestId: number;
  requestType: string;
  workerIdentity?: AnalyticsWorkerIdentity;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  stopsWorker: boolean;
}

interface SerializedCaptureEnvelope {
  kind: 'observation' | 'detail';
  subject: string;
  value: AnalyticsObservation<object> | AnalyticsDetailCapture;
}

interface CaptureQueueItem {
  type: 'capture';
  kind: SerializedCaptureEnvelope['kind'];
  subject: string;
  /** The immutable, independently-owned producer snapshot. */
  encoded: Uint8Array;
  /** Conservative serialized bound: retained snapshot plus its eventual
   * advanced-IPC clone and measured per-record framing overhead. */
  bytes: number;
  enqueuedAtMs: number;
  producerIdentity?: string;
  onDisposition?: (disposition: AnalyticsRecorderCaptureDisposition) => void;
  /** Held until the recorder has acknowledged or permanently rejected this
   * owned snapshot. */
  releaseAdmission?: () => void;
  /** A terminal helper failure may release this lease before a later owner
   * explicitly replays the retained snapshot. */
  requiresAdmission?: boolean;
}

interface ControlQueueItem {
  type: 'control';
  command: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type QueueItem = CaptureQueueItem | ControlQueueItem;

/** Bounds for the optional recorder heap ceiling. No default is applied: the
 * recorder's empty execArgv is a deliberate safety property. */
const MIN_RECORDER_HEAP_MB = 64;
const MAX_RECORDER_HEAP_MB = 512;

const CAPTURE_IPC_RECORD_OVERHEAD = serialize({
  type: 'captureBatch',
  requestId: Number.MAX_SAFE_INTEGER,
  items: [new Uint8Array(0)],
}).byteLength;

function minimumOwnedBytes(value: unknown, stopAfter: number): number {
  let bytes = 0;
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0 && bytes <= stopAfter) {
    const current = pending.pop();
    if (typeof current === 'string') bytes += current.length;
    else if (typeof current === 'number' || typeof current === 'bigint') bytes += 8;
    else if (typeof current === 'boolean') bytes += 1;
    else if (current instanceof Uint8Array) bytes += current.byteLength;
    else if (current instanceof ArrayBuffer) bytes += current.byteLength;
    else if (ArrayBuffer.isView(current)) bytes += current.byteLength;
    else if (typeof current === 'object' && current !== null && !seen.has(current)) {
      seen.add(current);
      bytes += 16;
      if (Array.isArray(current)) pending.push(...current);
      else {
        for (const [key, child] of Object.entries(current)) {
          bytes += key.length;
          pending.push(child);
        }
      }
    }
  }
  return bytes;
}

export interface AnalyticsRecorderWorkerStats {
  process: NodeJS.MemoryUsage & { cpuUsage: NodeJS.CpuUsage; workerIdentity: AnalyticsWorkerIdentity };
  recorder: Record<string, number>;
  detailStorage: Record<string, number | string>;
  delivery: Record<string, unknown>;
  startupPrivacyRecovery: {
    completed: string[];
    pending: Array<{ rootSessionId: string; error: string }>;
  };
}

export interface AnalyticsRecorderDeliveryWatermarks {
  producerReconciliation: ProducerReconciliation[];
  completeDetailWatermark: number | string;
}

export type AnalyticsRecorderCaptureDisposition =
  | {
    status: 'durable';
    producerReconciliation: ProducerReconciliation[];
    completeDetailWatermark: number | string;
  }
  | { status: 'rejected'; code: string; message: string };

export interface AnalyticsRecorderBacklog {
  queuedRecords: number;
  queuedBytes: number;
  inFlightRecords: number;
  inFlightBytes: number;
  peakRecords: number;
  peakBytes: number;
  rejectedRecords: number;
  deliveryFailures: number;
  replayedRecords: number;
}

export class AnalyticsCaptureCapacityError extends Error {
  readonly code = 'ANALYTICS_CAPTURE_CAPACITY';

  constructor(readonly records: number, readonly bytes: number) {
    super(`Analytics prototype queue capacity exceeded (${records} records, ${bytes} bytes).`);
    this.name = 'AnalyticsCaptureCapacityError';
  }
}

class AnalyticsRecorderTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsRecorderTransportError';
  }
}

export interface AnalyticsRecorderWorkerRequestContext {
  readonly requestId: number;
  readonly requestType: string;
  readonly workerIdentity: AnalyticsWorkerIdentity | null;
}

export class AnalyticsRecorderWorkerRequestError extends Error {
  readonly code?: string;
  readonly requestId?: number;
  readonly requestType?: string;
  readonly workerIdentity?: AnalyticsWorkerIdentity;

  constructor(message: string, code?: string, context?: AnalyticsRecorderWorkerRequestContext) {
    // Worker diagnostics are operational evidence, not an unbounded IPC log.
    // Preserve enough detail to identify the failed request while keeping a
    // malformed/hostile child response from retaining an arbitrary payload.
    const diagnostic = typeof message === 'string' ? message : 'Analytics recorder returned a malformed error message.';
    super(diagnostic.length <= 2_048 ? diagnostic : `${diagnostic.slice(0, 2_048)}...`);
    this.name = 'AnalyticsRecorderWorkerRequestError';
    this.code = typeof code === 'string' ? code.slice(0, 128) : undefined;
    this.requestId = context?.requestId;
    this.requestType = context?.requestType;
    if (context?.workerIdentity) this.workerIdentity = context.workerIdentity;
  }
}

/**
 * Disabled-by-default independent-process ingress. Capture ownership is
 * transferred synchronously into a bounded serialized queue, then one
 * time-sliced IPC batch is processed at a time. Lifecycle commands share that
 * exact queue, so an accepted pending-create observation cannot be overtaken by
 * its bind/delete/flush command. Agent execution never awaits recorder work.
 *
 * Ambiguous transport failures retain and replay the same immutable source
 * identities after helper replacement. A definitive recorder rejection remains
 * visible and retained for an operational owner; this boundary does not invent
 * a discard rule for the separately deferred outage policy.
 */
export class AnalyticsRecorderSupervisor implements AnalyticsSink, AnalyticsDetailSink {
  private child: ChildProcess | undefined;
  private workerReady = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private queue: QueueItem[] = [];
  private pumpScheduled = false;
  private processing = false;
  private starting: Promise<void> | undefined;
  private shutdownInProgress: Promise<void> | undefined;
  private stopping = false;
  private shutdownAcknowledged = false;
  private accepting = false;
  private failure: Error | undefined;
  private writerFencePromise: Promise<void> | undefined;
  private admittedControlCount = 0;
  private queuedRecords = 0;
  private queuedBytes = 0;
  private inFlightRecords = 0;
  private inFlightBytes = 0;
  private peakRecords = 0;
  private peakBytes = 0;
  private rejectedRecords = 0;
  private deliveryFailures = 0;
  private replayedRecords = 0;
  private automaticRestartAttempts = 0;
  private recovery: Promise<void> | undefined;
  private lastRejectedDelivery: Error | undefined;
  private workerStderr = '';
  /** Why the current child was deliberately killed by this supervisor.
   *
   * `child.kill()` on Windows is SIGTERM, so an intentional local kill is
   * otherwise indistinguishable from an external/OS termination: both surface
   * through `onExit` as "worker exited (SIGTERM)". Recording the cause here lets
   * the terminal error name the real reason (for example an IPC request timeout)
   * instead of reporting a bare signal. */
  private deliberateKillReason: string | undefined;
  private acknowledgedWatermarks: AnalyticsRecorderDeliveryWatermarks = {
    producerReconciliation: [],
    completeDetailWatermark: 0,
  };
  private readonly workerIdentities = new WeakMap<ChildProcess, AnalyticsWorkerIdentity>();

  constructor(private readonly options: AnalyticsRecorderSupervisorOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  get running(): boolean {
    return this.workerReady && Boolean(this.child?.connected);
  }

  get workerPid(): number | undefined {
    return this.workerReady ? this.child?.pid : undefined;
  }

  get terminalError(): Error | undefined {
    return this.failure;
  }

  get lastDeliveryError(): Error | undefined {
    return this.lastRejectedDelivery;
  }

  get deliveryWatermarks(): AnalyticsRecorderDeliveryWatermarks {
    return {
      producerReconciliation: this.acknowledgedWatermarks.producerReconciliation.map((entry) => ({
        ...entry,
        visibleGaps: entry.visibleGaps.map((gap) => ({ ...gap })),
      })),
      completeDetailWatermark: this.acknowledgedWatermarks.completeDetailWatermark,
    };
  }

  get backlog(): AnalyticsRecorderBacklog {
    return {
      queuedRecords: this.queuedRecords,
      queuedBytes: this.queuedBytes,
      inFlightRecords: this.inFlightRecords,
      inFlightBytes: this.inFlightBytes,
      peakRecords: this.peakRecords,
      peakBytes: this.peakBytes,
      rejectedRecords: this.rejectedRecords,
      deliveryFailures: this.deliveryFailures,
      replayedRecords: this.replayedRecords,
    };
  }

  async start(): Promise<void> {
    if (!this.options.enabled) return;
    if (this.stopping || this.shutdownInProgress) {
      throw new Error('Analytics recorder worker is shutting down.');
    }
    if (this.running) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.shutdownAcknowledged = false;
    this.failure = undefined;
    this.automaticRestartAttempts = 0;
    this.starting = this.startWorker();
    try {
      await this.starting;
      if (this.stopping) return;
      this.accepting = true;
      this.schedulePump();
    } finally {
      this.starting = undefined;
    }
  }

  submit<Fields extends object>(observation: AnalyticsObservation<Fields>): void {
    if (!this.options.enabled) return;
    this.enqueueCapture('observation', this.subjectKey(observation.captureSubject), observation);
  }

  /** Transfer one capture into the same bounded queue while retaining an
   * exact per-record durable disposition for an external producer ACK. */
  submitTracked<Fields extends object>(
    observation: AnalyticsObservation<Fields>,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void {
    if (!this.options.enabled) throw new Error('Analytics recorder worker is disabled.');
    this.enqueueCapture('observation', this.subjectKey(observation.captureSubject), observation, onDisposition);
  }

  preflightDetail(value: unknown): void {
    if (!this.options.enabled) return;
    if (!this.accepting) throw this.failure ?? new Error('Analytics recorder worker is not accepting capture.');
    const startedAt = performance.now();
    const records = this.queuedRecords + this.inFlightRecords + 1;
    const maximumRecords = this.options.maxQueueRecords ?? 65_536;
    const maximumBytes = this.options.maxQueueBytes ?? 64 * 1024 * 1024;
    const availableBytes = Math.max(0, maximumBytes - this.queuedBytes - this.inFlightBytes);
    const preflightLimit = Math.max(0, Math.floor((availableBytes - CAPTURE_IPC_RECORD_OVERHEAD) / 2));
    const minimumBytes = minimumOwnedBytes(value, preflightLimit);
    const minimumRetainedBytes = (minimumBytes * 2) + CAPTURE_IPC_RECORD_OVERHEAD;
    const synchronousMs = Math.max(0, performance.now() - startedAt);
    this.options.onProducerWorkMeasured?.({
      stage: 'ownership-preflight', records: 1, retainedBytes: minimumRetainedBytes, synchronousMs,
    });
    if (records > maximumRecords || minimumRetainedBytes > availableBytes) {
      this.rejectedRecords += 1;
      throw new AnalyticsCaptureCapacityError(
        records,
        this.queuedBytes + this.inFlightBytes + minimumRetainedBytes,
      );
    }
  }

  submitDetail(capture: AnalyticsDetailCapture): void {
    if (!this.options.enabled) return;
    this.enqueueCapture('detail', this.subjectKey(capture.captureSubject), capture);
  }

  submitTrackedDetail(
    capture: AnalyticsDetailCapture,
    onDisposition: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void {
    if (!this.options.enabled) throw new Error('Analytics recorder worker is disabled.');
    this.enqueueCapture('detail', this.subjectKey(capture.captureSubject), capture, onDisposition);
  }

  async flush(): Promise<void> {
    if (!this.options.enabled) return;
    await this.enqueueControl({ type: 'flush' });
  }

  /** Synchronously close producer admission, then wait for every already
   * accepted capture to receive a recorder acknowledgement. This is the
   * process-local half of the authenticated all-host writer fence. */
  async fence(timeoutMs = 10_000): Promise<void> {
    if (!this.options.enabled) return;
    if (this.writerFencePromise) return await this.writerFencePromise;
    this.accepting = false;
    if (this.queuedRecords === 0 && this.inFlightRecords === 0 && this.admittedControlCount === 0) return;
    this.writerFencePromise = (async () => {
      if (this.failure) throw this.failure;
      if (!this.running) {
        throw new AnalyticsRecorderTransportError('Analytics recorder worker is not running while writers remain queued.');
      }
      await this.enqueueControl({ type: 'flush' }, timeoutMs, true);
    })();
    try {
      await this.writerFencePromise;
    } finally {
      this.writerFencePromise = undefined;
    }
  }

  /** Prepare the single active IANA calendar zone in the recorder. This is a
   * control operation, intentionally separate from read-only aggregate reads. */
  async prepareProviderDailyProjection(
    timeZone: string,
    windowStartMs: number | string | bigint,
    windowEndMs: number | string | bigint,
    allowTimeZoneChange = false,
  ): Promise<void> {
    if (!this.options.enabled) return;
    await this.enqueueAdmittedControl({
      type: 'prepareProviderDailyProjection', timeZone, windowStartMs, windowEndMs, allowTimeZoneChange,
    });
  }

  async bindPendingCreate(
    pendingOperationId: string,
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
  ): Promise<AnalyticsSubjectBindingReceipt | undefined> {
    if (!this.options.enabled) return undefined;
    return this.enqueueAdmittedControl({
      type: 'bindPendingCreate', pendingOperationId, rootSessionId, sourceKey, timestampMs,
    }) as Promise<AnalyticsSubjectBindingReceipt>;
  }

  async deleteSession(
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
    pendingOperationId?: string,
  ): Promise<AnalyticsDeleteReceipt | undefined> {
    if (!this.options.enabled) return undefined;
    return this.enqueueAdmittedControl({
      type: 'deleteSession', rootSessionId, sourceKey, timestampMs, pendingOperationId,
    }) as Promise<AnalyticsDeleteReceipt>;
  }

  async workerStats(): Promise<AnalyticsRecorderWorkerStats | undefined> {
    if (!this.options.enabled) return undefined;
    return this.enqueueControl({ type: 'stats' }) as Promise<AnalyticsRecorderWorkerStats>;
  }

  /** Rehearses a clean helper replacement only; it does not restart VS Code or
   * arm a later activation. Earlier accepted capture drains before shutdown. */
  async restart(): Promise<void> {
    if (!this.options.enabled) return;
    await this.shutdown();
    await this.start();
  }

  async shutdown(): Promise<void> {
    if (!this.options.enabled) return;
    if (this.shutdownInProgress) return this.shutdownInProgress;
    this.shutdownInProgress = this.performShutdown();
    try {
      await this.shutdownInProgress;
    } finally {
      this.shutdownInProgress = undefined;
    }
  }

  private async performShutdown(): Promise<void> {
    const timeoutMs = this.options.shutdownTimeoutMs ?? 10_000;
    // Fence recovery and producer admission before inspecting any lifecycle
    // state. A concurrent failed start/recovery must never create a replacement
    // after shutdown has returned.
    this.stopping = true;
    this.accepting = false;
    this.shutdownAcknowledged = false;
    try {
      const starting = this.starting;
      const recovery = this.recovery;
      const notReadyChild = this.child && !this.workerReady ? this.child : undefined;
      if (notReadyChild) {
        await this.terminateChild(notReadyChild, timeoutMs);
      }
      await Promise.allSettled([starting, recovery].filter((pending): pending is Promise<void> => Boolean(pending)));

      // Background recovery is fenced above. One already-accepted ambiguous
      // batch may still use the configured bounded replacement budget, but the
      // replacement is owned and awaited by this shutdown call; it cannot
      // appear after shutdown settles.
      while (true) {
        const child = this.child;
        if (!child) {
          if (!this.failure || this.queuedRecords === 0) return;
          const maximum = Math.max(0, this.options.maxAutomaticRestarts ?? 1);
          if (this.automaticRestartAttempts >= maximum) throw this.failure;
          this.automaticRestartAttempts += 1;
          try {
            await this.startWorker();
          } catch (error) {
            this.failure = error instanceof Error ? error : new Error(String(error));
          }
          continue;
        }
        if (!this.workerReady || !child.connected || this.failure) {
          await this.terminateChild(child, timeoutMs);
          if (this.failure && this.queuedRecords > 0) continue;
          return;
        }
        try {
          const shutdown = this.enqueueControl(
            { type: 'shutdown' },
            timeoutMs,
            true,
          );
          await shutdown;
          await this.waitForExit(child, timeoutMs);
          return;
        } catch (error) {
          if (this.queuedRecords === 0) throw error;
          // The capture batch was restored to the owned queue. Loop only while
          // the explicit restart budget can make a shutdown-owned drain.
        }
      }
    } finally {
      this.rejectQueuedControls(
        this.failure ?? new AnalyticsRecorderTransportError('Analytics recorder worker stopped before a queued command completed.'),
      );
      const terminal = !this.child || this.child.exitCode !== null || this.child.signalCode !== null;
      if (terminal) this.releaseQueuedCaptureAdmissions();
      if (this.child && terminal) {
        this.child = undefined;
        this.workerReady = false;
      }
      // A disconnected IPC channel is not proof of process exit. Keep the
      // stop fence latched until a later cleanup call observes terminal state;
      // otherwise that child's delayed exit could schedule recovery.
      if (terminal) this.stopping = false;
      this.processing = false;
      this.pumpScheduled = false;
    }
  }

  private enqueueCapture(
    kind: SerializedCaptureEnvelope['kind'],
    subject: string,
    value: AnalyticsObservation<object> | AnalyticsDetailCapture,
    onDisposition?: (disposition: AnalyticsRecorderCaptureDisposition) => void,
  ): void {
    if (!this.accepting) throw this.failure ?? new Error('Analytics recorder worker is not accepting capture.');
    const startedAt = performance.now();
    const records = this.queuedRecords + this.inFlightRecords + 1;
    const maximumRecords = this.options.maxQueueRecords ?? 65_536;
    const maximumBytes = this.options.maxQueueBytes ?? 64 * 1024 * 1024;
    if (records > maximumRecords) {
      this.rejectedRecords += 1;
      this.options.onProducerWorkMeasured?.({
        stage: 'ownership-preflight', records: 1, retainedBytes: 0,
        synchronousMs: Math.max(0, performance.now() - startedAt),
      });
      throw new AnalyticsCaptureCapacityError(records, this.queuedBytes + this.inFlightBytes);
    }
    const availableBytes = Math.max(0, maximumBytes - this.queuedBytes - this.inFlightBytes);
    const preflightLimit = Math.max(0, Math.floor((availableBytes - CAPTURE_IPC_RECORD_OVERHEAD) / 2));
    const minimumBytes = minimumOwnedBytes(value, preflightLimit);
    const minimumRetainedBytes = (minimumBytes * 2) + CAPTURE_IPC_RECORD_OVERHEAD;
    if (minimumRetainedBytes > availableBytes) {
      this.rejectedRecords += 1;
      this.options.onProducerWorkMeasured?.({
        stage: 'ownership-preflight',
        records: 1,
        retainedBytes: minimumRetainedBytes,
        synchronousMs: Math.max(0, performance.now() - startedAt),
      });
      throw new AnalyticsCaptureCapacityError(
        records,
        this.queuedBytes + this.inFlightBytes + minimumRetainedBytes,
      );
    }
    const encoded = serialize({ kind, subject, value } satisfies SerializedCaptureEnvelope);
    // Reserve the owned snapshot plus the advanced-IPC clone without cloning
    // the full payload a second time on the producer loop. The fixed measured
    // envelope overhead covers per-record transport framing.
    const bytes = (encoded.byteLength * 2) + CAPTURE_IPC_RECORD_OVERHEAD;
    const synchronousMs = Math.max(0, performance.now() - startedAt);
    this.options.onProducerWorkMeasured?.({
      stage: 'ownership-serialize',
      records: 1,
      retainedBytes: bytes,
      synchronousMs,
    });

    const totalBytes = this.queuedBytes + this.inFlightBytes + bytes;
    if (totalBytes > maximumBytes) {
      this.rejectedRecords += 1;
      throw new AnalyticsCaptureCapacityError(records, totalBytes);
    }
    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = this.options.writerAdmission?.acquire();
      if (releaseAdmission !== undefined && typeof releaseAdmission !== 'function') {
        throw new Error('Analytics recorder admission did not return a release function.');
      }
      this.queue.push({
        type: 'capture',
        kind,
        subject,
        encoded,
        bytes,
        enqueuedAtMs: performance.now(),
        ...(kind === 'observation' && value.producerKind && value.stableOriginId
          ? { producerIdentity: analyticsProducerIdentity(value.generationId, value.producerKind, value.stableOriginId) }
          : {}),
        ...(onDisposition ? { onDisposition } : {}),
        ...(releaseAdmission ? { releaseAdmission } : {}),
        ...(this.options.writerAdmission ? { requiresAdmission: true } : {}),
      });
    } catch (error) {
      releaseAdmission?.();
      throw error;
    }
    this.queuedRecords += 1;
    this.queuedBytes += bytes;
    this.observePeak();
    this.schedulePump();
  }

  private enqueueAdmittedControl(command: Record<string, unknown>): Promise<unknown> {
    if (!this.accepting || this.failure) {
      return Promise.reject(this.failure ?? new Error('Analytics recorder worker is not accepting commands.'));
    }
    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = this.options.writerAdmission?.acquire();
      if (releaseAdmission !== undefined && typeof releaseAdmission !== 'function') {
        throw new Error('Analytics recorder admission did not return a release function.');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.admittedControlCount += 1;
    return this.enqueueControl(command).finally(() => {
      this.admittedControlCount = Math.max(0, this.admittedControlCount - 1);
      releaseAdmission?.();
    });
  }

  private enqueueControl(
    command: Record<string, unknown>,
    timeoutMs = this.options.controlRequestTimeoutMs ?? 30_000,
    allowWhileStopping = false,
  ): Promise<unknown> {
    if ((!this.accepting && !allowWhileStopping) || this.failure) {
      return Promise.reject(this.failure ?? new Error('Analytics recorder worker is not accepting commands.'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ type: 'control', command, timeoutMs, resolve, reject });
      this.schedulePump();
    });
  }

  private schedulePump(yieldToEventLoop = false): void {
    if (this.processing || this.pumpScheduled || this.failure || !this.running || this.queue.length === 0) return;
    this.pumpScheduled = true;
    const run = () => {
      this.pumpScheduled = false;
      void this.processNext();
    };
    if (yieldToEventLoop) setImmediate(run);
    else queueMicrotask(run);
  }

  private async processNext(): Promise<void> {
    if (this.processing || !this.running || this.queue.length === 0) return;
    this.processing = true;
    const first = this.queue[0]!;
    try {
      if (first.type === 'control') {
        await this.processControl(first);
      } else {
        await this.processCaptureBatch(first);
      }
    } finally {
      this.processing = false;
    }
    this.schedulePump(true);
  }

  private async processControl(item: ControlQueueItem): Promise<void> {
    try {
      const receipt = await this.requestRaw(item.command, item.timeoutMs, 0, 0);
      if (this.queue[0] === item) this.queue.shift();
      item.resolve(receipt);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.lastRejectedDelivery = failure;
      if (failure instanceof AnalyticsRecorderTransportError) {
        // Keep the command in place. A committed-but-unacknowledged lifecycle
        // operation is replayed only after the old helper has exited.
        this.failure = failure;
        if (this.stopping) {
          if (this.queue[0] === item) this.queue.shift();
          item.reject(failure);
        }
        return;
      }
      if (this.queue[0] === item) this.queue.shift();
      item.reject(failure);
    }
  }

  private async processCaptureBatch(first: CaptureQueueItem): Promise<void> {
    const maximum = Math.max(1, this.options.maxBatchSize ?? 256);
    const items: CaptureQueueItem[] = [];
    while (items.length < maximum) {
      const candidate = this.queue[items.length];
      if (candidate?.type !== 'capture' || candidate.kind !== first.kind) break;
      items.push(candidate);
    }
    try {
      this.reacquireRetainedCaptureAdmissions(items);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.lastRejectedDelivery = failure;
      this.failure = failure;
      this.rejectQueuedControls(failure);
      return;
    }
    this.queue.splice(0, items.length);
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    this.queuedRecords = Math.max(0, this.queuedRecords - items.length);
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    this.inFlightRecords = items.length;
    this.inFlightBytes = bytes;
    this.observePeak();

    try {
      const receipt = await this.requestRaw(
        { type: 'captureBatch', items: items.map((item) => item.encoded) },
        30_000,
        items.length,
        bytes,
      ) as ({
        rejections?: Array<{ index: number; code: string; error: string }>;
        producerReconciliation?: ProducerReconciliation[];
        completeDetailWatermark?: number | string;
      }) | undefined;
      const producerReconciliation = receipt?.producerReconciliation ?? [];
      const completeDetailWatermark = receipt?.completeDetailWatermark ?? this.acknowledgedWatermarks.completeDetailWatermark;
      this.acknowledgedWatermarks = { producerReconciliation, completeDetailWatermark };
      const rejectedIndexes = new Map<number, { code: string; error: string }>();
      for (const rejection of receipt?.rejections ?? []) {
        if (!Number.isSafeInteger(rejection.index) || rejection.index < 0 || rejection.index >= items.length) {
          throw new AnalyticsRecorderWorkerRequestError('Recorder returned an invalid capture rejection receipt.');
        }
        if (rejectedIndexes.has(rejection.index)) {
          throw new AnalyticsRecorderWorkerRequestError('Recorder returned a duplicate capture rejection receipt.');
        }
        rejectedIndexes.set(rejection.index, rejection);
        this.lastRejectedDelivery = new AnalyticsRecorderWorkerRequestError(rejection.error, rejection.code);
      }
      this.deliveryFailures += rejectedIndexes.size;
      const acceptedItems = items.filter((_item, index) => !rejectedIndexes.has(index));
      if (acceptedItems.length > 0) {
        const acknowledgedAt = performance.now();
        this.options.onDeliveryAcknowledged?.({
          records: acceptedItems.length,
          bytes: acceptedItems.reduce((sum, item) => sum + item.bytes, 0),
          latencyMs: acceptedItems.map((item) => acknowledgedAt - item.enqueuedAtMs),
          recordBytes: acceptedItems.map((item) => item.bytes),
          producerReconciliation,
          completeDetailWatermark,
        });
      }
      const reconciliationByProducer = new Map(
        producerReconciliation.map((entry) => [entry.producerIdentity, entry]),
      );
      for (const [index, item] of items.entries()) {
        const rejection = rejectedIndexes.get(index);
        const exactReconciliation = item.producerIdentity
          ? reconciliationByProducer.get(item.producerIdentity)
          : undefined;
        this.notifyCaptureDisposition(item, rejection
          ? { status: 'rejected', code: rejection.code, message: rejection.error }
          : {
              status: 'durable',
              producerReconciliation: exactReconciliation ? [exactReconciliation] : [],
              completeDetailWatermark,
            });
      }
      this.failure = undefined;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.deliveryFailures += items.length;
      this.lastRejectedDelivery = failure;
      // Ambiguous transport and definitive non-policy recorder failures retain
      // the immutable ownership snapshot for an operational owner. Expected
      // deletion-fence exclusions arrive as per-record acknowledgement receipts
      // and therefore cannot discard unrelated batch members here.
      this.queue.unshift(...items);
      this.queuedRecords += items.length;
      this.queuedBytes += bytes;
      this.replayedRecords += failure instanceof AnalyticsRecorderTransportError ? items.length : 0;
      this.failure = failure;
      if (failure instanceof AnalyticsRecorderWorkerRequestError) this.rejectQueuedControls(failure);
    } finally {
      this.inFlightRecords = 0;
      this.inFlightBytes = 0;
      this.observePeak();
    }
  }

  private notifyCaptureDisposition(
    item: CaptureQueueItem,
    disposition: AnalyticsRecorderCaptureDisposition,
  ): void {
    try {
      item.onDisposition?.(disposition);
    } catch {
      // A transport ACK observer cannot change recorder durability or replay.
    } finally {
      item.releaseAdmission?.();
      item.releaseAdmission = undefined;
    }
  }

  private async startWorker(): Promise<void> {
    const releaseAdmission = this.options.writerAdmission
      ? (this.options.writerAdmission.acquireStartup?.() ?? this.options.writerAdmission.acquire())
      : undefined;
    if (releaseAdmission !== undefined && typeof releaseAdmission !== 'function') {
      throw new Error('Analytics recorder admission did not return a release function.');
    }
    try {
      await this.startWorkerWithoutAdmission();
    } catch (error) {
      const child = this.child;
      if (child && !this.workerReady) {
        await this.terminateChild(child, this.options.shutdownTimeoutMs ?? 10_000).catch(() => { /* preserve startup error */ });
      }
      throw error;
    } finally {
      releaseAdmission?.();
    }
  }

  private async startWorkerWithoutAdmission(): Promise<void> {
    const spawnedAtMs = Date.now();
    const instanceId = randomUUID();
    // Only add a memory flag when an operator explicitly asked for a ceiling.
    // The recorder's empty-by-default execArgv is a deliberate safety property
    // (an inherited loader/debug flag can turn the helper into a wrapper and
    // break the sole IPC channel), so no default is applied here.
    const execArgv = [...(this.options.execArgv ?? [])];
    if (this.options.maxOldSpaceMb !== undefined) {
      const configuredHeapMb = this.options.maxOldSpaceMb;
      if (!Number.isSafeInteger(configuredHeapMb) || configuredHeapMb < MIN_RECORDER_HEAP_MB) {
        throw new RangeError(
          `Analytics recorder maxOldSpaceMb must be a safe integer of at least ${MIN_RECORDER_HEAP_MB}.`,
        );
      }
      execArgv.push(`--max-old-space-size=${Math.min(MAX_RECORDER_HEAP_MB, configuredHeapMb)}`);
    }
    const child = fork(this.options.workerScript, [], {
      // The recorder is a dedicated packaged-JS process (test loaders own
      // their own TS import). Inheriting Electron, debugger, or `node --test`
      // flags can turn it into a wrapper/grandchild and break the sole IPC
      // ownership channel.
      execArgv,
      env: {
        ...process.env,
        PIE_ANALYTICS_DATABASE_PATH: this.options.databasePath,
        PIE_ANALYTICS_WORKER_INSTANCE_ID: instanceId,
        PIE_ANALYTICS_WORKER_SPAWNED_AT_MS: String(spawnedAtMs),
        ...(this.options.rehearsalAcknowledgementDelayMs === undefined ? {} : {
          PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS: String(this.options.rehearsalAcknowledgementDelayMs),
        }),
      },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    if (!child.pid) throw new Error('Analytics recorder worker did not expose a process ID.');
    const workerIdentity: AnalyticsWorkerIdentity = Object.freeze({ pid: child.pid, spawnedAtMs, instanceId });
    this.workerIdentities.set(child, workerIdentity);
    this.notifyWorkerLifecycle({ state: 'spawned', identity: workerIdentity });
    this.child = child;
    this.workerReady = false;
    this.workerStderr = '';
    this.deliberateKillReason = undefined;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.workerStderr = `${this.workerStderr}${String(chunk)}`.slice(-8_192);
    });
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.once('error', (error) => {
      if (this.child === child) child.kill();
      this.onFailure(error);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Analytics recorder worker startup timed out.'));
      }, this.options.startupTimeoutMs ?? 10_000);
      const onMessage = (raw: unknown) => {
        const message = raw as { type?: string; error?: string; workerIdentity?: AnalyticsWorkerIdentity };
        if (message.type === 'ready') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          if (message.workerIdentity?.pid !== workerIdentity.pid
            || message.workerIdentity.spawnedAtMs !== workerIdentity.spawnedAtMs
            || message.workerIdentity.instanceId !== workerIdentity.instanceId) {
            child.kill();
            reject(new Error('Analytics recorder worker identity did not match its supervisor instance.'));
          } else {
            resolve();
          }
        } else if (message.type === 'fatal') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          child.kill();
          reject(new Error(message.error ?? 'Analytics recorder worker failed to start.'));
        }
      };
      child.on('message', onMessage);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        const diagnostic = redactSensitiveText(this.workerStderr.trim());
        reject(new Error(
          `Analytics recorder worker exited during startup (${code ?? signal ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : '.'}`,
        ));
      });
    });
    // Publish replacement identity only after readiness and clear the old
    // transport failure in the same turn, so callers cannot observe a new PID
    // that still rejects ordered lifecycle commands for the old outage.
    this.failure = undefined;
    this.workerReady = true;
    this.notifyWorkerLifecycle({ state: 'ready', identity: workerIdentity });
  }

  private requestRaw(
    message: Record<string, unknown>,
    timeoutMs: number,
    records: number,
    retainedBytes: number,
  ): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) {
      return Promise.reject(this.failure ?? new AnalyticsRecorderTransportError('Analytics recorder worker is not connected.'));
    }
    const requestId = this.nextRequestId++;
    const requestType = typeof message.type === 'string' ? message.type.slice(0, 64) : 'unknown';
    const workerIdentity = this.workerIdentities.get(child);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        const error = new AnalyticsRecorderTransportError(`Analytics recorder request ${requestId} timed out.`);
        if (this.child === child) {
          this.deliberateKillReason = `supervisor killed the worker after request ${requestId} (${String(message.type)}) exceeded ${timeoutMs} ms`;
          child.kill();
        }
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, {
        requestId,
        requestType,
        workerIdentity,
        stopsWorker: message.type === 'shutdown',
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const sendStartedAt = performance.now();
      let synchronousMs = 0;
      child.send({ ...message, requestId }, (sendError) => {
        const callbackLatencyMs = Math.max(0, performance.now() - sendStartedAt);
        this.options.onProducerWorkMeasured?.({
          stage: 'ipc-send',
          records,
          retainedBytes,
          synchronousMs,
          callbackLatencyMs,
        });
        if (!sendError) return;
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        pending?.reject(new AnalyticsRecorderTransportError(sendError.message));
        if (this.child === child) {
          this.deliberateKillReason = `supervisor killed the worker after an IPC send failure (${sendError.message})`;
          child.kill();
        }
      });
      synchronousMs = Math.max(0, performance.now() - sendStartedAt);
    });
  }

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const message = raw as { type?: string; requestId?: number; error?: string; errorCode?: string; receipt?: unknown };
    const requestId = message.requestId;
    if ((message.type !== 'ack' && message.type !== 'error')
      || typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId <= 0) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (message.type === 'error') {
      pending.reject(new AnalyticsRecorderWorkerRequestError(
        message.error ?? 'Analytics recorder request failed.',
        message.errorCode,
        {
          requestId: pending.requestId,
          requestType: pending.requestType,
          workerIdentity: pending.workerIdentity ?? null,
        },
      ));
    } else {
      // Fence the intentional helper exit before resolving shutdown back into
      // the async queue continuation; an exit event cannot race this marker.
      if (pending.stopsWorker) this.shutdownAcknowledged = true;
      pending.resolve(message.receipt);
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const identity = this.workerIdentities.get(child);
    if (identity) this.notifyWorkerLifecycle({ state: 'terminal', identity, code, signal });
    if (this.child !== child) return;
    this.child = undefined;
    this.workerReady = false;
    if (!this.shutdownAcknowledged) {
      const diagnostic = this.workerStderr.trim();
      const deliberate = this.deliberateKillReason;
      this.deliberateKillReason = undefined;
      // Prefer the supervisor's own recorded cause: a bare "(SIGTERM)" hides an
      // intentional local kill (for example an IPC timeout) behind what looks
      // like an external termination.
      const detail = [deliberate, diagnostic].filter(Boolean).join('; ');
      this.onFailure(new AnalyticsRecorderTransportError(
        deliberate
          ? `${deliberate}; worker then exited (${code ?? signal ?? 'unknown'}).`
          : `Analytics recorder worker exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : '.'}`,
      ));
    }
  }

  private notifyWorkerLifecycle(event: AnalyticsWorkerLifecycleEvent): void {
    try {
      this.options.onWorkerLifecycle?.(event);
    } catch {
      // Diagnostic observers cannot alter recorder ownership or recovery.
    }
  }

  private onFailure(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(
      error instanceof AnalyticsRecorderTransportError
        ? error
        : new AnalyticsRecorderTransportError(error.message),
    );
    this.pending.clear();
    if (this.stopping) this.rejectQueuedControls(error);
    else this.scheduleAutomaticRecovery();
  }

  private scheduleAutomaticRecovery(): void {
    if (this.stopping || this.recovery || this.child || this.running) return;
    const maximum = Math.max(0, this.options.maxAutomaticRestarts ?? 1);
    if (this.automaticRestartAttempts >= maximum) {
      this.rejectQueuedControls(this.failure ?? new Error('Analytics recorder recovery exhausted.'));
      return;
    }
    this.automaticRestartAttempts += 1;
    this.recovery = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (this.stopping || this.child) return;
      try {
        await this.startWorker();
        this.failure = undefined;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        this.recovery = undefined;
      }
      if (this.running) this.schedulePump();
      else this.scheduleAutomaticRecovery();
    })();
  }

  private rejectQueuedControls(error: Error): void {
    const retained: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.type === 'control') item.reject(error);
      else retained.push(item);
    }
    this.queue = retained;
  }

  private releaseQueuedCaptureAdmissions(): void {
    for (const item of this.queue) {
      if (item.type !== 'capture') continue;
      item.releaseAdmission?.();
      item.releaseAdmission = undefined;
    }
  }

  private reacquireRetainedCaptureAdmissions(items: readonly CaptureQueueItem[]): void {
    if (!this.options.writerAdmission) return;
    const reacquired: Array<() => void> = [];
    try {
      for (const item of items) {
        if (!item.requiresAdmission || item.releaseAdmission) continue;
        const release = this.options.writerAdmission.acquire();
        if (typeof release !== 'function') {
          throw new Error('Analytics recorder admission did not return a release function.');
        }
        item.releaseAdmission = release;
        reacquired.push(release);
      }
    } catch (error) {
      for (const release of reacquired) release();
      for (const item of items) {
        if (item.releaseAdmission && reacquired.includes(item.releaseAdmission)) item.releaseAdmission = undefined;
      }
      throw error;
    }
  }

  private subjectKey(subject: AnalyticsObservation['captureSubject']): string {
    switch (subject.kind) {
      case 'session': return `session:${subject.rootSessionId}`;
      case 'pendingCreate': return `pendingCreate:${subject.operationId}`;
      case 'host': return `host:${subject.hostId}`;
    }
  }

  private observePeak(): void {
    const records = this.queuedRecords + this.inFlightRecords;
    this.peakRecords = Math.max(this.peakRecords, records);
    this.peakBytes = Math.max(this.peakBytes, this.queuedBytes + this.inFlightBytes);
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Analytics recorder worker shutdown timed out.')), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    try {
      await this.waitForExit(child, timeoutMs);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await this.waitForExit(child, timeoutMs).catch(() => {
        throw error;
      });
    }
  }
}
