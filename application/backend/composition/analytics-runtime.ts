import {
  AnalyticsRuntimeAuthority,
  AnalyticsRuntimeError,
  type CanonicalAnalyticsRuntimeContext,
} from '../../../analytics/authority/analytics-runtime.js';
import {
  canonicalAnalyticsDatabasePath,
  type CanonicalAggregateRequest,
} from '../../../analytics/queries/query-entry.js';
import {
  AnalyticsRecorderSupervisor,
  type AnalyticsRecorderWriterAdmission,
} from '../../../analytics/recording/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../../../analytics/queries/query-client.js';

function validateAnalyticsTimeZone(configuredTimeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configuredTimeZone }).format(new Date(0));
  } catch {
    throw new AnalyticsRuntimeError(`Analytics timezone is not a valid IANA name: ${configuredTimeZone}`);
  }
  return configuredTimeZone;
}

export interface AnalyticsRuntimeOptions {
  /** Composition owns namespace selection; lifecycle admission authorizes writes. */
  canonicalContext: CanonicalAnalyticsRuntimeContext;
  stateDir: string;
  analyticsDir: string;
  /** Packaged helpers in the loaded runtime generation. */
  recorderWorkerScript: string;
  queryWorkerScript: string;
  buildId: string;
  workspaceId: string;
  /** Fresh per host process, distinct from workspaceId. */
  processGeneration: string;
  /** Stable active IANA calendar zone captured once per host. */
  timeZone?: string;
  writerAdmission: AnalyticsRecorderWriterAdmission;
  onError?: (error: unknown, stage: string) => void;
}

export interface AnalyticsRuntimeReadiness {
  authority: 'canonical';
  generationId: string;
  recorderSchemaVersion: number;
  projectionRevision: string | null;
  recorderReady: boolean;
  queryReady: boolean;
}

/** Narrow host seam implemented by the canonical runtime. */
export interface AnalyticsRuntimePort {
  readonly analyticsTimeZone: string;
  start(): Promise<AnalyticsRuntimeReadiness>;
  getCanonicalContext(): CanonicalAnalyticsRuntimeContext | undefined;
  /** Revoke producer admission and drain already accepted recorder writes. */
  fenceWriters(timeoutMs?: number): Promise<number>;
  stop(): Promise<void>;
}

interface AnalyticsHelperStartup {
  recorder: AnalyticsRecorderSupervisor;
  queryClient: AnalyticsQueryClient;
  recorderSchemaVersion: number;
  projectionRevision: string | null;
}

/** Real recorder and disposable-query readiness; failure never selects another
 * capture path or leaves a half-started recorder behind. */
async function startAnalyticsHelpers(options: {
  recorderWorkerScript: string;
  queryWorkerScript: string;
  databasePath: string;
  writerAdmission: AnalyticsRecorderWriterAdmission;
}): Promise<AnalyticsHelperStartup> {
  const recorder = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: options.recorderWorkerScript,
    databasePath: options.databasePath,
    writerAdmission: options.writerAdmission,
  });
  try {
    await recorder.start();
    const stats = await recorder.workerStats();
    if (!stats) throw new AnalyticsRuntimeError('Canonical recorder did not report worker stats.');
    const recorderSchemaVersion = Number(stats.recorder?.databaseSchemaVersion ?? Number.NaN);
    if (!Number.isSafeInteger(recorderSchemaVersion)) {
      throw new AnalyticsRuntimeError('Canonical recorder did not report a schema version.');
    }
    const queryClient = new AnalyticsQueryClient({
      databasePath: options.databasePath,
      workerScript: options.queryWorkerScript,
      timeoutMs: 10_000,
    });
    const schema = await queryClient.query<{ databaseSchemaVersion: number }>({ type: 'schema' });
    const projection = await queryClient.query<{ rows: Array<{ revision?: unknown }> }>({
      type: 'query',
      sql: 'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
    });
    const revisionValue = projection.rows[0]?.revision;
    const projectionRevision = revisionValue === undefined || revisionValue === null
      ? null : String(revisionValue);
    if (schema.databaseSchemaVersion !== recorderSchemaVersion) {
      throw new AnalyticsRuntimeError(
        `Canonical schema mismatch: recorder reports ${recorderSchemaVersion}, query reports ${schema.databaseSchemaVersion}.`,
      );
    }
    return { recorder, queryClient, recorderSchemaVersion, projectionRevision };
  } catch (error) {
    await recorder.shutdown().catch(() => { /* preserve original failure */ });
    throw error;
  }
}

/** Owns canonical helpers. Readiness, never a historical activation artifact,
 * publishes capture identity. Capture stays closed if either helper fails. */
