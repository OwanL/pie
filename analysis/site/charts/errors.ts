import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, selectedRunIds } from '../lib.ts';

export const errorCharts: ChartEntry[] = [
  {
    id: 'chart-backend-errors-by-code',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const counts = new Map<string, { count: number; runs: Set<string> }>();
      for (const row of ctx.backendErrors.rows) {
        if (!runIds.has(row.runId)) {
          continue;
        }
        const e = counts.get(row.errorCode) ?? { count: 0, runs: new Set<string>() };
        e.count += row.count;
        e.runs.add(row.runId);
        counts.set(row.errorCode, e);
      }
      const rows = [...counts.entries()]
        .map(([code, e]) => ({ code, count: e.count, affectedRuns: e.runs.size }))
        .sort((a, b) => b.count - a.count);
      ctx.setNote('backend-errors-by-code-note', `Backend error events by code across ${rows.reduce((s, r) => s + r.affectedRuns, 0)} affected runs.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 36, 180),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'code', type: 'nominal' as const, sort: rows.map((r) => r.code), title: null, axis: { labelLimit: 320 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Error events' },
          color: { value: CHART_COLORS.coral },
          tooltip: [
            { field: 'code', type: 'nominal' as const, title: 'Error code' },
            { field: 'count', type: 'quantitative' as const, title: 'Events' },
            { field: 'affectedRuns', type: 'quantitative' as const, title: 'Affected runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-backend-errors-by-code', spec, 'No backend errors match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-backend-errors-trend',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const map = new Map<string, number>();
      for (const row of ctx.backendErrors.rows) {
        if (!runIds.has(row.runId)) {
          continue;
        }
        map.set(row.startedDay, (map.get(row.startedDay) ?? 0) + row.count);
      }
      const rows = [...map.entries()]
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day));
      ctx.setNote('backend-errors-trend-note', `Daily backend error events across ${rows.length} days.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: rows },
        mark: { type: 'bar' as const, opacity: 0.8, cornerRadiusEnd: 3 },
        encoding: {
          x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
          y: { field: 'count', type: 'quantitative' as const, title: 'Error events' },
          color: { value: CHART_COLORS.coral },
          tooltip: [
            { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
            { field: 'count', type: 'quantitative' as const, title: 'Events' },
          ],
        },
      };
      await ctx.renderSpec('chart-backend-errors-trend', spec, 'No backend errors match the current filters.', ctx.renderToken);
    },
  },
];
