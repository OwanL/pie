import type { ChartContext, ChartEntry } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, completedRuns, median, modelFamilyKey, selectedRunIds } from '../lib.ts';

interface TimingComponentRow {
  component: string;
  medianMs: number;
  observationCount: number;
}

export function runtimeFrictionTimingRows(ctx: ChartContext): TimingComponentRow[] {
  const completed = completedRuns(ctx.runs);
  const runIds = selectedRunIds(completed);
  const prepass = completed
    .map((run) => run.skillPruningPrepassDurationMs)
    .filter((value): value is number => value !== null);
  const queue = ctx.turnThroughputRows
    .filter((row) => runIds.has(row.runId) && row.providerQueueMs !== null)
    .map((row) => row.providerQueueMs!);
  const retries = ctx.retryTimingRows.filter((row) => runIds.has(row.runId));
  const measuredRetry = retries
    .map((row) => row.measuredDelayMs)
    .filter((value): value is number => value !== null);
  const retryDuration = retries
    .map((row) => row.durationMs)
    .filter((value): value is number => value !== null);
  const components: Array<[string, number[]]> = [
    ['Skill-pruning prepass', prepass],
    ['Provider queue', queue],
    ['Retry scheduled delay', retries.map((row) => row.scheduledDelayMs)],
    ['Retry measured delay', measuredRetry],
    ['Retry episode duration', retryDuration],
  ];
  return components.flatMap(([component, values]) => {
    const medianMs = median(values);
    return medianMs === null ? [] : [{ component, medianMs: Math.round(medianMs), observationCount: values.length }];
  });
}

async function renderRuntimeFrictionTiming(ctx: ChartContext): Promise<void> {
  const rows = runtimeFrictionTimingRows(ctx);
  const covered = new Map(rows.map((row) => [row.component, row.observationCount]));
  ctx.setNote(
    'runtime-friction-timing-note',
    rows.length === 0
      ? 'No measured prepass, provider-queue, or retry timing telemetry matches the current filters; historical absence is not treated as zero.'
      : `Measured observations only — prepass n=${covered.get('Skill-pruning prepass') ?? 0}, queue turns n=${covered.get('Provider queue') ?? 0}, retry attempts n=${covered.get('Retry scheduled delay') ?? 0}. Missing legacy telemetry is excluded.`,
    ctx.renderToken,
  );
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(rows.length, 34, 180, 300),
    data: { values: rows },
    mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.86 },
    encoding: {
      y: { field: 'component', type: 'nominal' as const, sort: rows.map((row) => row.component), title: null, axis: { labelLimit: 240 } },
      x: { field: 'medianMs', type: 'quantitative' as const, title: 'Median measured duration / delay (ms)', axis: { format: ',.0f' } },
      color: {
        field: 'component',
        type: 'nominal' as const,
        legend: null,
        scale: { range: [CHART_COLORS.accent2, CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted] },
      },
      tooltip: [
        { field: 'component', type: 'nominal' as const, title: 'Signal' },
        { field: 'medianMs', type: 'quantitative' as const, title: 'Median (ms)', format: ',.0f' },
        { field: 'observationCount', type: 'quantitative' as const, title: 'Measured observations' },
      ],
    },
  };
  await ctx.renderSpec('chart-runtime-friction-timing', spec, 'No measured runtime-friction timing data matches the current filters.', ctx.renderToken);
}

interface ToolOverlapRow {
  model: string;
  component: 'Cumulative' | 'Critical path' | 'Parallel overlap';
  medianMs: number;
  runCount: number;
  medianCumulativeMs: number;
}

