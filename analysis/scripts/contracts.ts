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
  VerificationRollup, RunSnapshot as BaseRunSnapshot, TaskBoundaryIntent,
} from '../../shared/run-analytics-contracts.js';

export type {
  AssistantUsage, AuxiliaryLlmUsageKind, AuxiliaryLlmUsageSample, ActiveRunStatus, RunFinalizationReason, ThinkingLevel, PruningMode, InputKind,
  SessionContextFileFactor, SessionToolSnippetFactor,
  SessionSkillFactor, SessionAnalyticsFactors, FunctionalSettingsSnapshot,
  ToolFailureSample, ToolResultIssueSample, TurnThroughputStatus,
  TurnThroughputSample, RetryTimingSample, ToolUsageRollup, FileMutationRollup, FileExtensionRollup,
  VerificationRollup, TaskBoundaryIntent,
};

/** Analysis accepts the stable session-header identity when present in newer exports. */
export type RunSnapshot = BaseRunSnapshot & { sessionId?: string };

export { RUN_ANALYTICS_SCHEMA_VERSION } from '../../shared/run-analytics-contracts.js';

export const SITE_DATA_SCHEMA_VERSION = 7;
export const DATA_MODE_LOCAL_DEFAULT = 'local-default';
export const GENERATOR_VERSION = 'analysis-v2';

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
  'session-review-analytics.json',
  'outcome-correlations.json',
  'evidence-reliability.json',
  'backend-errors.json',
  'file-types.json',
  'token-throughput.json',
  'retry-timing.json',
] as const;

export type SiteDataFileName = (typeof SITE_DATA_FILE_NAMES)[number];

export type VerificationState = 'none' | 'passing' | 'failing';
export type VerificationCountBucket = '0' | '1' | '2-3' | '4+';

export type CriterionOrigin = 'explicit' | 'necessary_implied';
export type CriterionImportance = 'core' | 'supporting' | 'optional';
export type CriterionStatus = 'met' | 'partly_met' | 'unmet' | 'blocked' | 'not_assessable' | 'superseded';
export type CriterionReason = 'none' | 'omitted' | 'attempt_failed' | 'incorrect_result' | 'regression' | 'external_blocker' | 'user_dependency' | 'human_evidence_missing' | 'insufficient_artifact_evidence' | 'unknown';
export type OverallAttainment = 'achieved' | 'mostly_achieved' | 'partly_achieved' | 'not_achieved' | 'not_assessable';
export type ReviewConfidence = 'high' | 'medium' | 'low';

export interface ClassifiedCriterion {
  criterionId: string;
  statement: string;
  origin: CriterionOrigin;
  importance: CriterionImportance;
  taxonomy: { activity: string; surface: string[]; evidenceMode: string[] };
  status: CriterionStatus;
  reason: CriterionReason;
  evidenceRefs: string[];
}

export interface CriterionAttainmentSummary {
  total: number;
  assessable: number;
  controllableDenominator: number;
  met: number;
  partlyMet: number;
  unmet: number;
  blocked: number;
  externalBlocked: number;
  notAssessable: number;
  superseded: number;
  deliveredRate: number;
  controllableRate: number;
}

export interface ReviewProcessVector {
  requirementDiscipline: string;
  verificationDiscipline: string;
  scopeControl: string;
  recovery: string;
  finalClaimAccuracy: string;
}
export interface ReviewEvidenceVector {
  requirements: string;
  artifacts: string;
  execution: string;
  human: string;
  limitations: string[];
}
export interface ReviewerRuntimeReference {
  role: 'proposal' | 'consolidation' | 'component' | 'adjudication';
  reviewerId: string;
  requestedBucket: 'small' | 'medium';
  bucket: 'small' | 'medium' | 'frontier';
  bucketDowngraded: boolean;
  modelId: string;
  provider: string;
  family: string;
  thinkingLevel: string | null;
}
export interface SessionReviewV2Source {
  schemaVersion: number;
  kind: 'production';
  reviewId: string;
  sessionId: string;
  sessionPathAtReview: string;
  identityFallback: boolean;
  rubricVersion: 'session-review-v2.1';
  indexVersion: 'v1';
  reviewedAt: string;
  ledger: ClassifiedCriterion[];
  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  humanCheckStatus: string | null;
  confidence: ReviewConfidence;
  disagreement: { material: boolean; adjudicated: boolean; disputedFields: { field: string; resolution: string }[] };
  reviewers: ReviewerRuntimeReference[];
  diversityAchieved: boolean;
  blindingApplied: boolean;
}

