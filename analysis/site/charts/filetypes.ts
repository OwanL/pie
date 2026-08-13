import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, selectedRunIds } from '../lib.ts';

export const fileTypeCharts: ChartEntry[] = [
  {
    id: 'chart-file-type-activity',
    runCohort: 'all-history',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const map = new Map<string, { read: number; write: number; edit: number; runs: Set<string> }>();
      for (const row of ctx.fileExtensions.rows) {
        if (!runIds.has(row.runId)) {
          continue;
        }
        const e = map.get(row.extension) ?? { read: 0, write: 0, edit: 0, runs: new Set<string>() };
        e.read += row.readCount;
        e.write += row.writeCount;
        e.edit += row.editCount;
        e.runs.add(row.runId);
        map.set(row.extension, e);
      }
      const rows = [...map.entries()]
        .map(([extension, e]) => ({
          extension: extension || '(none)',
          read: e.read,
          write: e.write,
          edit: e.edit,
          total: e.read + e.write + e.edit,
          runs: e.runs.size,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15);
      ctx.setNote('file-type-activity-note', `Read / write / edit counts by file extension (top ${rows.length}).`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 26),
        data: { values: rows },
        mark: { type: 'bar' as const },
        encoding: {
          y: { field: 'extension', type: 'nominal' as const, sort: rows.map((r) => r.extension), title: null, axis: { labelLimit: 120 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Operations' },
          color: {
            field: 'op', type: 'nominal' as const, title: 'Operation',
            scale: { domain: ['read', 'edit', 'write'], range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral] },
            legend: { orient: 'bottom' as const },
          },
          tooltip: [
            { field: 'extension', type: 'nominal' as const, title: 'Extension' },
            { field: 'op', type: 'nominal' as const, title: 'Operation' },
            { field: 'count', type: 'quantitative' as const, title: 'Count' },
            { field: 'runs', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
        transform: [{ fold: ['read', 'edit', 'write'], as: ['op', 'count'] }],
      };
      await ctx.renderSpec('chart-file-type-activity', spec, 'No file-extension activity matches the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-files-reviewed',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      // Distinct files reviewed (read) per run — the breadth-of-investigation signal that
      // mirrors `editRevisitRate`'s churn signal. Only runs with attributable per-file reads
      // contribute (legacy runs without readCountsByFile are 0 and excluded).
      const rows = ctx.runs
        .map((r) => ({ runId: r.runId, files: r.filesReviewedCount ?? 0, reread: r.readRevisitRate }))
        .filter((r) => r.files > 0)
        .sort((a, b) => b.files - a.files)
        .slice(0, 15);

      const withChurn = ctx.runs
        .map((r) => r.readRevisitRate)
        .filter((v): v is number => v !== null);
      const meanChurn = withChurn.length > 0
        ? Math.round((withChurn.reduce((s, v) => s + v, 0) / withChurn.length) * 100)
        : null;
      const allReviewed = ctx.runs.map((r) => r.filesReviewedCount ?? 0).filter((n) => n > 0);
      const meanReviewed = allReviewed.length > 0
        ? Math.round((allReviewed.reduce((s, v) => s + v, 0) / allReviewed.length) * 10) / 10
        : null;
      const note = meanReviewed === null
        ? 'No runs with attributable file reads.'
        : `Distinct files read per run (top ${rows.length}). Mean: ${meanReviewed} · re-read churn ${meanChurn === null ? '—' : `${meanChurn}%`}.`;
      ctx.setNote('files-reviewed-note', note, ctx.renderToken);

      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 26),
        data: { values: rows },
        mark: { type: 'bar' as const },
        encoding: {
          y: { field: 'runId', type: 'nominal' as const, sort: rows.map((r) => r.runId), title: null, axis: { labelLimit: 120 } },
          x: { field: 'files', type: 'quantitative' as const, title: 'Distinct files reviewed' },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'runId', type: 'nominal' as const, title: 'Run' },
            { field: 'files', type: 'quantitative' as const, title: 'Files reviewed' },
            { field: 'reread', type: 'quantitative' as const, title: 'Re-read churn', format: '.1%' },
          ],
        },
      };
      await ctx.renderSpec('chart-files-reviewed', spec, 'No runs with attributable file reads match the current filters.', ctx.renderToken);
    },
  },
];
