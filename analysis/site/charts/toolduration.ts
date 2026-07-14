import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, selectedRunIds } from '../lib.ts';

interface ToolDurationRow {
  tool: string;
  totalDurationSec: number;
  meanDurationSec: number | null;
  callCount: number | null;
}

export const toolDurationCharts: ChartEntry[] = [
  {
    id: 'chart-tool-duration',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const map = new Map<string, { total: number; calls: number; failures: number }>();
      for (const row of ctx.toolRows) {
        if (!runIds.has(row.runId) || row.totalDurationMs <= 0) {
          continue;
        }
        const e = map.get(row.toolName) ?? { total: 0, calls: 0, failures: 0 };
        e.total += row.totalDurationMs;
        e.calls += row.callCount;
        e.failures += row.failureCount;
        map.set(row.toolName, e);
      }
      const rows: ToolDurationRow[] = [...map.entries()]
        .map(([tool, e]) => ({
          tool,
          totalDurationSec: Math.round((e.total / 1000) * 10) / 10,
          meanDurationSec: e.calls > 0 ? Math.round((e.total / e.calls / 1000) * 100) / 100 : null,
          callCount: e.calls > 0 ? e.calls : null,
        }))
        .sort((a, b) => b.totalDurationSec - a.totalDurationSec)
        .slice(0, 14);
      ctx.setNote('tool-duration-note', `Cumulative execution time per tool (top ${rows.length}); mean is unavailable when historical terminal call counts were not attributable.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'tool', type: 'nominal' as const, sort: rows.map((r) => r.tool), title: null, axis: { labelLimit: 220 } },
          x: { field: 'totalDurationSec', type: 'quantitative' as const, title: 'Total time (seconds)', axis: { format: '.1f' } },
          color: { value: CHART_COLORS.coral },
          tooltip: [
            { field: 'tool', type: 'nominal' as const, title: 'Tool' },
            { field: 'totalDurationSec', type: 'quantitative' as const, title: 'Total time (s)', format: '.1f' },
            { field: 'meanDurationSec', type: 'quantitative' as const, title: 'Mean per call (s)', format: '.2f' },
            { field: 'callCount', type: 'quantitative' as const, title: 'Calls' },
          ],
        },
      };
      await ctx.renderSpec('chart-tool-duration', spec, 'No timed tool calls match the current filters.', ctx.renderToken);
    },
  },
];
