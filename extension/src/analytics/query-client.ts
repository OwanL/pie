import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deserialize } from 'node:v8';

import type { AnalyticsWorkerLifecycleEvent, AnalyticsWorkerIdentity } from './recorder-supervisor.js';

const GRACEFUL_WORKER_EXIT_TIMEOUT_MS = 1_000;

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
  | {
      type: 'providerAggregate';
      todayStartMs: number;
      todayEndMs: number;
      weekStartMs: number;
      weekEndMs: number;
      timeZone?: string;
      dailyWindowStartMs?: number;
      dailyWindowEndMs?: number;
      maxGroups?: number;
      maxResultBytes?: number;
    }
  | { type: 'historicalDimensions'; maxResultBytes?: number }
  | { type: 'qualificationSpin'; iterations?: number; maxResultBytes?: number };

export type AnalyticsQueryLifecyclePhase =
  | 'submitted'
  | 'queued'
  | 'admitted'
  | 'capacity-rejected'
  | 'cancelled-before-start'
  | 'spawned'
  | 'ready'
  | 'terminal'
  | 'settled';

export type AnalyticsQueryWorkerTelemetryStatus =
  | 'available'
  | 'unavailable-cancelled'
  | 'unavailable-terminated'
  | 'unavailable-missing'
  | 'unavailable-invalid'
  | 'unavailable-runtime';

export type AnalyticsQueryWorkerTelemetrySamplePhase =
  | 'after-result-serialization'
  | 'after-error-message-formatting';

export interface AnalyticsQueryWorkerTelemetry {
  readonly workerIdentity: AnalyticsWorkerIdentity;
  /** Process high-water resident set size observed before final IPC framing,
   * converted from Node's KiB value. */
  readonly maxRssBytes: number;
  /** Cumulative worker CPU time in microseconds. Each helper serves one query. */
  readonly userCpuTimeMicros: number;
  readonly systemCpuTimeMicros: number;
  readonly currentMemory: {
    readonly rssBytes: number;
    readonly heapTotalBytes: number;
    readonly heapUsedBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
  };
  readonly runtimeSamplePhase: AnalyticsQueryWorkerTelemetrySamplePhase;
}

const TELEMETRY_MEMORY_FIELDS = [
  'rssBytes',
  'heapTotalBytes',
  'heapUsedBytes',
  'externalBytes',
  'arrayBuffersBytes',
] as const;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameWorkerIdentity(left: unknown, right: AnalyticsWorkerIdentity): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const identity = left as Partial<AnalyticsWorkerIdentity>;
  return identity.pid === right.pid
    && identity.spawnedAtMs === right.spawnedAtMs
    && identity.instanceId === right.instanceId;
}

function validateWorkerTelemetry(
  raw: unknown,
  expectedIdentity: AnalyticsWorkerIdentity,
  expectedPhase: AnalyticsQueryWorkerTelemetrySamplePhase,
): AnalyticsQueryWorkerTelemetry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<AnalyticsQueryWorkerTelemetry> & { currentMemory?: Partial<AnalyticsQueryWorkerTelemetry['currentMemory']> };
  if (!sameWorkerIdentity(candidate.workerIdentity, expectedIdentity)
    || candidate.runtimeSamplePhase !== expectedPhase
    || !isSafeNonNegativeInteger(candidate.maxRssBytes)
    || candidate.maxRssBytes <= 0
    || !isSafeNonNegativeInteger(candidate.userCpuTimeMicros)
    || !isSafeNonNegativeInteger(candidate.systemCpuTimeMicros)
    || !candidate.currentMemory || typeof candidate.currentMemory !== 'object'
    || Array.isArray(candidate.currentMemory)) {
    return undefined;
  }
  for (const field of TELEMETRY_MEMORY_FIELDS) {
    if (!isSafeNonNegativeInteger(candidate.currentMemory[field])) return undefined;
  }
  if (candidate.currentMemory.rssBytes <= 0) return undefined;
  return Object.freeze({
    workerIdentity: Object.freeze({
      pid: expectedIdentity.pid,
      spawnedAtMs: expectedIdentity.spawnedAtMs,
      instanceId: expectedIdentity.instanceId,
    }),
    maxRssBytes: candidate.maxRssBytes,
    userCpuTimeMicros: candidate.userCpuTimeMicros,
    systemCpuTimeMicros: candidate.systemCpuTimeMicros,
    currentMemory: Object.freeze({
      rssBytes: candidate.currentMemory.rssBytes,
      heapTotalBytes: candidate.currentMemory.heapTotalBytes,
      heapUsedBytes: candidate.currentMemory.heapUsedBytes,
      externalBytes: candidate.currentMemory.externalBytes,
      arrayBuffersBytes: candidate.currentMemory.arrayBuffersBytes,
    }),
    runtimeSamplePhase: expectedPhase,
  });
}

