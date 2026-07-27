import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  GENERATOR_VERSION,
  DATA_MODE_LOCAL_DEFAULT,
  SITE_DATA_FILE_NAMES,
  SITE_DATA_SCHEMA_VERSION,
  type BackendErrorData,
  type FileExtensionData,
  type ModelQualityAggregateRow,
  type ModelQualityData,
  type OverviewData,
  type PruningImpactData,
  type PreparedAnalyticsData,
  type PreparedRunRow,
  type PreparedTurnThroughputRow,
  type RetryTimingData,
  type SessionReviewAnalyticsData,
  type SiteDataBundle,
  type SiteDataFileName,
  type SiteManifest,
  type TimelineData,
  type TimelineRow,
  type TokenThroughputData,
  type ToolResultPruningImpactData,
  type ToolUsageAggregateRow,
  type ToolUsageData,
  type TreatmentComparisonData,
  type TreatmentComparisonRow,
  type VerificationImpactData,
  type VerificationImpactRow,
  type VerificationCountBucket,
} from './contracts.ts';
import { ensureDir, writeJsonFile } from './fs-utils.ts';
import { createModelLeaderboard } from './leaderboard.ts';
import { parseJsonOrThrow } from '../../shared/error-message.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[], digits = 3): number | null {
  if (values.length === 0) {
    return null;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}

function percentile(values: number[], p: number, digits = 0): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return round(sorted[lower]!, digits);
  }
  return round(sorted[lower]! * (1 - (index - lower)) + sorted[upper]! * (index - lower), digits);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }
  return round(((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2, 0);
}

function normalizeThinkingLevel(thinkingLevel: string | null): string {
  return thinkingLevel?.trim() ? thinkingLevel : '(unspecified)';
}

function normalizeExperimentAssignment(experimentAssignment: string | null): string {
  return experimentAssignment?.trim() ? experimentAssignment : '(none)';
}

function normalizePromptFamily(promptFamily: string | null): string {
  return promptFamily?.trim() ? promptFamily : '(none)';
}

function completeEstimatedRunCostUsd(run: PreparedRunRow): number | null {
  return typeof run.totalEstimatedCostUsd === 'number' && Number.isFinite(run.totalEstimatedCostUsd)
    ? run.totalEstimatedCostUsd
    : null;
}

function createManifest(prepared: PreparedAnalyticsData, generatedAt: Date): SiteManifest {
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    sourceAnalyticsSchemaVersion: prepared.sourceSchemaVersion,
    generatedAt: generatedAt.toISOString(),
    sourceWorkspaceKey: prepared.sourceWorkspaceKey,
    sourceExportedAt: prepared.sourceExportedAt,
    completedRunCount: prepared.runs.filter((run) => run.status !== 'open').length,
    openRunCount: prepared.runs.filter((run) => run.status === 'open').length,
    dataMode: DATA_MODE_LOCAL_DEFAULT,
    generatorVersion: GENERATOR_VERSION,
  };
}

function createOverview(prepared: PreparedAnalyticsData): OverviewData {
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open');
  const costValues = completedRuns.map(completeEstimatedRunCostUsd).filter((value): value is number => value !== null);
  const totalToolCalls = completedRuns.reduce((sum, run) => sum + run.toolCallCount, 0);
  const totalToolFailures = completedRuns.reduce((sum, run) => sum + run.toolFailureCount, 0);
  const totalResultIssues = completedRuns.reduce((sum, run) => sum + run.resultIssueCount, 0);
  const latestRunTimestamp = completedRuns.map((run) => run.updatedAt).sort().at(-1) ?? null;
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    totalCompletedRuns: completedRuns.length,
    totalOpenRuns: prepared.runs.filter((run) => run.status === 'open').length,
    medianBusyDurationMs: median(completedRuns.map((run) => run.busyDurationMs)),
    p90BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 90),
    p99BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 99),
    verificationRunRate: completedRuns.length === 0 ? null : round(completedRuns.filter((run) => run.verificationTotalCount > 0).length / completedRuns.length, 3),
    toolFailureRate: totalToolCalls === 0 ? null : round(totalToolFailures / totalToolCalls, 3),
    resultIssueRate: totalToolCalls === 0 ? null : round(totalResultIssues / totalToolCalls, 3),
    medianTokenEfficiency: percentile(completedRuns.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null), 50, 1),
    averageContextUtilization: average(completedRuns.map((run) => run.contextUtilization).filter((value): value is number => value !== null), 3),
    averageCacheHitRatio: average(completedRuns.map((run) => run.cacheHitRatio).filter((value): value is number => value !== null), 3),
    totalEstimatedCostUsd: costValues.length === 0 ? null : round(costValues.reduce((sum, value) => sum + value, 0), 4),
    medianEstimatedCostUsd: percentile(costValues, 50, 4),
    latestRunTimestamp,
  };
}

function createModelQuality(prepared: PreparedAnalyticsData): ModelQualityData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const modelId = run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
    const key = [modelId, normalizeThinkingLevel(run.thinkingLevel), normalizeExperimentAssignment(run.experimentAssignment)].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }
  const reviewCountByFamily = new Map<string, number>();
  for (const review of prepared.sessionReviewsV2) {
    for (const family of new Set(review.modelFamilies)) {
      reviewCountByFamily.set(family, (reviewCountByFamily.get(family) ?? 0) + 1);
    }
  }
  const rows: ModelQualityAggregateRow[] = [...groups.entries()].map(([key, runs]) => {
    const [modelId = '(unknown)', thinkingLevel = '(unspecified)', experimentAssignment = '(none)'] = key.split('::');
    return {
      modelId,
      thinkingLevel,
      experimentAssignment,
      runCount: runs.length,
      providerModelIds: [...new Set(runs.map((run) => run.modelId?.trim() || '(unknown)'))].sort(),
      v2ReviewCount: reviewCountByFamily.get(modelId) ?? 0,
      averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
      medianBusyDurationMs: median(runs.map((run) => run.busyDurationMs)),
      p90BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 90),
      p99BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 99),
      averageToolFailures: average(runs.map((run) => run.toolFailureCount), 2),
      verificationRunRate: runs.length === 0 ? null : round(runs.filter((run) => run.verificationTotalCount > 0).length / runs.length, 3),
      medianTokenEfficiency: percentile(runs.map((run) => run.tokenEfficiency).filter((value): value is number => value !== null), 50, 1),
      averageContextUtilization: average(runs.map((run) => run.contextUtilization).filter((value): value is number => value !== null), 3),
      averageCacheHitRatio: average(runs.map((run) => run.cacheHitRatio).filter((value): value is number => value !== null), 3),
    };
  }).sort((left, right) => right.runCount - left.runCount || left.modelId.localeCompare(right.modelId) || left.thinkingLevel.localeCompare(right.thinkingLevel) || left.experimentAssignment.localeCompare(right.experimentAssignment));
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    cohortLabels: { v2Reviews: 'V2 canonical production reviews' },
    rows,
    notes: [
      'V2 review counts are diagnostic stable-session review coverage; runtime metrics use all completed runs in each group.',
      'Operational metrics and review coverage are observational and do not independently determine the V2 leaderboard rank.',
    ],
  };
}

function verificationBucket(count: number): VerificationCountBucket {
  if (count <= 0) {
    return '0';
  }
  if (count === 1) {
    return '1';
  }
  if (count <= 3) {
    return '2-3';
  }
  return '4+';
}

