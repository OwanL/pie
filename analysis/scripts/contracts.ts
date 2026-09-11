import type {
  ToolFailureKind,
  ToolResultIssueKind,
  TreatmentChangeKind,
  VerificationCommandKind,
} from '../../shared/tool-analysis-kinds.js';

export type {
  ToolFailureKind,
  ToolResultIssueKind,
  TreatmentChangeKind,
  VerificationCommandKind,
} from '../../shared/tool-analysis-kinds.js';

import type {
  AssistantUsage, AuxiliaryLlmUsageKind, AuxiliaryLlmUsageSample, ActiveRunStatus, RunFinalizationReason, ThinkingLevel, PruningMode, InputKind,
  SessionContextFileFactor, SessionToolSnippetFactor,
  SessionSkillFactor, SessionAnalyticsFactors, FunctionalSettingsSnapshot,
  ToolFailureSample, ToolResultIssueSample, TurnThroughputStatus,
  TurnThroughputSample, RetryTimingSample, ToolUsageRollup, FileMutationRollup, FileExtensionRollup,
  VerificationRollup, RunSnapshot as BaseRunSnapshot, TaskBoundaryIntent, UserInputCharSample,
} from '../../shared/run-analytics-contracts.js';

export type {
  AssistantUsage, AuxiliaryLlmUsageKind, AuxiliaryLlmUsageSample, ActiveRunStatus, RunFinalizationReason, ThinkingLevel, PruningMode, InputKind,
  SessionContextFileFactor, SessionToolSnippetFactor,
  SessionSkillFactor, SessionAnalyticsFactors, FunctionalSettingsSnapshot,
  ToolFailureSample, ToolResultIssueSample, TurnThroughputStatus,
  TurnThroughputSample, RetryTimingSample, ToolUsageRollup, FileMutationRollup, FileExtensionRollup,
  VerificationRollup, TaskBoundaryIntent, UserInputCharSample,
};

/** Analysis accepts the stable session-header identity when present in newer exports. */
export type RunSnapshot = BaseRunSnapshot & { sessionId?: string };

export {
  RUN_ANALYTICS_SCHEMA_VERSION,
  CURRENT_HARNESS_REVISION,
  MAX_USER_INPUT_SAMPLE_CHARS,
} from '../../shared/run-analytics-contracts.js';

export type VerificationState = 'none' | 'passing' | 'failing';
export type VerificationCountBucket = '0' | '1' | '2-3' | '4+';

/**
 * Harness cohort classification for a run, resolved by the pure classifier in
 * `cohorts.ts` from the stamped harness revision and the run's start time:
 * - `current`: revision matches the current harness, or (historically) the run
 *   started inside the current-harness era before identity was required.
 * - `legacy`: started before the historical-current boundary, before harness
 *   stamping existed.
 * - `unknown`: started at/after the identity-required boundary without a
 *   revision — the run cannot be attributed to the current harness.
 * - `incompatible`: carries a revision that is not the current harness's.
 */
export type HarnessCohortStatus = 'current' | 'legacy' | 'unknown' | 'incompatible';

export interface SourceAnalyticsPayload {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  /** Raw pruning decisions read from data/pruning.jsonl. */
  pruningDecisions: PruningSourceDecision[];
  /** Raw pruning quality-signal events read from data/pruning.jsonl. */
  pruningEvents: PruningSourceEvent[];
  /** Raw tool-result-pruning events read from data/tool-result-pruning.jsonl. */
  toolResultPruningEvents: ToolResultPruningSourceEvent[];
  /** Raw warm-bash auto-prune rewrite events read from data/warm-bash.jsonl. Optional
   *  (absent on older exports / fresh checkouts with no warm-bash activity). */
  warmBashRewrites?: WarmBashRewriteSourceEvent[];
  /** Raw warm-bash per-session routing-counter summaries read from data/warm-bash.jsonl. */
  warmBashSummaries?: WarmBashSessionSummarySourceEvent[];
}

export interface LoadedSourceAnalytics {
  source: SourceAnalyticsPayload;
  sourceKind: 'fixture' | 'export' | 'storage-dir' | 'all-stores';
  sourcePath: string;
}

export interface PreparedSkillEntry {
  name: string;
  lastModifiedAt: string | null;
}

