import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS } from '../lib.ts';

export const interruptionCharts: ChartEntry[] = [
  {
    id: 'chart-interruption-signals',
    render: async (ctx: ChartContext) => {
      const completed = ctx.runs.filter((r) => r.status !== 'open');
      const interrupted = completed.filter((r) => r.interruptedCount > 0).length;
      const edited = completed.filter((r) => r.messageEditCount > 0).length;
      const truncated = completed.filter((r) => r.truncatedAfterCount > 0).length;
      const rows = [
        { signal: 'Interrupted', count: interrupted, detail: `${interrupted} runs` },
        { signal: 'Message edits', count: edited, detail: `${edited} runs` },
        { signal: 'Truncated', count: truncated, detail: `${truncated} runs` },
      ];
      ctx.setNote('interruption-signals-note', `Friction signals across ${completed.length} completed runs.`, ctx.renderToken);
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
];
