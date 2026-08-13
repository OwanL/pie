import type { ChartEntry, ChartContext } from '../lib.ts';
import {
  CHART_COLORS,
  categoricalHeight,
  completedRuns,
  estimatedRunCostUsd,
  median,
  modelColorScale,
  modelFamilyKey,
  selectedRunIds,
  sortNatural,
  uniqueNonEmpty,
} from '../lib.ts';
import type { PreparedRunRow, PreparedTurnThroughputRow } from '../../scripts/contracts.ts';
import type { VerificationCommandKind } from '../../scripts/contracts.ts';

const VERIFICATION_KINDS: VerificationCommandKind[] = ['test', 'build', 'lint', 'typecheck', 'format', 'other'];

type FamilyTurnThroughputRow = PreparedTurnThroughputRow & { modelFamily: string };

function filteredThroughputRows(ctx: ChartContext): FamilyTurnThroughputRow[] {
  const runIds = selectedRunIds(ctx.runs);
  const familyByRun = new Map(ctx.runs.map((run) => [run.runId, modelFamilyKey(run)]));
  return ctx.turnThroughputRows
    .filter(
      (row) =>
        runIds.has(row.runId) &&
        row.turnLatencyMs !== null &&
        row.overheadMs !== null &&
        row.providerLatencyMs !== null,
    )
    .map((row) => ({ ...row, modelFamily: familyByRun.get(row.runId) ?? modelFamilyKey(row) }));
}

function latencyDecompositionTable(rows: FamilyTurnThroughputRow[]) {
  const byModel = new Map<string, { overhead: number[]; provider: number[]; count: number }>();
  for (const row of rows) {
    const model = modelFamilyKey(row);
    const entry = byModel.get(model) ?? { overhead: [], provider: [], count: 0 };
    entry.overhead.push(row.overheadMs!);
    entry.provider.push(row.providerLatencyMs!);
    entry.count += 1;
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => {
      const overhead = Math.round(median(e.overhead) ?? 0);
      const provider = Math.round(median(e.provider) ?? 0);
      return {
        model,
        overhead,
        provider,
        total: overhead + provider,
        turnCount: e.count,
      };
    })
    .filter((r) => r.turnCount >= 2)
    .sort((a, b) => b.total - a.total)
    .slice(0, 14);
}

function renderLatencyDecomposition(ctx: ChartContext) {
  const rows = filteredThroughputRows(ctx);
  const table = latencyDecompositionTable(rows);
  const note = `${rows.length} assistant turns; overhead = our inter-turn work (turn boundary → turn_start); provider = request prep + network + TTFT (turn_start → first token).`;
  ctx.setNote('latency-decomposition-note', note, ctx.renderToken);

  const values = table.flatMap((r) => [
    { model: r.model, component: 'Overhead', ms: r.overhead },
    { model: r.model, component: 'Provider latency', ms: r.provider },
  ]);
  const spec = values.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(table.length),
    data: { values },
    mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
    encoding: {
      y: {
        field: 'model',
        type: 'nominal' as const,
        sort: table.map((r) => r.model),
        title: null,
        axis: { labelLimit: 260 },
      },
      x: {
        field: 'ms',
        type: 'quantitative' as const,
        title: 'Median latency per turn (ms)',
        axis: { format: ',.0f' },
      },
      color: {
        field: 'component',
        type: 'nominal' as const,
        title: 'Latency component',
        scale: {
          domain: ['Overhead', 'Provider latency'],
          range: [CHART_COLORS.accent, CHART_COLORS.coral],
        },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'component', type: 'nominal' as const, title: 'Component' },
        { field: 'ms', type: 'quantitative' as const, title: 'Median (ms)', format: ',.0f' },
        { field: 'turnCount', type: 'quantitative' as const, title: 'Turns' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-latency-decomposition',
    spec,
    'No completed turns with latency decomposition data match the current filters.',
    ctx.renderToken,
  );
}

interface CostEfficiencyRow {
  model: string;
  medianCostPerLine: number;
  medianCostPerRun: number;
  medianLinesPerRun: number;
  runCount: number;
}

function costEfficiencyTable(runs: PreparedRunRow[]): CostEfficiencyRow[] {
  const byModel = new Map<string, { costPerLine: number[]; costPerRun: number[]; linesPerRun: number[] }>();
  for (const run of completedRuns(runs)) {
    const cost = estimatedRunCostUsd(run);
    if (cost === null || cost <= 0 || run.lineMutationTotal <= 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? { costPerLine: [], costPerRun: [], linesPerRun: [] };
    entry.costPerLine.push(cost / run.lineMutationTotal);
    entry.costPerRun.push(cost);
    entry.linesPerRun.push(run.lineMutationTotal);
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      medianCostPerLine: median(e.costPerLine) ?? 0,
      medianCostPerRun: median(e.costPerRun) ?? 0,
      medianLinesPerRun: median(e.linesPerRun) ?? 0,
      runCount: e.costPerLine.length,
    }))
    .filter((r) => r.runCount >= 2)
    .sort((a, b) => a.medianCostPerLine - b.medianCostPerLine)
    .slice(0, 14);
}

