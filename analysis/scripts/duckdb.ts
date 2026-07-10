import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PreparedAnalyticsData,
  PreparedAgentReviewRow,
  PreparedBackendErrorRow,
  PreparedFileExtensionRow,
  PreparedPruningEventRow,
  PreparedPruningSignalRow,
  PreparedToolResultPruningRow,
  PreparedWarmBashRewriteRow,
  PreparedWarmBashSummaryRow,
  PreparedRunRow,
  PreparedToolFailureRow,
  PreparedToolUsageRow,
  PreparedTurnThroughputRow,
  PreparedVerificationUsageRow,
} from './contracts.ts';
import { ensureDir, sqlStringLiteral, writeJsonFile } from './fs-utils.ts';
import { parseJsonOrThrow } from '../../shared/error-message.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const QUERY_FILE_BY_NAME = {
  core_runs: path.resolve(SCRIPT_DIR, '../queries/001_core_runs.sql'),
  model_quality: path.resolve(SCRIPT_DIR, '../queries/model_quality.sql'),
  verification_impact: path.resolve(SCRIPT_DIR, '../queries/verification_impact.sql'),
  tool_usage: path.resolve(SCRIPT_DIR, '../queries/tool_usage.sql'),
  tool_failures: path.resolve(SCRIPT_DIR, '../queries/tool_failures.sql'),
  treatment_comparison: path.resolve(SCRIPT_DIR, '../queries/treatment_comparison.sql'),
  timeline: path.resolve(SCRIPT_DIR, '../queries/timeline.sql'),
  pruning_prepass_cost: path.resolve(SCRIPT_DIR, '../queries/pruning_prepass_cost.sql'),
  warm_bash: path.resolve(SCRIPT_DIR, '../queries/warm_bash.sql'),
} as const;

export type NamedQuery = keyof typeof QUERY_FILE_BY_NAME;

interface DuckDbRunRow {
  run_id: string;
  task_group_id: string;
  session_path_hash: string;
  status: string;
  scored: boolean;
  started_at: string;
  started_day: string;
  updated_at: string;
  finalized_at: string | null;
  finalization_reason: string | null;
  resolution: string | null;
  satisfaction: number | null;
  model_id: string | null;
  model_family: string | null;
  provider: string | null;
  thinking_level: string | null;
  mixed_model_config: boolean;
  mixed_treatment_config: boolean;
  experiment_assignment: string | null;
  prompt_family: string | null;
  prompt_hash_prefix: string | null;
  prompt_captured_at: string | null;
  tool_set_hash_prefix: string | null;
  skill_set_hash_prefix: string | null;
  active_extensions: string[];
  selected_tool_count: number;
  skill_count: number;
  context_file_count: number;
  prompt_guideline_count: number;
  send_count: number;
  assistant_turn_count: number;
  assistant_turn_duration_ms: number;
  busy_duration_ms: number;
  busy_period_count: number;
  interrupted_count: number;
  message_edit_count: number;
  truncated_after_count: number;
  backend_error_count: number;
  context_tokens: number | null;
  context_limit: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  token_reported_turn_count: number;
  filesystem_path_ref_count: number;
  image_input_count: number;
  image_input_bytes: number;
  unsupported_input_count: number;
  input_kinds_used: string[];
  tool_call_count: number;
  tool_failure_count: number;
  result_issue_count: number;
  subagent_call_count: number;
  subagent_task_count: number;
  subagent_agent_count: number;
  subagent_scored_task_count: number;
  subagent_mean_precision: number | null;
  subagent_mean_creativity: number | null;
  subagent_mean_reasoning: number | null;
  subagent_mean_thoroughness: number | null;
  subagent_max_precision: number | null;
  subagent_max_creativity: number | null;
  subagent_max_reasoning: number | null;
  subagent_max_thoroughness: number | null;
  subagent_composite_mean: number | null;
  verification_total_count: number;
  verification_failure_count: number;
  verification_state: string;
  verification_count_bucket: string;
  verification_test_count: number;
  verification_build_count: number;
  verification_lint_count: number;
  verification_typecheck_count: number;
  verification_format_count: number;
  verification_other_count: number;
  file_write_count: number;
  file_edit_count: number;
  file_delete_count: number;
  file_rename_count: number;
  touched_file_count: number;
  line_additions: number;
  line_deletions: number;
  line_modifications: number;
  line_mutation_total: number;
  token_efficiency: number | null;
  context_utilization: number | null;
  cache_hit_ratio: number | null;
  first_attempt_success: boolean;
  estimated_cost_usd: number | null;
  // ── Fields below were added after the initial DuckDB export layer and must be
  //    kept in sync with `PreparedRunRow` (contracts.ts) + `toDuckDbRunRow` +
  //    `runsTableSchema()`. They are appended here (and in the mapper/schema) so
  //    the positional `INSERT ... SELECT * FROM read_json_auto` column order is
  //    preserved — see `populateTableFromJson`.
  subagent_input_tokens: number;
  subagent_output_tokens: number;
  subagent_cache_read_tokens: number;
  subagent_cache_write_tokens: number;
  subagent_estimated_cost_usd: number | null;
  total_estimated_cost_usd: number | null;
  compaction_count: number;
  auto_retry_count: number;
  edit_revisit_rate: number | null;
  files_reviewed_count: number;
  read_revisit_rate: number | null;
}

