import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulateAggregateStats,
  computeAggregateStats,
  finalizeAggregateStats,
  finalizeAggregateStatsLayers,
  mergeAggregateStatsAccumulators,
  prepareAggregateStatsLayer,
  providerForModel,
  pricingForModel,
  buildCumulativeSeries,
  trailingLocalDates,
  MAX_INTRADAY_CHART_POINTS,
} from '../../../src/host/stats-service/aggregate-stats';
import { MAX_USER_INPUT_SAMPLE_CHARS, type RunSnapshot } from '../../../src/host/run-analytics';
import type { ModelPricingRecord } from '../../../../shared/pricing-core';
import type { AggregateSeriesSegment } from '../../../src/shared/protocol/aggregate-stats';
import type { TokenRateIndicatorState } from '../../../src/shared/token-rate';

function makeRun(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    sessionPath: '/s/1',
    runId: 'run-1',
    taskGroupId: 'tg-1',
    status: 'idle',
    startedAt: '2026-07-04T10:00:00.000Z',
    updatedAt: '2026-07-04T10:05:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1000,
    busyDurationMs: 1000,
    busyPeriodCount: 1,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: {
      totalCount: 0, failureCount: 0, executionFailureCount: 0,
      verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0,
      countsByName: {}, failureCountsByName: {}, failureCountsByKind: {},
      failureCountsByNameAndKind: {}, failureSamples: [],
      resultIssueCountsByName: {}, resultIssueCountsByKind: {},
      resultIssueCountsByNameAndKind: {}, resultIssueSamples: [],
      totalDurationMs: 0, timedCallCount: 0, durationMsByName: {},
      subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [],
    },
    fileMutation: {
      writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0,
      touchedFileCount: 0, lineAdditions: 0, lineDeletions: 0,
      lineModifications: 0, editCountsByFile: {}, readCountsByFile: {},
    },
    fileExtensions: {
      readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {},
    },
    verification: { totalCount: 0, failureCount: 0, countsByKind: {} },
    ...overrides,
  } as RunSnapshot;
}

function pricing(provider: string, input: number, output: number): ModelPricingRecord {
  return { id: 'm', provider, pricing: { input, output, cacheRead: 0, cacheWrite: 0 } };
}

/** Local noon on a calendar date — a TZ-independent anchor so date-bucketing
 *  assertions (local-midnight resets) hold in any timezone. */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}
/** ISO timestamp for a local wall-clock time (TZ-independent test anchor). */
function isoLocal(year: number, month: number, day: number, h = 12, min = 0): string {
  return new Date(year, month - 1, day, h, min, 0).toISOString();
}
const NOW = localNoon(2026, 7, 4);

function assertClose(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
}

test('mergeable accumulators deterministically match the compatibility wrapper', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['openai/gpt', [pricing('openai', 2, 6)]],
    ['anthropic/claude', [pricing('anthropic', 3, 15)]],
  ]);
  const runs = [
    makeRun({ runId: 'completed-1', modelId: 'openai/gpt', inputTokens: 1_000_000, outputTokens: 500_000 }),
    makeRun({ runId: 'completed-2', sessionPath: '/s/2', modelId: 'anthropic/claude', inputTokens: 2_000_000, outputTokens: 1_000_000 }),
    makeRun({ runId: 'open-1', sessionPath: '/s/3', modelId: 'openai/gpt', inputTokens: 3_000_000, outputTokens: 2_000_000 }),
  ];
  let accumulatedRuns = 0;
  const completed = accumulateAggregateStats(runs.slice(0, 2), pricingMap, {
    onRunAccumulated: () => { accumulatedRuns += 1; },
  });
  const open = accumulateAggregateStats(runs.slice(2), pricingMap, {
    onRunAccumulated: () => { accumulatedRuns += 1; },
  });
  const merged = finalizeAggregateStats(
    mergeAggregateStatsAccumulators(completed, open),
    NOW,
    ['/s/3'],
    {},
    3,
  );
  const direct = computeAggregateStats(runs, pricingMap, NOW, ['/s/3'], {}, 3);
  assert.deepEqual(merged, direct);
  assert.equal(accumulatedRuns, runs.length, 'instrumentation observes each accumulated run once');
});

test('mergeable accumulators match randomized contiguous completed/open splits', () => {
  let seed = 0x5eed1234;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['m-a', [pricing('provider-a', 2, 6)]],
    ['m-b', [pricing('provider-b', 3, 9)]],
  ]);

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const count = 1 + Math.floor(random() * 30);
    const runs: RunSnapshot[] = [];
    for (let i = 0; i < count; i += 1) {
      const dayOffset = Math.floor(random() * 20);
      const at = isoLocal(2026, 7, 4 - dayOffset, 8 + (i % 12));
      runs.push(makeRun({
        runId: `random-${iteration}-${i}`,
        sessionPath: `/s/${Math.floor(random() * 6)}`,
        modelId: random() < 0.5 ? 'm-a' : 'm-b',
        inputTokens: Math.floor(random() * 5) * 1_000_000,
        outputTokens: Math.floor(random() * 5) * 1_000_000,
        startedAt: at,
        updatedAt: at,
        finalizedAt: at,
        toolUsage: { ...makeRun({}).toolUsage, totalCount: Math.floor(random() * 8) },
        fileMutation: { ...makeRun({}).fileMutation, touchedFileCount: Math.floor(random() * 5) },
      }));
    }
    const split = Math.floor(random() * (runs.length + 1));
    const completed = accumulateAggregateStats(runs.slice(0, split), pricingMap);
    const open = accumulateAggregateStats(runs.slice(split), pricingMap);
    const merged = finalizeAggregateStatsLayers(
      prepareAggregateStatsLayer(completed, NOW),
      open,
      NOW,
      [],
      {},
      0,
    );
    assert.deepEqual(
      merged,
      computeAggregateStats(runs, pricingMap, NOW, [], {}, 0),
      `randomized equivalence iteration ${iteration}`,
    );
  }
});

test('computeAggregateStats: per-provider cost + token totals', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['openai/gpt', [pricing('openai', 2, 6)]],
    ['anthropic/claude', [pricing('anthropic', 3, 15)]],
  ]);
  const runs = [
    makeRun({
      runId: 'r1', sessionPath: '/s/1', modelId: 'openai/gpt',
      inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }),
    makeRun({
      runId: 'r2', sessionPath: '/s/2', modelId: 'anthropic/claude',
      inputTokens: 200_000, outputTokens: 100_000,
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 2);

  // openai: 1M*2/1M + 500k*6/1M = 2 + 3 = 5
  // anthropic: 200k*3/1M + 100k*15/1M = 0.6 + 1.5 = 2.1
  assert.equal(stats.totalCost.toFixed(4), (5 + 2.1).toFixed(4));
  assert.equal(stats.costByProvider.length, 2);
  assert.equal(stats.costByProvider[0]!.provider, 'openai');
  assert.equal(stats.costByProvider[0]!.cost, 5);
  assert.equal(stats.costByProvider[1]!.provider, 'anthropic');
  assert.equal(stats.totalInputTokens, 1_200_000);
  assert.equal(stats.totalOutputTokens, 600_000);
  assert.equal(stats.sessionCount, 2);
  assert.equal(stats.runCount, 2);
  assert.equal(stats.openTabCount, 2);
  assert.equal(stats.ready, true);
});

test('computeAggregateStats: today bucketing excludes other-day runs', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const yesterday = isoLocal(2026, 7, 3, 10);
  const runs = [
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 1_000_000, outputTokens: 0, startedAt: today, updatedAt: today, finalizedAt: today }),
    makeRun({ runId: 'r2', modelId: 'm', inputTokens: 2_000_000, outputTokens: 0, startedAt: yesterday, updatedAt: yesterday, finalizedAt: yesterday }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // today: 1M*1/1M = 1 ; total = 1 + 2 = 3 ; week = today + yesterday = 3
  assert.equal(stats.todayCost, 1);
  assert.equal(stats.totalCost, 3);
  assert.equal(stats.todayCostByProvider.length, 1);
  assert.equal(stats.todayCostByProvider[0]!.provider, 'openai');
  assert.equal(stats.weekCost, 3);
  assert.equal(stats.weekCostByProvider.length, 1);
  assert.equal(stats.weekCostByProvider[0]!.provider, 'openai');
  assert.equal(stats.todayRunCount, 1);
  assert.equal(stats.weekRunCount, 2);
  assert.equal(stats.todayInputTokens, 1_000_000);
  assert.equal(stats.todayOutputTokens, 0);
  assert.equal(stats.todayToolCallCount, 0);
  assert.equal(stats.todayTouchedFileCount, 0);
  // daily series includes both days (within 14-day window)
  assert.equal(stats.dailyCost.length, 2);
  assert.equal(stats.dailyCost[0]!.date, '2026-07-03');
  assert.equal(stats.dailyCost[1]!.date, '2026-07-04');
});

test('computeAggregateStats: daily spend follows usage occurrence, not long-lived run finalization', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const yesterday = isoLocal(2026, 7, 3, 23, 30);
  const today = isoLocal(2026, 7, 4, 10);
  const run = makeRun({
    runId: 'long-lived',
    modelId: 'm',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    tokenReportedTurnCount: 1,
    startedAt: yesterday,
    updatedAt: today,
    finalizedAt: today,
    turnThroughputSamples: [{
      endedAt: yesterday,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 1.1,
      generationDurationMs: 1_000,
      concurrentBusySessions: 1,
      status: 'completed',
      modelId: 'm',
      provider: 'openai',
      turnLatencyMs: null,
      overheadMs: null,
      providerLatencyMs: null,
    }],
  });

  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  assert.equal(stats.todayCost, 0, 'yesterday usage must not be charged on today finalization');
  assert.equal(stats.todayInputTokens, 0);
  assert.equal(stats.todayOutputTokens, 0);
  assert.equal(stats.todayCostSeries.length, 0);
  assert.equal(stats.todayInputTokenSeries.length, 0);
  assert.equal(stats.todayTokenSeries.length, 0);
  assert.equal(stats.todayRunCount, 1, 'run completion activity still belongs to today');
  assert.equal(stats.weekRunCount, 1);
  assert.equal(stats.weekCost, 1.1);
  assert.equal(stats.dailyCost.find((day) => day.date === '2026-07-03')?.totalCost, 1.1);
  assert.equal(stats.dailyCost.find((day) => day.date === '2026-07-04')?.totalCost, 0);
});

