import { appendPieLog } from '../util/pie-log';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';
import type { RunSnapshot, TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';
import type {
  AgentSettledPayload,
  AssistantUsage,
  AuxiliaryLlmUsagePayload,
  ComposerInput,
  ThinkingLevel,
  ToolCall,
  WorkingTimeState,
} from '../../shared/protocol';
import type { BillableInvocationRecord } from '../../shared/billable-invocation';
import { RunAnalyticsStorage } from './storage';
import { SessionRunTracker } from './tracker';
import type { AssistantTurnIdentity, RunObserver, StatsServiceOptions } from './types';
import { resolveSessionIdentity } from '../../shared/session-identity';
import { defaultCreateId, defaultNow } from './helpers';
import { WorkingTimeService } from '../working-time-service';
import {
  BillableAccounting,
  type BillableAccountingDeps,
} from '../billable-accounting/service';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type { SessionUsageSnapshot } from '../../shared/session-usage';
import type { LiveLifecycleWatermark } from '../../shared/live-pipeline-protocol.js';
import type {
  AnalyticsSessionContext,
  CanonicalAnalyticsCapture,
} from '../../analytics/canonical-capture.js';
import { analyticsRootSessionId } from '../../analytics/canonical-capture.js';
import type { CanonicalAnalyticsReadModel } from '../../analytics/query-entry.js';
import type { ProviderSettlementScope, ScopedProviderSettlementReadModel } from '../../analytics/sqlite-recorder.js';
import { CanonicalRevisionRefresher } from '../../analytics/revision-refresher.js';
import { sessionUsageSnapshotFromCanonicalSettlements } from '../../analytics/canonical-usage.js';

const MAX_CANONICAL_SESSION_CACHE_ENTRIES = 256;
/** Eager refresh is for the small displayed/running surface only. The cache
 * can retain more history for explicit lazy reads, but a revision invalidation
 * must never turn the whole session catalogue into a query batch. */
const MAX_CANONICAL_DISPLAYED_SESSION_REFRESH_ENTRIES = 32;
const MAX_CANONICAL_SESSION_CACHE_SAMPLES = 4_000;
const MAX_CANONICAL_SESSION_CACHE_BYTES = 4 * 1024 * 1024;

type CanonicalSessionUsageCacheEntry = {
  snapshot: SessionUsageSnapshot;
  revision: string;
  scopeKey: string;
  epoch: number;
  estimatedBytes: number;
  sampleCount: number;
  lastUsed: number;
};

type CanonicalSessionReadResult = {
  revision: string;
  settlements: ScopedProviderSettlementReadModel['settlements'];
  truncated: boolean;
  scopeKey: string;
  branchId?: string;
  unknown?: boolean;
};

type CanonicalPrivateCloseOperation = {
  rootSessionId: string;
  pendingCreateOperationId?: string;
  phase: 'closing' | 'deleted';
  runtimeRetired: boolean;
  promise: Promise<void>;
};

function canonicalRevision(value: string | number): bigint {
  return BigInt(value);
}

function canonicalRevisionString(value: string | number): string {
  return canonicalRevision(value).toString();
}

/** One persistent structured startup-stage measurement, also mirrored in
 *  memory for tests/diagnostics. Emitted for storage.start, the persisted
 *  analytics query, accounting.initialize (ledger and timeline warm-up),
 *  timeline restore, timeline healing, and historical migration. Durations
 *  use the monotonic `performance.now` clock, never the injected wall clock. */
export interface StatsStartupStageMetric {
  stage: string;
  durationMs: number;
  counts: Record<string, number>;
  /** Delta of cumulative timeline read/write/fsync/apply counters
   *  (ActivityTimeline.getDiagnostics()) across the stage. */
  timelineDelta?: Record<string, number>;
}

function stableEvidenceTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

/**
 * RunObserver/query façade for session accounting. Run observation is split by
 * ownership: run/token/working-time tracking stays in {@link SessionRunTracker}
 * and {@link WorkingTimeService}, while billable ledger adaptation (usage
 * events, migration, projection, privacy fences) is owned by
 * {@link BillableAccounting}. Query surfaces (open runs, pending completions,
 * session usage, exports) remain here so callers keep one seam.
 */
export class StatsService implements RunObserver {
  private readonly scheduleRender: () => void;
  private readonly getArchState: NonNullable<StatsServiceOptions['getArchState']>;
  private readonly dispatchArchEvent: NonNullable<StatsServiceOptions['dispatchArchEvent']>;
  private readonly tracker: SessionRunTracker;
  private readonly storage: RunAnalyticsStorage;
  private readonly workingTime: WorkingTimeService;
  private readonly accounting: BillableAccounting;
  private readonly activeBusyIntervalsBySession: Record<string, Set<string> | undefined> = {};
  private readonly activeBusyStartedAtByInterval: Record<string, string | undefined> = {};
  private readonly activeToolIntervalBySessionAndTool: Record<string, string | undefined> = {};
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly canonicalCapture: CanonicalAnalyticsCapture | undefined;
  private readonly analyticsReadModel: CanonicalAnalyticsReadModel | undefined;
  private analyticsRevisionRefresher: CanonicalRevisionRefresher | undefined;
  private canonicalRevisionStart: Promise<void> | null = null;
  /** Last bounded canonical read-model result per visible session path. The
   * durable key is the root session ID; the path is only a host-side lookup
   * key and is never sent to the canonical store. Entries carry the read
   * revision/scope so an older helper response can never replace a newer one. */
  private readonly canonicalSessionUsageByPath = new Map<string, CanonicalSessionUsageCacheEntry>();
  private canonicalSessionUsageCacheBytes = 0;
  private canonicalSessionUsageCacheSamples = 0;
  private canonicalSessionUsageUseSequence = 0;
  private canonicalCacheEpoch = 0;
  private canonicalDirtyRevision: string | null = null;
  private canonicalRefreshRequested = false;
  private canonicalSessionUsageRefresh: Promise<void> | null = null;
  private readonly canonicalSessionPathRefreshes = new Map<string, Promise<void>>();
  private readonly canonicalSessionPathEpochs = new Map<string, number>();
  /** An entry is an in-flight close until the recorder deletion resolves, then
   * remains as an ephemeral display/capture fence until runtime retirement. */
  private readonly canonicalPrivateClosesByPath = new Map<string, CanonicalPrivateCloseOperation>();
  /** Exact create/duplicate origin retained after the pending path is replaced.
   * A close operation ID must never enter this map. */
  private readonly pendingCreateOperationBySessionPath = new Map<string, string>();
  /** Prevent ordinary session refreshes from rescanning or resubmitting the
   * full selected ancestry. Branch switches rehydrate once; appends advance
   * from the prior exact leaf in constant time plus the new suffix. */
  private readonly canonicalBranchEntriesBySession = new Map<string, {
    captured: Set<string>;
    selectedEntryId?: string;
    selectedDepth?: number;
  }>();
  private startPromise: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  /** Tracked background continuation covering the event-loop defer, ledger→
   *  timeline healing, and historical migration, so shutdown() drains or
   *  cancels all of it and no deferred accounting work lands afterwards. */
  private backgroundWork: Promise<void> | null = null;
  /** Compaction is the only deferred accounting operation that cannot consult
   *  the service's disposed flag between every serialization batch. Abort it
   *  explicitly so shutdown does not wait for a full-history rewrite. */
  private readonly backgroundCompactionAbort = new AbortController();
  /** Persisted runs captured during restoration; input to the deferred
   *  historical-migration pass. */
  private deferredMigrationRuns: readonly RunSnapshot[] = [];
  private readonly startupStageMetrics: StatsStartupStageMetric[] = [];

  constructor(options: StatsServiceOptions) {
    this.scheduleRender = options.scheduleRender ?? (() => undefined);
    const dispatchArchEvent = options.dispatchArchEvent ?? ((_event) => { /* no-op if not provided */ });
    this.dispatchArchEvent = dispatchArchEvent;
    const getArchState = options.getArchState ?? (() => { throw new Error('getArchState not provided'); });
    this.getArchState = getArchState;
    const now = options.now ?? defaultNow;
    const createId = options.createId ?? defaultCreateId;
    this.now = now;
    this.createId = createId;
    this.canonicalCapture = options.analyticsCapture?.enabled ? options.analyticsCapture : undefined;
    this.analyticsReadModel = options.analyticsReadModel;
    const getExperimentAssignment = options.getExperimentAssignment ?? (() => null);
    this.workingTime = new WorkingTimeService({
      now,
      onChanged: this.scheduleRender,
    });

    let accountingRef: BillableAccounting | null = null;
    this.storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: options.dataOutcomesRootPath,
      legacyUsageDataRootPath: options.legacyUsageDataRootPath,
      workspaceId: options.workspaceId,
      legacyWorkspaceIds: options.legacyWorkspaceIds,
      now,
      serializeSessions: () => this.tracker.serializeSessions(),
      getBillableInvocationExport: () => accountingRef?.getBillableInvocationExport()
        ?? { billableInvocations: [], activityIntervals: [] },
      onPersistError: ({ message, at }) => {
        appendPieLog('warn', 'run-analytics', 'persistence error surfaced to UI', { at, error: message });
        dispatchArchEvent({
          kind: 'NoticeShown',
          notice: 'pie could not write run analytics to disk. Some diagnostics may be missing until this is fixed.',
          noticeKind: 'operational-error',
          noticeRaw: `Run analytics persistence failed at ${at}: ${message}`,
        });
      },
    });
    const accountingDeps: BillableAccountingDeps = {
      getStorageDir: () => this.storage.getStorageDir(),
      now,
      scheduleRender: this.scheduleRender,
      dispatchArchEvent,
      getAgentDir: options.getAgentDir ?? (() => null),
      isPrivateSession: (sessionPath) => this.isPrivateSession(sessionPath),
      sessionIdentity: (sessionPath) => this.sessionIdentity(sessionPath),
      currentRunId: (sessionPath) => this.currentRunId(sessionPath),
      activeOperationId: (sessionPath) => this.activeOperationId(sessionPath),
      markDerivedExportDirty: () => this.storage.markDerivedExportDirty(),
      ...(this.canonicalCapture ? { canonicalCapture: this.canonicalCapture } : {}),
    };
    accountingRef = new BillableAccounting(accountingDeps);
    this.accounting = accountingRef;
    const tracker = new SessionRunTracker({
      getArchState,
      dispatchArchEvent,
      scheduleRender: this.scheduleRender,
      schedulePersist: this.canonicalCapture
        ? () => undefined
        : (snapshotToAppend) => this.storage.schedulePersist(snapshotToAppend),
      now,
      createId,
      getExperimentAssignment,
    });
    this.tracker = tracker;
  }

  /** In-memory mirror of the persistent startup stage metrics. */
  getStartupStageMetrics(): readonly StatsStartupStageMetric[] {
    return this.startupStageMetrics;
  }

  async start(): Promise<void> {
    // Canonical capture has no legacy restore/import fallback. Restore the
    // bounded durable session projection before making the host usable; the
    // old early return left every post-restart session view empty.
    if (this.canonicalCapture) {
      if (this.disposed || this.started) return;
      if (this.startPromise) {
        await this.startPromise;
        return;
      }
      const startup = (async () => {
        const canonicalQueryStartAt = performance.now();
        await this.refreshCanonicalSessionUsage();
        if (this.disposed) return;
        this.recordStage('canonical-session-usage', canonicalQueryStartAt, {
          sessions: this.canonicalSessionUsageByPath.size,
        });
        this.started = true;
        this.startCanonicalRevisionRefresh();
        this.scheduleRender();
      })();
      this.startPromise = startup;
      try {
        await startup;
      } finally {
        this.startPromise = null;
      }
      return;
    }
    // Shutdown is terminal: never reactivate storage/restoration after it.
    if (this.disposed) {
      return;
    }
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    // Startup covers only essential restoration: storage, tracker restore,
    // the persisted analytics query, ledger and timeline warm-up, and
    // working-time restoration. Healing and historical migration are deferred
    // background work (see runDeferredStartupWork) so the first usable panel
    // never waits for either.
    const startup = (async () => {
      const storageStartAt = performance.now();
      const checkpoint = await this.storage.start();
      this.recordStage('storage.start', storageStartAt);
      if (this.disposed) return;
      this.tracker.restore(checkpoint?.sessions ?? {});
      const openBusyIntervals = this.tracker.getOpenBusyIntervals()
        .filter((interval) => !this.isPrivateSession(interval.sessionPath));
      const persistedRuns: RunSnapshot[] = [];
      try {
        const queryStartAt = performance.now();
        const persisted = await this.storage.queryPersistedRunAnalytics();
        if (this.disposed) return;
        for (const run of [...persisted.completedRuns, ...persisted.openRuns]) {
          if (!this.isPrivateSession(run.sessionPath)) persistedRuns.push(run);
        }
        this.deferredMigrationRuns = persistedRuns;
        this.recordStage('persisted-query', queryStartAt, {
          completedRuns: persisted.completedRuns.length,
          openRuns: persisted.openRuns.length,
        });
      } catch (error) {
        appendPieLog('warn', 'working-time', 'could not restore historical session working time', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.disposed) return;
      // Capture the timeline diagnostics before the warm-up so the stage
      // delta includes the timeline's own initialize counters.
      const initializeDiagnostics = this.timelineDiagnostics();
      const initializeStartAt = performance.now();
      await this.accounting.initialize();
      if (this.disposed) return;
      this.recordStage('accounting.initialize', initializeStartAt, {
        ledgerRows: this.accounting.exportRecords().length,
      }, initializeDiagnostics);
      // Working-time restoration reads the timeline file projection, not the
      // ledger heal, so healing can be deferred off the startup path.
      const restoreStartAt = performance.now();
      const restoreDiagnostics = this.timelineDiagnostics();
      const activityIntervals = this.accounting.activityTimeline.projectAll()
        .filter((interval) => !this.isPrivateSession(interval.sessionPath));
      this.workingTime.restoreActivityIntervals(activityIntervals);
      const timelineCoveredBusyPaths = new Set(activityIntervals
        .filter((interval) => interval.kind === 'busy')
        .map((interval) => interval.sessionPath));
      this.workingTime.restoreRuns(
        persistedRuns,
        openBusyIntervals.filter((interval) => !timelineCoveredBusyPaths.has(interval.sessionPath)),
      );
      for (const interval of activityIntervals) {
        if (!interval.endedAt && interval.kind === 'busy') {
          (this.activeBusyIntervalsBySession[interval.sessionPath] ??= new Set()).add(interval.intervalId);
        } else if (!interval.endedAt && interval.kind === 'tool' && interval.toolId) {
          this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(interval.sessionPath, interval.toolId)] = interval.intervalId;
        }
      }
      this.recordStage('timeline-restore', restoreStartAt, {
        restoredIntervals: activityIntervals.length,
      }, restoreDiagnostics);
      // Startup completes here: the resolved promise and the first scheduled
      // render precede all restart-only accounting work.
      this.started = true;
      this.scheduleRender();
    })();
    this.startPromise = startup;

    // Background continuation after startup resolved. The promise covering
    // defer, healing, and migration is tracked on the instance so shutdown()
    // drains/cancels all of it; failures are caught so deferred accounting
    // work can never surface as an unhandled rejection or reject the
    // already-resolved start() promise. It is assigned only once startup
    // resolved: a shutdown while startup is still pending must not await the
    // chain — the disposed checks in runDeferredStartupWork keep any
    // late-resolving startup from starting deferred work instead.
    void startup
      .then(() => {
        this.backgroundWork = this.runDeferredStartupWork()
          .catch((error) => {
            appendPieLog('warn', 'stats-service', 'deferred startup accounting work failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      })
      .catch((error) => {
        appendPieLog('warn', 'stats-service', 'deferred startup accounting work failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Background continuation of start(): ledger→timeline healing and the
   *  historical usage migration. Runs strictly after the start() promise
   *  resolved and the first render was scheduled, deferred by an explicit
   *  event-loop turn. Cancellation-aware: shutdown stops healing at its next
   *  bounded batch and the migration at its next run boundary or attempted
   *  row (bounded drain — never a full legacy-catalogue wait) so no ledger
   *  write, activity write, or render can land after shutdown.
   *
   *  Healed intervals are provider/auxiliary/history_compaction kinds only,
   *  which WorkingTimeService.restoreActivityIntervals ignores (it consumes
   *  busy/tool intervals exclusively), so a late heal can never rewrite or
   *  double-count live working-time clocks restored at startup. */
  private async runDeferredStartupWork(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.disposed) return;

    const healStartAt = performance.now();
    const healDiagnostics = this.timelineDiagnostics();
    try {
      const heal = await this.accounting.healActivityFromLedger({
        shouldContinue: () => !this.disposed,
      });
      this.recordStage('timeline-healing', healStartAt, {
        ledgerRowsConsidered: heal.ledgerRowsConsidered,
        healedIntervals: heal.healedIntervals,
        activityBatchFlushes: heal.activityBatchFlushes,
        cancelled: heal.cancelled ? 1 : 0,
      }, healDiagnostics);
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'activity heal failed; continuing to historical migration', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.disposed) return;

    const migrationStartAt = performance.now();
    const migrationDiagnostics = this.timelineDiagnostics();
    try {
      const metrics = await this.accounting.migrateHistoricalRunUsage(
        this.deferredMigrationRuns,
        { shouldContinue: () => !this.disposed },
      );
      this.recordStage('historical-migration', migrationStartAt, {
        runsConsidered: metrics.runsConsidered,
        attemptedRows: metrics.attemptedRows,
        newInvocationRows: metrics.newInvocationRows,
        activityBatchFlushes: metrics.activityBatchFlushes,
        cancelled: metrics.cancelled ? 1 : 0,
      }, migrationDiagnostics);
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'historical usage migration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Explicit background compaction boundary: routine mutations append only,
    // and the migration's bounded journal batches leave delta-journal lines
    // behind. Fold them into the canonical snapshot in the background, never
    // after shutdown.
    if (this.disposed) return;
    try {
      await this.accounting.activityTimeline.compact({ signal: this.backgroundCompactionAbort.signal });
    } catch (error) {
      appendPieLog('warn', 'stats-service', 'activity timeline compaction failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Cumulative ActivityTimeline diagnostics snapshot for stage deltas. */
  private timelineDiagnostics(): Record<string, number> {
    return { ...this.accounting.activityTimeline.getDiagnostics() };
  }

  /** Record one structured startup stage: duration, counts, and (when the
   *  timeline exposes cumulative counters) the timeline diagnostics delta.
   *  Persisted via the pie log and mirrored in memory. */
  private recordStage(
    stage: string,
    startedAtMs: number,
    counts: Record<string, number> = {},
    diagnosticsBefore?: Record<string, number>,
  ): void {
    const metric: StatsStartupStageMetric = {
      stage,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      counts: { ...counts },
    };
    if (diagnosticsBefore) {
      const after = this.timelineDiagnostics();
      const delta: Record<string, number> = {};
      for (const [key, value] of Object.entries(after)) {
        const before = diagnosticsBefore[key];
        if (before !== undefined) delta[key] = value - before;
      }
      if (Object.keys(delta).length > 0) metric.timelineDelta = delta;
    }
    this.startupStageMetrics.push(metric);
    appendPieLog('info', 'stats-service', 'startup stage metrics', { ...metric });
  }

  private isPrivateSession(sessionPath: string): boolean {
    return this.getArchState().sessions.privacyModeBySession[sessionPath] === true;
  }

  private isCanonicalCloseActive(sessionPath: string): boolean {
    return this.canonicalCapture !== undefined && this.canonicalPrivateClosesByPath.has(sessionPath);
  }

  private syncWorkingTimeBreakdown(sessionPath: string): void {
    const run = this.tracker.getMostRelevantRun(sessionPath);
    if (run) this.workingTime.observeRun(run);
  }

  private sessionIdentity(sessionPath: string): { sessionId: string | null; modelId?: string; provider?: string } {
    const summary = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath);
    return {
      sessionId: summary?.identityFallback === true ? null : summary?.sessionId?.trim() || null,
      modelId: summary?.modelId,
      provider: summary?.provider,
    };
  }

  private currentRunId(sessionPath: string): string | null {
    return this.tracker.getMostRelevantRun(sessionPath)?.runId ?? null;
  }

  private analyticsContext(sessionPath: string, operationIdOverride?: string | null): AnalyticsSessionContext {
    const identity = this.sessionIdentity(sessionPath);
    return {
      sessionId: identity.sessionId,
      sessionPath,
      runId: this.currentRunId(sessionPath),
      // An explicit null is an identity miss from a protocol-owned event. It
      // must not select whichever reducer operation happens to be active now;
      // omission retains compatibility for older direct observer callers.
      operationId: operationIdOverride === undefined
        ? this.activeOperationId(sessionPath)
        : operationIdOverride,
    };
  }

  private activeOperationId(sessionPath: string): string | null {
    const operation = Object.values(this.getArchState().operations).find((candidate) => (
      !candidate.terminal
      && (candidate.session.resolvedPath === sessionPath || candidate.session.pendingPath === sessionPath)
    ));
    return operation?.operationId ?? null;
  }

  private toolIntervalKey(sessionPath: string, toolId: string): string {
    return `${sessionPath}\0${toolId}`;
  }

  /** Clear private display state while the operational close deletes its facts. */
  async closePrivateSessionAnalytics(
    sessionPath: string,
    pendingCreateOperationId?: string,
    stableRootSessionId?: string,
  ): Promise<void> {
    if (this.canonicalCapture) {
      // Resolve the durable identity before looking for a concurrent close.
      // The cleanup operation must never become the analytics subject.
      const rootSessionId = stableRootSessionId?.trim() || resolveSessionIdentity(sessionPath).sessionId;
      const pendingOrigin = pendingCreateOperationId?.trim()
        || this.pendingCreateOperationBySessionPath.get(sessionPath);
      const existing = this.canonicalPrivateClosesByPath.get(sessionPath);
      if (existing) {
        if (existing.rootSessionId !== rootSessionId
          || existing.pendingCreateOperationId !== pendingOrigin) {
          throw new Error(`Concurrent canonical private close identity conflicts for ${sessionPath}.`);
        }
        await existing.promise;
        return;
      }

      const operation: CanonicalPrivateCloseOperation = {
        rootSessionId,
        ...(pendingOrigin ? { pendingCreateOperationId: pendingOrigin } : {}),
        phase: 'closing',
        runtimeRetired: false,
        promise: Promise.resolve(),
      };
      this.canonicalPrivateClosesByPath.set(sessionPath, operation);
      operation.promise = this.performCanonicalPrivateClose(sessionPath, operation);
      await operation.promise;
      return;
    }
    await this.setSessionPrivacy(sessionPath, true);
  }

  private async performCanonicalPrivateClose(
    sessionPath: string,
    operation: CanonicalPrivateCloseOperation,
  ): Promise<void> {
    // Hide the old answer immediately, but retain all local live state until
    // the durable deletion fence has committed so a failed close is retryable.
    this.invalidateCanonicalSessionCache();
    this.scheduleRender();
    try {
      await this.canonicalCapture!.closeSession(
        operation.rootSessionId,
        'on',
        this.now().getTime(),
        operation.pendingCreateOperationId,
      );
    } catch (error) {
      if (this.canonicalPrivateClosesByPath.get(sessionPath) === operation) {
        this.canonicalPrivateClosesByPath.delete(sessionPath);
      }
      this.invalidateCanonicalSessionCache();
      this.scheduleRender();
      throw error;
    }

    this.pendingCreateOperationBySessionPath.delete(sessionPath);
    operation.phase = 'deleted';
    this.tracker.discardSession(sessionPath);
    this.workingTime.resetSession(sessionPath, false);
    this.releaseCanonicalSessionCorrelations(sessionPath);
    // Keep the ephemeral fence until the runtime's existing close callback;
    // late local events must not recreate the discarded state.
    this.invalidateCanonicalSessionCache();
    this.scheduleRender();
    if (operation.runtimeRetired && this.canonicalPrivateClosesByPath.get(sessionPath) === operation) {
      this.canonicalPrivateClosesByPath.delete(sessionPath);
    }
  }

  async setSessionPrivacy(sessionPath: string, enabled: boolean): Promise<void> {
    if (this.canonicalCapture) {
      // Canonical privacy remains queryable while open. P2b owns the explicit
      // close/delete barrier and will call the recorder deletion adapter; mode
      // toggles alone must never erase or suppress capture.
      return;
    }
    const sessionId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
    if (!enabled) {
      this.accounting.markSessionOrdinary(sessionPath, sessionId);
      return;
    }
    this.workingTime.resetSession(
      sessionPath,
      this.getArchState().sessions.runningSessionPaths.includes(sessionPath),
    );
    this.tracker.discardSession(sessionPath);
    // Publish the durable privacy fence (and scrub the live timeline plus
    // queued writes) before durable analytics are forgotten.
    this.accounting.markSessionPrivate(sessionPath, sessionId);
    await this.storage.forgetSession(sessionPath, sessionId);
  }

  prepareForSend(
    sessionPath: string,
    inputs: ComposerInput[],
    initialUserMessage = '',
    operationId?: string | null,
  ): string {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return 'private-run';
    const runId = this.isCanonicalCloseActive(sessionPath)
      ? this.currentRunId(sessionPath) ?? this.createId()
      : this.tracker.prepareForSend(sessionPath, inputs, initialUserMessage);
    const context = this.analyticsContext(sessionPath, operationId ?? null);
    // A host run ID is a local accounting grouping, not an execution entity.
    // Protocol-owned sends without an operation ID remain unqualified rather
    // than inventing a canonical operation from that local ID.
    if (this.canonicalCapture && context.operationId) {
      const startedAtMs = this.now().getTime();
      this.canonicalCapture.captureExecution(
        context,
        context.operationId,
        'begin',
        `execution:${context.operationId}:begin`,
        startedAtMs,
        {
          operationId: context.operationId,
          runId,
          operationKind: 'agent-run',
          source: 'host',
          startedAtMs,
        },
      );
    }
    return runId;
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string, identity?: AssistantTurnIdentity): void {
    if (!this.isCanonicalCloseActive(sessionPath)) this.accounting.observeAssistantTurnStarted(sessionPath);
    const context = this.analyticsContext(sessionPath, identity?.operationId ?? null);
    if (this.canonicalCapture && context.operationId) {
      this.canonicalCapture.captureExecution(
        context,
        context.operationId,
        'phase',
        `turn:${turnId}:begin`,
        this.now().getTime(),
        {
          operationId: context.operationId,
          ...(identity?.requestId ? { requestId: identity.requestId } : {}),
          ...(identity?.attemptId ? { attemptId: identity.attemptId } : {}),
          runId: context.runId ?? undefined,
          turnId,
          operationKind: 'assistant-turn',
          source: 'host',
        },
      );
    }
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onAssistantTurnStarted(sessionPath, turnId);
  }

  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    if (!this.isCanonicalCloseActive(sessionPath)) {
      this.accounting.observeSkillPruningUsage(sessionPath, messageId, occurredAt, details);
    }
    const context = this.analyticsContext(sessionPath);
    this.canonicalCapture?.captureFeature(
      context,
      `pruning:${messageId}`,
      `pruning:${messageId}:observation`,
      Date.parse(occurredAt),
      { feature: 'pruning', decision: 'provider-settled', ruleVersion: 'legacy-adapter-v1' },
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onSkillPruningUsage(sessionPath, messageId, occurredAt, details);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status?: TurnThroughputStatus,
    latency?: TurnLatencyMeasurement,
    billing?: {
      modelId?: string;
      provider?: string;
      occurredAt?: string;
      operationId?: string;
      requestId?: string;
      attemptId?: string;
      durableEntryId?: string;
      generationDurationMs?: number;
    },
  ): void {
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.accounting.observeAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, billing);
    const context = this.analyticsContext(sessionPath, billing?.operationId ?? null);
    const sourceOccurredAtMs = stableEvidenceTime(billing?.occurredAt);
    const observedAtMs = sourceOccurredAtMs ?? 0;
    const executionId = context.operationId;
    if (this.canonicalCapture && executionId) {
      const measured = (value: number | undefined): number | null => (
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
      );
      this.canonicalCapture.captureLatency(context, executionId, turnId,
        `turn:${turnId}:latency`, sourceOccurredAtMs ?? 0, {
          turnBoundaryToFirstOutputMs: measured(latency?.turnLatencyMs),
          turnStartToFirstOutputMs: measured(latency?.providerLatencyMs),
          turnPreparationMs: measured(latency?.overheadMs),
          providerQueueMs: measured(latency?.providerQueueMs),
          generationDurationMs: measured(billing?.generationDurationMs),
          requestToFirstOutputMs: null,
          providerFirstOutputWaitMs: null,
          providerHeaderWaitMs: null,
          fullOperationMs: null,
          coverage: 'unknown',
        });
      this.canonicalCapture.captureExecution(
        context,
        executionId,
        'phase',
        `turn:${turnId}:end`,
        observedAtMs,
        {
          operationId: executionId,
          ...(billing?.requestId ? { requestId: billing.requestId } : {}),
          ...(billing?.attemptId ? { attemptId: billing.attemptId } : {}),
          runId: context.runId ?? undefined,
          turnId,
          operationKind: 'assistant-turn',
          source: 'host',
          // The message's createdAt is source evidence, not its terminal clock.
          endedAtMs: null,
          outcome: status ?? 'unknown',
        },
      );
      if (billing?.durableEntryId) {
        this.canonicalCapture.captureExecution(
          context,
          executionId,
          'transcriptEvidence',
          `turn:${turnId}:transcript-evidence`,
          observedAtMs,
          {
            operationId: executionId,
            ...(billing.requestId ? { requestId: billing.requestId } : {}),
            ...(billing.attemptId ? { attemptId: billing.attemptId } : {}),
            runId: context.runId ?? undefined,
            turnId,
            messageId: turnId,
            operationKind: 'assistant-turn',
            source: 'transcript',
            durableEntryId: billing.durableEntryId,
          },
        );
      }
    }
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, latency);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAssistantTerminalWatermark(watermark: LiveLifecycleWatermark, operationId?: string | null): void {
    if (!watermark.durableEntryId) return;
    const context = this.analyticsContext(watermark.sessionPath, operationId ?? null);
    if (this.canonicalCapture && context.operationId) {
      this.canonicalCapture.captureExecution(
        context,
        context.operationId,
        'phase',
        `turn:${watermark.turnId}:terminal-watermark:${watermark.attemptId}`,
        watermark.occurredAt,
        {
          operationId: context.operationId,
          runId: context.runId ?? undefined,
          turnId: watermark.turnId,
          requestId: watermark.requestId,
          attemptId: watermark.attemptId,
          operationKind: 'assistant-turn',
          source: 'backend-live-lifecycle',
          durableEntryId: watermark.durableEntryId,
          terminalWatermark: {
            requestId: watermark.requestId,
            turnId: watermark.turnId,
            attemptId: watermark.attemptId,
            finalSequence: watermark.finalSeq,
            terminalKind: watermark.terminalKind,
            durableEntryId: watermark.durableEntryId,
            occurredAt: watermark.occurredAt,
          },
        },
      );
    }
  }

  onAgentSettled(payload: AgentSettledPayload): void {
    const operationId = payload.operationId?.trim();
    // Settlement without the backend's operation identity cannot safely close
    // a host run. In particular, never turn the local run ID into a guessed
    // operation identity or attribute this receipt to a newer active send.
    if (!operationId || !this.canonicalCapture || this.isCanonicalCloseActive(payload.sessionPath)) return;
    const context = this.analyticsContext(payload.sessionPath, operationId);
    const sourceEndedAtMs = typeof payload.endedAt === 'number' && Number.isFinite(payload.endedAt)
      && payload.endedAt >= 0
      ? Math.trunc(payload.endedAt)
      : typeof payload.occurredAt === 'number' && Number.isFinite(payload.occurredAt) && payload.occurredAt >= 0
        ? Math.trunc(payload.occurredAt)
        : null;
    this.canonicalCapture.captureExecution(
      context,
      operationId,
      'end',
      `execution:${operationId}:agent-settled`,
      // Keep the required envelope timestamp stable across replay. Older
      // backends omit source timing, so retain the explicit unknown sentinel.
      sourceEndedAtMs ?? 0,
      {
        operationId,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.attemptId ? { attemptId: payload.attemptId } : {}),
        operationKind: 'agent-run',
        source: 'backend-agent-settled',
        ...(sourceEndedAtMs === null ? {} : { endedAtMs: sourceEndedAtMs }),
        outcome: 'unknown',
      },
    );
  }

  onSessionUsageSnapshot(
    sessionPath: string,
    sessionId: string | undefined,
    snapshot: SessionUsageSnapshot,
    selectionId?: string,
    selectionObservedAt?: number,
  ): void {
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.accounting.observeSessionUsageSnapshot(sessionPath, sessionId, snapshot);
    const context = this.analyticsContext(sessionPath);
    const state = this.canonicalBranchEntriesBySession.get(sessionPath) ?? { captured: new Set<string>() };
    const previousSelectedEntryId = state.selectedEntryId;
    const previousSelectedDepth = state.selectedDepth;
    const entries = snapshot.branchEntryIds ?? [];
    let startIndex = 0;
    if (state.selectedDepth !== undefined && state.selectedEntryId !== undefined) {
      if (entries.length === state.selectedDepth && snapshot.branchId === state.selectedEntryId) {
        startIndex = entries.length;
      } else if (entries.length >= state.selectedDepth
        && state.selectedDepth > 0
        && entries[state.selectedDepth - 1] === state.selectedEntryId) {
        startIndex = state.selectedDepth;
      }
    }
    for (let index = startIndex; index < entries.length; index += 1) {
      const entryId = entries[index]!;
      if (state.captured.has(entryId)) continue;
      this.canonicalCapture?.captureBranchEdge(
        context,
        entryId,
        index === 0 ? null : entries[index - 1]!,
        0,
        'snapshot',
      );
      state.captured.add(entryId);
    }
    if (entries.length > 0) {
      state.selectedEntryId = snapshot.branchId ?? entries[entries.length - 1];
      state.selectedDepth = entries.length;
      this.canonicalBranchEntriesBySession.set(sessionPath, state);
      if (this.canonicalCapture
        && (previousSelectedEntryId !== state.selectedEntryId || previousSelectedDepth !== state.selectedDepth)) {
        this.invalidateCanonicalSessionCache();
      }
    }
    if (snapshot.branchId && selectionId) {
      this.canonicalCapture?.captureBranchSelection(
        context,
        snapshot.branchId,
        selectionId,
        selectionObservedAt ?? 0,
      );
    }
  }

  onBranchObserved(
    sessionPath: string,
    entryId: string,
    parentEntryId: string | null | undefined,
    selectedEntryId: string,
    observedAt: number,
  ): void {
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.accounting.observeBranchEntry(sessionPath, entryId, parentEntryId, selectedEntryId);
    const state = this.canonicalBranchEntriesBySession.get(sessionPath) ?? { captured: new Set<string>() };
    const previousSelectedEntryId = state.selectedEntryId;
    const previousSelectedDepth = state.selectedDepth;
    state.captured.add(entryId);
    if (state.selectedEntryId !== undefined
      && state.selectedDepth !== undefined
      && parentEntryId === state.selectedEntryId) {
      state.selectedDepth += 1;
    } else {
      state.selectedDepth = undefined;
    }
    state.selectedEntryId = selectedEntryId;
    this.canonicalBranchEntriesBySession.set(sessionPath, state);
    if (this.canonicalCapture
      && (previousSelectedEntryId !== state.selectedEntryId || previousSelectedDepth !== state.selectedDepth)) {
      this.invalidateCanonicalSessionCache();
    }
    const context = this.analyticsContext(sessionPath);
    this.canonicalCapture?.captureBranchEdge(context, entryId, parentEntryId, observedAt);
    this.canonicalCapture?.captureBranchSelection(
      context,
      selectedEntryId,
      `entry:${selectedEntryId}`,
      observedAt,
    );
  }

  onSessionDuplicated(input: {
    destinationPath: string;
    destinationSessionId: string;
    sourcePath: string;
    sourceSessionId: string;
    sourceBranchId?: string;
    operationId: string;
    observedAt: number;
  }): void {
    this.canonicalCapture?.captureCopy(
      { sessionId: input.destinationSessionId, sessionPath: input.destinationPath, operationId: input.operationId },
      { sessionId: input.sourceSessionId, sessionPath: input.sourcePath },
      input.sourceBranchId,
      input.operationId,
      input.observedAt,
    );
  }

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    this.canonicalCapture?.captureTool(
      this.analyticsContext(sessionPath),
      toolCall,
      'begin',
      `tool:${toolCall.id}:begin`,
      toolCall.startedAt ?? this.now().getTime(),
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onToolStarted(sessionPath, toolCall);
    this.workingTime.onToolStarted(sessionPath, toolCall);
    const runId = this.currentRunId(sessionPath);
    const intervalId = `activity:tool:${runId ?? sessionPath}:${toolCall.id}`;
    this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(sessionPath, toolCall.id)] = intervalId;
    const startedAt = new Date(toolCall.startedAt ?? this.now().getTime()).toISOString();
    const interval: ActivityIntervalRecord = {
      schemaVersion: 1,
      intervalId,
      sessionId: this.sessionIdentity(sessionPath).sessionId,
      sessionPath,
      parentRunId: runId,
      parentOperationId: this.activeOperationId(sessionPath),
      invocationId: null,
      toolId: toolCall.id,
      kind: 'tool',
      startedAt,
    };
    if (this.canonicalCapture) this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), interval);
    else {
      this.accounting.activityTimeline.start(interval);
      this.storage.markDerivedExportDirty();
    }
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    const closing = this.isCanonicalCloseActive(sessionPath);
    if (!closing) this.accounting.observeSubagentToolResult(sessionPath, toolCall);
    this.canonicalCapture?.captureTool(
      this.analyticsContext(sessionPath),
      toolCall,
      'end',
      `tool:${toolCall.id}:end`,
      toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
        ? toolCall.startedAt + toolCall.durationMs : this.now().getTime(),
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (closing) return;
    // Close the live wall-time interval before durable telemetry catches up;
    // the service reconciles the two sources without double-counting.
    this.workingTime.onToolFinished(sessionPath, toolCall);
    const toolKey = this.toolIntervalKey(sessionPath, toolCall.id);
    const intervalId = this.activeToolIntervalBySessionAndTool[toolKey];
    if (intervalId) {
      const endedAt = new Date(toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
        ? toolCall.startedAt + toolCall.durationMs : this.now().getTime()).toISOString();
      if (this.canonicalCapture) {
        this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), {
          schemaVersion: 1,
          intervalId,
          sessionId: this.sessionIdentity(sessionPath).sessionId,
          sessionPath,
          parentRunId: this.currentRunId(sessionPath),
          parentOperationId: this.activeOperationId(sessionPath),
          invocationId: null,
          toolId: toolCall.id,
          kind: 'tool',
          startedAt: new Date(toolCall.startedAt ?? Date.parse(endedAt)).toISOString(),
          endedAt,
          outcome: toolCall.status === 'failed' ? 'failed' : 'succeeded',
        });
      } else {
        this.accounting.activityTimeline.settle(
          intervalId,
          endedAt,
          toolCall.status === 'failed' ? 'failed' : 'succeeded',
        );
        this.storage.markDerivedExportDirty();
      }
      delete this.activeToolIntervalBySessionAndTool[toolKey];
    }
    this.tracker.onToolFinished(sessionPath, toolCall);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onInterrupted(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onInterrupted(sessionPath);
  }

  onCompaction(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onCompaction(sessionPath);
  }

  onAuxiliaryLlmUsage(
    sessionPath: string,
    sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>,
  ): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    const observed = this.accounting.observeAuxiliaryLlmUsage(sessionPath, sample);
    if (observed.channelsKnown) {
      this.tracker.onAuxiliaryLlmUsage(sessionPath, observed.sample);
    }
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetry(
    sessionPath: string,
    timing?: { sourceId: string; occurredAt: string; attempt: number; scheduledDelayMs: number },
  ): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.accounting.observeAutoRetry(sessionPath, timing);
    this.tracker.onAutoRetry(sessionPath, timing);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetryMeasured(
    sessionPath: string,
    sourceId: string,
    measuredDelayMs: number | undefined,
    durationMs: number,
    evidence?: Pick<import('../../shared/protocol').RetryMeasuredPayload, 'operationId' | 'startedAt' | 'providerAttemptStartedAt' | 'endedAt'>,
  ): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onAutoRetryMeasured(sessionPath, sourceId, measuredDelayMs, durationMs);
    if (this.canonicalCapture) {
      this.canonicalCapture.captureRetryTiming(this.analyticsContext(sessionPath, evidence?.operationId ?? null), sourceId, {
        ...evidence, measuredDelayMs, durationMs,
      });
      this.syncWorkingTimeBreakdown(sessionPath);
      return;
    }
    const measuredElapsedMs = measuredDelayMs !== undefined
      && Number.isFinite(measuredDelayMs) && measuredDelayMs >= 0
      ? Math.trunc(measuredDelayMs) : null;
    const terminalElapsedMs = Number.isFinite(durationMs) && durationMs >= 0
      ? Math.trunc(durationMs) : null;
    const elapsed = measuredElapsedMs ?? terminalElapsedMs;
    if (!sourceId.trim() || elapsed === null) {
      this.syncWorkingTimeBreakdown(sessionPath);
      return;
    }
    const endedAtMs = this.now().getTime();
    const ownerId = this.currentRunId(sessionPath)
      ?? analyticsRootSessionId(this.sessionIdentity(sessionPath).sessionId, sessionPath);
    const interval: ActivityIntervalRecord = {
      schemaVersion: 1,
      intervalId: `activity:retry-wait:${ownerId}:${sourceId}`,
      sessionId: this.sessionIdentity(sessionPath).sessionId,
      sessionPath,
      parentRunId: this.currentRunId(sessionPath),
      parentOperationId: this.activeOperationId(sessionPath),
      invocationId: null,
      toolId: null,
      kind: 'retry_wait',
      startedAt: new Date(Math.max(0, endedAtMs - elapsed)).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      outcome: 'succeeded',
    };
    this.accounting.activityTimeline.record(interval);
    this.storage.markDerivedExportDirty();
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onMessageEdited(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onMessageEdited(sessionPath);
  }

  onTruncatedAfter(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onTruncatedAfter(sessionPath);
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath || (this.isPrivateSession(sessionPath) && !this.canonicalCapture)) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onBackendError(sessionPath, code);
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number,
    evidence?: Omit<import('../../shared/protocol').ContextUsageChangedPayload, 'sessionPath' | 'contextUsage'>): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    if (Number.isFinite(limit) && limit > 0) this.tracker.onContextUsageChanged(sessionPath, tokens, limit);
    if (this.canonicalCapture) {
      const contextLimitTokens = Number.isSafeInteger(limit) && limit > 0 ? limit : null;
      const qualifiedTokens = evidence?.canonicalInputTokens !== undefined ? evidence.canonicalInputTokens : tokens;
      const inputTokens = qualifiedTokens === null
        ? null
        : Number.isSafeInteger(qualifiedTokens) && qualifiedTokens >= 0 ? qualifiedTokens : null;
      this.canonicalCapture.captureContextObservation(
        this.analyticsContext(sessionPath),
        evidence?.observationId?.trim() || `host-context:${this.createId()}`,
        typeof evidence?.observedAt === 'number' && Number.isSafeInteger(evidence.observedAt)
          ? evidence.observedAt : this.now().getTime(),
        {
          source: evidence?.source ?? 'unknown',
          modelId: evidence?.modelId ?? null,
          provider: evidence?.provider ?? null,
          contextLimitTokens,
          inputTokens,
          estimate: evidence?.source === 'provider' ? false
            : evidence?.source === 'postCompactionEstimate' ? true : null,
        },
      );
    }
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.workingTime.onBusyChanged(sessionPath, busy);
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    this.tracker.onBusyChanged(sessionPath, busy);
    const nowIso = this.now().toISOString();
    if (busy && (this.activeBusyIntervalsBySession[sessionPath]?.size ?? 0) === 0) {
      const runId = this.currentRunId(sessionPath);
      const operationId = this.activeOperationId(sessionPath);
      const ownerId = operationId
        ?? runId
        ?? analyticsRootSessionId(this.sessionIdentity(sessionPath).sessionId, sessionPath);
      // The operation can legitimately emit multiple bounded busy cycles.
      // Allocate a transition identity only when opening a new interval so a
      // repeated cycle cannot overwrite the previous operation span.
      const intervalId = `activity:busy:${ownerId}:${this.createId()}`;
      (this.activeBusyIntervalsBySession[sessionPath] ??= new Set()).add(intervalId);
      this.activeBusyStartedAtByInterval[intervalId] = nowIso;
      const interval: ActivityIntervalRecord = {
        schemaVersion: 1,
        intervalId,
        sessionId: this.sessionIdentity(sessionPath).sessionId,
        sessionPath,
        parentRunId: runId,
        parentOperationId: operationId,
        invocationId: null,
        toolId: null,
        kind: 'busy',
        startedAt: nowIso,
      };
      if (this.canonicalCapture) this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), interval);
      else this.accounting.activityTimeline.start(interval);
    } else if (!busy) {
      const intervalIds = this.activeBusyIntervalsBySession[sessionPath];
      for (const intervalId of intervalIds ?? []) {
        if (this.canonicalCapture) {
          this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), {
            schemaVersion: 1,
            intervalId,
            sessionId: this.sessionIdentity(sessionPath).sessionId,
            sessionPath,
            parentRunId: this.currentRunId(sessionPath),
            parentOperationId: this.activeOperationId(sessionPath),
            invocationId: null,
            toolId: null,
            kind: 'busy',
            startedAt: this.activeBusyStartedAtByInterval[intervalId] ?? nowIso,
            endedAt: nowIso,
            outcome: 'succeeded',
          });
        } else {
          this.accounting.activityTimeline.settle(intervalId, nowIso, 'succeeded');
        }
        delete this.activeBusyStartedAtByInterval[intervalId];
      }
      delete this.activeBusyIntervalsBySession[sessionPath];
    }
    if (!this.canonicalCapture) this.storage.markDerivedExportDirty();
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
    provider?: string,
  ): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onUnsupportedInputAttempt(sessionPath);
  }

  private releaseCanonicalSessionCorrelations(sessionPath: string): void {
    this.canonicalBranchEntriesBySession.delete(sessionPath);
    this.accounting.onSessionClosed(sessionPath);
    const intervals = this.activeBusyIntervalsBySession[sessionPath];
    for (const intervalId of intervals ?? []) delete this.activeBusyStartedAtByInterval[intervalId];
    delete this.activeBusyIntervalsBySession[sessionPath];
    for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
      if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolIntervalBySessionAndTool[key];
    }
  }

  onSessionClosed(sessionPath: string): void {
    this.canonicalBranchEntriesBySession.delete(sessionPath);
    if (this.canonicalCapture) {
      // Session-close retention/deletion is deliberately not inferred here.
      // P2b resolves the durable close disposition before invoking recorder
      // deletion; this observer only releases producer-local correlation.
      const close = this.canonicalPrivateClosesByPath.get(sessionPath);
      if (close?.phase === 'closing') {
        // Runtime retirement can race the recorder deletion. Keep the local
        // state and close fence until the durable operation has settled so a
        // failed deletion can be retried without rehydrating a half-cleared
        // session.
        close.runtimeRetired = true;
        return;
      }
      this.tracker.onSessionClosed(sessionPath);
      this.releaseCanonicalSessionCorrelations(sessionPath);
      if (close?.phase === 'deleted' && this.canonicalPrivateClosesByPath.get(sessionPath) === close) {
        this.canonicalPrivateClosesByPath.delete(sessionPath);
      }
      return;
    }
    if (this.isPrivateSession(sessionPath)) {
      const sessionId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
      this.workingTime.resetSession(sessionPath, false);
      this.tracker.discardSession(sessionPath);
      this.accounting.forgetSession(sessionPath, sessionId);
      delete this.activeBusyIntervalsBySession[sessionPath];
      for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
        if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolIntervalBySessionAndTool[key];
      }
      return;
    }
    this.syncWorkingTimeBreakdown(sessionPath);
    this.tracker.onSessionClosed(sessionPath);
    this.accounting.onSessionClosed(sessionPath);
  }

  replaceSessionPath(
    oldPath: string,
    newPath: string,
    stableSessionId?: string,
    pendingCreateOperationId?: string,
  ): void {
    this.workingTime.replaceSessionPath(oldPath, newPath);
    this.tracker.replaceSessionPath(oldPath, newPath, stableSessionId);
    this.accounting.replaceSessionPath(oldPath, newPath);
    const capturedBranchEntries = this.canonicalBranchEntriesBySession.get(oldPath);
    if (capturedBranchEntries) {
      this.canonicalBranchEntriesBySession.delete(oldPath);
      this.canonicalBranchEntriesBySession.set(newPath, capturedBranchEntries);
    }
    if (this.canonicalCapture) this.invalidateCanonicalSessionCache();
    const pendingOrigin = pendingCreateOperationId
      ?? this.pendingCreateOperationBySessionPath.get(oldPath);
    if (!pendingOrigin) return;
    this.pendingCreateOperationBySessionPath.delete(oldPath);
    this.pendingCreateOperationBySessionPath.set(newPath, pendingOrigin);
    if (!this.canonicalCapture) return;
    const rootSessionId = stableSessionId?.trim() || resolveSessionIdentity(newPath).sessionId;
    void this.canonicalCapture.bindPendingCreate(
      oldPath,
      rootSessionId,
      this.now().getTime(),
      pendingOrigin,
    ).catch((error) => {
      appendPieLog('warn', 'stats-service', 'canonical pending-create bind failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  startNewTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.startNewTask(sessionPath);
  }

  continueTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.continueTask(sessionPath);
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    this.tracker.onExperimentAssignmentChanged(assignment);
  }

  private filterPrivateAnalytics(result: RunAnalyticsQueryResult): RunAnalyticsQueryResult {
    return {
      completedRuns: result.completedRuns.filter((run) => !this.isPrivateSession(run.sessionPath)),
      openRuns: result.openRuns.filter((run) => !this.isPrivateSession(run.sessionPath)),
    };
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    if (this.canonicalCapture) {
      await this.start();
      // RunSnapshot is a legacy transcript/run shape and has no canonical
      // equivalent. Returning an explicit empty run layer keeps legacy cache
      // consumers from reading the wrong authority; canonical usage is served
      // by getSessionUsage and AggregateStatsService below.
      return { completedRuns: [], openRuns: [] };
    }
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryRunAnalytics());
  }

  /** The resolved run-analytics storage directory (see {@link RunAnalyticsStorage.getStorageDir}). */
  getStorageDir(): string {
    return this.storage.getStorageDir();
  }

  /** Durable canonical read model (P5), available only under canonical authority.
   *
   * Returns `undefined` under legacy authority even though the host wires the
   * model at startup, so no consumer can read canonical data before the P7a
   * cutover. The check lives here rather than in each consumer: it was previously
   * an unenforced convention documented on this accessor, and a single consumer
   * that forgot it would silently read the canonical database under legacy
   * authority. Queries are read-only and fail explicitly when the canonical
   * database is absent. */
  getAnalyticsReadModel(): CanonicalAnalyticsReadModel | undefined {
    if (!this.canonicalCapture) return undefined;
    return this.analyticsReadModel;
  }

  /** Host-owned cumulative agent working-time clocks for renderer projection. */
  getWorkingTimeBySession(): Record<string, WorkingTimeState> {
    const states = this.workingTime.getStates();
    if (this.canonicalPrivateClosesByPath.size === 0) return states;
    const visible = { ...states };
    for (const sessionPath of this.canonicalPrivateClosesByPath.keys()) delete visible[sessionPath];
    return visible;
  }

  /** Ledger-backed session usage projection for UI and fixture conservation checks. */
  getSessionUsage(sessionPath: string): SessionUsageSnapshot {
    if (!this.canonicalCapture) return this.accounting.projectSessionUsage(sessionPath);
    if (this.canonicalPrivateClosesByPath.has(sessionPath)) return { samples: [], authority: 'unknown' };
    const durable = this.canonicalSessionUsageByPath.get(sessionPath);
    if (durable) {
      durable.lastUsed = ++this.canonicalSessionUsageUseSequence;
      return durable.snapshot;
    }
    // Shutdown is terminal for the host service. A renderer can still ask
    // for a projection while its final render is draining; never turn that
    // late read into a new helper process.
    if (this.disposed) return { samples: [], authority: 'unknown' };
    if (this.analyticsReadModel
      && !this.canonicalSessionUsageRefresh
      && this.canonicalSessionPathRefreshes.size < this.analyticsReadModel.getMaxConcurrentQueries()
      && !this.canonicalSessionPathRefreshes.has(sessionPath)) {
      // Session catalog hydration can legitimately happen after StatsService
      // startup. Kick off one bounded read on the first projection instead of
      // requiring a second host start. Until that read answers, canonical
      // authority is explicitly unknown; the process-local ledger is never a
      // substitute for durable canonical history.
      const refresh = this.refreshCanonicalSessionPath(sessionPath);
      this.canonicalSessionPathRefreshes.set(sessionPath, refresh);
      void refresh.finally(() => {
        if (this.canonicalSessionPathRefreshes.get(sessionPath) === refresh) {
          this.canonicalSessionPathRefreshes.delete(sessionPath);
          if (!this.canonicalSessionUsageByPath.has(sessionPath)) {
            this.canonicalSessionPathEpochs.delete(sessionPath);
          }
        }
        this.scheduleRender();
      }).catch(() => undefined);
    }
    return { samples: [], authority: 'unknown' };
  }

  /** Correlated activity authority used by conservation tests and exports. */
  getActivityIntervals(): readonly ActivityIntervalRecord[] {
    return this.accounting.activityTimeline.projectAll();
  }

  /** Immutable ordinary invocation rows used by aggregate projections/export. */
  getBillableInvocationRecords(): readonly BillableInvocationRecord[] {
    return this.accounting.exportRecords();
  }

  /** Current in-memory runs for live aggregate updates; does not touch disk. */
  getOpenRuns(): RunSnapshot[] {
    return this.tracker.getOpenRuns().filter((run) => (
      !this.canonicalPrivateClosesByPath.has(run.sessionPath)
      && (this.canonicalCapture || !this.isPrivateSession(run.sessionPath))
    ));
  }

  /** Finalized snapshots waiting for their batched JSONL append. This is the
   * completion bridge used by AggregateStatsService, preserving finalized
   * status/outcome/timestamps rather than its last observed open snapshot. */
  getPendingCompletedRuns(): RunSnapshot[] {
    return this.storage.getPendingCompletedRuns().filter((run) => !this.isPrivateSession(run.sessionPath));
  }

  /** Query the completed-data cache source without forcing pending analytics
   * to flush. Intended for mtime-gated host rollups. */
  async queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    if (this.canonicalCapture) {
      return await this.queryRunAnalytics();
    }
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryPersistedRunAnalytics());
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    if (this.canonicalCapture) throw new Error('Canonical analytics export is not wired; P5 activation fence remains closed.');
    await this.start();
    const privatePaths = new Set(
      Object.entries(this.getArchState().sessions.privacyModeBySession)
        .filter(([, enabled]) => enabled)
        .map(([sessionPath]) => sessionPath),
    );
    const privateIds = new Set<string>();
    for (const sessionPath of privatePaths) {
      const summaryId = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath)?.sessionId;
      if (summaryId) privateIds.add(summaryId);
      try { privateIds.add(resolveSessionIdentity(sessionPath).sessionId); } catch { /* path filtering remains authoritative */ }
    }
    return await this.storage.exportRunAnalytics(targetPath, privatePaths, privateIds);
  }

  async flush(): Promise<void> {
    if (this.canonicalCapture) return;
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.flush();
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
  }

  /** Rehydrate each known session from the canonical root-session projection.
   * Every query is capped by the read-model transport. A truncated session is
   * left unknown rather than exposing a partial usage history. */
  private async refreshCanonicalSessionUsage(): Promise<void> {
    if (!this.analyticsReadModel || !this.canonicalCapture) return;
    const readModel = this.analyticsReadModel;
    if (this.canonicalSessionUsageRefresh) return await this.canonicalSessionUsageRefresh;
    const refresh = (async () => {
      let firstPass = true;
      for (;;) {
        // A revision/branch invalidation that arrives while a helper is in
        // flight increments the epoch and requests another pass. The old
        // pass may finish, but none of its responses can enter the cache.
        this.canonicalRefreshRequested = false;
        this.canonicalDirtyRevision = null;
        const epoch = ++this.canonicalCacheEpoch;
        this.clearCanonicalSessionCache();
        // Startup/revision work is limited to the actual displayed/running UI
        // surface. The session catalogue may be much larger than that surface;
        // omitted paths hydrate lazily when requested and remain unknown until
        // their bounded durable read answers. Keep the active path first so a
        // large open-tab/running set cannot starve the current renderer.
        const sessionState = this.getArchState().sessions;
        const displayedPathOrder = [
          ...(sessionState.activeSessionPath ? [sessionState.activeSessionPath] : []),
          ...sessionState.runningSessionPaths,
          ...sessionState.openTabPaths,
        ];
        const displayedPathRank = new Map<string, number>();
        for (const sessionPath of displayedPathOrder) {
          if (!displayedPathRank.has(sessionPath)) displayedPathRank.set(sessionPath, displayedPathRank.size);
        }
        const sessions = [...sessionState.sessions]
          .filter((session) => displayedPathRank.has(session.path)
            && !this.canonicalPrivateClosesByPath.has(session.path))
          .sort((left, right) => displayedPathRank.get(left.path)! - displayedPathRank.get(right.path)!)
          .slice(0, MAX_CANONICAL_DISPLAYED_SESSION_REFRESH_ENTRIES);
        let nextIndex = 0;
        const workerCount = Math.min(sessions.length, readModel.getMaxConcurrentQueries());
        const readWorker = async (): Promise<void> => {
          for (;;) {
            // Finish the already-running reads, then give the latest dirty
            // revision priority over more work from an invalidated pass.
            if (this.disposed || epoch !== this.canonicalCacheEpoch) return;
            const index = nextIndex;
            nextIndex += 1;
            const session = sessions[index];
            if (!session) return;
            try {
              const result = await this.readCanonicalSessionPath(session.path);
              this.applyCanonicalSessionRead(session.path, result, epoch);
            } catch (error) {
              // Do not expose a prior durable snapshot or the local ledger
              // after a failed refresh: either could be stale across a
              // close/delete. An invalidated epoch rejects this response.
              if (epoch === this.canonicalCacheEpoch) {
                this.cacheCanonicalUnknown(session.path, '0', 'read-error', epoch);
                appendPieLog('warn', 'analytics', 'canonical session usage read failed', {
                  path: session.path,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        };
        await Promise.all(Array.from({ length: workerCount }, () => readWorker()));
        // The first pass always runs. Later passes are required only when an
        // invalidation was observed while the previous pass was reading.
        if (this.disposed || (!firstPass && !this.canonicalRefreshRequested && !this.canonicalDirtyRevision)) break;
        firstPass = false;
        if (this.disposed || (!this.canonicalRefreshRequested && !this.canonicalDirtyRevision)) break;
      }
    })();
    this.canonicalSessionUsageRefresh = refresh;
    try {
      await refresh;
    } catch (error) {
      appendPieLog('warn', 'analytics', 'canonical session usage refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.canonicalSessionUsageRefresh === refresh) this.canonicalSessionUsageRefresh = null;
    }
  }

  /** Invalidate every host-side canonical snapshot before a revision or scope
   * transition. The next durable read is the only source allowed to repopulate
   * the cache. */
  private invalidateCanonicalSessionCache(schedule = true): void {
    this.canonicalCacheEpoch += 1;
    this.canonicalRefreshRequested = true;
    this.clearCanonicalSessionCache();
    if (schedule && !this.disposed && this.analyticsReadModel && this.canonicalCapture
      && !this.canonicalSessionUsageRefresh) {
      void this.refreshCanonicalSessionUsage();
    }
  }

  private markCanonicalRevisionDirty(revision: string): void {
    this.canonicalCacheEpoch += 1;
    this.canonicalRefreshRequested = true;
    if (this.canonicalDirtyRevision === null
      || canonicalRevision(revision) > canonicalRevision(this.canonicalDirtyRevision)) {
      this.canonicalDirtyRevision = canonicalRevisionString(revision);
    }
    this.clearCanonicalSessionCache();
    if (!this.disposed && this.analyticsReadModel && this.canonicalCapture
      && !this.canonicalSessionUsageRefresh) {
      void this.refreshCanonicalSessionUsage();
    }
  }

  private clearCanonicalSessionCache(): void {
    this.canonicalSessionUsageByPath.clear();
    this.canonicalSessionUsageCacheBytes = 0;
    this.canonicalSessionUsageCacheSamples = 0;
    for (const sessionPath of this.canonicalSessionPathEpochs.keys()) {
      if (!this.canonicalSessionPathRefreshes.has(sessionPath)) {
        this.canonicalSessionPathEpochs.delete(sessionPath);
      }
    }
  }

  private removeCanonicalSessionCache(sessionPath: string): void {
    const entry = this.canonicalSessionUsageByPath.get(sessionPath);
    if (!entry) return;
    this.canonicalSessionUsageByPath.delete(sessionPath);
    this.canonicalSessionUsageCacheBytes -= entry.estimatedBytes;
    this.canonicalSessionUsageCacheSamples -= entry.sampleCount;
    if (!this.canonicalSessionPathRefreshes.has(sessionPath)) {
      this.canonicalSessionPathEpochs.delete(sessionPath);
    }
  }

  private estimateCanonicalSessionUsageBytes(snapshot: SessionUsageSnapshot): number {
    try {
      // This is only a deterministic serialized-size proxy. Entry and sample
      // counts are bounded independently; this value is not a heap
      // measurement, so host heap qualification remains pending.
      return JSON.stringify(snapshot).length * 2;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private cacheCanonicalUnknown(
    sessionPath: string,
    revision: string,
    scopeKey: string,
    epoch: number,
  ): void {
    this.cacheCanonicalSessionUsage(sessionPath, { samples: [], authority: 'unknown' }, revision, scopeKey, epoch);
  }

  private cacheCanonicalSessionUsage(
    sessionPath: string,
    snapshot: SessionUsageSnapshot,
    revision: string,
    scopeKey: string,
    epoch: number,
  ): void {
    if (epoch !== this.canonicalCacheEpoch || this.canonicalPrivateClosesByPath.has(sessionPath)) return;
    this.removeCanonicalSessionCache(sessionPath);
    let storedSnapshot = snapshot;
    let estimatedBytes = this.estimateCanonicalSessionUsageBytes(snapshot);
    let sampleCount = snapshot.samples.length;
    // A complete but too-large session cannot be represented safely in this
    // bounded host cache. Preserve truthful unknown coverage instead of
    // retaining an unbounded all-history object.
    if (sampleCount > MAX_CANONICAL_SESSION_CACHE_SAMPLES
      || estimatedBytes > MAX_CANONICAL_SESSION_CACHE_BYTES) {
      storedSnapshot = { samples: [], authority: 'unknown' };
      estimatedBytes = this.estimateCanonicalSessionUsageBytes(storedSnapshot);
      sampleCount = 0;
    }
    this.canonicalSessionUsageByPath.set(sessionPath, {
      snapshot: storedSnapshot,
      revision,
      scopeKey,
      epoch,
      estimatedBytes,
      sampleCount,
      lastUsed: ++this.canonicalSessionUsageUseSequence,
    });
    this.canonicalSessionUsageCacheBytes += estimatedBytes;
    this.canonicalSessionUsageCacheSamples += sampleCount;
    while (this.canonicalSessionUsageByPath.size > MAX_CANONICAL_SESSION_CACHE_ENTRIES
      || this.canonicalSessionUsageCacheBytes > MAX_CANONICAL_SESSION_CACHE_BYTES
      || this.canonicalSessionUsageCacheSamples > MAX_CANONICAL_SESSION_CACHE_SAMPLES) {
      let oldestPath: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [path, entry] of this.canonicalSessionUsageByPath) {
        if (entry.lastUsed < oldestUse) {
          oldestUse = entry.lastUsed;
          oldestPath = path;
        }
      }
      if (oldestPath === undefined) break;
      this.removeCanonicalSessionCache(oldestPath);
    }
  }

  private applyCanonicalSessionRead(
    sessionPath: string,
    result: CanonicalSessionReadResult,
    epoch: number,
  ): void {
    if (this.disposed || epoch !== this.canonicalCacheEpoch) return;
    if (result.unknown || result.truncated) {
      this.cacheCanonicalUnknown(sessionPath, result.revision, result.scopeKey, epoch);
      return;
    }
    const snapshot = sessionUsageSnapshotFromCanonicalSettlements(
      result.settlements,
      result.branchId ? { branchId: result.branchId } : undefined,
    );
    this.cacheCanonicalSessionUsage(sessionPath, snapshot, result.revision, result.scopeKey, epoch);
  }

  private async readCanonicalSessionPath(sessionPath: string): Promise<CanonicalSessionReadResult> {
    const identity = this.sessionIdentity(sessionPath);
    const rootSessionId = identity.sessionId ?? analyticsRootSessionId(null, sessionPath);
    const readModel = this.analyticsReadModel!;
    // The normal unbranched path is one bounded helper query. Branch metadata
    // already observed by the host selects the durable branch directly; after
    // restart, a root read is used only to detect branch rows before the
    // additional selection lookup.
    const hasObservedBranch = this.canonicalBranchEntriesBySession.get(sessionPath)?.selectedEntryId !== undefined;
    if (hasObservedBranch) {
      const revision = canonicalRevisionString(await readModel.readRevision());
      return await this.readCanonicalSelectedBranch(rootSessionId, revision);
    }
    const rootResult = await readModel.readScopedProviderSettlements(
      { kind: 'rootSession', rootSessionId },
      { limit: MAX_CANONICAL_SESSION_CACHE_SAMPLES, maxResultBytes: MAX_CANONICAL_SESSION_CACHE_BYTES },
    );
    const rootRead: CanonicalSessionReadResult = {
      revision: canonicalRevisionString(rootResult.revision),
      settlements: rootResult.settlements,
      truncated: rootResult.truncated,
      scopeKey: JSON.stringify(rootResult.scope),
    };
    if (rootResult.truncated || !rootResult.settlements.some((settlement) => settlement.branchId !== null)) {
      return rootRead;
    }
    return await this.readCanonicalSelectedBranch(rootSessionId, rootRead.revision);
  }

  private async readCanonicalSelectedBranch(
    rootSessionId: string,
    revision: string,
  ): Promise<CanonicalSessionReadResult> {
    const readModel = this.analyticsReadModel!;
    const selection = await readModel.executeQuery({
      sql: `SELECT generation_id, branch_id
            FROM analytics_current_branch_selections
            WHERE root_session_id = ?
            ORDER BY generation_id, branch_id
            LIMIT 3`,
      parameters: [rootSessionId],
      maxRows: 3,
      maxQueryBytes: 4 * 1024,
      maxResultBytes: 64 * 1024,
    });
    if (selection.truncation.byteLimit || selection.truncation.cellLimit || selection.rows.length > 1) {
      return { revision, settlements: [], truncated: false, scopeKey: `unknown:${rootSessionId}`, unknown: true };
    }
    const branchSelection = selection.rows[0];
    const generationId = typeof branchSelection?.generation_id === 'string'
      ? branchSelection.generation_id.trim() : '';
    const branchId = typeof branchSelection?.branch_id === 'string'
      ? branchSelection.branch_id.trim() : '';
    if (branchSelection === undefined || !generationId || !branchId) {
      return { revision, settlements: [], truncated: false, scopeKey: `unknown:${rootSessionId}`, unknown: true };
    }
    const scope: ProviderSettlementScope = { kind: 'selectedBranch', generationId, rootSessionId };
    const result = await readModel.readScopedProviderSettlements(scope, {
      limit: MAX_CANONICAL_SESSION_CACHE_SAMPLES,
      expectedRevision: revision,
      maxResultBytes: MAX_CANONICAL_SESSION_CACHE_BYTES,
    });
    const scopeKey = JSON.stringify(scope);
    return {
      revision: canonicalRevisionString(result.revision),
      settlements: result.settlements,
      truncated: result.truncated,
      scopeKey,
      ...(scope.kind === 'selectedBranch' ? { branchId } : {}),
      ...(scope.kind === 'selectedBranch' && result.selectionCoverage !== 'known' ? { unknown: true } : {}),
    };
  }

  private async refreshCanonicalSessionPath(sessionPath: string): Promise<void> {
    if (!this.analyticsReadModel || !this.canonicalCapture) return;
    if (this.canonicalSessionUsageRefresh) {
      await this.canonicalSessionUsageRefresh;
      return;
    }
    const epoch = this.canonicalCacheEpoch;
    const pathRefreshEpoch = (this.canonicalSessionPathEpochs.get(sessionPath) ?? 0) + 1;
    this.canonicalSessionPathEpochs.set(sessionPath, pathRefreshEpoch);
    try {
      const result = await this.readCanonicalSessionPath(sessionPath);
      if (!this.disposed && epoch === this.canonicalCacheEpoch
        && this.canonicalSessionPathEpochs.get(sessionPath) === pathRefreshEpoch) {
        this.applyCanonicalSessionRead(sessionPath, result, epoch);
      }
    } catch (error) {
      if (!this.disposed && epoch === this.canonicalCacheEpoch
        && this.canonicalSessionPathEpochs.get(sessionPath) === pathRefreshEpoch) {
        this.cacheCanonicalUnknown(sessionPath, '0', 'read-error', epoch);
        appendPieLog('warn', 'analytics', 'canonical session usage read failed', {
          path: sessionPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      // Once this request has completed, its token is only needed while a
      // cache entry or a newer request still refers to the path. Reclaim it
      // for paths that remain uncached so a long-lived session catalogue
      // cannot grow this map without bound.
      if (!this.canonicalSessionUsageByPath.has(sessionPath)
        && this.canonicalSessionPathEpochs.get(sessionPath) === pathRefreshEpoch) {
        this.canonicalSessionPathEpochs.delete(sessionPath);
      }
    }
  }

  /** Start the bounded cross-host refresh once canonical authority is active.
   *
   * Only another host's committed summary, correction or private close is
   * observable through the shared projection revision, so this reads that small
   * value at a bounded interval and re-renders on change. It never scans
   * history, never replays events and retains no per-history state. Dormant
   * under the legacy authority: there is no canonical revision to follow yet. */
  private startCanonicalRevisionRefresh(): void {
    if (!this.analyticsReadModel || this.analyticsRevisionRefresher) return;
    this.analyticsRevisionRefresher = new CanonicalRevisionRefresher({
      readModel: this.analyticsReadModel,
      onRevisionChange: (revision) => {
        this.markCanonicalRevisionDirty(revision);
        this.scheduleRender();
      },
      onError: (error) => {
        appendPieLog('warn', 'analytics', 'canonical analytics revision refresh could not read the revision', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const start = this.analyticsRevisionRefresher.start().then(() => undefined).catch((error: unknown) => {
      appendPieLog('warn', 'analytics', 'canonical analytics revision refresh failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.canonicalRevisionStart = start;
    void start.finally(() => {
      if (this.canonicalRevisionStart === start) this.canonicalRevisionStart = null;
    });
  }

  /** Observable refresh counters for idle-resource measurement. */
  getAnalyticsRevisionRefreshStats(): ReturnType<CanonicalRevisionRefresher['getStats']> | undefined {
    return this.analyticsRevisionRefresher?.getStats();
  }

  async shutdown(): Promise<void> {
    if (this.canonicalCapture) {
      this.disposed = true;
      const revisionRefreshDrain = this.analyticsRevisionRefresher?.stop();
      this.backgroundCompactionAbort.abort();
      const refreshes = [
        this.canonicalRevisionStart,
        revisionRefreshDrain,
        this.canonicalSessionUsageRefresh,
        ...this.canonicalSessionPathRefreshes.values(),
        ...[...this.canonicalPrivateClosesByPath.values()].map(({ promise }) => promise),
      ].filter((promise): promise is Promise<void> => promise !== null);
      await Promise.allSettled(refreshes);
      this.clearCanonicalSessionCache();
      this.canonicalSessionPathEpochs.clear();
      this.canonicalSessionPathRefreshes.clear();
      this.canonicalPrivateClosesByPath.clear();
      this.canonicalBranchEntriesBySession.clear();
      this.pendingCreateOperationBySessionPath.clear();
      this.analyticsRevisionRefresher = undefined;
      this.canonicalRevisionStart = null;
      this.canonicalSessionUsageRefresh = null;
      return;
    }
    // Terminal: block start reactivation immediately, then drain the tracked
    // background promise (defer, healing, migration) — healing stops at its
    // next bounded batch and the in-flight migration at its next run
    // boundary instead of waiting out a large legacy catalogue. Unmigrated
    // runs resume on the next startup.
    this.disposed = true;
    this.analyticsRevisionRefresher?.stop();
    this.backgroundCompactionAbort.abort();
    const background = this.backgroundWork;
    if (background) {
      await background;
    }
    this.tracker.finalizeOpenRunsForShutdown();
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.dispose();
  }
}
