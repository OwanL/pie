import type {
  AssistantUsage,
  ComposerInput,
  ThinkingLevel,
  ToolCall,
} from '../../shared/protocol';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';
import type { AgentReviewCompletion, TaskBoundaryIntent, RunSnapshot, TurnLatencyMeasurement, TurnThroughputStatus } from '../run-analytics';

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
  busyStartedAt: string | null;
}

export interface RunObserver {
  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage?: string): string;
  onAssistantTurnStarted(sessionPath: string, turnId: string): void;
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
  ): void;
  onToolStarted(sessionPath: string, toolCall: ToolCall): void;
  onToolFinished(sessionPath: string, toolCall: ToolCall): void;
  onInterrupted(sessionPath: string): void;
  onCompaction(sessionPath: string): void;
  onAutoRetry(sessionPath: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onBackendError(sessionPath: string | undefined, code: string): void;
  onContextUsageChanged(sessionPath: string, tokens: number | null, limit: number): void;
  onBusyChanged(sessionPath: string, busy: boolean): void;
  onModelConfigChanged(sessionPath: string, modelId: string | undefined, thinkingLevel: ThinkingLevel | undefined, provider?: string): void;
  onUnsupportedInputAttempt(sessionPath: string): void;
  onSessionClosed(sessionPath: string): void;
  replaceSessionPath(oldPath: string, newPath: string): void;
  recordAgentReview(
    sessionPath: string,
    review: {
      done: boolean;
      rating: number;
      completion: AgentReviewCompletion;
      reason: string;
      evaluatedAt: string;
      reviewerBuckets: string[];
      reviewerCount: number;
    },
  ): void;
}

export const NOOP_RUN_OBSERVER: RunObserver = {
  prepareForSend: () => 'noop-run',
  onAssistantTurnStarted: () => undefined,
  onSkillPruningUsage: () => undefined,
  onAssistantTurnEnded: () => undefined,
  onToolStarted: () => undefined,
  onToolFinished: () => undefined,
  onInterrupted: () => undefined,
  onCompaction: () => undefined,
  onAutoRetry: () => undefined,
  onMessageEdited: () => undefined,
  onTruncatedAfter: () => undefined,
  onBackendError: () => undefined,
  onContextUsageChanged: () => undefined,
  onBusyChanged: () => undefined,
  onModelConfigChanged: () => undefined,
  onUnsupportedInputAttempt: () => undefined,
  onSessionClosed: () => undefined,
  replaceSessionPath: () => undefined,
  recordAgentReview: () => undefined,
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
    busyStartedAt: null,
  };
}
