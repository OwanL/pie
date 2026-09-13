import type {
  AgentSettledPayload,
  AssistantUsage,
  AuxiliaryLlmUsagePayload,
  ComposerInput,
  SessionUsageSnapshot,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import type { LiveLifecycleWatermark } from '../../shared/live-pipeline-protocol.js';
import type { CanonicalAnalyticsCapture } from '../../analytics/canonical-capture.js';
import type { CanonicalAnalyticsReadModel } from '../../analytics/query-entry.js';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';
import type { BillableInvocationRecord } from '../../shared/billable-invocation';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';
import type { TaskBoundaryIntent, RunSnapshot, TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../run-analytics/query';

export type DispatchArchEvent = (event: Event) => void;
export type GetArchState = () => ArchState;

export interface SessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  turnIdsSeenInCurrentRun: Set<string>;
  /** Turn IDs whose `onAssistantTurnEnded` has already been processed — guards against duplicate `message.finished` events double-counting duration / tokens / throughput samples. */
  endedTurnIdsInCurrentRun: Set<string>;
  /** Tool call IDs whose `onToolStarted` has already been processed — guards against duplicate `tool.started` events double-counting usage. */
  startedToolCallIdsInCurrentRun: Set<string>;
  /** Tool call IDs whose `onToolFinished` has already been processed — guards against duplicate `tool.finished` events double-counting durations, failures, and file mutations. */
  finishedToolCallIdsInCurrentRun: Set<string>;
  /** Start-time attribution by call id, used to reconcile a name first learned at terminal time. */
  toolNamesByCallIdInCurrentRun: Map<string, string>;
  /** Merged, non-overlapping wall-clock tool intervals for critical-path union. */
  toolExecutionIntervalsInCurrentRun: Array<{ startedAt: number; endedAt: number }>;
  busyStartedAt: string | null;
}

export interface RunObserver {
  /** Optional null is an explicit identity miss: callers that have a
   * protocol-owned turn must not fall back to an unrelated active operation.
   * Omission retains the legacy adapter behavior for older direct callers. */
  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage?: string, operationId?: string | null): string;
  onAssistantTurnStarted(sessionPath: string, turnId: string, identity?: AssistantTurnIdentity): void;
  onSkillPruningUsage(
    sessionPath: string,
    messageId: string,
    occurredAt: string,
    details: unknown,
  ): void;
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
  ): void;
  onAssistantTerminalWatermark?(watermark: LiveLifecycleWatermark, operationId?: string | null): void;
  /** Authoritative backend execution settlement. Registry mutation commits
   * (including message-start acknowledgement) do not close this boundary. */
  onAgentSettled?(payload: AgentSettledPayload): void;
  /** Transcript-derived usage is migration/rebuild input only. */
  onSessionUsageSnapshot(
    sessionPath: string,
    sessionId: string | undefined,
    snapshot: SessionUsageSnapshot,
    selectionId?: string,
    selectionObservedAt?: number,
  ): void;
  onBranchObserved?(
    sessionPath: string,
    entryId: string,
    parentEntryId: string | null | undefined,
    selectedEntryId: string,
    observedAt: number,
  ): void;
  onSessionDuplicated?(input: {
    destinationPath: string;
    destinationSessionId: string;
    sourcePath: string;
    sourceSessionId: string;
    sourceBranchId?: string;
    operationId: string;
    observedAt: number;
  }): void;
  onToolStarted(sessionPath: string, toolCall: ToolCall): void;
  onToolFinished(sessionPath: string, toolCall: ToolCall): void;
  onInterrupted(sessionPath: string): void;
  onCompaction(sessionPath: string): void;
  onAuxiliaryLlmUsage(sessionPath: string, sample: Omit<AuxiliaryLlmUsagePayload, 'sessionPath'>): void;
  onAutoRetry(
    sessionPath: string,
    timing?: { sourceId: string; occurredAt: string; attempt: number; scheduledDelayMs: number },
  ): void;
  onAutoRetryMeasured(
    sessionPath: string,
    sourceId: string,
    measuredDelayMs: number | undefined,
    durationMs: number,
    evidence?: Pick<import('../../shared/protocol').RetryMeasuredPayload, 'operationId' | 'startedAt' | 'providerAttemptStartedAt' | 'endedAt' | 'durationClockDomain'>,
  ): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onBackendError(sessionPath: string | undefined, code: string): void;
  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number,
    evidence?: Omit<import('../../shared/protocol').ContextUsageChangedPayload, 'sessionPath' | 'contextUsage'>): void;
  onBusyChanged(sessionPath: string, busy: boolean): void;
  onModelConfigChanged(sessionPath: string, modelId: string | undefined, thinkingLevel: ThinkingLevel | undefined, provider?: string): void;
  onUnsupportedInputAttempt(sessionPath: string): void;
  onSessionClosed(sessionPath: string): void;
  /** Persist reversible privacy behavior while the session remains open. */
  setSessionPrivacy?(sessionPath: string, enabled: boolean): Promise<void>;
  /** Commit the close-only canonical deletion barrier for a private session.
   * The optional ID is the create/duplicate operation that owned the pending
   * analytics subject; it is never the close cleanup operation. */
  closePrivateSessionAnalytics?(
    sessionPath: string,
    pendingCreateOperationId?: string,
    stableRootSessionId?: string,
  ): Promise<void>;
  replaceSessionPath(
    oldPath: string,
    newPath: string,
    stableSessionId?: string,
    pendingCreateOperationId?: string,
  ): void;
}