function renderCostEfficiency(ctx: ChartContext) {
  const rows = costEfficiencyTable(ctx.runs);
  const totalRuns = rows.reduce((sum, r) => sum + r.runCount, 0);
  ctx.setNote(
    'cost-efficiency-note',
    `${rows.length} models, ${totalRuns} priced runs with code changes. Lower = cheaper per line of code mutated.`,
    ctx.renderToken,
  );
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(rows.length),
    data: { values: rows },
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
        field: 'medianCostPerLine',
        type: 'quantitative' as const,
        title: 'Median cost per line mutated (USD)',
        axis: { format: '$.4f' },
      },
      color: { value: CHART_COLORS.gold },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'medianCostPerLine', type: 'quantitative' as const, title: 'Cost / line', format: '$.4f' },
        { field: 'medianCostPerRun', type: 'quantitative' as const, title: 'Cost / run', format: '$.4f' },
        { field: 'medianLinesPerRun', type: 'quantitative' as const, title: 'Lines / run', format: '.0f' },
        { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-cost-efficiency',
    spec,
    'No completed runs with both cost and code mutation data match the current filters.',
    ctx.renderToken,
  );
}

interface CostPerMinuteRow {
  model: string;
  medianCostPerMinute: number;
  runCount: number;
}

function costPerMinuteTable(runs: PreparedRunRow[]): CostPerMinuteRow[] {
  const byModel = new Map<string, number[]>();
  for (const run of completedRuns(runs)) {
    const cost = estimatedRunCostUsd(run);
    if (cost === null || cost <= 0 || run.busyDurationMs <= 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? [];
    entry.push(cost / (run.busyDurationMs / 60000));
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, values]) => ({
      model,
      medianCostPerMinute: median(values) ?? 0,
      runCount: values.length,
    }))
    .filter((r) => r.runCount >= 2)
    .sort((a, b) => a.medianCostPerMinute - b.medianCostPerMinute)
    .slice(0, 14);
}

function renderCostPerMinute(ctx: ChartContext) {
  const rows = costPerMinuteTable(ctx.runs);
  const totalRuns = rows.reduce((sum, r) => sum + r.runCount, 0);
  ctx.setNote(
    'cost-per-minute-note',
    `${rows.length} models, ${totalRuns} priced completed runs. Dollar spend per minute of agent busy-time; lower = more cost-efficient throughput.`,
    ctx.renderToken,
  );
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(rows.length),
    data: { values: rows },
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
        field: 'medianCostPerMinute',
        type: 'quantitative' as const,
        title: 'Median cost per busy minute (USD)',
        axis: { format: '$.2f' },
      },
      color: { value: CHART_COLORS.coral },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'medianCostPerMinute', type: 'quantitative' as const, title: 'Cost / minute', format: '$.4f' },
        { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-cost-per-minute',
    spec,
    'No completed runs with both cost and busy-time data match the current filters.',
    ctx.renderToken,
  );
}

interface VerificationKindRow {
  kind: VerificationCommandKind;
  count: number;
}

function verificationKindBreakdown(runs: PreparedRunRow[]): VerificationKindRow[] {
  const totals: Record<VerificationCommandKind, number> = {
    test: 0,
    build: 0,
    lint: 0,
    typecheck: 0,
    format: 0,
    other: 0,
  };
  for (const run of completedRuns(runs)) {
    for (const kind of VERIFICATION_KINDS) {
      totals[kind] += run.verificationCountsByKind[kind] ?? 0;
    }
  }
  return VERIFICATION_KINDS.map((kind) => ({ kind, count: totals[kind] })).filter((r) => r.count > 0);
}

