import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolFailureKind, ToolResultIssueKind } from '../scripts/contracts.js';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { LEADERBOARD_MINIMUM_SCORED_RUNS } from '../scripts/leaderboard-scoring.ts';
import { buildSiteDataBundle, validateSiteDataBundle, writeSiteData, readSiteDataBundle } from '../scripts/site-data.ts';
import { loadFixture, withTempDir } from './helpers.ts';
import type {
  SourceAnalyticsPayload,
  RunSnapshot,
} from '../scripts/contracts.ts';

// ============================================================================
// Helper Factory Functions
// ============================================================================

function createMinimalRunSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const baseTimestamp = '2026-05-01T12:00:00.000Z';
  return {
    sessionPath: 'C:\\test\\session.jsonl',
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    taskGroupId: 'task-default',
    status: 'scored',
    scored: true,
    startedAt: baseTimestamp,
    updatedAt: baseTimestamp,
    finalizedAt: baseTimestamp,
    finalizationReason: 'scored',
    outcome: { resolution: 'resolved', satisfaction: 3 },
    modelId: 'test-model',
    thinkingLevel: 'medium',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 5000,
    busyDurationMs: 6000,
    busyPeriodCount: 1,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: 10000,
    contextLimit: 100000,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 1,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: {
      totalCount: 0,
      failureCount: 0,
      executionFailureCount: 0,
      verificationProjectFailureCount: 0,
      probeFailureCount: 0,
      totalDurationMs: 0,
      timedCallCount: 0,
      durationMsByName: {},
      countsByName: {},
      failureCountsByName: {},
      failureCountsByKind: {} as Record<ToolFailureKind, number>,
      failureCountsByNameAndKind: {},
      failureSamples: [],
      resultIssueCount: 0,
      resultIssueCountsByName: {},
      resultIssueCountsByKind: {} as Record<ToolResultIssueKind, number>,
      resultIssueCountsByNameAndKind: {},
      resultIssueSamples: [],
      subagentCallCount: 0,
      subagentTaskCount: 0,
      subagentAgentNames: [],
      subagentScoredTaskCount: 0,
      subagentTaskScores: {
        precision: { sum: 0, count: 0, max: 0 },
        creativity: { sum: 0, count: 0, max: 0 },
        reasoning: { sum: 0, count: 0, max: 0 },
        thoroughness: { sum: 0, count: 0, max: 0 },
      },
      subagentInputTokens: 0,
      subagentOutputTokens: 0,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    fileMutation: {
      writeCount: 0,
      editCount: 0,
      deleteCount: 0,
      renameCount: 0,
      touchedFileCount: 0,
      lineAdditions: 0,
      lineDeletions: 0,
      lineModifications: 0,
      editCountsByFile: {},
      readCountsByFile: {},
    },
    fileExtensions: {
      readCountsByExtension: {},
      writeCountsByExtension: {},
      editCountsByExtension: {},
    },
    verification: {
      totalCount: 0,
      failureCount: 0,
      countsByKind: {
        test: 0,
        build: 0,
        lint: 0,
        typecheck: 0,
        format: 0,
        other: 0,
      },
    },
    ...overrides,
    lastTurnUsage: overrides.lastTurnUsage ?? null,
  };
}

function createMinimalPayload(runs: RunSnapshot[], outcomes: RunSnapshot[] = []): SourceAnalyticsPayload {
  return {
    schemaVersion: 1,
    exportedAt: '2026-05-13T00:00:00.000Z',
    workspaceKey: 'test-workspace',
    completedRuns: runs,
    openRuns: [],
    pruningDecisions: [],
    pruningEvents: [],
    toolResultPruningEvents: [],
    agentReviews: [],
    outcomes: outcomes.map((run) => ({
      schemaVersion: 1,
      kind: 'run_outcome',
      recordedAt: run.finalizedAt ?? run.updatedAt,
      sessionPath: run.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome!,
    })),
  };
}

// ============================================================================
// Test Suite 1: Cross-referential Consistency
// ============================================================================

test('cross-ref: manifest.completedRunCount equals overview.totalCompletedRuns', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  assert.equal(
    bundle.manifest.completedRunCount,
    bundle.overview.totalCompletedRuns,
    'manifest completedRunCount must match overview totalCompletedRuns',
  );
});