function createVerificationImpact(prepared: PreparedAnalyticsData): VerificationImpactData {
  const groupedRuns = new Map<string, Set<string>>();
  const summaryGroups = new Map<string, Set<string>>();
  const usageByRunId = new Map<string, typeof prepared.verificationUsage>();
  for (const row of prepared.verificationUsage) {
    const existing = usageByRunId.get(row.runId) ?? [];
    existing.push(row);
    usageByRunId.set(row.runId, existing);
  }
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const usageRows = usageByRunId.get(run.runId) ?? [];
    const kinds = usageRows.length > 0 ? [...new Set(usageRows.map((row) => row.kind))] : ['none'];
    for (const verificationKind of kinds) {
      const count = verificationKind === 'none' ? 0 : usageRows.find((row) => row.kind === verificationKind)?.count ?? 0;
      const key = [verificationKind, verificationBucket(count), run.verificationState].join('::');
      const existing = groupedRuns.get(key) ?? new Set<string>();
      existing.add(run.runId);
      groupedRuns.set(key, existing);
    }
    const summary = summaryGroups.get(run.verificationState) ?? new Set<string>();
    summary.add(run.runId);
    summaryGroups.set(run.verificationState, summary);
  }
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows: [...groupedRuns.entries()].map(([key, runIds]) => {
      const [verificationKind = 'none', countBucket = '0', verificationState = 'none'] = key.split('::');
      return { verificationKind, countBucket: countBucket as VerificationImpactRow['countBucket'], verificationState: verificationState as VerificationImpactRow['verificationState'], runCount: runIds.size };
    }).sort((left, right) => left.verificationKind.localeCompare(right.verificationKind) || left.countBucket.localeCompare(right.countBucket) || left.verificationState.localeCompare(right.verificationState)),
    summaryRows: [...summaryGroups.entries()].map(([verificationState, runIds]) => ({ verificationState: verificationState as VerificationImpactData['summaryRows'][number]['verificationState'], runCount: runIds.size })),
    notes: ['Verification failures are tracked at run level; per-kind failure attribution is unavailable.', 'Open runs are excluded.'],
  };
}

function createToolUsage(prepared: PreparedAnalyticsData): ToolUsageData {
  const grouped = new Map<string, typeof prepared.toolUsage>();
  for (const row of prepared.toolUsage) {
    const existing = grouped.get(row.toolName) ?? [];
    existing.push(row);
    grouped.set(row.toolName, existing);
  }
  const summaryRows: ToolUsageAggregateRow[] = [...grouped.entries()].map(([toolName, rows]) => ({
    toolName,
    callCount: rows.reduce((sum, row) => sum + row.callCount, 0),
    failureCount: rows.reduce((sum, row) => sum + row.failureCount, 0),
    executionFailureCount: rows.reduce((sum, row) => sum + row.executionFailureCount, 0),
    verificationProjectFailureCount: rows.reduce((sum, row) => sum + row.verificationProjectFailureCount, 0),
    probeFailureCount: rows.reduce((sum, row) => sum + row.probeFailureCount, 0),
    resultIssueCount: rows.reduce((sum, row) => sum + row.resultIssueCount, 0),
    affectedRunCount: new Set(rows.map((row) => row.runId)).size,
  })).sort((left, right) => right.callCount - left.callCount || left.toolName.localeCompare(right.toolName));
  return { schemaVersion: SITE_DATA_SCHEMA_VERSION, rows: prepared.toolUsage, summaryRows };
}

function createTreatmentComparison(prepared: PreparedAnalyticsData): TreatmentComparisonData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const key = [normalizePromptFamily(run.promptFamily), run.promptHashPrefix ?? '', run.toolSetHashPrefix ?? '', run.skillSetHashPrefix ?? '', normalizeExperimentAssignment(run.experimentAssignment), run.mixedTreatmentConfig ? 'mixed' : 'pure'].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }
  const rows: TreatmentComparisonRow[] = [...groups.entries()].map(([key, runs]) => {
    const [promptFamily = '(none)', promptHashPrefix = '', toolSetHashPrefix = '', skillSetHashPrefix = '', experimentAssignment = '(none)', purity = 'pure'] = key.split('::');
    return { promptFamily, promptHashPrefix: promptHashPrefix || null, toolSetHashPrefix: toolSetHashPrefix || null, skillSetHashPrefix: skillSetHashPrefix || null, experimentAssignment, mixedTreatmentConfig: purity === 'mixed', runCount: runs.length };
  }).sort((left, right) => right.runCount - left.runCount || left.promptFamily.localeCompare(right.promptFamily) || left.experimentAssignment.localeCompare(right.experimentAssignment));
  return { schemaVersion: SITE_DATA_SCHEMA_VERSION, rows };
}

function createTimeline(prepared: PreparedAnalyticsData): TimelineData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const existing = groups.get(run.startedDay) ?? [];
    existing.push(run);
    groups.set(run.startedDay, existing);
  }
  const rows: TimelineRow[] = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucketStart, runs]) => ({
    bucketStart,
    runCount: runs.length,
    verificationRunCount: runs.filter((run) => run.verificationTotalCount > 0).length,
    toolFailureCount: runs.reduce((sum, run) => sum + run.toolFailureCount, 0),
    averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
    modelMix: Object.fromEntries([...runs.reduce((counts, run) => {
      const modelId = run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
      counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right))),
  }));
  return { schemaVersion: SITE_DATA_SCHEMA_VERSION, rows };
}

function createPruningImpact(prepared: PreparedAnalyticsData): PruningImpactData {
  const rows = prepared.pruningEvents;
  const signalRows = prepared.pruningSignals;
  const totalSkillTokensSaved = rows.reduce((sum, r) => sum + r.skillTokensSaved, 0);
  const totalToolTokensSaved = rows.reduce((sum, r) => sum + r.toolTokensSaved, 0);
  const modeCounts: Record<string, number> = {};
  for (const row of rows) {
    modeCounts[row.pruningMode] = (modeCounts[row.pruningMode] ?? 0) + 1;
  }
  const latencies = rows.map((r) => r.llmLatencyMs).filter((v) => Number.isFinite(v));

  // Over-pruning signal counts from the event-shaped lines.
  let skillReadCount = 0;
  let skillMissCount = 0;
  let shadowMissCandidateCount = 0;
  let toolRecoveredCount = 0;
  for (const signal of signalRows) {
    switch (signal.event) {
      case 'skill_read':
        skillReadCount += 1;
        break;
      case 'skill_miss':
      case 'skill_recovered':
        skillMissCount += 1;
        break;
      case 'shadow_miss_candidate':
        shadowMissCandidateCount += 1;
        break;
      case 'tool_recovered':
        toolRecoveredCount += 1;
        break;
    }
  }

  // Denominator: decisions that pruned >=1 tool (i.e. toolCountPruned >= 1).
  const decisionsThatPrunedTools = rows.filter((r) => r.toolCountPruned >= 1).length;
  const pruneRecoveredRate =
    decisionsThatPrunedTools > 0 ? toolRecoveredCount / decisionsThatPrunedTools : null;
  const skillMissDenominator = skillReadCount + skillMissCount + shadowMissCandidateCount;
  const skillMissRate = skillMissDenominator > 0 ? (skillMissCount + shadowMissCandidateCount) / skillMissDenominator : null;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    signalRows,
    summary: {
      totalEvents: rows.length,
      totalSkillTokensSaved,
      totalToolTokensSaved,
      medianLlmLatencyMs: median(latencies),
      modeCounts,
      skillReadCount,
      skillMissCount,
      shadowMissCandidateCount,
      toolRecoveredCount,
      decisionsThatPrunedTools,
      pruneRecoveredRate,
      skillMissRate,
    },
  };
}