test('computeAggregateStats: today activity (tokens/tool-calls/files) sums today runs', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const runs = [
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 100, outputTokens: 200, startedAt: today, updatedAt: today, finalizedAt: today,
      toolUsage: { totalCount: 5, failureCount: 0, executionFailureCount: 0, verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0, countsByName: {}, failureCountsByName: {}, failureCountsByKind: {}, failureCountsByNameAndKind: {}, failureSamples: [], resultIssueCountsByName: {}, resultIssueCountsByKind: {}, resultIssueCountsByNameAndKind: {}, resultIssueSamples: [], totalDurationMs: 0, timedCallCount: 0, durationMsByName: {}, subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [] } as any,
      fileMutation: { writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0, touchedFileCount: 3, lineAdditions: 0, lineDeletions: 0, lineModifications: 0, editCountsByFile: {}, readCountsByFile: {} } as any,
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.equal(stats.todayToolCallCount, 5);
  assert.equal(stats.todayTouchedFileCount, 3);
  assert.equal(stats.todayInputTokens, 100);
  assert.equal(stats.todayOutputTokens, 200);
});

test('computeAggregateStats: last run is the most-recently ended run', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 2, 6)]]]);
  const earlier = isoLocal(2026, 7, 3, 10);
  const later = isoLocal(2026, 7, 4, 10);
  const runs = [
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 500_000, outputTokens: 100_000, startedAt: earlier, updatedAt: earlier, finalizedAt: earlier, busyDurationMs: 30_000 }),
    makeRun({ runId: 'r2', modelId: 'm', inputTokens: 1_000_000, outputTokens: 500_000, startedAt: later, updatedAt: later, finalizedAt: later, busyDurationMs: 90_000 }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.ok(stats.lastRun);
  assert.equal(stats.lastRun!.endedAt, later); // r2 ended later
  assert.equal(stats.lastRun!.durationMs, 90_000);
  assert.equal(stats.lastRun!.provider, 'openai');
  // r2 cost: 1M*2/1M + 500k*6/1M = 2 + 3 = 5
  assert.equal(stats.lastRun!.cost, 5);
  assert.equal(stats.lastRun!.inputTokens, 1_000_000);
  assert.equal(stats.lastRun!.outputTokens, 500_000);
});

test('computeAggregateStats: throughput is generation-time-weighted', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'm',
      turnThroughputSamples: [
        { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 1000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: isoLocal(2026, 7, 4, 10, 1), outputTokens: 3000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        // interrupted turn is excluded
        { endedAt: isoLocal(2026, 7, 4, 10, 2), outputTokens: 500, generationDurationMs: 5_000, concurrentBusySessions: 1, status: 'interrupted', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // weighted: (1000 + 3000) / (20_000/1000) = 4000 / 20 = 200 tok/s
  assert.equal(stats.tokensPerSecond, 200);
  assert.equal(stats.tokensPerSecondByProvider.length, 1);
  assert.equal(stats.tokensPerSecondByProvider[0]!.tokensPerSecond, 200);
  assert.equal(stats.tokensPerSecondByProvider[0]!.sampleCount, 2);
  // today's throughput (samples ended today) = same 200 tok/s
  assert.equal(stats.todayTokensPerSecond, 200);
  assert.equal(stats.todayTokensPerSecondByProvider.length, 1);
  assert.equal(stats.todayTokensPerSecondByProvider[0]!.sampleCount, 2);
});

test('computeAggregateStats: unknown/unpriced model attributes to unknown with zero cost', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const runs = [makeRun({ runId: 'r1', modelId: 'mystery', inputTokens: 500_000, outputTokens: 100_000 })];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.equal(stats.totalCost, 0);
  assert.equal(stats.costByProvider.length, 1);
  assert.equal(stats.costByProvider[0]!.provider, 'unknown');
  // tokens still counted even when cost is 0
  assert.equal(stats.totalInputTokens, 500_000);
  assert.equal(stats.totalOutputTokens, 100_000);
});

test('computeAggregateStats: live tok/s sums running sessions rates', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const rates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '40 tok/s', ariaLabel: '', tooltip: '', state: 'generating', paused: false, rate: 40 },
    '/s/2': { label: '5.5 tok/s', ariaLabel: '', tooltip: '', state: 'generating', paused: false, rate: 5.5 },
    '/s/3': { label: '—', ariaLabel: '', tooltip: '', state: 'paused', paused: true }, // no rate → 0
  };
  const stats = computeAggregateStats([], pricingMap, NOW, ['/s/1', '/s/2', '/s/3'], rates, 3);
  assert.equal(stats.activeGenerationTokensPerSecond, 45.5);
  assert.equal(stats.liveTokensPerSecond, 45.5);
  assert.equal(stats.runningSessionCount, 3);
  assert.equal(stats.openTabCount, 3);
});

test('computeAggregateStats: a paused session (held rate) is excluded from live tok/s', () => {
  // A session paused on a tool call holds its last rate for the chip display
  // (token-rate.ts returns state:'paused' with a held `rate`) but must NOT
  // contribute to the status-bar aggregate for the whole tool-call duration.
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const rates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '⏸ 200 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 200 },
  };
  const stats = computeAggregateStats([], pricingMap, NOW, ['/s/1'], rates, 1);
  assert.equal(stats.liveTokensPerSecond, 0);
  // Still counted as a running session so ready/warming counts stay accurate.
  assert.equal(stats.runningSessionCount, 1);
});

test('computeAggregateStats: a long-running bash (paused peer) does not inflate the live total', () => {
  // Two running sessions: one generating at 150 tok/s, one paused on a tool
  // call holding 200 tok/s. The aggregate must be 150 (the generating session
  // only), not 350 — the user's exact symptom.
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const rates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '150 tok/s', ariaLabel: '', tooltip: '', state: 'generating', paused: false, rate: 150 },
    '/s/2': { label: '⏸ 200 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 200 },
  };
  const stats = computeAggregateStats([], pricingMap, NOW, ['/s/1', '/s/2'], rates, 2);
  assert.equal(stats.liveTokensPerSecond, 150);
  assert.equal(stats.runningSessionCount, 2);
});

test('computeAggregateStats: all-paused aggregate is 0 but running counts are unaffected', () => {
  // Two paused sessions (both mid tool call) → 0 live tok/s, but both still
  // counted in runningSessionCount so the ready/warming counts stay accurate.
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const rates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '⏸ 180 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 180 },
    '/s/2': { label: '⏸ 220 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 220 },
  };
  const stats = computeAggregateStats([], pricingMap, NOW, ['/s/1', '/s/2'], rates, 2);
  assert.equal(stats.liveTokensPerSecond, 0);
  assert.equal(stats.runningSessionCount, 2);
  assert.equal(stats.openTabCount, 2);
});

test('computeAggregateStats: resuming after a tool call restores the session\'s contribution', () => {
  // Same session transitions paused → generating across two computes. While
  // paused (tool running) it contributes 0; once generating again its rate is
  // summed back in.
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const pausedRates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '⏸ 200 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 200 },
  };
  const pausedStats = computeAggregateStats([], pricingMap, NOW, ['/s/1'], pausedRates, 1);
  assert.equal(pausedStats.liveTokensPerSecond, 0);

  const generatingRates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '200 tok/s', ariaLabel: '', tooltip: '', state: 'generating', paused: false, rate: 200 },
  };
  const generatingStats = computeAggregateStats([], pricingMap, NOW, ['/s/1'], generatingRates, 1);
  assert.equal(generatingStats.liveTokensPerSecond, 200);
});

test('computeAggregateStats: week window excludes runs older than 7 days', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const tenDaysAgo = isoLocal(2026, 6, 24, 10); // outside the 7-day window
  const runs = [
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 1_000_000, outputTokens: 0, startedAt: today, updatedAt: today, finalizedAt: today }),
    makeRun({ runId: 'r2', modelId: 'm', inputTokens: 5_000_000, outputTokens: 0, startedAt: tenDaysAgo, updatedAt: tenDaysAgo, finalizedAt: tenDaysAgo }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // today run = $1 ; 10-days-ago run = $5 but outside week window
  assert.equal(stats.todayCost, 1);
  assert.equal(stats.weekCost, 1);
  assert.equal(stats.totalCost, 6);
  assert.equal(stats.todayRunCount, 1);
  assert.equal(stats.weekRunCount, 1);
  assert.equal(stats.runCount, 2);
});

test('computeAggregateStats: today throughput buckets by sample end-date', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const yesterdaySample = isoLocal(2026, 7, 3, 23, 30);
  const todaySample = isoLocal(2026, 7, 4, 10);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'm',
      // Run landed today, but one of its samples ended yesterday (pre-local-midnight).
      startedAt: isoLocal(2026, 7, 3, 23, 0), updatedAt: todaySample, finalizedAt: todaySample,
      turnThroughputSamples: [
        { endedAt: yesterdaySample, outputTokens: 2000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: todaySample, outputTokens: 1000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // All-time: (2000 + 1000) / 20s = 150 tok/s
  assert.equal(stats.tokensPerSecond, 150);
  // Today: only the sample that ended today → 1000 / 10s = 100 tok/s
  assert.equal(stats.todayTokensPerSecond, 100);
  assert.equal(stats.todayTokensPerSecondByProvider[0]!.sampleCount, 1);
});

test('providerForModel / pricingForModel: ambiguous bare ids require an explicit provider', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['m', [
      { id: 'm', provider: 'proxy' }, // no pricing
      { id: 'm', provider: 'openai', pricing: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } },
      { id: 'm', provider: 'anthropic', pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
    ]],
  ]);
  assert.equal(providerForModel('m', pricingMap), 'unknown');
  assert.equal(pricingForModel('m', pricingMap), null);
  assert.equal(providerForModel('m', pricingMap, 'anthropic'), 'anthropic');
  assert.equal(pricingForModel('m', pricingMap, 'anthropic')!.output, 15);
  // Runtime provider identity is authoritative; never relabel an unpriced
  // openai-codex run as a same-id GitHub Copilot model.
  assert.equal(providerForModel('m', pricingMap, 'openai-codex'), 'openai-codex');
  assert.equal(pricingForModel('m', pricingMap, 'openai-codex'), null);
  assert.equal(providerForModel(undefined, pricingMap), 'unknown');
  assert.equal(pricingForModel('nope', pricingMap), null);
});

