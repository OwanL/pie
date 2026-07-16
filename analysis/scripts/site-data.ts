import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  GENERATOR_VERSION,
  DATA_MODE_LOCAL_DEFAULT,
  SITE_DATA_FILE_NAMES,
  SITE_DATA_SCHEMA_VERSION,
  type AgentReviewComparisonData,
  type BackendErrorData,
  type FileExtensionData,
  type ModelQualityAggregateRow,
  type ModelQualityData,
  type OverviewData,
  type PruningImpactData,
  type ResolutionCounts,
  type PreparedAnalyticsData,
  type PreparedAgentReviewRow,
  type PreparedRunRow,
  type PreparedTurnThroughputRow,
  type RetryTimingData,
  type SiteDataBundle,
  type SiteDataFileName,
  type SiteManifest,
  type TimelineData,
  type TimelineRow,
  type TokenThroughputData,
  type ToolResultPruningImpactData,
  type ToolResultPruningOutcomeBucket,
  type ToolResultPruningOutcomeData,
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

function hasScorableUserOutcome(run: PreparedRunRow): boolean {
  return run.scored
    && run.satisfaction !== null
    && !run.mixedModelConfig
    && !run.mixedTreatmentConfig
    && run.outcomeSource === 'user';
}

function createEmptyResolutionCounts(): ResolutionCounts {
  return {
    resolved: 0,
    partiallyResolved: 0,
    unresolved: 0,
  };
}

function addResolutionCount(counts: ResolutionCounts, resolution: PreparedRunRow['resolution']): void {
  switch (resolution) {
    case 'resolved':
      counts.resolved += 1;
      break;
    case 'partially_resolved':
      counts.partiallyResolved += 1;
      break;
    case 'unresolved':
      counts.unresolved += 1;
      break;
    default:
      break;
  }
}

function createManifest(prepared: PreparedAnalyticsData, generatedAt: Date): SiteManifest {
  const completedRunCount = prepared.runs.filter((run) => run.status !== 'open').length;
  const openRunCount = prepared.runs.filter((run) => run.status === 'open').length;
  const scoredRunCount = prepared.runs.filter((run) => run.scored && run.satisfaction !== null).length;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    sourceAnalyticsSchemaVersion: prepared.sourceSchemaVersion,
    generatedAt: generatedAt.toISOString(),
    sourceWorkspaceKey: prepared.sourceWorkspaceKey,
    sourceExportedAt: prepared.sourceExportedAt,
    completedRunCount,
    openRunCount,
    scoredRunCount,
    dataMode: DATA_MODE_LOCAL_DEFAULT,
    generatorVersion: GENERATOR_VERSION,
  };
}

function createOverview(prepared: PreparedAnalyticsData): OverviewData {
  const runs = prepared.runs;
  const completedRuns = runs.filter((run) => run.status !== 'open');
  const scoredRuns = completedRuns.filter((run) => run.satisfaction !== null);
  // True spend requires a complete parent + applicable subagent total; parent-only estimates
  // are never substituted for incomplete/unknown totals.
  const costValues = completedRuns.map(completeEstimatedRunCostUsd).filter((v): v is number => v !== null);
  const resolutionCounts = createEmptyResolutionCounts();
  for (const run of scoredRuns) {
    addResolutionCount(resolutionCounts, run.resolution);
  }

  const totalToolCalls = completedRuns.reduce((sum, run) => sum + run.toolCallCount, 0);
  const totalToolFailures = completedRuns.reduce((sum, run) => sum + run.toolFailureCount, 0);
  const totalResultIssues = completedRuns.reduce((sum, run) => sum + run.resultIssueCount, 0);
  const latestRunTimestamp = [...completedRuns]
    .map((run) => run.updatedAt)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    totalCompletedRuns: completedRuns.length,
    totalOpenRuns: runs.filter((run) => run.status === 'open').length,
    totalScoredRuns: scoredRuns.length,
    averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
    resolutionCounts,
    medianBusyDurationMs: median(completedRuns.map((run) => run.busyDurationMs)),
    p90BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 90),
    p99BusyDurationMs: percentile(completedRuns.map((run) => run.busyDurationMs), 99),
    verificationRunRate: completedRuns.length === 0
      ? null
      : round(completedRuns.filter((run) => run.verificationTotalCount > 0).length / completedRuns.length, 3),
    toolFailureRate: totalToolCalls === 0 ? null : round(totalToolFailures / totalToolCalls, 3),
    resultIssueRate: totalToolCalls === 0 ? null : round(totalResultIssues / totalToolCalls, 3),
    medianTokenEfficiency: percentile(completedRuns.map((r) => r.tokenEfficiency).filter((v): v is number => v !== null), 50, 1),
    averageContextUtilization: average(completedRuns.map((r) => r.contextUtilization).filter((v): v is number => v !== null), 3),
    averageCacheHitRatio: average(completedRuns.map((r) => r.cacheHitRatio).filter((v): v is number => v !== null), 3),
    firstAttemptSuccessRate: (() => {
      const eligible = completedRuns.filter((r) => r.firstAttemptSuccess !== null);
      return eligible.length === 0
        ? null
        : round(eligible.filter((r) => r.firstAttemptSuccess).length / eligible.length, 3);
    })(),
    totalEstimatedCostUsd: costValues.length === 0 ? null : round(costValues.reduce((sum, v) => sum + v, 0), 4),
    medianEstimatedCostUsd: percentile(costValues, 50, 4),
    latestRunTimestamp,
  };
}

