import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, average, categoricalHeight, median, modelFamilyKey, percentile } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

function cacheByModel(runs: PreparedRunRow[]) {
  const map = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status === 'open' || run.cacheHitRatio === null) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = map.get(model) ?? [];
    entry.push(run.cacheHitRatio);
    map.set(model, entry);
  }
  return [...map.entries()]
    .map(([model, values]) => ({
      model,
      medianCacheHit: median(values) ?? 0,
      meanCacheHit: average(values) ?? 0,
      runCount: values.length,
    }))
    .filter((r) => r.runCount >= 2)
    .sort((a, b) => b.medianCacheHit - a.medianCacheHit)
    .slice(0, 12);
}

function cacheTrend(runs: PreparedRunRow[]) {
  const map = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status === 'open' || run.cacheHitRatio === null) {
      continue;
    }
    const entry = map.get(run.startedDay) ?? [];
    entry.push(run.cacheHitRatio);
    map.set(run.startedDay, entry);
  }
  return [...map.entries()]
    .map(([day, values]) => ({ day, cacheHit: average(values) ?? 0, runCount: values.length }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function tokenVolumeByModel(runs: PreparedRunRow[]) {
  const map = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; runs: number }>();
  for (const run of runs) {
    if (run.status === 'open') {
      continue;
    }
    if (run.inputTokens === 0 && run.outputTokens === 0 && run.cacheReadTokens === 0 && run.cacheWriteTokens === 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const e = map.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0 };
    e.input += run.inputTokens;
    e.output += run.outputTokens;
    e.cacheRead += run.cacheReadTokens;
    e.cacheWrite += run.cacheWriteTokens;
    e.runs += 1;
    map.set(model, e);
  }
  return [...map.entries()]
    .map(([model, e]) => ({
      model,
      input: Math.round(e.input / 1_000_000 * 100) / 100,
      output: Math.round(e.output / 1_000_000 * 100) / 100,
      cacheRead: Math.round(e.cacheRead / 1_000_000 * 100) / 100,
      cacheWrite: Math.round(e.cacheWrite / 1_000_000 * 100) / 100,
      runs: e.runs,
    }))
    .sort((a, b) => (b.input + b.output + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.cacheRead + a.cacheWrite))
    .slice(0, 10);
}

function tokenEfficiencyByModel(runs: PreparedRunRow[]) {
  const map = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status === 'open' || run.tokenEfficiency === null) {
      continue;
    }
    const model = modelFamilyKey(run);
    const e = map.get(model) ?? [];
    e.push(run.tokenEfficiency);
    map.set(model, e);
  }
  return [...map.entries()]
    .map(([model, values]) => ({ model, median: median(values) ?? 0, p90: percentile(values, 90) ?? 0, runCount: values.length }))
    .filter((r) => r.runCount >= 2)
    .sort((a, b) => b.median - a.median)
    .slice(0, 12);
}

export const efficiencyCharts: ChartEntry[] = [
  {
    id: 'chart-cache-hit-by-model',
    render: async (ctx: ChartContext) => {
      const rows = cacheByModel(ctx.runs);
      ctx.setNote('cache-hit-by-model-note', `Median cache-read hit ratio by model (≥2 runs). Cache hit = cacheRead / (cacheRead + input).`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
          x: { field: 'medianCacheHit', type: 'quantitative' as const, title: 'Median cache hit ratio', scale: { domain: [0, 1] }, axis: { format: '.0%' } },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'medianCacheHit', type: 'quantitative' as const, title: 'Median', format: '.1%' },
            { field: 'meanCacheHit', type: 'quantitative' as const, title: 'Mean', format: '.1%' },
            { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-cache-hit-by-model', spec, 'No runs with cache-hit data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-cache-hit-trend',
    render: async (ctx: ChartContext) => {
      const rows = cacheTrend(ctx.runs);
      ctx.setNote('cache-hit-trend-note', `Daily mean cache-hit ratio across ${rows.length} days.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: rows },
        mark: { type: 'line' as const, strokeWidth: 2.5, point: { size: 35, filled: true } },
        encoding: {
          x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
          y: { field: 'cacheHit', type: 'quantitative' as const, title: 'Cache hit ratio', scale: { domain: [0, 1] }, axis: { format: '.0%' } },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
            { field: 'cacheHit', type: 'quantitative' as const, title: 'Cache hit', format: '.1%' },
            { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-cache-hit-trend', spec, 'No runs with cache-hit data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-token-volume',
    render: async (ctx: ChartContext) => {
      const rows = tokenVolumeByModel(ctx.runs);
      ctx.setNote('token-volume-note', `Total token volume (millions) by component, top ${rows.length} models.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        mark: { type: 'bar' as const },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
          x: { field: 'value', type: 'quantitative' as const, title: 'Tokens (millions)', axis: { format: '.1f' } },
          color: {
            field: 'component', type: 'nominal' as const, title: 'Token type',
            scale: { domain: ['cacheRead', 'input', 'output', 'cacheWrite'], range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.accent2] },
            legend: { orient: 'bottom' as const },
          },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'component', type: 'nominal' as const, title: 'Token type' },
            { field: 'value', type: 'quantitative' as const, title: 'Tokens (M)', format: '.2f' },
            { field: 'runs', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
        transform: [
          { fold: ['cacheRead', 'input', 'output', 'cacheWrite'], as: ['component', 'value'] },
        ],
      };
      await ctx.renderSpec('chart-token-volume', spec, 'No runs with token usage match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-token-efficiency-by-model',
    render: async (ctx: ChartContext) => {
      const rows = tokenEfficiencyByModel(ctx.runs);
      ctx.setNote('token-efficiency-by-model-note', `Median output tokens per mutated line by model (≥2 runs); higher = more verbose.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.8 },
            encoding: {
              y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
              x: { field: 'median', type: 'quantitative' as const, title: 'Tokens / line (median)', axis: { format: '.0f' } },
              color: { value: CHART_COLORS.accent2 },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model' },
                { field: 'median', type: 'quantitative' as const, title: 'Median', format: '.1f' },
                { field: 'p90', type: 'quantitative' as const, title: 'p90', format: '.1f' },
                { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-token-efficiency-by-model', spec, 'No runs with token-efficiency data match the current filters.', ctx.renderToken);
    },
  },
];
