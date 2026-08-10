import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedAnalyticsData, PreparedRunRow, PreparedSessionReviewV2Row, ReviewerRuntimeReference } from '../scripts/contracts.ts';
import { createModelLeaderboard, createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('V2 model leaderboard is review-only and leaves runtime-only families unranked', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const leaderboard = createModelLeaderboard(prepared);
  assert.equal(leaderboard.schemaVersion, 7);
  assert.deepEqual(leaderboard.sourceWeights, { review: 1, process: 0 });
  assert.deepEqual(leaderboard.shrinkage, { review: 8, process: 20 });
  assert.ok(leaderboard.rows.some((row) => row.modelId !== '(unknown)'));
  assert.ok(leaderboard.rows.every((row) => row.rank === null && row.compositeScore === null));
  assert.match(leaderboard.notes.join(' '), /review-only/i);
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
    sessionId: overrides.sessionId ?? `session-${overrides.runId}`,
    identityFallback: overrides.identityFallback ?? false,
    sessionPathHash: overrides.sessionPathHash ?? `hash-${overrides.runId}`,
    status: overrides.status ?? 'closed',
    startedAt: overrides.startedAt ?? '2026-05-10T12:00:00.000Z',
    startedDay: overrides.startedDay ?? '2026-05-10',
    updatedAt: overrides.updatedAt ?? '2026-05-10T12:00:00.000Z',
    finalizedAt: overrides.finalizedAt ?? '2026-05-10T12:00:00.000Z',
    finalizationReason: overrides.finalizationReason ?? 'closed',
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
    criticalPathDurationMs: overrides.criticalPathDurationMs ?? null,
    timedToolCallCount: overrides.timedToolCallCount ?? 0,
    toolFailureCount: overrides.toolFailureCount ?? 0,
    resultIssueCount: overrides.resultIssueCount ?? 0,
    subagentCallCount: overrides.subagentCallCount ?? 0,
    subagentTaskCount: overrides.subagentTaskCount ?? 0,
    subagentAgentCount: overrides.subagentAgentCount ?? 0,
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
    skillPruningPrepassDurationMs: overrides.skillPruningPrepassDurationMs ?? null,
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
    editRevisitRate: overrides.editRevisitRate ?? null,
    filesReviewedCount: overrides.filesReviewedCount ?? 0,
    readRevisitRate: overrides.readRevisitRate ?? null,
    estimatedCostUsd: overrides.estimatedCostUsd ?? null,
  };
}

function makeReview(run: PreparedRunRow, reviewId: string, qualityIndexV1: number, reviewers: ReviewerRuntimeReference[], overrides: Partial<PreparedSessionReviewV2Row> = {}): PreparedSessionReviewV2Row {
  return {
    cohort: 'v2_production', schemaVersion: 2, reviewId, sessionId: run.sessionId,
    identityFallback: false, rubricVersion: 'session-review-v2.1', indexVersion: 'v1',
    reviewedAt: '2026-07-24T10:00:00.000Z', startedDay: '2026-07-24', joinKey: 'session_id',
    unmatchedReason: null,
    runIds: [run.runId], modelFamilies: [run.modelFamily!], criteria: [],
    attainment: {
      deliveredOverall: 'achieved', controllableOverall: 'achieved',
      core: { total: 1, assessable: 1, controllableDenominator: 1, met: 1, partlyMet: 0, unmet: 0, blocked: 0, externalBlocked: 0, notAssessable: 0, superseded: 0, deliveredRate: 1, controllableRate: 1 },
      supporting: { total: 0, assessable: 0, controllableDenominator: 0, met: 0, partlyMet: 0, unmet: 0, blocked: 0, externalBlocked: 0, notAssessable: 0, superseded: 0, deliveredRate: 0, controllableRate: 0 },
      optional: { total: 0, assessable: 0, controllableDenominator: 0, met: 0, partlyMet: 0, unmet: 0, blocked: 0, externalBlocked: 0, notAssessable: 0, superseded: 0, deliveredRate: 0, controllableRate: 0 },
      qualityIndexV1,
    },
    criterionCoverage: 1, externalBlockerRate: 0,
    process: { requirementDiscipline: 'strong', verificationDiscipline: 'strong', scopeControl: 'strong', recovery: 'not_needed', finalClaimAccuracy: 'accurate' },
    evidence: { requirements: 'strong', artifacts: 'strong', execution: 'strong', human: 'not_needed', limitations: [] },
    humanCheckStatus: null, confidence: 'high',
    disagreement: { material: false, adjudicated: false, disputedFields: [] },
    reviewers, diversityAchieved: reviewers.some((reviewer) => reviewer.requestedBucket === 'medium'), blindingApplied: true,
    ...overrides,
  };
}

function reviewer(reviewerId: string, requestedBucket: 'small' | 'medium'): ReviewerRuntimeReference {
  return {
    role: 'proposal', reviewerId, requestedBucket, bucket: requestedBucket,
    bucketDowngraded: false, modelId: `reviewer-${reviewerId}`, provider: 'test',
    family: `reviewer-${reviewerId}`, thinkingLevel: null,
  };
}

