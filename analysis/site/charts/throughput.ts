import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  categoricalHeight,
  median,
  modelFamilyKey,
  percentile,
  sortNatural,
  uniqueNonEmpty,
} from '../lib.ts';
import type { PreparedRunRow, PreparedTurnThroughputRow } from '../../scripts/contracts.ts';

export type ThroughputChartRow = PreparedTurnThroughputRow & {
  model: string;
  tokensPerSecond: number;
};

/** Throughput rows belonging to the filtered run set, attributed to each turn's model family. */
export function effectiveThroughputRows(
  runs: PreparedRunRow[],
  turnRows: PreparedTurnThroughputRow[],
): ThroughputChartRow[] {
  const selectedRunIds = new Set(runs.map((run) => run.runId));
  return turnRows
    .filter((row) => selectedRunIds.has(row.runId) && row.tokensPerSecond !== null)
    .map((row) => ({
      ...row,
      model: modelFamilyKey(row),
      tokensPerSecond: row.tokensPerSecond!,
    }))
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

function relevantRows(ctx: ChartContext): ThroughputChartRow[] {
  return effectiveThroughputRows(ctx.runs, ctx.turnThroughputRows);
}

/** Distinct model-family labels among the throughput rows, sorted for a stable legend. */
function modelDomain(rows: ThroughputChartRow[]): string[] {
  return sortNatural(uniqueNonEmpty(rows.map((row) => row.model)));
}

/** One point per assistant turn: output tokens divided by measured generation time. */
function throughputOverTimeSpec(rows: ThroughputChartRow[], models: string[]) {
  return {
    width: 'container',
    height: 260,
    data: { values: rows },
    mark: { type: 'circle' as const, filled: true, opacity: 0.5, size: 40 },
    encoding: {
      x: { field: 'endedAt', type: 'temporal' as const, timeUnit: 'yearmonthdatehoursminutes', title: 'Turn ended' },
      y: { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Effective response throughput (tokens / sec)', scale: { zero: true, nice: true } },
      color: {
        field: 'model',
        type: 'nominal' as const,
        title: 'Model family',
        sort: models,
        scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.gold, CHART_COLORS.success] },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model family' },
        { field: 'tokensPerSecond', type: 'quantitative' as const, title: 'Effective throughput', format: '.1f' },
        { field: 'outputTokens', type: 'quantitative' as const, title: 'Output tokens' },
        { field: 'generationDurationMs', type: 'quantitative' as const, title: 'Gen time (ms)' },
        { field: 'concurrentBusySessions', type: 'quantitative' as const, title: 'Concurrent sessions' },
        { field: 'endedAt', type: 'temporal' as const, title: 'Ended' },
      ],
    },
  };
}

export interface ThroughputByModelRow {
  model: string;
  median: number;
  p90: number;
  turnCount: number;
}

/** Median (and p90) effective response throughput by canonical model family. */
export function throughputByModelRows(rows: ThroughputChartRow[]): ThroughputByModelRow[] {
  const byModel = new Map<string, number[]>();
  for (const row of rows) {
    const entry = byModel.get(row.model) ?? [];
    entry.push(row.tokensPerSecond);
    byModel.set(row.model, entry);
  }
  return [...byModel.entries()]
    .map(([model, values]) => ({
      model,
      median: Math.round((median(values) ?? 0) * 10) / 10,
      p90: Math.round((percentile(values, 90) ?? 0) * 10) / 10,
      turnCount: values.length,
    }))
    .filter((entry) => entry.turnCount >= 2)
    .sort((a, b) => b.median - a.median)
    .slice(0, 14);
}

function throughputByModelSpec(table: ThroughputByModelRow[]) {
  return {
    width: 'container',
    height: categoricalHeight(table.length),
    data: { values: table },
    layer: [
      {
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: table.map((row) => row.model), title: null, axis: { labelLimit: 260 } },
          x: { field: 'median', type: 'quantitative' as const, title: 'Effective response throughput (tokens / sec, median)', axis: { format: '.0f' } },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model family' },
            { field: 'median', type: 'quantitative' as const, title: 'Median', format: '.1f' },
            { field: 'p90', type: 'quantitative' as const, title: 'p90', format: '.1f' },
            { field: 'turnCount', type: 'quantitative' as const, title: 'Turns' },
          ],
        },
      },
      {
        mark: { type: 'tick' as const, color: CHART_COLORS.text, thickness: 1.5, opacity: 0.6 },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: table.map((row) => row.model), title: null, axis: null },
          x: { field: 'p90', type: 'quantitative' as const },
          tooltip: [{ field: 'p90', type: 'quantitative' as const, title: 'p90', format: '.1f' }],
        },
      },
    ],
  };
}

