import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, categoricalHeight, escapeHtml, median, selectedRunIds, sum } from '../lib.ts';
import type { PreparedPruningEventRow, PreparedPruningSignalRow, PreparedRunRow, ToolResultPruningImpactData } from '../../scripts/contracts.ts';

function filteredPruning(ctx: ChartContext): PreparedPruningEventRow[] {
  const runIds = selectedRunIds(ctx.runs);
  return ctx.pruning.rows.filter((r) => runIds.has(r.runId));
}

function filteredPruningSignals(ctx: ChartContext): PreparedPruningSignalRow[] {
  const runIds = selectedRunIds(ctx.runs);
  return ctx.pruning.signalRows.filter((r) => runIds.has(r.runId));
}

function tokensSavedTrend(rows: PreparedPruningEventRow[]) {
  const map = new Map<string, { tokens: number; events: number }>();
  for (const r of rows) {
    const e = map.get(r.startedDay) ?? { tokens: 0, events: 0 };
    e.tokens += r.skillTokensSaved + r.toolTokensSaved;
    e.events += 1;
    map.set(r.startedDay, e);
  }
  return [...map.entries()]
    .map(([day, e]) => ({ day, tokensSaved: e.tokens, events: e.events }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function topPrunedNames(rows: PreparedPruningEventRow[], field: 'prunedSkillNames' | 'prunedToolNames', limit: number) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const name of r[field]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface PruningRecoveryMetrics {
  toolRecoveries: number;
  toolPruningDecisions: number;
  toolRecoveriesPerDecision: number | null;
  skillMisses: number;
  skillReadAttempts: number;
  skillMissRate: number | null;
}

export function pruningRecoveryMetrics(
  decisionRows: PreparedPruningEventRow[],
  signals: PreparedPruningSignalRow[],
): PruningRecoveryMetrics {
  let skillMisses = 0;
  let toolRecoveries = 0;
  let successfulSkillReads = 0;
  for (const signal of signals) {
    if (signal.event === 'skill_miss' || signal.event === 'shadow_miss_candidate' || signal.event === 'skill_recovered') skillMisses += 1;
    else if (signal.event === 'tool_recovered') toolRecoveries += 1;
    else if (signal.event === 'skill_read') successfulSkillReads += 1;
  }
  const toolPruningDecisions = decisionRows.filter((row) => row.toolCountPruned >= 1).length;
  const skillReadAttempts = successfulSkillReads + skillMisses;
  return {
    toolRecoveries,
    toolPruningDecisions,
    toolRecoveriesPerDecision: toolPruningDecisions > 0 ? toolRecoveries / toolPruningDecisions : null,
    skillMisses,
    skillReadAttempts,
    skillMissRate: skillReadAttempts > 0 ? skillMisses / skillReadAttempts : null,
  };
}

/** Separate views preserve the distinct ratio and percentage units. */
export function pruningRecoverySpec(metrics: PruningRecoveryMetrics) {
  const views: Array<Record<string, unknown>> = [];
  if (metrics.toolRecoveriesPerDecision !== null) {
    views.push({
      width: 'container',
      height: 85,
      title: 'Tool recovery frequency',
      data: {
        values: [{
          label: 'Tool recoveries',
          value: metrics.toolRecoveriesPerDecision,
          events: metrics.toolRecoveries,
          decisions: metrics.toolPruningDecisions,
        }],
      },
      mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85, color: CHART_COLORS.accent },
      encoding: {
        y: { field: 'label', type: 'nominal' as const, title: null },
        x: { field: 'value', type: 'quantitative' as const, title: 'Tool recoveries per tool-pruning decision', axis: { format: '.2f' } },
        tooltip: [
          { field: 'value', type: 'quantitative' as const, title: 'Recoveries / decision', format: '.2f' },
          { field: 'events', type: 'quantitative' as const, title: 'Tool recovery events' },
          { field: 'decisions', type: 'quantitative' as const, title: 'Tool-pruning decisions' },
        ],
      },
    });
  }
  if (metrics.skillMissRate !== null) {
    views.push({
      width: 'container',
      height: 85,
      title: 'Skill miss share',
      data: {
        values: [{
          label: 'Skill misses',
          value: metrics.skillMissRate,
          misses: metrics.skillMisses,
          attempts: metrics.skillReadAttempts,
        }],
      },
      mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85, color: CHART_COLORS.coral },
      encoding: {
        y: { field: 'label', type: 'nominal' as const, title: null },
        x: { field: 'value', type: 'quantitative' as const, title: 'Skill miss rate (misses / read attempts)', scale: { domain: [0, 1] }, axis: { format: '.0%' } },
        tooltip: [
          { field: 'value', type: 'quantitative' as const, title: 'Miss rate', format: '.0%' },
          { field: 'misses', type: 'quantitative' as const, title: 'Skill misses' },
          { field: 'attempts', type: 'quantitative' as const, title: 'Skill read attempts' },
        ],
      },
    });
  }
  return views.length === 0 ? null : {
    vconcat: views,
    spacing: 24,
    resolve: { scale: { x: 'independent' as const } },
  };
}

interface ToolResultPruningDisplayRow {
  name: string;
  count: number;
  tokensSaved: number;
  beforeTokens?: number;
  afterTokens?: number;
}

function toolResultPruningList(title: string, rows: ToolResultPruningDisplayRow[], empty: string): string {
  return `<article><h4>${title}</h4>${rows.length === 0 ? `<p>${empty}</p>` : `<ul>${rows.map((row) => `<li><strong>${escapeHtml(row.name)}</strong>: ${row.count} event${row.count === 1 ? '' : 's'} · ${Math.round(row.tokensSaved).toLocaleString()} tokens saved</li>`).join('')}</ul>`}</article>`;
}

/** Render filtered tool-result-pruning health metrics without hiding the multi-rule attribution. */
export function toolResultPruningImpactHtml(data: ToolResultPruningImpactData, runs: PreparedRunRow[]): string {
  const runIds = selectedRunIds(runs);
  const rows = data.rows.filter((row) => runIds.has(row.runId));
  const totalTokensSaved = sum(rows.map((row) => row.tokensSaved));
  const totalBeforeTokens = sum(rows.map((row) => row.beforeTokens));
  const totalAfterTokens = sum(rows.map((row) => row.afterTokens));
  const savingsRatio = totalBeforeTokens > 0 ? totalTokensSaved / totalBeforeTokens : null;
  const rules = new Map<string, ToolResultPruningDisplayRow>();
  const tools = new Map<string, ToolResultPruningDisplayRow>();
  for (const row of rows) {
    for (const rule of row.rules) {
      const current = rules.get(rule) ?? { name: rule, count: 0, tokensSaved: 0 };
      current.count += 1;
      current.tokensSaved += row.tokensSaved;
      rules.set(rule, current);
    }
    const current = tools.get(row.toolName) ?? { name: row.toolName, count: 0, tokensSaved: 0, beforeTokens: 0, afterTokens: 0 };
    current.count += 1;
    current.tokensSaved += row.tokensSaved;
    current.beforeTokens = (current.beforeTokens ?? 0) + row.beforeTokens;
    current.afterTokens = (current.afterTokens ?? 0) + row.afterTokens;
    tools.set(row.toolName, current);
  }
  const sortRows = (left: ToolResultPruningDisplayRow, right: ToolResultPruningDisplayRow) => right.tokensSaved - left.tokensSaved || right.count - left.count || left.name.localeCompare(right.name);
  const topRules = [...rules.values()].sort(sortRows).slice(0, 8);
  const topTools = [...tools.values()].sort(sortRows).slice(0, 8);
  const ratioLabel = savingsRatio === null ? '—' : `${(savingsRatio * 100).toFixed(1)}%`;
  return `<div class="review-diagnostic-grid"><article><h4>Tool-result pruning summary</h4><p><strong>Events:</strong> ${rows.length.toLocaleString()}</p><p><strong>Total token savings:</strong> ${Math.round(totalTokensSaved).toLocaleString()}</p><p><strong>Savings ratio:</strong> ${ratioLabel} <span class="note">(${Math.round(totalBeforeTokens).toLocaleString()} before → ${Math.round(totalAfterTokens).toLocaleString()} after)</span></p><p class="note">Rule savings are attributed once per rule firing; multi-rule events can therefore appear in more than one rule total.</p></article>${toolResultPruningList('Top rules', topRules, 'No tool-result pruning rules match the current filters.')} ${toolResultPruningList('Top tools', topTools, 'No tool-result pruning tools match the current filters.')}</div>`;
}

export const pruningCharts: ChartEntry[] = [
  {
    id: 'chart-pruning-tokens-trend',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const trend = tokensSavedTrend(rows);
      const totalSaved = sum(trend.map((r) => r.tokensSaved));
      ctx.setNote('pruning-tokens-trend-note', `Daily tokens saved by the skill/tool pruner; ${trend.length} days, ${Math.round(totalSaved).toLocaleString()} tokens total.`, ctx.renderToken);
      const spec = trend.length === 0 ? null : {
        width: 'container',
        height: 200,
        data: { values: trend },
        layer: [
          {
            mark: { type: 'area' as const, opacity: 0.2 },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
              y: { field: 'tokensSaved', type: 'quantitative' as const, title: 'Tokens saved' },
              color: { value: CHART_COLORS.success },
            },
          },
          {
            mark: { type: 'line' as const, strokeWidth: 2, point: { size: 30, filled: true } },
            encoding: {
              x: { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate' },
              y: { field: 'tokensSaved', type: 'quantitative' as const },
              color: { value: CHART_COLORS.success },
              tooltip: [
                { field: 'day', type: 'temporal' as const, timeUnit: 'yearmonthdate', title: 'Day' },
                { field: 'tokensSaved', type: 'quantitative' as const, title: 'Tokens saved', format: ',' },
                { field: 'events', type: 'quantitative' as const, title: 'Pruning events' },
              ],
            },
          },
        ],
      };
      await ctx.renderSpec('chart-pruning-tokens-trend', spec, 'No pruning events match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-latency',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const latencies = rows.map((r) => r.llmLatencyMs).filter((v) => Number.isFinite(v) && v > 0);
      const med = median(latencies);
      ctx.setNote('pruning-latency-note', `Pruner LLM latency distribution across ${latencies.length} events${med !== null ? `; median ${Math.round(med)} ms` : ''}.`, ctx.renderToken);
      const spec = latencies.length === 0 ? null : {
        width: 'container',
        height: 220,
        data: { values: latencies.map((ms) => ({ latency: ms })) },
        mark: { type: 'bar' as const, opacity: 0.8 },
        encoding: {
          x: { bin: { maxbins: 30 }, field: 'latency', type: 'quantitative' as const, title: 'Pruner LLM latency (ms)' },
          y: { aggregate: 'count' as const, type: 'quantitative' as const, title: 'Events' },
          color: { value: CHART_COLORS.accent2 },
        },
      };
      await ctx.renderSpec('chart-pruning-latency', spec, 'No pruning events with latency data match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-top-skills',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const top = topPrunedNames(rows, 'prunedSkillNames', 15);
      ctx.setNote('pruning-top-skills-note', `Most frequently pruned skills (top ${top.length}).`, ctx.renderToken);
      const spec = top.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(top.length, 24),
        data: { values: top },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'name', type: 'nominal' as const, sort: top.map((r) => r.name), title: null, axis: { labelLimit: 300 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          color: { value: CHART_COLORS.gold },
          tooltip: [
            { field: 'name', type: 'nominal' as const, title: 'Skill' },
            { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          ],
        },
      };
      await ctx.renderSpec('chart-pruning-top-skills', spec, 'No pruned skills match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-top-tools',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const rows = filteredPruning(ctx);
      const top = topPrunedNames(rows, 'prunedToolNames', 15);
      ctx.setNote('pruning-top-tools-note', `Most frequently pruned tools (top ${top.length}).`, ctx.renderToken);
      const spec = top.length === 0 ? null : {
        width: 'container',
        height: categoricalHeight(top.length, 24),
        data: { values: top },
        mark: { type: 'bar' as const, cornerRadiusEnd: 3, opacity: 0.85 },
        encoding: {
          y: { field: 'name', type: 'nominal' as const, sort: top.map((r) => r.name), title: null, axis: { labelLimit: 300 } },
          x: { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'name', type: 'nominal' as const, title: 'Tool' },
            { field: 'count', type: 'quantitative' as const, title: 'Times pruned' },
          ],
        },
      };
      await ctx.renderSpec('chart-pruning-top-tools', spec, 'No pruned tools match the current filters.', ctx.renderToken);
    },
  },
  {
    id: 'chart-pruning-recovery-rate',
    runCohort: 'current-harness',
    render: async (ctx: ChartContext) => {
      const metrics = pruningRecoveryMetrics(filteredPruning(ctx), filteredPruningSignals(ctx));
      const recoveriesText = metrics.toolRecoveriesPerDecision === null
        ? 'n/a (no tool-pruning decisions)'
        : metrics.toolRecoveriesPerDecision.toFixed(2);
      const missRateText = metrics.skillMissRate === null
        ? 'n/a (no skill read attempts)'
        : `${Math.round(metrics.skillMissRate * 100)}%`;
      ctx.setNote(
        'pruning-recovery-rate-note',
        `Over-pruning signals: ${metrics.toolRecoveries} tool recoveries across ${metrics.toolPruningDecisions} tool-pruning decisions (${recoveriesText} recoveries/decision); ${metrics.skillMisses} skill misses across ${metrics.skillReadAttempts} read attempts (${missRateText}). Separate views use ratio and percent units respectively.`,
        ctx.renderToken,
      );
      const spec = pruningRecoverySpec(metrics);
      await ctx.renderSpec('chart-pruning-recovery-rate', spec, 'No over-pruning signals match the current filters.', ctx.renderToken);
    },
  },
];
