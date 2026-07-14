import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, completedRuns, meanInterval } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

const MIN_SCORED_PER_SETTING_GROUP = 3;

/** Common shape for a setting-dimension comparison row fed to Vega-Lite. */
export interface SettingImpactRow {
  group: string;
  avgSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  nLabel: string;
  runCount: number;
  scoredCount: number;
  resolutionRate: number | null;
}

export interface SettingComparison {
  rows: SettingImpactRow[];
  totalRunCount: number;
  totalScoredCount: number;
  trackedRunCount: number;
  trackedScoredCount: number;
}

function summarizeGroup(runs: PreparedRunRow[]): Omit<SettingImpactRow, 'group'> | null {
  const scored = runs.filter((run) => run.satisfaction !== null);
  if (scored.length < MIN_SCORED_PER_SETTING_GROUP) {
    return null;
  }
  const interval = meanInterval(scored.map((run) => run.satisfaction!), { min: 1, max: 5 });
  if (!interval) {
    return null;
  }
  const resolved = scored.filter((run) => run.resolution === 'resolved').length;
  return {
    avgSatisfaction: interval.mean,
    ciLower: interval.lower,
    ciUpper: interval.upper,
    ciLabel: interval.ciLabel,
    nLabel: `n=${scored.length}`,
    runCount: runs.length,
    scoredCount: scored.length,
    resolutionRate: Math.round((resolved / scored.length) * 1000) / 1000,
  };
}

/**
 * Pure setting comparison transform. Null group keys are untracked and are
 * excluded from displayed comparisons while remaining represented in coverage.
 */
export function settingComparisonRows(
  runs: PreparedRunRow[],
  groupForRun: (run: PreparedRunRow) => string | null,
  order: readonly string[] = [],
): SettingComparison {
  const completed = completedRuns(runs);
  const tracked = completed.flatMap((run) => {
    const group = groupForRun(run)?.trim();
    return group ? [{ group, run }] : [];
  });
  const groups = new Map<string, PreparedRunRow[]>();
  for (const { group, run } of tracked) {
    const groupRuns = groups.get(group) ?? [];
    groupRuns.push(run);
    groups.set(group, groupRuns);
  }

  const orderedGroups = [
    ...order.filter((group) => groups.has(group)),
    ...[...groups.keys()].filter((group) => !order.includes(group)),
  ];
  const rows = orderedGroups.flatMap((group) => {
    const summary = summarizeGroup(groups.get(group) ?? []);
    return summary ? [{ group, ...summary }] : [];
  });

  return {
    rows,
    totalRunCount: completed.length,
    totalScoredCount: completed.filter((run) => run.satisfaction !== null).length,
    trackedRunCount: tracked.length,
    trackedScoredCount: tracked.filter(({ run }) => run.satisfaction !== null).length,
  };
}

function coverageText(comparison: SettingComparison): string {
  const untracked = comparison.totalRunCount - comparison.trackedRunCount;
  return `${comparison.trackedRunCount}/${comparison.totalRunCount} completed runs tracked; `
    + `${comparison.trackedScoredCount}/${comparison.totalScoredCount} scored runs tracked; `
    + `${untracked} untracked completed run${untracked === 1 ? '' : 's'} excluded from the comparison.`;
}