export interface AnalyticsQueryAdmissionSnapshot {
  activeQueries: number;
  queuedQueries: number;
  maxConcurrentQueries: number;
  maxQueuedQueries: number;
}

/** One ordered, request-scoped diagnostic observation. The callback is
 * advisory: query completion and queue ownership never depend on it. */
export interface AnalyticsQueryLifecycleEvent {
  clientId: string;
  requestId: number;
  requestType: AnalyticsQueryRequest['type'];
  phase: AnalyticsQueryLifecyclePhase;
  snapshot: AnalyticsQueryAdmissionSnapshot;
  identity?: AnalyticsWorkerIdentity;
  admission?: 'active' | 'queued';
  outcome?: 'resolved' | 'rejected';
  code?: number | null;
  signal?: NodeJS.Signals | null;
  /** Terminal worker evidence. Cancellation/timeout is explicitly null and
   * never inferred from the host process or a periodic lower-bound sample. */
  telemetry?: AnalyticsQueryWorkerTelemetry | null;
  telemetryStatus?: AnalyticsQueryWorkerTelemetryStatus;
}

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
  /** Request admission/worker/settlement evidence. Observers are isolated
   * from the query path and must not be treated as an authority themselves. */
  onQueryLifecycle?: (event: AnalyticsQueryLifecycleEvent) => void;
}

/** One disposable read-only helper per historical query. Cancellation and
 * timeout terminate that helper, never the extension-host event loop or the
 * recorder writer. */
export class AnalyticsQueryClient {
  private nextRequestId = 1;
  private activeQueries = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly clientId = randomUUID();
  private readonly maxConcurrentQueries: number;
  private readonly maxQueuedQueries: number;

  constructor(private readonly options: AnalyticsQueryClientOptions) {
    const configuredConcurrent = options.maxConcurrentQueries ?? 2;
    const configuredQueued = options.maxQueuedQueries ?? 8;
    this.maxConcurrentQueries = Number.isFinite(configuredConcurrent)
      ? Math.max(1, Math.floor(configuredConcurrent)) : 2;
    this.maxQueuedQueries = Number.isFinite(configuredQueued)
      ? Math.max(0, Math.floor(configuredQueued)) : 8;
  }

  async query<Result = unknown>(request: AnalyticsQueryRequest, signal?: AbortSignal): Promise<Result> {
    const requestId = this.nextRequestId++;
    const requestType = request.type;
    this.notifyQueryLifecycle({
      requestId,
      requestType,
      phase: 'submitted',
      snapshot: this.admissionSnapshot(),
    });
    let outcome: 'resolved' | 'rejected' = 'resolved';
    let admitted = false;
    try {
      await this.acquire(requestId, requestType, signal);
      admitted = true;
      return await this.executeQuery<Result>(request, signal, requestId);
    } catch (error) {
      outcome = 'rejected';
      throw error;
    } finally {
      this.notifyQueryLifecycle({
        requestId,
        requestType,
        phase: 'settled',
        outcome,
        snapshot: this.admissionSnapshot(),
      });
      if (admitted) this.release();
    }
  }

  /** O(1) live admission snapshot for bounded diagnostics and tests. */
  getAdmissionSnapshot(): AnalyticsQueryAdmissionSnapshot {
    return this.admissionSnapshot();
  }

