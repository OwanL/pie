import { appendPieLog } from '../util/pie-log';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';
import type { RunSnapshot, TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';
import type {
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
import type { RunObserver, StatsServiceOptions } from './types';
import { resolveSessionIdentity } from '../../shared/session-identity';
import { defaultCreateId, defaultNow } from './helpers';
import { WorkingTimeService } from '../working-time-service';
import {
  BillableAccounting,
  type BillableAccountingDeps,
} from '../billable-accounting/service';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type { SessionUsageSnapshot } from '../../shared/session-usage';
import type {
  AnalyticsSessionContext,
  CanonicalAnalyticsCapture,
} from '../../analytics/canonical-capture.js';

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
    // Canonical capture has no legacy restore/import fallback. P5 must replace
    // legacy query consumers before P7 can select this authority.
    if (this.canonicalCapture) {
      this.started = true;
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

  private analyticsContext(sessionPath: string): AnalyticsSessionContext {
    const identity = this.sessionIdentity(sessionPath);
    return {
      sessionId: identity.sessionId,
      sessionPath,
      runId: this.currentRunId(sessionPath),
      operationId: this.activeOperationId(sessionPath),
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

  /** Enable/disable host-side privacy bookkeeping. Enabling immediately drops
   *  the current in-memory run and removes any already-written analytics for
   *  this session; the mode itself remains host-only. */
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

  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage = ''): string {
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return 'private-run';
    const runId = this.tracker.prepareForSend(sessionPath, inputs, initialUserMessage);
    this.canonicalCapture?.captureExecution(
      this.analyticsContext(sessionPath),
      runId,
      'begin',
      `execution:${runId}:begin`,
      this.now().getTime(),
      { operationId: this.activeOperationId(sessionPath) ?? undefined, runId, operationKind: 'agent-run', source: 'host' },
    );
    return runId;
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    this.accounting.observeAssistantTurnStarted(sessionPath);
    const context = this.analyticsContext(sessionPath);
    const executionId = context.runId ?? context.operationId ?? `turn:${turnId}`;
    this.canonicalCapture?.captureExecution(
      context,
      executionId,
      'phase',
      `turn:${turnId}:begin`,
      this.now().getTime(),
      { runId: context.runId ?? undefined, turnId, operationKind: 'assistant-turn', source: 'host' },
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    this.tracker.onAssistantTurnStarted(sessionPath, turnId);
  }

  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    this.accounting.observeSkillPruningUsage(sessionPath, messageId, occurredAt, details);
    const context = this.analyticsContext(sessionPath);
    this.canonicalCapture?.captureFeature(
      context,
      `pruning:${messageId}`,
      `pruning:${messageId}:observation`,
      Date.parse(occurredAt),
      { feature: 'pruning', decision: 'provider-settled', ruleVersion: 'legacy-adapter-v1' },
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
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
    billing?: { modelId?: string; provider?: string; occurredAt?: string; operationId?: string },
  ): void {
    this.accounting.observeAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, billing);
    const context = this.analyticsContext(sessionPath);
    const executionId = context.runId ?? context.operationId ?? `turn:${turnId}`;
    this.canonicalCapture?.captureExecution(
      context,
      executionId,
      'phase',
      `turn:${turnId}:end`,
      billing?.occurredAt ? Date.parse(billing.occurredAt) : this.now().getTime(),
      {
        runId: context.runId ?? undefined,
        turnId,
        operationKind: 'assistant-turn',
        source: 'host',
        endedAtMs: billing?.occurredAt ? Date.parse(billing.occurredAt) : this.now().getTime(),
        outcome: status ?? 'unknown',
      },
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
    this.tracker.onAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, latency);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onSessionUsageSnapshot(
    sessionPath: string,
    sessionId: string | undefined,
    snapshot: SessionUsageSnapshot,
  ): void {
    this.accounting.observeSessionUsageSnapshot(sessionPath, sessionId, snapshot);
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
    this.accounting.observeSubagentToolResult(sessionPath, toolCall);
    this.canonicalCapture?.captureTool(
      this.analyticsContext(sessionPath),
      toolCall,
      'end',
      `tool:${toolCall.id}:end`,
      toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
        ? toolCall.startedAt + toolCall.durationMs : this.now().getTime(),
    );
    if (this.isPrivateSession(sessionPath) && !this.canonicalCapture) return;
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
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onInterrupted(sessionPath);
  }

  onCompaction(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onCompaction(sessionPath);
  }

  onAuxiliaryLlmUsage(
    sessionPath: string,
    sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>,
  ): void {
    const observed = this.accounting.observeAuxiliaryLlmUsage(sessionPath, sample);
    if (this.isPrivateSession(sessionPath)) return;
    if (observed.channelsKnown) {
      this.tracker.onAuxiliaryLlmUsage(sessionPath, observed.sample);
    }
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetry(
    sessionPath: string,
    timing?: { sourceId: string; occurredAt: string; attempt: number; scheduledDelayMs: number },
  ): void {
    this.accounting.observeAutoRetry(sessionPath, timing);
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAutoRetry(sessionPath, timing);
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onAutoRetryMeasured(
    sessionPath: string,
    sourceId: string,
    measuredDelayMs: number | undefined,
    durationMs: number,
  ): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAutoRetryMeasured(sessionPath, sourceId, measuredDelayMs, durationMs);
    const endedAtMs = this.now().getTime();
    const elapsed = Math.max(0, measuredDelayMs ?? durationMs);
    const interval: ActivityIntervalRecord = {
      schemaVersion: 1,
      intervalId: `activity:retry-wait:${this.currentRunId(sessionPath) ?? sessionPath}:${sourceId}`,
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
    if (this.canonicalCapture) this.canonicalCapture.captureActivity(this.analyticsContext(sessionPath), interval);
    else {
      this.accounting.activityTimeline.record(interval);
      this.storage.markDerivedExportDirty();
    }
    this.syncWorkingTimeBreakdown(sessionPath);
  }

  onMessageEdited(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onMessageEdited(sessionPath);
  }

  onTruncatedAfter(sessionPath: string, _messageId: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onTruncatedAfter(sessionPath);
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    if (!sessionPath || this.isPrivateSession(sessionPath)) return;
    this.tracker.onBackendError(sessionPath, code);
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onContextUsageChanged(sessionPath, tokens, limit);
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    this.workingTime.onBusyChanged(sessionPath, busy);
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onBusyChanged(sessionPath, busy);
    const nowIso = this.now().toISOString();
    if (busy && (this.activeBusyIntervalsBySession[sessionPath]?.size ?? 0) === 0) {
      const runId = this.currentRunId(sessionPath);
      const operationId = this.activeOperationId(sessionPath);
      const intervalId = `activity:busy:${operationId ?? runId ?? `${sessionPath}:${nowIso}`}`;
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
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onUnsupportedInputAttempt(sessionPath);
  }

  onSessionClosed(sessionPath: string): void {
    if (this.canonicalCapture) {
      // Session-close retention/deletion is deliberately not inferred here.
      // P2b resolves the durable close disposition before invoking recorder
      // deletion; this observer only releases producer-local correlation.
      this.tracker.onSessionClosed(sessionPath);
      this.accounting.onSessionClosed(sessionPath);
      const intervals = this.activeBusyIntervalsBySession[sessionPath];
      for (const intervalId of intervals ?? []) delete this.activeBusyStartedAtByInterval[intervalId];
      delete this.activeBusyIntervalsBySession[sessionPath];
      for (const key of Object.keys(this.activeToolIntervalBySessionAndTool)) {
        if (key.startsWith(`${sessionPath}\0`)) delete this.activeToolIntervalBySessionAndTool[key];
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

  replaceSessionPath(oldPath: string, newPath: string, stableSessionId?: string): void {
    this.workingTime.replaceSessionPath(oldPath, newPath);
    this.tracker.replaceSessionPath(oldPath, newPath, stableSessionId);
    this.accounting.replaceSessionPath(oldPath, newPath);
  }

  startNewTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.startNewTask(sessionPath);
  }

  continueTask(sessionPath: string): void {
    if (this.isPrivateSession(sessionPath)) return;
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
    if (this.canonicalCapture) throw new Error('Canonical analytics read model is not wired; P5 activation fence remains closed.');
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryRunAnalytics());
  }

  /** The resolved run-analytics storage directory (see {@link RunAnalyticsStorage.getStorageDir}). */
  getStorageDir(): string {
    return this.storage.getStorageDir();
  }

  /** Host-owned cumulative agent working-time clocks for renderer projection. */
  getWorkingTimeBySession(): Record<string, WorkingTimeState> {
    return this.workingTime.getStates();
  }

  /** Ledger-backed session usage projection for UI and fixture conservation checks. */
  getSessionUsage(sessionPath: string): SessionUsageSnapshot {
    return this.accounting.projectSessionUsage(sessionPath);
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
    return this.tracker.getOpenRuns().filter((run) => !this.isPrivateSession(run.sessionPath));
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
    if (this.canonicalCapture) throw new Error('Canonical analytics read model is not wired; P5 activation fence remains closed.');
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

  async shutdown(): Promise<void> {
    if (this.canonicalCapture) {
      this.disposed = true;
      this.backgroundCompactionAbort.abort();
      return;
    }
    // Terminal: block start reactivation immediately, then drain the tracked
    // background promise (defer, healing, migration) — healing stops at its
    // next bounded batch and the in-flight migration at its next run
    // boundary instead of waiting out a large legacy catalogue. Unmigrated
    // runs resume on the next startup.
    this.disposed = true;
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