test('cross-ref: manifest.scoredRunCount equals overview.totalScoredRuns', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  assert.equal(
    bundle.manifest.scoredRunCount,
    bundle.overview.totalScoredRuns,
    'manifest scoredRunCount must match overview totalScoredRuns',
  );
});

test('cross-ref: overview.totalScoredRuns equals count of scored runSummary rows', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const scoredRunsInSummary = bundle.runSummary.rows.filter(
    (run) => run.satisfaction !== null && run.status !== 'open',
  ).length;

  assert.equal(
    bundle.overview.totalScoredRuns,
    scoredRunsInSummary,
    'overview totalScoredRuns must equal count of scored runs in runSummary',
  );
});

test('cross-ref: sum of toolUsage.summaryRows callCount equals sum of toolUsage.rows callCount', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const summaryTotal = bundle.toolUsage.summaryRows.reduce((sum, row) => sum + row.callCount, 0);
  const detailTotal = bundle.toolUsage.rows.reduce((sum, row) => sum + row.callCount, 0);

  assert.equal(
    summaryTotal,
    detailTotal,
    'toolUsage summary callCount must equal sum of detail callCounts',
  );
});

test('cross-ref: every toolUsage.rows runId exists in runSummary.rows', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const runIds = new Set(bundle.runSummary.rows.map((row) => row.runId));
  const toolUsageRunIds = new Set(bundle.toolUsage.rows.map((row) => row.runId));

  for (const runId of toolUsageRunIds) {
    assert.ok(
      runIds.has(runId),
      `toolUsage runId ${runId} must exist in runSummary`,
    );
  }
});

test('cross-ref: timeline total runCount equals manifest.completedRunCount', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const timelineTotal = bundle.timeline.rows.reduce((sum, row) => sum + row.runCount, 0);

  assert.equal(
    timelineTotal,
    bundle.manifest.completedRunCount,
    'timeline total runCount must equal manifest completedRunCount',
  );
});

test('cross-ref: modelQuality.rows total runCount equals manifest.completedRunCount', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const modelQualityTotal = bundle.modelQuality.rows.reduce((sum, row) => sum + row.runCount, 0);

  assert.equal(
    modelQualityTotal,
    bundle.manifest.completedRunCount,
    'modelQuality total runCount must equal manifest completedRunCount',
  );
});

test('cross-ref: modelLeaderboard.rows total runCount equals manifest.completedRunCount', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const leaderboardTotal = bundle.modelLeaderboard.rows.reduce((sum, row) => sum + row.runCount, 0);

  assert.equal(
    leaderboardTotal,
    bundle.manifest.completedRunCount,
    'modelLeaderboard total runCount must equal manifest completedRunCount',
  );
});

test('cross-ref: every modelId in modelQuality appears in modelLeaderboard', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const qualityKeys = new Set(bundle.modelQuality.rows.map((row) => row.modelId));
  const leaderboardKeys = new Set(bundle.modelLeaderboard.rows.map((row) => row.modelId));

  for (const key of qualityKeys) {
    assert.ok(
      leaderboardKeys.has(key),
      `modelQuality key ${key} must exist in modelLeaderboard`,
    );
  }
});

// ============================================================================
// Test Suite 2: Numerical Invariants
// ============================================================================

test('numerical: satisfaction scores are always in [1, 5] or null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.satisfaction !== null) {
      assert.ok(
        run.satisfaction >= 1 && run.satisfaction <= 5,
        `satisfaction ${run.satisfaction} for run ${run.runId} must be in [1, 5]`,
      );
    }
  }
});

test('numerical: token counts are all non-negative', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    assert.ok(run.inputTokens >= 0, `inputTokens must be >= 0 for run ${run.runId}`);
    assert.ok(run.outputTokens >= 0, `outputTokens must be >= 0 for run ${run.runId}`);
    assert.ok(run.cacheReadTokens >= 0, `cacheReadTokens must be >= 0 for run ${run.runId}`);
    assert.ok(run.cacheWriteTokens >= 0, `cacheWriteTokens must be >= 0 for run ${run.runId}`);
  }
});