function createModelQuality(prepared: PreparedAnalyticsData): ModelQualityData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    // Group by canonical model family (provider-agnostic), mirroring the leaderboard —
    // provider-specific ids sharing a family collapse into one row. modelFamily is resolved at
    // prepare time; falls back to modelId when unset (and '(unknown)' when missing).
    const mid = run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
    const key = [
      mid,
      normalizeThinkingLevel(run.thinkingLevel),
      normalizeExperimentAssignment(run.experimentAssignment),
    ].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }

  const rows: ModelQualityAggregateRow[] = [...groups.entries()].map(([key, runs]) => {
    const [modelId, thinkingLevel, experimentAssignment] = key.split('::');
    const scoredRuns = runs.filter(hasScorableUserOutcome);
    const nonMixedAgentOutcomes = runs.filter((run) => (
      run.scored
      && run.satisfaction !== null
      && !run.mixedModelConfig
      && !run.mixedTreatmentConfig
      && run.outcomeSource === 'agent'
    ));
    const mixedModelExcludedOutcomes = runs.filter((run) => (
      run.scored && run.satisfaction !== null && run.mixedModelConfig
    ));
    const mixedTreatmentExcludedOutcomes = runs.filter((run) => (
      run.scored && run.satisfaction !== null && !run.mixedModelConfig && run.mixedTreatmentConfig
    ));
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }

    return {
      modelId: modelId ?? '(unknown)',
      thinkingLevel: thinkingLevel ?? '(unspecified)',
      experimentAssignment: experimentAssignment ?? '(none)',
      runCount: runs.length,
      providerModelIds: [...new Set(runs.map((r) => (r.modelId ?? '').trim() || '(unknown)'))].sort(),
      scoredRunCount: scoredRuns.length,
      agentOutcomeCount: nonMixedAgentOutcomes.length,
      mixedModelExcludedOutcomeCount: mixedModelExcludedOutcomes.length,
      mixedTreatmentExcludedOutcomeCount: mixedTreatmentExcludedOutcomes.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
      medianBusyDurationMs: median(runs.map((run) => run.busyDurationMs)),
      p90BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 90),
      p99BusyDurationMs: percentile(runs.map((run) => run.busyDurationMs), 99),
      averageToolFailures: average(runs.map((run) => run.toolFailureCount), 2),
      verificationRunRate: runs.length === 0
        ? null
        : round(runs.filter((run) => run.verificationTotalCount > 0).length / runs.length, 3),
      medianTokenEfficiency: percentile(runs.map((r) => r.tokenEfficiency).filter((v): v is number => v !== null), 50, 1),
      averageContextUtilization: average(runs.map((r) => r.contextUtilization).filter((v): v is number => v !== null), 3),
      averageCacheHitRatio: average(runs.map((r) => r.cacheHitRatio).filter((v): v is number => v !== null), 3),
      firstAttemptSuccessRate: (() => {
        const eligible = runs.filter((r) => r.firstAttemptSuccess !== null);
        return eligible.length === 0
          ? null
          : round(eligible.filter((r) => r.firstAttemptSuccess).length / eligible.length, 3);
      })(),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (right.runCount !== left.runCount) {
      return right.runCount - left.runCount;
    }
    if (left.modelId !== right.modelId) {
      return left.modelId.localeCompare(right.modelId);
    }
    if (left.thinkingLevel !== right.thinkingLevel) {
      return left.thinkingLevel.localeCompare(right.thinkingLevel);
    }
    return left.experimentAssignment.localeCompare(right.experimentAssignment);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    notes: [
      'Satisfaction, resolution, and scoredRunCount use only stable-model, stable-treatment user outcomes, matching leaderboard attribution. Agent outcomes are supplemental; mixed-model and mixed-treatment outcomes are excluded and disclosed separately.',
      'Satisfaction averages from fewer than 3 user outcomes are highly variable and should be interpreted with caution.',
      'Operational run metrics use all completed runs in each group. Runs from the same task group are not independent observations; treat per-run sample sizes as upper bounds.',
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
  const groupedRuns = new Map<string, PreparedRunRow[]>();
  const summaryGroups = new Map<string, PreparedRunRow[]>();

  // Pre-group verification-usage rows by runId so each run's lookup is O(1)
  // instead of re-filtering the full usage list per run (O(R×V) → O(V+R)).
  // Order is preserved (Map arrays follow prepared.verificationUsage order),
  // so the emitted rows are identical to the prior per-run `.filter`.
  const usageByRunId = new Map<string, typeof prepared.verificationUsage>();
  for (const row of prepared.verificationUsage) {
    const existing = usageByRunId.get(row.runId) ?? [];
    existing.push(row);
    usageByRunId.set(row.runId, existing);
  }

  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const usageRows = usageByRunId.get(run.runId) ?? [];
    const kinds = usageRows.map((row) => row.kind);
    const effectiveKinds = kinds.length > 0 ? [...new Set(kinds)] : ['none'];
    for (const verificationKind of effectiveKinds) {
      const count = verificationKind === 'none' ? 0 : usageRows.find((row) => row.kind === verificationKind)?.count ?? 0;
      const countBucket = verificationBucket(count);
      const key = [verificationKind, countBucket, run.verificationState].join('::');
      const existing = groupedRuns.get(key) ?? [];
      existing.push(run);
      groupedRuns.set(key, existing);
    }

    const summaryExisting = summaryGroups.get(run.verificationState) ?? [];
    summaryExisting.push(run);
    summaryGroups.set(run.verificationState, summaryExisting);
  }

  const rows: VerificationImpactRow[] = [...groupedRuns.entries()].map(([key, runs]) => {
    const [verificationKind, countBucket, verificationState] = key.split('::');
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }
    return {
      verificationKind: verificationKind ?? 'none',
      countBucket: (countBucket ?? '0') as VerificationImpactRow['countBucket'],
      verificationState: (verificationState ?? 'none') as VerificationImpactRow['verificationState'],
      runCount: new Set(runs.map((run) => run.runId)).size,
      scoredRunCount: new Set(scoredRuns.map((run) => run.runId)).size,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (left.verificationKind !== right.verificationKind) {
      return left.verificationKind.localeCompare(right.verificationKind);
    }
    if (left.countBucket !== right.countBucket) {
      return left.countBucket.localeCompare(right.countBucket);
    }
    return left.verificationState.localeCompare(right.verificationState);
  });

  const summaryRows = [...summaryGroups.entries()].map(([verificationState, runs]) => {
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }
    return {
      verificationState: verificationState as VerificationImpactData['summaryRows'][number]['verificationState'],
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
    summaryRows,
    notes: [
      'Verification failures are tracked at the run level; per-kind failure attribution is not available in the source snapshots.',
      'Open (in-progress) runs are excluded from verification impact metrics.',
    ],
  };
}

function createToolUsage(prepared: PreparedAnalyticsData): ToolUsageData {
  const grouped = new Map<string, typeof prepared.toolUsage>();
  for (const row of prepared.toolUsage) {
    const existing = grouped.get(row.toolName) ?? [];
    existing.push(row);
    grouped.set(row.toolName, existing);
  }

  const scoredRuns = prepared.runs.filter((run) => run.satisfaction !== null);

  const summaryRows: ToolUsageAggregateRow[] = [...grouped.entries()].map(([toolName, toolRows]) => {
    const usedRunIds = new Set(toolRows.map((row) => row.runId));
    const usedRuns = scoredRuns.filter((run) => usedRunIds.has(run.runId));
    const unusedRuns = scoredRuns.filter((run) => !usedRunIds.has(run.runId));
    return {
      toolName,
      callCount: toolRows.reduce((sum, row) => sum + row.callCount, 0),
      failureCount: toolRows.reduce((sum, row) => sum + row.failureCount, 0),
      executionFailureCount: toolRows.reduce((sum, row) => sum + row.executionFailureCount, 0),
      verificationProjectFailureCount: toolRows.reduce((sum, row) => sum + row.verificationProjectFailureCount, 0),
      probeFailureCount: toolRows.reduce((sum, row) => sum + row.probeFailureCount, 0),
      resultIssueCount: toolRows.reduce((sum, row) => sum + row.resultIssueCount, 0),
      affectedRunCount: usedRunIds.size,
      averageSatisfactionWhenUsed: average(usedRuns.map((run) => run.satisfaction!), 2),
      averageSatisfactionWhenUnused: average(unusedRuns.map((run) => run.satisfaction!), 2),
    };
  });

  summaryRows.sort((left, right) => {
    if (right.callCount !== left.callCount) {
      return right.callCount - left.callCount;
    }
    return left.toolName.localeCompare(right.toolName);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows: prepared.toolUsage,
    summaryRows,
  };
}

function createTreatmentComparison(prepared: PreparedAnalyticsData): TreatmentComparisonData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const key = [
      normalizePromptFamily(run.promptFamily),
      run.promptHashPrefix ?? '',
      run.toolSetHashPrefix ?? '',
      run.skillSetHashPrefix ?? '',
      normalizeExperimentAssignment(run.experimentAssignment),
      run.mixedTreatmentConfig ? 'mixed' : 'pure',
    ].join('::');
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  }

  const rows: TreatmentComparisonRow[] = [...groups.entries()].map(([key, runs]) => {
    const [promptFamily, promptHashPrefix, toolSetHashPrefix, skillSetHashPrefix, experimentAssignment, purity] = key.split('::');
    const scoredRuns = runs.filter((run) => run.satisfaction !== null);
    const resolutionCounts = createEmptyResolutionCounts();
    for (const run of scoredRuns) {
      addResolutionCount(resolutionCounts, run.resolution);
    }

    return {
      promptFamily: promptFamily ?? '(none)',
      promptHashPrefix: promptHashPrefix || null,
      toolSetHashPrefix: toolSetHashPrefix || null,
      skillSetHashPrefix: skillSetHashPrefix || null,
      experimentAssignment: experimentAssignment ?? '(none)',
      mixedTreatmentConfig: purity === 'mixed',
      runCount: runs.length,
      scoredRunCount: scoredRuns.length,
      averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
      resolutionCounts,
    };
  });

  rows.sort((left, right) => {
    if (right.runCount !== left.runCount) {
      return right.runCount - left.runCount;
    }
    if (left.promptFamily !== right.promptFamily) {
      return left.promptFamily.localeCompare(right.promptFamily);
    }
    return left.experimentAssignment.localeCompare(right.experimentAssignment);
  });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
  };
}

