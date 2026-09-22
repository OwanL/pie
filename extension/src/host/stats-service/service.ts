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
import { analyzeToolCall, type ToolCallAnalysis } from '../../shared/tool-call-analysis/index.js';
import { resolveSessionCwd } from '../core/file-change-derivation.js';
import { RunAnalyticsStorage } from './storage';
import { SessionRunTracker } from './tracker';
import type {
  AssistantTurnIdentity,
  CanonicalActivityProjection,
  CanonicalActivityProjectionSnapshot,
  CanonicalActivityStats,
  CanonicalProjectionScope,
  CanonicalToolFacetProjection,
  CanonicalToolFacetProjectionSnapshot,
  RunObserver,
  StatsServiceOptions,
} from './types';
import { resolveSessionIdentity } from '../../shared/session-identity';
import { defaultCreateId, defaultNow } from './helpers';
import { WorkingTimeService } from '../working-time-service';
import {
  BillableAccounting,
  type BillableAccountingDeps,
} from '../billable-accounting/service';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import { activityProjectionSubjectFilter } from '../../analytics/activity-projection.js';
import type {
  SessionUsageFreshness,
  SessionUsageRefreshStatus,
  SessionUsageSample,
  SessionUsageSnapshot,
} from '../../shared/session-usage';
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
const MAX_CANONICAL_ACTIVITY_KINDS = 64;
const MAX_CANONICAL_TOOL_FACETS = 200;
const MAX_CANONICAL_ACTIVITY_RESULT_BYTES = 256 * 1024;
const MAX_CANONICAL_ACTIVITY_CACHE_ENTRIES = 256;
const MAX_CANONICAL_ACTIVITY_CACHE_BYTES = 4 * 1024 * 1024;
/** Eager refresh is for the small displayed/running surface only. The cache
 * can retain more history for explicit lazy reads, but a revision invalidation
 * must never turn the whole session catalogue into a query batch. */
const MAX_CANONICAL_DISPLAYED_SESSION_REFRESH_ENTRIES = 32;
const MAX_CANONICAL_SESSION_CACHE_SAMPLES = 4_000;
const MAX_CANONICAL_SESSION_CACHE_BYTES = 4 * 1024 * 1024;
/** A refresh may catch up once, but never spin behind an active writer. The
 * last completed root read is still published with stale metadata when the
 * second bounded pass is overtaken. */
const MAX_CANONICAL_SESSION_REFRESH_PASSES = 2;
const CANONICAL_SESSION_REFRESH_RETRY_DELAY_MS = 250;

type CanonicalSessionUsageCacheEntry = {
  snapshot: SessionUsageSnapshot;
  revision: string;
  scopeKey: string;
  epoch: number;
  estimatedBytes: number;
  sampleCount: number;
  lastUsed: number;
};

type PendingCanonicalUsage = {
  invocationId: string;
  /** Stable root id, or the same path fallback used by canonical capture. */
  scopeKey: string;
  sample: SessionUsageSample;
};

type CanonicalSessionReadResult = {
  revision: string;
  settlements: ScopedProviderSettlementReadModel['settlements'];
  truncated: boolean;
  scopeKey: string;
  branchId?: string;
  unknown?: boolean;
  /** The durable store has no committed branch selection for this root, but
   * the host has observed one. The settle-boundary captures (terminal
   * settlement, branch edge, selection) are usually still pending durable
   * commitment, so this is a delayed-commit window rather than a deleted or
   * ambiguous subject; the prior complete read must survive it. */
  pendingSelection?: boolean;
};

type CanonicalActivityReadResult = {
  revision: string;
  scope: CanonicalProjectionScope;
  scopeKey: string;
  activity: CanonicalActivityProjection | null;
  toolFacets: CanonicalToolFacetProjection | null;
  activityError?: unknown;
  toolFacetsError?: unknown;
};