test('numerical: tokenEfficiency recalculation matches when lineMutationTotal > 0', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.lineMutationTotal > 0 && run.tokenEfficiency !== null) {
      const expected = run.outputTokens / run.lineMutationTotal;
      const delta = Math.abs(run.tokenEfficiency - expected);
      assert.ok(
        delta < 0.01,
        `tokenEfficiency ${run.tokenEfficiency} should match calculated ${expected} for run ${run.runId}`,
      );
    }
  }
});

test('numerical: contextUtilization is in [0, 1] when not null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.contextUtilization !== null) {
      assert.ok(
        run.contextUtilization >= 0 && run.contextUtilization <= 1,
        `contextUtilization ${run.contextUtilization} must be in [0, 1] for run ${run.runId}`,
      );
    }
  }
});

test('numerical: cacheHitRatio is in [0, 1] when not null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.cacheHitRatio !== null) {
      assert.ok(
        run.cacheHitRatio >= 0 && run.cacheHitRatio <= 1,
        `cacheHitRatio ${run.cacheHitRatio} must be in [0, 1] for run ${run.runId}`,
      );
    }
  }
});

test('numerical: busyDurationMs is non-negative for all runs', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    assert.ok(
      run.busyDurationMs >= 0,
      `busyDurationMs ${run.busyDurationMs} must be >= 0 for run ${run.runId}`,
    );
  }
});

test('numerical: toolCallCount >= toolFailureCount for all runs', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    assert.ok(
      run.toolCallCount >= run.toolFailureCount,
      `toolCallCount ${run.toolCallCount} must be >= toolFailureCount ${run.toolFailureCount} for run ${run.runId}`,
    );
  }
});

test('numerical: verificationTotalCount >= verificationFailureCount for all runs', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    assert.ok(
      run.verificationTotalCount >= run.verificationFailureCount,
      `verificationTotalCount ${run.verificationTotalCount} must be >= verificationFailureCount ${run.verificationFailureCount} for run ${run.runId}`,
    );
  }
});

test('numerical: lineMutationTotal equals sum of additions + deletions + modifications', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    const expected = run.lineAdditions + run.lineDeletions + run.lineModifications;
    assert.equal(
      run.lineMutationTotal,
      expected,
      `lineMutationTotal must equal sum of line changes for run ${run.runId}`,
    );
  }
});

test('numerical: overview rates are in [0, 1] or null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const rates = [
    { name: 'verificationRunRate', value: bundle.overview.verificationRunRate },
    { name: 'toolFailureRate', value: bundle.overview.toolFailureRate },
    { name: 'resultIssueRate', value: bundle.overview.resultIssueRate },
    { name: 'firstAttemptSuccessRate', value: bundle.overview.firstAttemptSuccessRate },
  ];

  for (const { name, value } of rates) {
    if (value !== null) {
      assert.ok(
        value >= 0 && value <= 1,
        `overview.${name} (${value}) must be in [0, 1]`,
      );
    }
  }
});

test('numerical: leaderboard compositeScore is in [0, 1] or null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const row of bundle.modelLeaderboard.rows) {
    if (row.compositeScore !== null) {
      assert.ok(
        row.compositeScore >= 0 && row.compositeScore <= 1,
        `compositeScore ${row.compositeScore} must be in [0, 1] for model ${row.modelId}`,
      );
    }
  }
});

test('numerical: leaderboard reliabilityFactor is in [0, 1] or null', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const row of bundle.modelLeaderboard.rows) {
    if (row.reliabilityFactor !== null) {
      assert.ok(
        row.reliabilityFactor >= 0 && row.reliabilityFactor <= 1,
        `reliabilityFactor ${row.reliabilityFactor} must be in [0, 1] for model ${row.modelId}`,
      );
    }
  }
});

test('numerical: leaderboard ranks are ascending when present', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const rankedRows = bundle.modelLeaderboard.rows.filter((row) => row.rank !== null);
  for (let i = 1; i < rankedRows.length; i++) {
    assert.ok(
      rankedRows[i]!.rank! >= rankedRows[i - 1]!.rank!,
      `leaderboard rank must be ascending: ${rankedRows[i - 1]!.rank} -> ${rankedRows[i]!.rank}`,
    );
  }
});

