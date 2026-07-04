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

export const RUN_ANALYTICS_SCHEMA_VERSION = 1;
export const SITE_DATA_SCHEMA_VERSION = 1;
export const DATA_MODE_LOCAL_DEFAULT = 'local-default';
export const GENERATOR_VERSION = 'analysis-v1';

export const SITE_DATA_FILE_NAMES = [
  'manifest.json',
  'overview.json',
  'run-summary.json',
  'model-quality.json',
  'verification-impact.json',
  'tool-usage.json',
  'treatment-comparison.json',
  'timeline.json',
  'model-leaderboard.json',
  'pruning-impact.json',
  'tool-result-pruning-impact.json',
  'agent-review-comparison.json',
  'backend-errors.json',
  'file-types.json',
  'token-throughput.json',
] as const;

export type SiteDataFileName = (typeof SITE_DATA_FILE_NAMES)[number];

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';
export type RunFinalizationReason = 'scored' | 'closed_unscored' | 'new_task';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type PruningMode = 'auto' | 'shadow' | 'off' | 'custom';
export type InputKind = 'filesystemPathRef' | 'imageBlob' | 'fileBlob';
// VerificationCommandKind, ToolFailureKind, ToolResultIssueKind, and
// TreatmentChangeKind are re-exported above from the shared canonical module
// (../../shared/tool-analysis-kinds.js).
export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';
export type VerificationState = 'none' | 'passing' | 'failing';
export type VerificationCountBucket = '0' | '1' | '2-3' | '4+';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  satisfaction: number;
}

export interface SessionContextFileFactor {
  path: string;
  hash: string;
}

export interface SessionToolSnippetFactor {
  toolId: string;
  hash: string;
}

export interface SessionSkillFactor {
  name: string;
  contentHash: string | null;
  sourceHash: string | null;
  disableModelInvocation: boolean;
  lastModifiedAt: string | null;
}

export interface SessionAnalyticsFactors {
  promptFamily: string | null;
  promptHash: string | null;
  promptCapturedAt: string | null;
  harnessPromptHash: string | null;
  customPromptHash: string | null;
  appendSystemPromptHash: string | null;
  promptGuidelineHashes: string[];
  contextFiles: SessionContextFileFactor[];
  selectedToolIds: string[];
  toolSnippetHashes: SessionToolSnippetFactor[];
  toolSetHash: string | null;
  skills: SessionSkillFactor[];
  skillSetHash: string | null;
  /** Names of extensions active during this run (e.g. 'subagent', 'safeguard'). */
  activeExtensions: string[];
}

/**
 * Snapshot of the functional (behavioral) settings in effect when a run
 * started. Mirrors `extension/src/host/run-analytics/types.ts`. Null for runs
 * recorded before functional-settings tracking existed.
 */
export interface FunctionalSettingsSnapshot {
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  /** Pruning mode at run start. */
  pruningMode: PruningMode;
  /** Per-extension enabled/disabled toggles at run start (extension id -> enabled). */
  extensionToggles: Record<string, boolean>;
}

export interface SubagentTaskScoreRollup {
  precision:    { sum: number; count: number; max: number };
  creativity:   { sum: number; count: number; max: number };
  reasoning:    { sum: number; count: number; max: number };
  thoroughness: { sum: number; count: number; max: number };
}

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

/** Terminal status of a single assistant turn, mirrored on throughput samples. */
export type TurnThroughputStatus = 'completed' | 'error' | 'interrupted';

/**
 * One timestamped throughput observation per assistant turn. Throughput =
 * `outputTokens` / (`generationDurationMs` / 1000); the generation duration
 * excludes tool-execution time (tools run between messages). The latency
 * fields decompose the gap from the previous tool finishing to the model's
 * first reply token (null when not measurable for a turn).
 */
export interface TurnThroughputSample {
  endedAt: string;
  outputTokens: number;
  generationDurationMs: number;
  concurrentBusySessions: number;
  status: TurnThroughputStatus;
  turnLatencyMs: number | null;
  overheadMs: number | null;
  providerLatencyMs: number | null;
}