test('computeAggregateStats: throughput samples attribute to their own model with run-model fallback', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['openai/gpt', [pricing('openai', 0, 0)]],
    ['anthropic/claude', [pricing('anthropic', 0, 0)]],
  ]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'openai/gpt',
      turnThroughputSamples: [
        // Sample with its own model on a different provider.
        { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 3000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', modelId: 'anthropic/claude', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        // Sample without modelId falls back to the run's model.
        { endedAt: isoLocal(2026, 7, 4, 10, 1), outputTokens: 1000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // Total throughput: (3000 + 1000) / 20s = 200 tok/s
  assert.equal(stats.tokensPerSecond, 200);
  assert.equal(stats.tokensPerSecondByProvider.length, 2);
  const anthropic = stats.tokensPerSecondByProvider.find((p) => p.provider === 'anthropic');
  const openai = stats.tokensPerSecondByProvider.find((p) => p.provider === 'openai');
  assert.ok(anthropic, 'anthropic provider should be present');
  assert.ok(openai, 'openai provider should be present');
  // anthropic: 3000 / 10s = 300 tok/s
  assert.equal(anthropic!.tokensPerSecond, 300);
  assert.equal(anthropic!.outputTokens, 3000);
  assert.equal(anthropic!.sampleCount, 1);
  // openai: 1000 / 10s = 100 tok/s
  assert.equal(openai!.tokensPerSecond, 100);
  assert.equal(openai!.outputTokens, 1000);
  assert.equal(openai!.sampleCount, 1);
});

test('computeAggregateStats: today cost series is cumulative, pruned, with per-provider/model breakdown', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['openai/gpt', [pricing('openai', 2, 6)]],
    ['anthropic/claude', [pricing('anthropic', 3, 15)]],
  ]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'openai/gpt',
      inputTokens: 1_000_000, outputTokens: 1_000_000, // cost = 2 + 6 = 8
      startedAt: isoLocal(2026, 7, 4, 9, 0), updatedAt: isoLocal(2026, 7, 4, 10, 0), finalizedAt: isoLocal(2026, 7, 4, 10, 0),
      turnThroughputSamples: [
        { endedAt: isoLocal(2026, 7, 4, 9, 30), outputTokens: 400_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 600_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
    makeRun({
      runId: 'r2', modelId: 'anthropic/claude',
      inputTokens: 0, outputTokens: 200_000, // cost = 0 + 200k*15/1M = 3
      startedAt: isoLocal(2026, 7, 4, 11, 0), updatedAt: isoLocal(2026, 7, 4, 11, 30), finalizedAt: isoLocal(2026, 7, 4, 11, 30),
      turnThroughputSamples: [
        { endedAt: isoLocal(2026, 7, 4, 11, 30), outputTokens: 200_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // todayCost = 8 + 3 = 11. Series: 3 turn points + a trailing now point.
  assert.equal(stats.todayCost, 11);
  assert.equal(stats.todayCostSeries.length, 4);
  // Cost distributed by output tokens within each run:
  // r1 turn1 = 8 * 400k/1M = 3.2 (openai) ; r1 turn2 = 4.8 (openai) ; r2 = 3 (anthropic)
  const p0 = stats.todayCostSeries[0]!;
  assert.equal(p0.byProvider.length, 1);
  assert.equal(p0.byProvider[0]!.key, 'openai');
  assert.equal(p0.byProvider[0]!.value, 3.2);
  assert.equal(p0.byModel[0]!.key, 'openai/gpt');
  // After the anthropic turn, both providers present, cumulative = 11.
  const pTurn3 = stats.todayCostSeries[2]!;
  assert.equal(pTurn3.byProvider.length, 2);
  assert.equal(pTurn3.byProvider[0]!.key, 'openai');
  assert.equal(pTurn3.byProvider[0]!.value, 8);
  assert.equal(pTurn3.byProvider[1]!.key, 'anthropic');
  assert.equal(pTurn3.byProvider[1]!.value, 3);
  // Trailing now point extends to NOW and holds the full cumulative.
  const pNow = stats.todayCostSeries[3]!;
  assert.equal(pNow.ms, NOW);
  assert.equal(pNow.byProvider[0]!.value, 8);
  assert.equal(pNow.byProvider[1]!.value, 3);
});

test('computeAggregateStats: provider-qualified model identity survives daily and cumulative series', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['shared-model', [pricing('provider-a', 1, 2), pricing('provider-b', 3, 4)]],
  ]);
  const runs = [
    makeRun({
      runId: 'provider-a-run', modelId: 'shared-model', provider: 'provider-a',
      inputTokens: 100_000, outputTokens: 100_000,
      startedAt: isoLocal(2026, 7, 4, 9), updatedAt: isoLocal(2026, 7, 4, 9, 10), finalizedAt: isoLocal(2026, 7, 4, 9, 10),
      turnThroughputSamples: [{
        endedAt: isoLocal(2026, 7, 4, 9, 10), provider: 'provider-a', modelId: 'shared-model',
        outputTokens: 100_000, generationDurationMs: 1_000, concurrentBusySessions: 1,
        status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
      }],
    }),
    makeRun({
      runId: 'provider-b-run', sessionPath: '/s/2', modelId: 'shared-model', provider: 'provider-b',
      inputTokens: 100_000, outputTokens: 100_000,
      startedAt: isoLocal(2026, 7, 3, 10), updatedAt: isoLocal(2026, 7, 3, 10, 10), finalizedAt: isoLocal(2026, 7, 3, 10, 10),
      turnThroughputSamples: [{
        endedAt: isoLocal(2026, 7, 3, 10, 10), provider: 'provider-b', modelId: 'shared-model',
        outputTokens: 100_000, generationDurationMs: 1_000, concurrentBusySessions: 1,
        status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
      }],
    }),
  ];

  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  const dailyModels = stats.dailyCost.flatMap((day) => day.byModel);
  assert.deepEqual(
    dailyModels.map((entry) => [entry.provider, entry.model]).sort(),
    [['provider-a', 'shared-model'], ['provider-b', 'shared-model']],
  );
  const weekModels = stats.weekCostSeries.at(-1)!.byModel;
  assert.deepEqual(
    weekModels.map((entry) => [entry.provider, entry.model]).sort(),
    [['provider-a', 'shared-model'], ['provider-b', 'shared-model']],
  );
  assert.equal(stats.weekCostSeries.at(-1)!.byProvider.reduce((sum, entry) => sum + entry.value, 0), stats.weekCost);
  assert.ok(stats.weekCostSeries.some((point) => point.ms === Date.parse(isoLocal(2026, 7, 3, 10, 10))),
    'weekly area keeps underlying usage timestamps rather than daily midnight bars');
});

test('computeAggregateStats: today token + throughput series, daily run count, last-run turns', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['openai/gpt', [pricing('openai', 0, 0)]]]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'openai/gpt', inputTokens: 250_000, outputTokens: 1_000_000,
      startedAt: isoLocal(2026, 7, 4, 9, 0), updatedAt: isoLocal(2026, 7, 4, 10, 0), finalizedAt: isoLocal(2026, 7, 4, 10, 0),
      turnThroughputSamples: [
        { endedAt: isoLocal(2026, 7, 4, 9, 30), outputTokens: 400_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 600_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // Input uses its recorded run-usage timestamp; output retains per-turn samples.
  assert.equal(stats.todayInputTokenSeries.at(-1)!.byProvider[0]!.value, 250_000);
  assert.equal(stats.todayInputTokenSeries.at(-1)!.byModel[0]!.provider, 'openai');
  // Output series: 400k, 1M, +now(1M).
  assert.equal(stats.todayTokenSeries.length, 3);
  assert.equal(stats.todayTokenSeries[0]!.byProvider[0]!.value, 400_000);
  assert.equal(stats.todayTokenSeries[2]!.byProvider[0]!.value, 1_000_000);
  // Throughput series: one point per active hour (9 and 10).
  assert.equal(stats.todayThroughputSeries.length, 2);
  // hour 9: 400k / 10s = 40000 tok/s
  assert.equal(stats.todayThroughputSeries[0]!.byProvider[0]!.value, 40_000);
  // Daily run count: pruned to today only (1 run).
  assert.equal(stats.dailyRunCount.length, 1);
  assert.equal(stats.dailyRunCount[0]!.runCount, 1);
  // Last-run turn sparkline: 2 turns ascending.
  assert.ok(stats.lastRun);
  assert.equal(stats.lastRun!.turnSeries.length, 2);
  assert.equal(stats.lastRun!.turnSeries[0]!.outputTokens, 400_000);
  assert.equal(stats.lastRun!.turnSeries[1]!.outputTokens, 600_000);
});

test('computeAggregateStats: parent, subagent, and pruning usage reconcile across every cost/token rollup', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['parent', [pricing('parent-provider', 2, 6)]],
    ['child', [pricing('child-provider', 3, 15)]],
    ['pruner', [pricing('pruner-provider', 1, 2)]],
  ]);
  const endedAt = isoLocal(2026, 7, 4, 11, 0);
  const run = makeRun({
    modelId: 'parent',
    startedAt: isoLocal(2026, 7, 4, 9, 0),
    updatedAt: endedAt,
    finalizedAt: endedAt,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    toolUsage: {
      ...makeRun({}).toolUsage,
      subagentCallCount: 1,
      subagentTaskCount: 1,
      subagentInputTokens: 200_000,
      subagentOutputTokens: 100_000,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    auxiliaryLlmUsage: [
      {
        kind: 'subagent', sourceId: 'tool-1:0', occurredAt: isoLocal(2026, 7, 4, 10, 30), modelId: 'child',
        inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
      {
        kind: 'skill_pruning_prepass', sourceId: 'prune-1', occurredAt: isoLocal(2026, 7, 4, 9, 1), modelId: 'pruner',
        inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    ],
    turnThroughputSamples: [
      { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 500_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', modelId: 'parent', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: isoLocal(2026, 7, 4, 10, 30), outputTokens: 100_000, generationDurationMs: 5_000, concurrentBusySessions: 1, status: 'completed', modelId: 'child', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });

  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  // Parent $5 + child $2.10 + prepass $0.20.
  assertClose(stats.totalCost, 7.3);
  assertClose(stats.todayCost, 7.3);
  assertClose(stats.weekCost, 7.3);
  assertClose(stats.dailyCost[0]!.totalCost, 7.3);
  assert.equal(stats.totalInputTokens, 1_300_000);
  assert.equal(stats.totalOutputTokens, 650_000);
  assert.equal(stats.todayInputTokens, 1_300_000);
  assert.equal(stats.todayOutputTokens, 650_000);

  const providers = new Map(stats.costByProvider.map((entry) => [entry.provider, entry]));
  assertClose(providers.get('parent-provider')?.cost, 5);
  assertClose(providers.get('child-provider')?.cost, 2.1);
  assertClose(providers.get('pruner-provider')?.cost, 0.2);
  assert.deepEqual(
    new Map(stats.dailyCost[0]!.byModel.map((entry) => [entry.model, entry.cost])),
    new Map([['parent', 5], ['child', 2.1], ['pruner', 0.2]]),
  );

  const finalCostPoint = stats.todayCostSeries.at(-1)!;
  const finalTokenPoint = stats.todayTokenSeries.at(-1)!;
  assertClose(finalCostPoint.byProvider.reduce((sum, entry) => sum + entry.value, 0), 7.3);
  assertClose(finalCostPoint.byModel.reduce((sum, entry) => sum + entry.value, 0), 7.3);
  assert.equal(finalTokenPoint.byProvider.reduce((sum, entry) => sum + entry.value, 0), 650_000);
  assert.equal(finalTokenPoint.byModel.reduce((sum, entry) => sum + entry.value, 0), 650_000);
  assert.equal(stats.tokensPerSecondByProvider.reduce((sum, entry) => sum + entry.sampleCount, 0), 2,
    'auxiliary usage must not create duplicate throughput samples');
  assertClose(stats.lastRun?.cost, 7.3);
  assert.equal(stats.lastRun?.inputTokens, 1_300_000);
  assert.equal(stats.lastRun?.outputTokens, 650_000);
  assert.equal(stats.lastRun?.turnSeries.reduce((sum, entry) => sum + entry.outputTokens, 0), 650_000);
});

test('computeAggregateStats: forwarded child throughput never consumes parent billable usage', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['parent', [pricing('parent-provider', 2, 6)]],
    ['child', [pricing('child-provider', 3, 15)]],
  ]);
  const childEndedAt = isoLocal(2026, 7, 4, 10, 0);
  const parentEndedAt = isoLocal(2026, 7, 4, 10, 30);
  const run = makeRun({
    modelId: 'parent', provider: 'parent-provider',
    startedAt: isoLocal(2026, 7, 4, 9, 0), updatedAt: parentEndedAt, finalizedAt: parentEndedAt,
    inputTokens: 1_000_000, outputTokens: 100_000,
    toolUsage: {
      ...makeRun({}).toolUsage,
      subagentInputTokens: 200_000,
      subagentOutputTokens: 50_000,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    auxiliaryLlmUsage: [{
      kind: 'subagent', sourceId: 'child-1', occurredAt: childEndedAt,
      modelId: 'child', provider: 'child-provider',
      inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
    turnThroughputSamples: [
      { endedAt: childEndedAt, modelId: 'child', provider: 'child-provider', inputTokens: 0,
        outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0,
        generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed',
        turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: parentEndedAt, modelId: 'parent', provider: 'parent-provider', inputTokens: 1_000_000,
        outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
        generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed',
        turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });

  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  const providers = new Map(stats.costByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('parent-provider')?.inputTokens, 1_000_000);
  assert.equal(providers.get('parent-provider')?.outputTokens, 100_000);
  assertClose(providers.get('parent-provider')?.cost, 2.6);
  assert.equal(providers.get('child-provider')?.inputTokens, 200_000);
  assert.equal(providers.get('child-provider')?.outputTokens, 50_000);
  assertClose(providers.get('child-provider')?.cost, 1.35);
  assertClose(stats.totalCost, 3.95);
});

test('computeAggregateStats: multi-turn child turns never consume or steal parent usage', () => {
  // A multi-turn child forwards one throughput sample per turn while its
  // auxiliary sample records only the latest observed child response. Only the
  // latest child sample must be excluded from the parent reconciliation — an
  // earlier child turn that leaked into it stole parent output and attributed
  // it to the child provider. Parent and child use different providers/models.
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['parent', [pricing('parent-provider', 2, 6)]],
    ['child', [pricing('child-provider', 3, 15)]],
  ]);
  const childTurn1EndedAt = isoLocal(2026, 7, 4, 10, 0);
  const childTurn2EndedAt = isoLocal(2026, 7, 4, 10, 5);
  const parentEndedAt = isoLocal(2026, 7, 4, 10, 30);
  const childSample = (endedAt: string, outputTokens: number) => ({
    endedAt, modelId: 'child', provider: 'child-provider', inputTokens: 0,
    outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
    generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed' as const,
    turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
  });
  const run = makeRun({
    modelId: 'parent', provider: 'parent-provider',
    startedAt: isoLocal(2026, 7, 4, 9, 0), updatedAt: parentEndedAt, finalizedAt: parentEndedAt,
    inputTokens: 1_000_000, outputTokens: 100_000,
    toolUsage: {
      ...makeRun({}).toolUsage,
      subagentInputTokens: 200_000,
      subagentOutputTokens: 80_000,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    // occurredAt = the latest observed child response (turn 2), so an exact
    // timestamp match excludes only turn 2 and leaks turn 1 into the parent
    // reconciliation.
    auxiliaryLlmUsage: [{
      kind: 'subagent', sourceId: 'child-1', occurredAt: childTurn2EndedAt,
      modelId: 'child', provider: 'child-provider',
      inputTokens: 200_000, outputTokens: 80_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
    turnThroughputSamples: [
      childSample(childTurn1EndedAt, 30_000),
      childSample(childTurn2EndedAt, 50_000),
      { endedAt: parentEndedAt, modelId: 'parent', provider: 'parent-provider', inputTokens: 1_000_000,
        outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
        generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed',
        turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });

  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  const providers = new Map(stats.costByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('parent-provider')?.inputTokens, 1_000_000);
  assert.equal(providers.get('parent-provider')?.outputTokens, 100_000,
    'earlier child turns must not consume the parent usage remainder');
  assertClose(providers.get('parent-provider')?.cost, 2.6);
  assert.equal(providers.get('child-provider')?.inputTokens, 200_000);
  assert.equal(providers.get('child-provider')?.outputTokens, 80_000,
    'child attribution stays its reconciled canonical total, not stolen parent output');
  assertClose(providers.get('child-provider')?.cost, 1.8);
  assert.equal(stats.totalInputTokens, 1_200_000);
  assert.equal(stats.totalOutputTokens, 180_000, 'canonical totals preserved without double counting');
  assertClose(stats.totalCost, 4.4);
  // Both child turns remain distinct throughput observations for their provider.
  const throughput = new Map(stats.tokensPerSecondByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(throughput.get('child-provider')?.sampleCount, 2);
  assert.equal(throughput.get('parent-provider')?.sampleCount, 1);
});

test('computeAggregateStats: long-context tiers apply per request, not to multi-turn child aggregates', () => {
  const tieredPricing: ModelPricingRecord = {
    id: 'tiered', provider: 'provider',
    pricing: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 100_000, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }],
    },
  };
  const pricingMap = new Map<string, ModelPricingRecord[]>([['tiered', [tieredPricing]]]);
  const endedAt = isoLocal(2026, 7, 4, 10, 0);
  const childAggregate = makeRun({
    modelId: 'tiered', provider: 'provider', inputTokens: 0, outputTokens: 0,
    startedAt: endedAt, updatedAt: endedAt, finalizedAt: endedAt,
    toolUsage: {
      ...makeRun({}).toolUsage,
      subagentInputTokens: 200_000,
      subagentOutputTokens: 100_000,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    auxiliaryLlmUsage: [{
      kind: 'subagent', sourceId: 'multi-turn', occurredAt: endedAt,
      modelId: 'tiered', provider: 'provider',
      inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
  });
  const singleRequest = makeRun({
    runId: 'single-request', sessionPath: '/s/single',
    modelId: 'tiered', provider: 'provider', inputTokens: 200_000, outputTokens: 100_000,
    startedAt: endedAt, updatedAt: endedAt, finalizedAt: endedAt,
    turnThroughputSamples: [{
      endedAt, modelId: 'tiered', provider: 'provider', inputTokens: 200_000,
      outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed',
      turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  });

  assertClose(computeAggregateStats([childAggregate], pricingMap, NOW, [], {}, 0).totalCost, 0.3);
  assertClose(computeAggregateStats([singleRequest], pricingMap, NOW, [], {}, 0).totalCost, 3);
});

test('computeAggregateStats: historical subagent totals use the unique child throughput model as attribution', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['parent', [pricing('parent-provider', 0, 0)]],
    ['child', [pricing('child-provider', 4, 10)]],
  ]);
  const endedAt = isoLocal(2026, 7, 4, 11, 0);
  const base = makeRun({});
  const run = makeRun({
    modelId: 'parent', startedAt: endedAt, updatedAt: endedAt, finalizedAt: endedAt,
    toolUsage: {
      ...base.toolUsage,
      subagentInputTokens: 100_000,
      subagentOutputTokens: 50_000,
      subagentCacheReadTokens: 0,
      subagentCacheWriteTokens: 0,
    },
    turnThroughputSamples: [
      { endedAt, outputTokens: 50_000, generationDurationMs: 1000, concurrentBusySessions: 1, status: 'completed', modelId: 'child', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });
  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  assert.equal(stats.totalCost, 0.9);
  assert.equal(stats.totalInputTokens, 100_000);
  assert.equal(stats.totalOutputTokens, 50_000);
  assert.equal(stats.costByProvider.find((entry) => entry.provider === 'child-provider')?.cost, 0.9);
  assert.equal(stats.dailyCost[0]!.byModel[0]?.model, 'child');
});

test('computeAggregateStats: empty series when no today runs', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const yesterday = isoLocal(2026, 7, 3, 10);
  const runs = [makeRun({ runId: 'r1', modelId: 'm', inputTokens: 1_000_000, outputTokens: 0, startedAt: yesterday, updatedAt: yesterday, finalizedAt: yesterday })];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.equal(stats.todayCost, 0);
  assert.equal(stats.todayCostSeries.length, 0);
  assert.equal(stats.todayInputTokenSeries.length, 0);
  assert.equal(stats.todayTokenSeries.length, 0);
  assert.equal(stats.todayThroughputSeries.length, 0);
});

function segmentMap(segments: AggregateSeriesSegment[]): Map<string, number> {
  return new Map(segments.map((s) => [s.key, s.value]));
}

test('buildCumulativeSeries: downsamples to cap while preserving exact totals', () => {
  const samples = [];
  for (let i = 0; i < 500; i += 1) {
    samples.push({ ms: i * 1000, provider: `p${i % 3}`, model: `m${i % 3}`, value: i + 1 });
  }
  const total = samples.reduce((sum: number, s: { value: number }) => sum + s.value, 0);
  const expectedProvider = new Map<string, number>();
  const expectedModel = new Map<string, number>();
  for (const s of samples) {
    expectedProvider.set(s.provider, (expectedProvider.get(s.provider) ?? 0) + s.value);
    expectedModel.set(s.model, (expectedModel.get(s.model) ?? 0) + s.value);
  }
  const cap = 10;
  const series = buildCumulativeSeries(samples, 600_000, cap);
  assert.ok(series.length <= cap, `series length ${series.length} exceeds cap ${cap}`);
  assert.ok(series.length > 1, 'expected at least one sample bucket plus the now point');
  for (let i = 0; i < series.length - 1; i += 1) {
    assert.ok(series[i]!.ms <= series[i + 1]!.ms, 'series must be chronological');
  }
  const final = series[series.length - 1]!;
  assert.equal(final.byProvider.reduce((sum, s) => sum + s.value, 0), total);
  assert.deepEqual(segmentMap(final.byProvider), expectedProvider);
  assert.deepEqual(segmentMap(final.byModel), expectedModel);
});

test('buildCumulativeSeries: multiple samples in the same bucket are accumulated', () => {
  const samples = [];
  for (let i = 0; i < 50; i += 1) {
    samples.push({ ms: 1000 + i, provider: 'openai', model: 'm', value: 1 });
  }
  const cap = 5;
  const series = buildCumulativeSeries(samples, 2000, cap);
  assert.ok(series.length <= cap, `series length ${series.length} exceeds cap ${cap}`);
  const final = series[series.length - 1]!;
  assert.equal(final.byProvider.reduce((sum, s) => sum + s.value, 0), 50);
  assert.equal(final.byProvider.find((s) => s.key === 'openai')?.value, 50);
  assert.equal(final.byModel.find((s) => s.key === 'm')?.value, 50);
});

test('buildCumulativeSeries: trailing now point is included without exceeding cap', () => {
  const samples = [];
  for (let i = 0; i < 100; i += 1) {
    samples.push({ ms: i * 10, provider: 'openai', model: 'm', value: 1 });
  }
  const cap = 10;
  const series = buildCumulativeSeries(samples, 2000, cap);
  assert.ok(series.length <= cap, `series length ${series.length} exceeds cap ${cap}`);
  assert.ok(series.length > 1, 'expected sample buckets plus the trailing now point');
  assert.equal(series[series.length - 1]!.ms, 2000);
});

test('layered and one-pass cumulative cost series are deterministic and match the aggregate total', () => {
  const now = localNoon(2026, 7, 13);
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['fixture/model-a', [pricing('provider-a', 2, 6)]],
    ['fixture/model-b', [pricing('provider-b', 3, 9)]],
  ]);
  const runs: RunSnapshot[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const minute = i % 1200;
    const iso = new Date(2026, 6, 13, 0, minute, 0).toISOString();
    runs.push(makeRun({
      runId: `layered-${i}`,
      sessionPath: `/s/${i % 20}`,
      modelId: i % 2 === 0 ? 'fixture/model-a' : 'fixture/model-b',
      inputTokens: 100 + i,
      outputTokens: 100,
      startedAt: iso,
      updatedAt: iso,
      finalizedAt: iso,
      turnThroughputSamples: [0, 1].map((sample) => ({
        endedAt: new Date(2026, 6, 13, 0, minute, sample).toISOString(),
        outputTokens: 50,
        generationDurationMs: 1_000,
        concurrentBusySessions: 1,
        status: 'completed' as const,
        turnLatencyMs: null,
        overheadMs: null,
        providerLatencyMs: null,
      })),
    }));
  }
  const split = 500;
  const completed = accumulateAggregateStats(runs.slice(0, split), pricingMap);
  const open = accumulateAggregateStats(runs.slice(split), pricingMap);
  const layered = finalizeAggregateStatsLayers(prepareAggregateStatsLayer(completed, now), open, now, [], {}, 0);
  const direct = computeAggregateStats(runs, pricingMap, now, [], {}, 0);
  // Regression: before the fix, layered and one-pass final cost points differed
  // by a few ULPs (e.g., 0.9919691341559999 vs 0.991969134156) and the series
  // final value did not equal the aggregate today cost.
  assert.deepEqual(layered.todayCostSeries, direct.todayCostSeries,
    'layered and one-pass cumulative cost series must be exactly equal');
  const final = direct.todayCostSeries.at(-1)!;
  assert.equal(
    final.byProvider.reduce((sum, entry) => sum + entry.value, 0),
    direct.todayCost,
    'final cumulative cost series must equal the aggregate today cost',
  );
  assert.equal(
    final.byModel.reduce((sum, entry) => sum + entry.value, 0),
    direct.todayCost,
    'final cumulative cost series model breakdown must equal the aggregate today cost',
  );
  assert.equal(direct.costByProvider.length, 2);
  assert.equal(direct.todayCostByProvider.length, 2);
  assert.equal(direct.dailyCost[direct.dailyCost.length - 1]!.byModel.length, 2);
});

test('computeAggregateStats: intraday series capped at 240 for thousands of same-day samples', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 2, 6)]]]);
  const baseMs = Date.parse(isoLocal(2026, 7, 4, 0, 0));
  const samples = [];
  for (let i = 0; i < 1000; i += 1) {
    samples.push({
      endedAt: new Date(baseMs + i * 60_000).toISOString(),
      outputTokens: 1000,
      generationDurationMs: 1000,
      concurrentBusySessions: 1,
      status: 'completed' as const,
      turnLatencyMs: null,
      overheadMs: null,
      providerLatencyMs: null,
    });
  }
  const run = makeRun({
    runId: 'r1',
    modelId: 'm',
    outputTokens: 1_000_000,
    startedAt: isoLocal(2026, 7, 4, 0, 0),
    updatedAt: samples[samples.length - 1].endedAt,
    finalizedAt: samples[samples.length - 1].endedAt,
    turnThroughputSamples: samples,
  });
  const lateNow = new Date(2026, 6, 4, 23, 0, 0).getTime();
  const stats = computeAggregateStats([run], pricingMap, lateNow, [], {}, 0);
  assert.ok(
    stats.todayTokenSeries.length <= MAX_INTRADAY_CHART_POINTS,
    `token series ${stats.todayTokenSeries.length} exceeds cap ${MAX_INTRADAY_CHART_POINTS}`,
  );
  assert.ok(
    stats.todayCostSeries.length <= MAX_INTRADAY_CHART_POINTS,
    `cost series ${stats.todayCostSeries.length} exceeds cap ${MAX_INTRADAY_CHART_POINTS}`,
  );
  for (const series of [stats.todayTokenSeries, stats.todayCostSeries]) {
    for (let i = 0; i < series.length - 1; i += 1) {
      assert.ok(series[i]!.ms <= series[i + 1]!.ms, 'intraday series must be chronological');
    }
  }
  const finalToken = stats.todayTokenSeries[stats.todayTokenSeries.length - 1]!;
  assert.equal(finalToken.byProvider.reduce((sum, s) => sum + s.value, 0), 1_000_000);
  const finalCost = stats.todayCostSeries[stats.todayCostSeries.length - 1]!;
  assertClose(finalCost.byProvider.reduce((sum, s) => sum + s.value, 0), 6);
  assert.equal(finalToken.byProvider[0]!.key, 'openai');
  assert.equal(finalToken.byModel[0]!.key, 'm');
  assert.equal(finalCost.byProvider[0]!.key, 'openai');
  assert.equal(finalCost.byModel[0]!.key, 'm');
});

test('aggregate lifecycle stats merge completed and open attempt evidence without inventing unknown values as zero', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>();
  const completed = makeRun({
    runId: 'completed-lifecycle',
    subagentAttemptSamples: [{
      sourceId: 'done:0:a', attemptId: 'a', retryIndex: 0, outcome: 'failure',
      durationMs: 120, durationSource: 'measured', backoffMs: 0, backoffSource: 'reported',
      phaseDurationsMs: { preparing: 20, waiting_provider: 100 }, phaseDurationsSource: 'measured',
      attemptSettlementOutcome: 'error', attemptSettlementSource: 'reported', parentSettlementSource: 'unknown', cleanupOutcome: null, cleanupSource: 'unknown',
    }],
  });
  const open = makeRun({
    runId: 'open-lifecycle', sessionPath: '/s/open',
    // One parsed call plus one malformed call: explicit 1 must win over this
    // call count (rather than the legacy fallback of 2).
    unknownSubagentAttemptRecordSourceIds: ['legacy-missing'],
    toolUsage: { ...makeRun({}).toolUsage, subagentCallCount: 2 },
    subagentAttemptSamples: [{
      sourceId: 'open:0:b', attemptId: 'b', retryIndex: 1, outcome: 'success',
      durationMs: null, durationSource: 'unknown', backoffMs: 250, backoffSource: 'reported',
      phaseDurationsMs: null, phaseDurationsSource: 'unknown',
      attemptSettlementOutcome: 'completed', attemptSettlementSource: 'reported', parentSettlementSource: 'unknown', cleanupOutcome: null, cleanupSource: 'unknown',
    }],
  });
  const legacyUnavailable = makeRun({
    runId: 'legacy-lifecycle', sessionPath: '/s/legacy',
    toolUsage: { ...makeRun({}).toolUsage, subagentCallCount: 1 },
  });
  const stats = finalizeAggregateStats(
    mergeAggregateStatsAccumulators(
      accumulateAggregateStats([completed], pricingMap),
      accumulateAggregateStats([open, legacyUnavailable], pricingMap),
    ),
    NOW, [], {}, 0,
  );

  assert.deepEqual(stats.subagentLifecycle.outcomeCounts, { success: 1, failure: 1, aborted: 0 });
  assert.equal(stats.subagentLifecycle.attemptDuration.measuredMs, 120);
  assert.equal(stats.subagentLifecycle.attemptDuration.measuredCount, 1);
  assert.equal(stats.subagentLifecycle.attemptDuration.unknownCount, 1);
  assert.equal(stats.subagentLifecycle.retries.attemptCount, 1);
  assert.equal(stats.subagentLifecycle.retries.backoff.reportedMs, 250);
  assert.equal(stats.subagentLifecycle.attemptSettlements.reportedCount, 2);
  assert.equal(stats.subagentLifecycle.parentSettlement.unknownCount, 2, 'attempt stop reasons never claim parent settlement provenance');
  assert.equal(stats.subagentLifecycle.cleanupTelemetry.reportedCount, 0);
  assert.equal(stats.subagentLifecycle.cleanupTelemetry.unknownCount, 2, 'missing cleanup telemetry is not an orphan occurrence');
  assert.deepEqual(stats.subagentLifecycle.phaseDurations.measuredMsByPhase, { preparing: 20, waiting_provider: 100 });
  assert.deepEqual(stats.subagentLifecycle.phaseDurations.measuredCountByPhase, { preparing: 1, waiting_provider: 1 });
  assert.equal(stats.subagentLifecycle.phaseDurations.unknownAttemptCount, 1);
  assert.equal(stats.subagentLifecycle.unknownAttemptRecordCallCount, 2, 'one mixed-run malformed call plus one legacy unavailable call remain unknown');
});

function sample(endedAt: string, concurrentBusySessions: number): RunSnapshot['turnThroughputSamples'][number] {
  return {
    endedAt,
    outputTokens: 100,
    generationDurationMs: 1_000,
    concurrentBusySessions,
    status: 'completed',
    turnLatencyMs: null,
    overheadMs: null,
    providerLatencyMs: null,
  };
}

test('daily work trend: distinct sessions used and peak concurrently working sessions per day', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const runs = [
    // Two runs from the same session today: sessionsUsed counts the session once.
    makeRun({
      runId: 'r1', sessionPath: '/s/1', modelId: 'm', busyPeriodCount: 1,
      startedAt: isoLocal(2026, 7, 4, 9), updatedAt: isoLocal(2026, 7, 4, 9, 30), finalizedAt: isoLocal(2026, 7, 4, 9, 30),
      turnThroughputSamples: [sample(isoLocal(2026, 7, 4, 9, 30), 2)],
    }),
    makeRun({
      runId: 'r2', sessionPath: '/s/1', modelId: 'm', busyPeriodCount: 1,
      startedAt: isoLocal(2026, 7, 4, 10), updatedAt: isoLocal(2026, 7, 4, 10, 30), finalizedAt: isoLocal(2026, 7, 4, 10, 30),
      turnThroughputSamples: [sample(isoLocal(2026, 7, 4, 10, 30), 1)],
    }),
    // A different session yesterday with a higher observed concurrency.
    makeRun({
      runId: 'r3', sessionPath: '/s/2', modelId: 'm', busyPeriodCount: 1,
      startedAt: isoLocal(2026, 7, 3, 8), updatedAt: isoLocal(2026, 7, 3, 8, 30), finalizedAt: isoLocal(2026, 7, 3, 8, 30),
      turnThroughputSamples: [sample(isoLocal(2026, 7, 3, 8, 30), 3)],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);

  assert.equal(stats.dailyWorkTrend.length, 2, 'leading idle day is pruned; window stays bounded');
  const yesterday = stats.dailyWorkTrend[0]!;
  const today = stats.dailyWorkTrend[1]!;
  assert.equal(yesterday.date, '2026-07-03');
  assert.equal(yesterday.sessionsUsed, 1);
  assert.equal(yesterday.peakWorkingSessions, 3, 'best concurrentBusySessions sample wins');
  assert.equal(today.date, '2026-07-04');
  assert.equal(today.sessionsUsed, 1, 'same session twice on one day stays distinct-session counted');
  assert.equal(today.peakWorkingSessions, 2);
});

test('daily work trend: conservative peak 1 for an observed busy run without samples', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const busyRun = makeRun({
    runId: 'busy', sessionPath: '/s/1', modelId: 'm', busyPeriodCount: 1, busyDurationMs: 5_000,
    startedAt: isoLocal(2026, 7, 4, 9), updatedAt: isoLocal(2026, 7, 4, 9, 30), finalizedAt: isoLocal(2026, 7, 4, 9, 30),
    turnThroughputSamples: [],
  });
  const idleRun = makeRun({
    runId: 'idle', sessionPath: '/s/2', modelId: 'm', busyPeriodCount: 0, busyDurationMs: 0,
    startedAt: isoLocal(2026, 7, 3, 9), updatedAt: isoLocal(2026, 7, 3, 9, 30), finalizedAt: isoLocal(2026, 7, 3, 9, 30),
    turnThroughputSamples: [],
  });
  const stats = computeAggregateStats([busyRun, idleRun], pricingMap, NOW, [], {}, 0);

  const byDate = new Map(stats.dailyWorkTrend.map((day) => [day.date, day]));
  assert.equal(byDate.get('2026-07-04')!.peakWorkingSessions, 1, 'busy run without samples claims a conservative 1');
  assert.equal(byDate.get('2026-07-03')!.peakWorkingSessions, 0, 'a run with no busy evidence never claims work');
  assert.equal(byDate.get('2026-07-04')!.sessionsUsed, 1);
  assert.equal(byDate.get('2026-07-03')!.sessionsUsed, 1);
});

test('daily work trend stays bounded to 14 points across a long history', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const runs: RunSnapshot[] = [];
  for (let back = 0; back < 20; back += 1) {
    const at = isoLocal(2026, 7, 4 - back, 8);
    runs.push(makeRun({
      runId: `d${back}`, sessionPath: `/s/${back}`, modelId: 'm', busyPeriodCount: 1,
      startedAt: at, updatedAt: at, finalizedAt: at,
      turnThroughputSamples: [sample(at, 1)],
    }));
  }
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.ok(stats.dailyWorkTrend.length <= 14, `work trend length ${stats.dailyWorkTrend.length} exceeds 14`);
  assert.equal(stats.dailyWorkTrend.at(-1)!.date, '2026-07-04');
  assert.equal(stats.dailyWorkTrend[0]!.date, '2026-06-21');
});

test('user-input character volume uses one trailing-14-day lower-rank P95 cap and reconciles windows', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const samples = [
    { id: 'd4', day: 4, length: 10 },
    { id: 'd3', day: 3, length: 20 },
    { id: 'd2', day: 2, length: 30 },
    { id: 'd1', day: 1, length: 40 },
    { id: 'today-outlier', day: 0, length: 10_000 },
    { id: 'older', day: 10, length: 35 },
  ];
  const runs = samples.map(({ id, day, length }, index) => {
    const at = isoLocal(2026, 7, 4 - day, 9 + (index % 3));
    return makeRun({
      runId: id,
      sessionPath: `/s/${id}`,
      modelId: 'm',
      userInputCharSamples: [{ occurredAt: at, chars: length }],
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      startedAt: at,
      updatedAt: at,
      finalizedAt: at,
    });
  });
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);

  // Six pooled samples sort to 10,20,30,35,40,10000. Lower-rank P95 is index
  // floor((6 - 1) * .95) = 4, so the pasted outlier contributes only 40.
  assert.equal(stats.todayProductivity.userInputCharCap, 40);
  assert.equal(stats.todayProductivity.adjustedUserInputChars, 40);
  assert.equal(stats.todayProductivity.knownUserInputCharSampleCount, 1);
  assert.equal(stats.todayProductivity.expectedUserInputCharSampleCount, 1);
  assert.equal(stats.todayProductivity.cappedUserInputCharSampleCount, 1);

  assert.equal(stats.weekProductivity.userInputCharCap, 40, 'Today and 7-day use the same 14-day cap');
  assert.equal(stats.weekProductivity.adjustedUserInputChars, 140, '10 + 20 + 30 + 40 + capped 40');
  assert.equal(stats.weekProductivity.knownUserInputCharSampleCount, 5);
  assert.equal(stats.weekProductivity.expectedUserInputCharSampleCount, 5);
  assert.equal(stats.weekProductivity.cappedUserInputCharSampleCount, 1);

  const trendByDate = new Map(stats.dailyWorkTrend.map((day) => [day.date, day.productivity]));
  assert.equal(trendByDate.get('2026-07-04')?.adjustedUserInputChars, stats.todayProductivity.adjustedUserInputChars);
  const weekDates = new Set(['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  const graphWeekSum = stats.dailyWorkTrend
    .filter((day) => weekDates.has(day.date))
    .reduce((sum, day) => sum + day.productivity.adjustedUserInputChars, 0);
  assert.equal(graphWeekSum, stats.weekProductivity.adjustedUserInputChars, 'daily graph and 7-day headline reconcile');
  assert.ok(stats.dailyWorkTrend.every((day) => day.productivity.userInputCharCap === 40), 'every graph point exposes the shared cap');
});

test('legacy initial prompt characters contribute a lower-bound sample without full coverage', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const at = isoLocal(2026, 7, 4, 10);
  const legacy = makeRun({
    runId: 'legacy-input',
    modelId: 'm',
    initialUserMessageChars: 60,
    startedAt: at,
    updatedAt: at,
    finalizedAt: at,
  });
  delete legacy.userInputCharSamples;
  delete legacy.askUserAnsweredCount;
  delete legacy.askUserCancelledCount;
  const stats = computeAggregateStats([legacy], pricingMap, NOW, [], {}, 0);

  assert.equal(stats.todayProductivity.adjustedUserInputChars, 60);
  assert.equal(stats.todayProductivity.knownUserInputCharSampleCount, 1);
  assert.equal(stats.todayProductivity.expectedUserInputCharSampleCount, 2,
    'historical ask answer coverage remains conservatively incomplete');
  assert.equal(stats.todayProductivity.userInputCharCap, 60, 'fewer than five samples use the maximum without adjustment');
  assert.equal(stats.todayProductivity.cappedUserInputCharSampleCount, 0);
});

test('timestamped user input is attributed across local midnight independently of run completion', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const beforeMidnight = isoLocal(2026, 7, 3, 23, 55);
  const afterMidnight = isoLocal(2026, 7, 4, 0, 5);
  const finalized = isoLocal(2026, 7, 4, 0, 10);
  const run = makeRun({
    runId: 'cross-midnight-input',
    modelId: 'm',
    sendCount: 1,
    askUserAnsweredCount: 1,
    askUserCancelledCount: 0,
    startedAt: beforeMidnight,
    updatedAt: finalized,
    finalizedAt: finalized,
    userInputCharSamples: [
      { occurredAt: beforeMidnight, chars: 10 },
      { occurredAt: afterMidnight, chars: 20 },
    ],
  });
  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);

  assert.equal(stats.todayRunCount, 1, 'the run itself still belongs to its completion day');
  assert.equal(stats.todayProductivity.adjustedUserInputChars, 20, 'Today includes only input captured after midnight');
  assert.equal(stats.todayProductivity.knownUserInputCharSampleCount, 1);
  assert.equal(stats.todayProductivity.expectedUserInputCharSampleCount, 1);
  const yesterday = stats.dailyWorkTrend.find((day) => day.date === '2026-07-03');
  assert.equal(yesterday?.sessionsUsed, 0, 'input-day coverage is not compared with completion-day session counts');
  assert.equal(yesterday?.productivity.adjustedUserInputChars, 10);
  assert.equal(yesterday?.productivity.expectedUserInputCharSampleCount, 1);
  assert.equal(stats.weekProductivity.adjustedUserInputChars, 30, 'daily input points reconcile with the 7-day total');
});

