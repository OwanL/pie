import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  categoricalHeight,
  estimatedRunCostUsd,
  median,
  modelFamilyKey,
} from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

export interface CostByModelRow {
  model: string;
  /** Sum of priced run costs for the model (equals the sum of per-session subtotals). */
  totalCostUsd: number;
  /** Median cost across priced runs. */
  medianCostUsdPerRun: number;
  /** Mean cost per session — each session's run costs are summed first, then averaged across sessions. */
  avgCostUsdPerSession: number;
  /** Median cost per session (same per-session rollup as `avgCostUsdPerSession`). */
  medianCostUsdPerSession: number;
  runCount: number;
  withCostCount: number;
  /** Distinct sessions with ≥1 priced run for this model. */
  sessionCount: number;
}

interface CostTrendRow {
  day: string;
  totalCostUsd: number;
  runCount: number;
}

/**
 * Per-model cost rollup. A *session* (one `sessionPathHash`) may contain
 * multiple runs, so "average spend per model per session" requires summing run
 * costs within each session first, then averaging across sessions — distinct
 * from the per-run mean/median. The internal cohort retains unpriced models for
 * coverage accounting; spend-ranking exports filter them by `withCostCount`.
 * Reported free/local usage is priced at `$0` and therefore remains eligible.
 */
function costByModelCohortRows(runs: PreparedRunRow[]): CostByModelRow[] {
  const perModel = new Map<string, {
    perRunCosts: number[];
    runCount: number;
    /** sessionPathHash → summed run cost for that session (priced runs only). */
    sessionSubtotals: Map<string, number>;
  }>();
  for (const run of runs) {
    if (run.status === 'open') {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = perModel.get(model) ?? { perRunCosts: [], runCount: 0, sessionSubtotals: new Map<string, number>() };
    entry.runCount += 1;
    const cost = estimatedRunCostUsd(run);
    if (cost !== null) {
      entry.perRunCosts.push(cost);
      const prev = entry.sessionSubtotals.get(run.sessionPathHash) ?? 0;
      entry.sessionSubtotals.set(run.sessionPathHash, prev + cost);
    }
    perModel.set(model, entry);
  }
  return [...perModel.entries()].map(([model, e]) => {
    const subtotals = [...e.sessionSubtotals.values()];
    const total = subtotals.reduce((sum, value) => sum + value, 0);
    return {
      model,
      totalCostUsd: Math.round(total * 10000) / 10000,
      medianCostUsdPerRun: median(e.perRunCosts) ?? 0,
      avgCostUsdPerSession: subtotals.length === 0 ? 0 : Math.round((total / subtotals.length) * 10000) / 10000,
      medianCostUsdPerSession: median(subtotals) ?? 0,
      runCount: e.runCount,
      withCostCount: e.perRunCosts.length,
      sessionCount: subtotals.length,
    };
  });
}

/** Top model families by total estimated spend. */
export function groupCostByModel(runs: PreparedRunRow[]): CostByModelRow[] {
  return costByModelCohortRows(runs)
    .filter((row) => row.withCostCount > 0)
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 12);
}

/** Independently ranked top model families by average estimated spend per session. */
export function groupCostPerSessionByModel(runs: PreparedRunRow[]): CostByModelRow[] {
  return costByModelCohortRows(runs)
    .filter((row) => row.sessionCount > 0)
    .sort((a, b) => b.avgCostUsdPerSession - a.avgCostUsdPerSession)
    .slice(0, 12);
}