export interface PreparedRunRow {
  runId: string;
  taskGroupId: string;
  /** Stable session-header identity; path hash only when identityFallback is true. */
  sessionId: string;
  identityFallback: boolean;
  sessionPathHash: string;
  /** Harness revision stamped at run start; null for runs recorded before stamping existed. */
  harnessRevision: string | null;
  /** Deterministic privacy-safe digest of the revision plus captured analytics factors/functional settings; null for historical runs. */
  harnessFingerprint: string | null;
  /** Harness cohort classification resolved from the stamped revision and start time. */
  harnessStatus: HarnessCohortStatus;
  /** True when the run is attributed to the current harness (harnessStatus === 'current'). */
  isCurrentHarness: boolean;
  status: ActiveRunStatus;
  startedAt: string;
  startedDay: string;
  updatedAt: string;
  finalizedAt: string | null;
  finalizationReason: RunFinalizationReason | null;
  /** Provider-specific model id as recorded (e.g. 'umans-glm-5.2', 'glm-5.2:cloud'). Stored distinctly so provider differences remain investigable. */
  modelId: string | null;
  /** Canonical, provider-agnostic model family (e.g. 'glm-5.2') resolved from `models.json`'s optional `family` field; falls back to `modelId` when unset, null when `modelId` is null. */
  modelFamily: string | null;
  /** Provider name from `models.json` (e.g. 'anthropic', 'openai', 'umans', 'ollama'); null when the model could not be attributed to a provider (not in the registry). Surfaced so analytics can roll cost up by provider over time, complementing the provider-agnostic `modelFamily`. */
  provider: string | null;
  thinkingLevel: ThinkingLevel | null;
  mixedModelConfig: boolean;
  mixedTreatmentConfig: boolean;
  experimentAssignment: string | null;
  promptFamily: string | null;
  promptHashPrefix: string | null;
  promptCapturedAt: string | null;
  toolSetHashPrefix: string | null;
  skillSetHashPrefix: string | null;
  skillEntries: PreparedSkillEntry[];
  /** Names of extensions active during this run. */
  activeExtensions: string[];
  selectedToolCount: number;
  skillCount: number;
  contextFileCount: number;
  promptGuidelineCount: number;
  /** Privacy-safe size of the user-authored message that started the run; null for historical snapshots. */
  initialUserMessageChars: number | null;
  /** Sub-agent parent-model toggle at run start (null = untracked). */
  fsSubagentAlwaysParentModel: boolean | null;
  /** Pruning mode at run start (null = untracked). */
  fsPruningMode: PruningMode | null;
  /** Derived: pruning active (mode !== 'off') at run start (null = untracked). */
  fsPruningEnabled: boolean | null;
  /** Per-extension enabled/disabled toggles at run start (empty when untracked). */
  fsExtensionToggles: Record<string, boolean>;
  /** Tool-result-pruning enabled flag at run start (null = untracked, predates field). */
  fsToolResultPruningEnabled: boolean | null;
  /** Tool-result-pruning profile at run start (null = untracked). */
  fsToolResultPruningProfile: 'default' | 'security' | null;
  sendCount: number;
  assistantTurnCount: number;
  assistantTurnDurationMs: number;
  busyDurationMs: number;
  busyPeriodCount: number;
  interruptedCount: number;
  messageEditCount: number;
  truncatedAfterCount: number;
  backendErrorCount: number;
  contextTokens: number | null;
  contextLimit: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokenReportedTurnCount: number;
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: InputKind[];
  toolCallCount: number;
  /** Cumulative wall-clock duration reported by timed tool calls. */
  toolDurationMs: number;
  /** Non-overlapping timed tool duration; null when the source predates interval tracking. */
  criticalPathDurationMs: number | null;
  /** Number of tool calls that reported an execution duration. */
  timedToolCallCount: number;
  toolFailureCount: number;
  resultIssueCount: number;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentCount: number;
  /** Cumulative input tokens consumed by spawned sub-agent sessions (0 when none / untracked). */
  subagentInputTokens: number;
  /** Cumulative output tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentOutputTokens: number;
  /** Cumulative cache-read tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentCacheReadTokens: number;
  /** Cumulative cache-write tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentCacheWriteTokens: number;
  /** Estimated USD cost of spawned sub-agent sessions. Zero means no subagent calls or fully priced free usage; null means calls occurred but canonical token usage or complete model pricing was unavailable. */
  subagentEstimatedCostUsd: number | null;
  /** Complete parent + subagent estimated USD cost. Null unless reported parent usage and every applicable subagent component can be priced; an explicit null must not fall back to a partial parent-only cost. */
  totalEstimatedCostUsd: number | null;
  /** Number of history-compaction (`/compact`) LLM calls in this run (0 when untracked). */
  compactionCount: number;
  /** Aggregate skill-pruning prepass input tokens (0 when none). */
  skillPruningPrepassInputTokens: number;
  /** Aggregate skill-pruning prepass output tokens (0 when none). */
  skillPruningPrepassOutputTokens: number;
  /** Aggregate skill-pruning prepass cache-read tokens (0 when none). */
  skillPruningPrepassCacheReadTokens: number;
  /** Aggregate skill-pruning prepass cache-write tokens (0 when none). */
  skillPruningPrepassCacheWriteTokens: number;
  /** Aggregate measured skill-pruning prepass duration; null when no timing was reported. */
  skillPruningPrepassDurationMs: number | null;
  /** Full last-turn usage scalar fields, nullable when absent. */
  lastTurnInputTokens: number | null;
  lastTurnOutputTokens: number | null;
  lastTurnCacheReadTokens: number | null;
  lastTurnCacheWriteTokens: number | null;
  lastTurnTotalTokens: number | null;
  lastTurnReasoningTokens: number | null;
  /** Treatment-change kinds recorded during this run. */
  treatmentChangeKinds: TreatmentChangeKind[];
  /** Number of auto-retry attempts in this run (0 when untracked). */
  autoRetryCount: number;
  verificationTotalCount: number;
  verificationFailureCount: number;
  verificationState: VerificationState;
  verificationCountBucket: VerificationCountBucket;
  verificationCountsByKind: Record<VerificationCommandKind, number>;
  fileWriteCount: number;
  fileEditCount: number;
  fileDeleteCount: number;
  fileRenameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
  lineMutationTotal: number;
  tokenEfficiency: number | null;
  contextUtilization: number | null;
  cacheHitRatio: number | null;
  /** File-churn signal: fraction of EDIT ops that revisited an already-edited file in this run
   *   (0 = every edit touched a fresh file, no churn; →1 = kept re-editing the same files). Null
   *   when the run had no edits or lacked per-file attribution (legacy runs). Derived from
   *   `fileMutation.editCountsByFile`. Higher = more churn = worse. */
  editRevisitRate: number | null;
  /** Distinct files reviewed (read) in this run — the count of distinct path hashes in
   *   `fileMutation.readCountsByFile`. A breadth-of-investigation signal: how many different files
   *   the agent inspected. 0 for runs with no attributable reads (incl. legacy runs captured before
   *   per-file read tracking existed). */
  filesReviewedCount: number;
  /** Re-read churn: fraction of READ ops that revisited an already-read file in this run
   *   (0 = every read touched a fresh file, no churn; →1 = kept re-reading the same files). Null
   *   when the run had no attributable reads or lacked per-file attribution (legacy runs). Derived
   *   from `fileMutation.readCountsByFile`. Higher = more churn = worse. */
  readRevisitRate: number | null;
  /** Parent-session estimated USD cost derived from reported token usage × model pricing. Null when parent usage was not reported or pricing is unknown; reported usage on a known free model is 0. */
  estimatedCostUsd: number | null;
}