test('huge persisted user-input samples are bounded and aggregates remain finite', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const at = isoLocal(2026, 7, 4, 10);
  const run = makeRun({
    runId: 'huge-input',
    modelId: 'm',
    startedAt: at,
    updatedAt: at,
    finalizedAt: at,
    userInputCharSamples: [
      { occurredAt: at, chars: Number.MAX_VALUE },
      { occurredAt: at, chars: Number.POSITIVE_INFINITY },
    ],
  });
  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);

  assert.equal(stats.todayProductivity.adjustedUserInputChars, MAX_USER_INPUT_SAMPLE_CHARS);
  assert.equal(stats.todayProductivity.userInputCharCap, MAX_USER_INPUT_SAMPLE_CHARS);
  assert.equal(stats.todayProductivity.knownUserInputCharSampleCount, 1);
  assert.equal(stats.todayProductivity.expectedUserInputCharSampleCount, 2);
  assert.ok(Number.isFinite(stats.todayProductivity.adjustedUserInputChars));
});

test('productivity summaries: sends, prompt chars/tokens with coverage, attachments, and ask_user', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 0)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const yesterday = isoLocal(2026, 7, 3, 10);
  const runs = [
    // Today: tracked prompt chars + tokens, one image attachment, answered ask_user.
    makeRun({
      runId: 'tracked', sessionPath: '/s/1', modelId: 'm',
      sendCount: 2,
      initialUserMessageChars: 100,
      initialUserMessageTokens: 25,
      imageInputCount: 2,
      imageInputBytes: 2048,
      askUserAnsweredCount: 3,
      askUserCancelledCount: 1,
      inputTokens: 1_000_000,
      startedAt: today, updatedAt: today, finalizedAt: today,
    }),
    // Today: legacy run with no tracked prompt/ask_user fields — coverage only.
    makeRun({
      runId: 'legacy', sessionPath: '/s/2', modelId: 'm',
      sendCount: 1,
      inputTokens: 500_000,
      startedAt: isoLocal(2026, 7, 4, 9), updatedAt: isoLocal(2026, 7, 4, 9, 30), finalizedAt: isoLocal(2026, 7, 4, 9, 30),
    }),
    // Yesterday: tracked chars only (no token estimate), cancelled ask_user only.
    makeRun({
      runId: 'y', sessionPath: '/s/3', modelId: 'm',
      sendCount: 2,
      initialUserMessageChars: 60,
      askUserCancelledCount: 2,
      startedAt: yesterday, updatedAt: yesterday, finalizedAt: yesterday,
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);

  const todayP = stats.todayProductivity;
  assert.equal(todayP.sendCount, 3, 'tracked 2 sends plus the legacy run send');
  assert.equal(todayP.promptCharSamples, 1, 'legacy run without tracked chars stays untracked');
  assert.equal(todayP.promptChars, 100);
  assert.equal(todayP.averagePromptChars, 100);
  assert.equal(todayP.promptTokenSamples, 1);
  assert.equal(todayP.promptTokens, 25);
  assert.equal(todayP.inputTokens, 1_500_000, 'provider model-input tokens follow the usage-day buckets');
  assert.equal(todayP.imageInputCount, 2);
  assert.equal(todayP.imageInputBytes, 2048);
  assert.equal(todayP.askUserAnsweredCount, 3);
  assert.equal(todayP.askUserCancelledCount, 1, 'cancelled outcomes are carried separately from answered');
  assert.equal(todayP.askUserTrackedRuns, 1, 'only the run carrying ask_user counters counts as tracked');

  const weekP = stats.weekProductivity;
  assert.equal(weekP.sendCount, 5);
  assert.equal(weekP.promptCharSamples, 2);
  assert.equal(weekP.promptChars, 160);
  assert.equal(weekP.averagePromptChars, 80, 'week average pools tracked samples');
  assert.equal(weekP.promptTokenSamples, 1);
  assert.equal(weekP.promptTokens, 25);
  assert.equal(weekP.askUserAnsweredCount, 3);
  assert.equal(weekP.askUserCancelledCount, 3, 'cancelled ask_user outcomes carry into the week window');
  assert.equal(weekP.askUserTrackedRuns, 2);

  const todayTrend = stats.dailyWorkTrend.find((day) => day.date === '2026-07-04')!;
  assert.equal(todayTrend.productivity.sendCount, 3);
  assert.equal(todayTrend.productivity.askUserAnsweredCount, 3);
  assert.equal(todayTrend.productivity.askUserCancelledCount, 1);
  const idleTrendDay = stats.dailyWorkTrend.find((day) => day.date === '2026-07-02');
  assert.equal(idleTrendDay, undefined, 'leading idle days are pruned from the work trend');
});

