import type { BillableInvocationRecord } from '../../shared/billable-invocation';
import type {
  AggregateDailyCost,
  AggregateModelSeriesSegment,
  AggregateProviderCost,
  AggregateSeriesPoint,
  AggregateSeriesSegment,
  AggregateStats,
} from '../../shared/protocol/aggregate-stats';
import { MAX_INTRADAY_CHART_POINTS } from '../stats-service/aggregate-stats';

interface UsageRow {
  record: BillableInvocationRecord;
  ms: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The immutable portion of an aggregate which is owned by the invocation
 * ledger. Live run counts, throughput, and productivity fields other than
 * input-token totals remain owned by the run analytics aggregate. */
export interface LedgerUsageOverlay {
  todayCost: number;
  todayCostByProvider: AggregateProviderCost[];
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCostSeries: AggregateSeriesPoint[];
  todayInputTokenSeries: AggregateSeriesPoint[];
  todayTokenSeries: AggregateSeriesPoint[];
  todayProductivityInputTokens: number;
  weekCost: number;
  weekCostByProvider: AggregateProviderCost[];
  weekCostSeries: AggregateSeriesPoint[];
  weekProductivityInputTokens: number;
  dailyCost: AggregateDailyCost[];
  totalCost: number;
  costByProvider: AggregateProviderCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  billableAccounting: NonNullable<AggregateStats['billableAccounting']>;
}

/** A ledger overlay plus the wall-clock interval for which its time-scoped
 * fields remain valid. The records array is the authority's immutable cache
 * identity; callers must still obtain it through the authority on each check. */
export interface LedgerUsageProjection {
  overlay: LedgerUsageOverlay;
  validFromMs: number;
  validUntilMs: number;
}

/** Build the ledger-owned aggregate fields without retaining a whole aggregate.
 * The returned validity interval ends at the next same-day invocation, so a
 * future-dated row becomes visible as soon as the clock crosses it. */
export function buildLedgerUsageProjection(
  records: readonly BillableInvocationRecord[],
  nowMs: number,
): LedgerUsageProjection {
  const rows = records.map(toUsageRow).filter((row): row is UsageRow => row !== null);
  const todayStart = localDayStart(nowMs);
  const weekStart = addLocalDays(todayStart, -6);
  const today = rows.filter((row) => row.ms >= todayStart && row.ms <= nowMs);
  const week = rows.filter((row) => row.ms >= weekStart && row.ms <= nowMs);
  const totals = providerTotals(rows);
  const todayTotals = providerTotals(today);
  const weekTotals = providerTotals(week);
  const todayInputTokens = sum(today, (row) => row.input);

  return {
    overlay: {
      todayCost: sum(today, (row) => row.cost),
      todayCostByProvider: todayTotals,
      todayInputTokens,
      todayOutputTokens: sum(today, (row) => row.output),
      todayCostSeries: cumulativeSeries(today, (row) => row.cost),
      todayInputTokenSeries: cumulativeSeries(today, (row) => row.input),
      todayTokenSeries: cumulativeSeries(today, (row) => row.output),
      todayProductivityInputTokens: todayInputTokens,
      weekCost: sum(week, (row) => row.cost),
      weekCostByProvider: weekTotals,
      weekCostSeries: cumulativeSeries(week, (row) => row.cost),
      weekProductivityInputTokens: sum(week, (row) => row.input),
      dailyCost: buildDailyCost(rows, todayStart, nowMs),
      totalCost: sum(rows, (row) => row.cost),
      costByProvider: totals,
      totalInputTokens: sum(rows, (row) => row.input),
      totalOutputTokens: sum(rows, (row) => row.output),
      totalCacheReadTokens: sum(rows, (row) => row.cacheRead),
      totalCacheWriteTokens: sum(rows, (row) => row.cacheWrite),
      billableAccounting: {
        invocationCount: records.length,
        todayUnknownInvocationCount: today.filter((row) => row.record.provenance === 'unknown').length,
        todayUnpricedInvocationCount: today.filter((row) => row.record.provenance === 'unpriced').length,
        todayInstrumentationGapInvocationCount: today.filter((row) => row.record.instrumentationGap).length,
        weekUnknownInvocationCount: week.filter((row) => row.record.provenance === 'unknown').length,
        weekUnpricedInvocationCount: week.filter((row) => row.record.provenance === 'unpriced').length,
        weekInstrumentationGapInvocationCount: week.filter((row) => row.record.instrumentationGap).length,
        unknownInvocationCount: records.filter((record) => record.provenance === 'unknown').length,
        unpricedInvocationCount: records.filter((record) => record.provenance === 'unpriced').length,
        instrumentationGapInvocationCount: records.filter((record) => record.instrumentationGap).length,
      },
    },
    ...projectionValidity(rows, nowMs),
  };
}

/** Apply only ledger-owned fields to a fresh legacy/live aggregate. This
 * deliberately does not retain or freeze the whole aggregate or its live
 * productivity/working-time fields. */
export function applyLedgerUsageOverlay(base: AggregateStats, overlay: LedgerUsageOverlay): AggregateStats {
  return {
    ...base,
    todayCost: overlay.todayCost,
    todayCostByProvider: overlay.todayCostByProvider,
    todayInputTokens: overlay.todayInputTokens,
    todayOutputTokens: overlay.todayOutputTokens,
    todayCostSeries: overlay.todayCostSeries,
    todayInputTokenSeries: overlay.todayInputTokenSeries,
    todayTokenSeries: overlay.todayTokenSeries,
    todayProductivity: {
      ...base.todayProductivity,
      inputTokens: overlay.todayProductivityInputTokens,
    },
    weekCost: overlay.weekCost,
    weekCostByProvider: overlay.weekCostByProvider,
    weekCostSeries: overlay.weekCostSeries,
    weekProductivity: {
      ...base.weekProductivity,
      inputTokens: overlay.weekProductivityInputTokens,
    },
    dailyCost: overlay.dailyCost,
    totalCost: overlay.totalCost,
    costByProvider: overlay.costByProvider,
    totalInputTokens: overlay.totalInputTokens,
    totalOutputTokens: overlay.totalOutputTokens,
    totalCacheReadTokens: overlay.totalCacheReadTokens,
    totalCacheWriteTokens: overlay.totalCacheWriteTokens,
    billableAccounting: overlay.billableAccounting,
  };
}

/** Replace every aggregate usage/cost field with one projection over the
 * immutable invocation ledger. Run analytics still owns run counts,
 * throughput, productivity, tools, and settlement/timing fields. */
export function projectLedgerUsageOntoAggregate(
  base: AggregateStats,
  records: readonly BillableInvocationRecord[],
  nowMs: number,
): AggregateStats {
  return applyLedgerUsageOverlay(base, buildLedgerUsageProjection(records, nowMs).overlay);
}

function toUsageRow(record: BillableInvocationRecord): UsageRow | null {
  const ms = Date.parse(record.endedAt);
  if (!Number.isFinite(ms)) return null;
  return {
    record,
    ms,
    cost: record.providerReportedCostUsd ?? record.pricing?.calculatedCostUsd ?? 0,
    input: record.inputTokens ?? 0,
    output: record.outputTokens ?? 0,
    cacheRead: record.cacheReadTokens ?? 0,
    cacheWrite: record.cacheWriteTokens ?? 0,
  };
}

function providerTotals(rows: readonly UsageRow[]): AggregateProviderCost[] {
  const grouped = new Map<string, AggregateProviderCost>();
  for (const row of rows) {
    const provider = row.record.provider || 'unknown';
    const current = grouped.get(provider) ?? {
      provider,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    current.cost += row.cost;
    current.inputTokens += row.input;
    current.outputTokens += row.output;
    current.cacheReadTokens += row.cacheRead;
    current.cacheWriteTokens += row.cacheWrite;
    grouped.set(provider, current);
  }
  return [...grouped.values()].sort((left, right) => right.cost - left.cost || left.provider.localeCompare(right.provider));
}

interface CumulativeDelta {
  ms: number;
  byProvider: Map<string, number>;
  byModel: Map<string, { provider: string; model: string; value: number }>;
}

function emptyCumulativeDelta(ms: number): CumulativeDelta {
  return { ms, byProvider: new Map(), byModel: new Map() };
}

function addCumulativeDelta(target: CumulativeDelta, row: UsageRow, amount: number): void {
  const provider = row.record.provider || 'unknown';
  const model = row.record.model || 'unknown';
  target.byProvider.set(provider, (target.byProvider.get(provider) ?? 0) + amount);
  const modelKey = `${provider}\0${model}`;
  const modelTotal = target.byModel.get(modelKey);
  if (modelTotal) modelTotal.value += amount;
  else target.byModel.set(modelKey, { provider, model, value: amount });
}

function mergeCumulativeDelta(target: CumulativeDelta, source: CumulativeDelta): void {
  // A bucket's cumulative value includes its last event, not its first.
  target.ms = Math.max(target.ms, source.ms);
  for (const [provider, value] of source.byProvider) {
    target.byProvider.set(provider, (target.byProvider.get(provider) ?? 0) + value);
  }
  for (const [key, sourceModel] of source.byModel) {
    const targetModel = target.byModel.get(key);
    if (targetModel) targetModel.value += sourceModel.value;
    else target.byModel.set(key, { ...sourceModel });
  }
}

/** Build chart points after raw rows have been reduced to at most 240 bucket
 * deltas. The unbucketed path intentionally retains the old one-row-per-point
 * semantics for small inputs; large ledgers never construct the old enormous
 * cumulative provider/model snapshots. */
function cumulativeSeries(rows: readonly UsageRow[], value: (row: UsageRow) => number): AggregateSeriesPoint[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((left, right) => left.ms - right.ms);
  let deltas: CumulativeDelta[];
  let bounded = false;
  if (sorted.length <= MAX_INTRADAY_CHART_POINTS) {
    deltas = sorted.map((row) => {
      const delta = emptyCumulativeDelta(row.ms);
      addCumulativeDelta(delta, row, value(row));
      return delta;
    });
  } else {
    bounded = true;
    const exact = new Map<number, CumulativeDelta>();
    for (const row of sorted) {
      let delta = exact.get(row.ms);
      if (!delta) {
        delta = emptyCumulativeDelta(row.ms);
        exact.set(row.ms, delta);
      }
      addCumulativeDelta(delta, row, value(row));
    }
    const exactDeltas = [...exact.values()];
    if (exactDeltas.length <= MAX_INTRADAY_CHART_POINTS) {
      deltas = exactDeltas;
    } else {
      const firstMs = exactDeltas[0]!.ms;
      const lastMs = exactDeltas.at(-1)!.ms;
      const duration = lastMs - firstMs;
      const uniform = new Map<number, CumulativeDelta>();
      for (const delta of exactDeltas) {
        const index = duration === 0
          ? 0
          : Math.min(
            MAX_INTRADAY_CHART_POINTS - 1,
            Math.floor(((delta.ms - firstMs) * MAX_INTRADAY_CHART_POINTS) / duration),
          );
        let bucket = uniform.get(index);
        if (!bucket) {
          bucket = emptyCumulativeDelta(delta.ms);
          uniform.set(index, bucket);
        }
        mergeCumulativeDelta(bucket, delta);
      }
      deltas = [...uniform.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, delta]) => delta);
    }
  }