/**
 * Host-facing StatsService surface.  SessionService only needs RunObserver;
 * this wider port is kept structural so a rehearsal can use a filesystem-free
 * implementation without inheriting the concrete storage/accounting state.
 */
export interface StatsServicePort extends RunObserver {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  flush(): Promise<void>;
  onExperimentAssignmentChanged(assignment: string | null): void;
  startNewTask(sessionPath: string): void;
  continueTask(sessionPath: string): void;
  queryRunAnalytics(): Promise<RunAnalyticsQueryResult>;
  queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult>;
  exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload>;
  getStorageDir(): string;
  getAnalyticsReadModel?(): CanonicalAnalyticsReadModel | undefined;
  getAnalyticsRevisionRefreshStats?(): { revision: string | null } | undefined;
  getWorkingTimeBySession(): Record<string, import('../../shared/protocol').WorkingTimeState>;
  getSessionUsage(sessionPath: string): SessionUsageSnapshot;
  getActivityIntervals(): readonly ActivityIntervalRecord[];
  getBillableInvocationRecords(): readonly BillableInvocationRecord[];
  getOpenRuns(): RunSnapshot[];
  getPendingCompletedRuns(): RunSnapshot[];
}

export interface AssistantTurnIdentity {
  operationId?: string | null;
  requestId?: string;
  attemptId?: string;
  operationAttempt?: number;
}

export const NOOP_RUN_OBSERVER: RunObserver = {
  prepareForSend: () => 'noop-run',
  onAssistantTurnStarted: () => undefined,
  onSkillPruningUsage: () => undefined,
  onAssistantTurnEnded: () => undefined,
  onAssistantTerminalWatermark: () => undefined,
  onAgentSettled: () => undefined,
  onSessionUsageSnapshot: () => undefined,
  onBranchObserved: () => undefined,
  onSessionDuplicated: () => undefined,
  onToolStarted: () => undefined,
  onToolFinished: () => undefined,
  onInterrupted: () => undefined,
  onCompaction: () => undefined,
  onAuxiliaryLlmUsage: () => undefined,
  onAutoRetry: () => undefined,
  onAutoRetryMeasured: () => undefined,
  onMessageEdited: () => undefined,
  onTruncatedAfter: () => undefined,
  onBackendError: () => undefined,
  onContextUsageChanged: () => undefined,
  onBusyChanged: () => undefined,
  onModelConfigChanged: () => undefined,
  onUnsupportedInputAttempt: () => undefined,
  onSessionClosed: () => undefined,
  setSessionPrivacy: async () => undefined,
  closePrivateSessionAnalytics: async () => undefined,
  replaceSessionPath: () => undefined,
};

export interface StatsServiceOptions {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: string[];
  scheduleRender?: () => void;
  getArchState?: GetArchState;
  dispatchArchEvent?: DispatchArchEvent;
  now?: () => Date;
  createId?: () => string;
  getExperimentAssignment?: () => string | null;
  /** Resolve the catalog directory containing models.json for immutable pricing snapshots. */
  getAgentDir?: () => string | null;
  /** Disabled/legacy by default. A canonical authority is injected only after
   * P0/P2b/P5 activation prerequisites are independently accepted. */
  analyticsCapture?: CanonicalAnalyticsCapture;
  /** P5 durable canonical read model. Path-only until a consumer queries it;
   * consumers must gate on canonical authority until the P7a cutover. */
  analyticsReadModel?: CanonicalAnalyticsReadModel;
}

export function emptySessionRunState(): SessionRunState {
  return {
    currentRun: null,
    lastRun: null,
    nextTaskIntent: null,
    queuedUnsupportedInputCount: 0,
    turnIdsSeenInCurrentRun: new Set<string>(),
    endedTurnIdsInCurrentRun: new Set<string>(),
    startedToolCallIdsInCurrentRun: new Set<string>(),
    finishedToolCallIdsInCurrentRun: new Set<string>(),
    toolNamesByCallIdInCurrentRun: new Map<string, string>(),
    toolExecutionIntervalsInCurrentRun: [],
    busyStartedAt: null,
  };
}
