/** Pure shared chart computation for canonical aggregate projections. */

import type {
  AggregateModelSeriesSegment,
  AggregateSeriesPoint,
  AggregateSeriesSegment,
} from '../../lib/protocol/index.js';
import { MAX_INTRADAY_CHART_POINTS } from '../../../analytics/contracts/aggregate-stats.js';
import {
  addLocalCalendarDaysMs,
  localCalendarDayKey,
  localCalendarDayStartMs,
} from '../../../analytics/projections/metrics.js';

function providerModelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** Round a cost value to a fixed number of decimal places for deterministic
 *  protocol-facing cumulative series output. Cost values are USD; 12 decimal
 *  places is well below any practical currency precision while eliminating
 *  order-of-addition ULP noise. */
function canonicalCostValue(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function sortSegmentsDesc(a: AggregateSeriesSegment, b: AggregateSeriesSegment): number {
  return b.value - a.value || a.key.localeCompare(b.key);
}

/** Internal bucket used while building a cumulative series. */
interface CumulativeBucket {
  ms: number;
  byProvider: Map<string, number>;
  byModel: Map<string, { provider: string; model: string; value: number }>;
}

/**
 * Group raw cumulative-series samples into a bounded number of time buckets.
 * Samples at the same instant are merged first; if there are still too many
 * distinct instants, uniform-width time buckets are used. Provider/model values
 * are summed within each bucket so cumulative totals stay exact.
 */
function buildCumulativeBuckets<T extends { ms: number; provider: string; model: string; value: number }>(
  samples: T[],
  maxSampleBuckets: number,
  fixedRange?: { startMs: number; endMs: number },
  forceBucketing = false,
): CumulativeBucket[] {
  if (samples.length === 0 || maxSampleBuckets <= 0) return [];

  const sorted = [...samples].sort((a, b) => a.ms - b.ms);

  // First collapse samples that land at the exact same millisecond so repeated
  // events at one instant do not consume multiple chart points.
  const exactBuckets = new Map<number, CumulativeBucket>();
  for (const s of sorted) {
    let b = exactBuckets.get(s.ms);
    if (!b) {
      b = { ms: s.ms, byProvider: new Map(), byModel: new Map() };
      exactBuckets.set(s.ms, b);
    }
    b.byProvider.set(s.provider, (b.byProvider.get(s.provider) ?? 0) + s.value);
    const pairKey = providerModelKey(s.provider, s.model);
    const pair = b.byModel.get(pairKey);
    if (pair) pair.value += s.value;
    else b.byModel.set(pairKey, { provider: s.provider, model: s.model, value: s.value });
  }

  const buckets = [...exactBuckets.values()].sort((a, b) => a.ms - b.ms);
  if (buckets.length <= maxSampleBuckets && !forceBucketing) return buckets;

  // Too many distinct instants: uniform-width time buckets across the full range.
  const firstMs = fixedRange?.startMs ?? buckets[0].ms;
  const lastMs = fixedRange?.endMs ?? buckets[buckets.length - 1].ms;
  const duration = lastMs - firstMs;
  if (duration === 0) {
    // Every sample is at the same instant; merge everything into one bucket.
    const merged: CumulativeBucket = {
      ms: firstMs,
      byProvider: new Map(),
      byModel: new Map(),
    };
    for (const b of buckets) {
      for (const [k, v] of b.byProvider) {
        merged.byProvider.set(k, (merged.byProvider.get(k) ?? 0) + v);
      }
      for (const [k, pair] of b.byModel) {
        const target = merged.byModel.get(k);
        if (target) target.value += pair.value;
        else merged.byModel.set(k, { ...pair });
      }
    }
    return [merged];
  }

  const uniform = new Map<number, CumulativeBucket>();
  for (const b of buckets) {
    const idx = Math.min(maxSampleBuckets - 1, Math.floor(((b.ms - firstMs) * maxSampleBuckets) / duration));
    let u = uniform.get(idx);
    if (!u) {
      u = { ms: b.ms, byProvider: new Map(), byModel: new Map() };
      uniform.set(idx, u);
    }
    for (const [k, v] of b.byProvider) {
      u.byProvider.set(k, (u.byProvider.get(k) ?? 0) + v);
    }
    for (const [k, pair] of b.byModel) {
      const target = u.byModel.get(k);
      if (target) target.value += pair.value;
      else u.byModel.set(k, { ...pair });
    }
  }
  return [...uniform.entries()].sort((a, b) => a[0] - b[0]).map(([_, b]) => b);
}

/** Build a cumulative stacked series (cost or tokens) from per-turn samples,
 *  pruned to [first sample, now] with a trailing "now" point so the area
 *  extends to the current moment. Each point carries cumulative per-provider
 *  and provider-qualified per-model breakdowns. Rendering interpolates these
 *  exact points with monotone, non-overshooting curves.
 *
 *  To keep the snapshot payload bounded, raw samples are accumulated into at
 *  most `maxPoints - 1` time buckets; one point is always reserved for the
 *  trailing "now" value. */
export function buildCumulativeSeries(
  samples: { ms: number; provider: string; model: string; value: number }[],
  nowMs: number,
  maxPoints: number = MAX_INTRADAY_CHART_POINTS,
  options: {
    /** IANA projection timezone used for calendar-day bucketing. */
    timeZone?: string;
    forceBucketing?: boolean;
    fixedRange?: { startMs: number; endMs: number };
    targetTotals?: { byProvider: AggregateSeriesSegment[]; byModel: AggregateModelSeriesSegment[] };
    roundValues?: boolean;
  } = {},
): AggregateSeriesPoint[] {
  if (samples.length === 0 || maxPoints < 2) return [];
  const forceBucketing = options.forceBucketing ?? false;
  const targetTotals = options.targetTotals;
  const roundValues = options.roundValues ?? false;
  // Callers without a projection zone retain the process-local calendar;
  // canonical callers always provide the explicit analytics IANA zone.
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayDate = localCalendarDayKey(nowMs, timeZone);
  const allToday = samples.every((sample) => localCalendarDayKey(sample.ms, timeZone) === todayDate);
  const dayStartMs = localCalendarDayStartMs(nowMs, timeZone);
  const nextDayMs = addLocalCalendarDaysMs(dayStartMs, 1, timeZone);
  // A stable whole-projection-day grid makes downsampling composable: separately
  // compacted sample groups produce the same buckets as a one-pass projection.
  const buckets = buildCumulativeBuckets(
    samples,
    maxPoints - 1,
    options.fixedRange
      ?? (allToday ? { startMs: dayStartMs, endMs: nextDayMs } : undefined),
    forceBucketing,
  );
  const byProvider = new Map<string, number>();
  const byModel = new Map<string, { provider: string; model: string; value: number }>();
  const providerSegments = (): AggregateSeriesSegment[] =>
    [...byProvider.entries()]
      .map(([key, value]) => ({ key, value: roundValues ? canonicalCostValue(value) : value }))
      .sort(sortSegmentsDesc);
  const modelSegments = (): AggregateModelSeriesSegment[] =>
    [...byModel.values()]
      .map((entry) => ({
        key: entry.model,
        provider: entry.provider,
        model: entry.model,
        value: roundValues ? canonicalCostValue(entry.value) : entry.value,
      }))
      .sort((a, b) => b.value - a.value
        || a.provider.localeCompare(b.provider)
        || a.model.localeCompare(b.model));
  const points: AggregateSeriesPoint[] = [];
  for (const b of buckets) {
    for (const [provider, value] of b.byProvider) {
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + value);
    }
    for (const [key, entry] of b.byModel) {
      const current = byModel.get(key);
      if (current) current.value += entry.value;
      else byModel.set(key, { ...entry });
    }
    points.push({ ms: b.ms, byProvider: providerSegments(), byModel: modelSegments() });
  }
  // Trailing "now" point (current cumulative) so the chart extends to now.
  const last = points[points.length - 1]!;
  if (last.ms < nowMs) {
    points.push({ ms: nowMs, byProvider: providerSegments(), byModel: modelSegments() });
  }
  // Snap the final cumulative point to the canonical aggregate totals so the
  // chart's top-right value always matches the aggregate cost total and is
  // independent of sample compaction.
  if (targetTotals && points.length > 0) {
    const final = points[points.length - 1]!;
    final.byProvider = targetTotals.byProvider;
    final.byModel = targetTotals.byModel;
  }
  return points;
}
