import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type { BillableInvocationRecord } from '../../shared/billable-invocation';
import type { SessionUsageSnapshot, WorkingTimeState } from '../../shared/protocol';
import type { CanonicalAnalyticsReadModel } from '../../analytics/query-entry.js';
import type { RunSnapshot } from '../run-analytics';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';
import {
  NOOP_RUN_OBSERVER,
  type StatsServicePort,
} from './types';

/**
 * Process-local rehearsal implementation.  Keeping this as a separate port
 * implementation is intentional: constructing the normal StatsService also
 * constructs storage, accounting, and working-time owners before start().
 */
export class DisabledStatsService implements StatsServicePort {
  readonly prepareForSend = NOOP_RUN_OBSERVER.prepareForSend;
  readonly onAssistantTurnStarted = NOOP_RUN_OBSERVER.onAssistantTurnStarted;
  readonly onSkillPruningUsage = NOOP_RUN_OBSERVER.onSkillPruningUsage;
  readonly onAssistantTurnEnded = NOOP_RUN_OBSERVER.onAssistantTurnEnded;
  readonly onAssistantTerminalWatermark = NOOP_RUN_OBSERVER.onAssistantTerminalWatermark;
  readonly onAgentSettled = NOOP_RUN_OBSERVER.onAgentSettled;
  readonly onSessionUsageSnapshot = NOOP_RUN_OBSERVER.onSessionUsageSnapshot;
  readonly onBranchObserved = NOOP_RUN_OBSERVER.onBranchObserved;
  readonly onSessionDuplicated = NOOP_RUN_OBSERVER.onSessionDuplicated;
  readonly onToolStarted = NOOP_RUN_OBSERVER.onToolStarted;
  readonly onToolFinished = NOOP_RUN_OBSERVER.onToolFinished;
  readonly onInterrupted = NOOP_RUN_OBSERVER.onInterrupted;
  readonly onCompaction = NOOP_RUN_OBSERVER.onCompaction;
  readonly onAuxiliaryLlmUsage = NOOP_RUN_OBSERVER.onAuxiliaryLlmUsage;
  readonly onAutoRetry = NOOP_RUN_OBSERVER.onAutoRetry;
  readonly onAutoRetryMeasured = NOOP_RUN_OBSERVER.onAutoRetryMeasured;
  readonly onMessageEdited = NOOP_RUN_OBSERVER.onMessageEdited;
  readonly onTruncatedAfter = NOOP_RUN_OBSERVER.onTruncatedAfter;
  readonly onBackendError = NOOP_RUN_OBSERVER.onBackendError;
  readonly onContextUsageChanged = NOOP_RUN_OBSERVER.onContextUsageChanged;
  readonly onBusyChanged = NOOP_RUN_OBSERVER.onBusyChanged;
  readonly onModelConfigChanged = NOOP_RUN_OBSERVER.onModelConfigChanged;
  readonly onUnsupportedInputAttempt = NOOP_RUN_OBSERVER.onUnsupportedInputAttempt;
  readonly onSessionClosed = NOOP_RUN_OBSERVER.onSessionClosed;
  readonly setSessionPrivacy = NOOP_RUN_OBSERVER.setSessionPrivacy;
  readonly closePrivateSessionAnalytics = NOOP_RUN_OBSERVER.closePrivateSessionAnalytics;
  readonly replaceSessionPath = NOOP_RUN_OBSERVER.replaceSessionPath;

  async start(): Promise<void> { /* no analytics state exists in this mode */ }

  async shutdown(): Promise<void> { /* no analytics state exists in this mode */ }

  async flush(): Promise<void> { /* no analytics state exists in this mode */ }

  onExperimentAssignmentChanged(_assignment: string | null): void { /* intentionally ignored */ }

  startNewTask(_sessionPath: string): void { /* intentionally ignored */ }

  continueTask(_sessionPath: string): void { /* intentionally ignored */ }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    return { completedRuns: [], openRuns: [] };
  }

  async queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    return { completedRuns: [], openRuns: [] };
  }

  async exportRunAnalytics(_targetPath: string): Promise<RunAnalyticsExportPayload> {
    throw new Error('Run analytics export is unavailable while total analytics are disabled.');
  }

  getStorageDir(): string {
    throw new Error('Analytics storage is unavailable while total analytics are disabled.');
  }

  getAnalyticsReadModel(): CanonicalAnalyticsReadModel | undefined {
    return undefined;
  }

  getAnalyticsRevisionRefreshStats(): undefined {
    return undefined;
  }

  getWorkingTimeBySession(): Record<string, WorkingTimeState> {
    return {};
  }

  getSessionUsage(_sessionPath: string): SessionUsageSnapshot {
    return { samples: [], authority: 'unknown' };
  }

  getActivityIntervals(): readonly ActivityIntervalRecord[] {
    return [];
  }

  getBillableInvocationRecords(): readonly BillableInvocationRecord[] {
    return [];
  }

  getOpenRuns(): RunSnapshot[] {
    return [];
  }

  getPendingCompletedRuns(): RunSnapshot[] {
    return [];
  }
}
