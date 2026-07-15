import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedRunRow } from '../scripts/contracts.ts';
import { createModelLeaderboard, createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('family leaderboard ranks every observed non-unknown family with regularized source channels', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const leaderboard = createModelLeaderboard(prepared);
  assert.equal(leaderboard.schemaVersion, 4);
  assert.deepEqual(leaderboard.sourceWeights, { user: 0.6, agent: 0.25, process: 0.15 });
  assert.deepEqual(leaderboard.shrinkage, { user: 4, agent: 8, process: 20 });
  const ranked = leaderboard.rows.filter((row) => row.modelId !== '(unknown)');
  assert.ok(ranked.length > 0);
  assert.deepEqual(ranked.map((row) => row.rank), ranked.map((_, index) => index + 1));
  for (const row of ranked) {
    assert.equal(row.thinkingLevel, '(all)');
    assert.ok(row.compositeScore !== null && row.compositeScore >= 0 && row.compositeScore <= 1);
    assert.ok(row.scoreInterval80 && row.scoreInterval80.lower <= row.compositeScore && row.scoreInterval80.upper >= row.compositeScore);
    assert.ok(['outcome-backed', 'thin-outcome', 'telemetry-only'].includes(row.evidenceTier));
  }
});

test('run-only compatibility path collapses thinking levels to one family row', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const first = prepared.runs.find((run) => run.modelFamily !== null)!;
  const altered = { ...first, runId: `${first.runId}-thinking`, taskGroupId: `${first.taskGroupId}-thinking`, thinkingLevel: first.thinkingLevel === 'high' ? 'low' as const : 'high' as const };
  const data = createModelLeaderboardFromRuns([first, altered]);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0]!.thinkingLevel, '(all)');
  assert.equal(data.rows[0]!.thinkingLevels.length, 2);
});

