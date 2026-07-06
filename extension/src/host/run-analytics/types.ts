import type {
  ActiveRunStatus,
  AssistantUsage,
  ComposerInput,
  PruningMode,
  RunOutcome,
  SessionAnalyticsFactors,
  ThinkingLevel,
} from '../../shared/protocol';
import type { VerificationCommandKind, SubagentTaskScoreRollup, ToolFailureKind, ToolResultIssueKind, TreatmentChangeKind } from '../../shared/tool-call-analysis';

export type { TreatmentChangeKind } from '../../shared/tool-call-analysis';

export const RUN_ANALYTICS_SCHEMA_VERSION = 1;

export type TaskBoundaryIntent = 'new_task' | 'continue_task' | null;
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';

export interface ToolFailureSample {
  toolName: string;
  failureKind: ToolFailureKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
  occurredAt: string;
}

export interface ToolResultIssueSample {
  toolName: string;
  /** Non-success result kind: a verification command that exposed project failures, or an empty probe/search. */
  resultIssueKind: ToolResultIssueKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
  occurredAt: string;
}

/**
 * Terminal status of a single assistant turn, mirrored on throughput samples
 * so rate-limit / failure signals can be graphed alongside generation speed.
 */
export type TurnThroughputStatus = 'completed' | 'error' | 'interrupted';

/**
 * One timestamped throughput observation per assistant turn.
 *
 * Throughput = `outputTokens` ÷ (`generationDurationMs` / 1000). The
 * generation duration is the wall-clock span from `message_start` to
 * `message_end`, which excludes tool-execution time (tools run between
 * messages), so it isolates how fast the model itself is emitting tokens.
 *
 * `concurrentBusySessions` records how many sessions were mid-run when the
 * turn ended (including this one), enabling multi-session throughput /
 * rate-limit-resilience analysis.
 *
 * `turnLatencyMs` / `overheadMs` / `providerLatencyMs` decompose the gap
 * between the previous tool call finishing and the model's first reply token
 * (null when not measurable for a given turn — e.g. `turn_start` was not
 * observed, or the turn produced no content delta). `turnLatencyMs` ≈
 * `overheadMs` + `providerLatencyMs`; the split is anchored on the SDK's
 * `turn_start` event: overhead = turn boundary → `turn_start` (serial
 * inter-turn work on our side), provider = `turn_start` → first reply token
 * (request preparation + network + provider TTFT).
 */
export interface TurnThroughputSample {
  /** ISO timestamp when the assistant turn ended (`message_end`). */
  endedAt: string;
  /** Output tokens reported for this turn (0 when the provider did not report usage). */
  outputTokens: number;
  /** Wall-clock generation time for this turn in ms (tool-execution excluded). */
  generationDurationMs: number;
  /** Sessions concurrently mid-run when this turn ended, including this one. */
  concurrentBusySessions: number;
  /** Terminal status of the turn. */
  status: TurnThroughputStatus;
  /**
   * Total turn latency: previous tool end (or prompt send) → first reply
   * token, in ms. Null when not measurable for this turn.
   */
  turnLatencyMs: number | null;
  /**
   * Our overhead: turn boundary → `turn_start` (serial inter-turn work), in ms.
   * Null when `turn_start` was not observed.
   */
  overheadMs: number | null;
  /**
   * Provider latency: `turn_start` → first reply token (request prep + network
   * + provider TTFT), in ms. Null when not measurable.
   */
  providerLatencyMs: number | null;
}

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

export interface ToolUsageRollup {
  totalCount: number;
  /**
   * Execution failures only: tool calls where the tool could not complete its
   * job (timeout, invalid arguments, missing file, shell error, nonzero exit on
   * a non-verification command, ...). Non-success results (failing tests/builds,
   * empty searches) are tracked under `resultIssueCount`, not here.
   */
  failureCount: number;
  /** Failed tool calls excluding verification-project failures and probe/no-match outcomes. */
  executionFailureCount: number;
  /** Failed tool calls where the command was verification and exposed project failures. */
  verificationProjectFailureCount: number;
  /** Failed probe/search commands that likely mean "no matches" rather than a broken tool. */
  probeFailureCount: number;
  /** Non-success results: tool ran to completion but reported a non-success outcome (verification failure or empty probe). */
  resultIssueCount: number;
  countsByName: Record<string, number>;
  failureCountsByName: Record<string, number>;
  failureCountsByKind: Record<ToolFailureKind, number>;
  failureCountsByNameAndKind: Record<string, Record<ToolFailureKind, number>>;
  failureSamples: ToolFailureSample[];
  resultIssueCountsByName: Record<string, number>;
  resultIssueCountsByKind: Record<ToolResultIssueKind, number>;
  resultIssueCountsByNameAndKind: Record<string, Record<ToolResultIssueKind, number>>;
  resultIssueSamples: ToolResultIssueSample[];
  /** Cumulative wall-clock execution time (ms) across all timed tool calls. */
  totalDurationMs: number;
  /** Number of completed/failed tool calls that reported an execution duration. */
  timedCallCount: number;
  /** Cumulative execution time (ms) per normalized tool name. */
  durationMsByName: Record<string, number>;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  subagentScoredTaskCount: number;
  subagentTaskScores: SubagentTaskScoreRollup;
}