interface DuckDbToolUsageRow {
  run_id: string;
  tool_name: string;
  call_count: number;
  failure_count: number;
  execution_failure_count: number;
  verification_project_failure_count: number;
  probe_failure_count: number;
  result_issue_count: number;
  total_duration_ms: number;
  mean_duration_ms: number | null;
  started_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  mixed_treatment_config: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: string | null;
}

interface DuckDbToolFailureRow {
  run_id: string;
  tool_name: string;
  failure_kind: string;
  count: number;
  exit_code: number | null;
  error_excerpt: string | null;
  verification_kinds: string[];
  started_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  mixed_treatment_config: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: string | null;
}

interface DuckDbVerificationUsageRow {
  run_id: string;
  kind: string;
  count: number;
  run_had_any_failure: boolean;
  started_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  mixed_treatment_config: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: string | null;
}

interface DuckDbBackendErrorRow {
  run_id: string;
  error_code: string;
  count: number;
  started_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  scored: boolean;
  satisfaction: number | null;
  resolution: string | null;
}

interface DuckDbFileExtensionRow {
  run_id: string;
  extension: string;
  read_count: number;
  write_count: number;
  edit_count: number;
  total_count: number;
  started_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  mixed_treatment_config: boolean;
  scored: boolean;
  satisfaction: number | null;
  resolution: string | null;
}

interface DuckDbPruningEventRow {
  run_id: string;
  session_path_hash: string;
  timestamp: string;
  started_day: string;
  pruning_mode: string;
  query: string;
  llm_model: string;
  llm_thinking_level: string;
  llm_latency_ms: number;
  skill_count_kept: number;
  skill_count_pruned: number;
  skill_count_total: number;
  skill_tokens_saved: number;
  skill_tokens_original: number;
  tool_count_kept: number;
  tool_count_pruned: number;
  tool_count_total: number;
  tool_tokens_saved: number;
  tool_tokens_original: number;
  kept_skill_names: string[];
  pruned_skill_names: string[];
  kept_tool_names: string[];
  pruned_tool_names: string[];
  prepass_input_tokens: number | null;
  prepass_output_tokens: number | null;
  prepass_cache_read_tokens: number | null;
  prepass_cache_write_tokens: number | null;
  prepass_input_estimate_tokens: number | null;
  code_version: string | null;
}

interface DuckDbPruningSignalRow {
  run_id: string;
  session_path_hash: string;
  timestamp: string;
  started_day: string;
  event: string;
  skill_name: string | null;
  tool_name: string | null;
}

interface DuckDbToolResultPruningRow {
  run_id: string;
  session_path_hash: string;
  timestamp: string;
  started_day: string;
  tool_name: string;
  rules: string[];
  before_tokens: number;
  after_tokens: number;
  tokens_saved: number;
}

interface DuckDbWarmBashRewriteRow {
  run_id: string;
  session_path_hash: string;
  timestamp: string;
  started_day: string;
  before: string;
  after: string;
}

interface DuckDbWarmBashSummaryRow {
  run_id: string;
  session_path_hash: string;
  timestamp: string;
  started_day: string;
  fast_path: number;
  warm: number;
  fallback: number;
  pool_size: number;
  warmup_failures: number;
  auto_prune_enabled: boolean;
  fast_path_enabled: boolean;
  gnu_grep: boolean;
}

interface DuckDbAgentReviewRow {
  run_id: string;
  session_path_hash: string;
  task_group_id: string;
  recorded_at: string;
  evaluated_at: string;
  started_day: string;
  model_family: string | null;
  agent_rating: number;
  agent_completion: string;
  agent_done: boolean;
  reviewer_buckets: string[];
  reviewer_count: number;
  user_satisfaction: number | null;
}

interface DuckDbTurnThroughputRow {
  run_id: string;
  ended_at: string;
  started_day: string;
  model_id: string | null;
  thinking_level: string | null;
  experiment_assignment: string | null;
  output_tokens: number;
  generation_duration_ms: number;
  concurrent_busy_sessions: number;
  status: string;
  tokens_per_second: number | null;
  turn_latency_ms: number | null;
  overhead_ms: number | null;
  provider_latency_ms: number | null;
}

