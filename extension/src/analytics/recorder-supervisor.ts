import { fork, type ChildProcess } from 'node:child_process';
import { serialize } from 'node:v8';

import type {
  AnalyticsDetailCapture,
  AnalyticsDetailSink,
  AnalyticsObservation,
  AnalyticsSink,
} from '../../../shared/analytics/contracts.js';
import type { ProducerReconciliation } from './sqlite-recorder.js';

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

export interface AnalyticsRecorderSupervisorOptions {
  enabled: boolean;
  workerScript: string;
  databasePath: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxBatchSize?: number;
  maxQueueRecords?: number;
  maxQueueBytes?: number;
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
}

interface PendingRequest {
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
}

interface ControlQueueItem {
  type: 'control';
  command: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type QueueItem = CaptureQueueItem | ControlQueueItem;

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
  process: NodeJS.MemoryUsage & { cpuUsage: NodeJS.CpuUsage };
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

class AnalyticsRecorderWorkerRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'AnalyticsRecorderWorkerRequestError';
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
  private acknowledgedWatermarks: AnalyticsRecorderDeliveryWatermarks = {
    producerReconciliation: [],
    completeDetailWatermark: 0,
  };

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

  async flush(): Promise<void> {
    if (!this.options.enabled) return;
    await this.enqueueControl({ type: 'flush' });
  }

  async bindPendingCreate(
    pendingOperationId: string,
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
  ): Promise<AnalyticsSubjectBindingReceipt | undefined> {
    if (!this.options.enabled) return undefined;
    return this.enqueueControl({
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
    return this.enqueueControl({
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
    this.queue.push({
      type: 'capture',
      kind,
      subject,
      encoded,
      bytes,
      enqueuedAtMs: performance.now(),
    });
    this.queuedRecords += 1;
    this.queuedBytes += bytes;
    this.observePeak();
    this.schedulePump();
  }

  private enqueueControl(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
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
      const rejectedIndexes = new Set<number>();
      for (const rejection of receipt?.rejections ?? []) {
        if (!Number.isSafeInteger(rejection.index) || rejection.index < 0 || rejection.index >= items.length) {
          throw new AnalyticsRecorderWorkerRequestError('Recorder returned an invalid capture rejection receipt.');
        }
        rejectedIndexes.add(rejection.index);
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

  private async startWorker(): Promise<void> {
    const child = fork(this.options.workerScript, [], {
      env: {
        ...process.env,
        PIE_ANALYTICS_DATABASE_PATH: this.options.databasePath,
        ...(this.options.rehearsalAcknowledgementDelayMs === undefined ? {} : {
          PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS: String(this.options.rehearsalAcknowledgementDelayMs),
        }),
      },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    this.workerReady = false;
    this.workerStderr = '';
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
        const message = raw as { type?: string; error?: string };
        if (message.type === 'ready') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          resolve();
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
        reject(new Error(`Analytics recorder worker exited during startup (${code ?? signal ?? 'unknown'}).`));
      });
    });
    // Publish replacement identity only after readiness and clear the old
    // transport failure in the same turn, so callers cannot observe a new PID
    // that still rejects ordered lifecycle commands for the old outage.
    this.failure = undefined;
    this.workerReady = true;
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
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        const error = new AnalyticsRecorderTransportError(`Analytics recorder request ${requestId} timed out.`);
        reject(error);
        if (this.child === child) child.kill();
      }, timeoutMs);
      this.pending.set(requestId, {
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
        if (this.child === child) child.kill();
      });
      synchronousMs = Math.max(0, performance.now() - sendStartedAt);
    });
  }

  private onMessage(raw: unknown): void {
    const message = raw as { type?: string; requestId?: number; error?: string; errorCode?: string; receipt?: unknown };
    if ((message.type !== 'ack' && message.type !== 'error') || typeof message.requestId !== 'number') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      pending.reject(new AnalyticsRecorderWorkerRequestError(
        message.error ?? 'Analytics recorder request failed.',
        message.errorCode,
      ));
    } else {
      // Fence the intentional helper exit before resolving shutdown back into
      // the async queue continuation; an exit event cannot race this marker.
      if (pending.stopsWorker) this.shutdownAcknowledged = true;
      pending.resolve(message.receipt);
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.workerReady = false;
    if (!this.shutdownAcknowledged) {
      const diagnostic = this.workerStderr.trim();
      this.onFailure(new AnalyticsRecorderTransportError(
        `Analytics recorder worker exited (${code ?? signal ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : '.'}`,
      ));
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
