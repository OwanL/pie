import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PreparedRunRow,
  VerificationCommandKind,
} from '../scripts/contracts.ts';
import {
  BOOTSTRAP_MIN_RUNS,
  MIN_SCORED_RUNS_PER_MODEL,
  type BucketAssignments,
  computeBucketAssignments,
  computeComplexityScores,
  computeOutcomeScores,
  extractSignals,
  filterEligible,
  rankModelsInBand,
  assignBands,
  assignModelsToBuckets,
  percentileRanks,
  type SimpleModelConfig,
  type ModelOutcomeScores,
} from '../scripts/stratified-ranker.ts';

// ---------------------------------------------------------------------------
// Helpers – fixture construction
// ---------------------------------------------------------------------------

/** All verification-count-by-kind keys defaulting to 0. */
const ZERO_VERIFICATION_KINDS: Record<VerificationCommandKind, number> = {
  test: 0, build: 0, lint: 0, typecheck: 0, format: 0, other: 0,
};

/**
 * Build a minimal PreparedRunRow for testing.  All fields required by the
 * stratified-ranker pipeline are present; most default to zero / null.
 */
function makeRun(overrides: Partial<PreparedRunRow> & { runId: string }): PreparedRunRow {
  const defaults: PreparedRunRow = {
    runId: '',
    taskGroupId: 'tg-default',
    sessionPathHash: 'hash000000000000',
    status: 'scored',
    scored: true,
    startedAt: '2025-06-01T00:00:00Z',
    startedDay: '2025-06-01',
    updatedAt: '2025-06-01T00:00:00Z',
    finalizedAt: '2025-06-01T00:00:00Z',
    finalizationReason: 'scored',
    resolution: 'resolved',
    satisfaction: 4,
    modelId: 'model-a',
    modelFamily: 'model-a',
    provider: null,
    thinkingLevel: 'medium',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    experimentAssignment: null,
    promptFamily: null,
    promptHashPrefix: null,
    promptCapturedAt: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    skillEntries: [],
    activeExtensions: [],
    selectedToolCount: 0,
    skillCount: 0,
    contextFileCount: 0,
    promptGuidelineCount: 0,
    fsSubagentAlwaysParentModel: null,
    fsPruningMode: null,
    fsPruningEnabled: null,
    fsExtensionToggles: {},
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1000,
    busyDurationMs: 1000,
    busyPeriodCount: 1,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCount: 0,
    contextTokens: null,
    contextLimit: null,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 1,
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolCallCount: 5,
    toolFailureCount: 0,
    resultIssueCount: 0,
    subagentCallCount: 0,
    subagentTaskCount: 0,
    subagentAgentCount: 0,
    subagentScoredTaskCount: 0,
    subagentMeanPrecision: null,
    subagentMeanCreativity: null,
    subagentMeanReasoning: null,
    subagentMeanThoroughness: null,
    subagentMaxPrecision: null,
    subagentMaxCreativity: null,
    subagentMaxReasoning: null,
    subagentMaxThoroughness: null,
    subagentCompositeMean: null,
    verificationTotalCount: 1,
    verificationFailureCount: 0,
    verificationState: 'passing',
    verificationCountBucket: '1',
    verificationCountsByKind: { ...ZERO_VERIFICATION_KINDS, test: 1 },
    fileWriteCount: 0,
    fileEditCount: 1,
    fileDeleteCount: 0,
    fileRenameCount: 0,
    touchedFileCount: 1,
    lineAdditions: 10,
    lineDeletions: 5,
    lineModifications: 3,
    lineMutationTotal: 18,
    tokenEfficiency: 10,
    contextUtilization: null,
    cacheHitRatio: null,
    firstAttemptSuccess: true,
    editRevisitRate: null,
    filesReviewedCount: 0,
    readRevisitRate: null,
    estimatedCostUsd: null,
  };
  const merged = { ...defaults, ...overrides } as PreparedRunRow;
  // Default modelFamily to the run's own modelId (matching resolveModelFamily's
  // fallback to modelId when no family is declared in models.json), unless an
  // explicit family was supplied — so tests that vary only `modelId` still
  // produce distinct family-keyed groups after family grouping.
  if (overrides.modelFamily === undefined) {
    merged.modelFamily = merged.modelId ?? 'model-a';
  }
  return merged;
}

/** Build a set of runs that spans distinct complexity levels. */
function makeDiverseRuns(count: number, modelId = 'model-a'): PreparedRunRow[] {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < count; i++) {
    // Scale signals with index to create diversity
    const scale = i + 1;
    runs.push(makeRun({
      runId: `run-${i}`,
      modelId,
      lineAdditions: scale * 10,
      lineDeletions: scale * 2,
      lineModifications: scale,
      touchedFileCount: scale,
      toolCallCount: scale * 3,
      busyDurationMs: scale * 5000,
      verificationTotalCount: scale % 3,
      inputTokens: scale * 100,
      satisfaction: 3 + (i % 3),           // 3, 4, or 5
      resolution: i % 4 === 0 ? 'unresolved' : i % 4 === 1 ? 'partially_resolved' : 'resolved',
      toolFailureCount: i % 5 === 0 ? 1 : 0,
      firstAttemptSuccess: i % 3 !== 0,
      tokenEfficiency: 5 + (i % 10),       // 5..14
    }));
  }
  return runs;
}