function toDuckDbRunRow(row: PreparedRunRow): DuckDbRunRow {
  return {
    run_id: row.runId,
    task_group_id: row.taskGroupId,
    session_path_hash: row.sessionPathHash,
    status: row.status,
    scored: row.scored,
    started_at: row.startedAt,
    started_day: row.startedDay,
    updated_at: row.updatedAt,
    finalized_at: row.finalizedAt,
    finalization_reason: row.finalizationReason,
    resolution: row.resolution,
    satisfaction: row.satisfaction,
    model_id: row.modelId,
    model_family: row.modelFamily,
    provider: row.provider,
    thinking_level: row.thinkingLevel,
    mixed_model_config: row.mixedModelConfig,
    mixed_treatment_config: row.mixedTreatmentConfig,
    experiment_assignment: row.experimentAssignment,
    prompt_family: row.promptFamily,
    prompt_hash_prefix: row.promptHashPrefix,
    prompt_captured_at: row.promptCapturedAt,
    tool_set_hash_prefix: row.toolSetHashPrefix,
    skill_set_hash_prefix: row.skillSetHashPrefix,
    active_extensions: row.activeExtensions,
    selected_tool_count: row.selectedToolCount,
    skill_count: row.skillCount,
    context_file_count: row.contextFileCount,
    prompt_guideline_count: row.promptGuidelineCount,
    send_count: row.sendCount,
    assistant_turn_count: row.assistantTurnCount,
    assistant_turn_duration_ms: row.assistantTurnDurationMs,
    busy_duration_ms: row.busyDurationMs,
    busy_period_count: row.busyPeriodCount,
    interrupted_count: row.interruptedCount,
    message_edit_count: row.messageEditCount,
    truncated_after_count: row.truncatedAfterCount,
    backend_error_count: row.backendErrorCount,
    context_tokens: row.contextTokens,
    context_limit: row.contextLimit,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    token_reported_turn_count: row.tokenReportedTurnCount,
    filesystem_path_ref_count: row.filesystemPathRefCount,
    image_input_count: row.imageInputCount,
    image_input_bytes: row.imageInputBytes,
    unsupported_input_count: row.unsupportedInputCount,
    input_kinds_used: row.inputKindsUsed,
    tool_call_count: row.toolCallCount,
    tool_failure_count: row.toolFailureCount,
    result_issue_count: row.resultIssueCount,
    subagent_call_count: row.subagentCallCount,
    subagent_task_count: row.subagentTaskCount,
    subagent_agent_count: row.subagentAgentCount,
    subagent_scored_task_count: row.subagentScoredTaskCount,
    subagent_mean_precision: row.subagentMeanPrecision,
    subagent_mean_creativity: row.subagentMeanCreativity,
    subagent_mean_reasoning: row.subagentMeanReasoning,
    subagent_mean_thoroughness: row.subagentMeanThoroughness,
    subagent_max_precision: row.subagentMaxPrecision,
    subagent_max_creativity: row.subagentMaxCreativity,
    subagent_max_reasoning: row.subagentMaxReasoning,
    subagent_max_thoroughness: row.subagentMaxThoroughness,
    subagent_composite_mean: row.subagentCompositeMean,
    verification_total_count: row.verificationTotalCount,
    verification_failure_count: row.verificationFailureCount,
    verification_state: row.verificationState,
    verification_count_bucket: row.verificationCountBucket,
    verification_test_count: row.verificationCountsByKind.test,
    verification_build_count: row.verificationCountsByKind.build,
    verification_lint_count: row.verificationCountsByKind.lint,
    verification_typecheck_count: row.verificationCountsByKind.typecheck,
    verification_format_count: row.verificationCountsByKind.format,
    verification_other_count: row.verificationCountsByKind.other,
    file_write_count: row.fileWriteCount,
    file_edit_count: row.fileEditCount,
    file_delete_count: row.fileDeleteCount,
    file_rename_count: row.fileRenameCount,
    touched_file_count: row.touchedFileCount,
    line_additions: row.lineAdditions,
    line_deletions: row.lineDeletions,
    line_modifications: row.lineModifications,
    line_mutation_total: row.lineMutationTotal,
    token_efficiency: row.tokenEfficiency,
    context_utilization: row.contextUtilization,
    cache_hit_ratio: row.cacheHitRatio,
    first_attempt_success: row.firstAttemptSuccess,
    estimated_cost_usd: row.estimatedCostUsd,
    subagent_input_tokens: row.subagentInputTokens,
    subagent_output_tokens: row.subagentOutputTokens,
    subagent_cache_read_tokens: row.subagentCacheReadTokens,
    subagent_cache_write_tokens: row.subagentCacheWriteTokens,
    subagent_estimated_cost_usd: row.subagentEstimatedCostUsd,
    total_estimated_cost_usd: row.totalEstimatedCostUsd,
    compaction_count: row.compactionCount,
    auto_retry_count: row.autoRetryCount,
    edit_revisit_rate: row.editRevisitRate,
    files_reviewed_count: row.filesReviewedCount,
    read_revisit_rate: row.readRevisitRate,
  };
}

function toDuckDbToolUsageRow(row: PreparedToolUsageRow): DuckDbToolUsageRow {
  return {
    run_id: row.runId,
    tool_name: row.toolName,
    call_count: row.callCount,
    failure_count: row.failureCount,
    execution_failure_count: row.executionFailureCount,
    verification_project_failure_count: row.verificationProjectFailureCount,
    probe_failure_count: row.probeFailureCount,
    result_issue_count: row.resultIssueCount,
    total_duration_ms: row.totalDurationMs,
    mean_duration_ms: row.meanDurationMs,
    started_at: row.startedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    mixed_treatment_config: row.mixedTreatmentConfig,
    scored: row.scored,
    satisfaction: row.satisfaction,
    resolution: row.resolution,
  };
}