function costTrendRows(runs: PreparedRunRow[]): CostTrendRow[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const run of runs) {
    const cost = estimatedRunCostUsd(run);
    if (run.status === 'open' || cost === null) {
      continue;
    }
    const day = run.startedDay;
    const entry = map.get(day) ?? { total: 0, count: 0 };
    entry.total += cost;
    entry.count += 1;
    map.set(day, entry);
  }
  return [...map.entries()]
    .map(([day, e]) => ({ day, totalCostUsd: Math.round(e.total * 10000) / 10000, runCount: e.count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

interface CostTrendByProviderRow {
  day: string;
  provider: string;
  totalCostUsd: number;
  runCount: number;
}

/** Max providers drawn as their own series; the long tail folds into 'Other' to keep the legend readable. */
const COST_TREND_BY_PROVIDER_TOP_N = 8;

/**
 * Daily estimated cost broken down by provider — one row per (day, provider)
 * with priced, non-open runs. Providers are ranked by total spend across the
 * filtered window; the long tail beyond the top {@link COST_TREND_BY_PROVIDER_TOP_N}
 * is folded into an 'Other' bucket so every day's spend stays representable
 * without drowning the legend in one-off providers. Missing (day, provider)
 * combinations are imputed to `$0` so each series is a continuous line, and the
 * rendered line uses monotone interpolation to round the corners between days.
 * Mirrors {@link costTrendRows}'s open-run / unpriced-run exclusion.
 */
export function costTrendByProviderRows(runs: PreparedRunRow[]): CostTrendByProviderRow[] {
  const totalsByProvider = new Map<string, number>();
  const byDayProvider = new Map<string, Map<string, { total: number; count: number }>>();

  for (const run of runs) {
    const cost = estimatedRunCostUsd(run);
    if (run.status === 'open' || cost === null) {
      continue;
    }
    const provider = run.provider?.trim() || '(unknown)';
    totalsByProvider.set(provider, (totalsByProvider.get(provider) ?? 0) + cost);

    const dayMap = byDayProvider.get(run.startedDay) ?? new Map<string, { total: number; count: number }>();
    const entry = dayMap.get(provider) ?? { total: 0, count: 0 };
    entry.total += cost;
    entry.count += 1;
    dayMap.set(provider, entry);
    byDayProvider.set(run.startedDay, dayMap);
  }

  const keep = new Set(
    [...totalsByProvider.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, COST_TREND_BY_PROVIDER_TOP_N)
      .map(([name]) => name),
  );

  const hasOther = totalsByProvider.size > keep.size;
  const outputProviders = [...keep];
  if (hasOther) {
    outputProviders.push('Other');
  }

  const days = [...byDayProvider.keys()].sort();
  const rows: CostTrendByProviderRow[] = [];
  for (const day of days) {
    const dayMap = byDayProvider.get(day)!;
    let otherTotal = 0;
    let otherCount = 0;
    for (const [provider, e] of dayMap) {
      if (!keep.has(provider)) {
        otherTotal += e.total;
        otherCount += e.count;
      }
    }
    for (const provider of outputProviders) {
      if (provider === 'Other') {
        rows.push({ day, provider, totalCostUsd: Math.round(otherTotal * 10000) / 10000, runCount: otherCount });
      } else {
        const e = dayMap.get(provider);
        rows.push({
          day,
          provider,
          totalCostUsd: Math.round((e?.total ?? 0) * 10000) / 10000,
          runCount: e?.count ?? 0,
        });
      }
    }
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider));
}

export const costCharts: ChartEntry[] = [
  {
    id: 'chart-cost-by-model',
    render: async (ctx: ChartContext) => {
      const cohort = costByModelCohortRows(ctx.runs).filter((row) => row.withCostCount > 0);
      const rows = groupCostByModel(ctx.runs);
      const total = cohort.reduce((sum, row) => sum + row.totalCostUsd, 0);
      ctx.setNote('cost-by-model-note', `Top ${rows.length} of ${cohort.length} model families with priced runs by spend; full priced-cohort total $${Math.round(total * 100) / 100}. Reported free usage remains priced at $0; models with no priced rows are omitted.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
            encoding: {
              y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
              x: { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total estimated cost (USD)', axis: { format: '$.2f' } },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total cost', format: '$.2f' },
                { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Avg cost / session', format: '$.4f' },
                { field: 'medianCostUsdPerRun', type: 'quantitative' as const, title: 'Median cost / run', format: '$.4f' },
                { field: 'sessionCount', type: 'quantitative' as const, title: 'Priced sessions' },
                { field: 'withCostCount', type: 'quantitative' as const, title: 'Runs with pricing' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Total runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-by-model', spec, 'No completed runs with cost data match the current filters.', ctx.renderToken);
      if (rows.length > 0) {
        ctx.setNote('cost-by-model-note', `Top ${rows.length} of ${cohort.length} model families with priced runs by spend; full priced-cohort total $${Math.round(total * 100) / 100}. Avg spend per session in tooltip. Reported free usage remains priced at $0; models with no priced rows are omitted.`, ctx.renderToken);
      }
    },
  },
  {
    id: 'chart-cost-per-session-by-model',
    render: async (ctx: ChartContext) => {
      // Per-session average is only meaningful for models with ≥1 priced session;
      // a $0 bar would otherwise conflate "free model" with "no pricing".
      const cohort = costByModelCohortRows(ctx.runs).filter((row) => row.sessionCount > 0);
      const rows = groupCostPerSessionByModel(ctx.runs);
      const sessionTotal = cohort.reduce((sum, row) => sum + row.sessionCount, 0);
      ctx.setNote('cost-per-session-by-model-note', `Top ${rows.length} of ${cohort.length} model families independently ranked by average spend per session; full filtered cohort has ${sessionTotal} priced model-sessions. A model-session rolls up all of its runs.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
            encoding: {
              y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
              x: { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Average estimated cost per session (USD)', axis: { format: '$.2f' } },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model' },
                { field: 'avgCostUsdPerSession', type: 'quantitative' as const, title: 'Avg cost / session', format: '$.4f' },
                { field: 'medianCostUsdPerSession', type: 'quantitative' as const, title: 'Median cost / session', format: '$.4f' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Total cost', format: '$.2f' },
                { field: 'sessionCount', type: 'quantitative' as const, title: 'Priced sessions' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Total runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-per-session-by-model', spec, 'No priced sessions match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-cost-trend',
    render: async (ctx: ChartContext) => {
      const rows = costTrendRows(ctx.runs);
      ctx.setNote('cost-trend-note', `Daily estimated spend across ${rows.length} active days.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: rows },
        layer: [
          {
            mark: { type: 'area' as const, opacity: 0.2 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Estimated cost (USD)' },
              color: { value: CHART_COLORS.gold },
            },
          },
          {
            // Line carries its own point markers (tooltip lives here) — avoids a
            // redundant third point layer stacked over the area + line.
            mark: { type: 'line' as const, strokeWidth: 2, point: { filled: true, size: 40, opacity: 0.6 } },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const },
              color: { value: CHART_COLORS.gold },
              tooltip: [
                { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Cost', format: '$.2f' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-trend', spec, 'No runs with cost data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-cost-trend-by-provider',
    render: async (ctx: ChartContext) => {
      const rows = costTrendByProviderRows(ctx.runs);
      const providerCount = new Set(rows.map((r) => r.provider)).size;
      ctx.setNote(
        'cost-trend-by-provider-note',
        `Daily estimated spend split by provider; ${providerCount} provider${providerCount === 1 ? '' : 's'} shown (top ${COST_TREND_BY_PROVIDER_TOP_N} by spend, remainder folded into 'Other'). Estimated via token usage × model pricing.`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 240,
        data: { values: rows },
        layer: [
          {
            // One line per provider with $0 imputation for missing days and
            // monotone interpolation to round the corners between days (fewer
            // sharp spikes). Point markers still reveal the actual data points.
            mark: { type: 'line' as const, strokeWidth: 2, interpolate: 'monotone', point: { filled: true, size: 35, opacity: 0.55 }, opacity: 0.9 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
              y: { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Estimated cost (USD)', axis: { format: '$.2f' } },
              color: {
                field: 'provider', type: 'nominal' as const, title: 'Provider',
                scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.accent2, CHART_COLORS.text, CHART_COLORS.muted] },
                legend: { orient: 'bottom', labelLimit: 180 },
              },
              tooltip: [
                { field: 'provider', type: 'nominal' as const, title: 'Provider' },
                { field: 'day', type: 'temporal' as const, title: 'Day', timeUnit: 'yearmonthdate' },
                { field: 'totalCostUsd', type: 'quantitative' as const, title: 'Cost', format: '$.2f' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-cost-trend-by-provider', spec, 'No runs with cost data match the current filters.', ctx.renderToken);
    },
  },
];
