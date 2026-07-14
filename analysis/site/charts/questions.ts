import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  categoricalHeight,
  meanInterval,
  modelFamilyKey,
  selectedCompletedRuns,
  selectedRunIds,
  selectedScoredCompletedRuns,
  wilsonInterval,
} from '../lib.ts';
import type { PreparedRunRow, PreparedToolUsageRow } from '../../scripts/contracts.ts';

/**
 * "Questions asked" insights — correlates the number of clarifying questions a
 * run asked the user (the `ask_user` tool) against run outcomes.
 *
 * The per-run question count is derived from {@link PreparedToolUsageRow} rows
 * where `toolName === 'ask_user'`, joined back to the filtered run set. Two
 * complementary "versus" views are rendered:
 *
 *  1. A scatter of every scored run — clarifying questions (x, jittered) vs
 *     satisfaction (y), colored by resolution, sized by change footprint, with
 *     a linear trend line when there is enough contrast.
 *  2. A dose-response dot plot — mean satisfaction (95% CI) per question-count
 *     bucket (0 / 1 / 2–3 / 4+), with resolved share in the tooltip.
 */

const QUESTION_TOOL_NAME = 'ask_user';

const QUESTION_BUCKETS = ['0', '1', '2–3', '4+'] as const;
const QUESTION_BUCKET_LABELS: Record<string, string> = {
  '0': '0 questions',
  '1': '1 question',
  '2–3': '2–3 questions',
  '4+': '4+ questions',
};

function questionBucketIndex(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

/** Stable, deterministic jitter in [-amplitude, +amplitude] derived from runId. */
function stableJitter(runId: string, amplitude = 0.35): number {
  let hash = 0;
  for (let i = 0; i < runId.length; i++) {
    hash = (hash * 31 + runId.charCodeAt(i)) | 0;
  }
  const frac = ((hash >>> 0) % 1000) / 1000; // [0, 1)
  return (frac - 0.5) * 2 * amplitude;
}

function questionCountByRun(
  toolRows: PreparedToolUsageRow[],
  runIds: Set<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of toolRows) {
    if (!runIds.has(row.runId)) continue;
    if (row.toolName.trim().toLowerCase() !== QUESTION_TOOL_NAME) continue;
    counts.set(row.runId, (counts.get(row.runId) ?? 0) + row.callCount);
  }
  return counts;
}

interface QuestionScatterRow {
  questions: number;
  questionsJitter: number;
  satisfaction: number;
  resolution: string;
  model: string;
  lineMutationTotal: number;
  toolFailureCount: number;
  busyMinutes: number;
}

function questionScatterRows(
  runs: PreparedRunRow[],
  questionCounts: Map<string, number>,
): QuestionScatterRow[] {
  return selectedScoredCompletedRuns(runs).map((run) => {
    const questions = questionCounts.get(run.runId) ?? 0;
    return {
      questions,
      // For 0-question runs (usually the largest bucket) use one-sided jitter so
      // they spread to [0, +amp] instead of piling ~half exactly on the axis.
      questionsJitter: questions === 0
        ? Math.abs(stableJitter(run.runId))
        : questions + stableJitter(run.runId),
      satisfaction: run.satisfaction ?? 0,
      resolution: run.resolution ?? 'unknown',
      model: modelFamilyKey(run),
      lineMutationTotal: run.lineMutationTotal,
      toolFailureCount: run.toolFailureCount,
      busyMinutes: Math.max(run.busyDurationMs / 60000, 1 / 60),
    };
  });
}

interface QuestionDoseRow {
  bucket: string;
  bucketIndex: number;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  scoredRunCount: number;
  runCount: number;
  nLabel: string;
  resolvedRate: number | null;
  resolveCiLabel: string;
  meanQuestions: number;
}