function toDuckDbToolFailureRow(row: PreparedToolFailureRow): DuckDbToolFailureRow {
  return {
    run_id: row.runId,
    tool_name: row.toolName,
    failure_kind: row.failureKind,
    count: row.count,
    exit_code: row.exitCode,
    error_excerpt: row.errorExcerpt,
    verification_kinds: row.verificationKinds,
    started_at: row.startedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    mixed_treatment_config: row.mixedTreatmentConfig,
    scored: row.scored,
    satisfaction: row.satisfaction,
    resolution: row.resolution,
  };
}

function toDuckDbVerificationUsageRow(row: PreparedVerificationUsageRow): DuckDbVerificationUsageRow {
  return {
    run_id: row.runId,
    kind: row.kind,
    count: row.count,
    run_had_any_failure: row.runHadAnyFailure,
    started_at: row.startedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    mixed_treatment_config: row.mixedTreatmentConfig,
    scored: row.scored,
    satisfaction: row.satisfaction,
    resolution: row.resolution,
  };
}

function toDuckDbBackendErrorRow(row: PreparedBackendErrorRow): DuckDbBackendErrorRow {
  return {
    run_id: row.runId,
    error_code: row.errorCode,
    count: row.count,
    started_at: row.startedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    scored: row.scored,
    satisfaction: row.satisfaction,
    resolution: row.resolution,
  };
}

function toDuckDbFileExtensionRow(row: PreparedFileExtensionRow): DuckDbFileExtensionRow {
  return {
    run_id: row.runId,
    extension: row.extension,
    read_count: row.readCount,
    write_count: row.writeCount,
    edit_count: row.editCount,
    total_count: row.totalCount,
    started_at: row.startedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    mixed_treatment_config: row.mixedTreatmentConfig,
    scored: row.scored,
    satisfaction: row.satisfaction,
    resolution: row.resolution,
  };
}

function toDuckDbPruningEventRow(row: PreparedPruningEventRow): DuckDbPruningEventRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    timestamp: row.timestamp,
    started_day: row.startedDay,
    pruning_mode: row.pruningMode,
    query: row.query,
    llm_model: row.llmModel,
    llm_thinking_level: row.llmThinkingLevel,
    llm_latency_ms: row.llmLatencyMs,
    skill_count_kept: row.skillCountKept,
    skill_count_pruned: row.skillCountPruned,
    skill_count_total: row.skillCountTotal,
    skill_tokens_saved: row.skillTokensSaved,
    skill_tokens_original: row.skillTokensOriginal,
    tool_count_kept: row.toolCountKept,
    tool_count_pruned: row.toolCountPruned,
    tool_count_total: row.toolCountTotal,
    tool_tokens_saved: row.toolTokensSaved,
    tool_tokens_original: row.toolTokensOriginal,
    kept_skill_names: row.keptSkillNames,
    pruned_skill_names: row.prunedSkillNames,
    kept_tool_names: row.keptToolNames,
    pruned_tool_names: row.prunedToolNames,
    prepass_input_tokens: row.prepassInputTokens ?? null,
    prepass_output_tokens: row.prepassOutputTokens ?? null,
    prepass_cache_read_tokens: row.prepassCacheReadTokens ?? null,
    prepass_cache_write_tokens: row.prepassCacheWriteTokens ?? null,
    prepass_input_estimate_tokens: row.prepassInputEstimateTokens ?? null,
    code_version: row.codeVersion ?? null,
  };
}

function toDuckDbPruningSignalRow(row: PreparedPruningSignalRow): DuckDbPruningSignalRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    timestamp: row.timestamp,
    started_day: row.startedDay,
    event: row.event,
    skill_name: row.skillName,
    tool_name: row.toolName,
  };
}

function toDuckDbToolResultPruningRow(row: PreparedToolResultPruningRow): DuckDbToolResultPruningRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    timestamp: row.timestamp,
    started_day: row.startedDay,
    tool_name: row.toolName,
    rules: row.rules,
    before_tokens: row.beforeTokens,
    after_tokens: row.afterTokens,
    tokens_saved: row.tokensSaved,
  };
}

function toDuckDbWarmBashRewriteRow(row: PreparedWarmBashRewriteRow): DuckDbWarmBashRewriteRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    timestamp: row.timestamp,
    started_day: row.startedDay,
    before: row.before,
    after: row.after,
  };
}

function toDuckDbWarmBashSummaryRow(row: PreparedWarmBashSummaryRow): DuckDbWarmBashSummaryRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    timestamp: row.timestamp,
    started_day: row.startedDay,
    fast_path: row.fastPath,
    warm: row.warm,
    fallback: row.fallback,
    pool_size: row.poolSize,
    warmup_failures: row.warmupFailures,
    auto_prune_enabled: row.autoPruneEnabled,
    fast_path_enabled: row.fastPathEnabled,
    gnu_grep: row.gnuGrep,
  };
}