async function preparedForLeaderboard(runs: PreparedRunRow[], reviews: PreparedSessionReviewV2Row[]): Promise<PreparedAnalyticsData> {
  const prepared = prepareSourceAnalytics(await loadFixture());
  return { ...prepared, runs, sessionReviewsV2: reviews, historicalSessions: [] };
}

test('accepted mixed-bucket and small-only V2 reviews both produce provisional ranks', async () => {
  const smallOnlyRun = makeRun({ runId: 'small-only', modelId: 'reviewed-model', sessionId: 'small-only-session' });
  const mixedRun = makeRun({ runId: 'mixed-reviewers', modelId: 'reviewed-model', sessionId: 'mixed-reviewers-session' });
  const smallOnly = [reviewer('small-a', 'small'), reviewer('small-b', 'small')];
  const mixed = [reviewer('small-c', 'small'), reviewer('medium-a', 'medium')];
  const prepared = await preparedForLeaderboard(
    [smallOnlyRun, mixedRun],
    [makeReview(smallOnlyRun, 'small-only-review', 80, smallOnly), makeReview(mixedRun, 'mixed-review', 100, mixed)],
  );

  const row = createModelLeaderboard(prepared).rows[0]!;
  assert.equal(row.v2ReviewCount, 2);
  assert.equal(row.reviewEvidenceMass, 2);
  assert.equal(row.evidenceTier, 'thin-review');
  assert.equal(row.rank, 1);
  assert.ok(row.compositeScore !== null);
  assert.ok(row.scoreInterval80!.lower <= row.compositeScore! && row.compositeScore! <= row.scoreInterval80!.upper);
});

test('three accepted V2 reviews are review-backed and excluded reviews cannot rank', async () => {
  const runs = Array.from({ length: 3 }, (_, index) => makeRun({ runId: `reviewed-${index}`, modelId: 'reviewed-model', sessionId: `reviewed-session-${index}` }));
  const reviews = runs.map((run, index) => makeReview(run, `review-${index}`, 75 + index * 10, [reviewer(`small-${index}`, 'small')]));
  const ranked = createModelLeaderboard(await preparedForLeaderboard(runs, reviews)).rows[0]!;
  assert.equal(ranked.evidenceTier, 'review-backed');
  assert.equal(ranked.rank, 1);
  assert.deepEqual([ranked.scoreInterval80!.bestRank, ranked.scoreInterval80!.worstRank], [1, 1]);

  const excluded = [
    makeReview(runs[0]!, 'identity-fallback', 100, [reviewer('excluded-a', 'small')], { identityFallback: true }),
    makeReview(runs[1]!, 'unblinded', 100, [reviewer('excluded-b', 'small')], { blindingApplied: false }),
  ];
  const unranked = createModelLeaderboard(await preparedForLeaderboard(runs.slice(0, 2), excluded)).rows[0]!;
  assert.equal(unranked.evidenceTier, 'telemetry-only');
  assert.equal(unranked.compositeScore, null);
  assert.equal(unranked.rank, null);
});

