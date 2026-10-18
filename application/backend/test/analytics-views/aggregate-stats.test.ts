import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCumulativeSeries } from '../../analytics-views/aggregate-stats';
import {
  EMPTY_PROVIDER_GATE_STATS,
  MAX_INTRADAY_CHART_POINTS,
  type AggregateSeriesSegment,
} from '../../../../analytics/contracts/aggregate-stats.js';
import type { CanonicalAnalyticsReadModel } from '../../../../analytics/queries/query-entry.js';
import type { ProviderAggregateReadModel } from '../../../../analytics/recording/sqlite-recorder.js';
import { AggregateStatsService } from '../../analytics-views/aggregate-stats-service.js';
import { createInitialArchState } from '../../conversation-state/arch-state.js';

function canonicalAggregate(): ProviderAggregateReadModel {
  const coverage = { occurrenceCount: 0, knownCount: 0, unknownCount: 0, knownTotal: '0', value: '0', complete: true };
  return {
    revision: '1',
    snapshotWatermark: '0',
    accounting: {
      revision: '1', invocationCount: 0,
      inputTokens: coverage, outputTokens: coverage,
      cacheReadTokens: coverage, cacheWriteTokens: coverage,
      reasoningTokens: coverage, providerTotalTokens: coverage,
      effectiveCostUsd: { ...coverage, reportedCount: 0, calculatedCount: 0 },
    },
    executionSummary: {
      revision: '1', scope: { kind: 'global' }, executionCount: 4,
      begunCount: 4, settledCount: 4, lifecycleCoverage: 'known',
      timingCoverage: 'known', deliveryCoverage: 'complete', latestSettled: null,
    },
    latestRun: null,
    groups: [],
    sessionCount: 2,
    truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
  };
}

function canonicalServiceHarness() {
  const archState = createInitialArchState();
  let readCalls = 0;
  let gateCalls = 0;
  let changed = 0;
  let readFails = false;
  const readModel = {
    readProviderAggregateSummary: async () => {
      readCalls += 1;
      if (readFails) throw new Error('canonical query unavailable');
      return canonicalAggregate();
    },
  } as unknown as CanonicalAnalyticsReadModel;
  let available = true;
  // Only canonical readers are allowed. Access to any retired history,
  // ledger, or transient-run source fails instead of supplying a fake owner.
  const statsService = new Proxy({}, {
    get: (_target, property) => {
      if (property === 'getAnalyticsReadModel') return () => available ? readModel : undefined;
      if (property === 'getAnalyticsRevisionRefreshStats') return () => ({ revision: '1' });
      throw new Error(`unexpected aggregate source: ${String(property)}`);
    },
  });
  const service = new AggregateStatsService({
    getArchState: () => archState,
    statsService: statsService as never,
    fetchProviderGateStats: async () => { gateCalls += 1; return EMPTY_PROVIDER_GATE_STATS; },
    onChanged: () => { changed += 1; },
    now: () => new Date('2026-07-04T12:00:00Z'),
  });
  return {
    service, archState,
    recompute: () => (service as unknown as { recompute(): Promise<void> }).recompute(),
    tick: () => (service as unknown as { tick(): Promise<void> }).tick(),
    setAvailable: (value: boolean) => { available = value; },
    setReadFails: (value: boolean) => { readFails = value; },
    counts: () => ({ readCalls, gateCalls, changed }),
  };
}

test('aggregate has no history fallback when the canonical reader is unavailable', async () => {
  const harness = canonicalServiceHarness();
  harness.setAvailable(false);
  harness.archState.sessions.runningSessionPaths.push('/live');
  await harness.recompute();
  const aggregate = harness.service.getAggregateStats();
  assert.equal(aggregate.ready, false, 'zero placeholders are unknown, not authoritative empty history');
  assert.equal(aggregate.runningSessionCount, 1);
  assert.equal(aggregate.billableAccounting, undefined);
  assert.deepEqual(harness.counts(), { readCalls: 0, gateCalls: 1, changed: 1 });
});

test('aggregate live refresh preserves canonical usage and only updates live counts', async () => {
  const harness = canonicalServiceHarness();
  await harness.recompute();
  const before = harness.service.getAggregateStats();
  assert.equal(before.ready, true);
  assert.equal(before.runCount, 4);
  assert.equal(before.sessionCount, 2);
  harness.archState.sessions.runningSessionPaths.push('/live', '/live');
  harness.archState.sessions.openTabPaths.push('/tab');
  harness.service.refreshLive();
  const after = harness.service.getAggregateStats();
  assert.equal(after.runningSessionCount, 1);
  assert.equal(after.openTabCount, 1);
  assert.equal(after.runCount, 4);
  assert.equal(after.todayCostSeries, before.todayCostSeries);
  assert.equal(after.costByProvider, before.costByProvider);
  assert.equal(after.billableAccounting, before.billableAccounting);
  assert.deepEqual(harness.counts(), { readCalls: 1, gateCalls: 1, changed: 2 });
  harness.service.refreshLive();
  assert.equal(harness.service.getAggregateStats(), after, 'equal live refresh retains the aggregate identity');
});