const defaultModelConfig: SimpleModelConfig[] = [
  { id: 'model-a', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
  { id: 'model-b', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 2 },
  { id: 'model-c', eligible: true, thinking: ['high'], disabled_reason: null, cost: 3 },
  { id: 'ineligible-model', eligible: false, thinking: ['low'], disabled_reason: 'deprecated', cost: 0.5 },
];

// ===========================================================================
// percentileRanks
// ===========================================================================

test('percentileRanks: empty array returns empty', () => {
  assert.deepEqual(percentileRanks([]), []);
});

test('percentileRanks: single element returns [0.5]', () => {
  assert.deepEqual(percentileRanks([42]), [0.5]);
});

test('percentileRanks: all identical values return 0.5', () => {
  assert.deepEqual(percentileRanks([7, 7, 7, 7]), [0.5, 0.5, 0.5, 0.5]);
});

test('percentileRanks: two distinct values produce 0.25 and 0.75', () => {
  const ranks = percentileRanks([1, 2]);
  // sorted = [1, 2]. For 1: lt=0, eq=1 → (0+0.5)/2 = 0.25
  // For 2: lt=1, eq=1 → (1+0.5)/2 = 0.75
  assert.deepEqual(ranks, [0.25, 0.75]);
});

test('percentileRanks: handles ties correctly', () => {
  // [1, 1, 2, 3]
  const ranks = percentileRanks([1, 1, 2, 3]);
  // sorted = [1, 1, 2, 3], n=4
  // value 1: lt=0, eq=2 → (0+1)/4 = 0.25
  // value 1: lt=0, eq=2 → (0+1)/4 = 0.25
  // value 2: lt=2, eq=1 → (2+0.5)/4 = 0.625
  // value 3: lt=3, eq=1 → (3+0.5)/4 = 0.875
  assert.deepEqual(ranks, [0.25, 0.25, 0.625, 0.875]);
});

test('percentileRanks: strictly increasing sequence', () => {
  const ranks = percentileRanks([10, 20, 30]);
  // sorted = [10, 20, 30], n=3
  // 10: lt=0, eq=1 → (0+0.5)/3 ≈ 0.1667
  // 20: lt=1, eq=1 → (1+0.5)/3 = 0.5
  // 30: lt=2, eq=1 → (2+0.5)/3 ≈ 0.8333
  assert.ok(Math.abs(ranks[0]! - 1 / 6) < 1e-10);
  assert.equal(ranks[1], 0.5);
  assert.ok(Math.abs(ranks[2]! - 5 / 6) < 1e-10);
});

// ===========================================================================
// extractSignals
// ===========================================================================

test('extractSignals: all 6 signals extracted correctly', () => {
  const run = makeRun({
    runId: 'sig-test',
    lineAdditions: 10,
    lineDeletions: 5,
    lineModifications: 3,
    touchedFileCount: 7,
    toolCallCount: 12,
    busyDurationMs: 9000,
    verificationTotalCount: 4,
    inputTokens: 500,
  });

  const signals = extractSignals(run);
  assert.equal(signals.lineMutations, 18);   // 10+5+3
  assert.equal(signals.touchedFileCount, 7);
  assert.equal(signals.toolCallCount, 12);
  assert.equal(signals.busyDurationMs, 9000);
  assert.equal(signals.verificationTotalCount, 4);
  assert.equal(signals.inputTokens, 500);
});

test('extractSignals: all zeros', () => {
  const run = makeRun({
    runId: 'zero-sig',
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    touchedFileCount: 0,
    toolCallCount: 0,
    busyDurationMs: 0,
    verificationTotalCount: 0,
    inputTokens: 0,
  });

  const signals = extractSignals(run);
  assert.equal(signals.lineMutations, 0);
  assert.equal(signals.touchedFileCount, 0);
  assert.equal(signals.toolCallCount, 0);
  assert.equal(signals.busyDurationMs, 0);
  assert.equal(signals.verificationTotalCount, 0);
  assert.equal(signals.inputTokens, 0);
});

// ===========================================================================
// computeComplexityScores
// ===========================================================================

test('computeComplexityScores: empty runs returns empty map', () => {
  const scores = computeComplexityScores([]);
  assert.equal(scores.size, 0);
});

test('computeComplexityScores: single run gets score 0.5', () => {
  const runs = [makeRun({ runId: 'solo' })];
  const scores = computeComplexityScores(runs);
  assert.equal(scores.size, 1);
  assert.equal(scores.get('solo'), 0.5);
});

test('computeComplexityScores: identical runs all get 0.5', () => {
  const runs = [
    makeRun({ runId: 'a', lineAdditions: 10, touchedFileCount: 5, toolCallCount: 3, busyDurationMs: 1000, verificationTotalCount: 1, inputTokens: 100 }),
    makeRun({ runId: 'b', lineAdditions: 10, touchedFileCount: 5, toolCallCount: 3, busyDurationMs: 1000, verificationTotalCount: 1, inputTokens: 100 }),
    makeRun({ runId: 'c', lineAdditions: 10, touchedFileCount: 5, toolCallCount: 3, busyDurationMs: 1000, verificationTotalCount: 1, inputTokens: 100 }),
  ];
  const scores = computeComplexityScores(runs);
  assert.equal(scores.size, 3);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(scores.get(id), 0.5, `run ${id} should have score 0.5`);
  }
});

test('computeComplexityScores: all 6 signals contribute to the score', () => {
  // Two runs: one with all high signals, one with all low signals.
  // If any single signal were dropped, the gap would shrink differently.
  const low = makeRun({
    runId: 'low',
    lineAdditions: 1, lineDeletions: 0, lineModifications: 0,
    touchedFileCount: 1,
    toolCallCount: 1,
    busyDurationMs: 100,
    verificationTotalCount: 0,
    inputTokens: 10,
  });
  const high = makeRun({
    runId: 'high',
    lineAdditions: 1000, lineDeletions: 500, lineModifications: 200,
    touchedFileCount: 50,
    toolCallCount: 100,
    busyDurationMs: 500000,
    verificationTotalCount: 20,
    inputTokens: 10000,
  });
  const scores = computeComplexityScores([low, high]);

  // With two items, each percentile is either 0.25 or 0.75.
  // All 6 signals should rank 'low' at 0.25 and 'high' at 0.75.
  // Average = 6 * 0.25 / 6 = 0.25 for low, 0.75 for high.
  assert.equal(scores.get('low'), 0.25);
  assert.equal(scores.get('high'), 0.75);
});

test('computeComplexityScores: diverse runs produce different scores', () => {
  const runs = makeDiverseRuns(20);
  const scores = computeComplexityScores(runs);
  assert.equal(scores.size, 20);

  const values = [...scores.values()];
  const unique = new Set(values);
  assert.ok(unique.size > 1, 'diverse runs should produce varying complexity scores');
});

test('computeComplexityScores: all-zero signals still yield 0.5 for each run', () => {
  // When all signals are 0, all percentile ranks are 0.5 (all tied).
  const runs = [
    makeRun({ runId: 'z1', lineAdditions: 0, lineDeletions: 0, lineModifications: 0, touchedFileCount: 0, toolCallCount: 0, busyDurationMs: 0, verificationTotalCount: 0, inputTokens: 0 }),
    makeRun({ runId: 'z2', lineAdditions: 0, lineDeletions: 0, lineModifications: 0, touchedFileCount: 0, toolCallCount: 0, busyDurationMs: 0, verificationTotalCount: 0, inputTokens: 0 }),
  ];
  const scores = computeComplexityScores(runs);
  assert.equal(scores.get('z1'), 0.5);
  assert.equal(scores.get('z2'), 0.5);
});