// ============================================================================
// Test Suite 3: Temporal Ordering Invariants
// ============================================================================

test('temporal: timeline rows are sorted by bucketStart ascending', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (let i = 1; i < bundle.timeline.rows.length; i++) {
    const prev = bundle.timeline.rows[i - 1]!.bucketStart;
    const curr = bundle.timeline.rows[i]!.bucketStart;
    assert.ok(
      prev <= curr,
      `timeline bucketStart must be ascending: ${prev} -> ${curr}`,
    );
  }
});

test('temporal: run startedAt <= updatedAt', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    assert.ok(
      run.startedAt <= run.updatedAt,
      `startedAt ${run.startedAt} must be <= updatedAt ${run.updatedAt} for run ${run.runId}`,
    );
  }
});

test('temporal: run startedAt <= finalizedAt when finalizedAt exists', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.finalizedAt !== null) {
      assert.ok(
        run.startedAt <= run.finalizedAt,
        `startedAt ${run.startedAt} must be <= finalizedAt ${run.finalizedAt} for run ${run.runId}`,
      );
    }
  }
});

// ============================================================================
// Test Suite 4: Classification Completeness
// ============================================================================

test('classification: every completed run has valid verificationState', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  const validStates = new Set(['none', 'passing', 'failing']);
  const completedRuns = bundle.runSummary.rows.filter((run) => run.status !== 'open');

  for (const run of completedRuns) {
    assert.ok(
      validStates.has(run.verificationState),
      `verificationState ${run.verificationState} must be one of ${[...validStates].join(', ')} for run ${run.runId}`,
    );
  }
});

test('classification: verificationState none iff verificationTotalCount === 0', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.verificationState === 'none') {
      assert.equal(
        run.verificationTotalCount,
        0,
        `verificationState none requires verificationTotalCount === 0 for run ${run.runId}`,
      );
    }
    if (run.verificationTotalCount === 0) {
      assert.equal(
        run.verificationState,
        'none',
        `verificationTotalCount === 0 requires verificationState none for run ${run.runId}`,
      );
    }
  }
});

test('classification: verificationState failing iff has failures and total > 0', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.verificationState === 'failing') {
      assert.ok(
        run.verificationFailureCount > 0 && run.verificationTotalCount > 0,
        `verificationState failing requires failures > 0 and total > 0 for run ${run.runId}`,
      );
    }
    if (run.verificationFailureCount > 0 && run.verificationTotalCount > 0) {
      assert.equal(
        run.verificationState,
        'failing',
        `failures > 0 and total > 0 requires verificationState failing for run ${run.runId}`,
      );
    }
  }
});

test('classification: verificationState passing iff no failures and total > 0', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    if (run.verificationState === 'passing') {
      assert.ok(
        run.verificationFailureCount === 0 && run.verificationTotalCount > 0,
        `verificationState passing requires failures === 0 and total > 0 for run ${run.runId}`,
      );
    }
    if (run.verificationFailureCount === 0 && run.verificationTotalCount > 0) {
      assert.equal(
        run.verificationState,
        'passing',
        `failures === 0 and total > 0 requires verificationState passing for run ${run.runId}`,
      );
    }
  }
});

test('classification: verificationCountBucket matches verificationTotalCount', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  for (const run of bundle.runSummary.rows) {
    const count = run.verificationTotalCount;
    let expectedBucket: string;
    if (count === 0) {
      expectedBucket = '0';
    } else if (count === 1) {
      expectedBucket = '1';
    } else if (count <= 3) {
      expectedBucket = '2-3';
    } else {
      expectedBucket = '4+';
    }
    assert.equal(
      run.verificationCountBucket,
      expectedBucket,
      `verificationCountBucket ${run.verificationCountBucket} should be ${expectedBucket} for count ${count} in run ${run.runId}`,
    );
  }
});

// ============================================================================
// Test Suite 5: Round-trip Fidelity
// ============================================================================

