import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, modelFamilyKey } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

function firstAttemptByModel(runs: PreparedRunRow[]) {
  const map = new Map<string, { success: number; total: number }>();
  for (const run of runs) {
    if (run.status === 'open') {
      continue;
    }
    const model = modelFamilyKey(run);
    const e = map.get(model) ?? { success: 0, total: 0 };
    e.total += 1;
    if (run.firstAttemptSuccess) {
      e.success += 1;
    }
    map.set(model, e);
  }
  return [...map.entries()]
    .map(([model, e]) => ({ model, rate: e.total > 0 ? e.success / e.total : 0, success: e.success, total: e.total }))
    .filter((r) => r.total >= 2)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 12);
}

export const interruptionCharts: ChartEntry[] = [
  {
    id: 'chart-interruption-signals',
    render: async (ctx: ChartContext) => {
      const completed = ctx.runs.filter((r) => r.status !== 'open');
      const interrupted = completed.filter((r) => r.interruptedCount > 0).length;
      const edited = completed.filter((r) => r.messageEditCount > 0).length;
      const truncated = completed.filter((r) => r.truncatedAfterCount > 0).length;
      const firstAttempt = completed.filter((r) => r.firstAttemptSuccess).length;
      const firstRate = completed.length > 0 ? firstAttempt / completed.length : 0;
      const rows = [
        { signal: 'Interrupted', count: interrupted, detail: `${interrupted} runs` },
        { signal: 'Message edits', count: edited, detail: `${edited} runs` },
        { signal: 'Truncated', count: truncated, detail: `${truncated} runs` },
      ];
      ctx.setNote('interruption-signals-note', `Friction signals across ${completed.length} completed runs; first-attempt success rate ${Math.round(firstRate * 100)}%.`, ctx.renderToken);
      const spec = rows.length === 0 || completed.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, opacity: 0.85 },
        encoding: {
          x: { field: 'signal', type: 'nominal' as const, title: null, sort: ['Interrupted', 'Message edits', 'Truncated'] },
          y: { field: 'count', type: 'quantitative' as const, title: 'Runs affected' },
          color: { value: CHART_COLORS.coral },
          tooltip: [{ field: 'signal', type: 'nominal' as const, title: 'Signal' }, { field: 'count', type: 'quantitative' as const, title: 'Runs affected' }],
        },
      };
      await ctx.renderSpec('chart-interruption-signals', spec, 'No completed runs match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-first-attempt-by-model',
    render: async (ctx: ChartContext) => {
      const rows = firstAttemptByModel(ctx.runs);
      ctx.setNote('first-attempt-by-model-note', `First-attempt success rate by model family (≥2 runs): no interruptions, edits, or truncations and resolved.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
          x: { field: 'rate', type: 'quantitative' as const, title: 'First-attempt success rate', scale: { domain: [0, 1] }, axis: { format: '.0%' } },
          color: { value: CHART_COLORS.success },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'rate', type: 'quantitative' as const, title: 'Rate', format: '.0%' },
            { field: 'success', type: 'quantitative' as const, title: 'First-attempt' },
            { field: 'total', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-first-attempt-by-model', spec, 'No completed runs match the current filters.', ctx.renderToken);
    },
  },
];