/** Build a minimal PreparedRunRow for synthetic leaderboard tests. */
function makeRun(overrides: Partial<PreparedRunRow> & { runId: string; modelId: string }): PreparedRunRow {
  return {
    runId: overrides.runId,
    taskGroupId: overrides.taskGroupId ?? `${overrides.runId}-task`,
    sessionPathHash: overrides.sessionPathHash ?? `hash-${overrides.runId}`,
    status: overrides.status ?? 'scored',
    scored: overrides.scored ?? true,
    startedAt: overrides.startedAt ?? '2026-05-10T12:00:00.000Z',
    startedDay: overrides.startedDay ?? '2026-05-10',
    updatedAt: overrides.updatedAt ?? '2026-05-10T12:00:00.000Z',
    finalizedAt: overrides.finalizedAt ?? '2026-05-10T12:00:00.000Z',
    finalizationReason: overrides.finalizationReason ?? 'scored',
    resolution: overrides.resolution ?? 'resolved',
    satisfaction: overrides.satisfaction ?? 4,
    outcomeSource: overrides.outcomeSource ?? 'user',
    modelId: overrides.modelId,
    modelFamily: overrides.modelFamily ?? overrides.modelId,
    provider: overrides.provider ?? null,
    thinkingLevel: overrides.thinkingLevel ?? 'high',
    mixedModelConfig: overrides.mixedModelConfig ?? false,
    mixedTreatmentConfig: overrides.mixedTreatmentConfig ?? false,
    experimentAssignment: overrides.experimentAssignment ?? null,
    promptFamily: overrides.promptFamily ?? null,
    promptHashPrefix: overrides.promptHashPrefix ?? null,
    promptCapturedAt: overrides.promptCapturedAt ?? null,
    toolSetHashPrefix: overrides.toolSetHashPrefix ?? null,
    skillSetHashPrefix: overrides.skillSetHashPrefix ?? null,
    skillEntries: overrides.skillEntries ?? [],
    activeExtensions: overrides.activeExtensions ?? [],
    selectedToolCount: overrides.selectedToolCount ?? 0,
    skillCount: overrides.skillCount ?? 0,
    contextFileCount: overrides.contextFileCount ?? 0,
    promptGuidelineCount: overrides.promptGuidelineCount ?? 0,
    initialUserMessageChars: overrides.initialUserMessageChars ?? 100,
    fsSubagentAlwaysParentModel: overrides.fsSubagentAlwaysParentModel ?? null,
    fsPruningMode: overrides.fsPruningMode ?? null,
    fsPruningEnabled: overrides.fsPruningEnabled ?? null,
    fsExtensionToggles: overrides.fsExtensionToggles ?? {},
    fsToolResultPruningEnabled: overrides.fsToolResultPruningEnabled ?? null,
    fsToolResultPruningProfile: overrides.fsToolResultPruningProfile ?? null,
    sendCount: overrides.sendCount ?? 1,
    assistantTurnCount: overrides.assistantTurnCount ?? 1,
    assistantTurnDurationMs: overrides.assistantTurnDurationMs ?? 5000,
    busyDurationMs: overrides.busyDurationMs ?? 6000,
    busyPeriodCount: overrides.busyPeriodCount ?? 1,
    interruptedCount: overrides.interruptedCount ?? 0,
    messageEditCount: overrides.messageEditCount ?? 0,
    truncatedAfterCount: overrides.truncatedAfterCount ?? 0,
    backendErrorCount: overrides.backendErrorCount ?? 0,
    contextTokens: overrides.contextTokens ?? 10000,
    contextLimit: overrides.contextLimit ?? 100000,
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 500,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    tokenReportedTurnCount: overrides.tokenReportedTurnCount ?? 1,
    filesystemPathRefCount: overrides.filesystemPathRefCount ?? 0,
    imageInputCount: overrides.imageInputCount ?? 0,
    imageInputBytes: overrides.imageInputBytes ?? 0,
    unsupportedInputCount: overrides.unsupportedInputCount ?? 0,
    inputKindsUsed: overrides.inputKindsUsed ?? [],
    toolCallCount: overrides.toolCallCount ?? 0,
    toolDurationMs: overrides.toolDurationMs ?? 0,
    timedToolCallCount: overrides.timedToolCallCount ?? 0,
    toolFailureCount: overrides.toolFailureCount ?? 0,
    resultIssueCount: overrides.resultIssueCount ?? 0,
    subagentCallCount: overrides.subagentCallCount ?? 0,
    subagentTaskCount: overrides.subagentTaskCount ?? 0,
    subagentAgentCount: overrides.subagentAgentCount ?? 0,
    subagentScoredTaskCount: overrides.subagentScoredTaskCount ?? 0,
    subagentMeanPrecision: overrides.subagentMeanPrecision ?? null,
    subagentMeanCreativity: overrides.subagentMeanCreativity ?? null,
    subagentMeanReasoning: overrides.subagentMeanReasoning ?? null,
    subagentMeanThoroughness: overrides.subagentMeanThoroughness ?? null,
    subagentMaxPrecision: overrides.subagentMaxPrecision ?? null,
    subagentMaxCreativity: overrides.subagentMaxCreativity ?? null,
    subagentMaxReasoning: overrides.subagentMaxReasoning ?? null,
    subagentMaxThoroughness: overrides.subagentMaxThoroughness ?? null,
    subagentCompositeMean: overrides.subagentCompositeMean ?? null,
    subagentInputTokens: overrides.subagentInputTokens ?? 0,
    subagentOutputTokens: overrides.subagentOutputTokens ?? 0,
    subagentCacheReadTokens: overrides.subagentCacheReadTokens ?? 0,
    subagentCacheWriteTokens: overrides.subagentCacheWriteTokens ?? 0,
    subagentEstimatedCostUsd: overrides.subagentEstimatedCostUsd ?? null,
    totalEstimatedCostUsd: overrides.totalEstimatedCostUsd ?? null,
    compactionCount: overrides.compactionCount ?? 0,
    autoRetryCount: overrides.autoRetryCount ?? 0,
    skillPruningPrepassInputTokens: overrides.skillPruningPrepassInputTokens ?? 0,
    skillPruningPrepassOutputTokens: overrides.skillPruningPrepassOutputTokens ?? 0,
    skillPruningPrepassCacheReadTokens: overrides.skillPruningPrepassCacheReadTokens ?? 0,
    skillPruningPrepassCacheWriteTokens: overrides.skillPruningPrepassCacheWriteTokens ?? 0,
    lastTurnInputTokens: overrides.lastTurnInputTokens ?? null,
    lastTurnOutputTokens: overrides.lastTurnOutputTokens ?? null,
    lastTurnCacheReadTokens: overrides.lastTurnCacheReadTokens ?? null,
    lastTurnCacheWriteTokens: overrides.lastTurnCacheWriteTokens ?? null,
    lastTurnTotalTokens: overrides.lastTurnTotalTokens ?? null,
    lastTurnReasoningTokens: overrides.lastTurnReasoningTokens ?? null,
    treatmentChangeKinds: overrides.treatmentChangeKinds ?? [],
    verificationTotalCount: overrides.verificationTotalCount ?? 0,
    verificationFailureCount: overrides.verificationFailureCount ?? 0,
    verificationState: overrides.verificationState ?? 'none',
    verificationCountBucket: overrides.verificationCountBucket ?? '0',
    verificationCountsByKind: overrides.verificationCountsByKind ?? { test: 0, build: 0, lint: 0, typecheck: 0, format: 0, other: 0 },
    fileWriteCount: overrides.fileWriteCount ?? 0,
    fileEditCount: overrides.fileEditCount ?? 0,
    fileDeleteCount: overrides.fileDeleteCount ?? 0,
    fileRenameCount: overrides.fileRenameCount ?? 0,
    touchedFileCount: overrides.touchedFileCount ?? 0,
    lineAdditions: overrides.lineAdditions ?? 0,
    lineDeletions: overrides.lineDeletions ?? 0,
    lineModifications: overrides.lineModifications ?? 0,
    lineMutationTotal: overrides.lineMutationTotal ?? 0,
    tokenEfficiency: overrides.tokenEfficiency ?? null,
    contextUtilization: overrides.contextUtilization ?? null,
    cacheHitRatio: overrides.cacheHitRatio ?? null,
    firstAttemptSuccess: overrides.firstAttemptSuccess ?? true,
    editRevisitRate: overrides.editRevisitRate ?? null,
    filesReviewedCount: overrides.filesReviewedCount ?? 0,
    readRevisitRate: overrides.readRevisitRate ?? null,
    estimatedCostUsd: overrides.estimatedCostUsd ?? null,
  };
}