function renderVerificationKindBreakdown(ctx: ChartContext) {
  const rows = verificationKindBreakdown(ctx.runs);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const runCount = completedRuns(ctx.runs).filter((r) =>
    VERIFICATION_KINDS.some((kind) => (r.verificationCountsByKind[kind] ?? 0) > 0),
  ).length;
  ctx.setNote(
    'verification-kind-breakdown-note',
    `${total.toLocaleString()} verification commands across ${runCount} completed runs; mix by command kind.`,
    ctx.renderToken,
  );
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: 180,
    data: { values: rows },
    mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
    encoding: {
      y: { datum: 'All models', type: 'nominal' as const, title: null },
      x: {
        field: 'count',
        type: 'quantitative' as const,
        title: 'Total verification commands',
        axis: { format: ',.0f' },
      },
      color: {
        field: 'kind',
        type: 'nominal' as const,
        title: 'Verification kind',
        scale: {
          domain: VERIFICATION_KINDS,
          range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.accent2, CHART_COLORS.success, CHART_COLORS.muted],
        },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'kind', type: 'nominal' as const, title: 'Kind' },
        { field: 'count', type: 'quantitative' as const, title: 'Count', format: ',.0f' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-verification-kind-breakdown',
    spec,
    'No verification commands recorded for completed runs matching the current filters.',
    ctx.renderToken,
  );
}

interface NetMutationRow {
  model: string;
  additions: number;
  deletions: number;
  modifications: number;
  net: number;
}

