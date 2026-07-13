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
  MAX_INTRADAY_CHART_POINTS,
} from '../src/host/stats-service/aggregate-stats';
import { sumLiveRate } from '../src/host/aggregate-stats-service';
import type { RunSnapshot } from '../src/host/run-analytics';
import type { ModelPricingRecord } from '../../shared/pricing-core';
import type { AggregateSeriesSegment } from '../src/shared/protocol/aggregate-stats';
import type { TokenRateIndicatorState } from '../src/shared/token-rate';

function makeRun(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    sessionPath: '/s/1',
    runId: 'run-1',
    taskGroupId: 'tg-1',
    status: 'idle',
    scored: false,
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
      subagentScoredTaskCount: 0,
      subagentTaskScores: {
        scored: 0, total: 0, byAgent: {}, averageScore: null, scoreHistogram: {},
      },
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

test('computeAggregateStats: today activity (tokens/tool-calls/files) sums today runs', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const today = isoLocal(2026, 7, 4, 10);
  const runs = [
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 100, outputTokens: 200, startedAt: today, updatedAt: today, finalizedAt: today,
      toolUsage: { totalCount: 5, failureCount: 0, executionFailureCount: 0, verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0, countsByName: {}, failureCountsByName: {}, failureCountsByKind: {}, failureCountsByNameAndKind: {}, failureSamples: [], resultIssueCountsByName: {}, resultIssueCountsByKind: {}, resultIssueCountsByNameAndKind: {}, resultIssueSamples: [], totalDurationMs: 0, timedCallCount: 0, durationMsByName: {}, subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [], subagentScoredTaskCount: 0, subagentTaskScores: { scored: 0, total: 0, byAgent: {}, averageScore: null, scoreHistogram: {} } } as any,
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
    makeRun({ runId: 'r1', modelId: 'm', inputTokens: 500_000, outputTokens: 100_000, startedAt: earlier, updatedAt: earlier, finalizedAt: earlier, busyDurationMs: 30_000, outcome: { resolution: 'resolved', satisfaction: 4 } as any }),
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
  assert.equal(stats.lastRun!.outcome, null); // r2 unscored
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

test('sumLiveRate: a paused entry (held rate) contributes 0 (widened predicate)', () => {
  // sumLiveRate is the fast-path used when disk data is unchanged. Its param
  // is widened to TokenRateIndicatorState so the same generating-only predicate
  // applies — a paused entry with a held rate must not be summed.
  const rates: Record<string, TokenRateIndicatorState> = {
    '/s/1': { label: '⏸ 200 tok/s', ariaLabel: '', tooltip: '', state: 'paused', paused: true, rate: 200 },
    '/s/2': { label: '40 tok/s', ariaLabel: '', tooltip: '', state: 'generating', paused: false, rate: 40 },
  };
  assert.equal(sumLiveRate(['/s/1', '/s/2'], rates), 40);
  assert.equal(sumLiveRate(['/s/1'], rates), 0);
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

test('providerForModel / pricingForModel: first priced provider wins', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['m', [
      { id: 'm', provider: 'proxy' }, // no pricing
      { id: 'm', provider: 'openai', pricing: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } },
      { id: 'm', provider: 'anthropic', pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
    ]],
  ]);
  assert.equal(providerForModel('m', pricingMap), 'openai');
  assert.equal(pricingForModel('m', pricingMap)!.output, 6);
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

test('computeAggregateStats: today token + throughput series, daily run count, last-run turns', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['openai/gpt', [pricing('openai', 0, 0)]]]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'openai/gpt', outputTokens: 1_000_000,
      startedAt: isoLocal(2026, 7, 4, 9, 0), updatedAt: isoLocal(2026, 7, 4, 10, 0), finalizedAt: isoLocal(2026, 7, 4, 10, 0),
      turnThroughputSamples: [
        { endedAt: isoLocal(2026, 7, 4, 9, 30), outputTokens: 400_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: isoLocal(2026, 7, 4, 10, 0), outputTokens: 600_000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      ],
    }),
  ];
  const stats = computeAggregateStats(runs, pricingMap, NOW, [], {}, 0);
  // Token series: 400k, 1M, +now(1M).
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
