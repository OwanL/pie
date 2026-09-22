import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

function observation(options: {
  sourceKey: string;
  rootSessionId?: string;
  invocationId?: string;
  executionId?: string;
  generationId?: string;
  fields?: Record<string, unknown>;
}): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-1',
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: options.invocationId ? 'providerCall' : 'execution',
    entityKey: options.invocationId ?? options.sourceKey,
    observationKind: options.invocationId ? 'providerSettlement' : 'end',
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-a',
      rootSessionId,
      invocationId: options.invocationId,
      ...(options.executionId ? { executionId: options.executionId } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: options.fields ?? { outcome: 'success' },
  } as unknown as AnalyticsObservation;
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-cost-buckets-'));
  return { root, databasePath: path.join(root, 'analytics.sqlite') };
}

interface PlannedSettlement {
  provider: string;
  model: string;
  atMs: number;
  cost: number | null;
}

/** Submit one settlement per planned row and return the exact known totals. */
function submitSettlements(
  recorder: SqliteAnalyticsRecorder,
  planned: PlannedSettlement[],
): { knownCostByProvider: Map<string, number>; knownTotal: number; unknownCount: number } {
  const knownCostByProvider = new Map<string, number>();
  let knownTotal = 0;
  let unknownCount = 0;
  const observations: AnalyticsObservation[] = [];
  planned.forEach((entry, index) => {
    const invocationId = `invocation-${index}`;
    if (entry.cost === null) unknownCount += 1;
    else {
      knownCostByProvider.set(entry.provider, (knownCostByProvider.get(entry.provider) ?? 0) + entry.cost);
      knownTotal += entry.cost;
    }
    observations.push(observation({
      sourceKey: `${invocationId}-settlement`,
      invocationId,
      executionId: `execution-${index}`,
      fields: {
        invocationId,
        provider: entry.provider,
        dispatchedModel: entry.model,
        purpose: 'conversation',
        outcome: 'success',
        settledAtMs: entry.atMs,
        inputTokens: 1,
        outputTokens: 1,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: true,
        ...(entry.cost === null ? {} : { reportedCostUsd: entry.cost }),
        ...(entry.cost === null ? {} : { coverage: 'known' }),
      },
    }));
  });
  recorder.submitBatch(observations);
  return { knownCostByProvider, knownTotal, unknownCount };
}

function bucketTotals(buckets: Array<{ provider: string | null; cost: number | null }>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    if (bucket.cost === null) continue;
    const provider = bucket.provider ?? 'unknown';
    totals.set(provider, (totals.get(provider) ?? 0) + bucket.cost);
  }
  return totals;
}

