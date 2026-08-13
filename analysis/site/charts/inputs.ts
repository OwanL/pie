import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, modelFamilyKey } from '../lib.ts';

export const inputCharts: ChartEntry[] = [
  {
    id: 'chart-multimodal-inputs',
    runCohort: 'all-history',
    render: async (ctx: ChartContext) => {
      const completed = ctx.runs.filter((r) => r.status !== 'open');
      const map = new Map<string, { images: number; bytes: number; runs: number }>();
      for (const run of completed) {
        if (run.imageInputCount <= 0) {
          continue;
        }
        const model = modelFamilyKey(run);
        const e = map.get(model) ?? { images: 0, bytes: 0, runs: 0 };
        e.images += run.imageInputCount;
        e.bytes += run.imageInputBytes;
        e.runs += 1;
        map.set(model, e);
      }
      const rows = [...map.entries()]
        .map(([model, e]) => ({
          model,
          images: e.images,
          megabytes: Math.round((e.bytes / (1024 * 1024)) * 100) / 100,
          runs: e.runs,
        }))
        .sort((a, b) => b.images - a.images);
      const totalImages = rows.reduce((s, r) => s + r.images, 0);
      ctx.setNote('multimodal-inputs-note', `Image inputs by model family; ${totalImages} images across ${rows.length} families.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 36, 180),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'model', type: 'nominal' as const, sort: rows.map((r) => r.model), title: null, axis: { labelLimit: 260 } },
          x: { field: 'images', type: 'quantitative' as const, title: 'Image inputs' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'images', type: 'quantitative' as const, title: 'Images' },
            { field: 'megabytes', type: 'quantitative' as const, title: 'Total MB' },
            { field: 'runs', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-multimodal-inputs', spec, 'No runs with image inputs match the current filters.', ctx.renderToken);
    },
  },
];
