import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  average,
  categoricalHeight,
  completedRuns,
  estimatedRunCostUsd,
  modelColorScale,
  modelFamilyKey,
  selectedRunIds,
  sortNatural,
  uniqueNonEmpty,
} from '../lib.ts';
import type { PreparedRunRow, PreparedTurnThroughputRow } from '../../scripts/contracts.ts';

// ─── 1. Subagent cost attribution ────────────────────────────────────────────

interface SubagentCostRow {
  model: string;
  parentCostUsd: number;
  subagentCostUsd: number;
  totalCostUsd: number;
  runCount: number;
  runsWithSubagents: number;
}

/**
 * Stacked cost by model: parent-run spend (estimatedCostUsd) vs the spend
 * spawned sub-agent sessions add on top (subagentEstimatedCostUsd). Subagent
 * sessions bill separately and were historically excluded from run cost, so the
 * top segment is "hidden" spend that totalEstimatedCostUsd now captures.
 */
function subagentCostRows(runs: PreparedRunRow[]): SubagentCostRow[] {
  const byModel = new Map<string, { parent: number; subagent: number; runs: number; withSub: number }>();
  for (const run of completedRuns(runs)) {
    const total = estimatedRunCostUsd(run) ?? 0;
    const parent = Math.min(run.estimatedCostUsd ?? 0, total);
    const subagent = Math.max(0, total - parent);
    if (total === 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? { parent: 0, subagent: 0, runs: 0, withSub: 0 };
    entry.parent += parent;
    entry.subagent += subagent;
    entry.runs += 1;
    if (subagent > 0) {
      entry.withSub += 1;
    }
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      parentCostUsd: Math.round(e.parent * 10000) / 10000,
      subagentCostUsd: Math.round(e.subagent * 10000) / 10000,
      totalCostUsd: Math.round((e.parent + e.subagent) * 10000) / 10000,
      runCount: e.runs,
      runsWithSubagents: e.withSub,
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

const subagentCostChart: ChartEntry = {
  id: 'chart-subagent-cost-attribution',
  render: async (ctx: ChartContext) => {
    const cohort = subagentCostRows(ctx.runs);
    const rows = cohort.slice(0, 12);
    const totalSubagent = cohort.reduce((sum, row) => sum + row.subagentCostUsd, 0);
    const grandTotal = cohort.reduce((sum, row) => sum + row.totalCostUsd, 0);
    const share = grandTotal > 0 ? Math.round((totalSubagent / grandTotal) * 100) : 0;
    ctx.setNote(
      'subagent-cost-attribution-note',
      `Top ${rows.length} of ${cohort.length} model families. Full filtered-cohort spend is $${Math.round(grandTotal * 100) / 100}; subagent sessions account for ${share}% ($${Math.round(totalSubagent * 100) / 100}). Components use only complete parent + applicable subagent totals; unknown totals are omitted.`,
      ctx.renderToken,
    );

    const values = rows.flatMap((r) => [
      { model: r.model, component: 'Parent run', costUsd: r.parentCostUsd, total: r.totalCostUsd },
      { model: r.model, component: 'Subagent sessions', costUsd: r.subagentCostUsd, total: r.totalCostUsd },
    ]);
    const spec = values.length === 0 ? null : {
      width: 'container',
      height: categoricalHeight(rows.length),
      data: { values },
      mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
      encoding: {
        y: {
          field: 'model',
          type: 'nominal' as const,
          sort: rows.map((r) => r.model),
          title: null,
          axis: { labelLimit: 260 },
        },
        x: {
          field: 'costUsd',
          type: 'quantitative' as const,
          title: 'Estimated cost (USD)',
          axis: { format: '$.2f' },
        },
        color: {
          field: 'component',
          type: 'nominal' as const,
          title: 'Cost source',
          scale: { domain: ['Parent run', 'Subagent sessions'], range: [CHART_COLORS.accent, CHART_COLORS.coral] },
          legend: { orient: 'bottom' as const },
        },
        tooltip: [
          { field: 'model', type: 'nominal' as const, title: 'Model' },
          { field: 'component', type: 'nominal' as const, title: 'Source' },
          { field: 'costUsd', type: 'quantitative' as const, title: 'Cost', format: '$.4f' },
          { field: 'total', type: 'quantitative' as const, title: 'Model total', format: '$.2f' },
        ],
      },
    };
    await ctx.renderSpec(
      'chart-subagent-cost-attribution',
      spec,
      'No completed runs with cost data match the current filters.',
      ctx.renderToken,
    );
  },
};

// ─── 2. Context-window growth trajectory ────────────────────────────────────

interface ContextGrowthPoint {
  turnOrdinal: number;
  contextTokens: number;
  model: string;
  runId: string;
}

/**
 * Per-turn context-window size over the course of each run (turn 0 → N). A
 * rising trajectory shows context bloat — each turn costs more input tokens and
 * approaches the compaction threshold. Points are colored by model; one point
 * per turn with a reported context size.
 */
function contextGrowthPoints(ctx: ChartContext): { points: ContextGrowthPoint[]; models: string[] } {
  const runIds = selectedRunIds(ctx.runs);
  const relevant = ctx.turnThroughputRows
    .filter((row) => runIds.has(row.runId) && row.contextTokens !== null && row.contextTokens > 0);

  // Group by run, sort each run's turns chronologically, assign a 0-based ordinal.
  const byRun = new Map<string, PreparedTurnThroughputRow[]>();
  for (const row of relevant) {
    const entry = byRun.get(row.runId) ?? [];
    entry.push(row);
    byRun.set(row.runId, entry);
  }

  const familyByRun = new Map(ctx.runs.map((run) => [run.runId, modelFamilyKey(run)]));
  const points: ContextGrowthPoint[] = [];
  for (const [runId, rows] of byRun) {
    rows.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const model = familyByRun.get(runId) ?? modelFamilyKey(rows[0] ?? {});
    rows.forEach((row, index) => {
      points.push({
        turnOrdinal: index,
        contextTokens: row.contextTokens!,
        model,
        runId,
      });
    });
  }
  return { points, models: sortNatural(uniqueNonEmpty(points.map((p) => p.model))) };
}

const contextGrowthChart: ChartEntry = {
  id: 'chart-context-growth',
  render: async (ctx: ChartContext) => {
    const { points, models } = contextGrowthPoints(ctx);
    const runCount = new Set(points.map((p) => p.runId)).size;
    ctx.setNote(
      'context-growth-note',
      `${points.length} turns across ${runCount} runs. Rising trajectory = context bloat: each turn re-processes more input (higher cost) and nears the compaction threshold.`,
      ctx.renderToken,
    );

    const spec = points.length === 0 ? null : {
      width: 'container',
      height: 280,
      data: { values: points },
      mark: { type: 'circle' as const, filled: true, opacity: 0.35, size: 35 },
      encoding: {
        x: {
          field: 'turnOrdinal',
          type: 'quantitative' as const,
          title: 'Turn number within run',
          scale: { zero: true, nice: true },
        },
        y: {
          field: 'contextTokens',
          type: 'quantitative' as const,
          title: 'Context window (tokens)',
          scale: { zero: true, nice: true },
        },
        color: {
          field: 'model',
          type: 'nominal' as const,
          title: 'Model',
          sort: models,
          scale: modelColorScale(models),
          legend: { orient: 'bottom' as const },
        },
        tooltip: [
          { field: 'model', type: 'nominal' as const, title: 'Model' },
          { field: 'turnOrdinal', type: 'quantitative' as const, title: 'Turn #', format: '.0f' },
          { field: 'contextTokens', type: 'quantitative' as const, title: 'Context tokens', format: ',.0f' },
          { field: 'runId', type: 'nominal' as const, title: 'Run' },
        ],
      },
    };
    await ctx.renderSpec(
      'chart-context-growth',
      spec,
      'No turns with context-size data match the current filters (recorded only on recent runs).',
      ctx.renderToken,
      'canvas',
    );
  },
};

// ─── 3. Compaction & auto-retry friction ─────────────────────────────────────

interface FrictionRow {
  model: string;
  meanCompaction: number;
  meanRetry: number;
  runCount: number;
  runsCompacted: number;
  runsRetried: number;
}

/**
 * Mean compaction and auto-retry events per run, by model. Both signal friction:
 * compaction = the context window filled and history was summarized (a hidden
 * billable LLM call + possible quality loss); auto-retry = the backend retried a
 * failed turn (reliability issue / wasted tokens). 0 for runs recorded before
 * tracking existed.
 */
function frictionRows(runs: PreparedRunRow[]): FrictionRow[] {
  const byModel = new Map<string, { compaction: number[]; retry: number[]; runs: number; compacted: number; retried: number }>();
  for (const run of completedRuns(runs)) {
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? { compaction: [], retry: [], runs: 0, compacted: 0, retried: 0 };
    entry.compaction.push(run.compactionCount ?? 0);
    entry.retry.push(run.autoRetryCount ?? 0);
    entry.runs += 1;
    if ((run.compactionCount ?? 0) > 0) entry.compacted += 1;
    if ((run.autoRetryCount ?? 0) > 0) entry.retried += 1;
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      meanCompaction: Math.round((average(e.compaction) ?? 0) * 1000) / 1000,
      meanRetry: Math.round((average(e.retry) ?? 0) * 1000) / 1000,
      runCount: e.runs,
      runsCompacted: e.compacted,
      runsRetried: e.retried,
    }))
    .filter((r) => r.meanCompaction > 0 || r.meanRetry > 0 || r.runCount >= 3)
    .sort((a, b) => (b.meanCompaction + b.meanRetry) - (a.meanCompaction + a.meanRetry))
    .slice(0, 14);
}

const frictionChart: ChartEntry = {
  id: 'chart-compaction-retry-friction',
  render: async (ctx: ChartContext) => {
    const rows = frictionRows(ctx.runs);
    const compactedRuns = rows.reduce((s, r) => s + r.runsCompacted, 0);
    const retriedRuns = rows.reduce((s, r) => s + r.runsRetried, 0);
    const totalRuns = rows.reduce((s, r) => s + r.runCount, 0);
    ctx.setNote(
      'compaction-retry-friction-note',
      `${rows.length} models, ${totalRuns} runs. Compaction fired in ${compactedRuns} run(s); auto-retry in ${retriedRuns}. Both = friction (compaction = hidden cost + context pressure; retry = reliability). 0 for legacy runs.`,
      ctx.renderToken,
    );

    const values = rows.flatMap((r) => [
      { model: r.model, component: 'Compaction', events: r.meanCompaction, runCount: r.runCount },
      { model: r.model, component: 'Auto-retry', events: r.meanRetry, runCount: r.runCount },
    ]);
    const spec = values.length === 0 ? null : {
      width: 'container',
      height: categoricalHeight(rows.length),
      data: { values },
      mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
      encoding: {
        y: {
          field: 'model',
          type: 'nominal' as const,
          sort: rows.map((r) => r.model),
          title: null,
          axis: { labelLimit: 260 },
        },
        x: {
          field: 'events',
          type: 'quantitative' as const,
          title: 'Mean events per run',
          axis: { format: '.2f' },
        },
        color: {
          field: 'component',
          type: 'nominal' as const,
          title: 'Friction source',
          scale: { domain: ['Compaction', 'Auto-retry'], range: [CHART_COLORS.gold, CHART_COLORS.coral] },
          legend: { orient: 'bottom' as const },
        },
        tooltip: [
          { field: 'model', type: 'nominal' as const, title: 'Model' },
          { field: 'component', type: 'nominal' as const, title: 'Source' },
          { field: 'events', type: 'quantitative' as const, title: 'Mean / run', format: '.3f' },
          { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
        ],
      },
    };
    await ctx.renderSpec(
      'chart-compaction-retry-friction',
      spec,
      'No completed runs match the current filters.',
      ctx.renderToken,
    );
  },
};

export const attributionCharts: ChartEntry[] = [
  subagentCostChart,
  contextGrowthChart,
  frictionChart,
];