function questionDoseRows(
  runs: PreparedRunRow[],
  questionCounts: Map<string, number>,
): QuestionDoseRow[] {
  const completed = selectedCompletedRuns(runs);
  const buckets: PreparedRunRow[][] = [[], [], [], []];

  completed.forEach((run) => {
    const count = questionCounts.get(run.runId) ?? 0;
    buckets[questionBucketIndex(count)]?.push(run);
  });

  return QUESTION_BUCKETS.map((bucket, bucketIndex) => {
    const bucketRuns = buckets[bucketIndex] ?? [];
    const scored = bucketRuns.filter((run) => run.satisfaction !== null);
    // Skip buckets with no scored runs: there is no outcome to plot, and a
    // degenerate point at satisfaction=0 would be clipped outside [1, 5] with a
    // misleading tooltip. Mirrors the subagentTaskDoseRows sibling in app.ts.
    if (scored.length === 0) return null;
    const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
    if (!interval) return null;
    const resolvedCount = scored.filter((run) => run.resolution === 'resolved').length;
    const resolveInterval = wilsonInterval(resolvedCount, scored.length);
    const bucketQuestions = bucketRuns.reduce((sum, run) => sum + (questionCounts.get(run.runId) ?? 0), 0);
    const meanQuestions = bucketQuestions / bucketRuns.length;

    return {
      bucket: QUESTION_BUCKET_LABELS[bucket] ?? bucket,
      bucketIndex,
      meanSatisfaction: interval.mean,
      ciLower: interval.lower,
      ciUpper: interval.upper,
      ciLabel: interval.ciLabel,
      scoredRunCount: scored.length,
      runCount: bucketRuns.length,
      nLabel: `n=${scored.length}/${bucketRuns.length}`,
      resolvedRate: resolveInterval?.rate ?? null,
      resolveCiLabel: resolveInterval?.ciLabel ?? 'No scored runs',
      meanQuestions: Math.round(meanQuestions * 100) / 100,
    };
  }).filter((row): row is QuestionDoseRow => row !== null);
}