export function toolTimeOverlapRows(ctx: ChartContext): ToolOverlapRow[] {
  const byModel = new Map<string, Array<{ cumulative: number; critical: number }>>();
  for (const run of completedRuns(ctx.runs)) {
    if (run.criticalPathDurationMs === null) continue;
    const rows = byModel.get(modelFamilyKey(run)) ?? [];
    rows.push({ cumulative: run.toolDurationMs, critical: run.criticalPathDurationMs });
    byModel.set(modelFamilyKey(run), rows);
  }
  return [...byModel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([model, values]) => {
      const critical = median(values.map((value) => value.critical)) ?? 0;
      const overlap = median(values.map((value) => Math.max(0, value.cumulative - value.critical))) ?? 0;
      // Medians do not generally distribute over subtraction. Treat the
      // component medians as the displayed aggregate, so the stack total and
      // its cumulative reference are algebraically identical.
      const criticalMs = Math.round(critical);
      const cumulativeMs = Math.round(critical + overlap);
      // Round the displayed overlap as the residual, rather than independently,
      // so the integer stack total always equals the displayed reference.
      const overlapMs = cumulativeMs - criticalMs;
      return [
        { model, component: 'Cumulative' as const, medianMs: cumulativeMs, runCount: values.length, medianCumulativeMs: cumulativeMs },
        { model, component: 'Critical path' as const, medianMs: criticalMs, runCount: values.length, medianCumulativeMs: cumulativeMs },
        { model, component: 'Parallel overlap' as const, medianMs: overlapMs, runCount: values.length, medianCumulativeMs: cumulativeMs },
      ];
    });
}

async function renderToolTimeOverlap(ctx: ChartContext): Promise<void> {
  const rows = toolTimeOverlapRows(ctx);
  const modelCount = new Set(rows.map((row) => row.model)).size;
  const runCount = rows.filter((row) => row.component === 'Cumulative').reduce((sum, row) => sum + row.runCount, 0);
  ctx.setNote(
    'tool-time-overlap-note',
    rows.length === 0
      ? 'No runs with critical-path tool timing match the current filters; historical absence is not treated as zero overlap.'
      : `${runCount} measured runs across ${modelCount} models. Stacked bars show critical path + parallel overlap; the displayed cumulative reference is their aggregate sum (overlap = cumulative − critical path, computed per run before aggregation).`,
    ctx.renderToken,
  );
  const models = [...new Set(rows.map((row) => row.model))];
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(models.length),
    data: { values: rows },
    // Cumulative = critical path + parallel overlap, so showing all three as
    // independent grouped bars double-counts. Stack the two parts instead; their
    // total equals cumulative (kept in the tooltip as a reference).
    transform: [{ filter: 'datum.component !== "Cumulative"' }],
    mark: { type: 'bar' as const, cornerRadiusEnd: 2, opacity: 0.86 },
    encoding: {
      y: { field: 'model', type: 'nominal' as const, sort: models, title: null, axis: { labelLimit: 260 } },
      x: { field: 'medianMs', type: 'quantitative' as const, title: 'Median tool time (ms) — critical path + overlap = cumulative', axis: { format: ',.0f' } },
      color: {
        field: 'component', type: 'nominal' as const, title: 'Tool time',
        scale: { domain: ['Critical path', 'Parallel overlap'], range: [CHART_COLORS.accent, CHART_COLORS.gold] },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'component', type: 'nominal' as const, title: 'Component' },
        { field: 'medianMs', type: 'quantitative' as const, title: 'Median component (ms)', format: ',.0f' },
        { field: 'medianCumulativeMs', type: 'quantitative' as const, title: 'Displayed cumulative reference (ms)', format: ',.0f' },
        { field: 'runCount', type: 'quantitative' as const, title: 'Measured runs' },
      ],
    },
  };
  await ctx.renderSpec('chart-tool-time-overlap', spec, 'No critical-path tool timing data matches the current filters.', ctx.renderToken);
}

export const latencyFrictionCharts: ChartEntry[] = [
  { id: 'chart-runtime-friction-timing', runCohort: 'current-harness', render: renderRuntimeFrictionTiming },
  { id: 'chart-tool-time-overlap', runCohort: 'current-harness', render: renderToolTimeOverlap },
];