  const providerTotals = new Map<string, number>();
  const modelTotals = new Map<string, { provider: string; model: string; value: number }>();
  const points: AggregateSeriesPoint[] = [];
  for (const delta of deltas) {
    for (const [provider, value] of delta.byProvider) {
      providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + value);
    }
    for (const [key, entry] of delta.byModel) {
      const current = modelTotals.get(key);
      if (current) current.value += entry.value;
      else modelTotals.set(key, { ...entry });
    }
    const byProvider: AggregateSeriesSegment[] = [...providerTotals.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
    const byModel: AggregateModelSeriesSegment[] = [...modelTotals.values()]
      .map((entry) => ({
        key: `${entry.provider}/${entry.model}`,
        provider: entry.provider,
        model: entry.model,
        value: entry.value,
      }))
      .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
    points.push({ ms: delta.ms, byProvider, byModel });
  }

  // Bucket accumulation can change floating-point addition order. Snap only
  // the bounded path's last point to the exact row-order totals so its chart
  // endpoint remains authoritative even when provider/model groups are large.
  if (bounded && points.length > 0) {
    const final = points[points.length - 1]!;
    const exactProviders = new Map<string, number>();
    const exactModels = new Map<string, { provider: string; model: string; value: number }>();
    for (const row of rows) {
      const amount = value(row);
      const provider = row.record.provider || 'unknown';
      const model = row.record.model || 'unknown';
      exactProviders.set(provider, (exactProviders.get(provider) ?? 0) + amount);
      const key = `${provider}\0${model}`;
      const modelTotal = exactModels.get(key);
      if (modelTotal) modelTotal.value += amount;
      else exactModels.set(key, { provider, model, value: amount });
    }
    final.byProvider = [...exactProviders.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
    final.byModel = [...exactModels.values()]
      .map((entry) => ({
        key: `${entry.provider}/${entry.model}`,
        provider: entry.provider,
        model: entry.model,
        value: entry.value,
      }))
      .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
  }
  return points;
}

function buildDailyCost(rows: readonly UsageRow[], todayStart: number, nowMs: number): AggregateDailyCost[] {
  const firstDay = addLocalDays(todayStart, -13);
  const days = new Map<string, UsageRow[]>();
  for (const row of rows) {
    if (row.ms < firstDay || row.ms >= addLocalDays(todayStart, 1) || row.ms > nowMs) continue;
    const key = localDate(row.ms);
    const day = days.get(key) ?? [];
    day.push(row);
    days.set(key, day);
  }
  const result: AggregateDailyCost[] = [];
  for (let offset = -13; offset <= 0; offset += 1) {
    const dayMs = addLocalDays(todayStart, offset);
    const date = localDate(dayMs);
    const dayRows = days.get(date) ?? [];
    const byModel = new Map<string, { provider: string; model: string; cost: number }>();
    for (const row of dayRows) {
      const provider = row.record.provider || 'unknown';
      const model = row.record.model || 'unknown';
      const key = `${provider}\0${model}`;
      const current = byModel.get(key) ?? { provider, model, cost: 0 };
      current.cost += row.cost;
      byModel.set(key, current);
    }
    result.push({
      date,
      totalCost: sum(dayRows, (row) => row.cost),
      byProvider: providerTotals(dayRows),
      byModel: [...byModel.values()].sort((left, right) => right.cost - left.cost),
    });
  }
  return result;
}

function sum(rows: readonly UsageRow[], value: (row: UsageRow) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}

function projectionValidity(rows: readonly UsageRow[], nowMs: number): Pick<LedgerUsageProjection, 'validFromMs' | 'validUntilMs'> {
  const todayStart = localDayStart(nowMs);
  const nextDay = addLocalDays(todayStart, 1);
  let validFromMs = todayStart;
  let validUntilMs = nextDay;
  for (const row of rows) {
    if (row.ms < todayStart || row.ms >= nextDay) continue;
    if (row.ms <= nowMs) validFromMs = Math.max(validFromMs, row.ms);
    else validUntilMs = Math.min(validUntilMs, row.ms);
  }
  return { validFromMs, validUntilMs };
}

function localDayStart(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addLocalDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