function createToolResultPruningImpact(prepared: PreparedAnalyticsData): ToolResultPruningImpactData {
  const rows = prepared.toolResultPruning;
  const totalTokensSaved = rows.reduce((sum, r) => sum + r.tokensSaved, 0);
  const totalBeforeTokens = rows.reduce((sum, r) => sum + r.beforeTokens, 0);
  const totalAfterTokens = rows.reduce((sum, r) => sum + r.afterTokens, 0);
  const byRule = new Map<string, { count: number; tokensSaved: number }>();
  const byTool = new Map<string, { count: number; tokensSaved: number; beforeTokens: number; afterTokens: number }>();
  for (const row of rows) {
    for (const rule of row.rules) {
      const acc = byRule.get(rule) ?? { count: 0, tokensSaved: 0 };
      acc.count += 1;
      acc.tokensSaved += row.tokensSaved;
      byRule.set(rule, acc);
    }
    const t = byTool.get(row.toolName) ?? { count: 0, tokensSaved: 0, beforeTokens: 0, afterTokens: 0 };
    t.count += 1; t.tokensSaved += row.tokensSaved; t.beforeTokens += row.beforeTokens; t.afterTokens += row.afterTokens;
    byTool.set(row.toolName, t);
  }
  const byRuleRows = [...byRule.entries()].map(([rule, v]) => ({ rule, count: v.count, tokensSaved: v.tokensSaved })).sort((a, b) => b.tokensSaved - a.tokensSaved || a.rule.localeCompare(b.rule));
  const byToolRows = [...byTool.entries()].map(([toolName, v]) => ({ toolName, count: v.count, tokensSaved: v.tokensSaved, beforeTokens: v.beforeTokens, afterTokens: v.afterTokens })).sort((a, b) => b.tokensSaved - a.tokensSaved || a.toolName.localeCompare(b.toolName));
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    summary: {
      totalEvents: rows.length,
      totalTokensSaved,
      totalBeforeTokens,
      totalAfterTokens,
      byRule: byRuleRows,
      byTool: byToolRows,
    },
  };
}

function countValues(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function buildSessionReviewAnalytics(prepared: PreparedAnalyticsData): SessionReviewAnalyticsData {
  const rows = prepared.sessionReviewsV2;
  const criteria = rows.flatMap((row) => row.criteria);
  const reviewers = rows.flatMap((row) => row.reviewers);
  const quality = rows.map((row) => row.attainment.qualityIndexV1).filter((value): value is number => value !== null);
  const activeCriteria = criteria.filter((criterion) => criterion.status !== 'superseded');
  const assessableCriteria = activeCriteria.filter((criterion) => criterion.status !== 'not_assessable');
  const externalBlocked = activeCriteria.filter((criterion) => criterion.status === 'blocked' && criterion.reason === 'external_blocker');
  const processFields = ['requirementDiscipline', 'verificationDiscipline', 'scopeControl', 'recovery', 'finalClaimAccuracy'] as const;
  const evidenceFields = ['requirements', 'artifacts', 'execution', 'human'] as const;
  const process = Object.fromEntries(processFields.map((field) => [field, countValues(rows.map((row) => row.process[field]))])) as SessionReviewAnalyticsData['process'];
  const evidence = {
    ...Object.fromEntries(evidenceFields.map((field) => [field, countValues(rows.map((row) => row.evidence[field]))])),
    limitationCount: rows.reduce((sum, row) => sum + row.evidence.limitations.length, 0),
  } as SessionReviewAnalyticsData['evidence'];
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    cohort: 'v2_production', cohortLabel: 'V2 canonical production reviews', indexVersion: 'v1', rows,
    diagnostics: prepared.sessionReviewV2Diagnostics,
    summary: {
      reviewCount: rows.length,
      stableIdentityCount: rows.filter((row) => !row.identityFallback).length,
      identityFallbackCount: rows.filter((row) => row.identityFallback).length,
      joinedReviewCount: rows.filter((row) => row.joinKey !== 'unmatched').length,
      qualityIndexCount: quality.length,
      notAssessableReviewCount: rows.length - quality.length,
      meanQualityIndexV1: average(quality, 1),
      criterionCoverage: activeCriteria.length ? round(assessableCriteria.length / activeCriteria.length, 4) : null,
      externalBlockerRate: activeCriteria.length ? round(externalBlocked.length / activeCriteria.length, 4) : null,
      deliveredOverall: countValues(rows.map((row) => row.attainment.deliveredOverall)),
      controllableOverall: countValues(rows.map((row) => row.attainment.controllableOverall)),
      confidence: countValues(rows.map((row) => row.confidence)),
    },
    criteria: {
      total: criteria.length, assessable: assessableCriteria.length,
      byImportance: countValues(criteria.map((criterion) => criterion.importance)),
      byStatus: countValues(criteria.map((criterion) => criterion.status)),
      byReason: countValues(criteria.map((criterion) => criterion.reason)),
      byActivity: countValues(criteria.map((criterion) => criterion.activity)),
      bySurface: countValues(criteria.flatMap((criterion) => criterion.surfaces)),
      byEvidenceMode: countValues(criteria.flatMap((criterion) => criterion.evidenceModes)),
    },
    process,
    evidence,
    disagreement: {
      materialCount: rows.filter((row) => row.disagreement.material).length,
      adjudicatedCount: rows.filter((row) => row.disagreement.adjudicated).length,
      disputedFieldCount: rows.reduce((sum, row) => sum + row.disagreement.disputedFields.length, 0),
      byResolution: countValues(rows.flatMap((row) => row.disagreement.disputedFields.map((field) => field.resolution))),
    },
    reviewers: {
      callCount: reviewers.length,
      bucketDowngradeCount: reviewers.filter((reviewer) => reviewer.bucketDowngraded).length,
      diversityAchievedCount: rows.filter((row) => row.diversityAchieved).length,
      byRole: countValues(reviewers.map((reviewer) => reviewer.role)),
      byRequestedBucket: countValues(reviewers.map((reviewer) => reviewer.requestedBucket)),
      byEffectiveBucket: countValues(reviewers.map((reviewer) => reviewer.bucket)),
      byModel: countValues(reviewers.map((reviewer) => reviewer.modelId)),
      byProvider: countValues(reviewers.map((reviewer) => reviewer.provider)),
      byFamily: countValues(reviewers.map((reviewer) => reviewer.family)),
    },
    notes: [
      'qualityIndexV1 is derived only from agent-controllable assessable criterion attainment. Coverage, confidence, blockers, and process classifications are exposed separately and never multiply or penalize the index.',
      'V2 reviews join runtime rows by stable sessionId. path_fallback and unmatched rows are explicitly flagged and may be excluded from stable-identity cohorts.',
      'Reviewer author identity/treatments are joined only after the blinded canonical review has been persisted. Associations with tools, skills, models, and treatments are observational unless assignment was controlled.',
    ],
  };
}