test('cost buckets stay exact over every settlement when raw samples exceed 4096', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const dayStart = Date.UTC(2026, 0, 1);
  const dayEnd = dayStart + 86_400_000;
  // 4 200 settlements across ~2.5 hours, two providers with two models each,
  // and a deterministic unknown-cost (unpriced/unknown) subset.
  const planned: PlannedSettlement[] = [];
  for (let index = 0; index < 4_200; index += 1) {
    planned.push({
      provider: index % 2 === 0 ? 'alpha' : 'beta',
      model: index % 4 < 2 ? 'm1' : 'm2',
      atMs: dayStart + index * 2_100 + 1,
      cost: index % 13 === 0 ? null : index % 2 === 0 ? 1.25 : 2.5,
    });
  }
  try {
    recorder.prepareProviderDailyProjection('UTC', dayStart, dayEnd);
    const expected = submitSettlements(recorder, planned);

    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: dayStart,
      todayEndMs: dayEnd,
      weekStartMs: dayStart,
      weekEndMs: dayEnd,
      timeZone: 'UTC',
      dailyWindowStartMs: dayStart,
      dailyWindowEndMs: dayEnd,
    });
    const series = aggregate.series!;
    // Raw sample evidence is bounded as before ...
    assert.equal(series.truncated, true);
    assert.equal(series.settlementTruncated, true);
    assert.equal(series.settlements.length, 4_096);
    // ... but execution evidence is independent and cost buckets are a full
    // aggregation, so they are never truncated by the sample cap.
    assert.equal(series.executionTruncated, false);
    assert.equal(series.executions.length, 0);
    assert.equal(series.todayCostBucketsTruncated, false);
    assert.equal(series.weekCostBucketsTruncated, false);

    const todayBuckets = series.todayCostBuckets!;
    const weekBuckets = series.weekCostBuckets!;
    // Today aggregates at minute width: one bucket per occupied minute per
    // (provider, model) tuple; every settlement falls in [dayStart, dayEnd).
    // The week range keeps hourly width and aggregates the same settlements.
    const distinctMinutes = new Set(planned.map((_, index) => Math.floor((index * 2_100 + 1) / 60_000)));
    const distinctHours = new Set(planned.map((_, index) => Math.floor((index * 2_100 + 1) / 3_600_000)));
    const distinctPairs = new Set(planned.map((entry) => `${entry.provider}\u0000${entry.model}`));
    assert.equal(todayBuckets.length, distinctMinutes.size * distinctPairs.size);
    assert.equal(weekBuckets.length, distinctHours.size * distinctPairs.size);
    for (const bucket of todayBuckets) {
      assert.ok(Number(bucket.ms) >= dayStart && Number(bucket.ms) < dayEnd);
      assert.equal((Number(bucket.ms) - dayStart) % 60_000, 0, 'today buckets align to minute width');
    }
    for (const bucket of weekBuckets) {
      assert.equal((Number(bucket.ms) - dayStart) % 3_600_000, 0, 'week buckets stay hour-aligned');
    }
    // Exact per-provider totals and endpoint coverage over all 4 200 rows.
    assert.deepEqual(bucketTotals(todayBuckets), expected.knownCostByProvider);
    assert.equal(
      todayBuckets.reduce((total, bucket) => total + (bucket.cost ?? 0), 0),
      expected.knownTotal,
    );
    assert.deepEqual(bucketTotals(weekBuckets), expected.knownCostByProvider);
    // Known/unknown distinction survives aggregation.
    assert.equal(
      todayBuckets.reduce((total, bucket) => total + Number(bucket.unknownCostCount), 0),
      expected.unknownCount,
    );
    // Unknown-cost settlements never fabricate cost: bucket cost is null or a
    // positive known total. (The unknown-only bucket case is covered by the
    // local-calendar-boundary test below.)
    for (const bucket of todayBuckets) {
      assert.ok(bucket.cost === null || bucket.cost > 0);
    }
    // The exact endpoints tie to the maintained accounting projection.
    assert.equal(
      Number(aggregate.accounting.effectiveCostUsd.knownTotal),
      expected.knownTotal,
    );
    assert.equal(
      aggregate.series?.dailyCosts?.reduce((total, day) => total + day.totalCost, 0),
      expected.knownTotal,
    );
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('today cost buckets respect exact local calendar boundaries against the week range', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  // A half-hour zone offset (e.g. Asia/Kolkata): the local calendar boundary is
  // NOT an epoch-hour boundary, so the week's hourly buckets still straddle
  // it. At minute width a boundary can never straddle a bucket (every zone
  // offset is a whole number of minutes), and the exact settlement-time
  // predicate remains the boundary authority either way: bucket sums must
  // still cover exactly the settlements inside the boundary.
  const todayStart = Date.UTC(2026, 0, 1) + 1_800_000;
  const weekStart = todayStart - 86_400_000;
  const weekEnd = todayStart + 86_400_000;
    const oneHour = 3_600_000;
    const planned: PlannedSettlement[] = [
      // Before the local calendar boundary, inside the same epoch-hour bucket
      // as today's first settlements for the week's hourly aggregation. At
      // minute width no today bucket predates the boundary, so exclusion is
      // proven by the exact settlement-time predicate itself.
      { provider: 'alpha', model: 'm1', atMs: todayStart - 1_200_000, cost: 5 },
      // Yesterday, hours before the boundary.
      { provider: 'beta', model: 'm1', atMs: weekStart + oneHour + 500, cost: 3 },
      // Today: mixed providers plus an unknown-cost settlement.
      { provider: 'alpha', model: 'm1', atMs: todayStart + 500, cost: 1.5 },
      { provider: 'alpha', model: 'm2', atMs: todayStart + oneHour + 500, cost: 0.25 },
      { provider: 'beta', model: 'm2', atMs: todayStart + 2 * oneHour + 500, cost: null },
    ];
  try {
    recorder.prepareProviderDailyProjection('UTC', weekStart, weekEnd);
    const expected = submitSettlements(recorder, planned);

    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: todayStart,
      todayEndMs: weekEnd,
      weekStartMs: weekStart,
      weekEndMs: weekEnd,
      timeZone: 'UTC',
      dailyWindowStartMs: weekStart,
      dailyWindowEndMs: weekEnd,
    });
    const series = aggregate.series!;
    const todayBuckets = series.todayCostBuckets!;
    const weekBuckets = series.weekCostBuckets!;
    // Today spans exactly three occupied minute buckets. Minute width can
    // never straddle a minute-granular calendar boundary; the exact
    // settlement-time predicate remains the boundary authority and excludes
    // the pre-boundary settlement from today regardless.
    assert.equal(new Set(todayBuckets.map((bucket) => String(bucket.ms))).size, 3);
    for (const bucket of todayBuckets) {
      assert.equal(Number(bucket.ms) % 60_000, 0, 'today bucket keys are minute-aligned');
    }
    const todayTotals = bucketTotals(todayBuckets);
    const todayPlanned = planned.slice(2);
    // The pre-boundary settlement sharing the first bucket is excluded from
    // today even though its bucket also holds in-range settlements.
    assert.equal(todayTotals.get('alpha'), todayPlanned[0]!.cost! + todayPlanned[1]!.cost!);
    assert.equal(todayTotals.has('beta'), false, 'unknown-cost settlements contribute no known cost');
    assert.equal(
      todayBuckets.reduce((total, bucket) => total + Number(bucket.unknownCostCount), 0),
      1,
      'the unknown-cost settlement stays explicitly counted',
    );
    // An unknown-cost-only bucket survives aggregation with cost null rather
    // than being silently dropped.
    assert.ok(todayBuckets.some((bucket) =>
      bucket.provider === 'beta' && bucket.model === 'm2' && bucket.cost === null,
    ));
    // Week totals still include the pre-boundary settlements.
    const weekTotals = bucketTotals(weekBuckets);
    assert.equal(weekTotals.get('alpha'), expected.knownCostByProvider.get('alpha'));
    assert.equal(weekTotals.get('beta'), expected.knownCostByProvider.get('beta'));
    assert.ok(weekTotals.get('alpha')! > todayTotals.get('alpha')!, 'the pre-boundary cost stays week-visible only');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('minute today stays complete where the hourly week range truncates', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const windowStart = Date.UTC(2026, 0, 1);
  // One settlement per hour across more than 4 096 distinct buckets, all for a
  // single provider/model pair. Each settlement occupies one distinct minute
  // bucket and one distinct hour bucket, so the emitted row count alone
  // decides both per-range caps.
  const planned: PlannedSettlement[] = [];
  for (let index = 0; index < 4_100; index += 1) {
    planned.push({
      provider: 'solo',
      model: 'm',
      atMs: windowStart + index * 3_600_000 + 1_000,
      cost: 1,
    });
  }
  try {
    const expected = submitSettlements(recorder, planned);
    recorder.prepareProviderDailyProjection('UTC', windowStart, windowStart + planned.length * 3_600_000);
    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: windowStart,
      todayEndMs: windowStart + planned.length * 3_600_000,
      weekStartMs: windowStart,
      weekEndMs: windowStart + planned.length * 3_600_000,
      timeZone: 'UTC',
      dailyWindowStartMs: windowStart,
      dailyWindowEndMs: windowStart + planned.length * 3_600_000,
    });
    const series = aggregate.series!;
    // Same range, two per-range outcomes: the hourly week just passes its
    // 4 096-row cap and truncates, while the minute-width today (4 100 rows,
    // one per occupied minute) stays far under its 15 000-row cap and
    // remains a complete aggregation.
    assert.equal(series.weekCostBucketsTruncated, true);
    assert.equal(series.weekCostBuckets!.length, 4_096);
    assert.equal(
      Number(series.weekCostBuckets![0]!.ms),
      windowStart + (planned.length - 4_096) * 3_600_000,
      'newest hourly buckets are retained when the week range exceeds its cap',
    );
    assert.ok(
      series.weekCostBuckets!.reduce((total, bucket) => total + (bucket.cost ?? 0), 0)
        < expected.knownTotal,
      'truncated buckets must not silently reach the exact total',
    );
    assert.equal(series.todayCostBucketsTruncated, false);
    assert.equal(series.todayCostBuckets!.length, planned.length);
    assert.deepEqual(bucketTotals(series.todayCostBuckets!), expected.knownCostByProvider);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('minute today truncates at its own emitted-row cap instead of partial coverage', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const windowStart = Date.UTC(2026, 0, 1);
  // Four provider/model pairs, one settlement per pair per minute across
  // 3 800 minutes: 15 200 emitted minute/provider rows, past the today cap.
  const planned: PlannedSettlement[] = [];
  for (let minute = 0; minute < 3_800; minute += 1) {
    for (let pair = 0; pair < 4; pair += 1) {
      planned.push({
        provider: pair % 2 === 0 ? 'alpha' : 'beta',
        model: `m${pair}`,
        atMs: windowStart + minute * 60_000 + pair * 1_000 + 1,
        cost: 1,
      });
    }
  }
  try {
    const expected = submitSettlements(recorder, planned);
    recorder.prepareProviderDailyProjection('UTC', windowStart, windowStart + 3_800 * 60_000);
    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: windowStart,
      todayEndMs: windowStart + 3_800 * 60_000,
      weekStartMs: windowStart,
      weekEndMs: windowStart + 3_800 * 60_000,
      timeZone: 'UTC',
      dailyWindowStartMs: windowStart,
      dailyWindowEndMs: windowStart + 3_800 * 60_000,
    });
    const series = aggregate.series!;
    assert.equal(series.todayCostBucketsTruncated, true);
    assert.equal(series.todayCostBuckets!.length, 15_000);
    // Newest minute buckets are retained (current view stays useful);
    // consumers must still fall back to exact daily rollups rather than chart
    // a partial cumulative stream.
    assert.equal(
      Number(series.todayCostBuckets![0]!.ms),
      windowStart + (3_800 - 15_000 / 4) * 60_000,
    );
    assert.ok(
      series.todayCostBuckets!.reduce((total, bucket) => total + (bucket.cost ?? 0), 0)
        < expected.knownTotal,
    );
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