function toDuckDbAgentReviewRow(row: PreparedAgentReviewRow): DuckDbAgentReviewRow {
  return {
    run_id: row.runId,
    session_path_hash: row.sessionPathHash,
    task_group_id: row.taskGroupId,
    recorded_at: row.recordedAt,
    evaluated_at: row.evaluatedAt,
    started_day: row.startedDay,
    model_family: row.modelFamily,
    agent_rating: row.agentRating,
    agent_completion: row.agentCompletion,
    agent_done: row.agentDone,
    reviewer_buckets: row.reviewerBuckets,
    reviewer_count: row.reviewerCount,
    user_satisfaction: row.userSatisfaction,
  };
}

function toDuckDbTurnThroughputRow(row: PreparedTurnThroughputRow): DuckDbTurnThroughputRow {
  return {
    run_id: row.runId,
    ended_at: row.endedAt,
    started_day: row.startedDay,
    model_id: row.modelId,
    thinking_level: row.thinkingLevel,
    experiment_assignment: row.experimentAssignment,
    output_tokens: row.outputTokens,
    generation_duration_ms: row.generationDurationMs,
    concurrent_busy_sessions: row.concurrentBusySessions,
    status: row.status,
    tokens_per_second: row.tokensPerSecond,
    turn_latency_ms: row.turnLatencyMs,
    overhead_ms: row.overheadMs,
    provider_latency_ms: row.providerLatencyMs,
  };
}

export async function writeDuckDbStagingExports(exportsDir: string, prepared: PreparedAnalyticsData): Promise<{
  runsPath: string;
  toolUsagePath: string;
  verificationUsagePath: string;
  toolFailuresPath: string;
  backendErrorsPath: string;
  fileExtensionsPath: string;
  pruningEventsPath: string;
  pruningSignalsPath: string;
  toolResultPruningPath: string;
  warmBashRewritesPath: string;
  warmBashSummariesPath: string;
  agentReviewsPath: string;
  turnThroughputPath: string;
}> {
  await ensureDir(exportsDir);
  const runsPath = path.join(exportsDir, 'runs.json');
  const toolUsagePath = path.join(exportsDir, 'tool-usage.json');
  const toolFailuresPath = path.join(exportsDir, 'tool-failures.json');
  const verificationUsagePath = path.join(exportsDir, 'verification-usage.json');
  const backendErrorsPath = path.join(exportsDir, 'backend-errors.json');
  const fileExtensionsPath = path.join(exportsDir, 'file-extensions.json');
  const pruningEventsPath = path.join(exportsDir, 'pruning-events.json');
  const pruningSignalsPath = path.join(exportsDir, 'pruning-signals.json');
  const toolResultPruningPath = path.join(exportsDir, 'tool-result-pruning.json');
  const warmBashRewritesPath = path.join(exportsDir, 'warm-bash-rewrites.json');
  const warmBashSummariesPath = path.join(exportsDir, 'warm-bash-summaries.json');
  const agentReviewsPath = path.join(exportsDir, 'agent-reviews.json');
  const turnThroughputPath = path.join(exportsDir, 'turn-throughput.json');

  await Promise.all([
    writeJsonFile(runsPath, prepared.runs.map(toDuckDbRunRow)),
    writeJsonFile(toolUsagePath, prepared.toolUsage.map(toDuckDbToolUsageRow)),
    writeJsonFile(toolFailuresPath, prepared.toolFailures.map(toDuckDbToolFailureRow)),
    writeJsonFile(verificationUsagePath, prepared.verificationUsage.map(toDuckDbVerificationUsageRow)),
    writeJsonFile(backendErrorsPath, prepared.backendErrors.map(toDuckDbBackendErrorRow)),
    writeJsonFile(fileExtensionsPath, prepared.fileExtensions.map(toDuckDbFileExtensionRow)),
    writeJsonFile(pruningEventsPath, prepared.pruningEvents.map(toDuckDbPruningEventRow)),
    writeJsonFile(pruningSignalsPath, prepared.pruningSignals.map(toDuckDbPruningSignalRow)),
    writeJsonFile(toolResultPruningPath, prepared.toolResultPruning.map(toDuckDbToolResultPruningRow)),
    writeJsonFile(warmBashRewritesPath, prepared.warmBashRewrites.map(toDuckDbWarmBashRewriteRow)),
    writeJsonFile(warmBashSummariesPath, prepared.warmBashSummaries.map(toDuckDbWarmBashSummaryRow)),
    writeJsonFile(agentReviewsPath, prepared.agentReviews.map(toDuckDbAgentReviewRow)),
    writeJsonFile(turnThroughputPath, prepared.turnThroughput.map(toDuckDbTurnThroughputRow)),
  ]);

  return { runsPath, toolUsagePath, toolFailuresPath, verificationUsagePath, backendErrorsPath, fileExtensionsPath, pruningEventsPath, pruningSignalsPath, toolResultPruningPath, warmBashRewritesPath, warmBashSummariesPath, agentReviewsPath, turnThroughputPath };
}

async function openDuckDb(dbPath: string) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  return { instance, connection };
}