function createTimeline(prepared: PreparedAnalyticsData): TimelineData {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of prepared.runs.filter((entry) => entry.status !== 'open')) {
    const existing = groups.get(run.startedDay) ?? [];
    existing.push(run);
    groups.set(run.startedDay, existing);
  }

  const rows: TimelineRow[] = [...groups.entries()]
    .sort(([leftBucket], [rightBucket]) => leftBucket.localeCompare(rightBucket))
    .map(([bucketStart, runs]) => {
      const scoredRuns = runs.filter((run) => run.satisfaction !== null);
      const modelMix = Object.fromEntries(
        [...runs.reduce((counts, run) => {
          const mid = run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
          counts.set(mid, (counts.get(mid) ?? 0) + 1);
          return counts;
        }, new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right)),
      );

      return {
        bucketStart,
        runCount: runs.length,
        scoredRunCount: scoredRuns.length,
        averageSatisfaction: average(scoredRuns.map((run) => run.satisfaction!), 2),
        verificationRunCount: runs.filter((run) => run.verificationTotalCount > 0).length,
        toolFailureCount: runs.reduce((sum, run) => sum + run.toolFailureCount, 0),
        averageBusyDurationMs: average(runs.map((run) => run.busyDurationMs), 0),
        modelMix,
      };
    });

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    rows,
  };
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