/** The previous single 4 096-row cap made minute resolution truncate — and
 * revert the chart to the daily diagonal — for even a modest provider count.
 * This regression keeps a complete minute-resolution today untruncated when
 * the emitted minute/provider rows exceed that old cap: 1 100 occupied
 * minutes × 4 grouped provider/model pairs = 4 400 rows. The week range
 * keeps its existing hourly width and behavior. */
test('today minute buckets stay complete past the previous 4 096-row cap; week stays hourly', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const dayStart = Date.UTC(2026, 0, 1);
  const dayEnd = dayStart + 86_400_000;
  const minutePairs: Array<{ provider: string; model: string }> = [
    { provider: 'alpha', model: 'm1' },
    { provider: 'alpha', model: 'm2' },
    { provider: 'beta', model: 'm1' },
    { provider: 'beta', model: 'm2' },
  ];
  const planned: PlannedSettlement[] = [];
  for (let minute = 0; minute < 1_100; minute += 1) {
    for (const [pairIndex, pair] of minutePairs.entries()) {
      const index = minute * minutePairs.length + pairIndex;
      planned.push({
        provider: pair.provider,
        model: pair.model,
        atMs: dayStart + minute * 60_000 + pairIndex * 1_000 + 1,
        cost: index % 17 === 0 ? null : index % 3 === 0 ? 0.5 : 1.25,
      });
    }
  }
  try {
    recorder.prepareProviderDailyProjection('UTC', dayStart, dayEnd);
    const expected = submitSettlements(recorder, planned);

    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: dayStart,
      todayEndMs: dayEnd,
      weekStartMs: dayStart - 3_600_000,
      weekEndMs: dayEnd + 3_600_000,
      timeZone: 'UTC',
      dailyWindowStartMs: dayStart,
      dailyWindowEndMs: dayEnd,
    });
    const series = aggregate.series!;
    const expectedTodayRows = 1_100 * minutePairs.length;
    // The emitted minute/provider bucket rows exceed the previous single cap:
    // under it, today would have been marked truncated and the chart reverted
    // to the daily diagonal even though coverage was complete.
    assert.ok(expectedTodayRows > 4_096, 'regression precondition: rows exceed the previous cap');
    assert.equal(series.todayCostBucketsTruncated, false);
    assert.equal(series.todayCostBuckets!.length, expectedTodayRows);
    for (const bucket of series.todayCostBuckets!) {
      assert.ok(Number(bucket.ms) >= dayStart && Number(bucket.ms) < dayEnd);
      assert.equal(Number(bucket.ms) % 60_000, 0, 'today buckets are minute-aligned');
    }
    // Exact totals and unknown coverage over every settlement survive at
    // minute resolution.
    assert.deepEqual(bucketTotals(series.todayCostBuckets!), expected.knownCostByProvider);
    assert.equal(
      series.todayCostBuckets!.reduce((total, bucket) => total + (bucket.cost ?? 0), 0),
      expected.knownTotal,
    );
    assert.equal(
      series.todayCostBuckets!.reduce((total, bucket) => total + Number(bucket.unknownCostCount), 0),
      expected.unknownCount,
    );
    assert.equal(
      Number(aggregate.accounting.effectiveCostUsd.knownTotal),
      expected.knownTotal,
    );
    assert.equal(
      aggregate.series?.dailyCosts?.reduce((total, day) => total + day.totalCost, 0),
      expected.knownTotal,
    );
    // The week range keeps its existing hourly width and per-range behavior:
    // hour-aligned buckets, complete under the original hourly cap.
    assert.equal(series.weekCostBucketsTruncated, false);
    const weekRows = new Set(planned.map((entry) =>
      `${Math.floor(entry.atMs / 3_600_000)}\u0000${entry.provider}\u0000${entry.model}`,
    )).size;
    assert.equal(series.weekCostBuckets!.length, weekRows);
    for (const bucket of series.weekCostBuckets!) {
      assert.equal(Number(bucket.ms) % 3_600_000, 0, 'week buckets stay hour-aligned');
    }
    assert.deepEqual(bucketTotals(series.weekCostBuckets!), expected.knownCostByProvider);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});