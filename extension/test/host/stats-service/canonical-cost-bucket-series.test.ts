import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CanonicalAnalyticsReadModel } from '../../../src/analytics/query-entry.js';
import type { ProviderAggregateReadModel } from '../../../src/analytics/sqlite-recorder.js';
import { AggregateStatsService } from '../../../src/host/aggregate-stats-service.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats.js';
import {
  CANONICAL_COST_BUCKET_WIDTH_MS,
  addLocalCalendarDaysMs,
  localCalendarDayStartMs,
} from '../../../../shared/analytics/metrics.js';

function emptyCoverage() {
  return {
    occurrenceCount: 0,
    knownCount: 0,
    unknownCount: 0,
    knownTotal: '0',
    value: '0',
    complete: true,
  };
}

function aggregateAt(
  revision: string,
  executionCount = 0,
  sessionCount = executionCount,
): Omit<ProviderAggregateReadModel, 'groups' | 'series'> {
  return {
    revision,
    snapshotWatermark: '0',
    accounting: {
      revision,
      invocationCount: 0,
      inputTokens: emptyCoverage(),
      outputTokens: emptyCoverage(),
      cacheReadTokens: emptyCoverage(),
      cacheWriteTokens: emptyCoverage(),
      reasoningTokens: emptyCoverage(),
      providerTotalTokens: emptyCoverage(),
      effectiveCostUsd: {
        ...emptyCoverage(),
        reportedCount: 0,
        calculatedCount: 0,
      },
    },
    executionSummary: {
      revision,
      scope: { kind: 'global' },
      executionCount,
      begunCount: executionCount,
      settledCount: executionCount,
      lifecycleCoverage: 'known',
      timingCoverage: 'known',
      deliveryCoverage: 'complete',
      latestSettled: null,
    },
    latestRun: null,
    sessionCount,
    truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
  };
}

function providerGroupRows(
  rows: Array<{ provider: string; todayCost: number; weekCost: number }>,
): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    provider: row.provider,
    model: `${row.provider}-model`,
    session_count: 1,
    all_cost: row.weekCost,
    all_input: '0', all_output: '0', all_cache_read: '0', all_cache_write: '0',
    all_unknown: 0, all_unpriced: 0, all_gap: 0,
    today_cost: row.todayCost,
    today_input: '0', today_output: '0', today_cache_read: '0', today_cache_write: '0',
    today_unknown: 0, today_unpriced: 0, today_gap: 0,
    week_cost: row.weekCost,
    week_input: '0', week_output: '0', week_cache_read: '0', week_cache_write: '0',
    week_unknown: 0, week_unpriced: 0, week_gap: 0,
  }));
}

/** The week range's hourly bucket width (today is minute width —
 * `CANONICAL_COST_BUCKET_WIDTH_MS`). */
const BUCKET_MS = CANONICAL_COST_BUCKET_WIDTH_MS.week;

interface ServiceHarness {
  service: AggregateStatsService;
  recompute: () => Promise<void>;
}

function startService(
  readModel: Partial<CanonicalAnalyticsReadModel>,
  options: { nowMs: number; analyticsTimeZone?: string } = { nowMs: 1_750_000_000_000 },
): ServiceHarness {
  const archState = createInitialArchState();
  const statsService = {
    getAnalyticsReadModel: () => readModel,
    getOpenRuns: () => [],
    getPendingCompletedRuns: () => [],
    getStorageDir: () => tmpdir(),
    queryPersistedRunAnalytics: async () => ({ completedRuns: [], openRuns: [] }),
  };
  const service = new AggregateStatsService({
    getArchState: () => archState,
    statsService: statsService as never,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
    onChanged: () => undefined,
    now: () => new Date(options.nowMs),
    analyticsTimeZone: options.analyticsTimeZone,
  });
  return {
    service,
    recompute: async () => {
      await (service as unknown as { recompute(): Promise<void> }).recompute();
    },
  };
}

/** The exact per-range-width buckets the recorder emits for the planned
 * settlements: minute width for the today range, hour width for the week. */
function bucketsFor(
  rangeStartMs: number,
  planned: Array<{
    stepOffset: number;
    provider: string;
    cost: number | null;
    unknownCostCount?: number;
  }>,
  bucketWidthMs: number,
): Array<{ ms: number; provider: string; model: string; cost: number | null; unknownCostCount: number }> {
  return planned.map((entry) => ({
    ms: rangeStartMs + entry.stepOffset * bucketWidthMs,
    provider: entry.provider,
    model: entry.provider === 'unknown' ? 'unknown' : `${entry.provider}-model`,
    cost: entry.cost,
    unknownCostCount: entry.unknownCostCount ?? 0,
  }));
}