type CanonicalActivityCacheEntry = {
  activity: CanonicalActivityProjectionSnapshot;
  toolFacets: CanonicalToolFacetProjectionSnapshot;
  revision: string;
  scopeKey: string;
  epoch: number;
  estimatedBytes: number;
  lastUsed: number;
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

/** Parse one durable activity-span timestamp anchor (epoch milliseconds,
 * delivered by the helper as an int64 string or number). */
function canonicalTimestampAnchor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
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

function finiteToolTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function finiteToolDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
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
  /** Actual producer start samples for open tool intervals. A missing sample
   * must never be replaced with the terminal receipt time. */
  private readonly activeToolStartedAtBySessionAndTool: Record<string, number | undefined> = {};
  private readonly now: () => Date;
  /** Durable spans settled after this boundary belong to the current process
   * handoff (or an incomplete prior handoff). They are not restored as
   * historical time; live boundaries observed by this process are reconciled
   * by WorkingTimeService instead. */
  private readonly processStartedAtMs: number;
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
  /** The session.opened payload is the authoritative identity handoff for a
   * path. Keep it separately from the placeholder/reducer summary so a cold
   * open can hydrate the durable root before a later render replaces the
   * host-local lookup key. */
  private readonly canonicalRootSessionIdByPath = new Map<string, string>();
  /** Provider observations are display-only until the canonical read contains
   * the same invocation identity. Keep them path-scoped and identity-keyed so
   * a stream can hand off without either a dip or a duplicate charge. */
  private readonly pendingCanonicalUsageByPath = new Map<string, Map<string, PendingCanonicalUsage>>();
  private canonicalSessionUsageCacheBytes = 0;
  private canonicalSessionUsageCacheSamples = 0;
  private canonicalSessionUsageUseSequence = 0;
  /** Ordinary bounded rehydration keeps the last complete visible read here
   * while the replacement pass is in flight. The live cache is rebuilt behind
   * this held read, so an unrelated host render cannot turn a known cost into
   * an intermediate empty/unknown snapshot. Explicit privacy, deletion,
   * branch, and authority invalidations clear this held read instead. */
  private canonicalSessionUsageHeldByPath: Map<string, CanonicalSessionUsageCacheEntry> | null = null;
  /** Strict invalidation fence. While set, every canonical projection is
   * fail-closed even if a replacement helper has already returned a partial
   * result; the fence is released only after the bounded refresh settles. */
  private canonicalCacheFailClosed = false;
  private canonicalCacheEpoch = 0;
  private canonicalDirtyRevision: string | null = null;
  private canonicalRefreshRequested = false;
  /** True only while the revision refresher has not yet established its first
   * successful watermark. Lazy reads stay fail-closed during this window. */
  private canonicalRevisionAwaitingBaseline = true;
  private canonicalSessionUsageRefresh: Promise<void> | null = null;
  private canonicalSessionUsageRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly canonicalSessionPathRefreshes = new Map<string, Promise<void>>();
  private readonly canonicalSessionPathEpochs = new Map<string, number>();
  /** Bounded persisted activity/facet reads share the session usage refresh
   * epoch, so a peer revision or deletion invalidates every canonical surface
   * together. Session entries remain keyed by visible path; durable reads use
   * the resolved root session ID and never the path. */
  private readonly canonicalActivityByPath = new Map<string, CanonicalActivityCacheEntry>();
  private canonicalGlobalActivity: CanonicalActivityCacheEntry | null = null;
  private canonicalActivityCacheBytes = 0;
  private canonicalActivityUseSequence = 0;
  /** An entry is an in-flight close until the recorder deletion resolves, then
   * remains as an ephemeral display/capture fence until runtime retirement. */
  private readonly canonicalPrivateClosesByPath = new Map<string, CanonicalPrivateCloseOperation>();
  /** Session paths whose working-time clock was already restored from the
   * canonical busy wall-time union in this process. Cleared by a privacy close
   * and moved by a rename so a rebound root re-restores from fresh evidence. */
  private readonly canonicalBusyRestoredRootByPath = new Map<string, string>();
  /** Exact create/duplicate origin retained after the pending path is replaced.
   * A close operation ID must never enter this map. */
  private readonly pendingCreateOperationBySessionPath = new Map<string, string>();
  /** Prevent ordinary session refreshes from rescanning or resubmitting the
   * full observed ancestry. Branch edges/selections are producer-side facts;
   * the session usage projection itself is always read at root scope. */
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
    this.processStartedAtMs = Math.max(0, Math.trunc(now().getTime()));
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
        // Establish the revision baseline before hydrating any session rows.
        // The refresher deliberately does not notify for its first successful
        // read; starting it after hydration would therefore allow a peer
        // delete to become the baseline and leave the hydrated cache stale.
        const baselineRevision = await this.startCanonicalRevisionRefresh();
        if (this.disposed) return;
        if (baselineRevision === null) {
          // A failed first read must not be followed by hydration: the first
          // later successful refresher read is a silent baseline and could
          // otherwise absorb a peer delete. Stay unknown until that baseline
          // exists; getSessionUsage will then perform a fresh bounded read.
          this.canonicalRevisionAwaitingBaseline = Boolean(this.analyticsReadModel);
          this.invalidateCanonicalSessionCache(false);
        } else {
          this.canonicalRevisionAwaitingBaseline = false;
          // The bounded pass hydrates provider usage plus the global and
          // displayed-session activity/facet projections. It remains one
          // revision-fenced refresh rather than an agent-path query.
          await this.refreshCanonicalSessionUsage();
          if (this.disposed) return;
          // A peer can commit while hydration is in flight. Compare the
          // completed cache with a fresh durable watermark before exposing
          // startup as complete. Unknown cache entries are safe; only a
          // canonical snapshot at an older revision is stale data.
          await this.reconcileCanonicalSessionUsageRevision(baselineRevision);
        }
        if (this.disposed) return;
        this.recordStage('canonical-session-usage', canonicalQueryStartAt, {
          sessions: this.canonicalSessionUsageByPath.size,
        });
        // Cold working-time restoration: the canonical busy wall spans are the
        // only evidence (there is no legacy timeline under canonical
        // authority). Paths the bounded usage pass hydrated restore their
        // elapsed busy wall-time union here; the rest hydrate lazily with
        // their first durable read.
        const workingTimeRestoreStartAt = performance.now();
        await this.restoreCanonicalWorkingTimeForPaths([...this.canonicalSessionUsageByPath.keys()]);
        if (this.disposed) return;
        this.recordStage('canonical-working-time', workingTimeRestoreStartAt, {
          restored: this.canonicalBusyRestoredRootByPath.size,
        });
        this.started = true;
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
        if (!interval.endedAt && !interval.outcome && interval.kind === 'busy') {
          (this.activeBusyIntervalsBySession[interval.sessionPath] ??= new Set()).add(interval.intervalId);
        } else if (!interval.endedAt && !interval.outcome && interval.kind === 'tool' && interval.toolId) {
          const toolKey = this.toolIntervalKey(interval.sessionPath, interval.toolId);
          this.activeToolIntervalBySessionAndTool[toolKey] = interval.intervalId;
          const startedAt = finiteToolTimestamp(Date.parse(interval.startedAt));
          if (startedAt !== null) this.activeToolStartedAtBySessionAndTool[toolKey] = startedAt;
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

  /** An identity rebind must never display the previous root's restored busy
   * clock: discard the restore marker and the working-time state it produced,
   * so the rebound path re-restores from the new root's durable evidence. */
  private forgetCanonicalBusyRestoreForPath(sessionPath: string): void {
    if (!this.canonicalBusyRestoredRootByPath.delete(sessionPath)) return;
    this.workingTime.resetSession(sessionPath, false);
    this.scheduleRender();
  }

  private syncWorkingTimeBreakdown(sessionPath: string): void {
    const run = this.tracker.getMostRelevantRun(sessionPath);
    if (run) this.workingTime.observeRun(run);
  }

  private sessionIdentity(sessionPath: string): { sessionId: string | null; modelId?: string; provider?: string } {
    const summary = this.getArchState().sessions.sessions.find((session) => session.path === sessionPath);
    return {
      sessionId: this.canonicalRootSessionIdByPath.get(sessionPath)
        ?? (summary?.identityFallback === true ? null : summary?.sessionId?.trim() || null),
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
    this.canonicalBusyRestoredRootByPath.delete(sessionPath);
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

  onSessionOpened(sessionPath: string, sessionId?: string): void {
    if (!this.canonicalCapture || this.isCanonicalCloseActive(sessionPath)) return;
    const previousRootSessionId = this.canonicalRootSessionId(sessionPath);
    const stableRootSessionId = sessionId?.trim();
    if (stableRootSessionId) this.canonicalRootSessionIdByPath.set(sessionPath, stableRootSessionId);
    else this.canonicalRootSessionIdByPath.delete(sessionPath);
    const rootChanged = previousRootSessionId !== this.canonicalRootSessionId(sessionPath);
    const cachedEntry = this.canonicalSessionUsageByPath.get(sessionPath);
    const cachedRootMismatch = cachedEntry !== undefined
      && !this.canonicalSessionUsageEntryMatchesScope(sessionPath, cachedEntry);
    const identityChanged = rootChanged || cachedRootMismatch;
    if (identityChanged) this.forgetCanonicalBusyRestoreForPath(sessionPath);
    const needsHydration = (cachedEntry === undefined || cachedRootMismatch)
      && !this.canonicalSessionPathRefreshes.has(sessionPath);
    if (identityChanged || needsHydration) {
      // This hook runs after the opened summary and selection state are
      // reduced. It therefore includes a cold session that was absent from the
      // startup displayed-session pass, even when its pending usage cache is
      // empty. A changed root is strict; the initial same-root read can retain
      // ordinary stale-while-revalidate semantics.
      this.invalidateCanonicalSessionCache(true, identityChanged);
    }
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
        // Same-root branch/selection transition: keep the held read so the
        // settle-boundary refresh does not drop the displayed cost to an
        // em dash while its captures are still pending durable commitment.
        this.invalidateCanonicalSessionCache(true, false);
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
      // Same-root branch/selection transition: keep the held read (see
      // invalidateCanonicalSessionCache) while the replacement pass re-reads.
      this.invalidateCanonicalSessionCache(true, false);
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
      finiteToolTimestamp(toolCall.startedAt) ?? 0,
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (this.isCanonicalCloseActive(sessionPath)) return;
    this.tracker.onToolStarted(sessionPath, toolCall);
    this.workingTime.onToolStarted(sessionPath, toolCall);
    const observedStartedAt = finiteToolTimestamp(toolCall.startedAt);
    // Activity intervals require a real producer start. A malformed/legacy
    // start can still appear in the live tool projection, but its host receipt
    // time must never become canonical timing evidence.
    if (observedStartedAt !== null) {
      const runId = this.currentRunId(sessionPath);
      const intervalId = `activity:tool:${runId ?? sessionPath}:${toolCall.id}`;
      const toolKey = this.toolIntervalKey(sessionPath, toolCall.id);
      this.activeToolIntervalBySessionAndTool[toolKey] = intervalId;
      this.activeToolStartedAtBySessionAndTool[toolKey] = observedStartedAt;
      const interval: ActivityIntervalRecord = {
        schemaVersion: 1,
        intervalId,
        sessionId: this.sessionIdentity(sessionPath).sessionId,
        sessionPath,
        parentRunId: runId,
        parentOperationId: this.activeOperationId(sessionPath),
        invocationId: null,
        toolId: toolCall.id,
        ...(toolCall.parallelGroupId === undefined ? {} : { parallelGroupId: toolCall.parallelGroupId }),
        kind: 'tool',
        startedAt: new Date(observedStartedAt).toISOString(),
      };
      if (this.canonicalCapture) this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), interval);
      else {
        this.accounting.activityTimeline.start(interval);
        this.storage.markDerivedExportDirty();
      }
    }
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    const closing = this.isCanonicalCloseActive(sessionPath);
    if (!closing) this.accounting.observeSubagentToolResult(sessionPath, toolCall);
    const endedAtMs = finiteToolTimestamp(toolCall.endedAt);
    const startedAtMs = finiteToolTimestamp(toolCall.startedAt);
    const durationMs = finiteToolDuration(toolCall.durationMs);
    const monotonic = toolCall.durationClockDomain === 'monotonic-same-process';
    this.canonicalCapture?.captureTool(
      this.analyticsContext(sessionPath),
      toolCall,
      'end',
      `tool:${toolCall.id}:end`,
      endedAtMs ?? startedAtMs ?? 0,
    );
    // The terminal facet derives from the same per-tool analysis the run
    // tracker consumes, so the execution path never reanalyzes the call or
    // re-serializes a result body. This is a synchronous handoff: the
    // observation is enqueued without awaiting the recorder sink, and an
    // absent canonical authority short-circuits before any analysis runs.
    let facetAnalysis: ToolCallAnalysis | undefined;
    const terminalAnalysis = (): ToolCallAnalysis => (facetAnalysis ??= analyzeToolCall(toolCall));
    this.canonicalCapture?.captureToolFacet(
      this.analyticsContext(sessionPath),
      toolCall,
      terminalAnalysis(),
      resolveSessionCwd(
        this.getArchState().sessions.sessions,
        this.getArchState().sessions.workspaceCwd,
        sessionPath,
      ),
      endedAtMs ?? startedAtMs ?? 0,
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    if (closing) return;
    // Producer timing is authoritative. In particular, no terminal receipt
    // timestamp is substituted for a missing tool endpoint or duration.
    this.workingTime.onToolFinished(sessionPath, toolCall);
    const toolKey = this.toolIntervalKey(sessionPath, toolCall.id);
    const intervalId = this.activeToolIntervalBySessionAndTool[toolKey];
    const intervalStartedAtMs = this.activeToolStartedAtBySessionAndTool[toolKey] ?? startedAtMs ?? undefined;
    const activityEndedAtMs = endedAtMs ?? (
      toolCall.endedAt === undefined
      && !monotonic && intervalStartedAtMs !== undefined && durationMs !== null
        ? intervalStartedAtMs + durationMs
        : null
    );
    const orderedWallBounds = intervalStartedAtMs !== undefined
      && activityEndedAtMs !== null
      && activityEndedAtMs >= intervalStartedAtMs;
    const hasMeasuredMonotonicDuration = monotonic && durationMs !== null;
    // Keep wall endpoints only when they are an ordered producer interval, or
    // when a valid monotonic duration independently permits a reversed wall
    // correlation anchor. Never pass a reversed unmarked interval to timeline
    // normalization, and never turn missing timing into a receipt-time end.
    const settledEndedAtMs = activityEndedAtMs !== null
      && (orderedWallBounds || hasMeasuredMonotonicDuration)
      ? activityEndedAtMs
      : null;
    const settledDurationMs = durationMs !== null
      && (hasMeasuredMonotonicDuration || orderedWallBounds)
      ? durationMs
      : null;
    if (intervalId && intervalStartedAtMs !== undefined) {
      const outcome = toolCall.status === 'failed' ? 'failed' as const : 'succeeded' as const;
      const interval: ActivityIntervalRecord = {
        schemaVersion: 1,
        intervalId,
        sessionId: this.sessionIdentity(sessionPath).sessionId,
        sessionPath,
        parentRunId: this.currentRunId(sessionPath),
        parentOperationId: this.activeOperationId(sessionPath),
        invocationId: null,
        toolId: toolCall.id,
        ...(toolCall.parallelGroupId === undefined ? {} : { parallelGroupId: toolCall.parallelGroupId }),
        kind: 'tool',
        startedAt: new Date(intervalStartedAtMs).toISOString(),
        ...(activityEndedAtMs === null ? {} : { endedAt: new Date(activityEndedAtMs).toISOString() }),
        ...(durationMs === null ? {} : { durationMs }),
        ...(hasMeasuredMonotonicDuration ? { durationClockDomain: 'monotonic-same-process' as const } : {}),
        outcome,
      };
      if (this.canonicalCapture) {
        this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), interval);
      } else {
        // Timeline normalization accepts a terminal monotonic duration without
        // a fabricated wall endpoint, and accepts reversed wall anchors only
        // when an independent monotonic duration accompanies them.
        this.accounting.activityTimeline.settle(
          intervalId,
          settledEndedAtMs === null ? undefined : new Date(settledEndedAtMs).toISOString(),
          outcome,
          {
            ...(settledDurationMs === null ? {} : { durationMs: settledDurationMs }),
            ...(hasMeasuredMonotonicDuration ? { durationClockDomain: 'monotonic-same-process' as const } : {}),
          },
        );
        this.storage.markDerivedExportDirty();
      }
    }
    delete this.activeToolIntervalBySessionAndTool[toolKey];
    delete this.activeToolStartedAtBySessionAndTool[toolKey];
    this.tracker.onToolFinished(sessionPath, toolCall, terminalAnalysis());
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
    if (this.canonicalCapture && observed.record && observed.canonicalAccepted !== false) {
      this.rememberPendingCanonicalUsage(sessionPath, observed.invocationId, observed.kind, observed.record, sample);
      this.scheduleRender();
    }
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  private rememberPendingCanonicalUsage(
    sessionPath: string,
    invocationId: string,
    kind: BillableInvocationRecord['kind'],
    record: BillableInvocationRecord,
    observed: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>,
  ): void {
    const pending = this.pendingCanonicalUsageByPath.get(sessionPath) ?? new Map<string, PendingCanonicalUsage>();
    const totalTokens = record.providerTotalTokens
      ?? (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
        + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
    const sample: SessionUsageSample = {
      sourceId: record.sourceId,
      canonicalInvocationId: invocationId,
      kind,
      modelId: record.model === 'unknown-model' ? undefined : record.model,
      provider: record.provider === 'unknown-provider' ? undefined : record.provider,
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheWriteTokens: record.cacheWriteTokens ?? 0,
      totalTokens,
      ...(record.reasoningTokens !== undefined ? { reasoningTokens: record.reasoningTokens } : {}),
      ...(record.providerReportedCostUsd !== undefined ? { reportedCostUsd: record.providerReportedCostUsd } : {}),
      ...(record.pricing ? {
        calculatedCostUsd: record.pricing.calculatedCostUsd,
        priceCatalogVersion: record.pricing.catalogVersion,
      } : {}),
      ...(record.providerTotalTokens !== undefined ? { providerTotalTokens: record.providerTotalTokens } : {}),
      tokenChannelsKnown: record.inputTokens !== undefined && record.outputTokens !== undefined
        && record.cacheReadTokens !== undefined && record.cacheWriteTokens !== undefined,
      tokenChannelPresence: {
        input: record.inputTokens !== undefined,
        output: record.outputTokens !== undefined,
        cacheRead: record.cacheReadTokens !== undefined,
        cacheWrite: record.cacheWriteTokens !== undefined,
      },
      provenance: record.provenance,
      instrumentationGap: record.instrumentationGap,
      ...(record.instrumentationGapReason ? { instrumentationGapReason: record.instrumentationGapReason } : {}),
      outcome: record.outcome,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      ...(observed.provisionalMessageId ? { provisionalMessageId: observed.provisionalMessageId } : {}),
      ...(record.parentOperationId ? { parentOperationId: record.parentOperationId } : {}),
      ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
      ...(record.parentToolId ? { parentToolId: record.parentToolId } : {}),
    };
    pending.set(invocationId, {
      invocationId,
      scopeKey: this.canonicalRootSessionId(sessionPath),
      sample,
    });
    while (pending.size > 256) {
      const oldest = pending.keys().next().value;
      if (typeof oldest !== 'string') break;
      pending.delete(oldest);
    }
    this.pendingCanonicalUsageByPath.set(sessionPath, pending);
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
    evidence?: Pick<import('../../shared/protocol').RetryMeasuredPayload, 'operationId' | 'startedAt' | 'providerAttemptStartedAt' | 'endedAt' | 'durationClockDomain'>,
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
    this.canonicalRootSessionIdByPath.delete(sessionPath);
    this.canonicalBranchEntriesBySession.delete(sessionPath);
    this.pendingCanonicalUsageByPath.delete(sessionPath);
    this.accounting.onSessionClosed(sessionPath);
    const intervals = this.activeBusyIntervalsBySession[sessionPath];
    for (const intervalId of intervals ?? []) delete this.activeBusyStartedAtByInterval[intervalId];
    delete this.activeBusyIntervalsBySession[sessionPath];
    for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
      if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolIntervalBySessionAndTool[key];
    }
    for (const key of Object.keys(this.activeToolStartedAtBySessionAndTool)) {
      if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolStartedAtBySessionAndTool[key];
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
      for (const key of Object.keys(this.activeToolStartedAtBySessionAndTool)) {
        if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolStartedAtBySessionAndTool[key];
      }
      return;
    }
    this.syncWorkingTimeBreakdown(sessionPath);
    this.tracker.onSessionClosed(sessionPath);
    this.accounting.onSessionClosed(sessionPath);
    this.pendingCanonicalUsageByPath.delete(sessionPath);
  }

  replaceSessionPath(
    oldPath: string,
    newPath: string,
    stableSessionId?: string,
    pendingCreateOperationId?: string,
  ): void {
    if (this.canonicalCapture) {
      const replacementRootSessionId = stableSessionId?.trim();
      this.canonicalRootSessionIdByPath.delete(oldPath);
      if (replacementRootSessionId) {
        this.canonicalRootSessionIdByPath.set(newPath, replacementRootSessionId);
      }
    }
    this.workingTime.replaceSessionPath(oldPath, newPath);
    this.tracker.replaceSessionPath(oldPath, newPath, stableSessionId);
    this.accounting.replaceSessionPath(oldPath, newPath);
    // A rename is the same durable root; the restored busy-union marker moves
    // so the rebound path never re-queries or loses its restored clock.
    const restoredBusyRoot = this.canonicalBusyRestoredRootByPath.get(oldPath);
    if (restoredBusyRoot !== undefined) {
      this.canonicalBusyRestoredRootByPath.delete(oldPath);
      this.canonicalBusyRestoredRootByPath.set(newPath, restoredBusyRoot);
    }
    const pendingUsage = this.pendingCanonicalUsageByPath.get(oldPath);
    if (pendingUsage) {
      this.pendingCanonicalUsageByPath.delete(oldPath);
      this.pendingCanonicalUsageByPath.set(newPath, pendingUsage);
    }
    const capturedBranchEntries = this.canonicalBranchEntriesBySession.get(oldPath);
    if (capturedBranchEntries) {
      this.canonicalBranchEntriesBySession.delete(oldPath);
      this.canonicalBranchEntriesBySession.set(newPath, capturedBranchEntries);
    }
    if (this.canonicalCapture) this.invalidateCanonicalSessionCache();
    for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
      if (!key.startsWith(`${oldPath}\0`)) continue;
      const toolId = key.slice(oldPath.length + 1);
      this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(newPath, toolId)] =
        this.activeToolIntervalBySessionAndTool[key];
      delete this.activeToolIntervalBySessionAndTool[key];
    }
    for (const key of Object.keys(this.activeToolStartedAtBySessionAndTool)) {
      if (!key.startsWith(`${oldPath}\0`)) continue;
      const toolId = key.slice(oldPath.length + 1);
      this.activeToolStartedAtBySessionAndTool[this.toolIntervalKey(newPath, toolId)] =
        this.activeToolStartedAtBySessionAndTool[key];
      delete this.activeToolStartedAtBySessionAndTool[key];
    }
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

  /** Bounded canonical activity projection for the global scope or one
   * visible session. `totals.measuredTotalMs` is additive measured work, not
   * the busy wall-time union; callers must retain the `truncated` and
   * known/unknown counts from the projection. */
  getCanonicalActivityProjection(sessionPath?: string): CanonicalActivityProjectionSnapshot {
    if (this.canonicalCacheFailClosed || this.canonicalActivityReadSuppressed(sessionPath)) {
      return {
        authority: 'unknown',
        scope: this.canonicalProjectionScope(sessionPath),
        projection: null,
      };
    }
    const entry = this.canonicalActivityCacheEntry(sessionPath);
    if (entry) {
      entry.lastUsed = ++this.canonicalActivityUseSequence;
      return entry.activity;
    }
    this.scheduleCanonicalActivityHydration(sessionPath);
    return {
      authority: 'unknown',
      scope: this.canonicalProjectionScope(sessionPath),
      projection: null,
    };
  }

  /** Bounded canonical tool/file facet projection for the global scope or one
   * visible session. Returned rows retain their explicit verification and
   * attempted-change qualification; they are not verified worktree changes. */
  getCanonicalToolFacetProjection(sessionPath?: string): CanonicalToolFacetProjectionSnapshot {
    if (this.canonicalCacheFailClosed || this.canonicalActivityReadSuppressed(sessionPath)) {
      return {
        authority: 'unknown',
        scope: this.canonicalProjectionScope(sessionPath),
        projection: null,
      };
    }
    const entry = this.canonicalActivityCacheEntry(sessionPath);
    if (entry) {
      entry.lastUsed = ++this.canonicalActivityUseSequence;
      return entry.toolFacets;
    }
    this.scheduleCanonicalActivityHydration(sessionPath);
    return {
      authority: 'unknown',
      scope: this.canonicalProjectionScope(sessionPath),
      projection: null,
    };
  }

  /** The two canonical activity surfaces are returned separately qualified;
   * one unavailable projection must not make the other look complete. */
  getCanonicalActivityStats(sessionPath?: string): CanonicalActivityStats {
    return {
      activity: this.getCanonicalActivityProjection(sessionPath),
      toolFacets: this.getCanonicalToolFacetProjection(sessionPath),
    };
  }

  private pendingSampleStillStreams(sessionPath: string, sample: SessionUsageSample): boolean {
    const provisionalMessageId = sample.provisionalMessageId;
    if (!provisionalMessageId) return false;
    const message = this.getArchState().transcript.bySession[sessionPath]
      ?.find((candidate) => candidate.id === provisionalMessageId);
    return message?.role === 'assistant'
      && message.status === 'streaming'
      && message.usage === undefined;
  }

  /** Add observed rows until their canonical invocation identity is visible.
   * A matched row stays through the terminal transcript update when necessary,
   * so the live estimator can suppress the same stream before its host message
   * leaves the streaming state. */
  private sessionUsageWithPending(sessionPath: string, snapshot: SessionUsageSnapshot): SessionUsageSnapshot {
    const pending = this.pendingCanonicalUsageByPath.get(sessionPath);
    if (!pending || pending.size === 0) return snapshot;
    const currentScopeKey = this.canonicalRootSessionId(sessionPath);
    const durableIds = new Set<string>();
    for (const sample of snapshot.samples) {
      if (sample.canonicalInvocationId) durableIds.add(sample.canonicalInvocationId);
      durableIds.add(sample.sourceId);
    }
    const visible: SessionUsageSample[] = [];
    for (const [invocationId, entry] of pending) {
      if (entry.scopeKey !== currentScopeKey) {
        pending.delete(invocationId);
        continue;
      }
      if (durableIds.has(invocationId) && !this.pendingSampleStillStreams(sessionPath, entry.sample)) {
        pending.delete(invocationId);
        continue;
      }
      visible.push(entry.sample);
    }
    if (pending.size === 0) this.pendingCanonicalUsageByPath.delete(sessionPath);
    return visible.length > 0 ? { ...snapshot, pendingSamples: visible } : snapshot;
  }

  /** Ledger-backed session usage projection for UI and fixture conservation checks. */
  getSessionUsage(sessionPath: string): SessionUsageSnapshot {
    if (!this.canonicalCapture) return this.accounting.projectSessionUsage(sessionPath);
    if (this.canonicalPrivateClosesByPath.has(sessionPath) || this.canonicalCacheFailClosed) {
      return this.unknownSessionUsage();
    }
    // During an ordinary bounded rehydration, retain the last complete
    // same-scope read. It is explicitly stale while the replacement is in
    // flight; a missing held entry is still unknown rather than a guessed
    // transcript projection.
    if (this.canonicalSessionUsageRefresh && this.canonicalSessionUsageHeldByPath) {
      const held = this.canonicalSessionUsageHeldByPath.get(sessionPath);
      if (!held || !this.canonicalSessionUsageEntryMatchesScope(sessionPath, held)) {
        return this.unknownSessionUsage('refreshing');
      }
      held.lastUsed = ++this.canonicalSessionUsageUseSequence;
      return this.sessionUsageWithPending(sessionPath, this.sessionUsageWithState(held.snapshot, 'stale', 'refreshing'));
    }
    const durable = this.canonicalSessionUsageByPath.get(sessionPath);
    // A path can retain a stale identity after a session replacement that did
    // not pass through the normal rename callback. Never expose that old
    // root's usage under the new identity.
    if (durable && !this.canonicalSessionUsageEntryMatchesScope(sessionPath, durable)) {
      this.forgetCanonicalBusyRestoreForPath(sessionPath);
      this.scheduleCanonicalActivityHydration(sessionPath);
      return this.unknownSessionUsage('refreshing');
    }
    // A canonical entry with an older revision is still a coherent last-known
    // root read. Do not manufacture an empty unknown while the bounded
    // replacement runs; mark the returned snapshot stale instead.
    if (durable && durable.snapshot.authority === 'canonical'
      && !this.canonicalSessionUsageEntryIsFresh(durable)) {
      this.scheduleCanonicalActivityHydration(sessionPath);
      durable.lastUsed = ++this.canonicalSessionUsageUseSequence;
      const refreshStatus = durable.snapshot.refreshStatus === 'error' ? 'error' : 'refreshing';
      return this.sessionUsageWithPending(sessionPath, this.sessionUsageWithState(durable.snapshot, 'stale', refreshStatus));
    }
    if (durable) {
      // Unknown/read-error entries are already explicit fail-closed coverage;
      // do not turn every renderer read into another helper query.
      durable.lastUsed = ++this.canonicalSessionUsageUseSequence;
      return this.sessionUsageWithPending(sessionPath, durable.snapshot);
    }
    // Shutdown is terminal for the host service. A renderer can still ask
    // for a projection while its final render is draining; never turn that
    // late read into a new helper process.
    if (this.disposed) return this.unknownSessionUsage();
    // Session catalog hydration can legitimately happen after StatsService
    // startup. Kick off one bounded read on the first projection instead of
    // requiring a second host start. The same read hydrates canonical activity
    // and facets; until it answers, each surface stays explicitly unknown.
    this.scheduleCanonicalActivityHydration(sessionPath);
    return this.sessionUsageWithPending(sessionPath, this.unknownSessionUsage('refreshing'));
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

  private canonicalProjectionScope(sessionPath?: string): CanonicalProjectionScope {
    if (sessionPath === undefined) return { kind: 'global' };
    return { kind: 'session', rootSessionId: this.canonicalRootSessionId(sessionPath) };
  }

  private canonicalSessionScopeKey(sessionPath: string): string {
    // Session usage is read through ProviderSettlementScope, whose durable
    // root scope is named `rootSession`; activity projections use the
    // separate public `session` scope vocabulary.
    return JSON.stringify({ kind: 'rootSession', rootSessionId: this.canonicalRootSessionId(sessionPath) });
  }

  private canonicalSessionUsageEntryMatchesScope(
    sessionPath: string,
    entry: CanonicalSessionUsageCacheEntry,
  ): boolean {
    // Unknown is fail-closed and contains no subject data, so diagnostic/read
    // error scope keys must not prevent it from remaining an explicit unknown.
    if (entry.snapshot.authority !== 'canonical') return true;
    return entry.scopeKey === this.canonicalSessionScopeKey(sessionPath);
  }

  private canonicalSessionUsageEntryIsFresh(entry: CanonicalSessionUsageCacheEntry): boolean {
    const currentRevision = this.analyticsRevisionRefresher?.getStats().revision;
    if (currentRevision === null || currentRevision === undefined) return true;
    try {
      return canonicalRevision(entry.revision) >= canonicalRevision(currentRevision);
    } catch {
      return false;
    }
  }

  private unknownSessionUsage(refreshStatus: SessionUsageRefreshStatus = 'idle'): SessionUsageSnapshot {
    if (refreshStatus === 'idle') return { samples: [], authority: 'unknown' };
    return {
      samples: [],
      authority: 'unknown',
      freshness: 'unknown',
      refreshStatus,
    };
  }

  private sessionUsageWithState(
    snapshot: SessionUsageSnapshot,
    freshness: SessionUsageFreshness,
    refreshStatus: SessionUsageRefreshStatus,
  ): SessionUsageSnapshot {
    return {
      ...snapshot,
      freshness: snapshot.authority === 'canonical' ? freshness : 'unknown',
      refreshStatus,
    };
  }

  /** Staleness drives a rescheduling decision only for the bounded displayed
   * surface the eager pass can actually re-read. The cache may retain more
   * paths than that surface; a revision invalidation must never keep a 250ms
   * retry timer alive for paths the bounded pass omits, because only a lazy
   * on-demand read can satisfy them. */
  private hasStaleCanonicalSessionUsageForPaths(sessionPaths: Iterable<string>): boolean {
    for (const sessionPath of sessionPaths) {
      const entry = this.canonicalSessionUsageByPath.get(sessionPath);
      if (entry && entry.snapshot.authority === 'canonical'
        && !this.canonicalSessionUsageEntryIsFresh(entry)) return true;
    }
    return false;
  }

  private hasCanonicalSessionUsageRefreshErrorForPaths(sessionPaths: Iterable<string>): boolean {
    for (const sessionPath of sessionPaths) {
      const entry = this.canonicalSessionUsageByPath.get(sessionPath);
      if (entry && entry.snapshot.refreshStatus === 'error') return true;
    }
    return false;
  }

  /** Reinsert held entries omitted by the bounded displayed-session pass.
   * Keeping them avoids an artificial unknown for a same-root commit, while
   * scope checks still prevent identity or deletion rebinding. The retained
   * freshness is the revision truth: an entry whose own revision still covers
   * the refresher's current watermark stays fresh instead of wearing a
   * permanent stale badge the bounded pass can never clear; only an older
   * revision is stale and recovers lazily when its path is requested. */
  private retainHeldCanonicalSessionUsage(status: SessionUsageRefreshStatus): void {
    const held = this.canonicalSessionUsageHeldByPath;
    if (!held || this.canonicalCacheFailClosed) return;
    for (const [sessionPath, entry] of held) {
      if (this.canonicalSessionUsageByPath.has(sessionPath)
        || this.canonicalPrivateClosesByPath.has(sessionPath)
        || !this.canonicalSessionUsageEntryMatchesScope(sessionPath, entry)) continue;
      const entryIsFresh = this.canonicalSessionUsageEntryIsFresh(entry);
      const freshness: SessionUsageFreshness = entry.snapshot.authority !== 'canonical'
        ? 'unknown'
        : entryIsFresh ? 'fresh' : 'stale';
      const effectiveStatus = status === 'refreshing' && entryIsFresh
        ? 'idle'
        : status;
      this.cacheCanonicalSessionUsage(
        sessionPath,
        this.sessionUsageWithState(entry.snapshot, freshness, effectiveStatus),
        entry.revision,
        entry.scopeKey,
        this.canonicalCacheEpoch,
      );
    }
  }

  private scheduleCanonicalSessionUsageRetry(): void {
    if (this.canonicalSessionUsageRetryTimer !== undefined
      || this.disposed || this.canonicalCacheFailClosed
      || !this.analyticsReadModel || !this.canonicalCapture) return;
    this.canonicalSessionUsageRetryTimer = setTimeout(() => {
      this.canonicalSessionUsageRetryTimer = undefined;
      if (this.disposed || this.canonicalCacheFailClosed || this.canonicalSessionUsageRefresh) return;
      void this.refreshCanonicalSessionUsage();
    }, CANONICAL_SESSION_REFRESH_RETRY_DELAY_MS);
    this.canonicalSessionUsageRetryTimer.unref?.();
  }

  private cancelCanonicalSessionUsageRetry(): void {
    if (this.canonicalSessionUsageRetryTimer === undefined) return;
    clearTimeout(this.canonicalSessionUsageRetryTimer);
    this.canonicalSessionUsageRetryTimer = undefined;
  }

  private canonicalRootSessionId(sessionPath: string): string {
    const identity = this.sessionIdentity(sessionPath);
    return identity.sessionId ?? analyticsRootSessionId(null, sessionPath);
  }

  private canonicalActivityCacheEntry(sessionPath?: string): CanonicalActivityCacheEntry | undefined {
    const entry = sessionPath === undefined
      ? this.canonicalGlobalActivity ?? undefined
      : this.canonicalActivityByPath.get(sessionPath);
    if (entry && sessionPath !== undefined
      && entry.scopeKey !== JSON.stringify(this.canonicalProjectionScope(sessionPath))) {
      return undefined;
    }
    return entry;
  }

  private canonicalActivityReadSuppressed(sessionPath?: string): boolean {
    return sessionPath === undefined
      ? this.canonicalPrivateClosesByPath.size > 0
      : this.canonicalPrivateClosesByPath.has(sessionPath);
  }

  private canHydrateCanonicalActivity(): boolean {
    return !this.disposed
      && !this.canonicalCacheFailClosed
      && Boolean(this.analyticsReadModel && this.canonicalCapture)
      && this.started
      && !this.canonicalRevisionAwaitingBaseline
      && Boolean(this.analyticsRevisionRefresher
        && this.analyticsRevisionRefresher.getStats().revision !== null);
  }

  private scheduleCanonicalActivityHydration(sessionPath?: string): void {
    if (!this.canHydrateCanonicalActivity()) return;
    if (this.canonicalSessionUsageRefresh) return;
    if (sessionPath === undefined) {
      // The global projection is hydrated by the same bounded pass as the
      // displayed sessions. This preserves one revision/epoch fence and never
      // turns a global read into a history-sized scan.
      void this.refreshCanonicalSessionUsage();
      return;
    }
    const readModel = this.analyticsReadModel!;
    if (this.canonicalSessionPathRefreshes.size >= readModel.getMaxConcurrentQueries()
      || this.canonicalSessionPathRefreshes.has(sessionPath)) return;
    const refresh = this.refreshCanonicalSessionPath(sessionPath);
    this.canonicalSessionPathRefreshes.set(sessionPath, refresh);
    void refresh.finally(() => {
      if (this.canonicalSessionPathRefreshes.get(sessionPath) === refresh) {
        this.canonicalSessionPathRefreshes.delete(sessionPath);
        if (!this.canonicalSessionUsageByPath.has(sessionPath)
          && !this.canonicalActivityByPath.has(sessionPath)) {
          this.canonicalSessionPathEpochs.delete(sessionPath);
        }
      }
      this.scheduleRender();
    }).catch(() => undefined);
  }

  private estimateCanonicalActivityBytes(entry: CanonicalActivityCacheEntry): number {
    try {
      // This is a deterministic serialized-size proxy used only to bound the
      // host cache; it is not a heap measurement or a qualification claim.
      return JSON.stringify(entry).length * 2;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private removeCanonicalActivityCache(sessionPath?: string): void {
    if (sessionPath === undefined) {
      if (!this.canonicalGlobalActivity) return;
      this.canonicalActivityCacheBytes = Math.max(
        0,
        this.canonicalActivityCacheBytes - this.canonicalGlobalActivity.estimatedBytes,
      );
      this.canonicalGlobalActivity = null;
      return;
    }
    const entry = this.canonicalActivityByPath.get(sessionPath);
    if (!entry) return;
    this.canonicalActivityByPath.delete(sessionPath);
    this.canonicalActivityCacheBytes = Math.max(
      0,
      this.canonicalActivityCacheBytes - entry.estimatedBytes,
    );
  }

  private clearCanonicalActivityCache(): void {
    this.canonicalActivityByPath.clear();
    this.canonicalGlobalActivity = null;
    this.canonicalActivityCacheBytes = 0;
  }

  private cacheCanonicalActivityRead(
    sessionPath: string | undefined,
    result: CanonicalActivityReadResult,
    epoch: number,
  ): void {
    if (this.disposed || epoch !== this.canonicalCacheEpoch
      || (sessionPath !== undefined && this.canonicalPrivateClosesByPath.has(sessionPath))) return;
    this.removeCanonicalActivityCache(sessionPath);
    const activity: CanonicalActivityProjectionSnapshot = {
      authority: result.activity ? 'canonical' : 'unknown',
      scope: result.activity?.scope ?? result.scope,
      projection: result.activity,
    };
    const toolFacets: CanonicalToolFacetProjectionSnapshot = {
      authority: result.toolFacets ? 'canonical' : 'unknown',
      scope: result.toolFacets?.scope ?? result.scope,
      projection: result.toolFacets,
    };
    const entry: CanonicalActivityCacheEntry = {
      activity,
      toolFacets,
      revision: result.revision,
      scopeKey: result.scopeKey,
      epoch,
      estimatedBytes: 0,
      lastUsed: ++this.canonicalActivityUseSequence,
    };
    entry.estimatedBytes = this.estimateCanonicalActivityBytes(entry);
    // The helper already caps each result. Keep an additional host-side bound
    // so a malformed/future adapter cannot retain an unbounded object.
    if (entry.estimatedBytes > MAX_CANONICAL_ACTIVITY_CACHE_BYTES) {
      entry.activity = { authority: 'unknown', scope: result.scope, projection: null };
      entry.toolFacets = { authority: 'unknown', scope: result.scope, projection: null };
      entry.estimatedBytes = this.estimateCanonicalActivityBytes(entry);
    }
    if (sessionPath === undefined) this.canonicalGlobalActivity = entry;
    else this.canonicalActivityByPath.set(sessionPath, entry);
    this.canonicalActivityCacheBytes += entry.estimatedBytes;

    while (this.canonicalActivityByPath.size + (this.canonicalGlobalActivity ? 1 : 0)
      > MAX_CANONICAL_ACTIVITY_CACHE_ENTRIES
      || this.canonicalActivityCacheBytes > MAX_CANONICAL_ACTIVITY_CACHE_BYTES) {
      let oldestPath: string | undefined;
      let oldestEntry: CanonicalActivityCacheEntry | null = this.canonicalGlobalActivity;
      if (oldestEntry) oldestPath = undefined;
      for (const [path, candidate] of this.canonicalActivityByPath) {
        if (!oldestEntry || candidate.lastUsed < oldestEntry.lastUsed) {
          oldestEntry = candidate;
          oldestPath = path;
        }
      }
      if (!oldestEntry) break;
      this.removeCanonicalActivityCache(oldestPath);
    }
  }

  private applyCanonicalActivityRead(
    sessionPath: string | undefined,
    result: CanonicalActivityReadResult,
    epoch: number,
  ): void {
    this.cacheCanonicalActivityRead(sessionPath, result, epoch);
    if (result.activityError !== undefined) {
      appendPieLog('warn', 'analytics', 'canonical activity projection read failed', {
        ...(sessionPath === undefined ? {} : { path: sessionPath }),
        error: result.activityError instanceof Error ? result.activityError.message : String(result.activityError),
      });
    }
    if (result.toolFacetsError !== undefined) {
      appendPieLog('warn', 'analytics', 'canonical tool facet projection read failed', {
        ...(sessionPath === undefined ? {} : { path: sessionPath }),
        error: result.toolFacetsError instanceof Error ? result.toolFacetsError.message : String(result.toolFacetsError),
      });
    }
  }

  private async readCanonicalActivityScope(sessionPath?: string): Promise<CanonicalActivityReadResult> {
    const readModel = this.analyticsReadModel!;
    const scope = this.canonicalProjectionScope(sessionPath);
    const rootSessionId = scope.kind === 'session' ? scope.rootSessionId : undefined;
    const activityReader = readModel.readActivityProjection;
    const facetReader = readModel.readToolFacetProjection;
    const activityPromise: Promise<CanonicalActivityProjection | null> = typeof activityReader === 'function'
      ? Promise.resolve().then(() => activityReader.call(readModel, {
        ...(rootSessionId === undefined ? {} : { rootSessionId }),
        maxKinds: MAX_CANONICAL_ACTIVITY_KINDS,
        maxResultBytes: MAX_CANONICAL_ACTIVITY_RESULT_BYTES,
      }))
      : Promise.resolve(null);
    const facetPromise: Promise<CanonicalToolFacetProjection | null> = typeof facetReader === 'function'
      ? Promise.resolve().then(() => facetReader.call(readModel, {
        ...(rootSessionId === undefined ? {} : { rootSessionId }),
        limit: MAX_CANONICAL_TOOL_FACETS,
        maxResultBytes: MAX_CANONICAL_ACTIVITY_RESULT_BYTES,
      }))
      : Promise.resolve(null);
    const [activityRead, facetRead] = await Promise.allSettled([activityPromise, facetPromise]);
    const activity = activityRead.status === 'fulfilled' ? activityRead.value : null;
    const toolFacets = facetRead.status === 'fulfilled' ? facetRead.value : null;
    const revisions = [
      activity?.projectionRevision,
      activity?.revision,
      toolFacets?.projectionRevision,
      toolFacets?.revision,
    ];
    let revision = this.analyticsRevisionRefresher?.getStats().revision ?? '0';
    for (const candidate of revisions) {
      if (candidate === undefined || candidate === null) continue;
      try {
        if (canonicalRevision(candidate) > canonicalRevision(revision)) revision = canonicalRevisionString(candidate);
      } catch {
        // A malformed adapter result remains unavailable through the normal
        // cache fence; do not let it poison revision ordering.
      }
    }
    return {
      revision: canonicalRevisionString(revision),
      scope,
      scopeKey: JSON.stringify(scope),
      activity,
      toolFacets,
      ...(activityRead.status === 'rejected' ? { activityError: activityRead.reason } : {}),
      ...(facetRead.status === 'rejected' ? { toolFacetsError: facetRead.reason } : {}),
    };
  }

  /** Rehydrate each known session from the canonical root-session projection.
   * Every query is capped by the read-model transport. A truncated session is
   * left unknown rather than exposing a partial usage history. Ordinary passes
   * serve a held complete read while the replacement cache is built; strict
   * invalidations stay fail-closed. Render notification is deferred until all
   * bounded reads in the pass have settled. */
  private async refreshCanonicalSessionUsage(): Promise<void> {
    if (!this.analyticsReadModel || !this.canonicalCapture) return;
    const readModel = this.analyticsReadModel;
    if (this.canonicalSessionUsageRefresh) return await this.canonicalSessionUsageRefresh;
    // A normal bounded rehydration is stale-while-revalidate for the visible
    // session usage read. Move the last complete cache behind a held-read
    // fence, then build the replacement cache without making an unrelated
    // render observe an empty map. Strict invalidations set failClosed and
    // deliberately skip this hold so they remain unknown immediately.
    if (!this.canonicalCacheFailClosed && this.canonicalSessionUsageHeldByPath === null) {
      this.canonicalSessionUsageHeldByPath = new Map(this.canonicalSessionUsageByPath);
      this.clearCanonicalSessionCache();
    }
    let refreshSucceeded = false;
    let refreshHadFailure = false;
    // The bounded pass's refresh targets. Rescheduling decisions (another pass
    // or the delayed retry) consult only these paths: retained entries outside
    // the displayed bound cannot be satisfied by the eager pass and must never
    // keep it looping or retrying.
    let refreshTargetPaths: readonly string[] = [];
    const refresh = (async () => {
      let passCount = 0;
      for (;;) {
        passCount += 1;
        // A revision/branch invalidation that arrives while a helper is in
        // flight increments the epoch and requests another pass. Ordinary
        // same-root results may still publish as stale; strict invalidations
        // reject them before they cross the deletion/identity fence.
        this.canonicalRefreshRequested = false;
        this.canonicalDirtyRevision = null;
        const epoch = ++this.canonicalCacheEpoch;
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
        refreshTargetPaths = sessions.map((session) => session.path);
        const globalActivityRead = this.readCanonicalActivityScope();
        const hydrateGlobalActivity = globalActivityRead.then((result) => {
          if (!this.disposed && epoch === this.canonicalCacheEpoch) {
            this.applyCanonicalActivityRead(undefined, result, epoch);
          }
        }).catch((error: unknown) => {
          if (!this.disposed && epoch === this.canonicalCacheEpoch) {
            appendPieLog('warn', 'analytics', 'canonical global activity projection refresh failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        let nextIndex = 0;
        let passHadFailure = false;
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
            const [usageRead, activityRead] = await Promise.allSettled([
              this.readCanonicalSessionPath(session.path),
              this.readCanonicalActivityScope(session.path),
            ]);
            if (usageRead.status === 'fulfilled') {
              this.applyCanonicalSessionRead(session.path, usageRead.value, epoch);
            } else {
              passHadFailure = true;
              if (epoch === this.canonicalCacheEpoch) {
                this.cacheCanonicalRefreshFailure(session.path, epoch);
              }
              appendPieLog('warn', 'analytics', 'canonical session usage read failed', {
                path: session.path,
                error: usageRead.reason instanceof Error ? usageRead.reason.message : String(usageRead.reason),
              });
            }
            if (activityRead.status === 'fulfilled') {
              this.applyCanonicalActivityRead(session.path, activityRead.value, epoch);
            } else if (epoch === this.canonicalCacheEpoch) {
              appendPieLog('warn', 'analytics', 'canonical session activity projection refresh failed', {
                path: session.path,
                error: activityRead.reason instanceof Error ? activityRead.reason.message : String(activityRead.reason),
              });
            }
          }
        };
        await Promise.all([
          hydrateGlobalActivity,
          ...Array.from({ length: workerCount }, () => readWorker()),
        ]);
        // A helper result carries its own snapshot revision. If the refresher
        // already knows a newer revision, do not release this pass as fresh;
        // immediately run one more bounded read instead of publishing an
        // older snapshot as the new steady state.
        const currentRevision = this.analyticsRevisionRefresher?.getStats().revision;
        if (!this.canonicalRefreshRequested && !this.canonicalDirtyRevision
          && currentRevision !== null && currentRevision !== undefined
          && this.hasStaleCanonicalSessionUsageForPaths(refreshTargetPaths)) {
          this.canonicalRefreshRequested = true;
          this.canonicalDirtyRevision = canonicalRevisionString(currentRevision);
        }
        refreshHadFailure ||= passHadFailure;
        // A completed read may be overtaken by a writer. Catch up once, then
        // publish the last completed coherent result and retry asynchronously
        // rather than starving the renderer under sustained commits.
        const needsAnotherPass = !this.disposed && (
          this.canonicalRefreshRequested
          || this.canonicalDirtyRevision !== null
          || passHadFailure
          || this.hasStaleCanonicalSessionUsageForPaths(refreshTargetPaths)
        );
        if (this.disposed || !needsAnotherPass || passCount >= MAX_CANONICAL_SESSION_REFRESH_PASSES) break;
      }
      refreshSucceeded = true;
    })();
    this.canonicalSessionUsageRefresh = refresh;
    try {
      await refresh;
    } catch (error) {
      appendPieLog('warn', 'analytics', 'canonical session usage refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.canonicalSessionUsageRefresh === refresh) {
        this.canonicalSessionUsageRefresh = null;
        if (!refreshSucceeded && !this.disposed) {
          // An unexpected strict refresh failure cannot release the fence. An
          // ordinary refresh retains its last complete same-scope read with
          // an explicit error marker so it is never mistaken for fresh data.
          if (this.canonicalCacheFailClosed) {
            this.clearCanonicalSessionCache();
          } else {
            this.retainHeldCanonicalSessionUsage('error');
          }
        } else if (refreshSucceeded && !this.disposed && !this.canonicalCacheFailClosed) {
          this.retainHeldCanonicalSessionUsage(refreshHadFailure ? 'error' : 'refreshing');
          // The bounded pass intentionally yields to a sustained writer.
          // Clear the transient request and retry later instead of looping
          // synchronously or starving a completed snapshot publication.
          this.canonicalRefreshRequested = false;
          this.canonicalDirtyRevision = null;
          this.canonicalCacheFailClosed = false;
        } else if (refreshSucceeded && !this.disposed && !refreshHadFailure) {
          // A strict pass may still observe the revision callback for the
          // commit it just read. The completed scope-checked result is safe to
          // publish; any newer same-root revision is handled as stale on the
          // next bounded retry rather than holding the strict fence forever.
          this.canonicalCacheFailClosed = false;
        }
        const shouldRetry = !this.disposed
          && !this.canonicalCacheFailClosed
          && (this.hasStaleCanonicalSessionUsageForPaths(refreshTargetPaths)
            || this.hasCanonicalSessionUsageRefreshErrorForPaths(refreshTargetPaths));
        this.canonicalSessionUsageHeldByPath = null;
        if (shouldRetry) this.scheduleCanonicalSessionUsageRetry();
        // Render only after the complete bounded pass has settled. Ordinary
        // renders read the held snapshot above; strict invalidations remain
        // fail-closed until this point.
        if (!this.disposed && this.started) this.scheduleRender();
      }
    }
  }

  /** Invalidate every host-side canonical snapshot before a revision or scope
   * transition. The next durable read is the only source allowed to repopulate
   * the cache.
   *
   * `failClosed` distinguishes the two invalidation families. The default
   * strict form (privacy close, path rename away, reconciliation failure, or
   * an unavailable startup watermark) may hide or delete a subject, so it
   * clears the held read and the live cache immediately and fails closed until
   * the replacement pass lands. Ordinary peer revisions use
   * markCanonicalRevisionForRefresh instead, while a same-root branch or
   * selection transition passes `false`: the root never changes, so the prior
   * complete read continues to serve renders while the replacement pass
   * re-reads instead of dropping the displayed cost to an em dash for the
   * whole pending-commit window. */
  private invalidateCanonicalSessionCache(schedule = true, failClosed = true): void {
    this.canonicalCacheEpoch += 1;
    this.canonicalRefreshRequested = true;
    if (failClosed) {
      this.cancelCanonicalSessionUsageRetry();
      this.canonicalCacheFailClosed = true;
      this.canonicalSessionUsageHeldByPath = null;
      this.clearCanonicalSessionCache();
    }
    if (schedule && !this.disposed && this.analyticsReadModel && this.canonicalCapture
      && !this.canonicalSessionUsageRefresh) {
      void this.refreshCanonicalSessionUsage();
    }
  }

  /** Ordinary cross-host revision refresh. Keep the last complete cache in
   * stale-while-revalidate state; the durable read carries the explicit
   * revision that decides when the replacement is fresh. */
  private markCanonicalRevisionForRefresh(revision: string): void {
    this.canonicalCacheEpoch += 1;
    this.canonicalRefreshRequested = true;
    if (this.canonicalDirtyRevision === null
      || canonicalRevision(revision) > canonicalRevision(this.canonicalDirtyRevision)) {
      this.canonicalDirtyRevision = canonicalRevisionString(revision);
    }
    // Do not clear the cache or raise the fail-closed fence here. The refresh
    // pass moves this exact cache behind canonicalSessionUsageHeldByPath before
    // building its replacement. If an explicit invalidation already owns the
    // fence, it remains strict and no old snapshot is revived.
    if (!this.disposed && this.analyticsReadModel && this.canonicalCapture
      && !this.canonicalSessionUsageRefresh) {
      void this.refreshCanonicalSessionUsage();
    }
  }

  /** Strict invalidation for privacy/deletion, identity replacement, startup
   * watermark uncertainty, or any other transition where stale subject data
   * must not be displayed. */
  private markCanonicalRevisionDirty(revision: string): void {
    this.canonicalCacheEpoch += 1;
    this.canonicalRefreshRequested = true;
    this.cancelCanonicalSessionUsageRetry();
    this.canonicalCacheFailClosed = true;
    this.canonicalSessionUsageHeldByPath = null;
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
    this.clearCanonicalActivityCache();
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

  private canonicalSessionReadEpochAccepted(revision: string, epoch: number): boolean {
    if (epoch === this.canonicalCacheEpoch || !this.canonicalCacheFailClosed) return true;
    // A strict read that started after the deletion/identity fence may finish
    // after a revision callback bumps the epoch. Admit it only when its own
    // durable watermark reaches the invalidation watermark; an older response
    // must remain rejected so it cannot resurrect deleted or rebound data.
    if (this.canonicalDirtyRevision === null) return false;
    try {
      return canonicalRevision(revision) >= canonicalRevision(this.canonicalDirtyRevision);
    } catch {
      return false;
    }
  }

  private canonicalSessionUsageSnapshotForCache(
    snapshot: SessionUsageSnapshot,
    revision: string,
  ): SessionUsageSnapshot {
    if (snapshot.authority !== 'canonical') {
      return this.sessionUsageWithState(snapshot, 'unknown', snapshot.refreshStatus ?? 'idle');
    }
    const currentRevision = this.analyticsRevisionRefresher?.getStats().revision;
    let freshness: SessionUsageFreshness = snapshot.freshness ?? 'fresh';
    if (currentRevision !== null && currentRevision !== undefined) {
      try {
        freshness = canonicalRevision(revision) >= canonicalRevision(currentRevision) ? 'fresh' : 'stale';
      } catch {
        freshness = 'unknown';
      }
    }
    return this.sessionUsageWithState(snapshot, freshness, snapshot.refreshStatus ?? 'idle');
  }

  private cacheCanonicalUnknown(
    sessionPath: string,
    revision: string,
    scopeKey: string,
    epoch: number,
    refreshStatus: SessionUsageRefreshStatus = 'idle',
  ): void {
    this.cacheCanonicalSessionUsage(
      sessionPath,
      this.unknownSessionUsage(refreshStatus),
      revision,
      scopeKey,
      epoch,
    );
  }

  private cacheCanonicalRefreshFailure(sessionPath: string, epoch: number): void {
    const prior = this.canonicalSessionUsageHeldByPath?.get(sessionPath)
      ?? this.canonicalSessionUsageByPath.get(sessionPath);
    if (prior && this.canonicalSessionUsageEntryMatchesScope(sessionPath, prior)
      && !this.canonicalCacheFailClosed) {
      this.cacheCanonicalSessionUsage(
        sessionPath,
        this.sessionUsageWithState(prior.snapshot, 'stale', 'error'),
        prior.revision,
        prior.scopeKey,
        epoch,
      );
      return;
    }
    this.cacheCanonicalUnknown(sessionPath, '0', 'read-error', epoch, 'error');
  }

  private cacheCanonicalSessionUsage(
    sessionPath: string,
    snapshot: SessionUsageSnapshot,
    revision: string,
    scopeKey: string,
    epoch: number,
  ): void {
    if (!this.canonicalSessionReadEpochAccepted(revision, epoch)
      || this.canonicalPrivateClosesByPath.has(sessionPath)) return;
    this.removeCanonicalSessionCache(sessionPath);
    let storedSnapshot = this.canonicalSessionUsageSnapshotForCache(snapshot, revision);
    let estimatedBytes = this.estimateCanonicalSessionUsageBytes(storedSnapshot);
    let sampleCount = snapshot.samples.length;
    // A complete but too-large session cannot be represented safely in this
    // bounded host cache. Preserve truthful unknown coverage instead of
    // retaining an unbounded all-history object.
    if (sampleCount > MAX_CANONICAL_SESSION_CACHE_SAMPLES
      || estimatedBytes > MAX_CANONICAL_SESSION_CACHE_BYTES) {
      storedSnapshot = this.unknownSessionUsage(snapshot.refreshStatus ?? 'idle');
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
    this.evictCanonicalSessionUsageOverflow();
  }

  /** Shared LRU eviction for bounded session-usage cache insertion. */
  private evictCanonicalSessionUsageOverflow(): void {
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
    // An ordinary same-root invalidation may overtake this completed read; it
    // remains a coherent stale snapshot. Strict invalidations reject an old
    // response, but admit a completed read whose own revision reaches the
    // invalidation watermark.
    if (this.disposed || !this.canonicalSessionReadEpochAccepted(result.revision, epoch)) return;
    // A path can be rebound while a helper is in flight. A known result from
    // the old root must not be published under the new root; the next lazy
    // read will hydrate the current identity. Remove any old durable entry so
    // a subsequent render cannot retain it while that replacement read runs.
    if (!result.unknown && result.scopeKey !== this.canonicalSessionScopeKey(sessionPath)) {
      this.removeCanonicalSessionCache(sessionPath);
      return;
    }
    if (result.pendingSelection) {
      // The durable store has not committed the host-observed branch selection
      // yet. The prior complete read is still the last known truth for this
      // root; retain it (stale-while-revalidate) instead of caching a sticky
      // unknown that only a later revision change could clear. The revision
      // refresher converges the retained read once the pending commit lands.
      const prior = this.canonicalSessionUsageHeldByPath?.get(sessionPath)
        ?? this.canonicalSessionUsageByPath.get(sessionPath);
      if (prior && !this.canonicalPrivateClosesByPath.has(sessionPath)
        && this.canonicalSessionUsageEntryMatchesScope(sessionPath, prior)) {
        const status = prior.snapshot.refreshStatus === 'error' ? 'error' : 'refreshing';
        this.cacheCanonicalSessionUsage(
          sessionPath,
          this.sessionUsageWithState(prior.snapshot, 'stale', status),
          prior.revision,
          prior.scopeKey,
          epoch,
        );
        return;
      }
    }
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
    // The session indicator is a whole-root projection. It intentionally
    // includes branchless provider calls (auxiliary/prepass/title/compaction)
    // and calls recorded on every branch, including child/nested work that
    // shares this root. Explicit branch consumers continue to use
    // readCanonicalSelectedBranch/readScopedProviderSettlements directly.
    const rootResult = await readModel.readScopedProviderSettlements(
      { kind: 'rootSession', rootSessionId },
      { limit: MAX_CANONICAL_SESSION_CACHE_SAMPLES, maxResultBytes: MAX_CANONICAL_SESSION_CACHE_BYTES },
    );
    return {
      revision: canonicalRevisionString(rootResult.revision),
      settlements: rootResult.settlements,
      truncated: rootResult.truncated,
      scopeKey: JSON.stringify(rootResult.scope),
    };
  }

  /** Read the root's durable selected-branch projection.
   *
   * The selection lookup only discovers the generation and disambiguates the
   * selection; the selected-branch settlement read is the one consistent
   * snapshot and supplies the label. The recorder resolves the root's current
   * selection, walks its ancestry, and reads the settlement rows with their
   * projection revision inside a single SQLite transaction, so the returned
   * branch id and revision always describe exactly these rows. The first page is
   * deliberately not fenced with `expectedRevision`: that page fence rejects
   * page continuations whose projection changed, and fencing a first page
   * from a foreign snapshot only failed every read that raced a concurrent
   * commit while the answer was already self-consistent. `unknownRevision`
   * only labels the fail-closed results when no unambiguous selection exists.
   */
  private async readCanonicalSelectedBranch(
    rootSessionId: string,
    unknownRevision: string,
    options: { pendingSelectionOnMissingRow?: boolean } = {},
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
      return { revision: unknownRevision, settlements: [], truncated: false, scopeKey: `unknown:${rootSessionId}`, unknown: true };
    }
    const branchSelection = selection.rows[0];
    const generationId = typeof branchSelection?.generation_id === 'string'
      ? branchSelection.generation_id.trim() : '';
    const branchId = typeof branchSelection?.branch_id === 'string'
      ? branchSelection.branch_id.trim() : '';
    if (branchSelection === undefined || !generationId || !branchId) {
      // No committed selection row for this root. When the host itself has
      // observed a selected branch, this is the delayed-commit window at the
      // settle boundary: the settle-boundary captures have been submitted but
      // not committed. Label the read pending so the prior complete read is
      // retained instead of caching a sticky unknown.
      if (options.pendingSelectionOnMissingRow && branchSelection === undefined) {
        return { revision: unknownRevision, settlements: [], truncated: false, scopeKey: `unknown:${rootSessionId}`, unknown: true, pendingSelection: true };
      }
      return { revision: unknownRevision, settlements: [], truncated: false, scopeKey: `unknown:${rootSessionId}`, unknown: true };
    }
    const scope: ProviderSettlementScope = { kind: 'selectedBranch', generationId, rootSessionId };
    const result = await readModel.readScopedProviderSettlements(scope, {
      limit: MAX_CANONICAL_SESSION_CACHE_SAMPLES,
      maxResultBytes: MAX_CANONICAL_SESSION_CACHE_BYTES,
    });
    const scopeKey = JSON.stringify(scope);
    const atomicBranchId = typeof result.selectedBranchId === 'string'
      ? result.selectedBranchId.trim() : '';
    const selectedBranchKnown = result.selectionCoverage === 'known' && atomicBranchId.length > 0;
    return {
      revision: canonicalRevisionString(result.revision),
      settlements: result.settlements,
      truncated: result.truncated,
      scopeKey,
      ...(selectedBranchKnown ? { branchId: atomicBranchId } : {}),
      ...(!selectedBranchKnown ? { unknown: true } : {}),
    };
  }

  private async refreshCanonicalSessionPath(sessionPath: string): Promise<void> {
    if (!this.analyticsReadModel || !this.canonicalCapture) return;
    if (this.canonicalSessionUsageRefresh) {
      // An ordinary bounded pass owns the revision fence right now. Its finally
      // reinserts the held entries it omitted, so a path outside the displayed
      // bound stays stale afterwards. Serve this on-demand request once that
      // fence releases instead of silently dropping it, but only when the
      // pass left the path without fresh same-scope coverage; unknown entries
      // are explicit fail-closed coverage and fresh entries need no re-read.
      await this.canonicalSessionUsageRefresh;
      if (this.disposed || this.canonicalCacheFailClosed) return;
      const entry = this.canonicalSessionUsageByPath.get(sessionPath);
      if (entry && entry.snapshot.authority === 'canonical'
        && this.canonicalSessionUsageEntryMatchesScope(sessionPath, entry)
        && this.canonicalSessionUsageEntryIsFresh(entry)) return;
    }
    const epoch = this.canonicalCacheEpoch;
    const pathRefreshEpoch = (this.canonicalSessionPathEpochs.get(sessionPath) ?? 0) + 1;
    this.canonicalSessionPathEpochs.set(sessionPath, pathRefreshEpoch);
    try {
      const [usageRead, activityRead] = await Promise.allSettled([
        this.readCanonicalSessionPath(sessionPath),
        this.readCanonicalActivityScope(sessionPath),
      ]);
      const current = !this.disposed
        && (epoch === this.canonicalCacheEpoch || !this.canonicalCacheFailClosed)
        && this.canonicalSessionPathEpochs.get(sessionPath) === pathRefreshEpoch;
      if (usageRead.status === 'fulfilled' && current) {
        this.applyCanonicalSessionRead(sessionPath, usageRead.value, epoch);
      } else if (usageRead.status === 'rejected' && current) {
        this.cacheCanonicalRefreshFailure(sessionPath, epoch);
        appendPieLog('warn', 'analytics', 'canonical session usage read failed', {
          path: sessionPath,
          error: usageRead.reason instanceof Error ? usageRead.reason.message : String(usageRead.reason),
        });
      }
      if (activityRead.status === 'fulfilled' && current) {
        this.applyCanonicalActivityRead(sessionPath, activityRead.value, epoch);
      } else if (activityRead.status === 'rejected' && current) {
        appendPieLog('warn', 'analytics', 'canonical session activity projection refresh failed', {
          path: sessionPath,
          error: activityRead.reason instanceof Error ? activityRead.reason.message : String(activityRead.reason),
        });
      }
      // A lazily hydrated path restores its canonical busy wall-time union
      // once, alongside its first durable read (never re-read while this
      // process keeps observing live busy boundaries itself). It runs
      // detached from this refresh's read slot: the extra bounded query is
      // serialized by the read model's own concurrency cap and must not
      // extend the occupancy of a session-path refresh slot.
      if (current) void this.restoreCanonicalBusyUnionForPath(sessionPath);
    } finally {
      // Once this request has completed, its token is only needed while a
      // cache entry or a newer request still refers to the path. Reclaim it
      // for paths that remain uncached so a long-lived session catalogue
      // cannot grow this map without bound.
      if (!this.canonicalSessionUsageByPath.has(sessionPath)
        && !this.canonicalActivityByPath.has(sessionPath)
        && this.canonicalSessionPathEpochs.get(sessionPath) === pathRefreshEpoch) {
        this.canonicalSessionPathEpochs.delete(sessionPath);
      }
    }
  }

  /** Cold-restart working-time restoration under canonical authority.
   *
   * The legacy timeline is never consulted (it does not exist under canonical
   * capture) and no legacy run aggregate is used as a fallback: the durable
   * canonical busy spans are the only evidence. Each not-yet-restored path
   * gets one bounded root-scoped scalar union read over the busy span anchors;
   * the database computes the elapsed wall-time union and hands it to
   * WorkingTimeService as a replacement clock (never an additive measured sum,
   * and measured attribution stays unrestored). A truncated, unreadable, or identity-drifted
   * read keeps that session's clock explicitly unknown instead of restoring a
   * partial or wrong-root union. */
  private async restoreCanonicalWorkingTimeForPaths(sessionPaths: readonly string[]): Promise<void> {
    if (!this.canonicalCapture || !this.analyticsReadModel || this.disposed) return;
    const targets = sessionPaths.filter((sessionPath) => (
      !this.canonicalBusyRestoredRootByPath.has(sessionPath)
      && !this.canonicalPrivateClosesByPath.has(sessionPath)
    ));
    if (targets.length === 0) return;
    let nextIndex = 0;
    const workerCount = Math.min(targets.length, this.analyticsReadModel.getMaxConcurrentQueries());
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.disposed) return;
        const sessionPath = targets[nextIndex];
        nextIndex += 1;
        if (sessionPath === undefined) return;
        await this.restoreCanonicalBusyUnionForPath(sessionPath);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  /** One bounded canonical busy wall-time union restore for one path. Never
   * throws: an unavailable read is logged and the clock stays unknown. Only a
   * complete successful read gets the per-process marker; a transient failure
   * remains retryable on the next cold access without an automatic retry loop. */
  private async restoreCanonicalBusyUnionForPath(sessionPath: string): Promise<void> {
    if (this.disposed || this.canonicalBusyRestoredRootByPath.has(sessionPath)
      || this.canonicalPrivateClosesByPath.has(sessionPath)) return;
    const rootSessionId = this.canonicalRootSessionId(sessionPath);
    try {
      const read = await this.readCanonicalBusyWallUnion(rootSessionId);
      if (this.disposed || this.canonicalBusyRestoredRootByPath.has(sessionPath)) return;
      // Identity fence: a path rebound while the helper was in flight must not
      // adopt the previous root's busy clock.
      if (this.canonicalRootSessionId(sessionPath) !== rootSessionId) return;
      if (read === null) {
        // Do not latch an unavailable read as a successful attempt. The next
        // cold access gets one bounded retry; a transient helper/SQLite error
        // must not permanently erase known elapsed time.
        appendPieLog('warn', 'working-time', 'canonical busy wall-time restore unavailable; elapsed time stays unknown', {
          path: sessionPath,
        });
        return;
      }
      this.canonicalBusyRestoredRootByPath.set(sessionPath, rootSessionId);
      this.workingTime.restoreCanonicalBusyUnion(sessionPath, read.unionMs, {
        durableUnionExcludesLive: true,
      });
      this.scheduleRender();
    } catch (error) {
      // A failed read is deliberately not recorded in the success marker. The
      // caller's next cold access may retry without creating a refresh loop.
      appendPieLog('warn', 'working-time', 'canonical busy wall-time restore failed; elapsed time stays unknown', {
        path: sessionPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Read one root's durable busy spans as a full closed wall-time union.
   * SQLite performs the interval-island reduction and returns one bounded
   * scalar row, so valid data is never dropped merely because a root has more
   * than 2,000 spans. The running MAX of prior ends is intentional: LAG would
   * split a later interval incorrectly when an earlier nested interval keeps
   * an island open. Open spans are excluded as incomplete durable evidence;
   * they never become a live clock after restart. Only this
   * process's observed busy boundaries can create activeSince. */
  private async readCanonicalBusyWallUnion(
    rootSessionId: string,
  ): Promise<{ unionMs: number } | null> {
    const readModel = this.analyticsReadModel!;
    const result = await readModel.executeQuery({
      sql: `WITH ordered AS (
              SELECT CAST(started_at_ms AS INTEGER) AS started_at_ms,
                CAST(ended_at_ms AS INTEGER) AS ended_at_ms,
                generation_id, span_id,
                MAX(CAST(ended_at_ms AS INTEGER)) OVER (
                  ORDER BY CAST(started_at_ms AS INTEGER), CAST(ended_at_ms AS INTEGER), generation_id, span_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prior_max_ended_at_ms
              FROM analytics_activity_projection_members
              WHERE activity_kind = 'busy'
                AND ${activityProjectionSubjectFilter()}
                AND ended_at_ms IS NOT NULL
                AND CAST(started_at_ms AS INTEGER) BETWEEN 0 AND 9007199254740991
                AND CAST(ended_at_ms AS INTEGER) BETWEEN CAST(started_at_ms AS INTEGER) AND 9007199254740991
                AND CAST(ended_at_ms AS INTEGER) <= ?
            ), marked AS (
              SELECT *, CASE WHEN prior_max_ended_at_ms IS NULL
                OR started_at_ms > prior_max_ended_at_ms THEN 1 ELSE 0 END AS island_start
              FROM ordered
            ), grouped AS (
              SELECT *, SUM(island_start) OVER (
                ORDER BY started_at_ms, ended_at_ms, generation_id, span_id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS island_id
              FROM marked
            ), islands AS (
              SELECT island_id, MIN(started_at_ms) AS island_started_at_ms,
                MAX(ended_at_ms) AS island_ended_at_ms
              FROM grouped
              GROUP BY island_id
            )
            SELECT COALESCE(SUM(island_ended_at_ms - island_started_at_ms), 0) AS union_ms
            FROM islands`,
      // Keep the subject parameters first: the root/session and bound pending
      // subject filter remains the same privacy fence as every other activity
      // read. The final parameter is the process-boundary handoff fence.
      parameters: [rootSessionId, rootSessionId, this.processStartedAtMs],
      maxRows: 1,
      maxQueryBytes: 16 * 1024,
      maxResultBytes: 256 * 1024,
    });
    if (result.truncation.rowLimit || result.truncation.byteLimit || result.truncation.cellLimit) return null;
    if (result.returnedRows !== 1) return null;
    const unionMs = canonicalTimestampAnchor(result.rows[0]?.union_ms);
    return unionMs === null ? null : { unionMs };
  }

  /** Start the bounded cross-host refresh once canonical authority is active.
   *
   * Only another host's committed summary, correction or private close is
   * observable through the shared projection revision, so this reads that small
   * value at a bounded interval and hydrates before rendering on change. It
   * never scans history, never replays events and retains no per-history state.
   * Dormant under the legacy authority: there is no canonical revision to
   * follow yet. */
  private async startCanonicalRevisionRefresh(): Promise<string | null> {
    if (!this.analyticsReadModel) return null;
    if (this.analyticsRevisionRefresher) {
      if (this.canonicalRevisionStart) await this.canonicalRevisionStart;
      return this.analyticsRevisionRefresher.getStats().revision;
    }
    this.analyticsRevisionRefresher = new CanonicalRevisionRefresher({
      readModel: this.analyticsReadModel,
      onRevisionChange: (revision) => {
        // A normal peer revision is stale-while-revalidate: keep each path's
        // last complete same-scope snapshot visible until its replacement
        // read has returned. Explicit privacy/deletion/identity invalidations
        // still use markCanonicalRevisionDirty and fail closed immediately.
        this.markCanonicalRevisionForRefresh(revision);
      },
      onCheck: ({ revision }) => {
        if (revision === null || !this.canonicalRevisionAwaitingBaseline) return;
        this.canonicalRevisionAwaitingBaseline = false;
        // A recovered first baseline is intentionally a non-change from the
        // refresher's perspective, but it is a change from this host's
        // fail-closed state: hydrate before waking the renderer.
        if (!this.disposed && this.started) {
          this.markCanonicalRevisionDirty(revision);
        }
      },
      onError: (error) => {
        appendPieLog('warn', 'analytics', 'canonical analytics revision refresh could not read the revision', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const start = this.analyticsRevisionRefresher.start();
    const drain = start.then(() => undefined, (error: unknown) => {
      appendPieLog('warn', 'analytics', 'canonical analytics revision refresh failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.canonicalRevisionStart = drain;
    try {
      return await start;
    } catch {
      return null;
    } finally {
      void drain.finally(() => {
        if (this.canonicalRevisionStart === drain) this.canonicalRevisionStart = null;
      });
    }
  }

  /** Verify that startup hydration and its revision watermark describe the
   * same durable snapshot. A failed baseline is represented by null; the
   * independent watermark below still prevents a later first-successful
   * baseline from silently accepting an older cache. */
  private async reconcileCanonicalSessionUsageRevision(
    baselineRevision: string | null,
  ): Promise<void> {
    if (!this.analyticsReadModel || !this.canonicalCapture || this.disposed) return;
    let currentRevision: string;
    try {
      currentRevision = canonicalRevisionString(await this.analyticsReadModel.readRevision());
    } catch {
      // Never expose a complete canonical snapshot without a readable durable
      // watermark. The refresher will retry; the next explicit session read
      // can hydrate one bounded path once the store is available again.
      this.invalidateCanonicalSessionCache(false);
      return;
    }
    const projectionIsStale = (
      projection: CanonicalActivityProjectionSnapshot | CanonicalToolFacetProjectionSnapshot,
    ): boolean => projection.authority === 'canonical'
      && projection.projection !== null
      && canonicalRevision(projection.projection.projectionRevision) !== canonicalRevision(currentRevision);
    const activityEntries = [
      ...(this.canonicalGlobalActivity ? [this.canonicalGlobalActivity] : []),
      ...this.canonicalActivityByPath.values(),
    ];
    const stale = [...this.canonicalSessionUsageByPath.values()].some((entry) => (
      entry.snapshot.authority === 'canonical'
      && canonicalRevision(entry.revision) !== canonicalRevision(currentRevision)
    )) || activityEntries.some((entry) => (
      projectionIsStale(entry.activity) || projectionIsStale(entry.toolFacets)
    ));
    if (!stale) return;
    // Keep the baseline in the decision path for diagnostics and to make the
    // failed-baseline case explicit without treating null as a revision.
    if (baselineRevision !== null && canonicalRevision(currentRevision) < canonicalRevision(baselineRevision)) {
      this.invalidateCanonicalSessionCache(false);
      return;
    }
    // Revision drift alone is a same-root refresh, not an identity or privacy
    // transition. Keep the last complete read explicitly stale if the store is
    // still changing when this bounded pass returns.
    this.markCanonicalRevisionForRefresh(currentRevision);
    await this.refreshCanonicalSessionUsage();
  }

  /** Observable refresh counters for idle-resource measurement. */
  getAnalyticsRevisionRefreshStats(): ReturnType<CanonicalRevisionRefresher['getStats']> | undefined {
    return this.analyticsRevisionRefresher?.getStats();
  }

  async shutdown(): Promise<void> {
    if (this.canonicalCapture) {
      this.disposed = true;
      this.cancelCanonicalSessionUsageRetry();
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
      this.canonicalSessionUsageHeldByPath = null;
      this.canonicalCacheFailClosed = true;
      this.canonicalSessionPathEpochs.clear();
      this.canonicalSessionPathRefreshes.clear();
      this.canonicalPrivateClosesByPath.clear();
      this.canonicalBranchEntriesBySession.clear();
      this.canonicalBusyRestoredRootByPath.clear();
      this.canonicalRootSessionIdByPath.clear();
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
