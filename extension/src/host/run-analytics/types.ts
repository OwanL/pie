import type {
  ActiveRunStatus,
  AssistantUsage,
  AuxiliaryLlmUsageKind,
  AuxiliaryLlmUsageSample,
  FileExtensionRollup,
  FileMutationRollup,
  FunctionalSettingsSnapshot,
  PruningMode,
  RunFinalizationReason,
  RunSnapshot,
  RetryTimingSample,
  SessionAnalyticsFactors,
  TaskBoundaryIntent,
  ThinkingLevel,
  ToolFailureSample,
  ToolResultIssueSample,
  ToolUsageRollup,
  TurnThroughputSample,
  TurnThroughputStatus,
  VerificationRollup,
} from '../../../../shared/run-analytics-contracts.js';

export type {
  ActiveRunStatus,
  AssistantUsage,
  AuxiliaryLlmUsageKind,
  AuxiliaryLlmUsageSample,
  FileExtensionRollup,
  FileMutationRollup,
  FunctionalSettingsSnapshot,
  PruningMode,
  RunFinalizationReason,
  RunSnapshot,
  RetryTimingSample,
  SessionAnalyticsFactors,
  TaskBoundaryIntent,
  ThinkingLevel,
  ToolFailureSample,
  ToolResultIssueSample,
  ToolUsageRollup,
  TurnThroughputSample,
  TurnThroughputStatus,
  VerificationRollup,
};

export { RUN_ANALYTICS_SCHEMA_VERSION } from '../../../../shared/run-analytics-contracts.js';

export type { TreatmentChangeKind } from '../../shared/tool-call-analysis';

/**
 * Per-turn latency breakdown measured between the previous tool call finishing
 * (or the prompt being sent, for the first turn) and the model's first reply
 * token. Carried from the backend through `onAssistantTurnEnded` into a
 * {@link TurnThroughputSample}. Fields are optional on the wire (undefined when
 * not measurable) and normalized to `null` on the persisted sample.
 */
export interface TurnLatencyMeasurement {
  /** Total: turn boundary → first reply token, ms. */
  turnLatencyMs?: number;
  /** Our overhead: turn boundary → `turn_start`, ms. */
  overheadMs?: number;
  /** Provider latency: `turn_start` → first reply token, ms. */
  providerLatencyMs?: number;
  /** Correlated provider-gate permit wait; explicit zero means immediate. */
  providerQueueMs?: number;
  /** Number of provider attempts represented by providerQueueMs. */
  providerQueueAttemptCount?: number;
}

export interface PersistedSessionRunState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  busyStartedAt: string | null;
}

export interface RunCheckpoint {
  schemaVersion: number;
  seq: number;
  sessions: Record<string, PersistedSessionRunState>;
}

export interface RunSnapshotLogEntry {
  schemaVersion: number;
  kind: 'run_snapshot';
  recordedAt: string;
  run: RunSnapshot;
}