export class AnalyticsRuntime implements AnalyticsRuntimePort {
  private readonly authority: AnalyticsRuntimeAuthority;
  private recorder: AnalyticsRecorderSupervisor | undefined;
  private queryClient: AnalyticsQueryClient | undefined;
  private readiness: AnalyticsRuntimeReadiness | undefined;
  private readonly timeZone: string;
  private preparedDailyProjectionKey: string | undefined;
  private preparingDailyProjection: Promise<void> | undefined;
  private starting: Promise<AnalyticsRuntimeReadiness> | undefined;
  private stopping: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: AnalyticsRuntimeOptions) {
    this.authority = new AnalyticsRuntimeAuthority(options);
    if (!options.writerAdmission || typeof options.writerAdmission.acquire !== 'function') {
      throw new AnalyticsRuntimeError('Canonical startup requires lifecycle writer admission.');
    }
    const configuredTimeZone = options.timeZone?.trim()
      || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.timeZone = validateAnalyticsTimeZone(configuredTimeZone);
  }

  get databasePath(): string {
    return canonicalAnalyticsDatabasePath(this.options.analyticsDir);
  }

  get analyticsTimeZone(): string {
    return this.timeZone;
  }

  /** Prepare the writer-owned local-day window before a read. Competing zones
   * fail closed; reads never cause a last-writer-wins timezone rebuild. */
  async prepareProviderDailyProjection(request: CanonicalAggregateRequest): Promise<void> {
    if (this.stopped) throw new AnalyticsRuntimeError('Analytics runtime has stopped.');
    if (request.timeZone !== undefined && request.timeZone !== this.timeZone) {
      throw new AnalyticsRuntimeError(
        `Analytics aggregate timezone ${request.timeZone} does not match the configured runtime timezone ${this.timeZone}.`,
      );
    }
    const windowStartMs = request.dailyWindowStartMs ?? request.weekStartMs;
    const windowEndMs = request.dailyWindowEndMs ?? request.weekEndMs;
    if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(windowEndMs)
      || windowStartMs >= windowEndMs) {
      throw new RangeError('Analytics daily projection window is invalid.');
    }
    const key = `${this.timeZone}\0${windowStartMs}\0${windowEndMs}`;
    for (;;) {
      if (this.preparedDailyProjectionKey === key) return;
      const pending = this.preparingDailyProjection;
      if (!pending) break;
      await pending;
    }
    const recorder = this.recorder;
    if (!recorder || !this.readiness) {
      throw new AnalyticsRuntimeError('Canonical recorder is not ready for daily projection preparation.');
    }
    const promise = (async () => {
      await recorder.prepareProviderDailyProjection(this.timeZone, windowStartMs, windowEndMs, false);
      if (this.stopped) throw new AnalyticsRuntimeError('Analytics runtime stopped during daily projection preparation.');
      this.preparedDailyProjectionKey = key;
    })();
    this.preparingDailyProjection = promise;
    try {
      await promise;
    } finally {
      if (this.preparingDailyProjection === promise) this.preparingDailyProjection = undefined;
    }
  }

  start(): Promise<AnalyticsRuntimeReadiness> {
    if (this.stopped) return Promise.reject(new AnalyticsRuntimeError('Analytics runtime has stopped.'));
    if (this.starting) return this.starting;
    if (this.readiness) return Promise.resolve(this.readiness);
    const startup = this.startInternal();
    this.starting = startup;
    void startup.then(
      () => { if (this.starting === startup) this.starting = undefined; },
      () => { if (this.starting === startup) this.starting = undefined; },
    );
    return startup;
  }

  getCanonicalContext(): CanonicalAnalyticsRuntimeContext | undefined {
    return this.readiness ? this.authority.canonicalContext : undefined;
  }

  private async startInternal(): Promise<AnalyticsRuntimeReadiness> {
    let helpers: AnalyticsHelperStartup | undefined;
    try {
      helpers = await startAnalyticsHelpers({
        recorderWorkerScript: this.options.recorderWorkerScript,
        queryWorkerScript: this.options.queryWorkerScript,
        databasePath: this.databasePath,
        writerAdmission: this.options.writerAdmission,
      });
      if (this.stopped) throw new AnalyticsRuntimeError('Analytics runtime stopped during startup.');
      this.recorder = helpers.recorder;
      this.queryClient = helpers.queryClient;
      this.readiness = {
        authority: 'canonical',
        generationId: this.authority.canonicalContext.generationId,
        recorderSchemaVersion: helpers.recorderSchemaVersion,
        projectionRevision: helpers.projectionRevision,
        recorderReady: true,
        queryReady: true,
      };
      return this.readiness;
    } catch (error) {
      if (helpers) await helpers.recorder.shutdown().catch(() => { /* preserve startup error */ });
      this.recorder = undefined;
      this.queryClient = undefined;
      this.readiness = undefined;
      if (!this.stopped) {
        this.stopped = true;
        this.options.onError?.(error, 'canonical-startup');
      }
      throw error;
    }
  }

  getReadiness(): AnalyticsRuntimeReadiness | undefined {
    return this.readiness;
  }

  get sink(): AnalyticsRecorderSupervisor | undefined {
    return this.recorder;
  }

  get reads(): AnalyticsQueryClient | undefined {
    return this.queryClient;
  }

  /** Revoke producer admission and drain capture and lifecycle control writes. */
  async fenceWriters(timeoutMs = 10_000): Promise<number> {
    const recorder = this.recorder;
    if (!recorder) return 0;
    await recorder.fence(timeoutMs);
    const backlog = recorder.backlog;
    return backlog.queuedRecords + backlog.inFlightRecords;
  }

  /** Terminal and idempotent. Startup owns its admission until publication or
   * cleanup, so shutdown joins it before reporting that writers are stopped. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.preparedDailyProjectionKey = undefined;
    this.readiness = undefined;
    const startup = this.starting;
    this.stopping = (async () => {
      await startup?.catch(() => undefined);
      const recorder = this.recorder;
      this.recorder = undefined;
      this.queryClient = undefined;
      if (recorder) await recorder.shutdown().catch(() => { /* preserve caller error */ });
    })();
    return this.stopping;
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

export { AnalyticsRuntimeError };