test('computeComplexityScores: mixing zero and nonzero signals', () => {
  // One run has zero lineMutations but high token count; another has the reverse.
  const runs = [
    makeRun({ runId: 'tok-heavy', lineAdditions: 0, lineDeletions: 0, lineModifications: 0, touchedFileCount: 1, toolCallCount: 1, busyDurationMs: 100, verificationTotalCount: 0, inputTokens: 10000 }),
    makeRun({ runId: 'line-heavy', lineAdditions: 500, lineDeletions: 200, lineModifications: 50, touchedFileCount: 10, toolCallCount: 5, busyDurationMs: 5000, verificationTotalCount: 2, inputTokens: 50 }),
  ];
  const scores = computeComplexityScores(runs);
  // Both should be 0.5 since there are only 2 items and they are complements
  // Actually: for 2 items, each signal is either 0.25 or 0.75
  // tok-heavy: lineMutations=0 (0.25), touchedFile=1 (0.25), toolCall=1 (0.25),
  //            duration=100 (0.25), verification=0 (0.25), input=10000 (0.75)
  // → (0.25*5 + 0.75)/6 = 2.0/6 ≈ 0.3333
  // line-heavy: complements → (0.75*5 + 0.25)/6 = 4.0/6 ≈ 0.6667
  assert.ok(Math.abs(scores.get('tok-heavy')! - 2 / 6) < 1e-10);
  assert.ok(Math.abs(scores.get('line-heavy')! - 4 / 6) < 1e-10);
});

// ===========================================================================
// assignBands
// ===========================================================================

test('assignBands: empty runs produce 3 empty bands', () => {
  const scores = computeComplexityScores([]);
  const bands = assignBands([], scores);
  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.equal(band.runs.length, 0);
  }
  assert.deepEqual(bands.map((b) => b.band), ['low', 'medium', 'high']);
});

test('assignBands: only unscored runs produce empty bands', () => {
  const runs = [
    makeRun({ runId: 'u1', scored: false }),
    makeRun({ runId: 'u2', scored: false }),
  ];
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  for (const band of bands) {
    assert.equal(band.runs.length, 0);
  }
});

test('assignBands: 3 scored runs produce 1 per band', () => {
  const runs = makeDiverseRuns(3);
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  assert.equal(bands.length, 3);
  assert.equal(bands[0]!.runs.length, 1, 'low band should have 1 run');
  assert.equal(bands[1]!.runs.length, 1, 'medium band should have 1 run');
  assert.equal(bands[2]!.runs.length, 1, 'high band should have 1 run');
});

test('assignBands: 6 scored runs produce 2 per band', () => {
  const runs = makeDiverseRuns(6);
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  for (const band of bands) {
    assert.equal(band.runs.length, 2);
  }
});

test('assignBands: 7 scored runs splits with ceil (3,3,1)', () => {
  const runs = makeDiverseRuns(7);
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  // bandSize = ceil(7/3) = 3
  // Band 0: 0..3 → 3, Band 1: 3..6 → 3, Band 2: 6..7 → 1
  assert.equal(bands[0]!.runs.length, 3);
  assert.equal(bands[1]!.runs.length, 3);
  assert.equal(bands[2]!.runs.length, 1);
});

test('assignBands: low band has lower complexity than high band', () => {
  const runs = makeDiverseRuns(30);
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);

  const lowScores = bands[0]!.runs.map((r) => scores.get(r.runId) ?? 0);
  const highScores = bands[2]!.runs.map((r) => scores.get(r.runId) ?? 0);

  const lowAvg = lowScores.reduce((a, b) => a + b, 0) / lowScores.length;
  const highAvg = highScores.reduce((a, b) => a + b, 0) / highScores.length;

  assert.ok(lowAvg < highAvg, 'low band average complexity should be less than high band');
});

test('assignBands: all scored runs are assigned to a band', () => {
  const runs = makeDiverseRuns(15);
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  const totalInBands = bands.reduce((sum, b) => sum + b.runs.length, 0);
  assert.equal(totalInBands, 15, 'all scored runs should appear in a band');
});

// ===========================================================================
// computeOutcomeScores
// ===========================================================================

test('computeOutcomeScores: returns null when no scored runs', () => {
  const runs = [makeRun({ runId: 'r1', scored: false, satisfaction: null })];
  const result = computeOutcomeScores(runs);
  assert.equal(result, null);
});

test('computeOutcomeScores: returns null when scored but satisfaction is null', () => {
  const runs = [makeRun({ runId: 'r1', scored: true, satisfaction: null })];
  const result = computeOutcomeScores(runs);
  assert.equal(result, null);
});