async function closeDuckDb(instance: unknown, connection: unknown): Promise<void> {
  const connectionWithClose = connection as { disconnectSync?: () => void };
  const instanceWithClose = instance as { closeSync?: () => void };
  connectionWithClose.disconnectSync?.();
  instanceWithClose.closeSync?.();
}

async function runStatements(connection: { run: (sql: string) => Promise<unknown> }, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await connection.run(statement);
  }
}

function runsTableSchema(): string {
  return `
CREATE TABLE runs (
  run_id VARCHAR,
  task_group_id VARCHAR,
  session_path_hash VARCHAR,
  status VARCHAR,
  scored BOOLEAN,
  started_at TIMESTAMP,
  started_day DATE,
  updated_at TIMESTAMP,
  finalized_at TIMESTAMP,
  finalization_reason VARCHAR,
  resolution VARCHAR,
  satisfaction DOUBLE,
  model_id VARCHAR,
  model_family VARCHAR,
  provider VARCHAR,
  thinking_level VARCHAR,
  mixed_model_config BOOLEAN,
  mixed_treatment_config BOOLEAN,
  experiment_assignment VARCHAR,
  prompt_family VARCHAR,
  prompt_hash_prefix VARCHAR,
  prompt_captured_at TIMESTAMP,
  tool_set_hash_prefix VARCHAR,
  skill_set_hash_prefix VARCHAR,
  active_extensions VARCHAR[],
  selected_tool_count INTEGER,
  skill_count INTEGER,
  context_file_count INTEGER,
  prompt_guideline_count INTEGER,
  send_count INTEGER,
  assistant_turn_count INTEGER,
  assistant_turn_duration_ms BIGINT,
  busy_duration_ms BIGINT,
  busy_period_count INTEGER,
  interrupted_count INTEGER,
  message_edit_count INTEGER,
  truncated_after_count INTEGER,
  backend_error_count INTEGER,
  context_tokens BIGINT,
  context_limit BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  token_reported_turn_count INTEGER,
  filesystem_path_ref_count INTEGER,
  image_input_count INTEGER,
  image_input_bytes BIGINT,
  unsupported_input_count INTEGER,
  input_kinds_used VARCHAR[],
  tool_call_count INTEGER,
  tool_failure_count INTEGER,
  result_issue_count INTEGER,
  subagent_call_count INTEGER,
  subagent_task_count INTEGER,
  subagent_agent_count INTEGER,
  subagent_scored_task_count INTEGER,
  subagent_mean_precision DOUBLE,
  subagent_mean_creativity DOUBLE,
  subagent_mean_reasoning DOUBLE,
  subagent_mean_thoroughness DOUBLE,
  subagent_max_precision INTEGER,
  subagent_max_creativity INTEGER,
  subagent_max_reasoning INTEGER,
  subagent_max_thoroughness INTEGER,
  subagent_composite_mean DOUBLE,
  verification_total_count INTEGER,
  verification_failure_count INTEGER,
  verification_state VARCHAR,
  verification_count_bucket VARCHAR,
  verification_test_count INTEGER,
  verification_build_count INTEGER,
  verification_lint_count INTEGER,
  verification_typecheck_count INTEGER,
  verification_format_count INTEGER,
  verification_other_count INTEGER,
  file_write_count INTEGER,
  file_edit_count INTEGER,
  file_delete_count INTEGER,
  file_rename_count INTEGER,
  touched_file_count INTEGER,
  line_additions BIGINT,
  line_deletions BIGINT,
  line_modifications BIGINT,
  line_mutation_total BIGINT,
  token_efficiency DOUBLE,
  context_utilization DOUBLE,
  cache_hit_ratio DOUBLE,
  first_attempt_success BOOLEAN,
  estimated_cost_usd DOUBLE,
  subagent_input_tokens BIGINT,
  subagent_output_tokens BIGINT,
  subagent_cache_read_tokens BIGINT,
  subagent_cache_write_tokens BIGINT,
  subagent_estimated_cost_usd DOUBLE,
  total_estimated_cost_usd DOUBLE,
  compaction_count INTEGER,
  auto_retry_count INTEGER,
  edit_revisit_rate DOUBLE,
  files_reviewed_count INTEGER,
  read_revisit_rate DOUBLE
);
`.trim();
}

function toolUsageTableSchema(): string {
  return `
CREATE TABLE tool_usage (
  run_id VARCHAR,
  tool_name VARCHAR,
  call_count INTEGER,
  failure_count INTEGER,
  execution_failure_count INTEGER,
  verification_project_failure_count INTEGER,
  probe_failure_count INTEGER,
  result_issue_count INTEGER,
  total_duration_ms DOUBLE,
  mean_duration_ms DOUBLE,
  started_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  mixed_treatment_config BOOLEAN,
  scored BOOLEAN,
  satisfaction DOUBLE,
  resolution VARCHAR
);
`.trim();
}

