import { fork, type ChildProcess } from 'node:child_process';

import type {
  AnalyticsDetailCapture,
  AnalyticsDetailSink,
  AnalyticsObservation,
  AnalyticsSink,
} from '../../../shared/analytics/contracts.js';
import type { AnalyticsDeleteReceipt } from './sqlite-recorder.js';

export interface AnalyticsRecorderSupervisorOptions {
  enabled: boolean;
  workerScript: string;
  databasePath: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxBatchSize?: number;
  maxQueueRecords?: number;
  maxQueueBytes?: number;
  /** Disposable qualification seam; production activation must omit it. */
  rehearsalAcknowledgementDelayMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  records: number;
  bytes: number;
}

type QueueItem =
  | { kind: 'observation'; subject: string; value: AnalyticsObservation; bytes: number }
  | { kind: 'detail'; subject: string; value: AnalyticsDetailCapture; bytes: number };

export interface AnalyticsRecorderWorkerStats {
  process: NodeJS.MemoryUsage;
  recorder: Record<string, number>;
  detailStorage: Record<string, number>;
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
}

export class AnalyticsCaptureCapacityError extends Error {
  readonly code = 'ANALYTICS_CAPTURE_CAPACITY';

  constructor(readonly records: number, readonly bytes: number) {
    super(`Analytics prototype queue capacity exceeded (${records} records, ${bytes} bytes).`);
    this.name = 'AnalyticsCaptureCapacityError';
  }
}

/**
 * Disabled-by-default independent-process ingress. `submit` and `submitDetail`
 * only transfer ownership into a bounded in-memory producer queue and schedule
 * IPC; neither waits for recorder acceptance, commit, detail acknowledgement,
 * or drainage. Capacity rejection is explicit and fails qualification rather
 * than silently selecting an outage/data-loss policy.
 */
export class AnalyticsRecorderSupervisor implements AnalyticsSink, AnalyticsDetailSink {
  private child: ChildProcess | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private queue: QueueItem[] = [];
  private pumpScheduled = false;
  private starting: Promise<void> | undefined;
  private stopping = false;
  private failure: Error | undefined;
  private queuedBytes = 0;
  private inFlightRecords = 0;
  private inFlightBytes = 0;
  private peakRecords = 0;
  private peakBytes = 0;
  private rejectedRecords = 0;
  private deliveryFailures = 0;
  private lastRejectedDelivery: Error | undefined;