export interface PreparedToolUsageRow {
  runId: string;
  toolName: string;
  callCount: number;
  failureCount: number;
  executionFailureCount: number;
  verificationProjectFailureCount: number;
  probeFailureCount: number;
  resultIssueCount: number;
  /** Cumulative execution duration (ms) for this tool across the run (0 when unreported). */
  totalDurationMs: number;
  /** Number of timed calls for this tool in this run (0 when unreported). */
  timedCallCount: number;
  /** Mean execution duration (ms) per timed call (= totalDurationMs / timedCallCount); null when no timed calls exist. */
  meanDurationMs: number | null;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
}

export interface PreparedToolFailureRow {
  runId: string;
  toolName: string;
  failureKind: ToolFailureKind;
  count: number;
  exitCode: number | null;
  errorExcerpt: string | null;
  verificationKinds: VerificationCommandKind[];
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
}

export interface PreparedVerificationUsageRow {
  runId: string;
  kind: VerificationCommandKind;
  count: number;
  runHadAnyFailure: boolean;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
}

export interface PreparedBackendErrorRow {
  runId: string;
  errorCode: string;
  count: number;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
}

export interface PreparedFileExtensionRow {
  runId: string;
  extension: string;
  readCount: number;
  writeCount: number;
  editCount: number;
  totalCount: number;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
}

