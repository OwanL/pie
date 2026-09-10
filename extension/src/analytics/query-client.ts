import { fork } from 'node:child_process';
import { deserialize } from 'node:v8';

export type AnalyticsQueryRequest =
  | { type: 'schema'; maxResultBytes?: number }
  | {
      type: 'query';
      sql: string;
      parameters?: readonly unknown[];
      maxRows?: number;
      maxQueryBytes?: number;
      maxCellBytes?: number;
      maxResultBytes?: number;
    }
  | { type: 'detail'; payloadId: string; offset?: number | string; maxBytes?: number; maxResultBytes?: number }
  | { type: 'storage'; maxResultBytes?: number }
  // Compatibility commands for the in-tree accounting adapters.
  | { type: 'providerSettlements'; rootSessionId?: string; limit?: number; maxResultBytes?: number }
  | { type: 'providerAccounting'; rootSessionId?: string; maxResultBytes?: number }
  | { type: 'historicalDimensions'; maxResultBytes?: number }
  | { type: 'qualificationSpin'; iterations?: number; maxResultBytes?: number };

export interface AnalyticsQueryClientOptions {
  databasePath: string;
  workerScript: string;
  timeoutMs?: number;
  maxConcurrentQueries?: number;
  maxQueuedQueries?: number;
  /** Per-query JavaScript heap ceiling; native SQLite values remain separately
   * constrained by recorder query/detail result limits. */
  maxOldSpaceMb?: number;
}

/** One disposable read-only helper per historical query. Cancellation and
 * timeout terminate that helper, never the extension-host event loop or the
 * recorder writer. */
export class AnalyticsQueryClient {
  private nextRequestId = 1;
  private activeQueries = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: AnalyticsQueryClientOptions) {}

  async query<Result = unknown>(request: AnalyticsQueryRequest, signal?: AbortSignal): Promise<Result> {
    await this.acquire(signal);
    try {
      return await this.executeQuery<Result>(request, signal);
    } finally {
      this.release();
    }
  }

  private executeQuery<Result>(request: AnalyticsQueryRequest, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Analytics query cancelled.'));
    const requestId = this.nextRequestId++;
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let ready = false;
      const configuredHeapMb = this.options.maxOldSpaceMb ?? 192;
      if (!Number.isSafeInteger(configuredHeapMb) || configuredHeapMb < 64) {
        throw new RangeError('Analytics query maxOldSpaceMb must be a safe integer of at least 64.');
      }
      const maxOldSpaceMb = Math.min(512, configuredHeapMb);
      const child = fork(this.options.workerScript, [], {
        execArgv: [
          ...process.execArgv.filter((argument) => !argument.startsWith('--max-old-space-size=')),
          `--max-old-space-size=${maxOldSpaceMb}`,
        ],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          PIE_ANALYTICS_DATABASE_PATH: this.options.databasePath,
        },
      });
      const finish = (error?: Error, value?: Result): void => {
        if (settled || terminating) return;
        terminating = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const complete = (): void => {
          if (settled) return;
          settled = true;
          child.removeAllListeners();
          if (error) reject(error);
          else resolve(value as Result);
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          complete();
          return;
        }
        child.once('exit', complete);
        if (child.connected) child.disconnect();
        if (!child.killed) child.kill();
      };
      const onAbort = (): void => finish(
        signal?.reason instanceof Error ? signal.reason : new Error('Analytics query cancelled.'),
      );
      const timer = setTimeout(() => finish(new Error(`Analytics query timed out after ${timeoutMs}ms.`)), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('message', (raw: unknown) => {
        const message = raw as { type?: string; requestId?: number; error?: string; bytes?: Uint8Array };
        if (message.type === 'ready' && !ready) {
          ready = true;
          child.send({ ...request, requestId });
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type === 'error') {
          finish(new Error(message.error ?? 'Analytics query failed.'));
          return;
        }
        if (message.type === 'result' && message.bytes) {
          finish(undefined, deserialize(Buffer.from(message.bytes)) as Result);
        }
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, processSignal) => {
        if (!settled) finish(new Error(`Analytics query worker exited (${String(code)}, ${String(processSignal)}).`));
      });
    });
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Analytics query cancelled.'));
    const maximum = Math.max(1, this.options.maxConcurrentQueries ?? 2);
    if (this.activeQueries < maximum) {
      this.activeQueries += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= Math.max(0, this.options.maxQueuedQueries ?? 8)) {
      return Promise.reject(new Error('Analytics query capacity exceeded.'));
    }
    return new Promise<void>((resolve, reject) => {
      const resume = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.activeQueries += 1;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(resume);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error('Analytics query cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(resume);
    });
  }

  private release(): void {
    this.activeQueries = Math.max(0, this.activeQueries - 1);
    this.waiters.shift()?.();
  }
}