export interface ThroughputConcurrencyRow {
  model: string;
  concurrency: number;
  medianThroughput: number;
  turnCount: number;
  nLabel: string;
}

/** Exact-concurrency bins with a per-family median and visible sample size. */
export function throughputConcurrencyRows(rows: ThroughputChartRow[]): ThroughputConcurrencyRow[] {
  const bins = new Map<string, { model: string; concurrency: number; values: number[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.model, row.concurrentBusySessions]);
    const bin = bins.get(key) ?? { model: row.model, concurrency: row.concurrentBusySessions, values: [] };
    bin.values.push(row.tokensPerSecond);
    bins.set(key, bin);
  }
  return [...bins.values()]
    .map((bin) => ({
      model: bin.model,
      concurrency: bin.concurrency,
      medianThroughput: Math.round((median(bin.values) ?? 0) * 10) / 10,
      turnCount: bin.values.length,
      nLabel: `n=${bin.values.length}`,
    }))
    .sort((left, right) => left.model.localeCompare(right.model) || left.concurrency - right.concurrency);
}

/** Descriptive medians only; deliberately no fitted trend or causal interpretation. */
export function throughputVsConcurrencySpec(rows: ThroughputConcurrencyRow[], models: string[]) {
  return {
    width: 'container',
    height: 280,
    data: { values: rows },
    layer: [
      {
        mark: { type: 'point' as const, filled: true, opacity: 0.85, size: 100 },
        encoding: {
          x: { field: 'concurrency', type: 'quantitative' as const, title: 'Concurrent busy sessions (exact-count bins)', scale: { zero: true, nice: true } },
          y: { field: 'medianThroughput', type: 'quantitative' as const, title: 'Median effective response throughput (tokens / sec)', scale: { zero: true, nice: true } },
          color: {
            field: 'model',
            type: 'nominal' as const,
            title: 'Model family',
            sort: models,
            scale: { range: [CHART_COLORS.accent, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.gold, CHART_COLORS.success] },
            legend: { orient: 'bottom' as const },
          },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model family' },
            { field: 'concurrency', type: 'quantitative' as const, title: 'Concurrent sessions' },
            { field: 'medianThroughput', type: 'quantitative' as const, title: 'Median effective throughput', format: '.1f' },
            { field: 'turnCount', type: 'quantitative' as const, title: 'Turns in bin' },
          ],
        },
      },
      {
        mark: { type: 'text' as const, dy: -12, fontSize: 10, opacity: 0.85 },
        encoding: {
          x: { field: 'concurrency', type: 'quantitative' as const },
          y: { field: 'medianThroughput', type: 'quantitative' as const },
          text: { field: 'nLabel', type: 'nominal' as const },
          color: { value: CHART_COLORS.text },
        },
      },
    ],
  };
}

export const throughputCharts: ChartEntry[] = [
  {
    id: 'chart-throughput-over-time',
    render: async (ctx: ChartContext) => {
      const rows = relevantRows(ctx);
      const models = modelDomain(rows);
      ctx.setNote(
        'throughput-over-time-note',
        `${rows.length} assistant turns; effective response throughput = output tokens ÷ measured generation time (tool execution excluded).`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : throughputOverTimeSpec(rows, models);
      await ctx.renderSpec('chart-throughput-over-time', spec, 'No assistant turns with throughput data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-throughput-by-model',
    render: async (ctx: ChartContext) => {
      const table = throughputByModelRows(relevantRows(ctx));
      ctx.setNote(
        'throughput-by-model-note',
        `Median effective response throughput by model family (≥2 turns); tick = p90. ${table.length} families shown.`,
        ctx.renderToken,
      );
      const spec = table.length === 0 ? null : throughputByModelSpec(table);
      await ctx.renderSpec('chart-throughput-by-model', spec, 'No model families with ≥2 throughput samples match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-throughput-vs-concurrency',
    render: async (ctx: ChartContext) => {
      const samples = relevantRows(ctx);
      const rows = throughputConcurrencyRows(samples);
      const models = modelDomain(samples);
      ctx.setNote(
        'throughput-vs-concurrency-note',
        `${rows.length} model-family/concurrency bins. Points are median effective response throughput at each exact concurrency count; labels show turn n. Descriptive only: concurrency can covary with provider, model, and workload, so no fitted or causal interpretation is shown.`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : throughputVsConcurrencySpec(rows, models);
      await ctx.renderSpec('chart-throughput-vs-concurrency', spec, 'No throughput samples match the current filters.', ctx.renderToken);
    },
  },
];