test('round-trip: write and read preserves key numerical values exactly', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    const prepared = prepareSourceAnalytics(fixture);
    const bundle = buildSiteDataBundle(prepared);

    await writeSiteData(dir, bundle);
    const roundTrip = await readSiteDataBundle(dir);

    // Verify manifest counts
    assert.equal(roundTrip.manifest.completedRunCount, bundle.manifest.completedRunCount);
    assert.equal(roundTrip.manifest.scoredRunCount, bundle.manifest.scoredRunCount);

    // Verify overview statistics
    assert.equal(roundTrip.overview.totalCompletedRuns, bundle.overview.totalCompletedRuns);
    assert.equal(roundTrip.overview.totalScoredRuns, bundle.overview.totalScoredRuns);
    assert.equal(roundTrip.overview.averageSatisfaction, bundle.overview.averageSatisfaction);

    // Verify run summary row counts
    assert.equal(roundTrip.runSummary.rows.length, bundle.runSummary.rows.length);

    // Verify first run's key fields
    if (bundle.runSummary.rows.length > 0) {
      const originalRun = bundle.runSummary.rows[0]!;
      const roundTripRun = roundTrip.runSummary.rows[0]!;
      assert.equal(roundTripRun.runId, originalRun.runId);
      assert.equal(roundTripRun.satisfaction, originalRun.satisfaction);
      assert.equal(roundTripRun.busyDurationMs, originalRun.busyDurationMs);
      assert.equal(roundTripRun.tokenEfficiency, originalRun.tokenEfficiency);
    }

    // Verify tool usage aggregates
    assert.equal(roundTrip.toolUsage.summaryRows.length, bundle.toolUsage.summaryRows.length);
    if (bundle.toolUsage.summaryRows.length > 0) {
      const originalTool = bundle.toolUsage.summaryRows[0]!;
      const roundTripTool = roundTrip.toolUsage.summaryRows[0]!;
      assert.equal(roundTripTool.toolName, originalTool.toolName);
      assert.equal(roundTripTool.callCount, originalTool.callCount);
    }
  });
});

// ============================================================================
// Test Suite 6: Realistic Synthetic Data End-to-End
// ============================================================================