  private executeQuery<Result>(request: AnalyticsQueryRequest, signal: AbortSignal | undefined, requestId: number): Promise<Result> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Analytics query cancelled.'));
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      let terminating = false;
      let ready = false;
      let telemetry: AnalyticsQueryWorkerTelemetry | null = null;
      let telemetryStatus: AnalyticsQueryWorkerTelemetryStatus | undefined;
      let gracefulExitTimer: ReturnType<typeof setTimeout> | undefined;
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
      this.notifyWorkerLifecycle({ state: 'spawned', identity: workerIdentity }, requestId, request.type);
      let workerStderr = '';
      child.stderr?.on('data', (chunk: Uint8Array | string) => {
        workerStderr = `${workerStderr}${String(chunk)}`.slice(-8_192);
      });
      const observeTelemetry = (
        raw: unknown,
        phase: AnalyticsQueryWorkerTelemetrySamplePhase,
        claimedStatus?: AnalyticsQueryWorkerTelemetryStatus,
      ): void => {
        if (terminating || telemetryStatus === 'unavailable-cancelled') return;
        if (raw === undefined || raw === null) {
          telemetryStatus = claimedStatus === 'unavailable-runtime'
            ? 'unavailable-runtime'
            : 'unavailable-missing';
          return;
        }
        const validated = validateWorkerTelemetry(raw, workerIdentity, phase);
        if (!validated) {
          telemetry = null;
          telemetryStatus = 'unavailable-invalid';
          return;
        }
        telemetry = validated;
        telemetryStatus = 'available';
      };
      const finish = (
        error?: Error,
        value?: Result,
        forcedTerminationStatus?: AnalyticsQueryWorkerTelemetryStatus,
      ): void => {
        if (settled || terminating) return;
        if (forcedTerminationStatus) telemetryStatus = forcedTerminationStatus;
        terminating = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const complete = (): void => {
          if (settled) return;
          if (gracefulExitTimer !== undefined) {
            clearTimeout(gracefulExitTimer);
            gracefulExitTimer = undefined;
          }
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
        const forceKill = (): void => {
          if (settled || child.exitCode !== null || child.signalCode !== null) return;
          if (!child.killed) child.kill();
        };
        // Successful helpers close their read-only recorder from the child's
        // disconnect handler. Let that close and process exit complete before
        // resolving the query; SIGTERM here races SQLite shutdown with the
        // next concurrent read. Cancellation/timeout remains an immediate
        // bounded kill, with graceful teardown only for ordinary completion.
        if (forcedTerminationStatus || !child.connected) {
          forceKill();
          return;
        }
        gracefulExitTimer = setTimeout(forceKill, GRACEFUL_WORKER_EXIT_TIMEOUT_MS);
        gracefulExitTimer.unref?.();
        try {
          child.disconnect();
        } catch {
          forceKill();
        }
      };
      const onAbort = (): void => finish(
        signal?.reason instanceof Error ? signal.reason : new Error('Analytics query cancelled.'),
        undefined,
        'unavailable-cancelled',
      );
      const timer = setTimeout(() => finish(
        new Error(`Analytics query timed out after ${timeoutMs}ms.`),
        undefined,
        'unavailable-cancelled',
      ), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('message', (raw: unknown) => {
        const message = raw as {
          type?: string;
          requestId?: number;
          error?: string;
          bytes?: Uint8Array;
          workerIdentity?: AnalyticsWorkerIdentity;
          telemetry?: unknown;
          telemetryStatus?: AnalyticsQueryWorkerTelemetryStatus;
        };
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
          this.notifyWorkerLifecycle({ state: 'ready', identity: workerIdentity }, requestId, request.type);
          child.send({ ...request, requestId });
          return;
        }
        if (message.requestId !== requestId) return;
        if (message.type === 'error') {
          observeTelemetry(message.telemetry, 'after-error-message-formatting', message.telemetryStatus);
          finish(new Error(message.error ?? 'Analytics query failed.'));
          return;
        }
        if (message.type === 'result' && message.bytes) {
          observeTelemetry(message.telemetry, 'after-result-serialization', message.telemetryStatus);
          finish(undefined, deserialize(Buffer.from(message.bytes)) as Result);
        }
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code, processSignal) => {
        if (!telemetryStatus) telemetryStatus = 'unavailable-terminated';
        this.notifyWorkerLifecycle(
          { state: 'terminal', identity: workerIdentity, code, signal: processSignal },
          requestId,
          request.type,
          telemetry,
          telemetryStatus,
        );
        const diagnostic = workerStderr.trim();
        if (!settled) finish(new Error(
          `Analytics query worker exited (${String(code)}, ${String(processSignal)})${diagnostic ? `: ${diagnostic}` : '.'}`,
        ));
      });
    });
  }

  private notifyWorkerLifecycle(
    event: AnalyticsWorkerLifecycleEvent,
    requestId: number,
    requestType: AnalyticsQueryRequest['type'],
    telemetry?: AnalyticsQueryWorkerTelemetry | null,
    telemetryStatus?: AnalyticsQueryWorkerTelemetryStatus,
  ): void {
    try {
      this.options.onWorkerLifecycle?.(event);
    } catch {
      // Diagnostic observers cannot change query completion or termination.
    }
    this.notifyQueryLifecycle({
      requestId,
      requestType,
      phase: event.state,
      identity: event.identity,
      ...(event.state === 'terminal' ? { code: event.code ?? null, signal: event.signal ?? null } : {}),
      ...(event.state === 'terminal' ? { telemetry: telemetry ?? null, telemetryStatus } : {}),
      snapshot: this.admissionSnapshot(),
    });
  }

  private notifyQueryLifecycle(event: Omit<AnalyticsQueryLifecycleEvent, 'clientId'>): void {
    try {
      this.options.onQueryLifecycle?.({ clientId: this.clientId, ...event });
    } catch {
      // Diagnostic observers cannot change query completion or queue ownership.
    }
  }

  private admissionSnapshot(): AnalyticsQueryAdmissionSnapshot {
    return {
      activeQueries: this.activeQueries,
      queuedQueries: this.waiters.length,
      maxConcurrentQueries: this.maxConcurrentQueries,
      maxQueuedQueries: this.maxQueuedQueries,
    };
  }

  private acquire(requestId: number, requestType: AnalyticsQueryRequest['type'], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      this.notifyQueryLifecycle({
        requestId,
        requestType,
        phase: 'cancelled-before-start',
        snapshot: this.admissionSnapshot(),
      });
      return Promise.reject(signal.reason ?? new Error('Analytics query cancelled.'));
    }
    if (this.activeQueries < this.maxConcurrentQueries) {
      this.activeQueries += 1;
      this.notifyQueryLifecycle({
        requestId,
        requestType,
        phase: 'admitted',
        admission: 'active',
        snapshot: this.admissionSnapshot(),
      });
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueuedQueries) {
      this.notifyQueryLifecycle({
        requestId,
        requestType,
        phase: 'capacity-rejected',
        snapshot: this.admissionSnapshot(),
      });
      return Promise.reject(new Error('Analytics query capacity exceeded.'));
    }
    return new Promise<void>((resolve, reject) => {
      const resume = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.activeQueries += 1;
        this.notifyQueryLifecycle({
          requestId,
          requestType,
          phase: 'admitted',
          admission: 'queued',
          snapshot: this.admissionSnapshot(),
        });
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(resume);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          this.notifyQueryLifecycle({
            requestId,
            requestType,
            phase: 'cancelled-before-start',
            snapshot: this.admissionSnapshot(),
          });
        }
        reject(signal?.reason ?? new Error('Analytics query cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(resume);
      this.notifyQueryLifecycle({
        requestId,
        requestType,
        phase: 'queued',
        snapshot: this.admissionSnapshot(),
      });
    });
  }

  private release(): void {
    this.activeQueries = Math.max(0, this.activeQueries - 1);
    this.waiters.shift()?.();
  }
}
