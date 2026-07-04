import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAggregateStats, providerForModel, pricingForModel } from '../src/host/stats-service/aggregate-stats';
import type { RunSnapshot } from '../src/host/run-analytics';
import type { ModelPricingRecord } from '../../shared/pricing-core';
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

const NOW = Date.parse('2026-07-04T12:00:00.000Z');

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
  const today = '2026-07-04T10:00:00.000Z';
  const yesterday = '2026-07-03T10:00:00.000Z';
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
  // daily series includes both days (within 14-day window)
  assert.equal(stats.dailyCost.length, 2);
  assert.equal(stats.dailyCost[0]!.date, '2026-07-03');
  assert.equal(stats.dailyCost[1]!.date, '2026-07-04');
});

test('computeAggregateStats: throughput is generation-time-weighted', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 0, 0)]]]);
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'm',
      turnThroughputSamples: [
        { endedAt: '2026-07-04T10:00:00.000Z', outputTokens: 1000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        { endedAt: '2026-07-04T10:01:00.000Z', outputTokens: 3000, generationDurationMs: 10_000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
        // interrupted turn is excluded
        { endedAt: '2026-07-04T10:02:00.000Z', outputTokens: 500, generationDurationMs: 5_000, concurrentBusySessions: 1, status: 'interrupted', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
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

test('computeAggregateStats: week window excludes runs older than 7 days', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([['m', [pricing('openai', 1, 1)]]]);
  const today = '2026-07-04T10:00:00.000Z';
  const tenDaysAgo = '2026-06-24T10:00:00.000Z'; // outside the 7-day window
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
  const yesterdaySample = '2026-07-03T23:30:00.000Z';
  const todaySample = '2026-07-04T10:00:00.000Z';
  const runs = [
    makeRun({
      runId: 'r1', modelId: 'm',
      // Run landed today, but one of its samples ended yesterday (pre-midnight).
      startedAt: '2026-07-03T23:00:00.000Z', updatedAt: todaySample, finalizedAt: todaySample,
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