export interface FileMutationRollup {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
  /** Per-file EDIT counts keyed by a path hash. Backs the file-churn signal (re-editing the same
   *  file repeatedly). Edits only; empty for runs captured before this field existed. */
  editCountsByFile: Record<string, number>;
  /** Per-file READ counts keyed by a path hash. Backs the "files reviewed" breadth signal (how many
   *  distinct files the agent reviewed) and the re-read churn signal (re-opening the same file).
   *  Reads only; empty for runs captured before this field existed or when no read had an
   *  extractable path. */
  readCountsByFile: Record<string, number>;
}

export interface FileExtensionRollup {
  readCountsByExtension: Record<string, number>;
  writeCountsByExtension: Record<string, number>;
  editCountsByExtension: Record<string, number>;
}

export interface VerificationRollup {
  totalCount: number;
  failureCount: number;
  countsByKind: Record<VerificationCommandKind, number>;
}

/**
 * Snapshot of the functional (behavioral) settings in effect when a run started.
 * Captured once at run start from `ArchState.settings` so outcomes can be
 * compared across setting values (e.g. sub-agent parent-model toggle, pruning
 * mode, per-extension enable/disable toggles). Mirrored on the analysis side.
 *
 * Intentionally a small, low-cardinality set of toggles — the dimensions most
 * useful for A/B-style graphing. Additive/optional on `RunSnapshot`: historical
 * runs recorded before this field existed coerce to `null` ("untracked").
 */
export interface FunctionalSettingsSnapshot {
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  /** Pruning mode at run start. */
  pruningMode: PruningMode;
  /** Per-extension enabled/disabled toggles at run start (extension id -> enabled). */
  extensionToggles: Record<string, boolean>;
  /** Tool-result-pruning enabled flag at run start (null = untracked, predates field). Backs the
   *  outcome comparison: are runs better with tool-result pruning on or off? */
  toolResultPruningEnabled: boolean | null;
  /** Tool-result-pruning profile at run start (null = untracked). */
  toolResultPruningProfile: 'default' | 'security' | null;
}

export interface RunSnapshot {
  sessionPath: string;
  runId: string;
  taskGroupId: string;
  status: ActiveRunStatus;
  scored: boolean;
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizationReason?: RunFinalizationReason;
  outcome?: RunOutcome;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  mixedModelConfig: boolean;
  mixedTreatmentConfig: boolean;
  treatmentChangeKinds: TreatmentChangeKind[];
  experimentAssignment: string | null;
  analyticsFactors: SessionAnalyticsFactors | null;
  /** Functional settings snapshot captured at run start; null for runs recorded before tracking existed. */
  functionalSettings: FunctionalSettingsSnapshot | null;
  sendCount: number;
  assistantTurnCount: number;
  assistantTurnDurationMs: number;
  busyDurationMs: number;
  busyPeriodCount: number;
  interruptedCount: number;
  messageEditCount: number;
  truncatedAfterCount: number;
  backendErrorCodes: string[];
  contextTokens: number | null;
  contextLimit: number | null;
  /** Cumulative input tokens reported by the provider across assistant turns in this run. */
  inputTokens: number;
  /** Cumulative output tokens reported by the provider across assistant turns in this run. */
  outputTokens: number;
  /** Cumulative cache-read tokens across assistant turns in this run. */
  cacheReadTokens: number;
  /** Cumulative cache-write tokens across assistant turns in this run. */
  cacheWriteTokens: number;
  /** Number of assistant turns in this run that reported provider usage. */
  tokenReportedTurnCount: number;
  /** Usage from the most recent assistant turn in this run that reported it. */
  lastTurnUsage: AssistantUsage | null;
  /**
   * Per-turn throughput observations (one timestamped sample per assistant
   * turn). Empty for runs recorded before throughput sampling existed.
   */
  turnThroughputSamples: TurnThroughputSample[];
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: Array<ComposerInput['kind']>;
  toolUsage: ToolUsageRollup;
  fileMutation: FileMutationRollup;
  fileExtensions: FileExtensionRollup;
  verification: VerificationRollup;
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