test('synthetic: multi-model payload with known values produces expected calculations', async () => {
  // Create 3 runs with model A (satisfaction 5, 4, 3) and 3 runs with model B (satisfaction 2, 3, 4)
  const modelARuns = [
    createMinimalRunSnapshot({ 
      modelId: 'model-a', 
      outcome: { resolution: 'resolved', satisfaction: 5 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 10,
        failureCount: 0,
        countsByName: { bash: 10 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 2,
        failureCount: 0,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 10,
        lineDeletions: 5,
        lineModifications: 3,
      },
      outputTokens: 1800,
    }),
    createMinimalRunSnapshot({ 
      modelId: 'model-a', 
      outcome: { resolution: 'resolved', satisfaction: 4 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 8,
        failureCount: 1,
        countsByName: { bash: 8 },
        failureCountsByName: { bash: 1 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 1,
        failureCount: 0,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 8,
        lineDeletions: 4,
        lineModifications: 2,
      },
      outputTokens: 1400,
    }),
    createMinimalRunSnapshot({ 
      modelId: 'model-a', 
      outcome: { resolution: 'partially_resolved', satisfaction: 3 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 6,
        failureCount: 0,
        countsByName: { bash: 6 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 0,
        failureCount: 0,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 5,
        lineDeletions: 3,
        lineModifications: 1,
      },
      outputTokens: 900,
    }),
  ];

  const modelBRuns = [
    createMinimalRunSnapshot({ 
      modelId: 'model-b', 
      outcome: { resolution: 'unresolved', satisfaction: 2 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 12,
        failureCount: 3,
        countsByName: { bash: 12 },
        failureCountsByName: { bash: 3 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 3,
        failureCount: 2,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 6,
        lineDeletions: 4,
        lineModifications: 2,
      },
      outputTokens: 1200,
    }),
    createMinimalRunSnapshot({ 
      modelId: 'model-b', 
      outcome: { resolution: 'resolved', satisfaction: 3 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 9,
        failureCount: 2,
        countsByName: { bash: 9 },
        failureCountsByName: { bash: 2 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 1,
        failureCount: 0,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 7,
        lineDeletions: 3,
        lineModifications: 2,
      },
      outputTokens: 1200,
    }),
    createMinimalRunSnapshot({ 
      modelId: 'model-b', 
      outcome: { resolution: 'resolved', satisfaction: 4 },
      toolUsage: { 
        ...createMinimalRunSnapshot().toolUsage,
        totalCount: 10,
        failureCount: 1,
        countsByName: { bash: 10 },
        failureCountsByName: { bash: 1 },
      },
      verification: {
        ...createMinimalRunSnapshot().verification,
        totalCount: 2,
        failureCount: 0,
      },
      fileMutation: {
        ...createMinimalRunSnapshot().fileMutation,
        lineAdditions: 9,
        lineDeletions: 5,
        lineModifications: 3,
      },
      outputTokens: 1700,
    }),
  ];

  const payload = createMinimalPayload([...modelARuns, ...modelBRuns], [...modelARuns, ...modelBRuns]);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  // Verify overview calculations
  assert.equal(bundle.overview.totalCompletedRuns, 6);
  assert.equal(bundle.overview.totalScoredRuns, 6);
  
  // Average satisfaction: (5 + 4 + 3 + 2 + 3 + 4) / 6 = 21 / 6 = 3.5
  assert.equal(bundle.overview.averageSatisfaction, 3.5);

  // Verify model quality aggregates
  const modelAQuality = bundle.modelQuality.rows.find((row) => row.modelId === 'model-a');
  const modelBQuality = bundle.modelQuality.rows.find((row) => row.modelId === 'model-b');

  assert.ok(modelAQuality, 'model-a should appear in model quality');
  assert.ok(modelBQuality, 'model-b should appear in model quality');

  assert.equal(modelAQuality!.runCount, 3);
  assert.equal(modelAQuality!.scoredRunCount, 3);
  // Average satisfaction model A: (5 + 4 + 3) / 3 = 4
  assert.equal(modelAQuality!.averageSatisfaction, 4);

  assert.equal(modelBQuality!.runCount, 3);
  assert.equal(modelBQuality!.scoredRunCount, 3);
  // Average satisfaction model B: (2 + 3 + 4) / 3 = 3
  assert.equal(modelBQuality!.averageSatisfaction, 3);

  // Verify tool usage aggregation
  const bashUsage = bundle.toolUsage.summaryRows.find((row) => row.toolName === 'bash');
  assert.ok(bashUsage, 'bash tool should appear in summary');
  // Total: 10 + 8 + 6 + 12 + 9 + 10 = 55
  assert.equal(bashUsage!.callCount, 55);
  // Failures: 0 + 1 + 0 + 3 + 2 + 1 = 7
  assert.equal(bashUsage!.failureCount, 7);
  assert.equal(bashUsage!.affectedRunCount, 6);

  // Both models appear; sparse evidence is ranked without a minimum gate.
  const modelALeaderboard = bundle.modelLeaderboard.rows.find((row) => row.modelId === 'model-a');
  const modelBLeaderboard = bundle.modelLeaderboard.rows.find((row) => row.modelId === 'model-b');

  assert.ok(modelALeaderboard, 'model-a should appear in leaderboard');
  assert.ok(modelBLeaderboard, 'model-b should appear in leaderboard');
  assert.ok(modelALeaderboard!.rank !== null && modelBLeaderboard!.rank !== null, 'sparse families remain ranked');
  assert.ok(modelALeaderboard!.compositeScore !== null && modelBLeaderboard!.compositeScore !== null);
  assert.equal(modelALeaderboard!.evidenceTier, 'thin-outcome');
});

// ============================================================================
// Test Suite 7: Edge Case Grounding
// ============================================================================

test('edge: payload with zero tool calls produces valid empty toolUsage', async () => {
  const run = createMinimalRunSnapshot({
    toolUsage: {
      ...createMinimalRunSnapshot().toolUsage,
      totalCount: 0,
      failureCount: 0,
      countsByName: {},
    },
  });

  const payload = createMinimalPayload([run], [run]);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.toolUsage.rows.length, 0);
  assert.equal(bundle.toolUsage.summaryRows.length, 0);
});

test('edge: payload with only open runs produces valid overview with zeros/nulls', async () => {
  const openRun = createMinimalRunSnapshot({
    status: 'open',
    scored: false,
    outcome: undefined,
    finalizedAt: undefined,
    finalizationReason: undefined,
  });

  const payload: SourceAnalyticsPayload = {
    schemaVersion: 1,
    exportedAt: '2026-05-13T00:00:00.000Z',
    workspaceKey: 'test-workspace',
    completedRuns: [],
    openRuns: [openRun],
    pruningDecisions: [],
    pruningEvents: [],
    toolResultPruningEvents: [],
    agentReviews: [],
    outcomes: [],
  };

  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.overview.totalCompletedRuns, 0);
  assert.equal(bundle.overview.totalScoredRuns, 0);
  assert.equal(bundle.overview.averageSatisfaction, null);
  assert.equal(bundle.manifest.completedRunCount, 0);
  assert.equal(bundle.manifest.openRunCount, 1);
});

test('edge: payload where every run has max satisfaction produces averageSatisfaction === 5', async () => {
  const perfectRuns = [
    createMinimalRunSnapshot({ outcome: { resolution: 'resolved', satisfaction: 5 } }),
    createMinimalRunSnapshot({ outcome: { resolution: 'resolved', satisfaction: 5 } }),
    createMinimalRunSnapshot({ outcome: { resolution: 'resolved', satisfaction: 5 } }),
  ];

  const payload = createMinimalPayload(perfectRuns, perfectRuns);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.overview.averageSatisfaction, 5);
});

test('edge: payload with single scored run produces valid ranked leaderboard', async () => {
  const run = createMinimalRunSnapshot({ 
    outcome: { resolution: 'resolved', satisfaction: 4 },
  });

  const payload = createMinimalPayload([run], [run]);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.modelLeaderboard.rows.length, 1);
  assert.equal(bundle.modelLeaderboard.rows[0]!.rank, 1, 'single sparse family is regularized and ranked');
  assert.equal(bundle.modelLeaderboard.rows[0]!.evidenceTier, 'thin-outcome');
  assert.ok(bundle.modelLeaderboard.rows[0]!.scoreInterval80 !== null);
});

test('edge: payload with two scored runs (sparse evidence) produces ranked leaderboard', async () => {
  const runs = [
    createMinimalRunSnapshot({ 
      modelId: 'test-model',
      outcome: { resolution: 'resolved', satisfaction: 4 },
    }),
    createMinimalRunSnapshot({ 
      modelId: 'test-model',
      outcome: { resolution: 'resolved', satisfaction: 5 },
    }),
  ];

  const payload = createMinimalPayload(runs, runs);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.modelLeaderboard.rows.length, 1);
  assert.equal(bundle.modelLeaderboard.rows[0]!.scoredRunCount, 1, 'canonical retries collapse to the latest task observation');
  assert.equal(bundle.modelLeaderboard.rows[0]!.rank, 1, 'thin evidence is ranked rather than hard-excluded');
});

test('edge: payload with sparse scored runs produces ranked leaderboard', async () => {
  const satisfactionValues = [4, 5, 3];
  const runs = Array.from({ length: LEADERBOARD_MINIMUM_SCORED_RUNS }, (_, index) =>
    createMinimalRunSnapshot({
      modelId: 'test-model',
      taskGroupId: `minimum-task-${index}`,
      outcome: { resolution: 'resolved', satisfaction: satisfactionValues[index % satisfactionValues.length]! },
    }));

  const payload = createMinimalPayload(runs, runs);
  const prepared = prepareSourceAnalytics(payload);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  assert.equal(bundle.modelLeaderboard.rows.length, 1);
  assert.equal(bundle.modelLeaderboard.rows[0]!.scoredRunCount, LEADERBOARD_MINIMUM_SCORED_RUNS);
  assert.notEqual(bundle.modelLeaderboard.rows[0]!.rank, null, 'sparse scored runs are ranked without a minimum gate');
  assert.notEqual(bundle.modelLeaderboard.rows[0]!.compositeScore, null, 'sparse scored runs produce a composite score');
});