export const questionCharts: ChartEntry[] = [
  {
    id: 'chart-questions-vs-satisfaction',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const questionCounts = questionCountByRun(ctx.toolRows, runIds);
      const rows = questionScatterRows(ctx.runs, questionCounts);

      const maxQuestions = rows.reduce((max, row) => Math.max(max, row.questions), 0);
      const maxQuestionsJitter = rows.reduce((max, row) => Math.max(max, row.questionsJitter), maxQuestions);
      const distinctQuestionCounts = new Set(rows.map((row) => row.questions)).size;
      const showTrend = rows.length >= 4 && distinctQuestionCounts >= 2;
      const runsAskedAtLeastOne = rows.filter((row) => row.questions > 0).length;
      const askedShare = rows.length === 0 ? null : runsAskedAtLeastOne / rows.length;

      ctx.setNote(
        'questions-vs-satisfaction-note',
        `${rows.length} scored runs; ${askedShare === null ? '—' : `${Math.round(askedShare * 100)}%`} asked ≥1 clarifying question (ask_user).`
          + (showTrend ? ' Dashed line = linear fit.' : ''),
        ctx.renderToken,
      );

      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: 300,
        data: { values: rows },
        layer: [
          {
            // Drop the dark per-point hairline and shrink the size range — with
            // jittered overlapping points the outlines formed a noisy mesh.
            mark: { type: 'point' as const, filled: true, opacity: 0.5 },
            encoding: {
              x: {
                field: 'questionsJitter',
                type: 'quantitative' as const,
                title: 'Clarifying questions asked (ask_user calls)',
                scale: { domain: [0, Math.max(maxQuestionsJitter, 1)] },
              },
              y: { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction', scale: { domain: [1, 5] } },
              color: {
                field: 'resolution',
                type: 'nominal' as const,
                scale: {
                  domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
                  range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
                },
                title: 'Resolution',
                legend: { orient: 'bottom' as const, direction: 'horizontal' as const, columns: 4, symbolLimit: 4, labelLimit: 200 },
              },
              size: {
                field: 'lineMutationTotal',
                type: 'quantitative' as const,
                title: 'Line changes',
                scale: { range: [40, 180] },
                legend: { orient: 'bottom' as const, gradientLength: 120 },
              },
              tooltip: [
                { field: 'model', type: 'nominal' as const, title: 'Model family' },
                { field: 'resolution', type: 'nominal' as const, title: 'Resolution' },
                { field: 'questions', type: 'quantitative' as const, title: 'Questions asked' },
                { field: 'satisfaction', type: 'quantitative' as const, title: 'Satisfaction' },
                { field: 'toolFailureCount', type: 'quantitative' as const, title: 'Tool failures' },
                { field: 'lineMutationTotal', type: 'quantitative' as const, title: 'Line changes' },
                { field: 'busyMinutes', type: 'quantitative' as const, title: 'Busy minutes', format: '.1f' },
              ],
            },
          },
          ...(showTrend ? [{
            transform: [{ regression: 'satisfaction', on: 'questions', method: 'linear' }],
            mark: { type: 'line' as const, strokeDash: [6, 4], strokeWidth: 2, opacity: 0.5 },
            encoding: {
              x: {
                field: 'questions',
                type: 'quantitative' as const,
                scale: { domain: [0, Math.max(maxQuestionsJitter, 1)] },
              },
              y: { field: 'satisfaction', type: 'quantitative' as const, scale: { domain: [1, 5] } },
              color: { value: CHART_COLORS.accent },
            },
          }] : []),
        ],
      };
      await ctx.renderSpec('chart-questions-vs-satisfaction', spec, 'No scored runs match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-questions-dose-response',
    render: async (ctx: ChartContext) => {
      const runIds = selectedRunIds(ctx.runs);
      const questionCounts = questionCountByRun(ctx.toolRows, runIds);
      const rows = questionDoseRows(ctx.runs, questionCounts);

      const scoredTotal = rows.reduce((sum, row) => sum + row.scoredRunCount, 0);
      ctx.setNote(
        'questions-dose-response-note',
        rows.length === 0
          ? 'Need scored runs to bucket by clarifying-question count.'
          : `${rows.length} question-count buckets; mean satisfaction (95% CI) across ${scoredTotal} scored runs. Hover for resolved share.`,
        ctx.renderToken,
      );

      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rows.length, 44, 200),
        data: { values: rows },
        layer: [
          {
            mark: { type: 'rule' as const, strokeWidth: 2.2, opacity: 0.7 },
            encoding: {
              y: {
                field: 'bucket',
                type: 'nominal' as const,
                sort: { field: 'bucketIndex', order: 'ascending' },
                title: null,
                axis: { labelLimit: 200 },
              },
              x: { field: 'ciLower', type: 'quantitative' as const, title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
              x2: { field: 'ciUpper' },
              color: { value: CHART_COLORS.accent2 },
              tooltip: [
                { field: 'bucket', type: 'nominal' as const, title: 'Questions' },
                { field: 'meanSatisfaction', type: 'quantitative' as const, title: 'Mean satisfaction', format: '.2f' },
                { field: 'ciLabel', type: 'nominal' as const, title: 'Interval' },
                { field: 'resolvedRate', type: 'quantitative' as const, title: 'Resolved rate', format: '.0%' },
                { field: 'resolveCiLabel', type: 'nominal' as const, title: 'Resolved CI' },
                { field: 'meanQuestions', type: 'quantitative' as const, title: 'Mean questions', format: '.2f' },
                { field: 'nLabel', type: 'nominal' as const, title: 'Scored / total' },
              ],
            },
          },
          {
            mark: { type: 'point' as const, filled: true, size: 180, opacity: 0.95 },
            encoding: {
              y: {
                field: 'bucket',
                type: 'nominal' as const,
                sort: { field: 'bucketIndex', order: 'ascending' },
                title: null,
              },
              x: { field: 'meanSatisfaction', type: 'quantitative' as const, scale: { domain: [1, 5] } },
              color: { value: CHART_COLORS.accent2 },
              tooltip: [
                { field: 'bucket', type: 'nominal' as const, title: 'Questions' },
                { field: 'meanSatisfaction', type: 'quantitative' as const, title: 'Mean satisfaction', format: '.2f' },
                { field: 'ciLabel', type: 'nominal' as const, title: 'Interval' },
                { field: 'resolvedRate', type: 'quantitative' as const, title: 'Resolved rate', format: '.0%' },
                { field: 'nLabel', type: 'nominal' as const, title: 'Scored / total' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-questions-dose-response', spec, 'No scored runs match the current filters.', ctx.renderToken);
    },
  },
];