function satisfactionTooltip() {
  return [
    { field: 'group', type: 'nominal' as const, title: 'Setting' },
    { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Mean satisfaction', format: '.2f' },
    { field: 'ciLabel', type: 'nominal' as const, title: 'Mean interval' },
    { field: 'runCount', type: 'quantitative' as const, title: 'Completed runs' },
    { field: 'scoredCount', type: 'quantitative' as const, title: 'Scored runs' },
    { field: 'resolutionRate', type: 'quantitative' as const, title: 'Resolved rate', format: '.0%' },
  ];
}

/** Layered mean-satisfaction spec with t-based 95% intervals and visible n labels. */
export function satisfactionIntervalSpec(rows: SettingImpactRow[]) {
  const sort = rows.map((row) => row.group);
  return rows.length === 0 ? null : {
    width: 'container',
    height: 240,
    data: { values: rows },
    layer: [
      {
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, opacity: 0.72 },
        encoding: {
          x: { field: 'group', type: 'nominal' as const, sort, title: null, axis: { labelAngle: 0 } },
          y: { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Observed mean satisfaction', scale: { domain: [1, 5] } },
          color: { field: 'group', type: 'nominal' as const, scale: { range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.muted] }, legend: null },
          tooltip: satisfactionTooltip(),
        },
      },
      {
        mark: { type: 'rule' as const, strokeWidth: 3, color: CHART_COLORS.text },
        encoding: {
          x: { field: 'group', type: 'nominal' as const, sort },
          y: { field: 'ciLower', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          y2: { field: 'ciUpper' },
          tooltip: satisfactionTooltip(),
        },
      },
      {
        mark: { type: 'point' as const, filled: true, size: 90, color: CHART_COLORS.text },
        encoding: {
          x: { field: 'group', type: 'nominal' as const, sort },
          y: { field: 'avgSatisfaction', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          tooltip: satisfactionTooltip(),
        },
      },
      {
        mark: { type: 'text' as const, dy: 12, fontSize: 11, color: CHART_COLORS.text },
        encoding: {
          x: { field: 'group', type: 'nominal' as const, sort },
          y: { field: 'ciUpper', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          text: { field: 'nLabel', type: 'nominal' as const },
        },
      },
    ],
  };
}

interface ExtensionImpactRow extends SettingImpactRow {
  extension: string;
  state: 'Explicitly enabled' | 'Explicitly disabled';
}

function extensionIntervalSpec(rows: ExtensionImpactRow[], extensions: string[]) {
  const tooltip = [
    { field: 'extension', type: 'nominal' as const, title: 'Extension' },
    { field: 'state', type: 'nominal' as const, title: 'Explicit override' },
    { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Mean satisfaction', format: '.2f' },
    { field: 'ciLabel', type: 'nominal' as const, title: 'Mean interval' },
    { field: 'runCount', type: 'quantitative' as const, title: 'Completed runs' },
    { field: 'scoredCount', type: 'quantitative' as const, title: 'Scored runs' },
    { field: 'resolutionRate', type: 'quantitative' as const, title: 'Resolved rate', format: '.0%' },
  ];
  const x = { field: 'extension', type: 'nominal' as const, sort: extensions, title: null, axis: { labelAngle: 0, labelLimit: 120 } };
  const xOffset = { field: 'state', type: 'nominal' as const };
  const color = {
    field: 'state',
    type: 'nominal' as const,
    legend: { title: 'Explicit override' },
    scale: {
      domain: ['Explicitly enabled', 'Explicitly disabled'],
      range: [CHART_COLORS.success, CHART_COLORS.coral],
    },
  };
  return rows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(extensions.length, 40),
    data: { values: rows },
    layer: [
      {
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.7 },
        encoding: {
          x,
          xOffset,
          y: { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Observed mean satisfaction', scale: { domain: [1, 5] } },
          color,
          tooltip,
        },
      },
      {
        mark: { type: 'rule' as const, strokeWidth: 2.5, color: CHART_COLORS.text },
        encoding: {
          x,
          xOffset,
          y: { field: 'ciLower', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          y2: { field: 'ciUpper' },
          tooltip,
        },
      },
      {
        mark: { type: 'point' as const, filled: true, size: 70, color: CHART_COLORS.text },
        encoding: {
          x,
          xOffset,
          y: { field: 'avgSatisfaction', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          tooltip,
        },
      },
      {
        mark: { type: 'text' as const, dy: 11, fontSize: 10, color: CHART_COLORS.text },
        encoding: {
          x,
          xOffset,
          y: { field: 'ciUpper', type: 'quantitative' as const, scale: { domain: [1, 5] } },
          text: { field: 'nLabel', type: 'nominal' as const },
        },
      },
    ],
  };
}

export const settingsCharts: ChartEntry[] = [
  {
    id: 'chart-settings-subagent-parent',
    render: async (ctx: ChartContext) => {
      const comparison = settingComparisonRows(
        ctx.runs,
        (run) => run.fsSubagentAlwaysParentModel === null ? null : run.fsSubagentAlwaysParentModel ? 'On' : 'Off',
        ['On', 'Off'],
      );
      ctx.setNote(
        'settings-subagent-parent-note',
        `Observed mean satisfaction when sub-agents were configured to use the parent model (On) versus bucket selection (Off). ${coverageText(comparison)} Only groups with ≥${MIN_SCORED_PER_SETTING_GROUP} scored runs are shown with 95% mean intervals; descriptive only, not an adjusted treatment effect.`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-subagent-parent', satisfactionIntervalSpec(comparison.rows), 'No tracked groups have at least 3 scored runs under the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-pruning-mode',
    render: async (ctx: ChartContext) => {
      const comparison = settingComparisonRows(
        ctx.runs,
        (run) => run.fsPruningMode,
        ['auto', 'shadow', 'off', 'custom'],
      );
      ctx.setNote(
        'settings-pruning-mode-note',
        `Observed mean satisfaction by pruning mode recorded at run start. ${coverageText(comparison)} Only groups with ≥${MIN_SCORED_PER_SETTING_GROUP} scored runs are shown with 95% mean intervals; descriptive only, not an adjusted treatment effect.`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-pruning-mode', satisfactionIntervalSpec(comparison.rows), 'No tracked pruning-mode groups have at least 3 scored runs under the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-extension-toggles',
    render: async (ctx: ChartContext) => {
      const runs = completedRuns(ctx.runs);
      const affectedByExtension = new Map<string, PreparedRunRow[]>();
      const runsWithOverrides = new Set<string>();
      for (const run of runs) {
        for (const [extensionId, enabled] of Object.entries(run.fsExtensionToggles)) {
          if (typeof enabled !== 'boolean') {
            continue;
          }
          runsWithOverrides.add(run.runId);
          const bucket = affectedByExtension.get(extensionId) ?? [];
          bucket.push(run);
          affectedByExtension.set(extensionId, bucket);
        }
      }

      const rows: ExtensionImpactRow[] = [];
      const rankedExtensions = [...affectedByExtension.entries()]
        .sort((left, right) => right[1].length - left[1].length)
        .slice(0, 12);

      for (const [extensionId, extensionRuns] of rankedExtensions) {
        for (const { state, runs: stateRuns } of [
          { state: 'Explicitly enabled' as const, runs: extensionRuns.filter((run) => run.fsExtensionToggles[extensionId] === true) },
          { state: 'Explicitly disabled' as const, runs: extensionRuns.filter((run) => run.fsExtensionToggles[extensionId] === false) },
        ]) {
          const summary = summarizeGroup(stateRuns);
          if (summary) {
            rows.push({ extension: extensionId, state, ...summary, group: state });
          }
        }
      }

      const displayedExtensions = rankedExtensions
        .map(([extensionId]) => extensionId)
        .filter((extensionId) => rows.some((row) => row.extension === extensionId));
      const totalScored = runs.filter((run) => run.satisfaction !== null).length;
      const scoredWithOverrides = runs.filter((run) => runsWithOverrides.has(run.runId) && run.satisfaction !== null).length;
      ctx.setNote(
        'settings-extension-toggles-note',
        `Observed mean satisfaction by explicit per-extension override at run start; these values are not effective extension state. ${runsWithOverrides.size}/${runs.length} completed and ${scoredWithOverrides}/${totalScored} scored runs recorded at least one explicit override. Only groups with ≥${MIN_SCORED_PER_SETTING_GROUP} scored runs are shown with 95% mean intervals; descriptive only, not an adjusted treatment effect.`,
        ctx.renderToken,
      );
      const spec = extensionIntervalSpec(rows, displayedExtensions);
      await ctx.renderSpec('chart-settings-extension-toggles', spec, 'No explicit extension-override groups have at least 3 scored runs under the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-tool-result-pruning',
    render: async (ctx: ChartContext) => {
      const comparison = settingComparisonRows(
        ctx.runs,
        (run) => run.fsToolResultPruningEnabled === null ? null : run.fsToolResultPruningEnabled ? 'On' : 'Off',
        ['On', 'Off'],
      );
      ctx.setNote(
        'settings-tool-result-pruning-note',
        `Observed mean satisfaction with tool-result pruning enabled (On) versus disabled (Off) at run start. ${coverageText(comparison)} Only groups with ≥${MIN_SCORED_PER_SETTING_GROUP} scored runs are shown with 95% mean intervals; descriptive only and subject to explicit opt-out selection, not an adjusted treatment effect.`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-tool-result-pruning', satisfactionIntervalSpec(comparison.rows), 'No tracked tool-result-pruning groups have at least 3 scored runs under the current filters.', ctx.renderToken);
    },
  },
];