function toolFailuresTableSchema(): string {
  return `
CREATE TABLE tool_failures (
  run_id VARCHAR,
  tool_name VARCHAR,
  failure_kind VARCHAR,
  count INTEGER,
  exit_code INTEGER,
  error_excerpt VARCHAR,
  verification_kinds VARCHAR[],
  started_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  mixed_treatment_config BOOLEAN,
  scored BOOLEAN,
  satisfaction DOUBLE,
  resolution VARCHAR
);
`.trim();
}

function verificationUsageTableSchema(): string {
  return `
CREATE TABLE verification_usage (
  run_id VARCHAR,
  kind VARCHAR,
  count INTEGER,
  run_had_any_failure BOOLEAN,
  started_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  mixed_treatment_config BOOLEAN,
  scored BOOLEAN,
  satisfaction DOUBLE,
  resolution VARCHAR
);
`.trim();
}

function backendErrorsTableSchema(): string {
  return `
CREATE TABLE backend_errors (
  run_id VARCHAR,
  error_code VARCHAR,
  count INTEGER,
  started_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  scored BOOLEAN,
  satisfaction DOUBLE,
  resolution VARCHAR
);
`.trim();
}

function fileExtensionsTableSchema(): string {
  return `
CREATE TABLE file_extensions (
  run_id VARCHAR,
  extension VARCHAR,
  read_count INTEGER,
  write_count INTEGER,
  edit_count INTEGER,
  total_count INTEGER,
  started_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  mixed_treatment_config BOOLEAN,
  scored BOOLEAN,
  satisfaction DOUBLE,
  resolution VARCHAR
);
`.trim();
}

function pruningEventsTableSchema(): string {
  return `
CREATE TABLE pruning_events (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  timestamp TIMESTAMP,
  started_day DATE,
  pruning_mode VARCHAR,
  query VARCHAR,
  llm_model VARCHAR,
  llm_thinking_level VARCHAR,
  llm_latency_ms INTEGER,
  skill_count_kept INTEGER,
  skill_count_pruned INTEGER,
  skill_count_total INTEGER,
  skill_tokens_saved INTEGER,
  skill_tokens_original INTEGER,
  tool_count_kept INTEGER,
  tool_count_pruned INTEGER,
  tool_count_total INTEGER,
  tool_tokens_saved INTEGER,
  tool_tokens_original INTEGER,
  kept_skill_names VARCHAR[],
  pruned_skill_names VARCHAR[],
  kept_tool_names VARCHAR[],
  pruned_tool_names VARCHAR[],
  prepass_input_tokens INTEGER,
  prepass_output_tokens INTEGER,
  prepass_cache_read_tokens INTEGER,
  prepass_cache_write_tokens INTEGER,
  prepass_input_estimate_tokens INTEGER,
  code_version VARCHAR
);
`.trim();
}

function pruningSignalsTableSchema(): string {
  return `
CREATE TABLE pruning_signals (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  timestamp TIMESTAMP,
  started_day DATE,
  event VARCHAR,
  skill_name VARCHAR,
  tool_name VARCHAR
);
`.trim();
}

function toolResultPruningTableSchema(): string {
  return `
CREATE TABLE tool_result_pruning (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  timestamp TIMESTAMP,
  started_day DATE,
  tool_name VARCHAR,
  rules VARCHAR[],
  before_tokens INTEGER,
  after_tokens INTEGER,
  tokens_saved INTEGER
);
`.trim();
}

function warmBashRewritesTableSchema(): string {
  return `
CREATE TABLE warm_bash_rewrites (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  timestamp TIMESTAMP,
  started_day DATE,
  before VARCHAR,
  after VARCHAR
);
`.trim();
}

function warmBashSummariesTableSchema(): string {
  return `
CREATE TABLE warm_bash_summaries (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  timestamp TIMESTAMP,
  started_day DATE,
  fast_path BIGINT,
  warm BIGINT,
  fallback BIGINT,
  pool_size BIGINT,
  warmup_failures BIGINT,
  auto_prune_enabled BOOLEAN,
  fast_path_enabled BOOLEAN,
  gnu_grep BOOLEAN
);
`.trim();
}

function agentReviewTableSchema(): string {
  return `
CREATE TABLE agent_reviews (
  run_id VARCHAR,
  session_path_hash VARCHAR,
  task_group_id VARCHAR,
  recorded_at TIMESTAMP,
  evaluated_at TIMESTAMP,
  started_day DATE,
  model_family VARCHAR,
  agent_rating DOUBLE,
  agent_completion VARCHAR,
  agent_done BOOLEAN,
  reviewer_buckets VARCHAR[],
  reviewer_count INTEGER,
  user_satisfaction DOUBLE
);
`.trim();
}

function turnThroughputTableSchema(): string {
  return `
CREATE TABLE turn_throughput (
  run_id VARCHAR,
  ended_at TIMESTAMP,
  started_day DATE,
  model_id VARCHAR,
  thinking_level VARCHAR,
  experiment_assignment VARCHAR,
  output_tokens BIGINT,
  generation_duration_ms BIGINT,
  concurrent_busy_sessions INTEGER,
  status VARCHAR,
  tokens_per_second DOUBLE,
  turn_latency_ms INTEGER,
  overhead_ms INTEGER,
  provider_latency_ms INTEGER
);
`.trim();
}