function createBackendErrors(prepared: PreparedAnalyticsData): BackendErrorData {
  const rows = prepared.backendErrors;
  const byCode = new Map<string, { count: number; runs: Set<string> }>();
  for (const row of rows) {
    const existing = byCode.get(row.errorCode) ?? { count: 0, runs: new Set<string>() };
    existing.count += row.count;
    existing.runs.add(row.runId);
    byCode.set(row.errorCode, existing);
  }
  const byErrorCode = [...byCode.entries()]
    .map(([errorCode, value]) => ({ errorCode, count: value.count, affectedRunCount: value.runs.size }))
    .sort((left, right) => right.count - left.count || left.errorCode.localeCompare(right.errorCode));
  const affectedRuns = new Set(rows.map((r) => r.runId));
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    summary: {
      totalErrorEvents: rows.reduce((sum, r) => sum + r.count, 0),
      affectedRunCount: affectedRuns.size,
      byErrorCode,
    },
  };
}

function createFileExtensions(prepared: PreparedAnalyticsData): FileExtensionData {
  const rows = prepared.fileExtensions;
  const byExtension = new Map<string, { read: number; write: number; edit: number; runs: Set<string> }>();
  for (const row of rows) {
    const existing = byExtension.get(row.extension) ?? { read: 0, write: 0, edit: 0, runs: new Set<string>() };
    existing.read += row.readCount;
    existing.write += row.writeCount;
    existing.edit += row.editCount;
    existing.runs.add(row.runId);
    byExtension.set(row.extension, existing);
  }
  const summary = [...byExtension.entries()]
    .map(([extension, value]) => ({
      extension,
      readCount: value.read,
      writeCount: value.write,
      editCount: value.edit,
      totalCount: value.read + value.write + value.edit,
      affectedRunCount: value.runs.size,
    }))
    .sort((left, right) => right.totalCount - left.totalCount || left.extension.localeCompare(right.extension));
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    summary,
  };
}

function createRetryTiming(prepared: PreparedAnalyticsData): RetryTimingData {
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows: prepared.retryTiming.map((row) => ({ ...row })),
    notes: [
      'scheduledDelayMs is the configured SDK backoff; measuredDelayMs is observed scheduling-to-provider-gate delay; durationMs is the full retry episode span.',
      'Null measured delay or duration means that timing boundary was not observed. Missing historical retry samples remain absent rather than being presented as zero-duration retries.',
    ],
  };
}

function createTokenThroughput(prepared: PreparedAnalyticsData): TokenThroughputData {
  // Retain every turn (including errored / tokenless ones with null
  // tokensPerSecond) so coverage and error-rate analysis see the full
  // population. Chart transforms filter null tokensPerSecond at render time;
  // the artifact itself must not drop rows.
  const rows: PreparedTurnThroughputRow[] = prepared.turnThroughput.map((row) => ({ ...row }));
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    notes: [
      'Throughput = output tokens / generation time (ms → s). Generation time excludes tool execution (tools run between assistant messages), so it isolates raw model emission speed.',
      'concurrentBusySessions is end-of-turn descriptive telemetry: how many sessions were mid-run when the turn ended. It is not a causal rate-limit signal — the count is sampled once per turn and co-varies with many factors, so treat any throughput-vs-concurrency correlation as descriptive, not causal.',
      'Every turn is retained for coverage / error analysis (including errored and tokenless turns with null tokensPerSecond). Chart transforms filter null tokensPerSecond at render time; the artifact never drops rows.',
    ],
  };
}

export function buildSiteDataBundle(prepared: PreparedAnalyticsData, generatedAt = new Date()): SiteDataBundle {
  return {
    manifest: createManifest(prepared, generatedAt),
    overview: createOverview(prepared),
    runSummary: {
      schemaVersion: SITE_DATA_SCHEMA_VERSION,
      rows: prepared.runs,
    },
    modelQuality: createModelQuality(prepared),
    verificationImpact: createVerificationImpact(prepared),
    toolUsage: createToolUsage(prepared),
    treatmentComparison: createTreatmentComparison(prepared),
    timeline: createTimeline(prepared),
    modelLeaderboard: createModelLeaderboard(prepared),
    pruningImpact: createPruningImpact(prepared),
    toolResultPruningImpact: createToolResultPruningImpact(prepared),
    sessionReviewAnalytics: buildSessionReviewAnalytics(prepared),
    backendErrors: createBackendErrors(prepared),
    fileExtensions: createFileExtensions(prepared),
    tokenThroughput: createTokenThroughput(prepared),
    retryTiming: createRetryTiming(prepared),
  };
}

export function siteDataFileMap(bundle: SiteDataBundle): Record<SiteDataFileName, unknown> {
  return {
    'manifest.json': bundle.manifest,
    'overview.json': bundle.overview,
    'run-summary.json': bundle.runSummary,
    'model-quality.json': bundle.modelQuality,
    'verification-impact.json': bundle.verificationImpact,
    'tool-usage.json': bundle.toolUsage,
    'treatment-comparison.json': bundle.treatmentComparison,
    'timeline.json': bundle.timeline,
    'model-leaderboard.json': bundle.modelLeaderboard,
    'pruning-impact.json': bundle.pruningImpact,
    'tool-result-pruning-impact.json': bundle.toolResultPruningImpact,
    'session-review-analytics.json': bundle.sessionReviewAnalytics,
    'backend-errors.json': bundle.backendErrors,
    'file-types.json': bundle.fileExtensions,
    'token-throughput.json': bundle.tokenThroughput,
    'retry-timing.json': bundle.retryTiming,
  };
}