export type SessionReviewV2RejectionReason =
  | 'unsupported_schema'
  | 'unsupported_rubric'
  | 'unsupported_index'
  | 'invalid_identity'
  | 'invalid_payload';

export interface SessionReviewV2IngestionDiagnostics {
  rawProductionCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rejectedByReason: Record<SessionReviewV2RejectionReason, number>;
}

/**
 * Why a review could not be joined to any run. Both reasons are derived from
 * sound identity evidence only — no heuristic/fuzzy path matching is performed.
 *
 * - `no_run_for_identity`: no run in the export carries the review's stable
 *   session identity, and no run sits at the review's exact normalized session
 *   path. The reviewed session is simply absent from this export.
 * - `identity_conflict_at_path`: a run exists at the review's exact normalized
 *   session path but is attributed to a different session identity (a conflicting
 *   stable header, or propagation from a different review). Joining would risk a
 *   false attribution, so the review is deliberately left unmatched.
 */
export type ReviewJoinUnmatchedReason = 'no_run_for_identity' | 'identity_conflict_at_path';

/** Aggregate review↔run join coverage for the session-review-analytics artifact. */
export interface ReviewJoinCoverage {
  totalReviews: number;
  /** Reviews joined to at least one run (joinKey !== 'unmatched'). */
  joinedCount: number;
  /** Reviews that could not be joined to any run. */
  unmatchedCount: number;
  byJoinKey: { session_id: number; path_fallback: number; unmatched: number };
  unmatchedByReason: { no_run_for_identity: number; identity_conflict_at_path: number };
}

export type TranscriptSourceProvenance = 'legacy' | 'configured' | 'portable-export';

export interface HistoricalSessionAttribution {
  modelId: string;
  thinkingLevel: ThinkingLevel | null;
  /** Fraction of successful work attributed to this model+thinking cell. */
  share: number;
  successfulAssistantTurns: number;
  attributedTokens: number;
}

/** Content-free transcript evidence retained while loading an analytics source. */
export interface HistoricalSessionSourceSummary {
  sessionId: string;
  /** Normalized private path used only for canonical/review joins; never emitted in site data. */
  normalizedSessionPath: string;
  startedAt: string | null;
  endedAt: string | null;
  firstUserMessageChars: number | null;
  attributions: HistoricalSessionAttribution[];
  successfulAssistantTurns: number;
  errorAssistantTurns: number;
  abortedAssistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedCostUsd: number | null;
  toolCallCount: number;
  toolErrorCount: number;
  terminalStatus: 'success' | 'error' | 'aborted' | 'none';
  mixedModel: boolean;
  sourceProvenance: TranscriptSourceProvenance[];
}