/** Mean of a numeric field over a set of runs; null when the set is empty. */
function meanOver(runs: PreparedRunRow[], pick: (r: PreparedRunRow) => number): number | null {
  if (runs.length === 0) return null;
  return runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;
}

/** Fraction of runs satisfying a predicate; null when the set is empty. */
function rateOver(runs: PreparedRunRow[], predicate: (r: PreparedRunRow) => boolean): number | null {
  if (runs.length === 0) return null;
  return runs.filter(predicate).length / runs.length;
}

/** Build the outcome-comparison payload: bucket completed runs by whether
 *  tool-result-pruning was enabled at run start and contrast satisfaction /
 *  resolution / first-attempt-success / tool-failure / churn signals. This
 *  answers the user's question: are outcomes better with or without the
 *  system? */
function buildToolResultPruningOutcomes(prepared: PreparedAnalyticsData): ToolResultPruningOutcomeData {
  const completed = prepared.runs.filter((r) => r.status !== 'open');
  const buckets = new Map<string, PreparedRunRow[]>();
  for (const run of completed) {
    const key = run.fsToolResultPruningEnabled === null ? 'null' : String(run.fsToolResultPruningEnabled);
    const list = buckets.get(key) ?? [];
    list.push(run);
    buckets.set(key, list);
  }
  const order: (boolean | null)[] = [true, false, null];
  const bucketRows = order
    .filter((k) => buckets.has(k === null ? 'null' : String(k)))
    .map((k) => {
      const list = buckets.get(k === null ? 'null' : String(k))!;
      const scored = list.filter((r) => r.satisfaction !== null);
      const resolvedCount = scored.filter((r) => r.resolution === 'resolved').length;
      return {
        enabled: k,
        runCount: list.length,
        scoredRunCount: scored.length,
        meanSatisfaction: meanOver(scored, (r) => r.satisfaction ?? 0),
        resolvedRate: scored.length > 0 ? resolvedCount / scored.length : null,
        firstAttemptSuccessRate: (() => {
          const eligible = list.filter((r) => r.firstAttemptSuccess !== null);
          return eligible.length === 0 ? null : eligible.filter((r) => r.firstAttemptSuccess).length / eligible.length;
        })(),
        meanToolFailureCount: meanOver(list, (r) => r.toolFailureCount),
        meanEditCount: meanOver(list, (r) => r.fileEditCount),
        meanAssistantTurnCount: meanOver(list, (r) => r.assistantTurnCount),
        meanBusyDurationMs: meanOver(list, (r) => r.busyDurationMs),
      } satisfies ToolResultPruningOutcomeBucket;
    });
  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    buckets: bucketRows,
    notes: [
      'Compares completed (non-open) runs bucketed by whether tool-result pruning was enabled at run start.',
      'enabled=true: pruning active; enabled=false: disabled (config.enabled=false or extension toggle off); enabled=null: run predates the field (untracked).',
      'read-tool results are never pruned (hard safety guard), so enabled runs prune bash/ls/grep/find/etc. output only — the comparison reflects that scope.',
      'The system is enabled by default, so the disabled bucket may be small or skewed toward sessions where the user explicitly turned it off (selection bias).',
      'meanSatisfaction / resolvedRate are computed over scored runs only; the other means over all completed runs in the bucket.',
    ],
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

/** Build the agent-vs-user outcome comparison site-data payload. Agent ratings (1–5) come
 *  from the session_review tool; user satisfaction (1–5) comes from the user's run_outcome.
 *  Agreement is computed only over runs scored by BOTH (an agent review joined to a run that
 *  has a user outcome). Multi-reviewer coverage groups reviews by their reviewer-bucket
 *  signature so multi-reviewer vs single-reviewer populations can be contrasted. */
function buildAgentReviewComparison(prepared: PreparedAnalyticsData): AgentReviewComparisonData {
  const rows = prepared.agentReviews;

  // Agent side: group review rows by model family.
  const agentByModel = new Map<string, PreparedAgentReviewRow[]>();
  for (const row of rows) {
    const mid = row.modelFamily?.trim() || '(unknown)';
    const existing = agentByModel.get(mid) ?? [];
    existing.push(row);
    agentByModel.set(mid, existing);
  }

  // User side: group user-scored runs (satisfaction != null) by model family.
  const userByModel = new Map<string, number[]>();
  for (const run of prepared.runs) {
    if (run.status === 'open' || run.satisfaction === null || run.outcomeSource !== 'user') {
      continue;
    }
    const mid = run.modelFamily?.trim() || '(unknown)';
    const existing = userByModel.get(mid) ?? [];
    existing.push(run.satisfaction);
    userByModel.set(mid, existing);
  }

  const modelKeys = new Set<string>([...agentByModel.keys(), ...userByModel.keys()]);

  const perModel = [...modelKeys].map((modelId) => {
    const agentRows = agentByModel.get(modelId) ?? [];
    const userSatisfactions = userByModel.get(modelId) ?? [];
    const agentRatings = agentRows.map((r) => r.agentRating);
    const bothScored = agentRows.filter((r) => r.userSatisfaction !== null);
    const deltas = bothScored.map((r) => Math.abs(r.agentRating - (r.userSatisfaction as number)));
    const completion = { fully: 0, partial: 0, setback: 0 };
    for (const r of agentRows) {
      completion[r.agentCompletion] += 1;
    }
    return {
      modelId,
      agentReviewCount: agentRows.length,
      userOutcomeCount: userSatisfactions.length,
      bothScoredCount: bothScored.length,
      agentAverageRating: average(agentRatings, 2),
      userAverageSatisfaction: average(userSatisfactions, 2),
      agentCompletion: completion,
      agreement: {
        meanAbsDelta: deltas.length > 0 ? round(deltas.reduce((a, b) => a + b, 0) / deltas.length, 3) : null,
        exactCount: bothScored.filter((r) => r.agentRating === r.userSatisfaction).length,
        offByOneCount: bothScored.filter((r) => Math.abs(r.agentRating - (r.userSatisfaction as number)) === 1).length,
        offByTwoPlusCount: bothScored.filter((r) => Math.abs(r.agentRating - (r.userSatisfaction as number)) >= 2).length,
      },
    };
  }).sort((a, b) => b.agentReviewCount - a.agentReviewCount || a.modelId.localeCompare(b.modelId));

  // Multi-reviewer coverage: group by sorted reviewer-bucket signature.
  const byBucket = new Map<string, { buckets: string[]; rows: PreparedAgentReviewRow[] }>();
  for (const row of rows) {
    const sig = JSON.stringify(row.reviewerBuckets);
    const existing = byBucket.get(sig) ?? { buckets: row.reviewerBuckets, rows: [] };
    existing.rows.push(row);
    byBucket.set(sig, existing);
  }
  const reviewerBucketCoverage = [...byBucket.values()]
    .map((entry) => ({
      reviewerBuckets: entry.buckets,
      reviewCount: entry.rows.length,
      averageAgentRating: average(entry.rows.map((r) => r.agentRating), 2),
    }))
    .sort((a, b) => b.reviewCount - a.reviewCount || JSON.stringify(a.reviewerBuckets).localeCompare(JSON.stringify(b.reviewerBuckets)));

  const totalAgentReviews = rows.length;
  const totalRunsScoredByUser = prepared.runs.filter(
    (r) => r.status !== 'open' && r.satisfaction !== null && r.outcomeSource === 'user',
  ).length;
  const totalScoredByBoth = rows.filter((r) => r.userSatisfaction !== null).length;

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    perModel,
    reviewerBucketCoverage,
    overall: {
      totalAgentReviews,
      totalRunsScoredByUser,
      totalScoredByBoth,
    },
    notes: [
      "Agent ratings (1–5) are the session_review tool's judgement; user satisfaction (1–5) is the user's run_outcome. Agreement is computed only over runs scored by BOTH.",
      "reviewerBuckets is the sorted sub-agent bucket signature that fed the rating (e.g. ['medium','small']); an empty array means a single reviewer with no bucket provenance.",
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
    toolResultPruningOutcomes: buildToolResultPruningOutcomes(prepared),
    agentReviewComparison: buildAgentReviewComparison(prepared),
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
    'tool-result-pruning-outcomes.json': bundle.toolResultPruningOutcomes,
    'agent-review-comparison.json': bundle.agentReviewComparison,
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
  assert(typeof manifest.scoredRunCount === 'number', 'manifest.json is missing scoredRunCount.');
  assert(manifest.dataMode === DATA_MODE_LOCAL_DEFAULT, 'manifest.json has an unexpected dataMode.');
}

function validateOverview(overview: unknown, manifest: SiteManifest): asserts overview is OverviewData {
  assert(isRecord(overview), 'overview.json must contain an object.');
  assert(overview.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'overview.json has an unexpected schemaVersion.');
  assert(overview.totalCompletedRuns === manifest.completedRunCount, 'overview.json totalCompletedRuns does not match manifest.json.');
  assert(overview.totalOpenRuns === manifest.openRunCount, 'overview.json totalOpenRuns does not match manifest.json.');
  assert(overview.totalScoredRuns === manifest.scoredRunCount, 'overview.json totalScoredRuns does not match manifest.json.');
}

function validateRunSummary(runSummary: unknown): void {
  assert(isRecord(runSummary), 'run-summary.json must contain an object.');
  assert(runSummary.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'run-summary.json has an unexpected schemaVersion.');
  assert(Array.isArray(runSummary.rows), 'run-summary.json is missing rows.');
  for (const [index, row] of runSummary.rows.entries()) {
    assert(isRecord(row), `run-summary.json row ${index} must be an object.`);
    assert(typeof row.runId === 'string', `run-summary.json row ${index} is missing runId.`);
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
  const isNonNegativeInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  );
  const isUnitInterval = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  );

  assert(isRecord(leaderboard), 'model-leaderboard.json must contain an object.');
  assert(leaderboard.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'model-leaderboard.json has an unexpected schemaVersion.');
  assert(Array.isArray(leaderboard.rows), 'model-leaderboard.json is missing rows.');
  assert(isRecord(leaderboard.weights), 'model-leaderboard.json is missing weights.');
  for (const dimension of ['satisfaction', 'resolutionRate', 'fileChurn', 'toolReliability', 'verificationPassRate', 'tokenEfficiency']) {
    assert(typeof leaderboard.weights[dimension] === 'number' && Number.isFinite(leaderboard.weights[dimension]), `model-leaderboard.json weights.${dimension} is invalid.`);
  }
  assert(leaderboard.weights.fileChurn === 0, 'model-leaderboard.json process weights must be zero.');
  assert(leaderboard.weights.toolReliability === 0, 'model-leaderboard.json process weights must be zero.');
  assert(leaderboard.weights.verificationPassRate === 0, 'model-leaderboard.json process weights must be zero.');
  assert(leaderboard.weights.tokenEfficiency === 0, 'model-leaderboard.json process weights must be zero.');
  assert(
    Math.abs((leaderboard.weights.satisfaction as number) + (leaderboard.weights.resolutionRate as number) - 1) <= 1e-9,
    'model-leaderboard.json satisfaction and resolution weights must sum to 1.',
  );
  assert(isNonNegativeInteger(leaderboard.minimumScoredRuns), 'model-leaderboard.json has an invalid minimumScoredRuns.');
  assert(isNonNegativeInteger(leaderboard.minimumEffectiveTasks), 'model-leaderboard.json has an invalid minimumEffectiveTasks.');
  assert(isUnitInterval(leaderboard.minimumTaskScoringCoverage), 'model-leaderboard.json minimumTaskScoringCoverage must be in [0,1].');
  assert(isRecord(leaderboard.caseMix), 'model-leaderboard.json is missing caseMix.');
  const caseMix = leaderboard.caseMix;
  assert(caseMix.method === 'direct_standardization', 'model-leaderboard.json has an invalid caseMix method.');
  assert(typeof caseMix.applied === 'boolean', 'model-leaderboard.json caseMix is missing applied.');
  assert(isNonNegativeInteger(caseMix.minimumRatedTasksPerBand), 'model-leaderboard.json caseMix has an invalid minimumRatedTasksPerBand.');
  assert(isNonNegativeInteger(caseMix.minimumModelRatedTasksPerBand), 'model-leaderboard.json caseMix has an invalid minimumModelRatedTasksPerBand.');
  assert(isUnitInterval(caseMix.minimumTargetBandWeight), 'model-leaderboard.json caseMix has an invalid minimumTargetBandWeight.');
  assert(isRecord(caseMix.targetBandWeights), 'model-leaderboard.json caseMix is missing targetBandWeights.');
  assert(isRecord(caseMix.scoredBandCounts), 'model-leaderboard.json caseMix is missing scoredBandCounts.');
  const bands = ['low', 'medium', 'high'] as const;
  for (const band of bands) {
    assert(isUnitInterval(caseMix.targetBandWeights[band]), `model-leaderboard.json caseMix.targetBandWeights.${band} is invalid.`);
    assert(isNonNegativeInteger(caseMix.scoredBandCounts[band]), `model-leaderboard.json caseMix.scoredBandCounts.${band} is invalid.`);
  }
  assert(Array.isArray(caseMix.activeSignals), 'model-leaderboard.json caseMix is missing activeSignals.');
  assert(Array.isArray(leaderboard.notes), 'model-leaderboard.json is missing notes.');
  assert(isRecord(leaderboard.sourceWeights), 'model-leaderboard.json is missing sourceWeights.');
  assert(isRecord(leaderboard.sourcePriors), 'model-leaderboard.json is missing sourcePriors.');
  assert(isRecord(leaderboard.sourceLogitSpreads), 'model-leaderboard.json is missing sourceLogitSpreads.');
  assert(isRecord(leaderboard.shrinkage), 'model-leaderboard.json is missing shrinkage.');
  let expectedRank = 1;
  let seenUnranked = false;
  for (const [index, row] of leaderboard.rows.entries()) {
    assert(isRecord(row), `model-leaderboard.json row ${index} must be an object.`);
    assert(typeof row.modelId === 'string' && row.thinkingLevel === '(all)', `model-leaderboard.json row ${index} must be a family-level row.`);
    assert(Array.isArray(row.thinkingLevels), `model-leaderboard.json row ${index} is missing thinkingLevels.`);
    for (const field of ['userEvidenceCount', 'userEvidenceMass', 'agentEvidenceCount', 'agentEvidenceMass', 'processEvidenceCount', 'processEvidenceMass', 'canonicalTaskCount', 'transcriptOnlySessionCount', 'mixedAttributionMass']) {
      assert(typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] >= 0, `model-leaderboard.json row ${index}.${field} is invalid.`);
    }
    assert(['outcome-backed', 'thin-outcome', 'telemetry-only'].includes(String(row.evidenceTier)), `model-leaderboard.json row ${index} has invalid evidenceTier.`);
    for (const field of ['userChannelScore', 'agentChannelScore', 'processChannelScore', 'compositeScore']) {
      assert(row[field] === null || isUnitInterval(row[field]), `model-leaderboard.json row ${index}.${field} is invalid.`);
    }
    // Migrated invariants: count / coverage / gate-shape fields.
    assert(isNonNegativeInteger(row.runCount), `model-leaderboard.json row ${index} has an invalid runCount.`);
    assert(isNonNegativeInteger(row.scoredRunCount), `model-leaderboard.json row ${index} has an invalid scoredRunCount.`);
    assert(isNonNegativeInteger(row.effectiveTaskCount), `model-leaderboard.json row ${index} has an invalid effectiveTaskCount.`);
    assert(isNonNegativeInteger(row.attributableRunCount), `model-leaderboard.json row ${index} has an invalid attributableRunCount.`);
    assert(isNonNegativeInteger(row.attributableTaskCount), `model-leaderboard.json row ${index} has an invalid attributableTaskCount.`);
    assert(row.scoringCoverage === null || isUnitInterval(row.scoringCoverage), `model-leaderboard.json row ${index} has invalid scoringCoverage.`);
    assert(typeof row.scoringCoverageGateFailed === 'boolean', `model-leaderboard.json row ${index} is missing scoringCoverageGateFailed.`);
    assert(typeof row.caseMixAdjusted === 'boolean', `model-leaderboard.json row ${index} is missing caseMixAdjusted.`);
    assert(typeof row.caseMixBandOverlapGateFailed === 'boolean', `model-leaderboard.json row ${index} is missing caseMixBandOverlapGateFailed.`);
    assert(isRecord(row.taskComplexityBandCounts), `model-leaderboard.json row ${index} is missing taskComplexityBandCounts.`);
    for (const band of bands) {
      assert(isNonNegativeInteger(row.taskComplexityBandCounts[band]), `model-leaderboard.json row ${index} has invalid ${band} task count.`);
    }
    // Migrated invariant: provider canonical run/scored sums (transcript fields are separate).
    assert(Array.isArray(row.providers), `model-leaderboard.json row ${index} is missing providers.`);
    let providerRunSum = 0;
    let providerScoredSum = 0;
    for (const [pIndex, provider] of row.providers.entries()) {
      assert(isRecord(provider), `model-leaderboard.json row ${index} providers[${pIndex}] must be an object.`);
      assert(typeof provider.modelId === 'string', `model-leaderboard.json row ${index} providers[${pIndex}] is missing modelId.`);
      assert(isNonNegativeInteger(provider.runCount), `model-leaderboard.json row ${index} providers[${pIndex}] has an invalid runCount.`);
      assert(isNonNegativeInteger(provider.scoredRunCount), `model-leaderboard.json row ${index} providers[${pIndex}] has an invalid scoredRunCount.`);
      assert(isNonNegativeInteger(provider.transcriptOnlySessionCount), `model-leaderboard.json row ${index} providers[${pIndex}] has an invalid transcriptOnlySessionCount.`);
      assert(typeof provider.transcriptEvidenceMass === 'number' && Number.isFinite(provider.transcriptEvidenceMass) && provider.transcriptEvidenceMass >= 0, `model-leaderboard.json row ${index} providers[${pIndex}] has an invalid transcriptEvidenceMass.`);
      providerRunSum += provider.runCount;
      providerScoredSum += provider.scoredRunCount;
    }
    assert(providerRunSum === row.runCount, `model-leaderboard.json row ${index} provider runCount sum (${providerRunSum}) != row.runCount (${row.runCount}).`);
    assert(providerScoredSum === row.scoredRunCount, `model-leaderboard.json row ${index} provider scoredRunCount sum (${providerScoredSum}) != row.scoredRunCount (${row.scoredRunCount}).`);
    // Migrated invariant: dimensions shape/ranges.
    assert(isRecord(row.dimensions), `model-leaderboard.json row ${index} is missing dimensions.`);
    assert(isRecord(row.dimensions.tokenEfficiency), `model-leaderboard.json row ${index} is missing tokenEfficiency dimension.`);
    // Migrated invariant: rank ordering / sequential ranks.
    if (row.compositeScore !== null) {
      assert(row.rank === expectedRank, `model-leaderboard.json row ${index} has a non-contiguous rank.`);
      expectedRank += 1;
      assert(!seenUnranked, `model-leaderboard.json row ${index} is ranked after unranked rows.`);
      assert(row.unadjustedCompositeScore !== null, `model-leaderboard.json row ${index} has rank but null unadjustedCompositeScore.`);
      assert(row.reliabilityFactor !== null && typeof row.reliabilityFactor === 'number', `model-leaderboard.json row ${index} has rank but invalid reliabilityFactor.`);
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

function validateToolResultPruningOutcomes(data: unknown): asserts data is ToolResultPruningOutcomeData {
  assert(isRecord(data), 'tool-result-pruning-outcomes.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'tool-result-pruning-outcomes.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.buckets), 'tool-result-pruning-outcomes.json is missing buckets.');
  assert(Array.isArray(data.notes), 'tool-result-pruning-outcomes.json is missing notes.');
}

function validateAgentReviewComparison(data: unknown): asserts data is AgentReviewComparisonData {
  assert(isRecord(data), 'agent-review-comparison.json must contain an object.');
  assert(data.schemaVersion === SITE_DATA_SCHEMA_VERSION, 'agent-review-comparison.json has an unexpected schemaVersion.');
  assert(Array.isArray(data.perModel), 'agent-review-comparison.json is missing perModel.');
  assert(Array.isArray(data.reviewerBucketCoverage), 'agent-review-comparison.json is missing reviewerBucketCoverage.');
  assert(isRecord(data.overall), 'agent-review-comparison.json is missing overall.');
  assert(typeof data.overall.totalAgentReviews === 'number', 'agent-review-comparison.json overall is missing totalAgentReviews.');
  assert(typeof data.overall.totalRunsScoredByUser === 'number', 'agent-review-comparison.json overall is missing totalRunsScoredByUser.');
  assert(typeof data.overall.totalScoredByBoth === 'number', 'agent-review-comparison.json overall is missing totalScoredByBoth.');
  assert(Array.isArray(data.notes), 'agent-review-comparison.json is missing notes.');
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
  validateComparativeRows('model-quality.json', bundle.modelQuality.rows);
  validateVerificationImpact(bundle.verificationImpact);
  validateToolUsage(bundle.toolUsage);
  validateComparativeRows('treatment-comparison.json', bundle.treatmentComparison.rows);
  validateTimeline(bundle.timeline);
  validateModelLeaderboard(bundle.modelLeaderboard);
  validatePruningImpact(bundle.pruningImpact);
  validateToolResultPruningImpact(bundle.toolResultPruningImpact);
  validateToolResultPruningOutcomes(bundle.toolResultPruningOutcomes);
  validateAgentReviewComparison(bundle.agentReviewComparison);
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
    toolResultPruningOutcomes: files['tool-result-pruning-outcomes.json'] as SiteDataBundle['toolResultPruningOutcomes'],
    agentReviewComparison: files['agent-review-comparison.json'] as SiteDataBundle['agentReviewComparison'],
    backendErrors: files['backend-errors.json'] as SiteDataBundle['backendErrors'],
    fileExtensions: files['file-types.json'] as SiteDataBundle['fileExtensions'],
    tokenThroughput: files['token-throughput.json'] as SiteDataBundle['tokenThroughput'],
    retryTiming: files['retry-timing.json'] as SiteDataBundle['retryTiming'],
  };
}