test('unmatched stable-ID V2 reviews use transcript attribution as ranking evidence', async () => {
  const run = makeRun({ runId: 'joined', modelId: 'reviewed-model', sessionId: 'joined-session' });
  const orphanRun = makeRun({ runId: 'orphan', modelId: 'reviewed-model', sessionId: 'orphan-session' });
  const orphanReview = makeReview(orphanRun, 'orphan-review', 100, [reviewer('small-orphan', 'small')], {
    joinKey: 'unmatched', unmatchedReason: 'no_run_for_identity', runIds: [], modelFamilies: [],
  });
  const prepared = await preparedForLeaderboard([], [orphanReview]);
  prepared.historicalSessions = [{
    sessionId: orphanRun.sessionId,
    sessionPathHash: 'orphan-session-path-hash',
    startedAt: '2026-05-10T12:00:00.000Z', endedAt: '2026-05-10T12:05:00.000Z',
    firstUserMessageChars: 100,
    attributions: [{
      modelId: orphanRun.modelId!, modelFamily: orphanRun.modelFamily!, thinkingLevel: 'high',
      share: 1, successfulAssistantTurns: 1, attributedTokens: 100,
    }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['configured'], matchedCanonical: false, transcriptOnly: true,
  }];

  const row = createModelLeaderboard(prepared).rows.find((candidate) => candidate.modelId === 'reviewed-model')!;
  assert.equal(row.reviewEvidenceMass, 1);
  assert.equal(row.v2ReviewCount, 1);
  assert.equal(row.canonicalTaskCount, 0, 'transcript attribution does not manufacture a canonical run task');
  assert.equal(row.attributableTaskCount, 1);
  assert.equal(row.scoringCoverage, 1);
  assert.equal(row.transcriptOnlySessionCount, 1, 'review and process evidence dedupe the same transcript session');
  assert.equal(row.providers[0]!.transcriptOnlySessionCount, 1);
  assert.equal(row.rank, 1);
});

test('successful transcript work supplements missing joined-run families', async () => {
  const run = makeRun({ runId: 'partial-run', modelId: 'gpt-5.6-sol', sessionId: 'mixed-session' });
  const review = makeReview(run, 'mixed-review', 100, [reviewer('small-mixed', 'small')]);
  const prepared = await preparedForLeaderboard([run], [review]);
  prepared.historicalSessions = [{
    sessionId: run.sessionId, sessionPathHash: run.sessionPathHash,
    startedAt: run.startedAt, endedAt: run.finalizedAt, firstUserMessageChars: 100,
    attributions: [
      { modelId: 'gpt-5.6-sol', modelFamily: 'gpt-5.6-sol', thinkingLevel: 'high', share: 0.25, successfulAssistantTurns: 1, attributedTokens: 25 },
      { modelId: 'claude-opus-5', modelFamily: 'claude-opus-5', thinkingLevel: 'high', share: 0.75, successfulAssistantTurns: 1, attributedTokens: 75 },
    ],
    successfulAssistantTurns: 2, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: true, sourceProvenance: ['configured'], matchedCanonical: true, transcriptOnly: false,
  }];

  const rows = createModelLeaderboard(prepared).rows;
  const sol = rows.find((row) => row.modelId === 'gpt-5.6-sol')!;
  const opus = rows.find((row) => row.modelId === 'claude-opus-5')!;
  assert.equal(sol.reviewEvidenceMass, 0.25);
  assert.equal(sol.transcriptOnlySessionCount, 0);
  assert.equal(sol.providers[0]!.transcriptEvidenceMass, 0);
  assert.equal(opus.reviewEvidenceMass, 0.75);
  assert.equal(opus.canonicalTaskCount, 0);
  assert.equal(opus.transcriptOnlySessionCount, 1);
});

test('reviews of superseded canonical retries do not double-count one task', async () => {
  const older = makeRun({
    runId: 'retry-old', modelId: 'reviewed-model', sessionId: 'retry-old-session',
    taskGroupId: 'shared-task', startedAt: '2026-05-10T12:00:00.000Z',
  });
  const latest = makeRun({
    runId: 'retry-new', modelId: 'reviewed-model', sessionId: 'retry-new-session',
    taskGroupId: 'shared-task', startedAt: '2026-05-10T12:10:00.000Z',
  });
  const reviews = [
    makeReview(older, 'retry-old-review', 20, [reviewer('small-old', 'small')]),
    makeReview(latest, 'retry-new-review', 100, [reviewer('small-new', 'small')]),
  ];

  const row = createModelLeaderboard(await preparedForLeaderboard([older, latest], reviews)).rows[0]!;
  assert.equal(row.canonicalTaskCount, 1);
  assert.equal(row.reviewEvidenceMass, 1);
  assert.equal(row.scoringCoverage, 1);
  assert.equal(row.meanQualityIndexV1, 100);
});

test('dimension native bounds: all dimension values stay within their native ranges', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 5; i++) {
    runs.push(makeRun({
      runId: `strong-${i}`, modelId: 'strong-model',
      editRevisitRate: 0.8, tokenEfficiency: 40,
      toolCallCount: 10, toolFailureCount: 2,
      verificationTotalCount: 3, verificationState: 'passing',
    }));
  }
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows[0]!;
  const dims = row.dimensions;
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

test('runtime process differences do not create a V2 rank', () => {
  const reliable = makeRun({ runId: 'reliable', modelId: 'reliable-model', toolCallCount: 10, toolFailureCount: 0, verificationTotalCount: 2, verificationState: 'passing' });
  const unreliable = makeRun({ runId: 'unreliable', modelId: 'unreliable-model', toolCallCount: 10, toolFailureCount: 10, verificationTotalCount: 2, verificationState: 'failing' });
  const leaderboard = createModelLeaderboardFromRuns([reliable, unreliable]);
  assert.ok(leaderboard.rows.every((row) => row.rank === null && row.compositeScore === null));
});

test('open runs excluded from leaderboard run counts', () => {
  const runs: PreparedRunRow[] = [
    makeRun({ runId: 'completed-1', modelId: 'excl-model', status: 'closed' }),
    makeRun({ runId: 'open-1', modelId: 'excl-model', status: 'open' }),
  ];
  const leaderboard = createModelLeaderboardFromRuns(runs);
  const row = leaderboard.rows.find((row) => row.modelId === 'excl-model')!;
  assert.equal(row.runCount, 1, 'open run is excluded from runCount');
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

test('provider canonical run counts sum to row totals', async () => {
  const fixture = deepClone(await loadFixture());
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  for (const row of leaderboard.rows) {
    const runSum = row.providers.reduce((sum, provider) => sum + provider.runCount, 0);
    assert.equal(runSum, row.runCount, `provider runCount sum matches row.runCount for ${row.modelId}`);
    // Transcript fields are always present and non-negative.
    for (const provider of row.providers) {
      assert.ok(typeof provider.transcriptOnlySessionCount === 'number' && provider.transcriptOnlySessionCount >= 0);
      assert.ok(typeof provider.transcriptEvidenceMass === 'number' && Number.isFinite(provider.transcriptEvidenceMass) && provider.transcriptEvidenceMass >= 0);
    }
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