test('productivity summaries: untracked windows stay explicit instead of reading as zeros', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const legacyRun = makeRun({
    runId: 'legacy', sessionPath: '/s/1', modelId: 'm', sendCount: 1,
    startedAt: today, updatedAt: today, finalizedAt: today,
  });
  delete (legacyRun as Partial<RunSnapshot>).askUserAnsweredCount;
  delete (legacyRun as Partial<RunSnapshot>).askUserCancelledCount;
  const stats = computeAggregateStats([legacyRun], pricingMap, NOW, [], {}, 0);

  assert.equal(stats.todayProductivity.promptCharSamples, 0);
  assert.equal(stats.todayProductivity.averagePromptChars, null, 'no tracked samples means unknown average, not 0');
  assert.equal(stats.todayProductivity.promptTokenSamples, 0);
  assert.equal(stats.todayProductivity.askUserTrackedRuns, 0, 'legacy ask_user coverage is untracked, not zero');
  assert.equal(stats.todayProductivity.askUserAnsweredCount, 0);
  assert.equal(stats.todayProductivity.askUserCancelledCount, 0, 'missing legacy counters stay untracked rather than zero');
  assert.equal(stats.todayProductivity.filesystemPathRefCount, 0, 'file refs are always tracked; 0 means none recorded');
  assert.equal(stats.todayProductivity.sendCount, 1, 'send counts are always tracked');
});