export interface SourceAnalyticsPayload {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  /** Canonical V2 production reviews keyed by stable session-header ID. */
  sessionReviewsV2?: SessionReviewV2Source[];
  /** Validation accounting for every raw production review presented to this source loader. */
  sessionReviewV2Diagnostics: SessionReviewV2IngestionDiagnostics;
  /** Optional content-free evidence reconstructed from historical session transcripts. */
  historicalSessions?: HistoricalSessionSourceSummary[];
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
  status: ActiveRunStatus;
  startedAt: string;
  startedDay: string;
  updatedAt: string;
  finalizedAt: string | null;
  finalizationReason: RunFinalizationReason | null;
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

/** Prepared non-success result issue row for DuckDB + site-data. */
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

export interface PreparedHistoricalSessionAttribution extends HistoricalSessionAttribution {
  /** Canonical family resolved during preparation via models.json. */
  modelFamily: string;
}

export interface PreparedHistoricalSessionSummary extends Omit<HistoricalSessionSourceSummary, 'normalizedSessionPath' | 'attributions'> {
  attributions: PreparedHistoricalSessionAttribution[];
  /** Privacy-safe join identity. Raw/normalized paths are not part of prepared/public data. */
  sessionPathHash: string;
  /** A canonical run exists for this normalized session path. */
  matchedCanonical: boolean;
  /** Eligible for transcript-only fallback evidence (the inverse of matchedCanonical). */
  transcriptOnly: boolean;
}

export interface PreparedSessionReviewCriterionRow {
  criterionId: string;
  importance: CriterionImportance;
  origin: CriterionOrigin;
  activity: string;
  surfaces: string[];
  evidenceModes: string[];
  status: CriterionStatus;
  reason: CriterionReason;
}

export interface PreparedSessionReviewV2Row {
  cohort: 'v2_production';
  schemaVersion: number;
  reviewId: string;
  sessionId: string;
  identityFallback: boolean;
  rubricVersion: string;
  indexVersion: 'v1';
  reviewedAt: string;
  startedDay: string;
  joinKey: 'session_id' | 'path_fallback' | 'unmatched';
  /** Why the review could not be joined; null unless `joinKey === 'unmatched'`. */
  unmatchedReason: ReviewJoinUnmatchedReason | null;
  runIds: string[];
  modelFamilies: string[];
  criteria: PreparedSessionReviewCriterionRow[];
  attainment: {
    deliveredOverall: OverallAttainment;
    controllableOverall: OverallAttainment;
    core: CriterionAttainmentSummary;
    supporting: CriterionAttainmentSummary;
    optional: CriterionAttainmentSummary;
    qualityIndexV1: number | null;
  };
  criterionCoverage: number | null;
  externalBlockerRate: number | null;
  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  humanCheckStatus: string | null;
  confidence: ReviewConfidence;
  disagreement: SessionReviewV2Source['disagreement'];
  reviewers: ReviewerRuntimeReference[];
  diversityAchieved: boolean;
  blindingApplied: boolean;
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
  sessionReviewsV2: PreparedSessionReviewV2Row[];
  sessionReviewV2Diagnostics: SessionReviewV2IngestionDiagnostics;
  /** Aggregate review↔run join coverage, including unmatched reasons. */
  reviewJoinCoverage: ReviewJoinCoverage;
  /** Privacy-safe historical transcript evidence used by the family-level leaderboard. */
  historicalSessions: PreparedHistoricalSessionSummary[];
}

export interface SiteManifest {
  schemaVersion: number;
  sourceAnalyticsSchemaVersion: number;
  generatedAt: string;
  sourceWorkspaceKey: string;
  sourceExportedAt: string;
  completedRunCount: number;
  openRunCount: number;
  dataMode: typeof DATA_MODE_LOCAL_DEFAULT;
  generatorVersion: string;
}

export interface OverviewData {
  schemaVersion: number;
  totalCompletedRuns: number;
  totalOpenRuns: number;
  medianBusyDurationMs: number | null;
  p90BusyDurationMs: number | null;
  p99BusyDurationMs: number | null;
  verificationRunRate: number | null;
  toolFailureRate: number | null;
  resultIssueRate: number | null;
  medianTokenEfficiency: number | null;
  averageContextUtilization: number | null;
  averageCacheHitRatio: number | null;
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
  /** V2 production reviews attributed to this model family. */
  v2ReviewCount?: number;
  averageBusyDurationMs: number | null;
  medianBusyDurationMs: number | null;
  p90BusyDurationMs: number | null;
  p99BusyDurationMs: number | null;
  averageToolFailures: number | null;
  verificationRunRate: number | null;
  medianTokenEfficiency: number | null;
  averageContextUtilization: number | null;
  averageCacheHitRatio: number | null;
}

export interface ModelQualityData {
  schemaVersion: number;
  cohortLabels: { v2Reviews: 'V2 canonical production reviews' };
  rows: ModelQualityAggregateRow[];
  notes: string[];
}

export interface VerificationImpactRow {
  verificationKind: string;
  countBucket: VerificationCountBucket;
  verificationState: VerificationState;
  runCount: number;
}

export interface VerificationImpactSummaryRow {
  verificationState: VerificationState;
  runCount: number;
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
}

export interface TreatmentComparisonData {
  schemaVersion: number;
  rows: TreatmentComparisonRow[];
}

export interface TimelineRow {
  bucketStart: string;
  runCount: number;
  verificationRunCount: number;
  toolFailureCount: number;
  averageBusyDurationMs: number | null;
  modelMix: Record<string, number>;
}

export interface TimelineData {
  schemaVersion: number;
  rows: TimelineRow[];
}

export type TaskComplexityBand = 'low' | 'medium' | 'high';
export type PreTaskComplexitySignal = 'initialUserMessageChars' | 'attachmentCount' | 'contextFileCount';

export interface LeaderboardDimension {
  /** Observed point estimate (mean / rate / normalized efficiency). */
  value: number | null;
  /** Conservative range-aware one-sided 95% Hoeffding lower bound on the bounded mean; null for absent or invalid observations. Surfaced only as an uncertainty indicator, not used for ranking. */
  lowerBound: number | null;
  /** Fixed-strength regularized/standardized estimate; diagnostic for all dimensions and used in the composite only when its weight is non-zero. */
  shrunk: number | null;
  /** Number of terminal task-group values. Missing optional telemetry on a terminal representative has n=0 and receives the pooled prior. */
  n: number;
}

export interface ModelLeaderboardProviderBreakdown {
  /** Provider-specific model id collapsed into this family row. */
  modelId: string;
  runCount: number;
  /** Distinct transcript-only sessions attributed to this provider-specific id (fractional attribution does not inflate this count). */
  transcriptOnlySessionCount: number;
  /** Fractional transcript evidence mass attributed to this provider-specific id (sum of prepared attribution shares). */
  transcriptEvidenceMass: number;
}

export interface ModelLeaderboardThinkingBreakdown {
  thinkingLevel: string;
  runCount: number;
  /** Fractional transcript attribution mass plus canonical run count. */
  attributionMass: number;
}

export type ModelLeaderboardEvidenceTier = 'review-backed' | 'thin-review' | 'telemetry-only';

export interface ModelLeaderboardScoreInterval {
  lower: number;
  upper: number;
  level: 0.8;
  /** Rank range implied by overlap with other rows' score intervals. */
  bestRank: number;
  worstRank: number;
}

export interface ModelLeaderboardRow {
  /** Canonical, provider-agnostic model family the row is grouped by (e.g. 'glm-5.2'). Provider-specific ids that collapsed into this row are listed in `providers`. */
  modelId: string;
  /** Compatibility display value: family rows combine every thinking level. */
  thinkingLevel: '(all)';
  /** Thinking-level usage remains inspectable after family-level collapse. */
  thinkingLevels: ModelLeaderboardThinkingBreakdown[];
  /** All completed runs recorded in this group, including mixed-model runs retained for transparency. */
  runCount: number;
  /** Distinct task groups represented by eligible V2 reviews. */
  effectiveTaskCount: number;
  /** Completed stable model/treatment runs retained for provenance. */
  attributableRunCount: number;
  /** Distinct task groups among attributable completed stable model/treatment runs. */
  attributableTaskCount: number;
  /** effectiveTaskCount / attributableTaskCount; null when there are no attributable task groups. */
  scoringCoverage: number | null;
  /** Whether task-level V2 review coverage is below the minimum required for ranking. */
  scoringCoverageGateFailed: boolean;
  /** V2-reviewed mixed-model runs excluded from model-attributed scoring. */
  mixedModelExcludedCount: number;
  /** V2-reviewed stable-model runs excluded because treatment changed mid-run. */
  mixedTreatmentExcludedCount: number;
  /** Deduplicated V2 production-review effective mass. */
  v2ReviewCount: number;
  /** Mean unmodified per-session qualityIndexV1 (0–100); no process/coverage multiplier. */
  meanQualityIndexV1: number | null;
  reviewEvidenceCount: number;
  reviewEvidenceMass: number;
  processEvidenceCount: number;
  processEvidenceMass: number;
  canonicalTaskCount: number;
  transcriptOnlySessionCount: number;
  mixedAttributionMass: number;
  evidenceTier: ModelLeaderboardEvidenceTier;
  /** Direct-evidence channel estimates. Null means the family has no direct evidence in that channel. */
  reviewChannelScore: number | null;
  processChannelScore: number | null;
  /** Regularized cohort-relative composite. Non-unknown observed families are always ranked. */
  compositeScore: number | null;
  scoreInterval80: ModelLeaderboardScoreInterval | null;
  /** Regularized score before ex-ante task-complexity standardization. */
  unadjustedCompositeScore: number | null;
  /** Standardized score - unadjustedCompositeScore; remains diagnostic when the band-overlap gate excludes the standardized score. */
  caseMixAdjustment: number | null;
  /** Whether this row's ranked score was standardized over the shared ex-ante task mix. */
  caseMixAdjusted: boolean;
  /** True when a row passing the overall evidence gate is excluded under active case-mix adjustment because any represented target band has too few model-rated tasks. */
  caseMixBandOverlapGateFailed: boolean;
  rank: number | null;
  /** n/(n+k): how much the row's own V2 review evidence determines its regularized estimates. */
  evidenceWeight: number | null;
  /** @deprecated Compatibility alias for evidenceWeight; not a score multiplier. */
  reliabilityFactor: number | null;
  dimensions: {
    fileChurn: LeaderboardDimension;
    toolReliability: LeaderboardDimension;
    verificationPassRate: LeaderboardDimension;
    tokenEfficiency: LeaderboardDimension;
  };
  /** Median complete total estimated USD cost per run. Parent-only estimates are never substituted for unknown totals; not in the composite. */
  medianCostUsd: number | null;
  /** Mean ex-ante task-complexity percentile (0–1) of eligible reviewed sessions. */
  meanPreTaskComplexity: number | null;
  /** Distinct eligible reviewed task-group counts by ex-ante complexity band. */
  taskComplexityBandCounts: Record<TaskComplexityBand, number>;
  /** Share of the common target task mix covered by bands with direct evidence for this model. */
  caseMixOverlap: number | null;
  /** Mean post-treatment workload intensity (0–1) of eligible reviewed runs; descriptive only. */
  meanWorkloadIntensity: number | null;
  /** @deprecated Compatibility alias for meanWorkloadIntensity; not used in the composite. */
  meanTaskComplexity: number | null;
  /** @deprecated Compatibility field retained as false; workload intensity is never score-emphasized. */
  difficultyEmphasized: boolean;
  subagentRunCount: number;
  subagentUsageRate: number | null;
  avgSubagentTasksPerRun: number | null;
  medianDurationMs: number | null;
  medianTokenEfficiency: number | null;
  /** Provider-specific entries collapsed into this provider-agnostic row; always ≥1 entry (the '(unknown)' group yields a single '(unknown)' entry). Use this to drill into provider differences. */
  providers: ModelLeaderboardProviderBreakdown[];
}

export interface ModelLeaderboardCaseMixAdjustment {
  method: 'direct_standardization';
  applied: boolean;
  /** Global distinct reviewed tasks required in each represented band to activate adjustment. */
  minimumRatedTasksPerBand: number;
  /** Model-specific rated tasks required in every represented band for an adjusted row to rank. */
  minimumModelRatedTasksPerBand: number;
  /** Bands below this target-population share do not gate activation; their sparse priors fall back to the overall pool. */
  minimumTargetBandWeight: number;
  targetBandWeights: Record<TaskComplexityBand, number>;
  activeSignals: PreTaskComplexitySignal[];
  initialUserMessageCoverage: number;
  notes: string[];
}

export interface ModelLeaderboardData {
  schemaVersion: number;
  sourceLabels: { review: 'V2 qualityIndexV1'; process: 'Objective runtime process telemetry' };
  rows: ModelLeaderboardRow[];
  sourceWeights: { review: 1; process: 0 };
  sourcePriors: { review: number; process: number };
  sourceLogitSpreads: { review: number; process: number };
  shrinkage: { review: 8; process: 20 };
  weights: {
    fileChurn: number;
    toolReliability: number;
    verificationPassRate: number;
    tokenEfficiency: number;
  };
  /** Rank gate expressed as distinct reviewed task groups. */
  minimumEffectiveTasks: number;
  /** Minimum effectiveTaskCount / attributableTaskCount required for ranking. */
  minimumTaskScoringCoverage: number;
  caseMix: ModelLeaderboardCaseMixAdjustment;
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
  /** Agent used request_capability to re-enable a hidden tool — a direct over-pruning metric. */
  toolRecoveredCount: number;
  /** Denominator for `pruneRecoveredRate`: pruning decisions that pruned ≥1 tool (`toolCountPruned >= 1`). */
  decisionsThatPrunedTools: number;
  /** "Prunes that were recovered" rate = `toolRecoveredCount` / `decisionsThatPrunedTools`.
   *  Per-decision over-pruning signal: of the decisions that removed at least one tool, the fraction
   *  that the agent subsequently undid by re-enabling a hidden tool via request_capability. `null` when no
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

export interface CountByValueRow { value: string; count: number }
export interface SessionReviewAnalyticsData {
  schemaVersion: number;
  cohort: 'v2_production';
  cohortLabel: 'V2 canonical production reviews';
  indexVersion: 'v1';
  rows: PreparedSessionReviewV2Row[];
  diagnostics: SessionReviewV2IngestionDiagnostics;
  joinCoverage: ReviewJoinCoverage;
  summary: {
    reviewCount: number;
    stableIdentityCount: number;
    identityFallbackCount: number;
    joinedReviewCount: number;
    qualityIndexCount: number;
    notAssessableReviewCount: number;
    meanQualityIndexV1: number | null;
    criterionCoverage: number | null;
    externalBlockerRate: number | null;
    deliveredOverall: CountByValueRow[];
    controllableOverall: CountByValueRow[];
    confidence: CountByValueRow[];
  };
  criteria: {
    total: number;
    assessable: number;
    byImportance: CountByValueRow[];
    byStatus: CountByValueRow[];
    byReason: CountByValueRow[];
    byActivity: CountByValueRow[];
    bySurface: CountByValueRow[];
    byEvidenceMode: CountByValueRow[];
  };
  process: Record<keyof ReviewProcessVector, CountByValueRow[]>;
  evidence: Record<'requirements' | 'artifacts' | 'execution' | 'human', CountByValueRow[]> & { limitationCount: number };
  disagreement: { materialCount: number; adjudicatedCount: number; disputedFieldCount: number; byResolution: CountByValueRow[] };
  reviewers: { callCount: number; bucketDowngradeCount: number; diversityAchievedCount: number; byRole: CountByValueRow[]; byRequestedBucket: CountByValueRow[]; byEffectiveBucket: CountByValueRow[]; byModel: CountByValueRow[]; byProvider: CountByValueRow[]; byFamily: CountByValueRow[] };
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

export interface RetryTimingData {
  schemaVersion: number;
  rows: PreparedRetryTimingRow[];
  notes: string[];
}

// ─── Outcome-correlation bundle (observational, not causal) ─────────────────

/** Behavioral dimensions qualityIndexV1 is compared against. */
export type OutcomeCorrelationDimensionName =
  | 'verificationUsage'
  | 'compaction'
  | 'thinkingLevel'
  | 'promptSizeBand'
  | 'pruningMode'
  | 'subagentParentModel';

export interface OutcomeCorrelationGroup {
  /** Behavioral group value (e.g. 'verified', 'high', 'auto', 'true'). */
  value: string;
  /** Reviewed sessions (n) in this group. */
  sessionCount: number;
  meanQualityIndexV1: number;
  /** 95% Student-t confidence interval for the group mean; null when n < 2. */
  meanCi95: { lower: number; upper: number; level: 0.95 } | null;
}

export interface OutcomeCorrelationDifference {
  /** Reference group (largest tracked sample). */
  referenceValue: string;
  /** Comparison group. */
  comparisonValue: string;
  /** Comparison mean − reference mean. */
  observedMeanDifference: number;
  /** 95% Welch (unequal-variance) t confidence interval for the difference; null when either group has n < 2. */
  differenceCi95: { lower: number; upper: number; level: 0.95 } | null;
  referenceSessionCount: number;
  comparisonSessionCount: number;
}

export interface OutcomeCorrelationDimension {
  dimension: OutcomeCorrelationDimensionName;
  /** How the behavior was derived (observational grouping, never a controlled treatment). */
  description: string;
  /** Reviewed sessions contributing a tracked (non-untracked) group value. */
  includedSessionCount: number;
  /** Reviewed sessions whose behavior was untracked for this dimension. */
  untrackedSessionCount: number;
  groups: OutcomeCorrelationGroup[];
  /** Observed mean differences vs the reference group (largest tracked sample). Empty for <2 tracked groups. */
  differences: OutcomeCorrelationDifference[];
}

export interface OutcomeCorrelationData {
  schemaVersion: number;
  cohortLabel: string;
  /** Outcome metric under comparison. */
  outcomeMetric: 'qualityIndexV1';
  /** The canonical V2 quality formula is unchanged; this bundle only reads the index for observational grouping. */
  outcomeSource: 'canonical_v2_qualityIndexV1_unchanged';
  /** Unit of analysis: one reviewed session (latest review per stable identity) with a non-null qualityIndexV1 that joined at least one run. */
  unitOfAnalysis: string;
  /** Analyzable cohort: reviewed sessions with a non-null qualityIndexV1 that joined at least one run. */
  analyzableSessionCount: number;
  /** Reviewed sessions with a non-null qualityIndexV1 that joined no run (excluded from every dimension). */
  unmatchedExcludedCount: number;
  dimensions: OutcomeCorrelationDimension[];
  notes: string[];
}

// ─── Evidence-reliability diagnostics ─────────────────────────────────────

export interface EvidenceReliabilityFamilyShare {
  family: string;
  /** Fractional-summed reviewed-session mass attributed to this family (equal-split across a session's families). */
  reviewedSessionCount: number;
  /** Share of all attributed reviewed sessions (0–1). */
  share: number;
}

export interface EvidenceReliabilityData {
  schemaVersion: number;
  cohortLabel: string;
  /** Reviews with a non-null qualityIndexV1 (the cohort the diagnostics qualify). */
  reviewedSessionCount: number;
  /** Reviewed sessions attributed to at least one model family via joined runs. */
  attributedSessionCount: number;
  /** Reviewed sessions with no attributable family (unmatched or no family on joined runs). */
  unattributedCount: number;
  /** Distinct model families with at least one attributed reviewed session. */
  effectiveReviewedFamilies: number;
  /** Most-attributed family and its share of attributed reviewed sessions; null when nothing is attributed. */
  dominantFamily: { family: string; share: number; reviewedSessionCount: number } | null;
  ceilingSaturation: {
    /** Share of reviewed sessions at the exact qualityIndexV1 ceiling (100). */
    perfectRate: number;
    /** Share in the top 'achieved' band ([85, 100]). */
    achievedBandRate: number;
    medianQualityIndexV1: number | null;
    /** Distinct qualityIndexV1 values observed (1 means the index does not discriminate). */
    distinctQualityIndexValues: number;
  };
  familyShares: EvidenceReliabilityFamilyShare[];
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
  sessionReviewAnalytics: SessionReviewAnalyticsData;
  backendErrors: BackendErrorData;
  fileExtensions: FileExtensionData;
  tokenThroughput: TokenThroughputData;
  retryTiming: RetryTimingData;
  outcomeCorrelations: OutcomeCorrelationData;
  evidenceReliability: EvidenceReliabilityData;
}
