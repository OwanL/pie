import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deserialize } from 'node:v8';

import type { AnalyticsWorkerLifecycleEvent, AnalyticsWorkerIdentity } from './recorder-supervisor.js';

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
  | {
      type: 'scopedProviderSettlements';
      scope: import('./sqlite-recorder.js').ProviderSettlementScope;
      limit?: number;
      offset?: number;
      expectedRevision?: number | string;
      maxResultBytes?: number;
    }
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
  /** Explicit fork exec args for source-mode tests or embedding. Production
   * inherits no parent Node/Electron/test flags; the helper owns only its heap
   * ceiling below. */
  execArgv?: readonly string[];
  /** Diagnostic process evidence. `terminal` is emitted only by the child
   * process exit event, after query completion has requested termination. */
  onWorkerLifecycle?: (event: AnalyticsWorkerLifecycleEvent) => void;
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
      const spawnedAtMs = Date.now();
      const instanceId = randomUUID();
      const child = fork(this.options.workerScript, [], {
        execArgv: [
          ...(this.options.execArgv ?? []),
          `--max-old-space-size=${maxOldSpaceMb}`,
        ],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          PIE_ANALYTICS_DATABASE_PATH: this.options.databasePath,
          PIE_ANALYTICS_WORKER_INSTANCE_ID: instanceId,
          PIE_ANALYTICS_WORKER_SPAWNED_AT_MS: String(spawnedAtMs),
        },
      });
      if (!child.pid) throw new Error('Analytics query worker did not expose a process ID.');
      const workerIdentity: AnalyticsWorkerIdentity = Object.freeze({ pid: child.pid, spawnedAtMs, instanceId });
      this.notifyWorkerLifecycle({ state: 'spawned', identity: workerIdentity });
      let workerStderr = '';
      child.stderr?.on('data', (chunk: Uint8Array | string) => {
        workerStderr = `${workerStderr}${String(chunk)}`.slice(-8_192);
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
        const message = raw as { type?: string; requestId?: number; error?: string; bytes?: Uint8Array; workerIdentity?: AnalyticsWorkerIdentity };
        if (message.type === 'fatal') {
          finish(new Error(message.error ?? 'Analytics query worker failed to start.'));
          return;
        }
        if (message.type === 'ready' && !ready) {
          if (message.workerIdentity?.pid !== workerIdentity.pid
            || message.workerIdentity.spawnedAtMs !== workerIdentity.spawnedAtMs
            || message.workerIdentity.instanceId !== workerIdentity.instanceId) {
            finish(new Error('Analytics query worker identity did not match its client instance.'));
            return;
          }
          ready = true;
          this.notifyWorkerLifecycle({ state: 'ready', identity: workerIdentity });
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
        this.notifyWorkerLifecycle({ state: 'terminal', identity: workerIdentity, code, signal: processSignal });
        const diagnostic = workerStderr.trim();
        if (!settled) finish(new Error(
          `Analytics query worker exited (${String(code)}, ${String(processSignal)})${diagnostic ? `: ${diagnostic}` : '.'}`,
        ));
      });
    });
  }

  private notifyWorkerLifecycle(event: AnalyticsWorkerLifecycleEvent): void {
    try {
      this.options.onWorkerLifecycle?.(event);
    } catch {
      // Diagnostic observers cannot change query completion or termination.
    }
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