async function assertNoUnexpectedSiteDataFiles(outputDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw new Error(`Unexpected subdirectory found in site data directory: ${entry.name}`);
      }
      if (!entry.isFile()) {
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== '.json') {
        throw new Error(`Unexpected non-JSON file found in site data directory: ${entry.name}`);
      }
      if (!SITE_DATA_FILE_NAMES.includes(entry.name as SiteDataFileName)) {
        throw new Error(`Unexpected JSON file found in site data directory: ${entry.name}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function writeSiteData(outputDir: string, bundle: SiteDataBundle): Promise<void> {
  if (path.extname(outputDir).toLowerCase() === '.json') {
    throw new Error(`Site-data output must be a directory, received JSON file path: ${outputDir}`);
  }
  if (path.basename(outputDir).toLowerCase() === 'run-analytics.json') {
    throw new Error('Refusing to use run-analytics.json as a site-data output target.');
  }

  await assertNoUnexpectedSiteDataFiles(outputDir);
  await ensureDir(outputDir);
  const files = siteDataFileMap(bundle);
  await Promise.all(
    SITE_DATA_FILE_NAMES.map(async (fileName) => {
      await writeJsonFile(path.join(outputDir, fileName), files[fileName]);
    }),
  );
}

function validateManifest(manifest: unknown): asserts manifest is SiteManifest {
  assert(isRecord(manifest), 'manifest.json must contain an object.');
  assert(
    manifest.schemaVersion === SITE_DATA_SCHEMA_VERSION,
    `manifest.json schemaVersion mismatch: expected ${SITE_DATA_SCHEMA_VERSION}, got ${String(manifest.schemaVersion)}. Regenerate site data.`,
  );
  assert(typeof manifest.generatedAt === 'string', 'manifest.json is missing generatedAt.');
  assert(typeof manifest.sourceWorkspaceKey === 'string', 'manifest.json is missing sourceWorkspaceKey.');
  assert(typeof manifest.sourceExportedAt === 'string', 'manifest.json is missing sourceExportedAt.');
  assert(typeof manifest.completedRunCount === 'number', 'manifest.json is missing completedRunCount.');
  assert(typeof manifest.openRunCount === 'number', 'manifest.json is missing openRunCount.');
  assert(manifest.dataMode === DATA_MODE_LOCAL_DEFAULT, 'manifest.json has an unexpected dataMode.');
}

function validateOverview(overview: unknown, manifest: SiteManifest): asserts overview is OverviewData {
  assert(isRecord(overview), 'overview.json must contain an object.');
  assert(overview.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'overview.json has an unexpected schemaVersion.');
  assert(overview.totalCompletedRuns === manifest.completedRunCount, 'overview.json totalCompletedRuns does not match manifest.json.');
  assert(overview.totalOpenRuns === manifest.openRunCount, 'overview.json totalOpenRuns does not match manifest.json.');
}

function validateRunSummary(runSummary: unknown): void {
  assert(isRecord(runSummary), 'run-summary.json must contain an object.');
  assert(runSummary.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'run-summary.json has an unexpected schemaVersion.');
  assert(Array.isArray(runSummary.rows), 'run-summary.json is missing rows.');
  for (const [index, row] of runSummary.rows.entries()) {
    assert(isRecord(row), `run-summary.json row ${index} must be an object.`);
    assert(typeof row.runId === 'string', `run-summary.json row ${index} is missing runId.`);
    assert(typeof row.sessionId === 'string' && row.sessionId.length > 0, `run-summary.json row ${index} is missing sessionId.`);
    assert(typeof row.identityFallback === 'boolean', `run-summary.json row ${index} is missing identityFallback.`);
    assert(typeof row.sessionPathHash === 'string', `run-summary.json row ${index} is missing sessionPathHash.`);
    assert(typeof row.toolCallCount === 'number', `run-summary.json row ${index} is missing toolCallCount.`);
    assert(typeof row.toolDurationMs === 'number', `run-summary.json row ${index} is missing toolDurationMs.`);
    assert(row.criticalPathDurationMs === null || typeof row.criticalPathDurationMs === 'number', `run-summary.json row ${index} has an invalid criticalPathDurationMs.`);
    assert(row.skillPruningPrepassDurationMs === null || typeof row.skillPruningPrepassDurationMs === 'number', `run-summary.json row ${index} has an invalid skillPruningPrepassDurationMs.`);
    assert(typeof row.timedToolCallCount === 'number', `run-summary.json row ${index} is missing timedToolCallCount.`);
  }
}

function validateComparativeRows(label: string, rows: unknown): void {
  assert(Array.isArray(rows), `${label} is missing rows.`);
  rows.forEach((row, index) => {
    assert(isRecord(row), `${label} row ${index} must be an object.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `${label} row ${index} has an invalid runCount.`);
  });
}

function validateToolUsage(toolUsage: unknown): asserts toolUsage is ToolUsageData {
  assert(isRecord(toolUsage), 'tool-usage.json must contain an object.');
  assert(toolUsage.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'tool-usage.json has an unexpected schemaVersion.');
  assert(Array.isArray(toolUsage.rows), 'tool-usage.json is missing rows.');
  toolUsage.rows.forEach((row, index) => {
    assert(isRecord(row), `tool-usage.json row ${index} must be an object.`);
    assert(typeof row.toolName === 'string', `tool-usage.json row ${index} is missing toolName.`);
    assert(typeof row.callCount === 'number' && row.callCount >= 0, `tool-usage.json row ${index} has an invalid callCount.`);
    assert(typeof row.runId === 'string', `tool-usage.json row ${index} is missing runId.`);
  });
  assert(Array.isArray(toolUsage.summaryRows), 'tool-usage.json is missing summaryRows.');
  toolUsage.summaryRows.forEach((row, index) => {
    assert(isRecord(row), `tool-usage.json summary row ${index} must be an object.`);
    assert(typeof row.toolName === 'string', `tool-usage.json summary row ${index} is missing toolName.`);
    assert(typeof row.callCount === 'number' && row.callCount >= 0, `tool-usage.json summary row ${index} has an invalid callCount.`);
    assert(typeof row.affectedRunCount === 'number' && row.affectedRunCount >= 0, `tool-usage.json summary row ${index} has an invalid affectedRunCount.`);
  });
}

