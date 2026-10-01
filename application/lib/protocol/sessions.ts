import type { BackendSessionSummary } from '../../../harness/agent-processes/lib/rpc/session-events.js';

/** Renderer/session-list projection, including host-only create lifecycle hints. */
export interface SessionSummary extends BackendSessionSummary {
  creationState?: 'pending' | 'delayed';
  createOperationId?: string;
}

/** Worker/RPC session event DTOs. The host-only capability projection remains
 * application-owned and is exported separately below. */
export type {
  AgentMessagePayload,
  AgentSettledPayload,
  AuxiliaryLlmUsagePayload,
  BackendReadyPayload,
  BusyChangedPayload,
  CompactionOutcome,
  CompactionPayload,
  CompactionReason,
  CompactionStartedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  MessageToolCallDeltaPayload,
  OperationalErrorPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryDurationClockDomain,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
  RetryStatus,
  SessionCatalogProgress,
  SessionCloseRequestedPayload,
  SessionCloseResponseDeliveredPayload,
  SessionOpenedPayload,
  SessionUsageSnapshot,
  SystemPromptAvailability,
  SystemPromptEntry,
  SystemPromptSource,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
  TranscriptMode,
  TranscriptPageDirection,
  TranscriptPagePayload,
  TranscriptWindow,
} from '../../../harness/agent-processes/lib/rpc/session-events.js';
export type {
  SessionAnalyticsFactors,
  SessionCapabilityFacts,
  SessionContextFileFactor,
  SessionListChangedPayload,
  SessionSkillFactor,
  SessionToolSnippetFactor,
} from '../../../harness/agent-processes/lib/rpc/session-events.js';
export type {
  SessionCapabilities,
  SessionOperationRecoveryAction,
  SessionPrimaryOperation,
  SessionPrimaryOperationKind,
  SessionPrimaryOperationPhase,
} from './session-operation-projection.js';
export type { FileChangeEntry, FileChangeKind } from '../../../lib/file-changes/types.js';