test('layered completed/open accumulation matches one-pass productivity and work trend', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const runs = [
    makeRun({
      runId: 'completed', sessionPath: '/s/1', modelId: 'm', sendCount: 2,
      initialUserMessageChars: 40, initialUserMessageTokens: 10,
      userInputCharSamples: [
        { occurredAt: isoLocal(2026, 7, 4, 9), chars: 40 },
        { occurredAt: isoLocal(2026, 7, 4, 9, 10), chars: 10 },
        { occurredAt: isoLocal(2026, 7, 4, 9, 20), chars: 5 },
      ],
      askUserAnsweredCount: 1, askUserCancelledCount: 0, busyPeriodCount: 1,
      startedAt: isoLocal(2026, 7, 4, 9), updatedAt: isoLocal(2026, 7, 4, 9, 30), finalizedAt: isoLocal(2026, 7, 4, 9, 30),
      turnThroughputSamples: [sample(isoLocal(2026, 7, 4, 9, 30), 2)],
    }),
    makeRun({
      runId: 'open', sessionPath: '/s/2', modelId: 'm', sendCount: 1,
      initialUserMessageChars: 80,
      userInputCharSamples: [{ occurredAt: isoLocal(2026, 7, 4, 10), chars: 80 }],
      askUserAnsweredCount: 0, askUserCancelledCount: 1, busyPeriodCount: 1,
      startedAt: isoLocal(2026, 7, 4, 10), updatedAt: isoLocal(2026, 7, 4, 10, 30), finalizedAt: isoLocal(2026, 7, 4, 10, 30),
      turnThroughputSamples: [sample(isoLocal(2026, 7, 4, 10, 30), 1)],
    }),
  ];
  const split = 1;
  const completed = accumulateAggregateStats(runs.slice(0, split), pricingMap);
  const open = accumulateAggregateStats(runs.slice(split), pricingMap);
  const layered = finalizeAggregateStatsLayers(prepareAggregateStatsLayer(completed, NOW), open, NOW, [], {}, 0);
  const direct = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  assert.deepEqual(layered.todayProductivity, direct.todayProductivity, 'layered today productivity must match one-pass');
  assert.deepEqual(layered.weekProductivity, direct.weekProductivity, 'layered week productivity must match one-pass');
  assert.deepEqual(layered.dailyWorkTrend, direct.dailyWorkTrend, 'layered work trend must match one-pass');
  const todayTrend = direct.dailyWorkTrend.at(-1)!;
  assert.equal(todayTrend.sessionsUsed, 2);
  assert.equal(todayTrend.peakWorkingSessions, 2, 'peak is the max across merged runs, never their sum');
  assert.equal(todayTrend.productivity.promptChars, 120);
  assert.equal(todayTrend.productivity.adjustedUserInputChars, 135);
  assert.equal(todayTrend.productivity.knownUserInputCharSampleCount, 4);
  assert.equal(todayTrend.productivity.expectedUserInputCharSampleCount, 4, 'coverage survives accumulator merging');
  assert.equal(todayTrend.productivity.userInputCharCap, 80, 'fewer than five merged samples use the maximum');
});