/**
 * One row per assistant turn, flattened from `RunSnapshot.turnThroughputSamples`
 * with run-level metadata. `tokensPerSecond` is precomputed for completed turns
 * with reported output tokens and positive generation time; null otherwise.
 */
export interface PreparedTurnThroughputRow {
  runId: string;
  endedAt: string;
  startedDay: string;
  /** Provider-specific model used for this turn. */
  modelId: string | null;
  /** Provider paired with this turn's modelId when known. */
  provider: string | null;
  /** Canonical provider-agnostic family for this turn's model. */
  modelFamily: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  outputTokens: number;
  generationDurationMs: number;
  concurrentBusySessions: number;
  status: TurnThroughputStatus;
  tokensPerSecond: number | null;
  turnLatencyMs: number | null;
  overheadMs: number | null;
  providerLatencyMs: number | null;
  /** Time waiting for provider-gate permits; null when no gate observation exists. */
  providerQueueMs: number | null;
  /** Provider attempts represented by queue timing; 0 means unavailable. */
  providerQueueAttemptCount: number;
  /** Input tokens reported for this turn (0 when unreported). */
  inputTokens: number;
  /** Cache-read tokens reported for this turn (0 when unreported). */
  cacheReadTokens: number;
  /** Cache-write tokens reported for this turn (0 when unreported). */
  cacheWriteTokens: number;
  /** Context-window token count at the end of this turn (null when unreported). */
  contextTokens: number | null;
}

/** One prepared auto-retry timing observation with run-level attribution. */
export interface PreparedRetryTimingRow {
  runId: string;
  sourceId: string;
  occurredAt: string;
  startedDay: string;
  attempt: number;
  scheduledDelayMs: number;
  measuredDelayMs: number | null;
  durationMs: number | null;
  modelId: string | null;
  modelFamily: string | null;
  provider: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
}

/** Prepared non-success result issue row for DuckDB. */
export interface PreparedToolResultIssueRow {
  runId: string;
  toolName: string;
  resultIssueKind: ToolResultIssueKind;
  count: number;
  exitCode: number | null;
  errorExcerpt: string | null;
  verificationKinds: VerificationCommandKind[];
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
}

/** Raw pruning decision as read from data/pruning.jsonl. */
export interface PruningSourceDecision {
  timestamp: string;
  sessionId: string;
  sessionPath: string;
  mode: string;
  query: string;
  llmModel: string;
  llmThinkingLevel: string;
  llmLatencyMs: number;
  included: string[];
  excluded: string[];
  skillBlockTokens: number;
  originalBlockTokens: number;
  toolIncluded?: string[];
  toolExcluded?: string[];
  toolBlockTokens?: number;
  originalToolBlockTokens?: number;
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  prepassInputEstimateTokens?: number;
  codeVersion?: string;
}

/** Raw pruning quality-signal event read from data/pruning.jsonl.
 *  These are the over-pruning signals: `skill_miss` / `shadow_miss_candidate`
 *  (agent read a skill the pruner had pruned — a wrong-prune),
 *  `skill_recovered` (agent loaded a hidden skill through request_capability), and
 *  `tool_recovered` (agent re-enabled a hidden tool through request_capability).
 *  `skill_read` is a non-miss baseline read, surfaced only as a denominator for the miss rate. */
export interface PruningSourceEvent {
  event: 'skill_read' | 'skill_miss' | 'shadow_miss_candidate' | 'skill_recovered' | 'tool_recovered';
  skillName?: string;
  toolName?: string;
  sessionId: string;
  timestamp: string;
}

/** Raw tool-result-pruning event read from data/tool-result-pruning.jsonl.
 *  Emitted by extensions/tool-result-pruner for every tool result whose output
 *  the lossless pipeline rewrote. Carries which rules fired + before/after token
 *  counts (the §9.3 measurement signal: per-rule savings, per-tool noise). */
