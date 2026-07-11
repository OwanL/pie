import { defaultCreateId, defaultNow } from './helpers';
import { appendPieLog } from '../util/pie-log';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';
import type { TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';
import type {
  AssistantUsage,
  ComposerInput,
  RunOutcome,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import { RunAnalyticsStorage } from './storage';
import { SessionRunTracker } from './tracker';
import type { RunObserver, StatsServiceOptions } from './types';

export class StatsService implements RunObserver {
  private readonly scheduleRender: () => void;
  private readonly tracker: SessionRunTracker;
  private readonly storage: RunAnalyticsStorage;
  private startPromise: Promise<void> | null = null;
  private started = false;

  constructor(options: StatsServiceOptions) {
    this.scheduleRender = options.scheduleRender ?? (() => undefined);
    const dispatchArchEvent = options.dispatchArchEvent ?? ((_event) => { /* no-op if not provided */ });
    const getArchState = options.getArchState ?? (() => { throw new Error('getArchState not provided'); });
    const now = options.now ?? defaultNow;
    const createId = options.createId ?? defaultCreateId;
    const getExperimentAssignment = options.getExperimentAssignment ?? (() => null);

    const trackerRef: { current: SessionRunTracker | null } = { current: null };
    this.storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: options.dataOutcomesRootPath,
      legacyUsageDataRootPath: options.legacyUsageDataRootPath,
      workspaceId: options.workspaceId,
      legacyWorkspaceIds: options.legacyWorkspaceIds,
      now,
      serializeSessions: () => trackerRef.current?.serializeSessions() ?? {},
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
    const tracker = new SessionRunTracker({
      getArchState,
      dispatchArchEvent,
      scheduleRender: this.scheduleRender,
      schedulePersist: (snapshotToAppend, outcomeToAppend) => (
        this.storage.schedulePersist(snapshotToAppend, outcomeToAppend)
      ),
      schedulePersistAgentReview: (entry) => this.storage.schedulePersistAgentReview(entry),
      now,
      createId,
      getExperimentAssignment,
    });
    trackerRef.current = tracker;
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
      this.started = true;
      this.scheduleRender();
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  prepareForSend(sessionPath: string, inputs: ComposerInput[]): string {
    return this.tracker.prepareForSend(sessionPath, inputs);
  }

  onAssistantTurnStarted(sessionPath: string, turnId: string): void {
    this.tracker.onAssistantTurnStarted(sessionPath, turnId);
  }

  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void {
    this.tracker.onSkillPruningUsage(sessionPath, messageId, occurredAt, details);
  }

  onAssistantTurnEnded(
    sessionPath: string,
    turnId: string,
    durationMs: number,
    usage?: AssistantUsage,
    status?: TurnThroughputStatus,
    latency?: TurnLatencyMeasurement,
  ): void {
    this.tracker.onAssistantTurnEnded(sessionPath, turnId, durationMs, usage, status, latency);
  }

  onToolStarted(sessionPath: string, toolCall: ToolCall): void {
    this.tracker.onToolStarted(sessionPath, toolCall);
  }

  onToolFinished(sessionPath: string, toolCall: ToolCall): void {
    this.tracker.onToolFinished(sessionPath, toolCall);
  }

  onInterrupted(sessionPath: string): void {
    this.tracker.onInterrupted(sessionPath);
  }

  onCompaction(sessionPath: string): void {
    this.tracker.onCompaction(sessionPath);
  }

  onAutoRetry(sessionPath: string): void {
    this.tracker.onAutoRetry(sessionPath);
  }

  onMessageEdited(sessionPath: string, _messageId: string): void {
    this.tracker.onMessageEdited(sessionPath);
  }

  onTruncatedAfter(sessionPath: string, _messageId: string): void {
    this.tracker.onTruncatedAfter(sessionPath);
  }

  onBackendError(sessionPath: string | undefined, code: string): void {
    this.tracker.onBackendError(sessionPath, code);
  }

  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void {
    this.tracker.onContextUsageChanged(sessionPath, tokens, limit);
  }

  onBusyChanged(sessionPath: string, busy: boolean): void {
    this.tracker.onBusyChanged(sessionPath, busy);
  }

  onModelConfigChanged(
    sessionPath: string,
    modelId: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
  ): void {
    this.tracker.onModelConfigChanged(sessionPath, modelId, thinkingLevel);
  }

  onUnsupportedInputAttempt(sessionPath: string): void {
    this.tracker.onUnsupportedInputAttempt(sessionPath);
  }

  onSessionClosed(sessionPath: string): void {
    this.tracker.onSessionClosed(sessionPath);
  }

  replaceSessionPath(oldPath: string, newPath: string): void {
    this.tracker.replaceSessionPath(oldPath, newPath);
  }

  recordOutcome(sessionPath: string, outcome: RunOutcome): void {
    this.tracker.recordOutcome(sessionPath, outcome);
  }

  recordAgentReview(
    sessionPath: string,
    review: {
      done: boolean;
      rating: number;
      completion: 'fully' | 'partial' | 'setback';
      reason: string;
      evaluatedAt: string;
      reviewerBuckets: string[];
      reviewerCount: number;
    },
  ): void {
    this.tracker.recordAgentReview(sessionPath, review);
  }

  startNewTask(sessionPath: string): void {
    this.tracker.startNewTask(sessionPath);
  }

  continueTask(sessionPath: string): void {
    this.tracker.continueTask(sessionPath);
  }

  onExperimentAssignmentChanged(assignment: string | null): void {
    this.tracker.onExperimentAssignmentChanged(assignment);
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.start();
    return await this.storage.queryRunAnalytics();
  }

  /** The resolved run-analytics storage directory (see {@link RunAnalyticsStorage.getStorageDir}). */
  getStorageDir(): string {
    return this.storage.getStorageDir();
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    await this.start();
    return await this.storage.exportRunAnalytics(targetPath);
  }

  async flush(): Promise<void> {
    await this.storage.flush();
  }

  async shutdown(): Promise<void> {
    this.tracker.finalizeOpenRunsForShutdown();
    await this.flush();
  }
}