test('completed throughput samples without output are unavailable for historical rates', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const run = makeRun({
    runId: 'r1', modelId: 'm', inputTokens: 1_500, outputTokens: 1_000,
    startedAt: isoLocal(2026, 7, 4, 10), updatedAt: isoLocal(2026, 7, 4, 10, 10), finalizedAt: isoLocal(2026, 7, 4, 10, 10),
    turnThroughputSamples: [
      // Real completed turn: contributes tokens + duration.
      { endedAt: isoLocal(2026, 7, 4, 10, 0), inputTokens: 1_000, outputTokens: 1_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      // Completed but no output (e.g. a tool-only turn): unavailable, must not
      // contribute duration/sample count/provider rate/chart values.
      { endedAt: isoLocal(2026, 7, 4, 10, 5), inputTokens: 500, outputTokens: 0, generationDurationMs: 5_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      // No output and no generation time either.
      { endedAt: isoLocal(2026, 7, 4, 10, 6), inputTokens: 0, outputTokens: 0, generationDurationMs: 0, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });
  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);
  // Only the 1000-token / 10s sample feeds the rate.
  assert.equal(stats.tokensPerSecond, 100);
  assert.equal(stats.tokensPerSecondByProvider.length, 1);
  assert.equal(stats.tokensPerSecondByProvider[0]!.outputTokens, 1_000);
  assert.equal(stats.tokensPerSecondByProvider[0]!.generationDurationMs, 10_000);
  assert.equal(stats.tokensPerSecondByProvider[0]!.sampleCount, 1);
  assert.equal(stats.todayTokensPerSecond, 100);
  assert.equal(stats.todayTokensPerSecondByProvider[0]!.sampleCount, 1);
  // The throughput chart carries the one usable hour point at its true rate.
  assert.equal(stats.todayThroughputSeries.length, 1);
  assert.equal(stats.todayThroughputSeries[0]!.byProvider[0]!.value, 100);
  // Usage attribution is unchanged: the zero-output sample still bills its input.
  assert.equal(stats.totalInputTokens, 1_500);
  assert.equal(stats.totalOutputTokens, 1_000);
});

test('repeated input usage makes distinct cumulative jumps with unchanged totals', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 0)]]]);
  const run = makeRun({
    runId: 'r1', modelId: 'm', inputTokens: 300, outputTokens: 50,
    startedAt: isoLocal(2026, 7, 4, 10), updatedAt: isoLocal(2026, 7, 4, 10, 10), finalizedAt: isoLocal(2026, 7, 4, 10, 10),
    turnThroughputSamples: [
      { endedAt: isoLocal(2026, 7, 4, 10, 0), inputTokens: 100, outputTokens: 0, generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: isoLocal(2026, 7, 4, 10, 5), inputTokens: 200, outputTokens: 50, generationDurationMs: 1_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });
  const stats = computeAggregateStats([run], pricingMap, NOW, [], {}, 0);

  assert.equal(stats.todayInputTokens, 300, 'totals are exact');
  const series = stats.todayInputTokenSeries;
  assert.ok(series.length >= 3, `expected a jump per input event plus the now point, got ${series.length}`);
  assert.equal(series[0]!.ms, Date.parse(isoLocal(2026, 7, 4, 10, 0)));
  assert.equal(series[0]!.byProvider[0]!.value, 100, 'the first input event jumps at its own timestamp');
  assert.equal(series[1]!.ms, Date.parse(isoLocal(2026, 7, 4, 10, 5)));
  assert.equal(series[1]!.byProvider[0]!.value, 300, 'the second event accumulates on top');
  const final = series.at(-1)!;
  assert.equal(final.byProvider.reduce((sum, entry) => sum + entry.value, 0), 300);
  assert.equal(final.byModel.reduce((sum, entry) => sum + entry.value, 0), 300);
  // Layered preparation produces the same series.
  const completed = accumulateAggregateStats([run], pricingMap);
  const layered = finalizeAggregateStatsLayers(prepareAggregateStatsLayer(completed, NOW), accumulateAggregateStats([], pricingMap), NOW, [], {}, 0);
  assert.deepEqual(layered.todayInputTokenSeries, stats.todayInputTokenSeries);
});

