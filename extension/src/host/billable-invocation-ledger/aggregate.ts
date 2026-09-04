import type { BillableInvocationRecord } from '../../shared/billable-invocation';
import type {
  AggregateDailyCost,
  AggregateProviderCost,
  AggregateSeriesPoint,
  AggregateStats,
} from '../../shared/protocol/aggregate-stats';

interface UsageRow {
  record: BillableInvocationRecord;
  ms: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Replace every aggregate usage/cost field with one projection over the
 * immutable invocation ledger. Run analytics still owns run counts,
 * throughput, productivity, tools, and settlement/timing fields. */
export function projectLedgerUsageOntoAggregate(
  base: AggregateStats,
  records: readonly BillableInvocationRecord[],
  nowMs: number,
): AggregateStats {
  const rows = records.map(toUsageRow).filter((row): row is UsageRow => row !== null);
  const todayStart = localDayStart(nowMs);
  const weekStart = addLocalDays(todayStart, -6);
  const today = rows.filter((row) => row.ms >= todayStart && row.ms <= nowMs);
  const week = rows.filter((row) => row.ms >= weekStart && row.ms <= nowMs);
  const totals = providerTotals(rows);
  const todayTotals = providerTotals(today);
  const weekTotals = providerTotals(week);
  const dailyCost = buildDailyCost(rows, todayStart);

  return {
    ...base,
    todayCost: sum(today, (row) => row.cost),
    todayCostByProvider: todayTotals,
    todayInputTokens: sum(today, (row) => row.input),
    todayOutputTokens: sum(today, (row) => row.output),
    todayCostSeries: cumulativeSeries(today, (row) => row.cost),
    todayInputTokenSeries: cumulativeSeries(today, (row) => row.input),
    todayTokenSeries: cumulativeSeries(today, (row) => row.output),
    todayProductivity: {
      ...base.todayProductivity,
      inputTokens: sum(today, (row) => row.input),
    },
    weekCost: sum(week, (row) => row.cost),
    weekCostByProvider: weekTotals,
    weekCostSeries: cumulativeSeries(week, (row) => row.cost),
    weekProductivity: {
      ...base.weekProductivity,
      inputTokens: sum(week, (row) => row.input),
    },
    dailyCost,
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
  };
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

function cumulativeSeries(rows: readonly UsageRow[], value: (row: UsageRow) => number): AggregateSeriesPoint[] {
  const sorted = [...rows].sort((left, right) => left.ms - right.ms);
  const providerTotals = new Map<string, number>();
  const modelTotals = new Map<string, { provider: string; model: string; value: number }>();
  const points: AggregateSeriesPoint[] = [];
  for (const row of sorted) {
    const amount = value(row);
    const provider = row.record.provider || 'unknown';
    const model = row.record.model || 'unknown';
    providerTotals.set(provider, (providerTotals.get(provider) ?? 0) + amount);
    const modelKey = `${provider}\0${model}`;
    const modelTotal = modelTotals.get(modelKey) ?? { provider, model, value: 0 };
    modelTotal.value += amount;
    modelTotals.set(modelKey, modelTotal);
    points.push({
      ms: row.ms,
      byProvider: [...providerTotals].map(([key, accumulated]) => ({ key, value: accumulated }))
        .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key)),
      byModel: [...modelTotals.values()].map((entry) => ({
        key: `${entry.provider}/${entry.model}`,
        provider: entry.provider,
        model: entry.model,
        value: entry.value,
      })).sort((left, right) => right.value - left.value || left.key.localeCompare(right.key)),
    });
  }
  return points;
}

function buildDailyCost(rows: readonly UsageRow[], todayStart: number): AggregateDailyCost[] {
  const firstDay = addLocalDays(todayStart, -13);
  const days = new Map<string, UsageRow[]>();
  for (const row of rows) {
    if (row.ms < firstDay || row.ms >= addLocalDays(todayStart, 1)) continue;
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