test('dimension native bounds: all dimension values stay within their native ranges', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 5; i++) {
    runs.push(makeRun({
      runId: `strong-${i}`, modelId: 'strong-model',
      satisfaction: 5, resolution: 'resolved',
      editRevisitRate: 0.8, tokenEfficiency: 40,
      toolCallCount: 10, toolFailureCount: 2,
      verificationTotalCount: 3, verificationState: 'passing',
    }));
  }
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows[0]!;
  const dims = row.dimensions;
  // satisfaction is mapped to [1, 5]
  assert.ok(dims.satisfaction.value! >= 1 && dims.satisfaction.value! <= 5, `satisfaction ${dims.satisfaction.value} in [1,5]`);
  // resolutionRate is [0, 1]
  assert.ok(dims.resolutionRate.value! >= 0 && dims.resolutionRate.value! <= 1, `resolutionRate ${dims.resolutionRate.value} in [0,1]`);
  // fileChurn is [0, 1] (re-edit rate)
  assert.ok(dims.fileChurn.value! >= 0 && dims.fileChurn.value! <= 1, `fileChurn ${dims.fileChurn.value} in [0,1]`);
  // toolReliability is [0, 1]
  assert.ok(dims.toolReliability.value! >= 0 && dims.toolReliability.value! <= 1, `toolReliability ${dims.toolReliability.value} in [0,1]`);
  // verificationPassRate is [0, 1]
  assert.ok(dims.verificationPassRate.value! >= 0 && dims.verificationPassRate.value! <= 1, `verificationPassRate ${dims.verificationPassRate.value} in [0,1]`);
  // tokenEfficiency is capped at 50
  assert.ok(dims.tokenEfficiency.value! >= 0 && dims.tokenEfficiency.value! <= 50, `tokenEfficiency ${dims.tokenEfficiency.value} in [0,50]`);
});

test('subagent context fields: subagentRunCount, usageRate, and avgTasks are populated', () => {
  const runs: PreparedRunRow[] = [
    makeRun({ runId: 'sub-1', modelId: 'sub-model', subagentCallCount: 2, subagentTaskCount: 5 }),
    makeRun({ runId: 'sub-2', modelId: 'sub-model', subagentCallCount: 0, subagentTaskCount: 0 }),
    makeRun({ runId: 'sub-3', modelId: 'sub-model', subagentCallCount: 1, subagentTaskCount: 3 }),
  ];
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows[0]!;
  assert.equal(row.subagentRunCount, 2, 'two of three runs used subagents');
  assert.ok(Math.abs(row.subagentUsageRate! - 2 / 3) < 0.001, 'subagentUsageRate is 2/3');
  // avgSubagentTasksPerRun is mean over runs that used subagents: (5 + 3) / 2 = 4
  assert.equal(row.avgSubagentTasksPerRun, 4);
});