  constructor(private readonly options: AnalyticsRecorderSupervisorOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  get running(): boolean {
    return Boolean(this.child?.connected);
  }

  get workerPid(): number | undefined {
    return this.child?.pid;
  }

  get terminalError(): Error | undefined {
    return this.failure;
  }

  get lastDeliveryError(): Error | undefined {
    return this.lastRejectedDelivery;
  }

  get backlog(): AnalyticsRecorderBacklog {
    return {
      queuedRecords: this.queue.length,
      queuedBytes: this.queuedBytes,
      inFlightRecords: this.inFlightRecords,
      inFlightBytes: this.inFlightBytes,
      peakRecords: this.peakRecords,
      peakBytes: this.peakBytes,
      rejectedRecords: this.rejectedRecords,
      deliveryFailures: this.deliveryFailures,
    };
  }

  async start(): Promise<void> {
    if (!this.options.enabled || this.running) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.failure = undefined;
    this.starting = this.startWorker();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  submit(observation: AnalyticsObservation): void {
    if (!this.options.enabled) return;
    // Facts are contractually compact. Avoid JSON serialization on the producer
    // path; reserve a conservative accounting unit until physical DTO limits
    // are fixed by later P3 integration.
    this.enqueue({
      kind: 'observation',
      subject: this.subjectKey(observation.captureSubject),
      value: observation,
      bytes: 1_024,
    });
  }

  submitDetail(capture: AnalyticsDetailCapture): void {
    if (!this.options.enabled) return;
    this.enqueue({
      kind: 'detail',
      subject: this.subjectKey(capture.captureSubject),
      value: capture,
      bytes: capture.bytes.byteLength,
    });
  }

  async flush(): Promise<void> {
    if (!this.options.enabled) return;
    if (!this.running) throw this.failure ?? new Error('Analytics recorder worker is not running.');
    this.pump();
    await this.request({ type: 'flush' });
  }

  async deleteSession(
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
  ): Promise<AnalyticsDeleteReceipt | undefined> {
    if (!this.options.enabled) return undefined;
    return this.request({ type: 'deleteSession', rootSessionId, sourceKey, timestampMs }) as Promise<AnalyticsDeleteReceipt>;
  }

  async workerStats(): Promise<AnalyticsRecorderWorkerStats | undefined> {
    if (!this.options.enabled) return undefined;
    return this.request({ type: 'stats' }) as Promise<AnalyticsRecorderWorkerStats>;
  }

  /** Rehearses a clean helper replacement only; it does not restart VS Code or
   * arm a later activation. Pending capture must be flushed first. */
  async restart(): Promise<void> {
    if (!this.options.enabled) return;
    await this.shutdown();
    await this.start();
  }

  async shutdown(): Promise<void> {
    if (!this.options.enabled || !this.child) return;
    this.stopping = true;
    const child = this.child;
    try {
      this.pump();
      await this.request({ type: 'shutdown' }, this.options.shutdownTimeoutMs ?? 10_000);
      await this.waitForExit(child, this.options.shutdownTimeoutMs ?? 10_000);
    } finally {
      if (this.child === child) this.child = undefined;
      this.stopping = false;
    }
  }

  private enqueue(item: QueueItem): void {
    if (!this.running) throw this.failure ?? new Error('Analytics recorder worker is not running.');
    const records = this.queue.length + this.inFlightRecords + 1;
    const bytes = this.queuedBytes + this.inFlightBytes + item.bytes;
    if (records > (this.options.maxQueueRecords ?? 65_536)
      || bytes > (this.options.maxQueueBytes ?? 64 * 1024 * 1024)) {
      this.rejectedRecords += 1;
      throw new AnalyticsCaptureCapacityError(records, bytes);
    }
    this.queue.push(item);
    this.queuedBytes += item.bytes;
    this.observePeak();
    if (!this.pumpScheduled) {
      this.pumpScheduled = true;
      queueMicrotask(() => this.pump());
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
    child.stderr?.on('data', () => undefined);
    child.on('message', (message: unknown) => this.onMessage(message));
    child.once('exit', (code, signal) => this.onExit(child, code, signal));
    child.once('error', (error) => this.onFailure(error));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Analytics recorder worker startup timed out.')), this.options.startupTimeoutMs ?? 10_000);
      const onMessage = (raw: unknown) => {
        const message = raw as { type?: string; error?: string };
        if (message.type === 'ready') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          resolve();
        } else if (message.type === 'fatal') {
          clearTimeout(timeout);
          child.off('message', onMessage);
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
  }

  private pump(): void {
    this.pumpScheduled = false;
    if (this.queue.length === 0) return;
    const maxBatchSize = Math.max(1, this.options.maxBatchSize ?? 256);
    while (this.queue.length > 0) {
      const kind = this.queue[0]!.kind;
      const subject = this.queue[0]!.subject;
      const items: QueueItem[] = [];
      while (items.length < maxBatchSize
        && this.queue[0]?.kind === kind
        && this.queue[0]?.subject === subject) {
        items.push(this.queue.shift()!);
      }
      const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
      this.queuedBytes -= bytes;
      this.inFlightRecords += items.length;
      this.inFlightBytes += bytes;
      this.observePeak();
      const message = kind === 'observation'
        ? { type: 'record', observations: items.map((item) => item.value) }
        : { type: 'detail', captures: items.map((item) => item.value) };
      void this.request(message, 30_000, items.length, bytes).catch((error) => {
        this.deliveryFailures += items.length;
        this.lastRejectedDelivery = error;
      });
    }
  }

  private request(
    message: Record<string, unknown>,
    timeoutMs = 30_000,
    records = 0,
    bytes = 0,
  ): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) {
      this.settleAccounting(records, bytes);
      return Promise.reject(this.failure ?? new Error('Analytics recorder worker is not connected.'));
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (pending) this.settleAccounting(pending.records, pending.bytes);
        reject(new Error(`Analytics recorder request ${requestId} timed out.`));
      }, timeoutMs);
      this.pending.set(requestId, {
        records,
        bytes,
        resolve: (value) => {
          clearTimeout(timeout);
          this.settleAccounting(records, bytes);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.settleAccounting(records, bytes);
          reject(error);
        },
      });
      child.send({ ...message, requestId }, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        pending?.reject(error);
      });
    });
  }

  private onMessage(raw: unknown): void {
    const message = raw as { type?: string; requestId?: number; error?: string; receipt?: unknown };
    if ((message.type !== 'ack' && message.type !== 'error') || typeof message.requestId !== 'number') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new Error(message.error ?? 'Analytics recorder request failed.'));
    else pending.resolve(message.receipt);
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (!this.stopping) this.onFailure(new Error(`Analytics recorder worker exited (${code ?? signal ?? 'unknown'}).`));
  }

  private onFailure(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private subjectKey(subject: AnalyticsObservation['captureSubject']): string {
    switch (subject.kind) {
      case 'session': return `session:${subject.rootSessionId}`;
      case 'pendingCreate': return `pendingCreate:${subject.operationId}`;
      case 'host': return `host:${subject.hostId}`;
    }
  }

  private settleAccounting(records: number, bytes: number): void {
    this.inFlightRecords = Math.max(0, this.inFlightRecords - records);
    this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
  }

  private observePeak(): void {
    this.peakRecords = Math.max(this.peakRecords, this.queue.length + this.inFlightRecords);
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
}