test('aggregate becomes unknown when its canonical reader is withheld', async () => {
  const harness = canonicalServiceHarness();
  await harness.recompute();
  harness.setAvailable(false);
  harness.service.refreshLive();
  assert.equal(harness.service.getAggregateStats().ready, false);
  assert.equal(harness.service.getAggregateStats().runCount, 0);
  assert.equal(harness.service.getAggregateStats().billableAccounting, undefined);
  assert.deepEqual(harness.counts(), { readCalls: 1, gateCalls: 1, changed: 2 });
});

test('an in-flight canonical read cannot publish after its reader is withheld', async () => {
  const harness = canonicalServiceHarness();
  await harness.recompute();
  const pending = harness.recompute();
  harness.setAvailable(false);
  await pending;
  assert.equal(harness.service.getAggregateStats().ready, false);
  assert.equal(harness.service.getAggregateStats().billableAccounting, undefined);
});

test('failed canonical reads publish unknown and the next tick can recover', async () => {
  const harness = canonicalServiceHarness();
  await harness.tick();
  assert.equal(harness.service.getAggregateStats().ready, true);
  harness.setReadFails(true);
  await harness.tick();
  assert.equal(harness.service.getAggregateStats().ready, false);
  assert.equal(harness.service.getAggregateStats().billableAccounting, undefined);
  harness.setReadFails(false);
  await harness.tick();
  assert.equal(harness.service.getAggregateStats().ready, true);
  assert.deepEqual(harness.counts(), { readCalls: 3, gateCalls: 3, changed: 3 });
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

test('buildCumulativeSeries: explicit projection timezone controls calendar buckets', () => {
  // Choose a projection zone that differs from the process zone so an
  // implementation that falls back to Date's local calendar fails this test.
  const processTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const projectionTimeZone = processTimeZone === 'America/Los_Angeles' ? 'UTC' : 'America/Los_Angeles';
  const first = Date.parse('2026-01-01T08:30:00Z');
  const second = Date.parse('2026-01-01T19:30:00Z');
  const third = Date.parse('2026-01-02T00:10:00Z');
  const fourth = Date.parse('2026-01-02T00:20:00Z');
  const now = Date.parse('2026-01-02T00:30:00Z');
  const series = buildCumulativeSeries([
    { ms: first, provider: 'openai', model: 'm', value: 1 },
    { ms: second, provider: 'openai', model: 'm', value: 1 },
    { ms: third, provider: 'openai', model: 'm', value: 1 },
    { ms: fourth, provider: 'openai', model: 'm', value: 1 },
  ], now, 3, { forceBucketing: true, timeZone: projectionTimeZone });
  if (projectionTimeZone === 'America/Los_Angeles') {
    assert.deepEqual(series.map((point) => point.ms), [first, third, now]);
    assert.deepEqual(series.map((point) => point.byProvider[0]?.value), [2, 4, 4]);
  } else {
    assert.deepEqual(series.map((point) => point.ms), [first, second, now]);
    assert.deepEqual(series.map((point) => point.byProvider[0]?.value), [1, 4, 4]);
  }
});

test('buildCumulativeSeries: default intraday cap preserves thousands of samples and provider-qualified models', () => {
  const startMs = Date.parse('2026-07-04T00:00:00Z');
  const now = Date.parse('2026-07-04T23:00:00Z');
  const samples = Array.from({ length: 2000 }, (_, i) => ({
    ms: startMs + i * 30_000,
    provider: i % 2 === 0 ? 'provider-a' : 'provider-b',
    model: 'shared-model',
    value: 1000,
  }));
  const series = buildCumulativeSeries(samples, now, undefined, { timeZone: 'UTC' });
  assert.ok(series.length <= MAX_INTRADAY_CHART_POINTS);
  assert.ok(series.length > 1);
  assert.equal(series.at(-1)!.ms, now);
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i - 1]!.ms <= series[i]!.ms);
  }
  const final = series.at(-1)!;
  assert.deepEqual(final.byProvider, [
    { key: 'provider-a', value: 1_000_000 },
    { key: 'provider-b', value: 1_000_000 },
  ]);
  assert.deepEqual(final.byModel, ['provider-a', 'provider-b'].map((provider) => ({
    key: 'shared-model', provider, model: 'shared-model', value: 1_000_000,
  })));
});