test('stronger equal-evidence synthetic model ranks above weaker', () => {
  const strong: PreparedRunRow[] = [];
  const weak: PreparedRunRow[] = [];
  for (let i = 0; i < 6; i++) {
    strong.push(makeRun({ runId: `strong-${i}`, modelId: 'strong-model', satisfaction: 5, resolution: 'resolved' }));
    weak.push(makeRun({ runId: `weak-${i}`, modelId: 'weak-model', satisfaction: 1, resolution: 'unresolved' }));
  }
  const leaderboard = createModelLeaderboardFromRuns([...strong, ...weak]);
  const strongRow = leaderboard.rows.find((row) => row.modelId === 'strong-model')!;
  const weakRow = leaderboard.rows.find((row) => row.modelId === 'weak-model')!;
  assert.ok(strongRow.rank !== null && weakRow.rank !== null);
  assert.ok(strongRow.rank! < weakRow.rank!, `strong (${strongRow.rank}) should rank above weak (${weakRow.rank})`);
  assert.ok(strongRow.compositeScore! > weakRow.compositeScore!, 'strong composite should exceed weak');
});

test('fileChurn diagnostic direction: value is re-edit rate, shrunk inverts for display', () => {
  const runs: PreparedRunRow[] = [
    makeRun({ runId: 'churn-1', modelId: 'churn-model', editRevisitRate: 0.9 }),
    makeRun({ runId: 'churn-2', modelId: 'churn-model', editRevisitRate: 0.9 }),
  ];
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const dim = leaderboard.rows[0]!.dimensions.fileChurn;
  assert.equal(dim.value, 0.9, 'fileChurn value is the raw re-edit rate (higher = worse)');
  assert.equal(dim.shrunk, 0.1, 'fileChurn shrunk inverts (1 - value) so higher churn = lower score');
});

test('EB shrinkage: sparse extreme shrinks toward pool, dense stays closer to observed', () => {
  // A pool model with low satisfaction creates a prior below the extreme, so EB shrinkage
  // pulls sparse evidence more strongly toward the pool than dense evidence.
  const pool: PreparedRunRow[] = [];
  for (let i = 0; i < 10; i++) {
    pool.push(makeRun({ runId: `pool-${i}`, modelId: 'pool-model', satisfaction: 1, resolution: 'unresolved' }));
  }
  const sparse: PreparedRunRow[] = [
    makeRun({ runId: 'sparse-0', modelId: 'sparse-model', satisfaction: 5, resolution: 'resolved' }),
  ];
  const dense: PreparedRunRow[] = [];
  for (let i = 0; i < 8; i++) {
    dense.push(makeRun({ runId: `dense-${i}`, modelId: 'dense-model', satisfaction: 5, resolution: 'resolved' }));
  }
  const leaderboard = createModelLeaderboardFromRuns([...pool, ...sparse, ...dense]);
  const sparseRow = leaderboard.rows.find((row) => row.modelId === 'sparse-model')!;
  const denseRow = leaderboard.rows.find((row) => row.modelId === 'dense-model')!;
  // Both have the same observed mean (satisfaction=5), but the sparse model has lower
  // evidenceWeight (n/(n+K) is smaller), so its estimate shrinks more toward the pool.
  assert.ok(sparseRow.evidenceWeight! < denseRow.evidenceWeight!, 'sparse model has lower evidence weight');
  // The dense model's user channel score should be closer to the observed extreme (higher)
  // than the sparse model's, which shrinks more toward the pooled prior.
  assert.ok(denseRow.userChannelScore! > sparseRow.userChannelScore!, 'dense model stays closer to observed extreme');
});

test('open runs excluded from leaderboard run counts', () => {
  const runs: PreparedRunRow[] = [
    makeRun({ runId: 'completed-1', modelId: 'excl-model', status: 'scored', satisfaction: 4 }),
    makeRun({ runId: 'open-1', modelId: 'excl-model', status: 'open', scored: false, satisfaction: null, resolution: null, outcomeSource: null }),
  ];
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows.find((row) => row.modelId === 'excl-model')!;
  assert.equal(row.runCount, 1, 'open run is excluded from runCount');
  assert.equal(row.scoredRunCount, 1);
});

