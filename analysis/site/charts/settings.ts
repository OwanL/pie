import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, average, categoricalHeight, completedRuns } from '../lib.ts';
import type { PreparedRunRow } from '../../scripts/contracts.ts';

/** Common shape for a setting-dimension comparison row fed to Vega-Lite. */
interface SettingImpactRow {
  group: string;
  avgSatisfaction: number | null;
  runCount: number;
  scoredCount: number;
  resolutionRate: number | null;
}

function summarizeGroup(runs: PreparedRunRow[]): Omit<SettingImpactRow, 'group'> {
  const scored = runs.filter((run) => run.satisfaction !== null);
  const avgSatisfaction = average(scored.map((run) => run.satisfaction!));
  const resolved = scored.filter((run) => run.resolution === 'resolved').length;
  const resolutionRate = scored.length > 0 ? Math.round((resolved / scored.length) * 1000) / 1000 : null;
  return {
    avgSatisfaction,
    runCount: runs.length,
    scoredCount: scored.length,
    resolutionRate,
  };
}

/** Keep only groups with at least one scored run so satisfaction bars always render. */
function toImpactRows(groups: Array<{ group: string; runs: PreparedRunRow[] }>): SettingImpactRow[] {
  return groups
    .map(({ group, runs }) => ({ group, ...summarizeGroup(runs) }))
    .filter((row) => row.scoredCount > 0);
}

function satisfactionBarSpec(rows: SettingImpactRow[]) {
  return rows.length === 0 ? null : {
    width: 'container',
    height: 240,
    data: { values: rows },
    mark: { type: 'bar' as const, cornerRadiusEnd: 4, opacity: 0.88 },
    encoding: {
      x: {
        field: 'group',
        type: 'nominal' as const,
        title: null,
        axis: { labelAngle: 0 },
      },
      y: {
        field: 'avgSatisfaction',
        type: 'quantitative' as const,
        title: 'Avg satisfaction',
        // Satisfaction is a 1–5 Likert scale: floor the axis at 1 so the
        // On/Off/mode differences (typically 3.5–4.5) are visible, not flattened.
        scale: { domain: [1, 5] },
      },
      color: {
        field: 'group',
        type: 'nominal' as const,
        scale: { range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.muted] },
        // x-axis already encodes group; suppress the duplicate legend.
        legend: null,
      },
      tooltip: [
        { field: 'group', type: 'nominal' as const, title: 'Setting' },
        { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Avg satisfaction', format: '.2f' },
        { field: 'runCount', type: 'quantitative' as const, title: 'Completed runs' },
        { field: 'scoredCount', type: 'quantitative' as const, title: 'Scored runs' },
        {
          field: 'resolutionRate',
          type: 'quantitative' as const,
          title: 'Resolved rate',
          format: '.0%',
        },
      ],
    },
  };
}

