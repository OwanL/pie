import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, selectedRunIds } from '../lib.ts';

export interface ToolDurationRow {
  tool: string;
  totalDurationSec: number;
  meanDurationSec: number | null;
  timedCallCount: number | null;
}

export function toolDurationRows(ctx: ChartContext): ToolDurationRow[] {
  const runIds = selectedRunIds(ctx.runs);
  const map = new Map<string, { total: number; timedCalls: number; failures: number }>();
  for (const row of ctx.toolRows) {
    if (!runIds.has(row.runId) || row.totalDurationMs <= 0) continue;
    const entry = map.get(row.toolName) ?? { total: 0, timedCalls: 0, failures: 0 };
    entry.total += row.totalDurationMs;
    entry.timedCalls += row.timedCallCount;
    entry.failures += row.failureCount;
    map.set(row.toolName, entry);
  }
  return [...map.entries()]
    .map(([tool, entry]) => ({
      tool,
      totalDurationSec: Math.round((entry.total / 1000) * 10) / 10,
      meanDurationSec: entry.timedCalls > 0 ? Math.round((entry.total / entry.timedCalls / 1000) * 100) / 100 : null,
      timedCallCount: entry.timedCalls > 0 ? entry.timedCalls : null,
    }))
    .sort((a, b) => b.totalDurationSec - a.totalDurationSec)
    .slice(0, 14);
}

export const toolDurationCharts: ChartEntry[] = [
  {
    id: 'chart-tool-duration',
    runCohort: 'all-history',
    render: async (ctx: ChartContext) => {
      const rows = toolDurationRows(ctx);
      ctx.setNote('tool-duration-note', `Cumulative execution time per tool (top ${rows.length}); mean uses timed calls only and is unavailable when timed-call counts were not attributable.`, ctx.renderToken);
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
            { field: 'meanDurationSec', type: 'quantitative' as const, title: 'Mean per timed call (s)', format: '.2f' },
            { field: 'timedCallCount', type: 'quantitative' as const, title: 'Timed calls' },
          ],
        },
      };
      await ctx.renderSpec('chart-tool-duration', spec, 'No timed tool calls match the current filters.', ctx.renderToken);
    },
  },
];
