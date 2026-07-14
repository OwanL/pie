import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, median, modelFamilyKey } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

/**
 * Prompt-size-vs-outcome charts.
 *
 * "Prompt size" is proxied by a run's cumulative `inputTokens` — the total
 * prompt tokens sent to the model across the run. (Raw prompt byte/char size
 * is not captured by the analytics pipeline — only prompt *hashes* are, for
 * A/B grouping — so token count is the closest available sizing signal. See
 * `SessionAnalyticsFactors` in `shared/run-analytics-contracts.ts`.)
 *
 * Two charts mirror the cost module's outcome pairing:
 *  - {@link chartPromptSizeVsSatisfaction}: scatter of prompt size vs the
 *    1–5 satisfaction score, coloured by resolution — does prompt heft track
 *    reported quality?
 *  - {@link chartPromptSizeByOutcome}: median prompt size per resolution
 *    bucket (resolved / partially_resolved / unresolved) — do bigger prompts
 *    tend to resolve better?
 */

interface PromptSizeByOutcomeRow {
  resolution: string;
  medianPromptTokens: number;
  meanPromptTokens: number;
  runCount: number;
}

function promptSizeByOutcomeRows(runs: PreparedRunRow[]): PromptSizeByOutcomeRow[] {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    if (run.status === 'open' || run.resolution === null || run.inputTokens <= 0) {
      continue;
    }
    const entry = groups.get(run.resolution) ?? [];
    entry.push(run.inputTokens);
    groups.set(run.resolution, entry);
  }
  return [...groups.entries()].map(([resolution, tokens]) => ({
    resolution,
    medianPromptTokens: Math.round(median(tokens) ?? 0),
    meanPromptTokens: Math.round(tokens.reduce((s, v) => s + v, 0) / tokens.length),
    runCount: tokens.length,
  }));
}

export const promptSizeCharts: ChartEntry[] = [
  {
    id: 'chart-prompt-size-vs-satisfaction',
    render: async (ctx: ChartContext) => {
      const points = ctx.runs
        .filter((r) => r.status !== 'open' && r.satisfaction !== null && r.inputTokens > 0)
        .map((r) => ({
          promptTokens: r.inputTokens,
          satisfaction: r.satisfaction!,
          resolution: r.resolution ?? '(unscored)',
          model: modelFamilyKey(r),
        }));
      ctx.setNote('prompt-size-vs-satisfaction-note', `${points.length} scored runs with prompt-size data; log-scaled token axis.`, ctx.renderToken);
      const spec = points.length === 0 ? null : {
        width: 'container',
        height: 280,
        data: { values: points },
        mark: { type: 'circle' as const, filled: true, opacity: 0.55, size: 90 },
        encoding: {
          x: { field: 'promptTokens', type: 'quantitative' as const, title: 'Prompt size (input tokens, log)', scale: { type: 'log' } },
          y: { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction', scale: { domain: [1, 5] } },
          color: {
            field: 'resolution', type: 'nominal' as const, title: 'Resolution',
            scale: { domain: ['resolved', 'partially_resolved', 'unresolved', '(unscored)'], range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted] },
          },
          tooltip: [
            { field: 'model', type: 'nominal' as const, title: 'Model' },
            { field: 'promptTokens', type: 'quantitative' as const, title: 'Prompt tokens', format: ',' },
            { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction' },
            { field: 'resolution', type: 'nominal' as const, title: 'Resolution' },
          ],
        },
      };
      await ctx.renderSpec('chart-prompt-size-vs-satisfaction', spec, 'No scored runs with prompt-size data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-prompt-size-by-outcome',
    render: async (ctx: ChartContext) => {
      const rows = promptSizeByOutcomeRows(ctx.runs);
      ctx.setNote('prompt-size-by-outcome-note', `Median prompt size per outcome across ${rows.reduce((s, r) => s + r.runCount, 0)} scored runs with prompt-size data.`, ctx.renderToken);
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 220,
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, opacity: 0.85 },
        encoding: {
          x: { field: 'resolution', type: 'nominal' as const, title: 'Resolution', sort: ['resolved', 'partially_resolved', 'unresolved'] },
          y: { field: 'medianPromptTokens', type: 'quantitative' as const, title: 'Median prompt size (tokens)', axis: { format: ',' } },
          color: {
            field: 'resolution', type: 'nominal' as const, title: 'Resolution',
            scale: { domain: ['resolved', 'partially_resolved', 'unresolved'], range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral] },
            // x-axis already encodes resolution; a legend would duplicate it.
            legend: null,
          },
          tooltip: [
            { field: 'resolution', type: 'nominal' as const, title: 'Resolution' },
            { field: 'medianPromptTokens', type: 'quantitative' as const, title: 'Median prompt tokens', format: ',' },
            { field: 'meanPromptTokens', type: 'quantitative' as const, title: 'Mean prompt tokens', format: ',' },
            { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
          ],
        },
      };
      await ctx.renderSpec('chart-prompt-size-by-outcome', spec, 'No scored runs with prompt-size data match the current filters.', ctx.renderToken);
    },
  },
];