test('trailing local calendar windows are DST-safe (no skipped or duplicated dates)', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // US spring forward: 2026-03-08 is a 23-hour day. A `now` just after local
    // midnight on Mar 9 made fixed 86,400,000ms stepping skip 2026-03-08.
    const springNow = new Date(2026, 2, 9, 0, 30).getTime();
    const springDates = trailingLocalDates(springNow, 14);
    assert.equal(springDates.length, 14);
    assert.equal(new Set(springDates).size, 14, 'spring-forward must not duplicate a date');
    assert.ok(springDates.includes('2026-03-08'), 'the 23-hour day is not skipped');
    assert.equal(springDates[springDates.length - 1], '2026-03-09');
    assert.equal(springDates[0], '2026-02-24');

    // US fall back: 2026-11-01 is a 25-hour day; fixed stepping duplicated it.
    const fallNow = new Date(2026, 10, 2, 0, 30).getTime();
    const fallDates = trailingLocalDates(fallNow, 14);
    assert.equal(fallDates.length, 14);
    assert.equal(new Set(fallDates).size, 14, 'fall-back must not duplicate a date');
    assert.ok(fallDates.includes('2026-11-01'));
    assert.equal(fallDates[fallDates.length - 1], '2026-11-02');
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('rolling-week cost windows count the DST-shortened day exactly once', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
    const now = new Date(2026, 2, 9, 0, 30).getTime();
    const runs = [];
    for (let back = 0; back < 7; back += 1) {
      const at = new Date(2026, 2, 9 - back, 12, 0, 0).toISOString();
      runs.push(makeRun({
        runId: `dst-${back}`, sessionPath: `/s/${back}`, modelId: 'm',
        inputTokens: 1_000_000, outputTokens: 0,
        startedAt: at, updatedAt: at, finalizedAt: at,
      }));
    }
    const stats = computeAggregateStats(runs, pricingMap, now, [], {}, 0);
    assert.equal(stats.weekRunCount, 7, 'all seven local week days fall inside the window');
    assert.equal(stats.weekCost, 7, 'each local day is counted exactly once across the DST boundary');
    assert.equal(stats.dailyCost.length, 7);
    assert.equal(stats.dailyCost[0]!.date, '2026-03-03');
    assert.equal(stats.dailyCost.at(-1)!.date, '2026-03-09');
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('prepared layers visit only the rolling-week dates for week cost samples', () => {
  const now = localNoon(2026, 7, 13);
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const runs: RunSnapshot[] = [];
  // 40 days before `now`: well outside every window. Its samples must never be
  // visited while preparing the rolling-week chart.
  for (let i = 0; i < 50; i += 1) {
    const at = isoLocal(2026, 6, 3, 8, i);
    runs.push(makeRun({
      runId: `old-${i}`, sessionPath: `/s/old/${i}`, modelId: 'm',
      inputTokens: 1_000_000, outputTokens: 0,
      startedAt: at, updatedAt: at, finalizedAt: at,
      turnThroughputSamples: [sample(at, 1)],
    }));
  }
  // Yesterday (inside the rolling week) and today.
  for (const [id, day, hour] of [['y', 12, 9] as const, ['t', 13, 10] as const]) {
    const at = isoLocal(2026, 7, day, hour);
    runs.push(makeRun({
      runId: `recent-${id}`, sessionPath: `/s/${id}`, modelId: 'm',
      inputTokens: 1_000_000, outputTokens: 0,
      startedAt: at, updatedAt: at, finalizedAt: at,
      turnThroughputSamples: [sample(at, 1)],
    }));
  }

  const completed = accumulateAggregateStats(runs, pricingMap);
  const visited: string[] = [];
  const prepared = prepareAggregateStatsLayer(completed, now, {
    onCompletedSourceEntryVisited: (kind) => visited.push(kind),
  });
  // Each run's cost distributes over its single turn sample → one cost sample
  // per run; only the two week-date runs are visited, never the 50 samples on
  // the 40-day-old date (there is no lifetime week-sample list to scan).
  const costVisits = visited.filter((kind) => kind === 'cost_sample').length;
  assert.equal(costVisits, 2);

  // Layered equality survives the per-date week-sample storage.
  const open = accumulateAggregateStats([], pricingMap);
  const layered = finalizeAggregateStatsLayers(prepared, open, now, [], {}, 0);
  const direct = computeAggregateStats(runs, pricingMap, now, [], {}, 0);
  assert.deepEqual(layered.weekCostSeries, direct.weekCostSeries);
  assert.deepEqual(layered.todayCostSeries, direct.todayCostSeries);
  assert.equal(direct.weekCost, 2);
  assert.equal(direct.weekCostSeries.at(-1)!.byProvider.reduce((sum, entry) => sum + entry.value, 0), 2);
});

test('prepared layers never leak pre-window history into week samples', () => {
  const now = localNoon(2026, 7, 13);
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const at = isoLocal(2026, 6, 3, 8);
  const completed = accumulateAggregateStats([makeRun({
    runId: 'old', sessionPath: '/s/old', modelId: 'm',
    inputTokens: 1_000_000, outputTokens: 0,
    startedAt: at, updatedAt: at, finalizedAt: at,
    turnThroughputSamples: [sample(at, 1)],
  })], pricingMap);
  const visited: string[] = [];
  const prepared = prepareAggregateStatsLayer(completed, now, {
    onCompletedSourceEntryVisited: (kind) => visited.push(kind),
  });
  assert.equal(visited.filter((kind) => kind === 'cost_sample').length, 0,
    'cost samples outside the seven local week dates are not visited');
  const layered = finalizeAggregateStatsLayers(prepared, accumulateAggregateStats([], pricingMap), now, [], {}, 0);
  assert.equal(layered.weekCost, 0);
  assert.equal(layered.weekCostSeries.length, 0, 'pre-window history never leaks into the rolling-week chart');
});