test('busy windows chart from exact cost buckets instead of a daily diagonal', async () => {
  const nowMs = 1_750_000_000_000;
  const todayStart = localCalendarDayStartMs(nowMs, 'UTC');
  const weekStart = addLocalCalendarDaysMs(todayStart, -6, 'UTC');
  // A >4096-row window: the recorder bounds the raw samples (truncated, no
  // per-settlement samples) while its minute-width today buckets remain
  // complete. Minute offsets are spread across the day so the host's bounded
  // chart downsampling keeps one point per bucket.
  const todayPlanned = [
    { stepOffset: 0, provider: 'alpha', cost: 1 },
    { stepOffset: 240, provider: 'beta', cost: 0.5 },
    { stepOffset: 480, provider: 'alpha', cost: 2 },
    { stepOffset: 660, provider: 'beta', cost: 0.5 },
    { stepOffset: 840, provider: 'alpha', cost: 1 },
  ];
  const weekPlanned = [
    { stepOffset: 0, provider: 'alpha', cost: 7 },
    ...todayPlanned.map((entry) => ({
      stepOffset: entry.stepOffset / 60 + (todayStart - weekStart) / (60 * BUCKET_MS),
      provider: entry.provider,
      cost: entry.cost,
    })),
  ];
  const readModel = {
    readProviderAggregateSummary: async () => ({
      ...aggregateAt('1'),
      groups: providerGroupRows([
        { provider: 'alpha', todayCost: 4, weekCost: 11 },
        { provider: 'beta', todayCost: 1, weekCost: 1 },
      ]),
      series: {
        settlements: [],
        executions: [],
        dailyCosts: [{
          date: new Date(todayStart).toISOString().slice(0, 10),
          totalCost: 4,
          byProvider: [{ provider: 'alpha', cost: 3 }, { provider: 'beta', cost: 1 }],
          byModel: [
            { provider: 'alpha', model: 'alpha-model', cost: 3 },
            { provider: 'beta', model: 'beta-model', cost: 1 },
          ],
        }],
        dailyExecutions: [{
          date: new Date(todayStart).toISOString().slice(0, 10),
          runCount: 7,
          sessionCount: 2,
        }],
        todayCostBuckets: bucketsFor(todayStart, todayPlanned, CANONICAL_COST_BUCKET_WIDTH_MS.today),
        weekCostBuckets: bucketsFor(weekStart, weekPlanned, CANONICAL_COST_BUCKET_WIDTH_MS.week),
        todayCostBucketsTruncated: false,
        weekCostBucketsTruncated: false,
        truncated: true,
        settlementTruncated: true,
        executionTruncated: false,
      },
    }),
  } as unknown as Partial<CanonicalAnalyticsReadModel>;
  const harness = startService(readModel);
  try {
    await harness.recompute();
    const stats = harness.service.getAggregateStats();

    // Today's stacked chart is granular, not a two-point daily diagonal.
    assert.ok(stats.todayCostSeries.length >= 6, `expected minute granularity, got ${stats.todayCostSeries.length}`);
    const todayAlpha = stats.todayCostSeries.map((point) =>
      point.byProvider.find((segment) => segment.key === 'alpha')?.value ?? 0);
    // The slope changes with actual usage: flat between buckets 0 and 1 for
    // alpha, then rising again.
    assert.equal(todayAlpha[0], 1);
    assert.equal(todayAlpha[1], 1);
    assert.equal(todayAlpha[2], 3);
    assert.equal(todayAlpha[3], 3);
    assert.equal(todayAlpha[4], 4);
    assert.equal(stats.todayCostSeries.at(-1)!.ms, nowMs, 'the series extends to now');
    // Exact endpoint totals stack per provider.
    const finalToday = stats.todayCostSeries.at(-1)!;
    assert.deepEqual(
      finalToday.byProvider.map((segment) => [segment.key, segment.value]),
      [['alpha', 4], ['beta', 1]],
    );
    assert.deepEqual(
      finalToday.byModel.map((segment) => [segment.provider, segment.model, segment.value]),
      [['alpha', 'alpha-model', 4], ['beta', 'beta-model', 1]],
    );
    // Weekly chart includes the pre-today bucket and stays exact.
    const finalWeek = stats.weekCostSeries.at(-1)!;
    assert.deepEqual(
      finalWeek.byProvider.map((segment) => [segment.key, segment.value]),
      [['alpha', 11], ['beta', 1]],
    );
    assert.ok(stats.weekCostSeries.length >= stats.todayCostSeries.length - 1);
    // Token semantics stay independent: with truncated settlement samples the
    // token charts remain honestly unavailable.
    assert.equal(stats.todayInputTokenSeries.length, 0);
    assert.equal(stats.todayTokenSeries.length, 0);
    // Execution evidence was not truncated, so run counts stay exact.
    assert.equal(stats.todayRunCount, 7);
  } finally {
    harness.service.dispose();
  }
});

