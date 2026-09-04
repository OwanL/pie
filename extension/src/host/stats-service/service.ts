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
import { resolveSessionIdentity } from '../../backend/session-review-store';
import { defaultCreateId, defaultNow } from './helpers';
import { WorkingTimeService } from '../working-time-service';
import { BillableAccounting, type BillableAccountingDeps } from '../billable-accounting/service';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type { SessionUsageSnapshot } from '../../shared/session-usage';

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
  private readonly activeToolIntervalBySessionAndTool: Record<string, string | undefined> = {};
  private readonly now: () => Date;
  private readonly createId: () => string;
  private startPromise: Promise<void> | null = null;
  private started = false;

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
    };
    accountingRef = new BillableAccounting(accountingDeps);
    this.accounting = accountingRef;
    const tracker = new SessionRunTracker({
      getArchState,
      dispatchArchEvent,
      scheduleRender: this.scheduleRender,
      schedulePersist: (snapshotToAppend) => this.storage.schedulePersist(snapshotToAppend),
      now,
      createId,
      getExperimentAssignment,
    });
    this.tracker = tracker;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = (async () => {
      const checkpoint = await this.storage.start();
      this.tracker.restore(checkpoint?.sessions ?? {});
      const openBusyIntervals = this.tracker.getOpenBusyIntervals()
        .filter((interval) => !this.isPrivateSession(interval.sessionPath));
      let persistedRuns: RunSnapshot[] = [];
      try {
        const persisted = await this.storage.queryPersistedRunAnalytics();
        persistedRuns = [...persisted.completedRuns, ...persisted.openRuns]
          .filter((run) => !this.isPrivateSession(run.sessionPath));
      } catch (error) {
        appendPieLog('warn', 'working-time', 'could not restore historical session working time', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.accounting.healActivityFromLedger();
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
      this.accounting.migrateHistoricalRunUsage(persistedRuns);
      this.started = true;
      this.scheduleRender();
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
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
    if (this.isPrivateSession(sessionPath)) return 'private-run';
    return this.tracker.prepareForSend(sessionPath, inputs, initialUserMessage);
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    this.accounting.observeAssistantTurnStarted(sessionPath);
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onAssistantTurnStarted(sessionPath, turnId);
  }

  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    this.accounting.observeSkillPruningUsage(sessionPath, messageId, occurredAt, details);
    if (this.isPrivateSession(sessionPath)) return;
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
    if (this.isPrivateSession(sessionPath)) return;
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
    if (this.isPrivateSession(sessionPath)) return;
    this.tracker.onToolStarted(sessionPath, toolCall);
    this.workingTime.onToolStarted(sessionPath, toolCall);
    const runId = this.currentRunId(sessionPath);
    const intervalId = `activity:tool:${runId ?? sessionPath}:${toolCall.id}`;
    this.activeToolIntervalBySessionAndTool[this.toolIntervalKey(sessionPath, toolCall.id)] = intervalId;
    const startedAt = new Date(toolCall.startedAt ?? this.now().getTime()).toISOString();
    this.accounting.activityTimeline.start({
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
    });
    this.storage.markDerivedExportDirty();
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    this.accounting.observeSubagentToolResult(sessionPath, toolCall);
    if (this.isPrivateSession(sessionPath)) return;
    // Close the live wall-time interval before durable telemetry catches up;
    // the service reconciles the two sources without double-counting.
    this.workingTime.onToolFinished(sessionPath, toolCall);
    const toolKey = this.toolIntervalKey(sessionPath, toolCall.id);
    const intervalId = this.activeToolIntervalBySessionAndTool[toolKey];
    if (intervalId) {
      this.accounting.activityTimeline.settle(
        intervalId,
        new Date(toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
          ? toolCall.startedAt + toolCall.durationMs : this.now().getTime()).toISOString(),
        toolCall.status === 'failed' ? 'failed' : 'succeeded',
      );
      delete this.activeToolIntervalBySessionAndTool[toolKey];
      this.storage.markDerivedExportDirty();
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
    this.accounting.activityTimeline.record({
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
    });
    this.storage.markDerivedExportDirty();
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
      this.accounting.activityTimeline.start({
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
      });
    } else if (!busy) {
      const intervalIds = this.activeBusyIntervalsBySession[sessionPath];
      for (const intervalId of intervalIds ?? []) {
        this.accounting.activityTimeline.settle(intervalId, nowIso, 'succeeded');
      }
      delete this.activeBusyIntervalsBySession[sessionPath];
    }
    this.storage.markDerivedExportDirty();
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
    await this.start();
    return this.filterPrivateAnalytics(await this.storage.queryPersistedRunAnalytics());
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
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
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.flush();
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
  }

  async shutdown(): Promise<void> {
    this.tracker.finalizeOpenRunsForShutdown();
    this.accounting.retryPendingWrites();
    this.accounting.activityTimeline.flush();
    await this.storage.dispose();
  }
}