export const settingsCharts: ChartEntry[] = [
  {
    id: 'chart-settings-subagent-parent',
    render: async (ctx: ChartContext) => {
      const runs = completedRuns(ctx.runs);
      const onRuns = runs.filter((run) => run.fsSubagentAlwaysParentModel === true);
      const offRuns = runs.filter((run) => run.fsSubagentAlwaysParentModel === false);
      const untrackedRuns = runs.filter((run) => run.fsSubagentAlwaysParentModel === null);
      const rows = toImpactRows([
        { group: 'On', runs: onRuns },
        { group: 'Off', runs: offRuns },
        { group: '(untracked)', runs: untrackedRuns },
      ]);
      const totalScored = runs.filter((run) => run.satisfaction !== null).length;
      ctx.setNote(
        'settings-subagent-parent-note',
        `Average satisfaction for runs where sub-agents always use the parent model (On) vs. bucket selection (Off). ${totalScored} scored runs in view; runs recorded before tracking existed fall under (untracked).`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-subagent-parent', satisfactionBarSpec(rows), 'No scored runs with subagent parent-model tracking match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-pruning-mode',
    render: async (ctx: ChartContext) => {
      const runs = completedRuns(ctx.runs);
      const modes = ['auto', 'shadow', 'off', 'custom'] as const;
      const groups: Array<{ group: string; runs: PreparedRunRow[] }> = modes
        .map((mode) => ({ group: mode, runs: runs.filter((run) => run.fsPruningMode === mode) }))
        .filter((entry) => entry.runs.length > 0);
      const untrackedRuns = runs.filter((run) => run.fsPruningMode === null);
      if (untrackedRuns.length > 0) {
        groups.push({ group: '(untracked)', runs: untrackedRuns });
      }
      const rows = toImpactRows(groups);
      const enabledCount = runs.filter((run) => run.fsPruningEnabled === true).length;
      ctx.setNote(
        'settings-pruning-mode-note',
        `Average satisfaction by pruning mode at run start. ${enabledCount} of ${runs.length} runs had pruning active (mode !== 'off'); (untracked) covers runs recorded before tracking existed.`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-pruning-mode', satisfactionBarSpec(rows), 'No scored runs with pruning-mode tracking match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-extension-toggles',
    render: async (ctx: ChartContext) => {
      const runs = completedRuns(ctx.runs);
      const affectedByExtension = new Map<string, PreparedRunRow[]>();
      for (const run of runs) {
        for (const [extensionId, enabled] of Object.entries(run.fsExtensionToggles)) {
          if (typeof enabled !== 'boolean') {
            continue;
          }
          const bucket = affectedByExtension.get(extensionId) ?? [];
          bucket.push(run);
          affectedByExtension.set(extensionId, bucket);
        }
      }

      const rows: Array<SettingImpactRow & { extension: string; state: 'Enabled' | 'Disabled' }> = [];
      const rankedExtensions = [...affectedByExtension.entries()]
        .sort((left, right) => right[1].length - left[1].length)
        .slice(0, 12);

      for (const [extensionId, extensionRuns] of rankedExtensions) {
        const enabledRuns = extensionRuns.filter((run) => run.fsExtensionToggles[extensionId] === true);
        const disabledRuns = extensionRuns.filter((run) => run.fsExtensionToggles[extensionId] === false);
        for (const { state, runs } of [
          { state: 'Enabled' as const, runs: enabledRuns },
          { state: 'Disabled' as const, runs: disabledRuns },
        ]) {
          const summary = summarizeGroup(runs);
          if (summary.scoredCount === 0) {
            continue;
          }
          rows.push({ extension: extensionId, state, ...summary, group: state });
        }
      }

      ctx.setNote(
        'settings-extension-toggles-note',
        `Average satisfaction by per-extension enabled/disabled toggle at run start, for the ${rankedExtensions.length} most-used extensions. Only groups with scored runs are shown.`,
        ctx.renderToken,
      );
      const spec = rows.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(rankedExtensions.length, 40),
        data: { values: rows },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          x: { field: 'extension', type: 'nominal' as const, title: null, axis: { labelAngle: 0, labelLimit: 120 } },
          y: { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Avg satisfaction', scale: { domain: [1, 5] } },
          color: {
            field: 'state',
            type: 'nominal' as const,
            legend: { title: 'Toggle' },
            scale: { range: [CHART_COLORS.success, CHART_COLORS.coral] },
          },
          xOffset: { field: 'state', type: 'nominal' as const },
          tooltip: [
            { field: 'extension', type: 'nominal' as const, title: 'Extension' },
            { field: 'state', type: 'nominal' as const, title: 'Toggle' },
            { field: 'avgSatisfaction', type: 'quantitative' as const, title: 'Avg satisfaction', format: '.2f' },
            { field: 'runCount', type: 'quantitative' as const, title: 'Completed runs' },
            { field: 'scoredCount', type: 'quantitative' as const, title: 'Scored runs' },
            { field: 'resolutionRate', type: 'quantitative' as const, title: 'Resolved rate', format: '.0%' },
          ],
        },
      };
      await ctx.renderSpec('chart-settings-extension-toggles', spec, 'No scored runs with extension-toggle tracking match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-settings-tool-result-pruning',
    render: async (ctx: ChartContext) => {
      // Bucket completed runs by whether tool-result pruning was enabled at run
      // start (true / false / null=untracked) and contrast average satisfaction.
      // Answers "are outcomes better with or without the system?" Read-tool
      // results are never pruned (hard safety guard), so the On bucket reflects
      // bash/ls/grep/find/etc. output pruning only.
      const runs = completedRuns(ctx.runs);
      const onRuns = runs.filter((run) => run.fsToolResultPruningEnabled === true);
      const offRuns = runs.filter((run) => run.fsToolResultPruningEnabled === false);
      const untrackedRuns = runs.filter((run) => run.fsToolResultPruningEnabled === null);
      const rows = toImpactRows([
        { group: 'On', runs: onRuns },
        { group: 'Off', runs: offRuns },
        { group: '(untracked)', runs: untrackedRuns },
      ]);
      const totalScored = runs.filter((run) => run.satisfaction !== null).length;
      ctx.setNote(
        'settings-tool-result-pruning-note',
        `Average satisfaction for runs with tool-result pruning enabled (On) vs. disabled (Off). ${totalScored} scored runs in view; the system is on by default, so Off is skewed toward sessions where the user explicitly turned it off (selection bias). (untracked) covers runs recorded before tracking existed.`,
        ctx.renderToken,
      );
      await ctx.renderSpec('chart-settings-tool-result-pruning', satisfactionBarSpec(rows), 'No scored runs with tool-result-pruning tracking match the current filters.', ctx.renderToken);
    },
  },
];