test('null telemetry produces finite leaderboard values (no NaN/Infinity)', () => {
  const runs: PreparedRunRow[] = [
    makeRun({
      runId: 'null-telemetry-1', modelId: 'null-model',
      tokenEfficiency: null, editRevisitRate: null, contextUtilization: null,
      cacheHitRatio: null, totalEstimatedCostUsd: null, estimatedCostUsd: null,
      verificationTotalCount: 0, verificationState: 'none', toolCallCount: 0,
    }),
    makeRun({
      runId: 'null-telemetry-2', modelId: 'null-model',
      tokenEfficiency: null, editRevisitRate: null, contextUtilization: null,
      cacheHitRatio: null, totalEstimatedCostUsd: null, estimatedCostUsd: null,
      verificationTotalCount: 0, verificationState: 'none', toolCallCount: 0,
    }),
  ];
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows[0]!;
  for (const value of [row.compositeScore, row.unadjustedCompositeScore, row.evidenceWeight, row.reliabilityFactor, row.caseMixOverlap]) {
    assert.ok(value === null || Number.isFinite(value), `leaderboard numeric field is finite or null: ${value}`);
  }
  for (const dim of Object.values(row.dimensions)) {
    assert.ok(dim.value === null || Number.isFinite(dim.value), 'dimension value is finite or null');
    assert.ok(dim.shrunk === null || Number.isFinite(dim.shrunk), 'dimension shrunk is finite or null');
  }
  assert.equal(row.dimensions.fileChurn.value, null, 'no edits → null fileChurn');
  assert.equal(row.dimensions.tokenEfficiency.value, null, 'no token efficiency → null');
  assert.equal(row.medianCostUsd, null, 'no cost → null');
});

test('provider canonical sums: runCount and scoredRunCount sum to row totals', async () => {
  const fixture = deepClone(await loadFixture());
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  for (const row of leaderboard.rows) {
    const runSum = row.providers.reduce((sum, provider) => sum + provider.runCount, 0);
    const scoredSum = row.providers.reduce((sum, provider) => sum + provider.scoredRunCount, 0);
    assert.equal(runSum, row.runCount, `provider runCount sum matches row.runCount for ${row.modelId}`);
    assert.equal(scoredSum, row.scoredRunCount, `provider scoredRunCount sum matches row.scoredRunCount for ${row.modelId}`);
    // Transcript fields are always present and non-negative.
    for (const provider of row.providers) {
      assert.ok(typeof provider.transcriptOnlySessionCount === 'number' && provider.transcriptOnlySessionCount >= 0);
      assert.ok(typeof provider.transcriptEvidenceMass === 'number' && Number.isFinite(provider.transcriptEvidenceMass) && provider.transcriptEvidenceMass >= 0);
    }
  }
});

test('userOutcomeCount and agentOutcomeCount are rounded consistently with evidence mass', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const leaderboard = createModelLeaderboard(prepared);
  for (const row of leaderboard.rows) {
    assert.equal(row.userOutcomeCount, row.userEvidenceMass, 'userOutcomeCount matches userEvidenceMass (both rounded)');
    assert.equal(row.agentOutcomeCount, row.agentEvidenceMass, 'agentOutcomeCount matches agentEvidenceMass (both rounded)');
  }
});

test('unknown family has null compositeScore and null rank, sorted after ranked rows', async () => {
  const fixture = deepClone(await loadFixture());
  // Ensure an unknown family exists by deleting a modelId.
  delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).modelId;
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  const unknownRow = leaderboard.rows.find((row) => row.modelId === '(unknown)');
  if (unknownRow) {
    assert.equal(unknownRow.compositeScore, null, 'unknown family has null compositeScore');
    assert.equal(unknownRow.rank, null, 'unknown family has null rank');
    // Unknown row should be after all ranked rows.
    const unknownIndex = leaderboard.rows.indexOf(unknownRow);
    for (let i = 0; i < unknownIndex; i++) {
      assert.ok(leaderboard.rows[i]!.rank !== null, `row ${i} before unknown is ranked`);
    }
  }
});

test('score interval contains composite score and rank range is valid', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const leaderboard = createModelLeaderboard(prepared);
  const ranked = leaderboard.rows.filter((row) => row.rank !== null);
  for (const row of ranked) {
    const interval = row.scoreInterval80!;
    assert.ok(interval.lower <= row.compositeScore! && row.compositeScore! <= interval.upper,
      `composite ${row.compositeScore} within [${interval.lower}, ${interval.upper}]`);
    assert.ok(interval.bestRank >= 1 && interval.bestRank <= row.rank!, `bestRank ${interval.bestRank} <= rank ${row.rank}`);
    assert.ok(interval.worstRank >= row.rank! && interval.worstRank <= ranked.length, `worstRank ${interval.worstRank} >= rank ${row.rank}`);
  }
});