test('buildCumulativeSeries: repeated input usage makes distinct cumulative jumps with unchanged totals', () => {
  const first = Date.parse('2026-07-04T10:00:00Z');
  const second = Date.parse('2026-07-04T10:05:00Z');
  const now = Date.parse('2026-07-04T12:00:00Z');
  const series = buildCumulativeSeries([
    { ms: first, provider: 'openai', model: 'm', value: 100 },
    { ms: second, provider: 'openai', model: 'm', value: 200 },
  ], now, undefined, { timeZone: 'UTC' });
  assert.deepEqual(series.map((point) => point.ms), [first, second, now]);
  assert.deepEqual(series.map((point) => point.byProvider[0]!.value), [100, 300, 300]);
  assert.deepEqual(series.map((point) => point.byModel[0]!.value), [100, 300, 300]);
});

test('buildCumulativeSeries: rounded compacted and raw samples snap to exact canonical totals', () => {
  const startMs = Date.parse('2026-07-04T00:00:00Z');
  const now = Date.parse('2026-07-04T23:00:00Z');
  const samples = Array.from({ length: 2000 }, (_, i) => ({
    ms: startMs + i * 30_000, provider: 'openai', model: 'm', value: 0.000123456789123,
  }));
  const targetTotals = {
    byProvider: [{ key: 'openai', value: 0.246913578246 }],
    byModel: [{ key: 'm', provider: 'openai', model: 'm', value: 0.246913578246 }],
  };
  const options = { timeZone: 'UTC', forceBucketing: true, roundValues: true, targetTotals };
  const direct = buildCumulativeSeries(samples, now, 10, options);
  // Each group's per-bucket deltas can be reconstructed from its cumulative
  // series without relying on the retired completed/open accumulator pipeline.
  const compacted = [samples.slice(0, 500), samples.slice(500)].flatMap((group) => {
    const series = buildCumulativeSeries(group, now, 10, { timeZone: 'UTC', forceBucketing: true });
    return series.slice(0, -1).map((point, index) => ({
      ms: point.ms, provider: 'openai', model: 'm',
      value: point.byProvider[0]!.value - (series[index - 1]?.byProvider[0]!.value ?? 0),
    }));
  });
  assert.deepEqual(buildCumulativeSeries(compacted, now, 10, options), direct);
  assert.deepEqual(direct.at(-1)!.byProvider, targetTotals.byProvider);
  assert.deepEqual(direct.at(-1)!.byModel, targetTotals.byModel);
  for (const point of direct) {
    assert.equal(point.byProvider[0]!.value, point.byModel[0]!.value);
    assert.equal(point.byProvider[0]!.value, Math.round(point.byProvider[0]!.value * 1e12) / 1e12);
  }
});

for (const { day, start, middle, now } of [
  {
    day: 'spring-forward', start: '2026-03-08T05:00:00Z',
    middle: '2026-03-08T16:40:00Z', now: '2026-03-09T03:30:00Z',
  },
  {
    day: 'fall-back', start: '2026-11-01T04:00:00Z',
    middle: '2026-11-01T16:20:00Z', now: '2026-11-02T04:30:00Z',
  },
]) {
  test(`buildCumulativeSeries: ${day} uses the whole projection calendar day`, () => {
    const firstMs = Date.parse(start) + 30 * 60_000;
    const middleMs = Date.parse(middle);
    const nowMs = Date.parse(now);
    const series = buildCumulativeSeries([
      { ms: firstMs, provider: 'openai', model: 'm', value: 1 },
      { ms: middleMs, provider: 'openai', model: 'm', value: 2 },
    ], nowMs, 3, { timeZone: 'America/New_York', forceBucketing: true });
    // Spring's day lasts 23 hours, fall's 25: these samples fall on opposite
    // sides of the actual midpoint, unlike a fixed 24-hour grid.
    const expectedValues = day === 'spring-forward' ? [1, 3, 3] : [3, 3];
    assert.deepEqual(series.map((point) => point.byProvider[0]!.value), expectedValues);
    assert.equal(series.at(-1)!.ms, nowMs);
    assert.equal(series.at(-1)!.byModel[0]!.value, 3);
  });
}

test('buildCumulativeSeries: empty inputs and insufficient caps return no chart', () => {
  assert.deepEqual(buildCumulativeSeries([], 2000), []);
  const samples = [{ ms: 1000, provider: 'openai', model: 'm', value: 1 }];
  for (const cap of [0, 1]) assert.deepEqual(buildCumulativeSeries(samples, 2000, cap), []);
});

test('buildCumulativeSeries: identical instants merge and an existing now point is not duplicated', () => {
  const samples = [
    { ms: 1000, provider: 'openai', model: 'm', value: 1 },
    { ms: 1000, provider: 'openai', model: 'm', value: 2 },
  ];
  const series = buildCumulativeSeries(samples, 1000);
  assert.equal(series.length, 1);
  assert.equal(series[0]!.byProvider[0]!.value, 3);
  assert.equal(series[0]!.byModel[0]!.value, 3);
});
