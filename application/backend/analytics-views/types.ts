import type {
  AgentSettledPayload,
  AssistantUsage,
  AuxiliaryLlmUsagePayload,
  ComposerInput,
  SessionUsageSnapshot,
  ThinkingLevel,
  ToolCall,
} from '../../lib/protocol/index.js';
import type { LiveLifecycleWatermark } from '../../lib/protocol/live-pipeline.js';
import type { CanonicalAnalyticsCapture } from '../../../analytics/capture/canonical-capture.js';
import type { CanonicalAnalyticsReadModel } from '../../../analytics/queries/query-entry.js';
import type { ActivityProjectionReadModel } from '../../../analytics/projections/activity-projection.js';
import type { ToolFacetProjectionReadModel } from '../../../analytics/projections/tool-facet.js';
import type { AnalyticsQuerySnapshotMetadata } from '../../../analytics/recording/sqlite-recorder.js';
import type { ActivityIntervalRecord } from '../../../analytics/contracts/activity-interval';
import type { BillableInvocationRecord } from '../../../analytics/usage-accounting/billable-invocation';
import type { ArchState } from '../conversation-state/arch-state';
import type { Event } from '../conversation-state/events';
import type {
  RunSnapshot,
  TurnLatencyMeasurement,
  TurnThroughputStatus,
} from '../../../analytics/legacy/run-analytics/types.js';
import type { RunAnalyticsExportPayload, RunAnalyticsQueryResult } from '../../../analytics/legacy/run-analytics/query';

export type DispatchArchEvent = (event: Event) => void;
export type GetArchState = () => ArchState;
export type { SessionRunState } from '../../../analytics/legacy/stats-service/session-run-state.js';
export { emptySessionRunState } from '../../../analytics/legacy/stats-service/session-run-state.js';

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
  /** A session.opened publication supplies the authoritative root identity and
   * gives canonical cold-session hydration a post-reducer lifecycle boundary. */
  onSessionOpened?(sessionPath: string, sessionId?: string): void;
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
    evidence?: Pick<import('../../lib/protocol/index.js').RetryMeasuredPayload, 'operationId' | 'startedAt' | 'providerAttemptStartedAt' | 'endedAt' | 'durationClockDomain'>,
  ): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onBackendError(sessionPath: string | undefined, code: string): void;
  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number,
    evidence?: Omit<import('../../lib/protocol/index.js').ContextUsageChangedPayload, 'sessionPath' | 'contextUsage'>): void;
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
 * this wider port is kept structural so an implementation does not inherit the
 * concrete storage/accounting state.
 */
export type CanonicalActivityProjection = ActivityProjectionReadModel & AnalyticsQuerySnapshotMetadata;
export type CanonicalToolFacetProjection = ToolFacetProjectionReadModel & AnalyticsQuerySnapshotMetadata;
export type CanonicalProjectionScope = ActivityProjectionReadModel['scope'];

/** One bounded canonical activity read for a global or root-session scope.
 * `projection` is null only when the read is unavailable; a successful read
 * retains its own truncation and unknown-count metadata. */
export interface CanonicalActivityProjectionSnapshot {
  authority: 'canonical' | 'unknown';
  scope: CanonicalProjectionScope;
  projection: CanonicalActivityProjection | null;
}

/** One bounded canonical tool/file facet read for a global or root-session
 * scope. Facet rows are evidence/proxies as classified by the projection; they
 * are not verified worktree changes or a process census. */
export interface CanonicalToolFacetProjectionSnapshot {
  authority: 'canonical' | 'unknown';
  scope: CanonicalProjectionScope;
  projection: CanonicalToolFacetProjection | null;
}

/** Canonical activity surfaces consumed by host statistics. The two reads are
 * independently qualified because activity summaries and facet rows have
 * different coverage and truncation semantics. */
export interface CanonicalActivityStats {
  activity: CanonicalActivityProjectionSnapshot;
  toolFacets: CanonicalToolFacetProjectionSnapshot;
}

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
  getWorkingTimeBySession(): Record<string, import('../../lib/protocol/index.js').WorkingTimeState>;
  getCanonicalActivityProjection(sessionPath?: string): CanonicalActivityProjectionSnapshot;
  getCanonicalToolFacetProjection(sessionPath?: string): CanonicalToolFacetProjectionSnapshot;
  getCanonicalActivityStats(sessionPath?: string): CanonicalActivityStats;
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
  onSessionOpened: () => undefined,
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
  /** Resolve the catalog directory whose `models.json` plus generated
   *  historical pricing catalog back the captured pricing facts handed to
   *  settlement accounting. */
  getAgentDir?: () => string | null;
  /** Disabled/legacy by default. A canonical authority is injected only after
   * P0/P2b/P5 activation prerequisites are independently accepted. */
  analyticsCapture?: CanonicalAnalyticsCapture;
  /** P5 durable canonical read model. Path-only until a consumer queries it;
   * consumers must gate on canonical authority until the P7a cutover. */
  analyticsReadModel?: CanonicalAnalyticsReadModel;
}