test('cost bucket truncation falls back to the exact daily rollup, never a partial stream', async () => {
  const nowMs = 1_750_000_000_000;
  const todayStart = localCalendarDayStartMs(nowMs, 'UTC');
  const date = new Date(todayStart).toISOString().slice(0, 10);
  const readModel = {
    readProviderAggregateSummary: async () => ({
      ...aggregateAt('1'),
      groups: providerGroupRows([{ provider: 'bulk-provider', todayCost: 4_097, weekCost: 4_097 }]),
      series: {
        settlements: [],
        executions: [],
        dailyCosts: [{
          date,
          totalCost: 4_097,
          byProvider: [{ provider: 'bulk-provider', cost: 4_097 }],
          byModel: [{ provider: 'bulk-provider', model: 'bulk-model', cost: 4_097 }],
        }],
        dailyExecutions: [{ date, runCount: 4_097, sessionCount: 1 }],
        todayCostBuckets: [],
        weekCostBuckets: [],
        todayCostBucketsTruncated: true,
        weekCostBucketsTruncated: true,
        truncated: true,
      },
    }),
  } as unknown as Partial<CanonicalAnalyticsReadModel>;
  const harness = startService(readModel);
  try {
    await harness.recompute();
    const stats = harness.service.getAggregateStats();
    assert.ok(stats.todayCostSeries.length > 0, 'the coarse daily fallback keeps the graph visible');
    assert.equal(stats.todayCostSeries.at(-1)!.byProvider[0]!.value, 4_097);
    assert.equal(stats.weekCostSeries.at(-1)!.byProvider[0]!.value, 4_097);
    assert.ok(stats.todayCostSeries.length <= 3, 'no partial bucket stream is charted');
  } finally {
    harness.service.dispose();
  }
});

test('bucket-aligned cost charts stay exact across non-UTC calendar zones', async () => {
  const timeZone = 'Asia/Kolkata';
  const nowMs = 1_750_000_000_000;
  const todayStart = localCalendarDayStartMs(nowMs, timeZone);
  // In a +05:30 zone the local midnight is not an UTC hour boundary; the
  // recorder aligns buckets to epoch multiples of the range's width, so the
  // host must too. Minute width can never straddle this boundary (every zone
  // offset is a whole number of minutes); hour width can.
  assert.notEqual((todayStart) % BUCKET_MS, 0);
  assert.equal((todayStart) % CANONICAL_COST_BUCKET_WIDTH_MS.today, 0);
  const planned = [
    { stepOffset: 0, provider: 'alpha', cost: 1 },
    { stepOffset: 300, provider: 'alpha', cost: 2 },
    { stepOffset: 600, provider: 'beta', cost: null, unknownCostCount: 3 },
    { stepOffset: 900, provider: 'alpha', cost: 3 },
  ];
  const readModel = {
    readProviderAggregateSummary: async () => ({
      ...aggregateAt('1'),
      groups: providerGroupRows([{ provider: 'alpha', todayCost: 6, weekCost: 6 }]),
      series: {
        settlements: [],
        executions: [],
        dailyCosts: [{
          date: new Date(nowMs).toISOString().slice(0, 10),
          totalCost: 6,
          byProvider: [{ provider: 'alpha', cost: 6 }],
          byModel: [{ provider: 'alpha', model: 'alpha-model', cost: 6 }],
        }],
        dailyExecutions: [],
        todayCostBuckets: bucketsFor(todayStart, planned, CANONICAL_COST_BUCKET_WIDTH_MS.today),
        weekCostBuckets: bucketsFor(todayStart, planned, CANONICAL_COST_BUCKET_WIDTH_MS.today),
        todayCostBucketsTruncated: false,
        weekCostBucketsTruncated: false,
        truncated: false,
      },
    }),
  } as unknown as Partial<CanonicalAnalyticsReadModel>;
  const harness = startService(readModel, { nowMs, analyticsTimeZone: timeZone });
  try {
    await harness.recompute();
    const stats = harness.service.getAggregateStats();
    for (const point of stats.todayCostSeries) {
      assert.ok(point.ms >= todayStart && point.ms <= nowMs, 'points stay inside the local day');
    }
    const final = stats.todayCostSeries.at(-1)!;
    assert.equal(final.byProvider[0]!.key, 'alpha');
    assert.equal(final.byProvider[0]!.value, 6, 'the endpoint snaps only to the exact known total');
    // One bucket carries only unknown-cost settlements and contributes no
    // fabricated value, so three bucket steps plus the trailing now point.
    assert.ok(stats.todayCostSeries.length >= 4);
  } finally {
    harness.service.dispose();
  }
});