export interface ToolUsageRollup {
  totalCount: number;
  /** Execution failures only (the tool could not do its job). Non-success results are under `resultIssueCount`. */
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
  /** Per-file READ counts keyed by a path hash. Backs the "files reviewed" breadth signal (how
   *  many distinct files the agent reviewed) and the re-read churn signal (re-opening the same
   *  file). Reads only; empty for runs captured before this field existed or when no read had an
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokenReportedTurnCount: number;
  /** Per-turn throughput observations; empty for runs recorded before sampling existed. */
  turnThroughputSamples: TurnThroughputSample[];
  filesystemPathRefCount: number;
  imageInputCount: number;
  imageInputBytes: number;
  unsupportedInputCount: number;
  inputKindsUsed: InputKind[];
  toolUsage: ToolUsageRollup;
  fileMutation: FileMutationRollup;
  fileExtensions: FileExtensionRollup;
  verification: VerificationRollup;
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

/** Agent-review completion judgement, mirrored from the `session_review` tool. */
export type AgentReviewCompletion = 'fully' | 'partial' | 'setback';

/** Raw agent-authored session review read from `agent-reviews.jsonl` (one per line).
 *  The agent-side counterpart to the user's `run_outcome` ({@link OutcomeHistoryLogEntry}):
 *  carries the richer agent-review fields (done / 1–5 rating / completion / reason) plus
 *  multi-reviewer provenance (reviewerBuckets / reviewerCount) so agent judgement can be
 *  compared against the user's own outcome in the dashboard. */
export interface AgentReviewSourceEvent {
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

export interface SourceAnalyticsPayload {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  outcomes: OutcomeHistoryLogEntry[];
  /** Raw agent-authored session reviews read from <store>/agent-reviews.jsonl. */
  agentReviews: AgentReviewSourceEvent[];
  /** Raw pruning decisions read from data/pruning.jsonl. */
  pruningDecisions: PruningSourceDecision[];
  /** Raw pruning quality-signal events read from data/pruning.jsonl. */
  pruningEvents: PruningSourceEvent[];
  /** Raw tool-result-pruning events read from data/tool-result-pruning.jsonl. */
  toolResultPruningEvents: ToolResultPruningSourceEvent[];
}

export interface LoadedSourceAnalytics {
  source: SourceAnalyticsPayload;
  sourceKind: 'fixture' | 'export' | 'storage-dir' | 'all-stores';
  sourcePath: string;
}

export interface ResolutionCounts {
  resolved: number;
  partiallyResolved: number;
  unresolved: number;
}

export interface PreparedSkillEntry {
  name: string;
  lastModifiedAt: string | null;
}

export interface PreparedRunRow {
  runId: string;
  taskGroupId: string;
  sessionPathHash: string;
  status: ActiveRunStatus;
  scored: boolean;
  startedAt: string;
  startedDay: string;
  updatedAt: string;
  finalizedAt: string | null;
  finalizationReason: RunFinalizationReason | null;
  resolution: RunOutcomeResolution | null;
  satisfaction: number | null;
  /** Provider-specific model id as recorded (e.g. 'umans-glm-5.2', 'glm-5.2:cloud'). Stored distinctly so provider differences remain investigable. */
  modelId: string | null;
  /** Canonical, provider-agnostic model family (e.g. 'glm-5.2') resolved from `models.json`'s optional `family` field; falls back to `modelId` when unset, null when `modelId` is null. The leaderboard groups by this, not `modelId`. */
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
  /** Sub-agent parent-model toggle at run start (null = untracked). */
  fsSubagentAlwaysParentModel: boolean | null;
  /** Pruning mode at run start (null = untracked). */
  fsPruningMode: PruningMode | null;
  /** Derived: pruning active (mode !== 'off') at run start (null = untracked). */
  fsPruningEnabled: boolean | null;
  /** Per-extension enabled/disabled toggles at run start (empty when untracked). */
  fsExtensionToggles: Record<string, boolean>;
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
  toolFailureCount: number;
  resultIssueCount: number;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentCount: number;
  subagentScoredTaskCount: number;
  subagentMeanPrecision: number | null;
  subagentMeanCreativity: number | null;
  subagentMeanReasoning: number | null;
  subagentMeanThoroughness: number | null;
  subagentMaxPrecision: number | null;
  subagentMaxCreativity: number | null;
  subagentMaxReasoning: number | null;
  subagentMaxThoroughness: number | null;
  subagentCompositeMean: number | null;
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
  firstAttemptSuccess: boolean;
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
  /** Estimated USD cost derived from token usage × model pricing (null when pricing is unknown for the model). */
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
  /** Mean execution duration (ms) per call (= totalDurationMs / callCount); null when callCount is 0. */
  meanDurationMs: number | null;
  startedAt: string;
  startedDay: string;
  modelId: string | null;
  thinkingLevel: ThinkingLevel | null;
  experimentAssignment: string | null;
  mixedTreatmentConfig: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
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
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
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
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
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
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
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
  scored: boolean;
  satisfaction: number | null;
  resolution: RunOutcomeResolution | null;
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
  modelId: string | null;
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
}

/** Raw pruning quality-signal event read from data/pruning.jsonl.
 *  These are the over-pruning signals: `skill_miss` / `shadow_miss_candidate`
 *  (agent read a skill the pruner had pruned — a wrong-prune) and
 *  `tool_recovered` (agent called `request_tool` to re-enable a pruned tool).
 *  `skill_read` is a non-miss baseline read, surfaced only as a denominator for the miss rate. */
export interface PruningSourceEvent {
  event: 'skill_read' | 'skill_miss' | 'shadow_miss_candidate' | 'tool_recovered';
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

/** Prepared pruning quality-signal row for DuckDB (joined to a run by sessionPathHash). */
export interface PreparedPruningSignalRow {
  runId: string;
  sessionPathHash: string;
  timestamp: string;
  startedDay: string;
  event: 'skill_read' | 'skill_miss' | 'shadow_miss_candidate' | 'tool_recovered';
  skillName: string | null;
  toolName: string | null;
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

/** Prepared agent-review row for DuckDB + site-data (joined to a run by sessionPathHash + runId).
 *  Carries the matched run's model family + user satisfaction so the comparison builder is
 *  self-contained (no re-join to runs needed). */
export interface PreparedAgentReviewRow {
  runId: string;
  sessionPathHash: string;
  taskGroupId: string;
  recordedAt: string;
  evaluatedAt: string;
  startedDay: string;
  /** Canonical model family of the matched run (null when unjoined). */
  modelFamily: string | null;
  agentRating: number;
  agentCompletion: AgentReviewCompletion;
  agentDone: boolean;
  reviewerBuckets: string[];
  reviewerCount: number;
  /** User satisfaction for the matched run (null when the run has no user outcome). */
  userSatisfaction: number | null;
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
}

export interface PreparedAnalyticsData {
  sourceSchemaVersion: number;
  sourceExportedAt: string;
  sourceWorkspaceKey: string;
  runs: PreparedRunRow[];
  toolUsage: PreparedToolUsageRow[];
  toolFailures: PreparedToolFailureRow[];
  verificationUsage: PreparedVerificationUsageRow[];
  backendErrors: PreparedBackendErrorRow[];
  fileExtensions: PreparedFileExtensionRow[];
  turnThroughput: PreparedTurnThroughputRow[];
  pruningEvents: PreparedPruningEventRow[];
  pruningSignals: PreparedPruningSignalRow[];
  toolResultPruning: PreparedToolResultPruningRow[];
  agentReviews: PreparedAgentReviewRow[];
}

export interface SiteManifest {
  schemaVersion: number;
  sourceAnalyticsSchemaVersion: number;
  generatedAt: string;
  sourceWorkspaceKey: string;
  sourceExportedAt: string;
  completedRunCount: number;
  openRunCount: number;
  scoredRunCount: number;
  dataMode: typeof DATA_MODE_LOCAL_DEFAULT;
  generatorVersion: string;
}

export interface OverviewData {
  schemaVersion: number;
  totalCompletedRuns: number;
  totalOpenRuns: number;
  totalScoredRuns: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
  medianBusyDurationMs: number | null;
  p90BusyDurationMs: number | null;
  p99BusyDurationMs: number | null;
  verificationRunRate: number | null;
  toolFailureRate: number | null;
  resultIssueRate: number | null;
  medianTokenEfficiency: number | null;
  averageContextUtilization: number | null;
  averageCacheHitRatio: number | null;
  firstAttemptSuccessRate: number | null;
  totalEstimatedCostUsd: number | null;
  medianEstimatedCostUsd: number | null;
  latestRunTimestamp: string | null;
}

export interface RunSummaryData {
  schemaVersion: number;
  rows: PreparedRunRow[];
}

export interface ModelQualityAggregateRow {
  /** Canonical, provider-agnostic model family the row is grouped by (e.g. 'glm-5.2'); mirrors
   *  `ModelLeaderboardRow.modelId`. Provider-specific ids collapsed into this row are listed in
   *  `providerModelIds` so provider differences stay investigable. */
  modelId: string;
  thinkingLevel: string;
  experimentAssignment: string;
  runCount: number;
  /** Provider-specific model ids (e.g. 'umans-glm-5.2', 'glm-5.2:cloud') collapsed into this
   *  family row; sorted and deduplicated. Optional for backward compatibility with older
   *  model-quality.json artifacts that predate family grouping. */
  providerModelIds?: string[];
  scoredRunCount: number;
  averageSatisfaction: number | null;
  averageBusyDurationMs: number | null;
  medianBusyDurationMs: number | null;
  p90BusyDurationMs: number | null;
  p99BusyDurationMs: number | null;
  averageToolFailures: number | null;
  verificationRunRate: number | null;
  medianTokenEfficiency: number | null;
  averageContextUtilization: number | null;
  averageCacheHitRatio: number | null;
  firstAttemptSuccessRate: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface ModelQualityData {
  schemaVersion: number;
  rows: ModelQualityAggregateRow[];
  notes: string[];
}

export interface VerificationImpactRow {
  verificationKind: string;
  countBucket: VerificationCountBucket;
  verificationState: VerificationState;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface VerificationImpactSummaryRow {
  verificationState: VerificationState;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface VerificationImpactData {
  schemaVersion: number;
  rows: VerificationImpactRow[];
  summaryRows: VerificationImpactSummaryRow[];
  notes: string[];
}

export interface ToolUsageAggregateRow {
  toolName: string;
  callCount: number;
  failureCount: number;
  executionFailureCount: number;
  verificationProjectFailureCount: number;
  probeFailureCount: number;
  resultIssueCount: number;
  affectedRunCount: number;
  averageSatisfactionWhenUsed: number | null;
  averageSatisfactionWhenUnused: number | null;
}

export interface ToolUsageData {
  schemaVersion: number;
  rows: PreparedToolUsageRow[];
  summaryRows: ToolUsageAggregateRow[];
}

export interface TreatmentComparisonRow {
  promptFamily: string;
  promptHashPrefix: string | null;
  toolSetHashPrefix: string | null;
  skillSetHashPrefix: string | null;
  experimentAssignment: string;
  mixedTreatmentConfig: boolean;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  resolutionCounts: ResolutionCounts;
}

export interface TreatmentComparisonData {
  schemaVersion: number;
  rows: TreatmentComparisonRow[];
}

export interface TimelineRow {
  bucketStart: string;
  runCount: number;
  scoredRunCount: number;
  averageSatisfaction: number | null;
  verificationRunCount: number;
  toolFailureCount: number;
  averageBusyDurationMs: number | null;
  modelMix: Record<string, number>;
}

export interface TimelineData {
  schemaVersion: number;
  rows: TimelineRow[];
}

export interface LeaderboardDimension {
  /** Observed point estimate (mean / rate / normalized efficiency). */
  value: number | null;
  /** 95% confidence-interval lower bound, surfaced as an uncertainty indicator (not used for ranking). */
  lowerBound: number | null;
  /** Empirical-Bayes shrunk estimate toward the cross-model grand mean; this is the value used in the composite. */
  shrunk: number | null;
  n: number;
}

export interface ModelLeaderboardProviderBreakdown {
  /** Provider-specific model id (e.g. 'umans-glm-5.2', 'glm-5.2:cloud') collapsed into this row; distinct per provider so provider differences remain investigable. */
  modelId: string;
  runCount: number;
  scoredRunCount: number;
}

export interface ModelLeaderboardRow {
  /** Canonical, provider-agnostic model family the row is grouped by (e.g. 'glm-5.2'). Provider-specific ids that collapsed into this row are listed in `providers`. */
  modelId: string;
  thinkingLevel: string;
  runCount: number;
  scoredRunCount: number;
  compositeScore: number | null;
  rank: number | null;
  reliabilityFactor: number | null;
  dimensions: {
    satisfaction: LeaderboardDimension;
    resolutionRate: LeaderboardDimension;
    fileChurn: LeaderboardDimension;
    toolReliability: LeaderboardDimension;
    verificationPassRate: LeaderboardDimension;
    tokenEfficiency: LeaderboardDimension;
  };
  /** Median estimated USD cost per run (over completed runs with known pricing); shown separately, not in the composite. */
  medianCostUsd: number | null;
  /** Mean task complexity (0–1) of the model's scored runs; transparency only, not part of the composite. */
  meanTaskComplexity: number | null;
  /** Whether the outcome dimensions were complexity-weighted (mastery) for this row — true when the scored population has task-complexity variance, so difficulty-emphasis actually differentiates runs. */
  difficultyEmphasized: boolean;
  subagentRunCount: number;
  subagentUsageRate: number | null;
  avgSubagentTasksPerRun: number | null;
  medianDurationMs: number | null;
  medianTokenEfficiency: number | null;
  /** Provider-specific entries collapsed into this provider-agnostic row; always ≥1 entry (the '(unknown)' group yields a single '(unknown)' entry). Use this to drill into provider differences. */
  providers: ModelLeaderboardProviderBreakdown[];
}

export interface ModelLeaderboardData {
  schemaVersion: number;
  rows: ModelLeaderboardRow[];
  weights: {
    satisfaction: number;
    resolutionRate: number;
    fileChurn: number;
    toolReliability: number;
    verificationPassRate: number;
    tokenEfficiency: number;
  };
  minimumScoredRuns: number;
  notes: string[];
}

export interface PruningSummary {
  totalEvents: number;
  totalSkillTokensSaved: number;
  totalToolTokensSaved: number;
  medianLlmLatencyMs: number | null;
  modeCounts: Record<string, number>;
  /** Non-miss skill reads after pruning — the baseline denominator for `skillMissRate`. */
  skillReadCount: number;
  /** Agent read a skill the pruner had pruned (a wrong-prune). */
  skillMissCount: number;
  /** Agent read a shadow-pruned skill (shadow mode wrong-prune candidate). */
  shadowMissCandidateCount: number;
  /** Agent called `request_tool` to re-enable a pruned tool — the most direct over-pruning metric. */
  toolRecoveredCount: number;
  /** Denominator for `pruneRecoveredRate`: pruning decisions that pruned ≥1 tool (`toolCountPruned >= 1`). */
  decisionsThatPrunedTools: number;
  /** "Prunes that were recovered" rate = `toolRecoveredCount` / `decisionsThatPrunedTools`.
   *  Per-decision over-pruning signal: of the decisions that removed at least one tool, the fraction
   *  that the agent subsequently undid by re-enabling a pruned tool via `request_tool`. `null` when no
   *  decision pruned a tool (denominator 0). Units differ across numerator/denominator (recovery
   *  *events* vs pruning *decisions*) — a single decision can yield multiple recoveries, so this is a
   *  rate-of-incidence signal, not a strict fraction; treat values >1 as "every tool-pruning decision
   *  was recovered at least once". */
  pruneRecoveredRate: number | null;
  /** Skill over-pruning rate = (`skillMissCount` + `shadowMissCandidateCount`) /
   *  (`skillReadCount` + `skillMissCount` + `shadowMissCandidateCount`): of all skill reads after
   *  pruning, the fraction that hit a pruned skill. `null` when there were no skill reads (denominator 0). */
  skillMissRate: number | null;
}

export interface PruningImpactData {
  schemaVersion: number;
  rows: PreparedPruningEventRow[];
  /** Over-pruning signal rows (skill miss / shadow miss / tool recovered), joined to runs. */
  signalRows: PreparedPruningSignalRow[];
  summary: PruningSummary;
}

/** Per-rule aggregate for tool-result pruning: how often each rule fired and
 *  how many tokens it saved. Rules are counted once per pruned result they
 *  fired on (a result can fire several rules). */
export interface ToolResultPruningByRuleRow {
  rule: string;
  count: number;
  tokensSaved: number;
}

/** Per-tool aggregate for tool-result pruning: which tools produce the most
 *  prunable output noise. */
export interface ToolResultPruningByToolRow {
  toolName: string;
  count: number;
  tokensSaved: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface ToolResultPruningSummary {
  totalEvents: number;
  totalTokensSaved: number;
  totalBeforeTokens: number;
  totalAfterTokens: number;
  byRule: ToolResultPruningByRuleRow[];
  byTool: ToolResultPruningByToolRow[];
}

export interface ToolResultPruningImpactData {
  schemaVersion: number;
  rows: PreparedToolResultPruningRow[];
  summary: ToolResultPruningSummary;
}

/** Agreement signal between agent rating and user satisfaction, computed only over runs
 *  scored by BOTH (an agent review AND a user outcome). */
export interface AgentReviewAgreementSummary {
  /** Mean of |agent_rating - user_satisfaction| over runs scored by both. Null when none scored by both. */
  meanAbsDelta: number | null;
  /** Runs where agent_rating === user_satisfaction. */
  exactCount: number;
  /** Runs where |agent_rating - user_satisfaction| === 1. */
  offByOneCount: number;
  /** Runs where |agent_rating - user_satisfaction| >= 2. */
  offByTwoPlusCount: number;
}

/** Per-model aggregate comparing agent judgement vs user outcome. */
export interface AgentReviewPerModelRow {
  /** Canonical model family the row is grouped by (mirrors model-quality modelId). */
  modelId: string;
  agentReviewCount: number;
  /** Runs in this model group scored by the user (satisfaction != null). */
  userOutcomeCount: number;
  /** Runs in this model group scored by BOTH agent and user. */
  bothScoredCount: number;
  agentAverageRating: number | null;
  userAverageSatisfaction: number | null;
  agentCompletion: { fully: number; partial: number; setback: number };
  agreement: AgentReviewAgreementSummary;
}

/** Multi-reviewer coverage: review counts grouped by reviewer-bucket signature. */
export interface AgentReviewReviewerBucketRow {
  /** Sorted reviewer-bucket signature (e.g. ['medium','small']); empty array when no bucket provenance. */
  reviewerBuckets: string[];
  reviewCount: number;
  averageAgentRating: number | null;
}

/** Site-data payload comparing agent-authored reviews against user outcomes. */
export interface AgentReviewComparisonData {
  schemaVersion: number;
  perModel: AgentReviewPerModelRow[];
  reviewerBucketCoverage: AgentReviewReviewerBucketRow[];
  overall: {
    totalAgentReviews: number;
    totalRunsScoredByUser: number;
    totalScoredByBoth: number;
  };
  notes: string[];
}

export interface BackendErrorByCodeRow {
  errorCode: string;
  count: number;
  affectedRunCount: number;
}

export interface BackendErrorSummary {
  totalErrorEvents: number;
  affectedRunCount: number;
  byErrorCode: BackendErrorByCodeRow[];
}

export interface BackendErrorData {
  schemaVersion: number;
  rows: PreparedBackendErrorRow[];
  summary: BackendErrorSummary;
}

export interface FileExtensionSummaryRow {
  extension: string;
  readCount: number;
  writeCount: number;
  editCount: number;
  totalCount: number;
  affectedRunCount: number;
}

export interface FileExtensionData {
  schemaVersion: number;
  rows: PreparedFileExtensionRow[];
  summary: FileExtensionSummaryRow[];
}

export interface TokenThroughputData {
  schemaVersion: number;
  rows: PreparedTurnThroughputRow[];
  notes: string[];
}

export interface SiteDataBundle {
  manifest: SiteManifest;
  overview: OverviewData;
  runSummary: RunSummaryData;
  modelQuality: ModelQualityData;
  verificationImpact: VerificationImpactData;
  toolUsage: ToolUsageData;
  treatmentComparison: TreatmentComparisonData;
  timeline: TimelineData;
  modelLeaderboard: ModelLeaderboardData;
  pruningImpact: PruningImpactData;
  toolResultPruningImpact: ToolResultPruningImpactData;
  agentReviewComparison: AgentReviewComparisonData;
  backendErrors: BackendErrorData;
  fileExtensions: FileExtensionData;
  tokenThroughput: TokenThroughputData;
}
