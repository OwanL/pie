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
  RunOutcome,
  RunOutcomeResolution,
  RunSnapshot,
  SessionAnalyticsFactors,
  SubagentTaskScoreRollup,
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
  RunOutcome,
  RunOutcomeResolution,
  RunSnapshot,
  SessionAnalyticsFactors,
  SubagentTaskScoreRollup,
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

export interface OutcomeHistoryLogEntry {
  schemaVersion: number;
  kind: 'run_outcome';
  recordedAt: string;
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  outcome: RunOutcome;
}

/** A single agent-authored session review (from the `session_review` tool),
 *  persisted to `agent-reviews.jsonl` and joined to the run in effect when the
 *  review was recorded. Mirrors {@link OutcomeHistoryLogEntry} but carries the
 *  richer agent-review fields (done / 1–5 rating / completion / reason) plus
 *  the multi-reviewer provenance (reviewerBuckets / reviewerCount) so agent
 *  judgement can be compared against the user's own `run_outcome` in the
 *  dashboard. */
export type AgentReviewCompletion = 'fully' | 'partial' | 'setback';

export interface AgentReviewEntry {
  schemaVersion: number;
  kind: 'agent_review';
  recordedAt: string;
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  done: boolean;
  rating: number;
  completion: AgentReviewCompletion;
  reason: string;
  evaluatedAt: string;
  /** Sub-agent buckets whose judgments fed the rating (e.g. ['medium','small']). */
  reviewerBuckets: string[];
  /** Number of sub-agent reviewers that fed the rating. */
  reviewerCount: number;
}