function validateVerificationImpact(verificationImpact: unknown): asserts verificationImpact is VerificationImpactData {
  assert(isRecord(verificationImpact), 'verification-impact.json must contain an object.');
  assert(verificationImpact.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'verification-impact.json has an unexpected schemaVersion.');
  assert(Array.isArray(verificationImpact.rows), 'verification-impact.json is missing rows.');
  assert(Array.isArray(verificationImpact.summaryRows), 'verification-impact.json is missing summaryRows.');
  verificationImpact.summaryRows.forEach((row, index) => {
    assert(isRecord(row), `verification-impact.json summary row ${index} must be an object.`);
    assert(typeof row.verificationState === 'string', `verification-impact.json summary row ${index} is missing verificationState.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `verification-impact.json summary row ${index} has an invalid runCount.`);
  });
}

function validateTimeline(timeline: unknown): asserts timeline is TimelineData {
  assert(isRecord(timeline), 'timeline.json must contain an object.');
  assert(timeline.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'timeline.json has an unexpected schemaVersion.');
  assert(Array.isArray(timeline.rows), 'timeline.json is missing rows.');
  let previousBucket: string | null = null;
  for (const [index, row] of timeline.rows.entries()) {
    assert(isRecord(row), `timeline.json row ${index} must be an object.`);
    assert(typeof row.bucketStart === 'string', `timeline.json row ${index} is missing bucketStart.`);
    assert(typeof row.runCount === 'number' && row.runCount >= 0, `timeline.json row ${index} has an invalid runCount.`);
    assert(isRecord(row.modelMix), `timeline.json row ${index} is missing modelMix.`);
    if (previousBucket !== null) {
      assert(previousBucket.localeCompare(row.bucketStart) <= 0, 'timeline.json rows must be sorted by bucketStart.');
    }
    previousBucket = row.bucketStart;
  }
}

function validateModelLeaderboard(leaderboard: unknown): void {
  const isNonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const isUnitInterval = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  assert(isRecord(leaderboard), 'model-leaderboard.json must contain an object.');
  assert(leaderboard.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'model-leaderboard.json has an unexpected schemaVersion.');
  assert(Array.isArray(leaderboard.rows), 'model-leaderboard.json is missing rows.');
  assert(isRecord(leaderboard.sourceLabels) && leaderboard.sourceLabels.review === 'V2 qualityIndexV1', 'model-leaderboard.json is missing the V2 review cohort label.');
  assert(isRecord(leaderboard.weights), 'model-leaderboard.json is missing weights.');
  for (const dimension of ['fileChurn', 'toolReliability', 'verificationPassRate', 'tokenEfficiency']) {
    assert(leaderboard.weights[dimension] === 0, `model-leaderboard.json weights.${dimension} must be zero.`);
  }
  assert(isNonNegativeInteger(leaderboard.minimumEffectiveTasks), 'model-leaderboard.json has an invalid minimumEffectiveTasks.');
  assert(isUnitInterval(leaderboard.minimumTaskScoringCoverage), 'model-leaderboard.json minimumTaskScoringCoverage must be in [0,1].');
  assert(isRecord(leaderboard.sourceWeights) && leaderboard.sourceWeights.review === 1 && leaderboard.sourceWeights.process === 0, 'model-leaderboard.json V2 ranking must be review-only.');
  assert(isRecord(leaderboard.sourcePriors), 'model-leaderboard.json is missing sourcePriors.');
  assert(isRecord(leaderboard.sourceLogitSpreads), 'model-leaderboard.json is missing sourceLogitSpreads.');
  assert(isRecord(leaderboard.shrinkage), 'model-leaderboard.json is missing shrinkage.');
  assert(isRecord(leaderboard.caseMix), 'model-leaderboard.json is missing caseMix.');
  const caseMix = leaderboard.caseMix;
  assert(caseMix.method === 'direct_standardization', 'model-leaderboard.json has an invalid caseMix method.');
  assert(typeof caseMix.applied === 'boolean', 'model-leaderboard.json caseMix is missing applied.');
  assert(isNonNegativeInteger(caseMix.minimumRatedTasksPerBand), 'model-leaderboard.json caseMix has an invalid minimumRatedTasksPerBand.');
  assert(isNonNegativeInteger(caseMix.minimumModelRatedTasksPerBand), 'model-leaderboard.json caseMix has an invalid minimumModelRatedTasksPerBand.');
  assert(isUnitInterval(caseMix.minimumTargetBandWeight), 'model-leaderboard.json caseMix has an invalid minimumTargetBandWeight.');
  assert(isRecord(caseMix.targetBandWeights), 'model-leaderboard.json caseMix is missing targetBandWeights.');
  const bands = ['low', 'medium', 'high'] as const;
  for (const band of bands) assert(isUnitInterval(caseMix.targetBandWeights[band]), `model-leaderboard.json caseMix.targetBandWeights.${band} is invalid.`);
  assert(Array.isArray(caseMix.activeSignals), 'model-leaderboard.json caseMix is missing activeSignals.');
  assert(Array.isArray(leaderboard.notes), 'model-leaderboard.json is missing notes.');

  let expectedRank = 1;
  let seenUnranked = false;
  for (const [index, row] of leaderboard.rows.entries()) {
    assert(isRecord(row), `model-leaderboard.json row ${index} must be an object.`);
    assert(typeof row.modelId === 'string' && row.thinkingLevel === '(all)', `model-leaderboard.json row ${index} must be a family-level row.`);
    assert(Array.isArray(row.thinkingLevels), `model-leaderboard.json row ${index} is missing thinkingLevels.`);
    for (const field of ['reviewEvidenceCount', 'reviewEvidenceMass', 'processEvidenceCount', 'processEvidenceMass', 'canonicalTaskCount', 'transcriptOnlySessionCount', 'mixedAttributionMass', 'v2ReviewCount']) {
      assert(typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] >= 0, `model-leaderboard.json row ${index}.${field} is invalid.`);
    }
    assert(row.meanQualityIndexV1 === null || (typeof row.meanQualityIndexV1 === 'number' && Number.isFinite(row.meanQualityIndexV1) && row.meanQualityIndexV1 >= 0 && row.meanQualityIndexV1 <= 100), `model-leaderboard.json row ${index}.meanQualityIndexV1 is invalid.`);
    assert(['review-backed', 'thin-review', 'telemetry-only'].includes(String(row.evidenceTier)), `model-leaderboard.json row ${index} has invalid evidenceTier.`);
    for (const field of ['reviewChannelScore', 'processChannelScore', 'compositeScore']) assert(row[field] === null || isUnitInterval(row[field]), `model-leaderboard.json row ${index}.${field} is invalid.`);
    for (const field of ['runCount', 'attributableRunCount', 'attributableTaskCount', 'mixedModelExcludedCount', 'mixedTreatmentExcludedCount']) assert(isNonNegativeInteger(row[field]), `model-leaderboard.json row ${index} has an invalid ${field}.`);
    assert(typeof row.effectiveTaskCount === 'number' && Number.isFinite(row.effectiveTaskCount) && row.effectiveTaskCount >= 0, `model-leaderboard.json row ${index} has an invalid effectiveTaskCount.`);
    assert(row.scoringCoverage === null || isUnitInterval(row.scoringCoverage), `model-leaderboard.json row ${index} has invalid scoringCoverage.`);
    assert(typeof row.scoringCoverageGateFailed === 'boolean', `model-leaderboard.json row ${index} is missing scoringCoverageGateFailed.`);
    assert(typeof row.caseMixAdjusted === 'boolean', `model-leaderboard.json row ${index} is missing caseMixAdjusted.`);
    assert(typeof row.caseMixBandOverlapGateFailed === 'boolean', `model-leaderboard.json row ${index} is missing caseMixBandOverlapGateFailed.`);
    assert(isRecord(row.taskComplexityBandCounts), `model-leaderboard.json row ${index} is missing taskComplexityBandCounts.`);
    for (const band of bands) assert(typeof row.taskComplexityBandCounts[band] === 'number' && Number.isFinite(row.taskComplexityBandCounts[band]) && row.taskComplexityBandCounts[band] >= 0, `model-leaderboard.json row ${index} has invalid ${band} task mass.`);
    assert(Array.isArray(row.providers), `model-leaderboard.json row ${index} is missing providers.`);
    let providerRunSum = 0;
    for (const [providerIndex, provider] of row.providers.entries()) {
      assert(isRecord(provider), `model-leaderboard.json row ${index} providers[${providerIndex}] must be an object.`);
      assert(typeof provider.modelId === 'string', `model-leaderboard.json row ${index} providers[${providerIndex}] is missing modelId.`);
      assert(isNonNegativeInteger(provider.runCount), `model-leaderboard.json row ${index} providers[${providerIndex}] has an invalid runCount.`);
      assert(isNonNegativeInteger(provider.transcriptOnlySessionCount), `model-leaderboard.json row ${index} providers[${providerIndex}] has an invalid transcriptOnlySessionCount.`);
      assert(typeof provider.transcriptEvidenceMass === 'number' && Number.isFinite(provider.transcriptEvidenceMass) && provider.transcriptEvidenceMass >= 0, `model-leaderboard.json row ${index} providers[${providerIndex}] has an invalid transcriptEvidenceMass.`);
      providerRunSum += provider.runCount;
    }
    assert(providerRunSum === row.runCount, `model-leaderboard.json row ${index} provider runCount sum (${providerRunSum}) != row.runCount (${row.runCount}).`);
    assert(isRecord(row.dimensions), `model-leaderboard.json row ${index} is missing dimensions.`);
    for (const dimension of ['fileChurn', 'toolReliability', 'verificationPassRate', 'tokenEfficiency']) assert(isRecord(row.dimensions[dimension]), `model-leaderboard.json row ${index} is missing ${dimension} dimension.`);
    if (row.compositeScore !== null) {
      assert(row.rank === expectedRank, `model-leaderboard.json row ${index} has a non-contiguous rank.`);
      expectedRank += 1;
      assert(!seenUnranked, `model-leaderboard.json row ${index} is ranked after unranked rows.`);
      assert(row.unadjustedCompositeScore !== null, `model-leaderboard.json row ${index} has rank but null unadjustedCompositeScore.`);
      assert(isRecord(row.scoreInterval80) && isUnitInterval(row.scoreInterval80.lower) && isUnitInterval(row.scoreInterval80.upper), `model-leaderboard.json row ${index} has invalid scoreInterval80.`);
      assert(row.scoreInterval80.level === 0.8, `model-leaderboard.json row ${index} has invalid interval level.`);
      assert(isNonNegativeInteger(row.scoreInterval80.bestRank) && isNonNegativeInteger(row.scoreInterval80.worstRank), `model-leaderboard.json row ${index} has invalid rank interval.`);
    } else {
      seenUnranked = true;
      assert(row.rank === null, `model-leaderboard.json row ${index} has null compositeScore but non-null rank.`);
    }
  }
}

function validatePruningImpact(data: unknown): asserts data is PruningImpactData {
  assert(isRecord(data), 'pruning-impact.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'pruning-impact.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'pruning-impact.json is missing rows.');
  assert(Array.isArray(data.signalRows), 'pruning-impact.json is missing signalRows.');
  assert(isRecord(data.summary), 'pruning-impact.json is missing summary.');
  assert(typeof data.summary.totalEvents === 'number', 'pruning-impact.json summary is missing totalEvents.');
  assert(typeof data.summary.skillMissCount === 'number', 'pruning-impact.json summary is missing skillMissCount.');
  assert(typeof data.summary.shadowMissCandidateCount === 'number', 'pruning-impact.json summary is missing shadowMissCandidateCount.');
  assert(typeof data.summary.toolRecoveredCount === 'number', 'pruning-impact.json summary is missing toolRecoveredCount.');
  assert(typeof data.summary.decisionsThatPrunedTools === 'number', 'pruning-impact.json summary is missing decisionsThatPrunedTools.');
  assert(data.summary.pruneRecoveredRate === null || typeof data.summary.pruneRecoveredRate === 'number', 'pruning-impact.json summary has an invalid pruneRecoveredRate.');
  assert(data.summary.skillMissRate === null || typeof data.summary.skillMissRate === 'number', 'pruning-impact.json summary has an invalid skillMissRate.');
}

function validateToolResultPruningImpact(data: unknown): asserts data is ToolResultPruningImpactData {
  assert(isRecord(data), 'tool-result-pruning-impact.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'tool-result-pruning-impact.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'tool-result-pruning-impact.json is missing rows.');
  assert(isRecord(data.summary), 'tool-result-pruning-impact.json is missing summary.');
  assert(typeof data.summary.totalEvents === 'number', 'tool-result-pruning-impact.json summary is missing totalEvents.');
  assert(typeof data.summary.totalTokensSaved === 'number', 'tool-result-pruning-impact.json summary is missing totalTokensSaved.');
  assert(typeof data.summary.totalBeforeTokens === 'number', 'tool-result-pruning-impact.json summary is missing totalBeforeTokens.');
  assert(typeof data.summary.totalAfterTokens === 'number', 'tool-result-pruning-impact.json summary is missing totalAfterTokens.');
  assert(Array.isArray(data.summary.byRule), 'tool-result-pruning-impact.json summary is missing byRule.');
  assert(Array.isArray(data.summary.byTool), 'tool-result-pruning-impact.json summary is missing byTool.');
}

function validateSessionReviewAnalytics(data: unknown): asserts data is SessionReviewAnalyticsData {
  assert(isRecord(data), 'session-review-analytics.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'session-review-analytics.json has an unexpected schemaVersion.');
  assert(data.cohort === 'v2_production', 'session-review-analytics.json must contain only the v2_production cohort.');
  assert(data.indexVersion === 'v1', 'session-review-analytics.json has an unexpected indexVersion.');
  assert(Array.isArray(data.rows), 'session-review-analytics.json is missing rows.');
  assert(isRecord(data.diagnostics), 'session-review-analytics.json is missing ingestion diagnostics.');
  assert(typeof data.diagnostics.rawProductionCount === 'number', 'session-review-analytics.json diagnostics is missing rawProductionCount.');
  assert(typeof data.diagnostics.acceptedCount === 'number', 'session-review-analytics.json diagnostics is missing acceptedCount.');
  assert(typeof data.diagnostics.rejectedCount === 'number', 'session-review-analytics.json diagnostics is missing rejectedCount.');
  assert(isRecord(data.diagnostics.rejectedByReason), 'session-review-analytics.json diagnostics is missing rejectedByReason.');
  assert(data.diagnostics.rawProductionCount === data.diagnostics.acceptedCount + data.diagnostics.rejectedCount, 'session-review-analytics.json diagnostics raw count must equal accepted + rejected.');
  assert(isRecord(data.summary), 'session-review-analytics.json is missing summary.');
  assert(typeof data.summary.reviewCount === 'number', 'session-review-analytics.json summary is missing reviewCount.');
  assert(typeof data.summary.qualityIndexCount === 'number', 'session-review-analytics.json summary is missing qualityIndexCount.');
  assert(typeof data.summary.notAssessableReviewCount === 'number', 'session-review-analytics.json summary is missing notAssessableReviewCount.');
  assert(data.summary.reviewCount === data.summary.qualityIndexCount + data.summary.notAssessableReviewCount, 'session-review-analytics.json summary reviewCount must equal qualityIndexCount + notAssessableReviewCount.');
  assert(data.summary.meanQualityIndexV1 === null || (typeof data.summary.meanQualityIndexV1 === 'number' && data.summary.meanQualityIndexV1 >= 0 && data.summary.meanQualityIndexV1 <= 100), 'session-review-analytics.json has an invalid meanQualityIndexV1.');
  assert(isRecord(data.criteria) && typeof data.criteria.total === 'number', 'session-review-analytics.json is missing criterion diagnostics.');
  assert(isRecord(data.process), 'session-review-analytics.json is missing process diagnostics.');
  assert(isRecord(data.evidence), 'session-review-analytics.json is missing evidence diagnostics.');
  assert(isRecord(data.disagreement), 'session-review-analytics.json is missing disagreement diagnostics.');
  assert(isRecord(data.reviewers), 'session-review-analytics.json is missing reviewer diagnostics.');
  for (const [index, row] of data.rows.entries()) {
    assert(isRecord(row) && row.cohort === 'v2_production', `session-review-analytics.json row ${index} has an invalid cohort.`);
    assert(typeof row.sessionId === 'string' && row.sessionId.length > 0, `session-review-analytics.json row ${index} is missing sessionId.`);
    assert(isRecord(row.attainment), `session-review-analytics.json row ${index} is missing attainment.`);
    assert(row.attainment.qualityIndexV1 === null || (typeof row.attainment.qualityIndexV1 === 'number' && row.attainment.qualityIndexV1 >= 0 && row.attainment.qualityIndexV1 <= 100), `session-review-analytics.json row ${index} has an invalid qualityIndexV1.`);
  }
}

function validateBackendErrors(data: unknown): asserts data is BackendErrorData {
  assert(isRecord(data), 'backend-errors.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'backend-errors.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'backend-errors.json is missing rows.');
  assert(isRecord(data.summary), 'backend-errors.json is missing summary.');
  assert(typeof data.summary.totalErrorEvents === 'number', 'backend-errors.json summary is missing totalErrorEvents.');
}

function validateFileExtensions(data: unknown): asserts data is FileExtensionData {
  assert(isRecord(data), 'file-types.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'file-types.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'file-types.json is missing rows.');
  assert(Array.isArray(data.summary), 'file-types.json is missing summary.');
}

function validateTokenThroughput(data: unknown): asserts data is TokenThroughputData {
  assert(isRecord(data), 'token-throughput.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'token-throughput.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'token-throughput.json is missing rows.');
  assert(Array.isArray(data.notes), 'token-throughput.json is missing notes.');
  data.rows.forEach((row, index) => {
    assert(isRecord(row), `token-throughput.json row ${index} must be an object.`);
    assert(typeof row.runId === 'string', `token-throughput.json row ${index} is missing runId.`);
    assert(row.modelId === null || typeof row.modelId === 'string', `token-throughput.json row ${index} has an invalid modelId.`);
    assert(row.modelFamily === null || typeof row.modelFamily === 'string', `token-throughput.json row ${index} has an invalid modelFamily.`);
    assert(typeof row.endedAt === 'string', `token-throughput.json row ${index} is missing endedAt.`);
    assert(typeof row.generationDurationMs === 'number' && row.generationDurationMs >= 0, `token-throughput.json row ${index} has an invalid generationDurationMs.`);
    assert(typeof row.outputTokens === 'number' && row.outputTokens >= 0, `token-throughput.json row ${index} has an invalid outputTokens.`);
    assert(typeof row.concurrentBusySessions === 'number' && row.concurrentBusySessions >= 0, `token-throughput.json row ${index} has an invalid concurrentBusySessions.`);
    assert(typeof row.status === 'string', `token-throughput.json row ${index} is missing status.`);
    assert(typeof row.inputTokens === 'number' && row.inputTokens >= 0, `token-throughput.json row ${index} has an invalid inputTokens.`);
    assert(typeof row.cacheReadTokens === 'number' && row.cacheReadTokens >= 0, `token-throughput.json row ${index} has an invalid cacheReadTokens.`);
    assert(typeof row.cacheWriteTokens === 'number' && row.cacheWriteTokens >= 0, `token-throughput.json row ${index} has an invalid cacheWriteTokens.`);
    assert(row.contextTokens === null || (typeof row.contextTokens === 'number' && row.contextTokens >= 0), `token-throughput.json row ${index} has an invalid contextTokens.`);
    assert(row.providerQueueMs === null || (typeof row.providerQueueMs === 'number' && row.providerQueueMs >= 0), `token-throughput.json row ${index} has an invalid providerQueueMs.`);
    assert(typeof row.providerQueueAttemptCount === 'number' && row.providerQueueAttemptCount >= 0, `token-throughput.json row ${index} has an invalid providerQueueAttemptCount.`);
  });
}

function validateRetryTiming(data: unknown): asserts data is RetryTimingData {
  assert(isRecord(data), 'retry-timing.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'retry-timing.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.rows), 'retry-timing.json is missing rows.');
  assert(Array.isArray(data.notes), 'retry-timing.json is missing notes.');
  data.rows.forEach((row, index) => {
    assert(isRecord(row), `retry-timing.json row ${index} must be an object.`);
    assert(typeof row.runId === 'string', `retry-timing.json row ${index} is missing runId.`);
    assert(typeof row.sourceId === 'string', `retry-timing.json row ${index} is missing sourceId.`);
    assert(typeof row.occurredAt === 'string', `retry-timing.json row ${index} is missing occurredAt.`);
    assert(typeof row.attempt === 'number' && row.attempt >= 1, `retry-timing.json row ${index} has an invalid attempt.`);
    assert(typeof row.scheduledDelayMs === 'number' && row.scheduledDelayMs >= 0, `retry-timing.json row ${index} has an invalid scheduledDelayMs.`);
    assert(row.measuredDelayMs === null || (typeof row.measuredDelayMs === 'number' && row.measuredDelayMs >= 0), `retry-timing.json row ${index} has an invalid measuredDelayMs.`);
    assert(row.durationMs === null || (typeof row.durationMs === 'number' && row.durationMs >= 0), `retry-timing.json row ${index} has an invalid durationMs.`);
  });
}

export function validateSiteDataBundle(bundle: SiteDataBundle): void {
  validateManifest(bundle.manifest);
  validateOverview(bundle.overview, bundle.manifest);
  validateRunSummary(bundle.runSummary);
  assert(bundle.modelQuality.cohortLabels.v2Reviews === 'V2 canonical production reviews', 'model-quality.json is missing the V2 cohort label.');
  validateComparativeRows('model-quality.json', bundle.modelQuality.rows);
  validateVerificationImpact(bundle.verificationImpact);
  validateToolUsage(bundle.toolUsage);
  validateComparativeRows('treatment-comparison.json', bundle.treatmentComparison.rows);
  validateTimeline(bundle.timeline);
  validateModelLeaderboard(bundle.modelLeaderboard);
  validatePruningImpact(bundle.pruningImpact);
  validateToolResultPruningImpact(bundle.toolResultPruningImpact);
  validateSessionReviewAnalytics(bundle.sessionReviewAnalytics);
  validateBackendErrors(bundle.backendErrors);
  validateFileExtensions(bundle.fileExtensions);
  validateTokenThroughput(bundle.tokenThroughput);
  validateRetryTiming(bundle.retryTiming);
}

export async function readSiteDataBundle(outputDir: string): Promise<SiteDataBundle> {
  await assertNoUnexpectedSiteDataFiles(outputDir);
  const fileMap = await Promise.all(SITE_DATA_FILE_NAMES.map(async (fileName) => {
    const content = parseJsonOrThrow<unknown>(await fs.readFile(path.join(outputDir, fileName), 'utf8'), path.join(outputDir, fileName));
    return [fileName, content] as const;
  }));
  const files = Object.fromEntries(fileMap) as Record<SiteDataFileName, unknown>;
  return {
    manifest: files['manifest.json'] as SiteDataBundle['manifest'],
    overview: files['overview.json'] as SiteDataBundle['overview'],
    runSummary: files['run-summary.json'] as SiteDataBundle['runSummary'],
    modelQuality: files['model-quality.json'] as SiteDataBundle['modelQuality'],
    verificationImpact: files['verification-impact.json'] as SiteDataBundle['verificationImpact'],
    toolUsage: files['tool-usage.json'] as SiteDataBundle['toolUsage'],
    treatmentComparison: files['treatment-comparison.json'] as SiteDataBundle['treatmentComparison'],
    timeline: files['timeline.json'] as SiteDataBundle['timeline'],
    modelLeaderboard: files['model-leaderboard.json'] as SiteDataBundle['modelLeaderboard'],
    pruningImpact: files['pruning-impact.json'] as SiteDataBundle['pruningImpact'],
    toolResultPruningImpact: files['tool-result-pruning-impact.json'] as SiteDataBundle['toolResultPruningImpact'],
    sessionReviewAnalytics: files['session-review-analytics.json'] as SiteDataBundle['sessionReviewAnalytics'],
    backendErrors: files['backend-errors.json'] as SiteDataBundle['backendErrors'],
    fileExtensions: files['file-types.json'] as SiteDataBundle['fileExtensions'],
    tokenThroughput: files['token-throughput.json'] as SiteDataBundle['tokenThroughput'],
    retryTiming: files['retry-timing.json'] as SiteDataBundle['retryTiming'],
  };
}