export interface ToolResultPruningSourceEvent {
  event: 'tool_result_pruned';
  sessionId: string;
  toolName: string;
  rules: string[];
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  timestamp: string;
}

/** Raw warm-bash auto-prune rewrite event read from data/warm-bash.jsonl.
 *  Emitted by extensions/warm-bash for every transparent command rewrite
 *  (recursive grep / bare-path find). Point-in-time, joinable to a run by
 *  sessionPathHash + timestamp (same mechanism as pruning signals). */
export interface WarmBashRewriteSourceEvent {
  event: 'auto_prune_rewrite';
  sessionId: string;
  timestamp: string;
  before: string;
  after: string;
}

/** Raw warm-bash per-session routing-counter summary read from data/warm-bash.jsonl.
 *  Emitted once at session_shutdown; counters are session-cumulative (warm-bash has
 *  no run-boundary signal), so these are per-session, not per-run. */
export interface WarmBashSessionSummarySourceEvent {
  event: 'session_summary';
  sessionId: string;
  timestamp: string;
  fastPath: number;
  warm: number;
  fallback: number;
  poolSize: number;
  warmupFailures: number;
  autoPruneEnabled: boolean;
  fastPathEnabled: boolean;
  gnuGrep: boolean;
}

/** Prepared pruning quality-signal row for DuckDB (joined to a run by sessionPathHash). */
export interface PreparedPruningSignalRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  event: 'skill_read' | 'skill_miss' | 'shadow_miss_candidate' | 'skill_recovered' | 'tool_recovered';
  skillName: string | null;
  toolName: string | null;
}

/** Prepared warm-bash rewrite row for DuckDB (joined to a run by sessionPathHash).
 *  One row per transparent command rewrite. */
export interface PreparedWarmBashRewriteRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  before: string;
  after: string;
}

/** Prepared warm-bash per-session summary row for DuckDB (joined to a run by
 *  sessionPathHash). One row per session that used the bash tool. */
export interface PreparedWarmBashSummaryRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  fastPath: number;
  warm: number;
  fallback: number;
  poolSize: number;
  warmupFailures: number;
  autoPruneEnabled: boolean;
  fastPathEnabled: boolean;
  gnuGrep: boolean;
}

/** Prepared tool-result-pruning row for DuckDB (joined to a run by sessionPathHash).
 *  One row per pruned tool result. */
export interface PreparedToolResultPruningRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  toolName: string;
  rules: string[];
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
}

/** Prepared pruning event row for DuckDB. */
export interface PreparedPruningEventRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  pruningMode: string;
  query: string;
  llmModel: string;
  llmThinkingLevel: string;
  llmLatencyMs: number;
  skillCountKept: number;
  skillCountPruned: number;
  skillCountTotal: number;
  skillTokensSaved: number;
  skillTokensOriginal: number;
  toolCountKept: number;
  toolCountPruned: number;
  toolCountTotal: number;
  toolTokensSaved: number;
  toolTokensOriginal: number;
  keptSkillNames: string[];
  prunedSkillNames: string[];
  keptToolNames: string[];
  prunedToolNames: string[];
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  prepassInputEstimateTokens?: number;
  codeVersion?: string;
}

export interface PreparedAnalyticsData {
  sourceSchemaVersion: number;
  sourceExportedAt: string;
  sourceWorkspaceKey: string;
  runs: PreparedRunRow[];
  toolUsage: PreparedToolUsageRow[];
  toolFailures: PreparedToolFailureRow[];
  toolResultIssues: PreparedToolResultIssueRow[];
  verificationUsage: PreparedVerificationUsageRow[];
  backendErrors: PreparedBackendErrorRow[];
  fileExtensions: PreparedFileExtensionRow[];
  turnThroughput: PreparedTurnThroughputRow[];
  retryTiming: PreparedRetryTimingRow[];
  pruningEvents: PreparedPruningEventRow[];
  pruningSignals: PreparedPruningSignalRow[];
  toolResultPruning: PreparedToolResultPruningRow[];
  warmBashRewrites: PreparedWarmBashRewriteRow[];
  warmBashSummaries: PreparedWarmBashSummaryRow[];
}