async function populateTableFromJson(connection: { run: (sql: string) => Promise<unknown> }, tableName: string, schemaSql: string, sourcePath: string): Promise<void> {
  await runStatements(connection, [
    `DROP TABLE IF EXISTS ${tableName};`,
    schemaSql,
  ]);

  const rawRows = parseJsonOrThrow<unknown[]>(await fs.readFile(sourcePath, 'utf8'), sourcePath);
  if (rawRows.length === 0) {
    return;
  }

  await connection.run(`INSERT INTO ${tableName} SELECT * FROM read_json_auto(${sqlStringLiteral(sourcePath)});`);
}

async function createDerivedViews(connection: { run: (sql: string) => Promise<unknown> }): Promise<void> {
  await runStatements(connection, [
    'DROP VIEW IF EXISTS outcomes;',
    'DROP VIEW IF EXISTS run_factors;',
    'DROP VIEW IF EXISTS subagent_usage;',
    'DROP VIEW IF EXISTS file_mutation;',
    `
CREATE VIEW outcomes AS
SELECT
  run_id,
  task_group_id,
  resolution,
  satisfaction,
  COALESCE(finalized_at, updated_at) AS recorded_at
FROM runs
WHERE scored = TRUE AND resolution IS NOT NULL;
`.trim(),
    `
CREATE VIEW run_factors AS
SELECT
  run_id,
  prompt_family,
  prompt_hash_prefix,
  prompt_captured_at,
  tool_set_hash_prefix,
  skill_set_hash_prefix,
  active_extensions,
  selected_tool_count,
  skill_count,
  context_file_count,
  prompt_guideline_count
FROM runs;
`.trim(),
    `
CREATE VIEW subagent_usage AS
SELECT
  run_id,
  subagent_call_count,
  subagent_task_count,
  subagent_agent_count
FROM runs;
`.trim(),
    `
CREATE VIEW file_mutation AS
SELECT
  run_id,
  file_write_count AS write_count,
  file_edit_count AS edit_count,
  file_delete_count AS delete_count,
  file_rename_count AS rename_count,
  touched_file_count,
  line_additions,
  line_deletions,
  line_modifications,
  line_mutation_total
FROM runs;
`.trim(),
  ]);
}

export async function buildDuckDbDatabase(params: {
  dbPath: string;
  exportsDir: string;
  prepared: PreparedAnalyticsData;
}): Promise<void> {
  await ensureDir(path.dirname(params.dbPath));
  const stagingPaths = await writeDuckDbStagingExports(params.exportsDir, params.prepared);
  const { instance, connection } = await openDuckDb(params.dbPath);

  try {
    await populateTableFromJson(connection, 'runs', runsTableSchema(), stagingPaths.runsPath);
    await populateTableFromJson(connection, 'tool_usage', toolUsageTableSchema(), stagingPaths.toolUsagePath);
    await populateTableFromJson(connection, 'tool_failures', toolFailuresTableSchema(), stagingPaths.toolFailuresPath);
    await populateTableFromJson(connection, 'verification_usage', verificationUsageTableSchema(), stagingPaths.verificationUsagePath);
    await populateTableFromJson(connection, 'backend_errors', backendErrorsTableSchema(), stagingPaths.backendErrorsPath);
    await populateTableFromJson(connection, 'file_extensions', fileExtensionsTableSchema(), stagingPaths.fileExtensionsPath);
    await populateTableFromJson(connection, 'pruning_events', pruningEventsTableSchema(), stagingPaths.pruningEventsPath);
    await populateTableFromJson(connection, 'pruning_signals', pruningSignalsTableSchema(), stagingPaths.pruningSignalsPath);
    await populateTableFromJson(connection, 'tool_result_pruning', toolResultPruningTableSchema(), stagingPaths.toolResultPruningPath);
    await populateTableFromJson(connection, 'warm_bash_rewrites', warmBashRewritesTableSchema(), stagingPaths.warmBashRewritesPath);
    await populateTableFromJson(connection, 'warm_bash_summaries', warmBashSummariesTableSchema(), stagingPaths.warmBashSummariesPath);
    await populateTableFromJson(connection, 'agent_reviews', agentReviewTableSchema(), stagingPaths.agentReviewsPath);
    await populateTableFromJson(connection, 'turn_throughput', turnThroughputTableSchema(), stagingPaths.turnThroughputPath);
    await createDerivedViews(connection);
  } finally {
    await closeDuckDb(instance, connection);
  }
}

export async function readNamedQuerySql(name: NamedQuery): Promise<string> {
  return await fs.readFile(QUERY_FILE_BY_NAME[name], 'utf8');
}

export async function runDuckDbQuery(dbPath: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const { instance, connection } = await openDuckDb(dbPath);
  try {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  } finally {
    await closeDuckDb(instance, connection);
  }
}

export async function runNamedDuckDbQuery(dbPath: string, name: NamedQuery): Promise<Array<Record<string, unknown>>> {
  return await runDuckDbQuery(dbPath, await readNamedQuerySql(name));
}