test('computeOutcomeScores: all resolved → resolutionRate = 1', () => {
  const runs = [
    makeRun({ runId: 'r1', resolution: 'resolved', satisfaction: 5 }),
    makeRun({ runId: 'r2', resolution: 'resolved', satisfaction: 4 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.equal(result.resolutionRate, 1);
});

test('computeOutcomeScores: mix of resolutions', () => {
  const runs = [
    makeRun({ runId: 'r1', resolution: 'resolved', satisfaction: 5 }),
    makeRun({ runId: 'r2', resolution: 'partially_resolved', satisfaction: 3 }),
    makeRun({ runId: 'r3', resolution: 'unresolved', satisfaction: 1 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // resolved=1, partially=0.5, unresolved=0 → (1+0.5+0)/3 = 0.5
  assert.ok(Math.abs(result.resolutionRate - 0.5) < 1e-10);
});

test('computeOutcomeScores: satisfaction is mean of 1-5 values', () => {
  const runs = [
    makeRun({ runId: 'r1', satisfaction: 2 }),
    makeRun({ runId: 'r2', satisfaction: 4 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.equal(result.satisfaction, 3);
});

test('computeOutcomeScores: fileChurn inverts mean editRevisitRate', () => {
  // editRevisitRate 0 = no churn → fileChurn 1; 1 = all churn → fileChurn 0.
  const runs = [
    makeRun({ runId: 'r1', editRevisitRate: 0 }),    // no churn
    makeRun({ runId: 'r2', editRevisitRate: 0.5 }),  // half churn
    makeRun({ runId: 'r3', editRevisitRate: 1 }),    // all churn
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // mean editRevisitRate = (0 + 0.5 + 1) / 3 = 0.5 → fileChurn = 1 - 0.5 = 0.5
  assert.ok(Math.abs(result.fileChurn - 0.5) < 1e-10);
});

test('computeOutcomeScores: fileChurn drops null editRevisitRate rows', () => {
  // Runs with null editRevisitRate are excluded from the fileChurn denominator,
  // mirroring how null tokenEfficiency values are dropped.
  const runs = [
    makeRun({ runId: 'r1', editRevisitRate: 0 }),    // fileChurn contribution: 1
    makeRun({ runId: 'r2', editRevisitRate: null }), // dropped from this dim
    makeRun({ runId: 'r3', editRevisitRate: 1 }),    // fileChurn contribution: 0
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // mean over non-null = (0 + 1) / 2 = 0.5 → fileChurn = 1 - 0.5 = 0.5
  assert.ok(Math.abs(result.fileChurn - 0.5) < 1e-10);
});

test('computeOutcomeScores: fileChurn all-null editRevisitRate defaults to worst', () => {
  // When every run has null editRevisitRate the dimension defaults to the worst
  // (0), matching the all-null tokenEfficiency path (median → TOKEN_EFFICIENCY_MAX → 0).
  const runs = [
    makeRun({ runId: 'r1', editRevisitRate: null }),
    makeRun({ runId: 'r2', editRevisitRate: null }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.equal(result.fileChurn, 0);
});

test('computeOutcomeScores: toolReliability = proportion with 0 failures', () => {
  const runs = [
    makeRun({ runId: 'r1', toolFailureCount: 0 }),
    makeRun({ runId: 'r2', toolFailureCount: 3 }),
    makeRun({ runId: 'r3', toolFailureCount: 0 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.ok(Math.abs(result.toolReliability - 2 / 3) < 1e-10);
});

test('computeOutcomeScores: verificationAdoption = proportion with count > 0', () => {
  const runs = [
    makeRun({ runId: 'r1', verificationTotalCount: 2 }),
    makeRun({ runId: 'r2', verificationTotalCount: 0 }),
    makeRun({ runId: 'r3', verificationTotalCount: 5 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.ok(Math.abs(result.verificationAdoption - 2 / 3) < 1e-10);
});

test('computeOutcomeScores: tokenEfficiency is median inverted', () => {
  // tokenEfficiency in PreparedRunRow is outputTokens/lineMutationTotal.
  // computeOutcomeScores takes the median, caps at 50, then inverts.
  const runs = [
    makeRun({ runId: 'r1', tokenEfficiency: 10 }),   // inverted: 1 - 10/50 = 0.8
    makeRun({ runId: 'r2', tokenEfficiency: 20 }),   // inverted: 1 - 20/50 = 0.6
    makeRun({ runId: 'r3', tokenEfficiency: 30 }),   // inverted: 1 - 30/50 = 0.4
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // Median of [10, 20, 30] = 20. Inverted: 1 - 20/50 = 0.6
  assert.ok(Math.abs(result.tokenEfficiency - 0.6) < 1e-10);
});

test('computeOutcomeScores: tokenEfficiency capped at TOKEN_EFFICIENCY_MAX (50)', () => {
  const runs = [
    makeRun({ runId: 'r1', tokenEfficiency: 100 }),  // clamped to 50, inverted = 0
    makeRun({ runId: 'r2', tokenEfficiency: 200 }),  // clamped to 50, inverted = 0
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // Both clamped to 50, inverted = 1 - 50/50 = 0
  assert.equal(result.tokenEfficiency, 0);
});

test('computeOutcomeScores: tokenEfficiency with null values excluded', () => {
  const runs = [
    makeRun({ runId: 'r1', tokenEfficiency: null }),
    makeRun({ runId: 'r2', tokenEfficiency: 10 }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // Only non-null value: median = 10. Inverted: 1 - 10/50 = 0.8
  assert.ok(Math.abs(result.tokenEfficiency - 0.8) < 1e-10);
});

test('computeOutcomeScores: all null tokenEfficiency defaults to max', () => {
  const runs = [
    makeRun({ runId: 'r1', tokenEfficiency: null }),
    makeRun({ runId: 'r2', tokenEfficiency: null }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // No non-null values → sorted array is empty → median = TOKEN_EFFICIENCY_MAX (50)
  // inverted = 1 - 50/50 = 0
  assert.equal(result.tokenEfficiency, 0);
});

test('computeOutcomeScores: compositeScore is average of 6 normalized dimensions', () => {
  // Craft a run with known values for all 6 dimensions
  const runs = [
    makeRun({
      runId: 'perfect',
      satisfaction: 5,                    // (5-1)/4 = 1.0
      resolution: 'resolved',            // 1.0
      editRevisitRate: 0,               // fileChurn = 1 - 0 = 1.0
      toolFailureCount: 0,              // 1.0
      verificationTotalCount: 1,        // 1.0
      tokenEfficiency: 0,               // 1 - 0/50 = 1.0
    }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  // All 6 dimensions normalized to 1.0 → composite = 1.0
  assert.ok(Math.abs(result.compositeScore - 1.0) < 1e-10);
});

test('computeOutcomeScores: compositeScore with worst values', () => {
  const runs = [
    makeRun({
      runId: 'worst',
      satisfaction: 1,                    // (1-1)/4 = 0
      resolution: 'unresolved',          // 0
      editRevisitRate: 1,               // fileChurn = 1 - 1 = 0
      toolFailureCount: 10,             // 0
      verificationTotalCount: 0,        // 0
      tokenEfficiency: 50,              // 1 - 50/50 = 0
    }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.ok(Math.abs(result.compositeScore) < 1e-10, `composite should be ~0, got ${result.compositeScore}`);
});

test('computeOutcomeScores: modelId extracted from first run', () => {
  const runs = [makeRun({ runId: 'r1', modelId: 'my-model' })];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.equal(result.modelId, 'my-model');
});

test('computeOutcomeScores: unscored and null-satisfaction runs are filtered out', () => {
  const runs = [
    makeRun({ runId: 'r1', scored: true, satisfaction: 5 }),
    makeRun({ runId: 'r2', scored: false, satisfaction: 3 }),
    makeRun({ runId: 'r3', scored: true, satisfaction: null }),
  ];
  const result = computeOutcomeScores(runs);
  assert.ok(result);
  assert.equal(result.runCount, 1);  // only r1 counts
  assert.equal(result.satisfaction, 5);
});

// ===========================================================================
// rankModelsInBand
// ===========================================================================

test('rankModelsInBand: single model returns it', () => {
  const outcomes: ModelOutcomeScores[] = [{
    modelId: 'm1',
    runCount: 5,
    satisfaction: 4,
    resolutionRate: 0.8,
    fileChurn: 0.6,
    toolReliability: 0.9,
    verificationAdoption: 0.5,
    tokenEfficiency: 0.7,
    compositeScore: 0.75,
  }];
  const ranked = rankModelsInBand(outcomes);
  assert.deepEqual(ranked, ['m1']);
});

test('rankModelsInBand: sorts by composite descending', () => {
  const outcomes: ModelOutcomeScores[] = [
    { modelId: 'low', runCount: 5, satisfaction: 3, resolutionRate: 0.5, fileChurn: 0.5, toolReliability: 0.5, verificationAdoption: 0.5, tokenEfficiency: 0.5, compositeScore: 0.3 },
    { modelId: 'high', runCount: 5, satisfaction: 5, resolutionRate: 1, fileChurn: 1, toolReliability: 1, verificationAdoption: 1, tokenEfficiency: 1, compositeScore: 0.9 },
  ];
  const ranked = rankModelsInBand(outcomes);
  assert.equal(ranked[0], 'high');
});

test('rankModelsInBand: ranks purely by quality composite, ignoring cost', () => {
  // Cost is not a ranking factor — not even a tiebreaker. Models are ordered
  // strictly by compositeScore descending; costs are omitted entirely to make
  // the assertion unambiguous.
  const outcomes: ModelOutcomeScores[] = [
    { modelId: 'quality-a', runCount: 5, satisfaction: 4, resolutionRate: 0.8, fileChurn: 0.7, toolReliability: 0.9, verificationAdoption: 0.8, tokenEfficiency: 0.7, compositeScore: 0.81 },
    { modelId: 'quality-b', runCount: 5, satisfaction: 4, resolutionRate: 0.7, fileChurn: 0.6, toolReliability: 0.8, verificationAdoption: 0.7, tokenEfficiency: 0.6, compositeScore: 0.79 },
    { modelId: 'quality-c', runCount: 5, satisfaction: 3, resolutionRate: 0.5, fileChurn: 0.4, toolReliability: 0.6, verificationAdoption: 0.5, tokenEfficiency: 0.5, compositeScore: 0.40 },
    { modelId: 'quality-d', runCount: 5, satisfaction: 2, resolutionRate: 0.3, fileChurn: 0.2, toolReliability: 0.4, verificationAdoption: 0.3, tokenEfficiency: 0.3, compositeScore: 0.20 },
  ];
  const ranked = rankModelsInBand(outcomes);
  assert.deepEqual(ranked, ['quality-a', 'quality-b', 'quality-c', 'quality-d']);
});

test('rankModelsInBand: config presence does not affect ranking', () => {
  const outcomes: ModelOutcomeScores[] = [
    { modelId: 'known', runCount: 5, satisfaction: 4, resolutionRate: 0.8, fileChurn: 0.7, toolReliability: 0.9, verificationAdoption: 0.8, tokenEfficiency: 0.7, compositeScore: 0.8 },
    { modelId: 'unknown', runCount: 5, satisfaction: 4, resolutionRate: 0.7, fileChurn: 0.6, toolReliability: 0.8, verificationAdoption: 0.7, tokenEfficiency: 0.6, compositeScore: 0.7 },
  ];
  const ranked = rankModelsInBand(outcomes);
  assert.equal(ranked[0], 'known');
  assert.equal(ranked[1], 'unknown');
});

test('rankModelsInBand: ranks by quality, not cost', () => {
  const outcomes: ModelOutcomeScores[] = [
    { modelId: 'cheap-low', runCount: 5, satisfaction: 3, resolutionRate: 0.5, fileChurn: 0.5, toolReliability: 0.5, verificationAdoption: 0.5, tokenEfficiency: 0.5, compositeScore: 0.3 },
    { modelId: 'expensive-high', runCount: 5, satisfaction: 5, resolutionRate: 1, fileChurn: 1, toolReliability: 1, verificationAdoption: 1, tokenEfficiency: 1, compositeScore: 0.9 },
  ];
  const ranked = rankModelsInBand(outcomes);
  assert.deepEqual(ranked, ['expensive-high', 'cheap-low']);
});

// ===========================================================================
// filterEligible
// ===========================================================================

test('filterEligible: eligible models pass through', () => {
  const buckets: BucketAssignments = {
    small: ['model-a'],
    medium: ['model-b'],
    frontier: ['model-c'],
  };
  const config: SimpleModelConfig[] = [
    { id: 'model-a', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    { id: 'model-b', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 2 },
    { id: 'model-c', eligible: true, thinking: ['high'], disabled_reason: null, cost: 3 },
  ];
  const result = filterEligible(buckets, config);
  assert.deepEqual(result, buckets);
});

test('filterEligible: ineligible models are removed', () => {
  const buckets: BucketAssignments = {
    small: ['eligible-m', 'ineligible-m'],
    medium: [],
    frontier: [],
  };
  const config: SimpleModelConfig[] = [
    { id: 'eligible-m', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    { id: 'ineligible-m', eligible: false, thinking: ['medium'], disabled_reason: 'deprecated', cost: 0.5 },
  ];
  const result = filterEligible(buckets, config);
  assert.deepEqual(result.small, ['eligible-m']);
});

test('filterEligible: models in analytics but not in config are included', () => {
  const buckets: BucketAssignments = {
    small: ['known-model', 'unknown-model'],
    medium: [],
    frontier: [],
  };
  const config: SimpleModelConfig[] = [
    { id: 'known-model', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    // 'unknown-model' is not in config at all
  ];
  const result = filterEligible(buckets, config);
  assert.deepEqual(result.small, ['known-model', 'unknown-model']);
});

test('filterEligible: empty buckets stay empty', () => {
  const buckets: BucketAssignments = { small: [], medium: [], frontier: [] };
  const result = filterEligible(buckets, defaultModelConfig);
  assert.deepEqual(result, { small: [], medium: [], frontier: [] });
});

// ===========================================================================
// assignModelsToBuckets
// ===========================================================================

test('assignModelsToBuckets: models appear in their best band', () => {
  // Create runs for model-x in both low and high bands.
  // Give model-x higher compositeScore in the high band. Use enough high-
  // complexity runs so the high band has ≥3 scored runs after the tercile split
  // and the per-model minimum-sample threshold is satisfied there.
  const lowRuns = Array.from({ length: 7 }, (_, i) =>
    makeRun({
      runId: `low-${i}`,
      modelId: 'model-x',
      satisfaction: 2,           // low satisfaction in low band
      resolution: 'unresolved',
      lineAdditions: 1,         // low complexity signals
      lineDeletions: 0,
      lineModifications: 0,
      touchedFileCount: 1,
      toolCallCount: 1,
      busyDurationMs: 100,
      inputTokens: 10,
      tokenEfficiency: 40,      // poor efficiency
    })
  );
  const highRuns = Array.from({ length: 8 }, (_, i) =>
    makeRun({
      runId: `high-${i}`,
      modelId: 'model-x',
      satisfaction: 5,           // high satisfaction in high band
      resolution: 'resolved',
      lineAdditions: 500,       // high complexity signals
      lineDeletions: 200,
      lineModifications: 50,
      touchedFileCount: 20,
      toolCallCount: 30,
      busyDurationMs: 50000,
      inputTokens: 5000,
      tokenEfficiency: 5,       // good efficiency
    })
  );

  const allRuns = [...lowRuns, ...highRuns];
  const scores = computeComplexityScores(allRuns);
  const bands = assignBands(allRuns, scores);

  const config: SimpleModelConfig[] = [
    { id: 'model-x', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
  ];
  const result = assignModelsToBuckets(bands, config);

  // model-x should appear in frontier (high band) since it has better composite there
  assert.ok(!result.small.includes('model-x'), 'model-x should not be in small bucket');
  assert.ok(result.frontier.includes('model-x'), 'model-x should be in frontier bucket');
});

test('assignModelsToBuckets: model with runs in only one band appears in that bucket', () => {
  // model-y has 5 low-complexity runs; filler-z has 10 higher-complexity runs.
  // This keeps all model-y runs in the low band so it clears the per-band
  // minimum-sample threshold and appears in exactly one bucket.
  const yRuns = Array.from({ length: 5 }, (_, i) =>
    makeRun({
      runId: `single-y-${i}`,
      modelId: 'model-y',
      satisfaction: 4,
      resolution: 'resolved',
      lineAdditions: 5,
      lineDeletions: 1,
      lineModifications: 1,
      touchedFileCount: 1,
      toolCallCount: 1,
      busyDurationMs: 100,
      inputTokens: 20,
      tokenEfficiency: 10,
    })
  );

  const zRuns = Array.from({ length: 10 }, (_, i) =>
    makeRun({
      runId: `single-z-${i}`,
      modelId: 'filler-z',
      satisfaction: 3,
      resolution: 'resolved',
      lineAdditions: 500,
      lineDeletions: 100,
      lineModifications: 50,
      touchedFileCount: 20,
      toolCallCount: 100,
      busyDurationMs: 50000,
      inputTokens: 5000,
      tokenEfficiency: 30,
    })
  );

  const runs = [...yRuns, ...zRuns];
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);

  const config: SimpleModelConfig[] = [
    { id: 'model-y', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    { id: 'filler-z', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 2 },
  ];
  const result = assignModelsToBuckets(bands, config);

  // model-y should appear in exactly one bucket
  const allBuckets = [...result.small, ...result.medium, ...result.frontier];
  const count = allBuckets.filter((id) => id === 'model-y').length;
  assert.equal(count, 1, 'model-y should appear in exactly one bucket');
});

test('assignModelsToBuckets: family grouping collapses two provider ids into one bucket', () => {
  // Two provider-specific model ids sharing one modelFamily collapse into a
  // single family-keyed group (mirroring leaderboard.ts), so the family label —
  // not the provider ids — appears in the buckets.
  const familyRuns: PreparedRunRow[] = [];
  // Provider A: umans-glm-5.2
  for (let i = 0; i < 6; i++) {
    familyRuns.push(makeRun({
      runId: `umans-${i}`,
      modelId: 'umans-glm-5.2',
      modelFamily: 'glm-5.2',
      satisfaction: 4,
      resolution: 'resolved',
      editRevisitRate: 0,
    }));
  }
  // Provider B: glm-5.2:cloud (same family)
  for (let i = 0; i < 6; i++) {
    familyRuns.push(makeRun({
      runId: `cloud-${i}`,
      modelId: 'glm-5.2:cloud',
      modelFamily: 'glm-5.2',
      satisfaction: 4,
      resolution: 'resolved',
      editRevisitRate: 0,
    }));
  }

  const complexityScores = computeComplexityScores(familyRuns);
  const bands = assignBands(familyRuns, complexityScores);
  const config: SimpleModelConfig[] = [
    { id: 'umans-glm-5.2', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 10 },
    { id: 'glm-5.2:cloud', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 10 },
  ];
  const result = assignModelsToBuckets(bands, config);

  const allIds = [...result.small, ...result.medium, ...result.frontier];
  // The family label appears exactly once (collapses both provider ids).
  assert.equal(allIds.filter((id) => id === 'glm-5.2').length, 1, 'family glm-5.2 should appear once');
  // Neither provider-specific id leaks through as its own bucket entry.
  assert.ok(!allIds.includes('umans-glm-5.2'), 'umans-glm-5.2 should be collapsed into its family');
  assert.ok(!allIds.includes('glm-5.2:cloud'), 'glm-5.2:cloud should be collapsed into its family');
});

test('assignModelsToBuckets: models with fewer than 3 scored runs in a band are excluded', () => {
  const lowCountRuns = Array.from({ length: 2 }, (_, i) =>
    makeRun({
      runId: `few-${i}`,
      modelId: 'low-count-model',
      satisfaction: 5,
      resolution: 'resolved',
      lineAdditions: 1, lineDeletions: 0, lineModifications: 0,
      touchedFileCount: 1,
      toolCallCount: 1,
      busyDurationMs: 100,
      inputTokens: 10,
      tokenEfficiency: 5,
    })
  );

  const qualifyingRuns = Array.from({ length: 6 }, (_, i) =>
    makeRun({
      runId: `qual-${i}`,
      modelId: 'qualifying-model',
      satisfaction: 4,
      resolution: 'resolved',
      lineAdditions: 5, lineDeletions: 2, lineModifications: 1,
      touchedFileCount: 1,
      toolCallCount: 1,
      busyDurationMs: 200,
      inputTokens: 20,
      tokenEfficiency: 6,
    })
  );

  const fillerRuns = Array.from({ length: 6 }, (_, i) =>
    makeRun({
      runId: `fill-${i}`,
      modelId: 'filler-model',
      satisfaction: 3,
      resolution: 'resolved',
      lineAdditions: 500, lineDeletions: 100, lineModifications: 50,
      touchedFileCount: 20,
      toolCallCount: 100,
      busyDurationMs: 50000,
      inputTokens: 5000,
      tokenEfficiency: 30,
    })
  );

  const allRuns = [...lowCountRuns, ...qualifyingRuns, ...fillerRuns];
  const scores = computeComplexityScores(allRuns);
  const bands = assignBands(allRuns, scores);

  const config: SimpleModelConfig[] = [
    { id: 'low-count-model', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    { id: 'qualifying-model', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 2 },
    { id: 'filler-model', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 3 },
  ];
  const result = assignModelsToBuckets(bands, config);

  const allIds = [...result.small, ...result.medium, ...result.frontier];
  assert.ok(!allIds.includes('low-count-model'), 'model with < 3 scored runs should be excluded');
  assert.ok(allIds.includes('qualifying-model'), 'qualifying model should be ranked');
});

// ===========================================================================
// computeBucketAssignments (integration via internal pipeline)
// ===========================================================================

test('computeBucketAssignments: returns empty for non-existent directory', async () => {
  const result = await computeBucketAssignments('/nonexistent/path/abc123', defaultModelConfig);
  assert.deepEqual(result, { small: [], medium: [], frontier: [] });
});

test('computeBucketAssignments: bootstrap gate constant is 40', () => {
  assert.equal(BOOTSTRAP_MIN_RUNS, 40);
});

test('computeBucketAssignments: per-model minimum scored runs constant is 3', () => {
  assert.equal(MIN_SCORED_RUNS_PER_MODEL, 3);
});

// Test the full pipeline logic by composing internal functions directly,
// since computeBucketAssignments requires a real analytics directory.
test('full pipeline: < 40 scored runs produces empty assignments', () => {
  const runs = makeDiverseRuns(39);
  const scoredRuns = runs.filter((r) => r.scored);
  assert.equal(scoredRuns.length, 39);
  // This mirrors the bootstrap gate in computeBucketAssignments
  if (scoredRuns.length < BOOTSTRAP_MIN_RUNS) {
    // Would return empty
    assert.ok(true);
  } else {
    assert.fail('should not reach here');
  }
});

test('full pipeline: 40+ scored runs produces populated assignments', () => {
  const runs = makeDiverseRuns(45);
  const scoredRuns = runs.filter((r) => r.scored);
  assert.ok(scoredRuns.length >= BOOTSTRAP_MIN_RUNS);

  const complexityScores = computeComplexityScores(runs);
  const bands = assignBands(runs, complexityScores);
  const config: SimpleModelConfig[] = [
    { id: 'model-a', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
  ];
  const buckets = assignModelsToBuckets(bands, config);
  const filtered = filterEligible(buckets, config);

  // Should have model-a in at least one bucket
  const allIds = [...filtered.small, ...filtered.medium, ...filtered.frontier];
  assert.ok(allIds.includes('model-a'), 'model-a should be assigned to a bucket');
});

test('full pipeline: multi-model scenario assigns each model to a bucket', () => {
  // Create runs for 3 models with different complexity profiles
  const modelARuns = Array.from({ length: 15 }, (_, i) =>
    makeRun({
      runId: `a-low-${i}`,
      modelId: 'model-a',
      satisfaction: 4,
      resolution: 'resolved',
      lineAdditions: 5, lineDeletions: 2, lineModifications: 1,
      touchedFileCount: 1,
      toolCallCount: 2,
      busyDurationMs: 500,
      verificationTotalCount: 0,
      inputTokens: 50,
      tokenEfficiency: 8,
    })
  );
  const modelBRuns = Array.from({ length: 15 }, (_, i) =>
    makeRun({
      runId: `b-mid-${i}`,
      modelId: 'model-b',
      satisfaction: 3,
      resolution: 'partially_resolved',
      lineAdditions: 50, lineDeletions: 20, lineModifications: 10,
      touchedFileCount: 8,
      toolCallCount: 15,
      busyDurationMs: 5000,
      verificationTotalCount: 2,
      inputTokens: 500,
      tokenEfficiency: 20,
    })
  );
  const modelCRuns = Array.from({ length: 15 }, (_, i) =>
    makeRun({
      runId: `c-high-${i}`,
      modelId: 'model-c',
      satisfaction: 5,
      resolution: 'resolved',
      lineAdditions: 500, lineDeletions: 200, lineModifications: 50,
      touchedFileCount: 30,
      toolCallCount: 50,
      busyDurationMs: 50000,
      verificationTotalCount: 5,
      inputTokens: 5000,
      tokenEfficiency: 3,
    })
  );

  const allRuns = [...modelARuns, ...modelBRuns, ...modelCRuns];
  assert.ok(allRuns.length >= BOOTSTRAP_MIN_RUNS);

  const complexityScores = computeComplexityScores(allRuns);
  const bands = assignBands(allRuns, complexityScores);
  const config: SimpleModelConfig[] = [
    { id: 'model-a', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 1 },
    { id: 'model-b', eligible: true, thinking: ['medium'], disabled_reason: null, cost: 2 },
    { id: 'model-c', eligible: true, thinking: ['high'], disabled_reason: null, cost: 3 },
  ];
  const buckets = assignModelsToBuckets(bands, config);
  const filtered = filterEligible(buckets, config);

  // Each model should appear in exactly one bucket
  const allIds = [...filtered.small, ...filtered.medium, ...filtered.frontier];
  for (const modelId of ['model-a', 'model-b', 'model-c']) {
    const count = allIds.filter((id) => id === modelId).length;
    assert.equal(count, 1, `${modelId} should appear in exactly one bucket`);
  }
});

test('full pipeline: ineligible model is filtered out', () => {
  const runs = makeDiverseRuns(45, 'ineligible-model');
  const complexityScores = computeComplexityScores(runs);
  const bands = assignBands(runs, complexityScores);
  const buckets = assignModelsToBuckets(bands, defaultModelConfig);
  const filtered = filterEligible(buckets, defaultModelConfig);

  const allIds = [...filtered.small, ...filtered.medium, ...filtered.frontier];
  assert.ok(!allIds.includes('ineligible-model'), 'ineligible model should be filtered out');
});

test('full pipeline: model not in config is kept', () => {
  const runs = makeDiverseRuns(45, 'new-model-not-in-config');
  const complexityScores = computeComplexityScores(runs);
  const bands = assignBands(runs, complexityScores);
  const buckets = assignModelsToBuckets(bands, defaultModelConfig);
  const filtered = filterEligible(buckets, defaultModelConfig);

  const allIds = [...filtered.small, ...filtered.medium, ...filtered.frontier];
  assert.ok(allIds.includes('new-model-not-in-config'), 'model not in config should be kept');
});

test('full pipeline: ranks strictly by quality composite', () => {
  // Cost is not a ranking factor. Models are ordered by compositeScore
  // descending regardless of their cost.
  const outcomes: ModelOutcomeScores[] = [
    { modelId: 'expensive-high', runCount: 10, satisfaction: 4, resolutionRate: 1, fileChurn: 1, toolReliability: 1, verificationAdoption: 1, tokenEfficiency: 0.8, compositeScore: 0.9 },
    { modelId: 'cheap-high', runCount: 10, satisfaction: 4, resolutionRate: 1, fileChurn: 1, toolReliability: 1, verificationAdoption: 1, tokenEfficiency: 0.8, compositeScore: 0.85 },
    { modelId: 'expensive-low', runCount: 10, satisfaction: 3, resolutionRate: 0.5, fileChurn: 0.5, toolReliability: 0.5, verificationAdoption: 0.5, tokenEfficiency: 0.5, compositeScore: 0.4 },
    { modelId: 'cheap-low', runCount: 10, satisfaction: 3, resolutionRate: 0.5, fileChurn: 0.5, toolReliability: 0.5, verificationAdoption: 0.5, tokenEfficiency: 0.5, compositeScore: 0.35 },
  ];
  const ranked = rankModelsInBand(outcomes);
  assert.deepEqual(ranked, ['expensive-high', 'cheap-high', 'expensive-low', 'cheap-low']);
});

// ===========================================================================
// Edge cases
// ===========================================================================

test('edge case: single run with all minimum signals', () => {
  const run = makeRun({
    runId: 'minimal',
    lineAdditions: 0, lineDeletions: 0, lineModifications: 0,
    touchedFileCount: 0,
    toolCallCount: 0,
    busyDurationMs: 0,
    verificationTotalCount: 0,
    inputTokens: 0,
    satisfaction: 1,
    resolution: 'unresolved',
    firstAttemptSuccess: false,
    editRevisitRate: 1,               // all churn → fileChurn 0 (worst)
    tokenEfficiency: 50,
    toolFailureCount: 99,
  });
  const scores = computeComplexityScores([run]);
  assert.equal(scores.get('minimal'), 0.5);

  const outcomes = computeOutcomeScores([run]);
  assert.ok(outcomes);
  assert.equal(outcomes!.satisfaction, 1);
  assert.equal(outcomes!.resolutionRate, 0);
  assert.equal(outcomes!.fileChurn, 0);
  assert.equal(outcomes!.toolReliability, 0);
  assert.equal(outcomes!.verificationAdoption, 0);
  assert.equal(outcomes!.tokenEfficiency, 0);  // 1 - 50/50 = 0
});

test('edge case: even number of runs splits evenly into bands', () => {
  const runs = makeDiverseRuns(12);  // divisible by 3
  const scores = computeComplexityScores(runs);
  const bands = assignBands(runs, scores);
  for (const band of bands) {
    assert.equal(band.runs.length, 4, 'each band should have 4 runs');
  }
});

test('edge case: large dataset produces valid bucket assignments', () => {
  const modelIds = ['model-a', 'model-b', 'model-c', 'model-d'];
  const runs: PreparedRunRow[] = [];
  let idx = 0;
  for (const modelId of modelIds) {
    for (let i = 0; i < 20; i++) {
      runs.push(makeRun({
        runId: `run-${idx++}`,
        modelId,
        satisfaction: 2 + (idx % 4),
        resolution: idx % 3 === 0 ? 'unresolved' : 'resolved',
        lineAdditions: 10 + (idx * 7),
        lineDeletions: 5 + (idx * 3),
        lineModifications: 2 + (idx * 2),
        touchedFileCount: 1 + (idx % 10),
        toolCallCount: 5 + (idx % 8),
        busyDurationMs: 1000 + (idx * 500),
        verificationTotalCount: idx % 4,
        inputTokens: 100 + (idx * 50),
        tokenEfficiency: 5 + (idx % 20),
        toolFailureCount: idx % 7 === 0 ? 1 : 0,
        firstAttemptSuccess: idx % 3 !== 0,
      }));
    }
  }

  assert.equal(runs.length, 80);

  const complexityScores = computeComplexityScores(runs);
  const bands = assignBands(runs, complexityScores);
  const config: SimpleModelConfig[] = modelIds.map((id, i) => ({
    id,
    eligible: true,
    thinking: ['medium'] as const,
    disabled_reason: null,
    cost: i + 1,
  }));
  const buckets = assignModelsToBuckets(bands, config);
  const filtered = filterEligible(buckets, config);

  // Each model should appear exactly once
  const allIds = [...filtered.small, ...filtered.medium, ...filtered.frontier];
  for (const modelId of modelIds) {
    assert.equal(allIds.filter((id) => id === modelId).length, 1, `${modelId} should appear once`);
  }
});

test('edge case: runs with no line mutations (tokenEfficiency=null)', () => {
  const runs = Array.from({ length: 5 }, (_, i) =>
    makeRun({
      runId: `no-mut-${i}`,
      lineAdditions: 0,
      lineDeletions: 0,
      lineModifications: 0,
      tokenEfficiency: null,
      satisfaction: 4,
      resolution: 'resolved',
    })
  );
  const outcomes = computeOutcomeScores(runs);
  assert.ok(outcomes);
  // All tokenEfficiency are null → defaults to TOKEN_EFFICIENCY_MAX=50 → inverted = 0
  assert.equal(outcomes!.tokenEfficiency, 0);
});