function netMutationTable(runs: PreparedRunRow[]): NetMutationRow[] {
  const byModel = new Map<string, { additions: number; deletions: number; modifications: number }>();
  for (const run of completedRuns(runs)) {
    if (run.lineAdditions + run.lineDeletions + run.lineModifications <= 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? { additions: 0, deletions: 0, modifications: 0 };
    entry.additions += run.lineAdditions;
    entry.deletions += run.lineDeletions;
    entry.modifications += run.lineModifications;
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      ...e,
      net: e.additions - e.deletions,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 14);
}

function renderNetMutation(ctx: ChartContext) {
  const table = netMutationTable(ctx.runs);
  const totalNet = table.reduce((sum, r) => sum + r.net, 0);
  ctx.setNote(
    'net-mutation-note',
    `${table.length} models with code changes. Net growth = additions − deletions (overall ${totalNet >= 0 ? '+' : ''}${totalNet.toLocaleString()} lines).`,
    ctx.renderToken,
  );
  const spec = table.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(table.length),
    data: { values: table },
    transform: [
      { fold: ['additions', 'deletions', 'modifications'] as ['additions', 'deletions', 'modifications'], as: ['component', 'count'] as ['component', 'count'] },
    ],
    mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
    encoding: {
      y: {
        field: 'model',
        type: 'nominal' as const,
        sort: table.map((r) => r.model),
        title: null,
        axis: { labelLimit: 260 },
      },
      x: {
        field: 'count',
        type: 'quantitative' as const,
        title: 'Lines of code',
        axis: { format: ',.0f' },
      },
      color: {
        field: 'component',
        type: 'nominal' as const,
        title: 'Change type',
        scale: {
          domain: ['additions', 'deletions', 'modifications'],
          range: [CHART_COLORS.success, CHART_COLORS.coral, CHART_COLORS.gold],
        },
        legend: { orient: 'bottom' as const },
      },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'component', type: 'nominal' as const, title: 'Change type' },
        { field: 'count', type: 'quantitative' as const, title: 'Lines', format: ',.0f' },
        { field: 'additions', type: 'quantitative' as const, title: 'Additions', format: ',.0f' },
        { field: 'deletions', type: 'quantitative' as const, title: 'Deletions', format: ',.0f' },
        { field: 'modifications', type: 'quantitative' as const, title: 'Modifications', format: ',.0f' },
        { field: 'net', type: 'quantitative' as const, title: 'Net growth', format: ',.0f' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-net-mutation',
    spec,
    'No completed runs with line mutations match the current filters.',
    ctx.renderToken,
  );
}

interface BusyFragmentationPoint {
  runId: string;
  model: string;
  busyMinutes: number;
  periods: number;
}

function busyFragmentationPoints(runs: PreparedRunRow[]): { points: BusyFragmentationPoint[]; models: string[] } {
  const points = completedRuns(runs)
    .filter((run) => run.busyDurationMs > 0)
    .map((run) => ({
      runId: run.runId,
      model: modelFamilyKey(run),
      busyMinutes: Math.round((run.busyDurationMs / 60000) * 10) / 10,
      periods: run.busyPeriodCount,
    }));
  return { points, models: sortNatural(uniqueNonEmpty(points.map((p) => p.model))) };
}

function renderBusyFragmentation(ctx: ChartContext) {
  const { points, models } = busyFragmentationPoints(ctx.runs);
  ctx.setNote(
    'busy-fragmentation-note',
    `${points.length} completed runs. Many short bursts = fragmented attention.`,
    ctx.renderToken,
  );
  const spec = points.length === 0 ? null : {
    width: 'container',
    height: 300,
    data: { values: points },
    mark: { type: 'circle' as const, filled: true, opacity: 0.55, size: 60 },
    encoding: {
      x: {
        field: 'busyMinutes',
        type: 'quantitative' as const,
        title: 'Busy duration (minutes)',
        scale: { zero: true, nice: true },
      },
      y: {
        field: 'periods',
        type: 'quantitative' as const,
        title: 'Busy-period count',
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
        { field: 'runId', type: 'nominal' as const, title: 'Run' },
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'busyMinutes', type: 'quantitative' as const, title: 'Busy minutes', format: '.1f' },
        { field: 'periods', type: 'quantitative' as const, title: 'Busy periods' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-busy-fragmentation',
    spec,
    'No completed runs with busy-time data match the current filters.',
    ctx.renderToken,
    'canvas',
  );
}

interface TokenCoverageRow {
  model: string;
  coverage: number;
  runCount: number;
  medianTurns: number;
}

function tokenCoverageTable(runs: PreparedRunRow[]): TokenCoverageRow[] {
  const byModel = new Map<string, { ratios: number[]; turns: number[] }>();
  for (const run of completedRuns(runs)) {
    if (run.assistantTurnCount <= 0) {
      continue;
    }
    const model = modelFamilyKey(run);
    const entry = byModel.get(model) ?? { ratios: [], turns: [] };
    entry.ratios.push(run.tokenReportedTurnCount / run.assistantTurnCount);
    entry.turns.push(run.assistantTurnCount);
    byModel.set(model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      coverage: median(e.ratios) ?? 0,
      runCount: e.ratios.length,
      medianTurns: Math.round(median(e.turns) ?? 0),
    }))
    .filter((r) => r.runCount >= 2)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, 14);
}

function renderTokenCoverage(ctx: ChartContext) {
  const rows = tokenCoverageTable(ctx.runs);
  const totalRuns = rows.reduce((sum, r) => sum + r.runCount, 0);
  ctx.setNote(
    'token-coverage-note',
    `${rows.length} models, ${totalRuns} completed runs. Fraction of assistant turns that reported provider usage; low coverage = cost/token metrics unreliable.`,
    ctx.renderToken,
  );
  const spec = rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(rows.length),
    data: { values: rows },
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
        field: 'coverage',
        type: 'quantitative' as const,
        title: 'Median token-reporting coverage',
        scale: { domain: [0, 1] },
        axis: { format: '.0%' },
      },
      color: { value: CHART_COLORS.accent2 },
      tooltip: [
        { field: 'model', type: 'nominal' as const, title: 'Model' },
        { field: 'coverage', type: 'quantitative' as const, title: 'Coverage', format: '.1%' },
        { field: 'medianTurns', type: 'quantitative' as const, title: 'Median turns / run' },
        { field: 'runCount', type: 'quantitative' as const, title: 'Runs' },
      ],
    },
  };
  return ctx.renderSpec(
    'chart-token-coverage',
    spec,
    'No completed runs with assistant-turn data match the current filters.',
    ctx.renderToken,
  );
}

export const insightsCharts: ChartEntry[] = [
  {
    id: 'chart-latency-decomposition',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderLatencyDecomposition(ctx),
  },
  {
    id: 'chart-cost-efficiency',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderCostEfficiency(ctx),
  },
  {
    id: 'chart-cost-per-minute',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderCostPerMinute(ctx),
  },
  {
    id: 'chart-verification-kind-breakdown',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderVerificationKindBreakdown(ctx),
  },
  {
    id: 'chart-net-mutation',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderNetMutation(ctx),
  },
  {
    id: 'chart-busy-fragmentation',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderBusyFragmentation(ctx),
  },
  {
    id: 'chart-token-coverage',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => renderTokenCoverage(ctx),
  },
];
