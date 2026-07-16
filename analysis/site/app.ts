import embed from 'vega-embed';

import { LEADERBOARD_WEIGHTS } from '../scripts/leaderboard-scoring.ts';
import { createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { meanDifferenceInterval, meanInterval, wilsonInterval } from './chart-stats.ts';
import { renderChartEntries, type ChartContext } from './lib.ts';
import { newCharts } from './charts/index.ts';
import { toErrorMessage } from '../../shared/error-message.js';

import type {
  BackendErrorData,
  FileExtensionData,
  ModelLeaderboardData,
  ModelLeaderboardRow,
  ModelQualityData,
  OverviewData,
  PruningImpactData,
  RetryTimingData,
  RunSummaryData,
  PreparedRunRow,
  PreparedToolUsageRow,
  SiteManifest,
  TimelineData,
  TokenThroughputData,
  ToolUsageData,
  TreatmentComparisonData,
  VerificationImpactData,
} from '../scripts/contracts.ts';

interface DashboardData {
  manifest: SiteManifest;
  overview: OverviewData;
  runSummary: RunSummaryData;
  modelQuality: ModelQualityData;
  verificationImpact: VerificationImpactData;
  toolUsage: ToolUsageData;
  treatmentComparison: TreatmentComparisonData;
  timeline: TimelineData;
  pruningImpact: PruningImpactData;
  backendErrors: BackendErrorData;
  fileExtensions: FileExtensionData;
  tokenThroughput: TokenThroughputData;
  retryTiming: RetryTimingData;
  modelLeaderboard: ModelLeaderboardData;
}

export interface FilterState {
  startDate: string;
  endDate: string;
  modelId: string;
  thinkingLevel: string;
  experimentAssignment: string;
  subagentParentModel: string;
  pruningMode: string;
  scoredOnly: boolean;
  pureOnly: boolean;
}

export const DEFAULT_FILTERS: FilterState = {
  startDate: '',
  endDate: '',
  modelId: '',
  thinkingLevel: '',
  experimentAssignment: '',
  subagentParentModel: '',
  pruningMode: '',
  scoredOnly: false,
  pureOnly: false,
};

const CHART_COLORS = {
  accent: '#8de3ff',
  accent2: '#c0ff72',
  coral: '#ff8578',
  gold: '#ffd479',
  success: '#59e17f',
  text: '#f6f1e8',
  muted: '#b9b1a3',
  grid: 'rgba(255,255,255,0.05)',
};

const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const THINKING_LEVEL_DOMAIN = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
const THINKING_LEVEL_RANGE = ['#8c8478', '#7ec8e3', '#59e17f', '#ffd479', '#ff8578', '#c084fc'];

const chartViews = new Map<string, { finalize: () => void }>();
let activeRenderToken = 0;

function byId<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as TElement;
}

async function fetchJson<TValue>(relativePath: string): Promise<TValue> {
  const response = await fetch(relativePath, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load ${relativePath}: ${response.status} ${response.statusText}`);
  }
  return await response.json() as TValue;
}

async function fetchOptionalJson<TValue>(relativePath: string): Promise<TValue | null> {
  try {
    return await fetchJson<TValue>(relativePath);
  } catch (error) {
    console.warn(`[pie-analysis] ${toErrorMessage(error)}`);
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }
  return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function normalizeThinkingLevel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'max') {
    return 'xhigh';
  }
  return normalized;
}

function formatThinkingLevelLabel(value: string): string {
  return value === 'xhigh' ? 'max' : value;
}

function sortNatural(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

function sortThinkingLevels(values: string[]): string[] {
  return [...values].sort((left, right) => {
    const leftIndex = THINKING_LEVEL_ORDER.indexOf(left);
    const rightIndex = THINKING_LEVEL_ORDER.indexOf(right);
    if (leftIndex >= 0 && rightIndex >= 0) {
      return leftIndex - rightIndex;
    }
    if (leftIndex >= 0) {
      return -1;
    }
    if (rightIndex >= 0) {
      return 1;
    }
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];
}

function scoredRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return runs.filter((run) => run.scored && run.satisfaction !== null);
}

/**
 * Canonical provider-agnostic model key. Provider-specific ids that resolve
 * to the same family (e.g. `umans-glm-5.2` and `glm-5.2:cloud`) collapse into one
 * row. Mirrors the expression used by the persisted site-data bundle so the
 * in-browser views and the artifacts stay consistent.
 */
function modelFamilyKey(run: { modelFamily: string | null; modelId?: string | null }): string {
  return run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
}

export function applyFilters(runs: PreparedRunRow[], filters: FilterState): PreparedRunRow[] {
  return runs.filter((run) => {
    if (filters.startDate && run.startedDay < filters.startDate) {
      return false;
    }
    if (filters.endDate && run.startedDay > filters.endDate) {
      return false;
    }
    if (filters.modelId && modelFamilyKey(run) !== filters.modelId) {
      return false;
    }
    const runThinkingLevel = normalizeThinkingLevel(run.thinkingLevel);
    const filterThinkingLevel = normalizeThinkingLevel(filters.thinkingLevel);
    if (filterThinkingLevel && runThinkingLevel !== filterThinkingLevel) {
      return false;
    }
    if (filters.experimentAssignment && (run.experimentAssignment ?? '(none)') !== filters.experimentAssignment) {
      return false;
    }
    if (filters.subagentParentModel) {
      const matches = filters.subagentParentModel === 'true'
        ? run.fsSubagentAlwaysParentModel === true
        : run.fsSubagentAlwaysParentModel === false;
      if (!matches) {
        return false;
      }
    }
    if (filters.pruningMode && run.fsPruningMode !== filters.pruningMode) {
      return false;
    }
    if (filters.scoredOnly && (!run.scored || run.satisfaction === null)) {
      return false;
    }
    if (filters.pureOnly && run.mixedTreatmentConfig) {
      return false;
    }
    return true;
  });
}

function estimatedRunCostUsd(run: PreparedRunRow): number | null {
  return typeof run.totalEstimatedCostUsd === 'number' && Number.isFinite(run.totalEstimatedCostUsd)
    ? run.totalEstimatedCostUsd
    : null;
}

function hasReportedParentTokenUsage(run: PreparedRunRow): boolean {
  return run.tokenReportedTurnCount > 0
    || run.inputTokens > 0
    || run.outputTokens > 0
    || run.cacheReadTokens > 0
    || run.cacheWriteTokens > 0;
}

export interface CoverageMetric {
  count: number;
  percentage: number | null;
}

export interface CoverageSummary {
  selectedRunCount: number;
  completed: CoverageMetric;
  outcomeScored: CoverageMetric;
  priced: CoverageMetric;
  tokenTelemetry: CoverageMetric;
  mixedModel: CoverageMetric;
}

/** Coverage after global filters. Non-completion metrics use completed runs as their denominator. */
export function coverageSummary(runs: PreparedRunRow[]): CoverageSummary {
  const completed = runs.filter((run) => run.status !== 'open');
  const completedCount = completed.length;
  const metric = (count: number, denominator: number): CoverageMetric => ({
    count,
    percentage: denominator === 0 ? null : count / denominator,
  });

  return {
    selectedRunCount: runs.length,
    completed: metric(completedCount, runs.length),
    outcomeScored: metric(
      completed.filter((run) => run.scored && run.satisfaction !== null).length,
      completedCount,
    ),
    priced: metric(completed.filter((run) => estimatedRunCostUsd(run) !== null).length, completedCount),
    tokenTelemetry: metric(completed.filter(hasReportedParentTokenUsage).length, completedCount),
    mixedModel: metric(completed.filter((run) => run.mixedModelConfig).length, completedCount),
  };
}

function renderCoverageBanner(runs: PreparedRunRow[]): void {
  const coverage = coverageSummary(runs);
  const item = (label: string, metric: CoverageMetric, detail = '') => `
    <span class="coverage-item">
      <strong>${label}</strong>
      <span>${metric.count}/${label === 'Completed' ? coverage.selectedRunCount : coverage.completed.count} (${percentage(metric.percentage)})${detail}</span>
    </span>
  `;

  byId('coverage-banner').innerHTML = `
    <div class="coverage-copy">
      <strong>Filtered cohort: ${coverage.selectedRunCount} runs</strong>
      <span>Global filters define the base cohort for cards and charts; outcome charts narrow to scored outcomes locally.</span>
    </div>
    <div class="coverage-metrics">
      ${item('Completed', coverage.completed)}
      ${item('Outcome-scored', coverage.outcomeScored)}
      ${item('Priced', coverage.priced)}
      ${item('Token telemetry', coverage.tokenTelemetry)}
      ${item('Mixed-model', coverage.mixedModel, '; excluded from model scoring')}
    </div>
  `;
}

function selectedRunIds(runs: PreparedRunRow[]): Set<string> {
  return new Set(runs.map((run) => run.runId));
}

function isDefaultFilterState(filters: FilterState): boolean {
  return JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS);
}

function populateSelect(
  id: string,
  values: string[],
  placeholder: string,
  options: { labelForValue?: (value: string) => string } = {},
): void {
  const select = byId<HTMLSelectElement>(id);
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = placeholder;
  select.append(defaultOption);

  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = options.labelForValue ? options.labelForValue(value) : value;
    select.append(option);
  });
}

function renderCards(runs: PreparedRunRow[], overview: OverviewData, usePrecomputed: boolean): void {
  const container = byId('overview-cards');
  const completedRunsList = runs.filter((run) => run.status !== 'open');
  const scored = scoredRuns(completedRunsList);
  const verificationRate = completedRunsList.length === 0
    ? null
    : completedRunsList.filter((run) => run.verificationTotalCount > 0).length / completedRunsList.length;
  const totalToolCalls = completedRunsList.reduce((sum, run) => sum + run.toolCallCount, 0);
  const totalToolFailures = completedRunsList.reduce((sum, run) => sum + run.toolFailureCount, 0);
  const resolvedRate = scored.length === 0
    ? null
    : scored.filter((run) => run.resolution === 'resolved').length / scored.length;
  const medianBusyTime = median(completedRunsList.map((run) => run.busyDurationMs));
  const costValues = completedRunsList
    .map(estimatedRunCostUsd)
    .filter((value): value is number => value !== null);

  const cards = usePrecomputed
    ? [
        {
          label: 'Runs',
          value: String(overview.totalCompletedRuns + overview.totalOpenRuns),
          detail: `${overview.totalScoredRuns} outcome-scored, ${overview.totalOpenRuns} open`,
        },
        {
          label: 'Avg satisfaction',
          value: overview.averageSatisfaction?.toFixed(2) ?? '—',
          detail: 'outcome-scored runs',
        },
        {
          label: 'Resolved',
          value: overview.totalScoredRuns === 0 ? '—' : percentage(overview.resolutionCounts.resolved / overview.totalScoredRuns),
          detail: 'of outcome-scored runs',
        },
        {
          label: 'Verification',
          value: percentage(overview.verificationRunRate),
          detail: 'of completed runs',
        },
        {
          label: 'Tool failures',
          value: percentage(overview.toolFailureRate),
          detail: 'of tool calls',
        },
        {
          label: 'Median time',
          value: overview.medianBusyDurationMs === null ? '—' : `${Math.round(overview.medianBusyDurationMs / 1000)}s`,
          detail: 'busy duration',
        },
        {
          label: 'Cost',
          value: overview.totalEstimatedCostUsd === null ? '—' : `$${Math.round(overview.totalEstimatedCostUsd * 100) / 100}`,
          detail: 'estimated spend',
        },
      ]
    : [
        {
          label: 'Runs',
          value: String(runs.length),
          detail: `${scored.length} outcome-scored, ${runs.filter((run) => run.status === 'open').length} open`,
        },
        {
          label: 'Avg satisfaction',
          value: average(scored.map((run) => run.satisfaction ?? 0))?.toFixed(2) ?? '—',
          detail: 'outcome-scored runs',
        },
        {
          label: 'Resolved',
          value: percentage(resolvedRate),
          detail: 'of outcome-scored runs',
        },
        {
          label: 'Verification',
          value: percentage(verificationRate),
          detail: 'of completed runs',
        },
        {
          label: 'Tool failures',
          value: totalToolCalls === 0 ? '—' : percentage(totalToolFailures / totalToolCalls),
          detail: `${totalToolFailures}/${totalToolCalls} calls`,
        },
        {
          label: 'Median time',
          value: medianBusyTime === null ? '—' : `${Math.round(medianBusyTime / 1000)}s`,
          detail: 'busy duration',
        },
        {
          label: 'Cost',
          value: costValues.length === 0 ? '—' : `$${Math.round(costValues.reduce((s, v) => s + v, 0) * 100) / 100}`,
          detail: 'estimated spend',
        },
      ];

  container.innerHTML = cards.map((card) => `
    <article class="metric-card">
      <p>${card.label}</p>
      <strong>${card.value}</strong>
      <p>${card.detail}</p>
    </article>
  `).join('');
}

function chartConfig() {
  return {
    autosize: { type: 'pad', contains: 'padding', resize: true },
    background: 'transparent',
    config: {
      view: { stroke: 'transparent' },
      axis: {
        labelColor: CHART_COLORS.muted,
        titleColor: CHART_COLORS.text,
        domainColor: CHART_COLORS.grid,
        gridColor: CHART_COLORS.grid,
        tickColor: CHART_COLORS.grid,
        labelFont: 'Atkinson Hyperlegible, Aptos, Segoe UI, sans-serif',
        titleFont: 'Aptos Display, Aptos, Segoe UI, sans-serif',
        labelFontSize: 11,
        titleFontSize: 12,
        titleFontWeight: 650,
        labelPadding: 6,
        titlePadding: 10,
        labelOverlap: 'greedy',
      },
      legend: {
        labelColor: CHART_COLORS.text,
        titleColor: CHART_COLORS.text,
        labelFont: 'Atkinson Hyperlegible, Aptos, Segoe UI, sans-serif',
        titleFont: 'Aptos Display, Aptos, Segoe UI, sans-serif',
        labelFontSize: 11,
        titleFontSize: 12,
        labelLimit: 300,
        labelPadding: 5,
        titlePadding: 10,
        rowPadding: 7,
        symbolSize: 110,
        layout: { top: { anchor: 'middle' }, bottom: { anchor: 'middle' } },
      },
      header: {
        labelColor: CHART_COLORS.text,
        titleColor: CHART_COLORS.text,
        labelFont: 'Aptos Display, Aptos, Segoe UI, sans-serif',
        titleFont: 'Aptos Display, Aptos, Segoe UI, sans-serif',
      },
    },
  };
}

function isCurrentRender(renderToken: number): boolean {
  return renderToken === activeRenderToken;
}

function disposeChartView(targetId: string): void {
  const view = chartViews.get(targetId);
  if (view) {
    view.finalize();
    chartViews.delete(targetId);
  }
}

async function renderSpec(
  targetId: string,
  spec: Record<string, unknown> | null,
  emptyMessage: string,
  renderToken: number,
): Promise<void> {
  if (!isCurrentRender(renderToken)) {
    return;
  }

  const target = byId(targetId);
  disposeChartView(targetId);

  if (!spec) {
    target.innerHTML = `<div class="chart-empty">${emptyMessage}</div>`;
    return;
  }

  const resolvedSpec = { ...spec };
  if (resolvedSpec.width === 'container') {
    const measuredWidth = target.getBoundingClientRect().width || target.parentElement?.getBoundingClientRect().width || 0;
    if (measuredWidth > 0) {
      resolvedSpec.width = Math.max(320, Math.floor(measuredWidth - 8));
    } else {
      // Keep fallback widths card-relative to avoid giant SVG overflow when initial layout width is unavailable.
      const isSpanTwoCard = target.closest('.span-2') !== null;
      resolvedSpec.width = isSpanTwoCard ? 760 : 380;
    }
  }

  // Faceted specs often ignore top-level width unless child spec width is explicit.
  // If the author omitted it, derive a sensible per-facet width from the measured container.
  if (typeof resolvedSpec.width === 'number' && resolvedSpec.facet && resolvedSpec.spec && typeof resolvedSpec.spec === 'object') {
    const childSpec = { ...(resolvedSpec.spec as Record<string, unknown>) };
    if (childSpec.width === undefined) {
      const facetObj = typeof resolvedSpec.facet === 'object' && resolvedSpec.facet !== null
        ? resolvedSpec.facet as Record<string, unknown>
        : null;
      const columns = typeof facetObj?.columns === 'number' && Number.isFinite(facetObj.columns)
        ? Math.max(1, Math.floor(facetObj.columns))
        : 1;
      childSpec.width = Math.max(280, Math.floor((resolvedSpec.width - 140) / columns));
      resolvedSpec.spec = childSpec;
    }
  }

  target.innerHTML = '';
  try {
    const result = await embed(
      target,
      { ...(chartConfig() as Record<string, unknown>), ...resolvedSpec } as any,
      { actions: false, renderer: 'svg' },
    );
    if (!isCurrentRender(renderToken)) {
      result.view.finalize();
      return;
    }
    chartViews.set(targetId, result.view);

    if (!target.querySelector('svg, canvas')) {
      target.innerHTML = '<div class="chart-empty">Chart rendered no visual output. Try refresh/reset filters.</div>';
    }
  } catch (error) {
    if (!isCurrentRender(renderToken)) {
      return;
    }
    const message = toErrorMessage(error);
    target.innerHTML = `<div class="chart-empty">Unable to render chart: ${escapeHtml(message)}</div>`;
  }
}

function setNote(id: string, text: string, renderToken: number): void {
  if (!isCurrentRender(renderToken)) {
    return;
  }
  byId(id).textContent = text;
}

function completedRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return runs.filter((run) => run.status !== 'open');
}

// ─── Data preparation ────────────────────────────────────────────────────────

interface OutcomeEstimateRow {
  label: string;
  detail: string;
  runCount: number;
  scoredRunCount: number;
  resolvedCount: number;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciEstimated: boolean;
  ciLabel: string;
  nLabel: string;
  resolveRate: number | null;
  resolveCiLabel: string;
  modelId?: string;
  thinkingLevel?: string;
}

interface DailyOutcomeRow {
  bucketStart: string;
  runCount: number;
  scoredRunCount: number;
  meanSatisfaction: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  ciEstimated: boolean;
  ciLabel: string;
  nLabel: string;
  verificationRate: number | null;
  toolFailureRate: number | null;
  averageBusyMinutes: number | null;
  modelMix: string;
  rollingMean: number | null;
  rollingLower: number | null;
  rollingUpper: number | null;
  rollingN: number;
}

interface CompositionRow {
  modelId: string;
  resolution: string;
  count: number;
  share: number;
  resolvedShare: number;
  scoredRunCount: number;
  nLabel: string;
}

interface DimensionRow {
  dimension: string;
  value: string;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  scoredRunCount: number;
  runCount: number;
  nLabel: string;
}

interface MutationBucketCompositionRow {
  bucket: string;
  bucketIndex: number;
  resolution: string;
  count: number;
  share: number;
  scoredRunCount: number;
}

interface MutationBucketMeanRow {
  bucket: string;
  bucketIndex: number;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  scoredRunCount: number;
  nLabel: string;
}

interface VerificationContrastRow {
  label: string;
  state: string;
  baselineLabel: string;
  scoredRunCount: number;
  baselineScoredRunCount: number;
  satisfactionDelta: number;
  ciLower: number;
  ciUpper: number;
  ciEstimated: boolean;
  ciLabel: string;
  nLabel: string;
}

interface ToolDiagnosticRow {
  toolName: string;
  callCount: number;
  failureCount: number;
  failureRate: number;
  failureCiLower: number;
  failureCiUpper: number;
  failureCiLabel: string;
  affectedRunCount: number;
  usedScoredRunCount: number;
  unusedScoredRunCount: number;
  satisfactionDelta: number | null;
  deltaCiLower: number | null;
  deltaCiUpper: number | null;
  deltaCiLabel: string;
}

interface MutationRunRow {
  lineMutationTotal: number;
  satisfaction: number;
  resolution: string;
  modelId: string;
  touchedFileCount: number;
  toolFailureCount: number;
  subagentCallCount: number;
}

function normalizedExperimentLabel(value: string | null | undefined): string {
  return value?.trim() || '(none)';
}

function shortHashLabel(prefix: string | null | undefined, fallback: string): string {
  return prefix?.trim() ? prefix.slice(0, 8) : fallback;
}

function promptDisplayLabel(prefix: string | null | undefined, capturedAt: string | null | undefined, fallback: string): string {
  const hash = prefix?.trim();
  if (!hash) return fallback;
  const datePart = capturedAt ? ` (${capturedAt.slice(0, 10)})` : '';
  return hash.slice(0, 8) + datePart;
}

function skillDisplayLabel(name: string, lastModifiedAt: string | null): string {
  const datePart = lastModifiedAt ? ` (${lastModifiedAt.slice(0, 10)})` : '';
  const maxLen = 32;
  const full = name + datePart;
  if (full.length <= maxLen) return full;
  const truncName = name.slice(0, maxLen - datePart.length - 1);
  return truncName + '\u2026' + datePart;
}

function selectedCompletedRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return completedRuns(runs);
}

function selectedScoredCompletedRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return scoredRuns(selectedCompletedRuns(runs));
}

function groupRunsBy(
  runs: PreparedRunRow[],
  keyForRun: (run: PreparedRunRow) => string,
): Map<string, PreparedRunRow[]> {
  const groups = new Map<string, PreparedRunRow[]>();
  runs.forEach((run) => {
    const key = keyForRun(run);
    const existing = groups.get(key) ?? [];
    existing.push(run);
    groups.set(key, existing);
  });
  return groups;
}

function outcomeEstimateRow(
  label: string,
  detail: string,
  runs: PreparedRunRow[],
  scoredOverride?: PreparedRunRow[],
): OutcomeEstimateRow | null {
  const scored = scoredOverride ?? scoredRuns(runs);
  const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
  if (!interval) {
    return null;
  }

  const resolvedCount = scored.filter((run) => run.resolution === 'resolved').length;
  const resolveInterval = wilsonInterval(resolvedCount, scored.length);

  return {
    label,
    detail,
    runCount: runs.length,
    scoredRunCount: scored.length,
    resolvedCount,
    meanSatisfaction: interval.mean,
    ciLower: interval.lower,
    ciUpper: interval.upper,
    ciEstimated: interval.ciEstimated,
    ciLabel: interval.ciLabel,
    nLabel: `n=${scored.length}/${runs.length}`,
    resolveRate: resolveInterval?.rate ?? null,
    resolveCiLabel: resolveInterval?.ciLabel ?? 'No scored runs',
  };
}

function dailyOutcomeRows(runs: PreparedRunRow[]): DailyOutcomeRow[] {
  const groups = groupRunsBy(runs, (run) => run.startedDay);
  const sortedDays = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));

  const dayScoredValues = new Map<string, number[]>();
  sortedDays.forEach(([day, groupedRuns]) => {
    const scored = scoredRuns(selectedCompletedRuns(groupedRuns));
    dayScoredValues.set(day, scored.map((run) => run.satisfaction ?? 0));
  });

  return sortedDays.map(([bucketStart, groupedRuns], index) => {
      const completed = selectedCompletedRuns(groupedRuns);
      const scored = scoredRuns(completed);
      const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
      const toolCalls = completed.reduce((sum, run) => sum + run.toolCallCount, 0);
      const toolFailures = completed.reduce((sum, run) => sum + run.toolFailureCount, 0);
      const modelMix = [...groupedRuns.reduce((counts, run) => {
        const modelId = run.modelId ?? '(unknown)';
        counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([modelId, count]) => `${modelId}: ${count}`)
        .join(', ');

      const pooled: number[] = [];
      const lower = Math.max(0, index - 3);
      const upper = Math.min(sortedDays.length - 1, index + 3);
      for (let offset = lower; offset <= upper; offset++) {
        const day = sortedDays[offset]?.[0];
        if (!day) continue;
        pooled.push(...(dayScoredValues.get(day) ?? []));
      }
      let rollingMean: number | null = null;
      let rollingLower: number | null = null;
      let rollingUpper: number | null = null;
      if (pooled.length >= 3) {
        const rollingInterval = meanInterval(pooled, { min: 1, max: 5 });
        if (rollingInterval) {
          rollingMean = rollingInterval.mean;
          rollingLower = rollingInterval.lower;
          rollingUpper = rollingInterval.upper;
        }
      }

      return {
        bucketStart,
        runCount: groupedRuns.length,
        scoredRunCount: scored.length,
        meanSatisfaction: interval?.mean ?? null,
        ciLower: interval?.lower ?? null,
        ciUpper: interval?.upper ?? null,
        ciEstimated: interval?.ciEstimated ?? false,
        ciLabel: interval?.ciLabel ?? 'No scored runs',
        nLabel: `n=${scored.length}/${groupedRuns.length}`,
        verificationRate: completed.length === 0
          ? null
          : completed.filter((run) => run.verificationTotalCount > 0).length / completed.length,
        toolFailureRate: toolCalls === 0 ? null : toolFailures / toolCalls,
        averageBusyMinutes: average(completed.map((run) => run.busyDurationMs / 60000)),
        modelMix,
        rollingMean,
        rollingLower,
        rollingUpper,
        rollingN: pooled.length,
      };
    });
}

function userPrimaryModelOutcomes(runs: PreparedRunRow[]): PreparedRunRow[] {
  return runs.filter((run) => (
    run.scored
    && run.satisfaction !== null
    && !run.mixedModelConfig
    && !run.mixedTreatmentConfig
    && run.outcomeSource === 'user'
  ));
}

export function modelThinkingRows(runs: PreparedRunRow[]): OutcomeEstimateRow[] {
  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => JSON.stringify([
    modelFamilyKey(run),
    formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? '(unspecified)'),
  ]));

  return [...groups.entries()]
    .map(([key, groupedRuns]) => {
      const [modelId, thinkingLevel] = JSON.parse(key) as [string, string];
      const row = outcomeEstimateRow(
        `${modelId} [${thinkingLevel}]`,
        `Model ${modelId} at thinking=${thinkingLevel}`,
        groupedRuns,
        userPrimaryModelOutcomes(groupedRuns),
      );
      if (row) {
        row.modelId = modelId;
        row.thinkingLevel = thinkingLevel;
      }
      return row;
    })
    .filter((row): row is OutcomeEstimateRow => Boolean(row))
    .sort((left, right) => {
      if (right.scoredRunCount !== left.scoredRunCount) return right.scoredRunCount - left.scoredRunCount;
      return right.meanSatisfaction - left.meanSatisfaction;
    })
    .slice(0, 14);
}

export function compositionByModelRows(runs: PreparedRunRow[]): CompositionRow[] {
  const groups = groupRunsBy(userPrimaryModelOutcomes(selectedCompletedRuns(runs)), (run) => modelFamilyKey(run));
  const ranked = [...groups.entries()]
    .sort(([, leftRuns], [, rightRuns]) => rightRuns.length - leftRuns.length)
    .slice(0, 12);
  const resolutions = ['resolved', 'partially_resolved', 'unresolved', 'unknown'];
  const out: CompositionRow[] = [];
  ranked.forEach(([modelId, groupedRuns]) => {
    const total = groupedRuns.length;
    const resolvedCount = groupedRuns.filter((run) => (run.resolution ?? 'unknown') === 'resolved').length;
    const resolvedShare = total === 0 ? 0 : resolvedCount / total;
    resolutions.forEach((resolution) => {
      const count = groupedRuns.filter((run) => (run.resolution ?? 'unknown') === resolution).length;
      out.push({
        modelId,
        resolution,
        count,
        share: total === 0 ? 0 : count / total,
        resolvedShare,
        scoredRunCount: total,
        nLabel: `n=${total}`,
      });
    });
  });
  return out;
}

function verificationMeanRows(runs: PreparedRunRow[]): OutcomeEstimateRow[] {
  const labels: Record<string, string> = {
    none: 'No verification',
    passing: 'Passing checks',
    failing: 'At least one failing check',
  };
  const groups = groupRunsBy(selectedScoredCompletedRuns(runs), (run) => run.verificationState);

  return ['none', 'passing', 'failing']
    .map((state) => outcomeEstimateRow(labels[state] ?? state, `verificationState=${state}`, groups.get(state) ?? []))
    .filter((row): row is OutcomeEstimateRow => Boolean(row));
}

function verificationContrastRows(runs: PreparedRunRow[]): VerificationContrastRow[] {
  const scored = selectedScoredCompletedRuns(runs);
  const baseline = scored.filter((run) => run.verificationState === 'none').map((run) => run.satisfaction ?? 0);
  if (baseline.length === 0) {
    return [];
  }

  const comparisons = [
    { state: 'passing', label: 'Passing checks' },
    { state: 'failing', label: 'At least one failing check' },
  ];

  return comparisons.map(({ state, label }) => {
    const groupValues = scored
      .filter((run) => run.verificationState === state)
      .map((run) => run.satisfaction ?? 0);
    const interval = meanDifferenceInterval(groupValues, baseline, { min: -4, max: 4 });
    if (!interval) {
      return null;
    }
    return {
      label,
      state,
      baselineLabel: 'No verification',
      scoredRunCount: groupValues.length,
      baselineScoredRunCount: baseline.length,
      satisfactionDelta: interval.difference,
      ciLower: interval.lower,
      ciUpper: interval.upper,
      ciEstimated: interval.ciEstimated,
      ciLabel: interval.ciLabel,
      nLabel: `n=${groupValues.length} vs ${baseline.length}`,
    };
  }).filter((row): row is VerificationContrastRow => Boolean(row));
}

function toolDiagnosticRows(runs: PreparedRunRow[], toolRows: PreparedToolUsageRow[]): ToolDiagnosticRow[] {
  const runIds = selectedRunIds(runs);
  const relevantToolRows = toolRows.filter((row) => runIds.has(row.runId));
  const selectedScored = selectedScoredCompletedRuns(runs);
  const grouped = new Map<string, PreparedToolUsageRow[]>();

  relevantToolRows.forEach((row) => {
    const existing = grouped.get(row.toolName) ?? [];
    existing.push(row);
    grouped.set(row.toolName, existing);
  });

  return [...grouped.entries()]
    .map(([toolName, rows]) => {
      const callCount = rows.reduce((sum, row) => sum + row.callCount, 0);
      const failureCount = rows.reduce((sum, row) => sum + row.failureCount, 0);
      const failureInterval = wilsonInterval(failureCount, callCount);
      if (!failureInterval) {
        return null;
      }

      const usedRunIds = new Set(rows.map((row) => row.runId));
      const usedValues = selectedScored
        .filter((run) => usedRunIds.has(run.runId))
        .map((run) => run.satisfaction ?? 0);
      const unusedValues = selectedScored
        .filter((run) => !usedRunIds.has(run.runId))
        .map((run) => run.satisfaction ?? 0);
      const deltaInterval = meanDifferenceInterval(usedValues, unusedValues, { min: -4, max: 4 });

      return {
        toolName,
        callCount,
        failureCount,
        failureRate: failureInterval.rate,
        failureCiLower: failureInterval.lower,
        failureCiUpper: failureInterval.upper,
        failureCiLabel: failureInterval.ciLabel,
        affectedRunCount: usedRunIds.size,
        usedScoredRunCount: usedValues.length,
        unusedScoredRunCount: unusedValues.length,
        satisfactionDelta: deltaInterval?.difference ?? null,
        deltaCiLower: deltaInterval?.lower ?? null,
        deltaCiUpper: deltaInterval?.upper ?? null,
        deltaCiLabel: deltaInterval?.ciLabel ?? 'Need scored used and unused runs',
      };
    })
    .filter((row): row is ToolDiagnosticRow => Boolean(row))
    .sort((left, right) => right.callCount - left.callCount || right.failureRate - left.failureRate)
    .slice(0, 12);
}

function subagentDoseRows(runs: PreparedRunRow[]): OutcomeEstimateRow[] {
  const bucketOrder = ['None', '1', '2–3', '4+'];
  function bucket(n: number): string {
    if (n === 0) return 'None';
    if (n === 1) return '1';
    if (n <= 3) return '2–3';
    return '4+';
  }

  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => bucket(run.subagentCallCount));
  return bucketOrder
    .map((label) => outcomeEstimateRow(label, `${label} subagent calls`, groups.get(label) ?? []))
    .filter((row): row is OutcomeEstimateRow => Boolean(row));
}

function dimensionComparisonRows(runs: PreparedRunRow[]): { rows: DimensionRow[]; dimensionsWithContrast: number } {
  const dimensions: Array<{ name: string; key: (run: PreparedRunRow) => string }> = [
    { name: 'Experiment', key: (run) => normalizedExperimentLabel(run.experimentAssignment) },
    { name: 'Prompt', key: (run) => promptDisplayLabel(run.promptHashPrefix, run.promptCapturedAt, 'no-prompt') },
    { name: 'Tool set', key: (run) => shortHashLabel(run.toolSetHashPrefix, 'no-tools') },
  ];
  const completed = selectedCompletedRuns(runs);
  const out: DimensionRow[] = [];
  let dimensionsWithContrast = 0;

  dimensions.forEach(({ name, key }) => {
    const groups = groupRunsBy(completed, key);
    if (groups.size < 2) return;
    const dimRows: DimensionRow[] = [];
    [...groups.entries()].forEach(([value, groupedRuns]) => {
      const scored = scoredRuns(groupedRuns);
      if (scored.length < 1) return;
      const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
      if (!interval) return;
      dimRows.push({
        dimension: name,
        value,
        meanSatisfaction: interval.mean,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        ciLabel: interval.ciLabel,
        scoredRunCount: scored.length,
        runCount: groupedRuns.length,
        nLabel: `n=${scored.length}/${groupedRuns.length}`,
      });
    });
    if (dimRows.length === 0) return;
    dimRows.sort((left, right) => right.scoredRunCount - left.scoredRunCount);
    out.push(...dimRows.slice(0, 6));
    dimensionsWithContrast += 1;
  });

  // ── Skill set: expand individual skills ────────────────────────────────────
  const skillGroups = new Map<string, PreparedRunRow[]>();
  for (const run of completed) {
    for (const entry of run.skillEntries ?? []) {
      const label = skillDisplayLabel(entry.name, entry.lastModifiedAt);
      const existing = skillGroups.get(label) ?? [];
      existing.push(run);
      skillGroups.set(label, existing);
    }
  }
  if (skillGroups.size >= 2) {
    const dimRows: DimensionRow[] = [];
    [...skillGroups.entries()].forEach(([value, groupedRuns]) => {
      const scored = scoredRuns(groupedRuns);
      if (scored.length < 1) return;
      const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
      if (!interval) return;
      dimRows.push({
        dimension: 'Skill set',
        value,
        meanSatisfaction: interval.mean,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        ciLabel: interval.ciLabel,
        scoredRunCount: scored.length,
        runCount: groupedRuns.length,
        nLabel: `n=${scored.length}/${groupedRuns.length}`,
      });
    });
    if (dimRows.length > 0) {
      dimRows.sort((left, right) => right.scoredRunCount - left.scoredRunCount);
      out.push(...dimRows.slice(0, 8));
      dimensionsWithContrast += 1;
    }
  }

  return { rows: out, dimensionsWithContrast };
}

function quartileBoundaries(values: number[]): { q1: number; q2: number; q3: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const n = sorted.length;
  function quantile(probability: number): number {
    if (n === 0) return 0;
    if (n === 1) return sorted[0] ?? 0;
    const index = (n - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const lowerValue = sorted[lower] ?? 0;
    const upperValue = sorted[upper] ?? lowerValue;
    return lowerValue + (upperValue - lowerValue) * (index - lower);
  }
  return { q1: quantile(0.25), q2: quantile(0.5), q3: quantile(0.75) };
}

function formatBucketBound(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 100) return Math.round(value).toString();
  return Math.round(value * 10) / 10 + '';
}

interface MutationBucketing {
  composition: MutationBucketCompositionRow[];
  means: MutationBucketMeanRow[];
}

function mutationBucketRows(rows: MutationRunRow[]): MutationBucketing | null {
  if (rows.length < 8) return null;
  const { q1, q2, q3 } = quartileBoundaries(rows.map((row) => row.lineMutationTotal));
  const labels = [
    `XS (≤${formatBucketBound(q1)})`,
    `S (${formatBucketBound(q1)}–${formatBucketBound(q2)})`,
    `M (${formatBucketBound(q2)}–${formatBucketBound(q3)})`,
    `L (>${formatBucketBound(q3)})`,
  ];
  function bucketFor(value: number): number {
    if (value <= q1) return 0;
    if (value <= q2) return 1;
    if (value <= q3) return 2;
    return 3;
  }

  const bucketed: MutationRunRow[][] = [[], [], [], []];
  rows.forEach((row) => {
    const idx = bucketFor(row.lineMutationTotal);
    bucketed[idx]?.push(row);
  });

  const resolutions = ['resolved', 'partially_resolved', 'unresolved', 'unknown'];
  const composition: MutationBucketCompositionRow[] = [];
  const means: MutationBucketMeanRow[] = [];

  bucketed.forEach((bucketRows, bucketIndex) => {
    const label = labels[bucketIndex] ?? `bucket ${bucketIndex}`;
    const total = bucketRows.length;
    if (total === 0) {
      resolutions.forEach((resolution) => {
        composition.push({ bucket: label, bucketIndex, resolution, count: 0, share: 0, scoredRunCount: 0 });
      });
      return;
    }
    resolutions.forEach((resolution) => {
      const count = bucketRows.filter((row) => (row.resolution ?? 'unknown') === resolution).length;
      composition.push({
        bucket: label,
        bucketIndex,
        resolution,
        count,
        share: count / total,
        scoredRunCount: total,
      });
    });
    const interval = meanInterval(bucketRows.map((row) => row.satisfaction), { min: 1, max: 5 });
    if (interval) {
      means.push({
        bucket: label,
        bucketIndex,
        meanSatisfaction: interval.mean,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        ciLabel: interval.ciLabel,
        scoredRunCount: total,
        nLabel: `n=${total}`,
      });
    }
  });

  return { composition, means };
}

function mutationRows(runs: PreparedRunRow[]): MutationRunRow[] {
  return selectedScoredCompletedRuns(runs).map((run) => ({
    lineMutationTotal: run.lineMutationTotal,
    satisfaction: run.satisfaction ?? 0,
    resolution: run.resolution ?? 'unknown',
    modelId: run.modelId ?? '(unknown)',
    touchedFileCount: run.touchedFileCount,
    toolFailureCount: run.toolFailureCount,
    subagentCallCount: run.subagentCallCount,
  }));
}

// ── Time/effort analysis ─────────────────────────────────────────────────────

interface ModelEfficiencyRow {
  label: string;
  detail: string;
  runCount: number;
  medianBusyMinutes: number;
  p25BusyMinutes: number;
  p75BusyMinutes: number;
  medianBusyLabel: string;
  p25BusyLabel: string;
  p75BusyLabel: string;
  nLabel: string;
  thinkingLevel: string;
}

interface TimeQualityRow {
  busyMinutes: number;
  satisfaction: number;
  resolution: string;
  modelId: string;
  toolFailureCount: number;
  lineMutationTotal: number;
}

interface TimeProductivityRow {
  label: string;
  modelId: string;
  thinkingLevel: string;
  runCount: number;
  medianMinutesPerTurn: number;
  p25MinutesPerTurn: number;
  p75MinutesPerTurn: number;
  medianMinutesPerTurnLabel: string;
  p25MinutesPerTurnLabel: string;
  p75MinutesPerTurnLabel: string;
  nLabel: string;
}

interface TimeParetoRow {
  rank: number;
  label: string;
  busyMinutes: number;
  cumulativeShare: number;
  modelId: string;
  thinkingLevel: string;
  resolution: string;
  satisfaction: number | null;
  startedAt: string;
  busyLabel: string;
}

interface ContextSaturationPointRow {
  fillShare: number;
  satisfaction: number;
  resolution: string;
  modelId: string;
  busyMinutes: number;
  contextTokens: number;
  contextLimit: number;
  fillLabel: string;
}

interface SubagentTaskDoseRow {
  label: string;
  detail: string;
  runCount: number;
  scoredRunCount: number;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciEstimated: boolean;
  ciLabel: string;
  nLabel: string;
  resolvedCount: number;
  resolveRate: number | null;
  resolveCiLabel: string;
}

interface ComplexitySubagentRow {
  lineMutationTotal: number;
  subagentCallCount: number;
  satisfaction: number;
  resolution: string;
  modelId: string;
  touchedFileCount: number;
  toolFailureCount: number;
  busyMinutes: number;
}

interface ComplexitySubagentTierRow {
  bucket: string;
  bucketIndex: number;
  runCount: number;
  scoredRunCount: number;
  meanLineMutations: number;
  meanSubagentCalls: number;
  subagentUseRate: number;
  subagentUseCiLower: number;
  subagentUseCiUpper: number;
  subagentUseCiLabel: string;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  nLabel: string;
}

interface SubagentRoiTierRow {
  bucket: string;
  bucketIndex: number;
  group: 'With subagents' | 'No subagents';
  runCount: number;
  scoredRunCount: number;
  meanSatisfaction: number;
  ciLower: number;
  ciUpper: number;
  ciLabel: string;
  resolveRate: number | null;
  resolveCiLower: number | null;
  resolveCiUpper: number | null;
  resolveCiLabel: string;
  nLabel: string;
}

interface SubagentDiversityRow extends OutcomeEstimateRow {
  bucketIndex: number;
  subagentCallRate: number;
  subagentTaskRate: number;
}

interface TaskSizeDistributionRow {
  bucket: string;
  bucketIndex: number;
  resolution: string;
  count: number;
}

interface SubagentTrendRow {
  bucketStart: string;
  totalRunCount: number;
  scoredRunCount: number;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentCallRate: number | null;
  subagentTaskRate: number | null;
  subagentCallRateLabel: string;
  subagentTaskRateLabel: string;
  runsWithSubagents: number;
  subagentPenetration: number | null;
  penetrationCiLower: number | null;
  penetrationCiUpper: number | null;
  penetrationCiLabel: string;
}

interface OutcomeTimeSummaryRow {
  label: string;
  detail: string;
  runCount: number;
  scoredRunCount: number;
  resolvedCount: number;
  resolvedRate: number;
  resolvedCiLower: number;
  resolvedCiUpper: number;
  resolvedCiLabel: string;
  medianBusyMinutes: number;
  p25BusyMinutes: number;
  p75BusyMinutes: number;
  medianBusyLabel: string;
  p25BusyLabel: string;
  p75BusyLabel: string;
  nLabel: string;
}

interface ModelFrontierRow extends OutcomeTimeSummaryRow {
  modelId: string;
  thinkingLevel: string;
}

interface OutcomeTimeBucketRow extends OutcomeTimeSummaryRow {
  bucket: string;
  bucketIndex: number;
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function busyMinutesForChart(durationMs: number): number {
  return Math.max(durationMs / 60000, 1 / 60);
}

function formatBusyDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0s';
  }
  if (durationMs < 60000) {
    return `${Math.round(durationMs / 1000)}s`;
  }
  if (durationMs < 3600000) {
    return `${Math.round(durationMs / 60000)}m`;
  }
  const hours = durationMs / 3600000;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}h`;
}

function durationSummary(durationMsValues: number[]): {
  medianMs: number;
  p25Ms: number;
  p75Ms: number;
  medianBusyMinutes: number;
  p25BusyMinutes: number;
  p75BusyMinutes: number;
  medianBusyLabel: string;
  p25BusyLabel: string;
  p75BusyLabel: string;
} | null {
  const medianMs = quantile(durationMsValues, 0.5);
  const p25Ms = quantile(durationMsValues, 0.25);
  const p75Ms = quantile(durationMsValues, 0.75);
  if (medianMs === null || p25Ms === null || p75Ms === null) {
    return null;
  }
  return {
    medianMs,
    p25Ms,
    p75Ms,
    medianBusyMinutes: busyMinutesForChart(medianMs),
    p25BusyMinutes: busyMinutesForChart(p25Ms),
    p75BusyMinutes: busyMinutesForChart(p75Ms),
    medianBusyLabel: formatBusyDuration(medianMs),
    p25BusyLabel: formatBusyDuration(p25Ms),
    p75BusyLabel: formatBusyDuration(p75Ms),
  };
}

function outcomeTimeSummary(label: string, detail: string, runs: PreparedRunRow[]): OutcomeTimeSummaryRow | null {
  if (runs.length === 0) {
    return null;
  }
  const duration = durationSummary(runs.map((run) => run.busyDurationMs));
  const scored = scoredRuns(runs);
  const resolvedCount = scored.filter((run) => run.resolution === 'resolved').length;
  const resolvedInterval = wilsonInterval(resolvedCount, scored.length);
  if (!duration || !resolvedInterval) {
    return null;
  }
  return {
    label,
    detail,
    runCount: runs.length,
    scoredRunCount: scored.length,
    resolvedCount,
    resolvedRate: resolvedInterval.rate,
    resolvedCiLower: resolvedInterval.lower,
    resolvedCiUpper: resolvedInterval.upper,
    resolvedCiLabel: resolvedInterval.ciLabel,
    medianBusyMinutes: duration.medianBusyMinutes,
    p25BusyMinutes: duration.p25BusyMinutes,
    p75BusyMinutes: duration.p75BusyMinutes,
    medianBusyLabel: duration.medianBusyLabel,
    p25BusyLabel: duration.p25BusyLabel,
    p75BusyLabel: duration.p75BusyLabel,
    nLabel: `n=${scored.length}/${runs.length}`,
  };
}

function modelEfficiencyRows(runs: PreparedRunRow[]): ModelEfficiencyRow[] {
  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => JSON.stringify([
    run.modelId ?? '(unknown)',
    formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? '(unspecified)'),
  ]));

  return [...groups.entries()]
    .map(([key, groupedRuns]) => {
      const [modelId, thinkingLevel] = JSON.parse(key) as [string, string];
      const duration = durationSummary(groupedRuns.map((run) => run.busyDurationMs));
      if (!duration) return null;

      return {
        label: `${modelId} [${thinkingLevel}]`,
        detail: `Model ${modelId} at thinking=${thinkingLevel}`,
        runCount: groupedRuns.length,
        medianBusyMinutes: duration.medianBusyMinutes,
        p25BusyMinutes: duration.p25BusyMinutes,
        p75BusyMinutes: duration.p75BusyMinutes,
        medianBusyLabel: duration.medianBusyLabel,
        p25BusyLabel: duration.p25BusyLabel,
        p75BusyLabel: duration.p75BusyLabel,
        nLabel: `n=${groupedRuns.length}`,
        thinkingLevel,
      };
    })
    .filter((row): row is ModelEfficiencyRow => Boolean(row))
    .sort((a, b) => b.runCount - a.runCount)
    .slice(0, 14);
}

function modelFrontierRows(runs: PreparedRunRow[]): ModelFrontierRow[] {
  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => JSON.stringify([
    run.modelId ?? '(unknown)',
    formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? '(unspecified)'),
  ]));

  return [...groups.entries()]
    .map(([key, groupedRuns]) => {
      const [modelId, thinkingLevel] = JSON.parse(key) as [string, string];
      const summary = outcomeTimeSummary(
        `${modelId} [${thinkingLevel}]`,
        `Model ${modelId} at thinking=${thinkingLevel}`,
        groupedRuns,
      );
      if (!summary) {
        return null;
      }
      return {
        ...summary,
        modelId,
        thinkingLevel,
      };
    })
    .filter((row): row is ModelFrontierRow => Boolean(row))
    .sort((left, right) => left.medianBusyMinutes - right.medianBusyMinutes || right.resolvedRate - left.resolvedRate || right.scoredRunCount - left.scoredRunCount)
    .slice(0, 14);
}

function verificationCostRows(runs: PreparedRunRow[]): OutcomeTimeBucketRow[] {
  const bucketOrder = ['0', '1', '2-3', '4+'];
  const bucketLabels: Record<string, string> = {
    '0': '0 checks',
    '1': '1 check',
    '2-3': '2–3 checks',
    '4+': '4+ checks',
  };
  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => run.verificationCountBucket);

  return bucketOrder
    .map((bucket, bucketIndex) => {
      const summary = outcomeTimeSummary(bucketLabels[bucket] ?? bucket, `verificationCountBucket=${bucket}`, groups.get(bucket) ?? []);
      if (!summary) {
        return null;
      }
      return {
        ...summary,
        bucket: bucketLabels[bucket] ?? bucket,
        bucketIndex,
      };
    })
    .filter((row): row is OutcomeTimeBucketRow => Boolean(row));
}

function toolFailureBurdenRows(runs: PreparedRunRow[]): OutcomeTimeBucketRow[] {
  const bucketLabels = ['0 failures', '1 failure', '2–3 failures', '4+ failures'];
  const bucketFor = (failureCount: number): number => {
    if (failureCount <= 0) return 0;
    if (failureCount === 1) return 1;
    if (failureCount <= 3) return 2;
    return 3;
  };

  const bucketed: PreparedRunRow[][] = [[], [], [], []];
  selectedCompletedRuns(runs).forEach((run) => {
    bucketed[bucketFor(run.toolFailureCount)]?.push(run);
  });

  return bucketed
    .map((bucketRuns, bucketIndex) => {
      const label = bucketLabels[bucketIndex] ?? `bucket ${bucketIndex}`;
      const summary = outcomeTimeSummary(label, label, bucketRuns);
      if (!summary) {
        return null;
      }
      return {
        ...summary,
        bucket: label,
        bucketIndex,
      };
    })
    .filter((row): row is OutcomeTimeBucketRow => Boolean(row));
}

function timeQualityRows(runs: PreparedRunRow[]): TimeQualityRow[] {
  return selectedScoredCompletedRuns(runs).map((run) => ({
    busyMinutes: busyMinutesForChart(run.busyDurationMs),
    satisfaction: run.satisfaction ?? 0,
    resolution: run.resolution ?? 'unknown',
    modelId: run.modelId ?? '(unknown)',
    toolFailureCount: run.toolFailureCount,
    lineMutationTotal: run.lineMutationTotal,
  }));
}

function timeProductivityRows(runs: PreparedRunRow[]): TimeProductivityRow[] {
  const eligible = selectedCompletedRuns(runs).filter((run) => run.assistantTurnCount > 0);
  const groups = groupRunsBy(eligible, (run) => JSON.stringify([
    run.modelId ?? '(unknown)',
    formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? '(unspecified)'),
  ]));

  return [...groups.entries()]
    .map(([key, groupedRuns]) => {
      const [modelId, thinkingLevel] = JSON.parse(key) as [string, string];
      // minutes spent per assistant turn (busy time / turn count)
      const perTurnMs = groupedRuns.map((run) => run.busyDurationMs / Math.max(run.assistantTurnCount, 1));
      const summary = durationSummary(perTurnMs);
      if (!summary) return null;
      return {
        label: `${modelId} [${thinkingLevel}]`,
        modelId,
        thinkingLevel,
        runCount: groupedRuns.length,
        medianMinutesPerTurn: summary.medianBusyMinutes,
        p25MinutesPerTurn: summary.p25BusyMinutes,
        p75MinutesPerTurn: summary.p75BusyMinutes,
        medianMinutesPerTurnLabel: summary.medianBusyLabel,
        p25MinutesPerTurnLabel: summary.p25BusyLabel,
        p75MinutesPerTurnLabel: summary.p75BusyLabel,
        nLabel: `n=${groupedRuns.length}`,
      };
    })
    .filter((row): row is TimeProductivityRow => Boolean(row))
    .sort((a, b) => a.medianMinutesPerTurn - b.medianMinutesPerTurn)
    .slice(0, 14);
}

function timeParetoRows(runs: PreparedRunRow[], limit = 30): TimeParetoRow[] {
  const completed = selectedCompletedRuns(runs).filter((run) => run.busyDurationMs > 0);
  if (completed.length === 0) return [];
  const totalBusyMs = completed.reduce((sum, run) => sum + run.busyDurationMs, 0);
  if (totalBusyMs <= 0) return [];

  const sorted = [...completed].sort((a, b) => b.busyDurationMs - a.busyDurationMs);
  const topN = sorted.slice(0, limit);

  let cumulativeMs = 0;
  const rows: TimeParetoRow[] = topN.map((run, index) => {
    cumulativeMs += run.busyDurationMs;
    const startedShort = run.startedAt ? run.startedAt.slice(0, 10) : '—';
    const modelId = run.modelId ?? '(unknown)';
    return {
      rank: index + 1,
      label: `#${index + 1} · ${modelId} · ${startedShort}`,
      busyMinutes: run.busyDurationMs / 60000,
      cumulativeShare: cumulativeMs / totalBusyMs,
      modelId,
      thinkingLevel: formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? '(unspecified)'),
      resolution: run.resolution ?? 'unknown',
      satisfaction: run.satisfaction,
      startedAt: startedShort,
      busyLabel: formatBusyDuration(run.busyDurationMs),
    };
  });

  return rows;
}

function contextSaturationPoints(runs: PreparedRunRow[]): ContextSaturationPointRow[] {
  return selectedScoredCompletedRuns(runs)
    .filter((run) => run.contextTokens !== null && run.contextLimit !== null && (run.contextLimit ?? 0) > 0)
    .map((run) => {
      const fillShare = Math.min((run.contextTokens ?? 0) / (run.contextLimit ?? 1), 1);
      return {
        fillShare,
        satisfaction: run.satisfaction ?? 0,
        resolution: run.resolution ?? 'unknown',
        modelId: run.modelId ?? '(unknown)',
        busyMinutes: run.busyDurationMs / 60000,
        contextTokens: run.contextTokens ?? 0,
        contextLimit: run.contextLimit ?? 0,
        fillLabel: `${(fillShare * 100).toFixed(1)}%`,
      };
    });
}

function subagentTaskDoseRows(runs: PreparedRunRow[]): SubagentTaskDoseRow[] {
  const bucketOrder = ['None', '1', '2–3', '4+'];
  function bucket(n: number): string {
    if (n === 0) return 'None';
    if (n === 1) return '1';
    if (n <= 3) return '2–3';
    return '4+';
  }

  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => bucket(run.subagentTaskCount));
  const result: SubagentTaskDoseRow[] = [];

  bucketOrder.forEach((label) => {
    const groupedRuns = groups.get(label) ?? [];
    const scored = scoredRuns(groupedRuns);
    if (scored.length === 0) return;
    const interval = meanInterval(scored.map((run) => run.satisfaction ?? 0), { min: 1, max: 5 });
    if (!interval) return;
    const resolvedCount = scored.filter((run) => run.resolution === 'resolved').length;
    const resolveInterval = wilsonInterval(resolvedCount, scored.length);
    result.push({
      label,
      detail: `${label} subagent tasks`,
      runCount: groupedRuns.length,
      scoredRunCount: scored.length,
      meanSatisfaction: interval.mean,
      ciLower: interval.lower,
      ciUpper: interval.upper,
      ciEstimated: interval.ciEstimated,
      ciLabel: interval.ciLabel,
      nLabel: `n=${scored.length}/${groupedRuns.length}`,
      resolvedCount,
      resolveRate: resolveInterval?.rate ?? null,
      resolveCiLabel: resolveInterval?.ciLabel ?? 'No scored runs',
    });
  });

  return result;
}

function complexitySubagentScatterRows(runs: PreparedRunRow[]): ComplexitySubagentRow[] {
  return selectedScoredCompletedRuns(runs).map((run) => ({
    lineMutationTotal: run.lineMutationTotal,
    subagentCallCount: run.subagentCallCount,
    satisfaction: run.satisfaction ?? 0,
    resolution: run.resolution ?? 'unknown',
    modelId: run.modelId ?? '(unknown)',
    touchedFileCount: run.touchedFileCount,
    toolFailureCount: run.toolFailureCount,
    busyMinutes: busyMinutesForChart(run.busyDurationMs),
  }));
}

function complexitySubagentTierRows(
  scatterRows: ComplexitySubagentRow[],
  allRuns: PreparedRunRow[],
): ComplexitySubagentTierRow[] | null {
  if (scatterRows.length < 8) return null;
  const { q1, q2, q3 } = quartileBoundaries(scatterRows.map((row) => row.lineMutationTotal));
  const labels = [
    `XS (≤${formatBucketBound(q1)})`,
    `S (${formatBucketBound(q1)}–${formatBucketBound(q2)})`,
    `M (${formatBucketBound(q2)}–${formatBucketBound(q3)})`,
    `L (>${formatBucketBound(q3)})`,
  ];
  function tierFor(value: number): number {
    if (value <= q1) return 0;
    if (value <= q2) return 1;
    if (value <= q3) return 2;
    return 3;
  }

  const bucketed: ComplexitySubagentRow[][] = [[], [], [], []];
  scatterRows.forEach((row) => {
    bucketed[tierFor(row.lineMutationTotal)]?.push(row);
  });

  const completedBucketed: PreparedRunRow[][] = [[], [], [], []];
  selectedCompletedRuns(allRuns).forEach((run) => {
    const tier = tierFor(run.lineMutationTotal);
    bucketed[tier] ? completedBucketed[tier]?.push(run) : null;
  });

  return labels.map((label, bucketIndex) => {
    const bucketRows = bucketed[bucketIndex] ?? [];
    const completedBucketRows = completedBucketed[bucketIndex] ?? [];
    const total = bucketRows.length;
    if (total === 0) {
      return {
        bucket: label,
        bucketIndex,
        runCount: 0,
        scoredRunCount: 0,
        meanLineMutations: 0,
        meanSubagentCalls: 0,
        subagentUseRate: 0,
        subagentUseCiLower: 0,
        subagentUseCiUpper: 0,
        subagentUseCiLabel: '',
        meanSatisfaction: 0,
        ciLower: 0,
        ciUpper: 0,
        ciLabel: '',
        nLabel: 'n=0',
      };
    }

    const satisfactionInterval = meanInterval(bucketRows.map((row) => row.satisfaction), { min: 1, max: 5 });
    const subagentRuns = completedBucketRows.filter((run) => run.subagentCallCount > 0).length;
    const subagentUseInterval = wilsonInterval(subagentRuns, completedBucketRows.length);

    return {
      bucket: label,
      bucketIndex,
      runCount: completedBucketRows.length,
      scoredRunCount: total,
      meanLineMutations: average(bucketRows.map((row) => row.lineMutationTotal)) ?? 0,
      meanSubagentCalls: average(bucketRows.map((row) => row.subagentCallCount)) ?? 0,
      subagentUseRate: subagentUseInterval?.rate ?? 0,
      subagentUseCiLower: subagentUseInterval?.lower ?? 0,
      subagentUseCiUpper: subagentUseInterval?.upper ?? 0,
      subagentUseCiLabel: subagentUseInterval?.ciLabel ?? '',
      meanSatisfaction: satisfactionInterval?.mean ?? 0,
      ciLower: satisfactionInterval?.lower ?? 0,
      ciUpper: satisfactionInterval?.upper ?? 0,
      ciLabel: satisfactionInterval?.ciLabel ?? '',
      nLabel: `n=${total}/${completedBucketRows.length}`,
    };
  });
}

function subagentTrendRows(runs: PreparedRunRow[]): SubagentTrendRow[] {
  const groups = groupRunsBy(selectedCompletedRuns(runs), (run) => run.startedDay);
  const sortedDays = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));

  return sortedDays.map(([bucketStart, groupedRuns]) => {
    const scored = scoredRuns(groupedRuns);
    const subagentCallCount = groupedRuns.reduce((sum, run) => sum + run.subagentCallCount, 0);
    const subagentTaskCount = groupedRuns.reduce((sum, run) => sum + run.subagentTaskCount, 0);
    const runsWithSubagents = groupedRuns.filter((run) => run.subagentCallCount > 0).length;
    const penetrationInterval = wilsonInterval(runsWithSubagents, groupedRuns.length);

    return {
      bucketStart,
      totalRunCount: groupedRuns.length,
      scoredRunCount: scored.length,
      subagentCallCount,
      subagentTaskCount,
      subagentCallRate: groupedRuns.length === 0 ? null : subagentCallCount / groupedRuns.length,
      subagentTaskRate: groupedRuns.length === 0 ? null : subagentTaskCount / groupedRuns.length,
      subagentCallRateLabel: groupedRuns.length === 0 ? '—' : `${(subagentCallCount / groupedRuns.length).toFixed(2)} calls/run`,
      subagentTaskRateLabel: groupedRuns.length === 0 ? '—' : `${(subagentTaskCount / groupedRuns.length).toFixed(2)} tasks/run`,
      runsWithSubagents,
      subagentPenetration: penetrationInterval?.rate ?? null,
      penetrationCiLower: penetrationInterval?.lower ?? null,
      penetrationCiUpper: penetrationInterval?.upper ?? null,
      penetrationCiLabel: penetrationInterval?.ciLabel ?? '',
    };
  });
}

function subagentRoiTierRows(runs: PreparedRunRow[]): SubagentRoiTierRow[] {
  const completed = selectedCompletedRuns(runs);
  if (completed.length < 8) return [];
  const { q1, q2, q3 } = quartileBoundaries(completed.map((r) => r.lineMutationTotal));
  const labels = [
    `XS (\u2264${formatBucketBound(q1)})`,
    `S (${formatBucketBound(q1)}\u2013${formatBucketBound(q2)})`,
    `M (${formatBucketBound(q2)}\u2013${formatBucketBound(q3)})`,
    `L (>${formatBucketBound(q3)})`,
  ];
  const tierFor = (value: number): number => {
    if (value <= q1) return 0;
    if (value <= q2) return 1;
    if (value <= q3) return 2;
    return 3;
  };
  const rows: SubagentRoiTierRow[] = [];
  labels.forEach((label, idx) => {
    const bucketRuns = completed.filter((r) => tierFor(r.lineMutationTotal) === idx);
    (['With subagents', 'No subagents'] as const).forEach((group) => {
      const hasSub = group === 'With subagents';
      const subset = bucketRuns.filter((r) => (r.subagentCallCount > 0) === hasSub);
      if (subset.length === 0) return;
      const scored = scoredRuns(subset);
      const interval = meanInterval(scored.map((r) => r.satisfaction ?? 0), { min: 1, max: 5 });
      if (!interval) return;
      const resolvedCount = scored.filter((r) => r.resolution === 'resolved').length;
      const resolveInterval = wilsonInterval(resolvedCount, scored.length);
      rows.push({
        bucket: label,
        bucketIndex: idx,
        group,
        runCount: subset.length,
        scoredRunCount: scored.length,
        meanSatisfaction: interval.mean,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        ciLabel: interval.ciLabel,
        resolveRate: resolveInterval?.rate ?? null,
        resolveCiLower: resolveInterval?.lower ?? null,
        resolveCiUpper: resolveInterval?.upper ?? null,
        resolveCiLabel: resolveInterval?.ciLabel ?? 'No scored runs',
        nLabel: `n=${scored.length}/${subset.length}`,
      });
    });
  });
  return rows;
}

function subagentDiversityRows(runs: PreparedRunRow[]): SubagentDiversityRow[] {
  const bucketOrder = ['0', '1', '2', '3+'];
  const bucketFor = (n: number): string => {
    if (n === 0) return '0';
    if (n === 1) return '1';
    if (n === 2) return '2';
    return '3+';
  };
  const completed = selectedCompletedRuns(runs);
  const groups = groupRunsBy(completed, (r) => bucketFor(r.subagentAgentCount));
  const rows: SubagentDiversityRow[] = [];
  bucketOrder.forEach((label, idx) => {
    const groupedRuns = groups.get(label) ?? [];
    if (groupedRuns.length === 0) return;
    const base = outcomeEstimateRow(label, `${label} distinct subagents`, groupedRuns);
    if (!base) return;
    const totalCalls = groupedRuns.reduce((sum, r) => sum + r.subagentCallCount, 0);
    const totalTasks = groupedRuns.reduce((sum, r) => sum + r.subagentTaskCount, 0);
    rows.push({
      ...base,
      bucketIndex: idx,
      subagentCallRate: totalCalls / groupedRuns.length,
      subagentTaskRate: totalTasks / groupedRuns.length,
    });
  });
  return rows;
}

function taskSizeDistributionRows(runs: PreparedRunRow[]): TaskSizeDistributionRow[] {
  const bucketDefs: Array<{ label: string; test: (n: number) => boolean }> = [
    { label: '0', test: (n) => n === 0 },
    { label: '1\u201310', test: (n) => n >= 1 && n <= 10 },
    { label: '11\u2013100', test: (n) => n >= 11 && n <= 100 },
    { label: '101\u20131k', test: (n) => n >= 101 && n <= 1000 },
    { label: '>1k', test: (n) => n > 1000 },
  ];
  const completed = selectedCompletedRuns(runs);
  const counts = new Map<string, { bucketIndex: number; bucket: string; resolution: string; count: number }>();
  completed.forEach((run) => {
    const idx = bucketDefs.findIndex((b) => b.test(run.lineMutationTotal));
    if (idx < 0) return;
    const bucket = bucketDefs[idx]!.label;
    const resolution = run.resolution ?? 'unscored';
    const key = `${idx}|${resolution}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { bucketIndex: idx, bucket, resolution, count: 1 });
    }
  });
  return [...counts.values()].sort((a, b) => a.bucketIndex - b.bucketIndex);
}

function taskSizeTimeRows(runs: PreparedRunRow[]): OutcomeTimeBucketRow[] {
  const completed = selectedCompletedRuns(runs);
  if (completed.length < 8) return [];
  const { q1, q2, q3 } = quartileBoundaries(completed.map((r) => r.lineMutationTotal));
  const labels = [
    `XS (\u2264${formatBucketBound(q1)})`,
    `S (${formatBucketBound(q1)}\u2013${formatBucketBound(q2)})`,
    `M (${formatBucketBound(q2)}\u2013${formatBucketBound(q3)})`,
    `L (>${formatBucketBound(q3)})`,
  ];
  const tierFor = (value: number): number => {
    if (value <= q1) return 0;
    if (value <= q2) return 1;
    if (value <= q3) return 2;
    return 3;
  };
  return labels
    .map((label, idx) => {
      const groupedRuns = completed.filter((r) => tierFor(r.lineMutationTotal) === idx);
      const summary = outcomeTimeSummary(label, `workload-size tier ${label}`, groupedRuns);
      if (!summary) return null;
      return { ...summary, bucket: label, bucketIndex: idx };
    })
    .filter((row): row is OutcomeTimeBucketRow => Boolean(row));
}

// ─── Leaderboard data preparation ────────────────────────────────────────────

const DIMENSION_COLORS = ['#8de3ff', '#c0ff72', '#ffd479', '#ff8578', '#c084fc', '#f7b267'];
const DIMENSION_NAMES = ['Satisfaction', 'Resolution', 'File churn', 'Tool reliability', 'Verification', 'Token efficiency'];

interface LeaderboardCompositeRow {
  label: string;
  axisLabel: string;
  modelId: string;
  thinkingLevel: string;
  sortOrder: number;
  compositeScore: number | null;
  rank: number | null;
  rankLabel: string;
  scoreLabel: string;
  eligibilityLabel: string;
  unadjustedScoreLabel: string;
  adjustmentLabel: string;
  barLabel: string;
  evidenceWeightLabel: string;
  runCount: number;
  scoredRunCount: number;
  effectiveTaskCount: number;
  attributableTaskCount: number;
  scoringCoverageLabel: string;
  caseMixOverlapLabel: string;
  userOutcomeCount: number;
  agentOutcomeCount: number;
  mixedModelExcludedCount: number;
  mixedTreatmentExcludedCount: number;
  nLabel: string;
  outcomeSourceLabel: string;
  avgSatisfaction: string;
  resolutionRate: string;
  fileChurnRate: string;
  toolReliabilityRate: string;
  verificationPassRate: string;
  tokenEfficiencyRate: string;
  medianCostUsd: string;
  meanPreTaskComplexity: string;
  taskMixLabel: string;
  meanWorkloadIntensity: string;
  subagentRate: string;
  providersLabel: string;
  intervalLabel: string;
  rankRangeLabel: string;
  evidenceTier: string;
  userChannelLabel: string;
  agentChannelLabel: string;
  processChannelLabel: string;
  userEvidenceLabel: string;
  agentEvidenceLabel: string;
  processEvidenceLabel: string;
  canonicalTaskCount: number;
  transcriptOnlySessionCount: number;
  thinkingMixLabel: string;
}

interface LeaderboardDimensionRow {
  label: string;
  axisLabel: string;
  sortOrder: number;
  dimension: string;
  score: number;
  rawLabel: string;
}

function leaderboardRows(runs: PreparedRunRow[], precomputed?: ModelLeaderboardData): {
  /** Ranked-only chart/summary rows. */
  composite: LeaderboardCompositeRow[];
  /** Ranked family rows plus an optional separately disclosed unknown row. */
  tableRows: LeaderboardCompositeRow[];
  dimensions: LeaderboardDimensionRow[];
  unrankedCount: number;
  rows: ModelLeaderboardRow[];
  caseMix: ModelLeaderboardData['caseMix'];
  minimumTaskScoringCoverage: number;
} {
  // This generated implementation is the only scoring path. Everything below is display mapping.
  const leaderboard = precomputed ?? createModelLeaderboardFromRuns(runs);
  const ranked = leaderboard.rows.filter(
    (row): row is ModelLeaderboardRow & { compositeScore: number; rank: number } => (
      row.compositeScore !== null && row.rank !== null
    ),
  );
  const fmtPct = (value: number | null | undefined): string => (
    value !== null && value !== undefined ? `${(value * 100).toFixed(0)}%` : '—'
  );
  const axisLabel = (label: string, rank: number): string => `#${rank} · ${label}`;
  const displayLabel = (row: ModelLeaderboardRow): string => (
    `${row.modelId} / ${formatThinkingLevelLabel(row.thinkingLevel)}`
  );
  const providersLabel = (row: ModelLeaderboardRow): string => {
    const providerModelIds = row.providers.map((provider) => provider.modelId);
    if (providerModelIds.length > 1) {
      return `${providerModelIds.length} providers · ${providerModelIds.join(', ')}`;
    }
    return providerModelIds[0] && providerModelIds[0] !== row.modelId ? providerModelIds[0] : '';
  };

  const eligibilityLabel = (row: ModelLeaderboardRow): string => row.modelId === '(unknown)' ? 'Unknown / unranked' : row.evidenceTier;

  const tableRows: LeaderboardCompositeRow[] = leaderboard.rows.map((row, index) => {
    const label = displayLabel(row);
    const rankLabel = row.rank === null ? '—' : `#${row.rank}`;
    const scoreLabel = row.compositeScore === null ? '—' : `${(row.compositeScore * 100).toFixed(1)}%`;
    const unadjustedScoreLabel = row.unadjustedCompositeScore !== null
      ? `${(row.unadjustedCompositeScore * 100).toFixed(1)}%`
      : '—';
    const adjustmentLabel = row.caseMixAdjustment !== null
      ? `${row.caseMixAdjustment >= 0 ? '+' : ''}${(row.caseMixAdjustment * 100).toFixed(1)} pp`
      : 'inactive';
    return {
      label,
      axisLabel: row.rank === null ? `Provisional · ${label}` : axisLabel(label, row.rank),
      modelId: row.modelId,
      thinkingLevel: formatThinkingLevelLabel(row.thinkingLevel),
      sortOrder: index,
      compositeScore: row.compositeScore,
      rank: row.rank,
      rankLabel,
      scoreLabel,
      eligibilityLabel: eligibilityLabel(row),
      unadjustedScoreLabel,
      adjustmentLabel,
      barLabel: `${rankLabel} · ${scoreLabel}`,
      evidenceWeightLabel: fmtPct(row.evidenceWeight),
      runCount: row.runCount,
      scoredRunCount: row.scoredRunCount,
      effectiveTaskCount: row.effectiveTaskCount,
      attributableTaskCount: row.attributableTaskCount,
      scoringCoverageLabel: fmtPct(row.scoringCoverage),
      caseMixOverlapLabel: fmtPct(row.caseMixOverlap),
      userOutcomeCount: row.userOutcomeCount,
      agentOutcomeCount: row.agentOutcomeCount,
      mixedModelExcludedCount: row.mixedModelExcludedCount,
      mixedTreatmentExcludedCount: row.mixedTreatmentExcludedCount,
      nLabel: `${row.scoredRunCount} outcomes / ${row.effectiveTaskCount} rated tasks / ${row.attributableTaskCount} attributable tasks / ${row.runCount} runs`,
      outcomeSourceLabel: `${row.userOutcomeCount} ranked user / ${row.agentOutcomeCount} supplemental agent`,
      avgSatisfaction: row.dimensions.satisfaction.value?.toFixed(2) ?? '—',
      resolutionRate: fmtPct(row.dimensions.resolutionRate.value),
      fileChurnRate: row.dimensions.fileChurn.value !== null
        ? `${(row.dimensions.fileChurn.value * 100).toFixed(0)}% re-edit`
        : '—',
      toolReliabilityRate: fmtPct(row.dimensions.toolReliability.value),
      verificationPassRate: fmtPct(row.dimensions.verificationPassRate.value),
      tokenEfficiencyRate: row.dimensions.tokenEfficiency.value !== null
        ? `${row.dimensions.tokenEfficiency.value.toFixed(1)} tok/line`
        : '—',
      medianCostUsd: row.medianCostUsd !== null ? `$${row.medianCostUsd.toFixed(4)}` : '—',
      meanPreTaskComplexity: fmtPct(row.meanPreTaskComplexity),
      taskMixLabel: `L ${row.taskComplexityBandCounts.low} / M ${row.taskComplexityBandCounts.medium} / H ${row.taskComplexityBandCounts.high}`,
      meanWorkloadIntensity: fmtPct(row.meanWorkloadIntensity),
      subagentRate: fmtPct(row.subagentUsageRate),
      providersLabel: providersLabel(row),
      intervalLabel: row.scoreInterval80 ? `${(row.scoreInterval80.lower * 100).toFixed(1)}–${(row.scoreInterval80.upper * 100).toFixed(1)}%` : '—',
      rankRangeLabel: row.scoreInterval80 ? `#${row.scoreInterval80.bestRank}–#${row.scoreInterval80.worstRank}` : '—',
      evidenceTier: row.evidenceTier,
      userChannelLabel: row.userChannelScore === null ? '—' : `${(row.userChannelScore * 100).toFixed(1)}%`,
      agentChannelLabel: row.agentChannelScore === null ? '—' : `${(row.agentChannelScore * 100).toFixed(1)}%`,
      processChannelLabel: row.processChannelScore === null ? '—' : `${(row.processChannelScore * 100).toFixed(1)}%`,
      userEvidenceLabel: `${row.userEvidenceCount} (${row.userEvidenceMass.toFixed(1)} mass)`,
      agentEvidenceLabel: `${row.agentEvidenceCount} (${row.agentEvidenceMass.toFixed(1)} mass)`,
      processEvidenceLabel: `${row.processEvidenceCount} (${row.processEvidenceMass.toFixed(1)} mass)`,
      canonicalTaskCount: row.canonicalTaskCount,
      transcriptOnlySessionCount: row.transcriptOnlySessionCount,
      thinkingMixLabel: row.thinkingLevels.map((item) => `${formatThinkingLevelLabel(item.thinkingLevel)} ${item.attributionMass.toFixed(1)}`).join(', '),
    };
  });
  const composite = tableRows.filter(
    (row): row is LeaderboardCompositeRow & { compositeScore: number; rank: number } => (
      row.compositeScore !== null && row.rank !== null
    ),
  );

  const dimensions: LeaderboardDimensionRow[] = [];
  ranked.forEach((row) => {
    const label = displayLabel(row);
    const rowAxisLabel = axisLabel(label, row.rank);
    const add = (
      dimension: string,
      metric: ModelLeaderboardRow['dimensions'][keyof ModelLeaderboardRow['dimensions']],
      rawLabel: (value: number) => string,
    ): void => {
      if (metric.shrunk === null) return;
      dimensions.push({
        label,
        axisLabel: rowAxisLabel,
        sortOrder: row.rank - 1,
        dimension,
        score: metric.shrunk,
        rawLabel: metric.value === null || metric.n === 0
          ? 'No telemetry · pooled prior'
          : rawLabel(metric.value),
      });
    };
    add('Satisfaction', row.dimensions.satisfaction, (value) => `${value.toFixed(2)} avg`);
    add('Resolution', row.dimensions.resolutionRate, (value) => `${fmtPct(value)} rate`);
    add('File churn', row.dimensions.fileChurn, (value) => `${(value * 100).toFixed(0)}% re-edit`);
    add('Tool reliability', row.dimensions.toolReliability, (value) => `${fmtPct(value)} clean`);
    add('Verification', row.dimensions.verificationPassRate, (value) => `${fmtPct(value)} pass`);
    add('Token efficiency', row.dimensions.tokenEfficiency, (value) => `${value.toFixed(1)} tok/line`);
  });

  return {
    composite,
    tableRows,
    dimensions,
    unrankedCount: leaderboard.rows.length - ranked.length,
    rows: leaderboard.rows,
    caseMix: leaderboard.caseMix,
    minimumTaskScoringCoverage: leaderboard.minimumTaskScoringCoverage,
  };
}

function renderLeaderboardTable(
  rows: LeaderboardCompositeRow[],
  minimumTaskScoringCoverage: number,
  minimumModelRatedTasksPerBand: number,
  renderToken: number,
): void {
  if (!isCurrentRender(renderToken)) {
    return;
  }

  const target = byId('leaderboard-table');
  if (rows.length === 0) {
    target.innerHTML = '';
    return;
  }

  target.innerHTML = `
    <table class="data-table leaderboard-table">
      <caption>Observational family ranks relative to the current model cohort and ex-ante task mix—not universal benchmark capability. Ranks reflect point-estimate order; models with overlapping 80% score intervals have unresolved relative order (see the rank range column). Every observed family is shown; sparse evidence shrinks toward pooled source priors and is labelled.</caption>
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Model / thinking</th>
          <th scope="col">Evidence tier</th>
          <th scope="col">Composite</th>
          <th scope="col">80% score / rank interval</th>
          <th scope="col">U score / evidence</th>
          <th scope="col">A score / evidence</th>
          <th scope="col">P score / evidence</th>
          <th scope="col">Canonical / transcript-only</th>
          <th scope="col">Raw score</th>
          <th scope="col">Case-mix Δ</th>
          <th scope="col">Case-mix overlap</th>
          <th scope="col">Evidence weight</th>
          <th scope="col">Outcomes / rated tasks / attributable tasks / runs</th>
          <th scope="col">Task rating coverage</th>
          <th scope="col">Ranked / supplemental</th>
          <th scope="col">Mixed model / treatment excluded</th>
          <th scope="col">Sat.</th>
          <th scope="col">Resolved</th>
          <th scope="col">File churn</th>
          <th scope="col">Tool clean</th>
          <th scope="col">Ver. pass</th>
          <th scope="col">Tok/line</th>
          <th scope="col">Med. total cost</th>
          <th scope="col">Ex-ante complexity</th>
          <th scope="col">Task mix L/M/H</th>
          <th scope="col">Workload intensity</th>
          <th scope="col">Subagents</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, index) => `
          <tr class="${row.rank === null ? `unranked-row${index > 0 && rows[index - 1]?.rank !== null ? ' unranked-start' : ''}` : 'ranked-row'}">
            <td class="rank-cell">${escapeHtml(row.rankLabel)}</td>
            <th scope="row">
              <span class="model-name">${escapeHtml(row.modelId)}</span>
              <span class="model-detail">${escapeHtml(row.thinkingLevel)}</span>
              ${row.providersLabel ? `<span class="model-providers">${escapeHtml(row.providersLabel)}</span>` : ''}
            </th>
            <td class="eligibility-cell">${escapeHtml(row.evidenceTier)}</td>
            <td class="numeric strong-cell">${escapeHtml(row.scoreLabel)}</td>
            <td class="numeric">${escapeHtml(row.intervalLabel)} / ${escapeHtml(row.rankRangeLabel)}</td>
            <td class="numeric">${escapeHtml(row.userChannelLabel)} / ${escapeHtml(row.userEvidenceLabel)}</td>
            <td class="numeric">${escapeHtml(row.agentChannelLabel)} / ${escapeHtml(row.agentEvidenceLabel)}</td>
            <td class="numeric">${escapeHtml(row.processChannelLabel)} / ${escapeHtml(row.processEvidenceLabel)}</td>
            <td class="numeric">${row.canonicalTaskCount} / ${row.transcriptOnlySessionCount}</td>
            <td class="numeric">${escapeHtml(row.unadjustedScoreLabel)}</td>
            <td class="numeric">${escapeHtml(row.adjustmentLabel)}</td>
            <td class="numeric">${escapeHtml(row.caseMixOverlapLabel)}</td>
            <td class="numeric">${escapeHtml(row.evidenceWeightLabel)}</td>
            <td class="numeric">${escapeHtml(row.nLabel)}</td>
            <td class="numeric">${escapeHtml(row.scoringCoverageLabel)}</td>
            <td class="numeric">${escapeHtml(row.outcomeSourceLabel)}</td>
            <td class="numeric">${row.mixedModelExcludedCount} / ${row.mixedTreatmentExcludedCount}</td>
            <td class="numeric">${escapeHtml(row.avgSatisfaction)}</td>
            <td class="numeric">${escapeHtml(row.resolutionRate)}</td>
            <td class="numeric">${escapeHtml(row.fileChurnRate)}</td>
            <td class="numeric">${escapeHtml(row.toolReliabilityRate)}</td>
            <td class="numeric">${escapeHtml(row.verificationPassRate)}</td>
            <td class="numeric">${escapeHtml(row.tokenEfficiencyRate)}</td>
            <td class="numeric">${escapeHtml(row.medianCostUsd)}</td>
            <td class="numeric">${escapeHtml(row.meanPreTaskComplexity)}</td>
            <td class="numeric">${escapeHtml(row.taskMixLabel)}</td>
            <td class="numeric">${escapeHtml(row.meanWorkloadIntensity)}</td>
            <td class="numeric">${escapeHtml(row.subagentRate)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function outcomeTimeBucketSpec(
  rows: OutcomeTimeBucketRow[],
  options: { bucketTitle: string; timeTitle: string; rateTitle: string },
): Record<string, unknown> | null {
  if (rows.length === 0) {
    return null;
  }

  return {
    width: 'container',
    data: { values: rows },
    vconcat: [
      {
        width: 'container',
        height: 138,
        layer: [
          {
            mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.72 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' }, axis: { labels: false, ticks: false, title: null } },
              y: { field: 'p25BusyMinutes', type: 'quantitative', title: options.timeTitle, scale: { type: 'log', nice: true } },
              y2: { field: 'p75BusyMinutes' },
              color: { value: CHART_COLORS.gold },
            },
          },
          {
            mark: { type: 'point', filled: true, size: 170, opacity: 0.95 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' }, axis: { labels: false, ticks: false, title: null } },
              y: { field: 'medianBusyMinutes', type: 'quantitative', scale: { type: 'log', nice: true } },
              color: { value: CHART_COLORS.accent },
              tooltip: [
                { field: 'label', type: 'nominal', title: 'Group' },
                { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
                { field: 'medianBusyLabel', type: 'nominal', title: 'Median busy duration' },
                { field: 'p25BusyLabel', type: 'nominal', title: 'P25 busy duration' },
                { field: 'p75BusyLabel', type: 'nominal', title: 'P75 busy duration' },
                { field: 'resolvedRate', type: 'quantitative', title: 'Resolved share', format: '.1%' },
                { field: 'resolvedCiLabel', type: 'nominal', title: 'Resolved interval' },
              ],
            },
          },
          {
            mark: { type: 'text', align: 'center', baseline: 'bottom', dy: -10, fontSize: 11, opacity: 0.78 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' } },
              y: { field: 'p75BusyMinutes', type: 'quantitative', scale: { type: 'log', nice: true } },
              text: { field: 'medianBusyLabel', type: 'nominal' },
              color: { value: CHART_COLORS.muted },
            },
          },
        ],
      },
      {
        width: 'container',
        height: 138,
        layer: [
          {
            mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.78 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' }, title: options.bucketTitle, axis: { labelAngle: 0, labelPadding: 4 } },
              y: { field: 'resolvedCiLower', type: 'quantitative', title: options.rateTitle, axis: { format: '.0%' }, scale: { domain: [0, 1] } },
              y2: { field: 'resolvedCiUpper' },
              color: { value: CHART_COLORS.accent2 },
            },
          },
          {
            mark: { type: 'point', filled: true, size: 170, opacity: 0.95 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' }, axis: { labelAngle: 0 } },
              y: { field: 'resolvedRate', type: 'quantitative', scale: { domain: [0, 1] } },
              color: {
                field: 'resolvedRate',
                type: 'quantitative',
                legend: null,
                scale: { domain: [0, 1], range: [CHART_COLORS.coral, CHART_COLORS.success] },
              },
            },
          },
          {
            mark: { type: 'text', align: 'center', baseline: 'bottom', dy: -10, fontSize: 11, opacity: 0.78 },
            encoding: {
              x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' } },
              y: { field: 'resolvedCiUpper', type: 'quantitative', scale: { domain: [0, 1] } },
              text: { field: 'nLabel', type: 'nominal' },
              color: { value: CHART_COLORS.muted },
            },
          },
        ],
      },
    ],
    spacing: 6,
  };
}

function categoricalHeight(rowCount: number, rowHeight = 30, min = 260, max = 520): number {
  return Math.max(min, Math.min(max, 70 + rowCount * rowHeight));
}

function sampleWarning(rows: Array<{ scoredRunCount?: number; runCount?: number }>, field: 'scoredRunCount' | 'runCount' = 'scoredRunCount'): string {
  const small = rows.filter((row) => (row[field] ?? 0) > 0 && (row[field] ?? 0) < 5).length;
  return small > 0 ? `${small} small-n groups (<5); compare intervals, not just row order.` : 'Intervals show uncertainty; compare row widths before ranking.';
}

function frontierComparisonSpec(rows: ModelFrontierRow[]): Record<string, unknown> {
  const panelHeight = Math.max(170, Math.min(220, 48 + rows.length * 14));
  const frontierY = {
    field: 'label',
    type: 'nominal',
    sort: { field: 'medianBusyMinutes', order: 'ascending' as const },
    title: null,
  };

  const sharedTooltip = [
    { field: 'label', type: 'nominal', title: 'Group' },
    { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
    { field: 'medianBusyLabel', type: 'nominal', title: 'Median busy duration' },
    { field: 'p25BusyLabel', type: 'nominal', title: 'P25 busy duration' },
    { field: 'p75BusyLabel', type: 'nominal', title: 'P75 busy duration' },
    { field: 'resolvedRate', type: 'quantitative', title: 'Resolved share', format: '.1%' },
    { field: 'resolvedCiLabel', type: 'nominal', title: 'Resolved interval' },
  ] as const;

  return {
    width: 'container',
    data: { values: rows },
    vconcat: [
      {
        height: panelHeight,
        layer: [
          {
            mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.68 },
            encoding: {
              y: { ...frontierY, axis: { labelLimit: 190, labelPadding: 8 } },
              x: { field: 'p25BusyMinutes', type: 'quantitative', title: 'Busy duration (minutes)', scale: { type: 'log', nice: true } },
              x2: { field: 'p75BusyMinutes' },
              color: { value: CHART_COLORS.gold },
              tooltip: sharedTooltip,
            },
          },
          {
            mark: { type: 'point', filled: true, size: 120, opacity: 0.95, stroke: '#07140b', strokeWidth: 1 },
            encoding: {
              y: { ...frontierY, axis: { labelLimit: 190, labelPadding: 8 } },
              x: { field: 'medianBusyMinutes', type: 'quantitative', scale: { type: 'log', nice: true } },
              color: { field: 'thinkingLevel', type: 'nominal', title: 'Reasoning', scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE }, legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 } },
              tooltip: sharedTooltip,
            },
          },
        ],
      },
      {
        height: panelHeight,
        layer: [
          {
            mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.78 },
            encoding: {
              y: { ...frontierY, axis: { labels: false, ticks: false, domain: false, title: null } },
              x: { field: 'resolvedCiLower', type: 'quantitative', title: 'Resolved share (Wilson 95% CI)', axis: { format: '.0%' }, scale: { domain: [0, 1] } },
              x2: { field: 'resolvedCiUpper' },
              color: { value: CHART_COLORS.accent2 },
              tooltip: sharedTooltip,
            },
          },
          {
            mark: { type: 'point', filled: true, size: 120, opacity: 0.95, stroke: '#07140b', strokeWidth: 1 },
            encoding: {
              y: { ...frontierY, axis: { labels: false, ticks: false, domain: false, title: null } },
              x: { field: 'resolvedRate', type: 'quantitative', scale: { domain: [0, 1] } },
              color: { field: 'thinkingLevel', type: 'nominal', title: 'Reasoning', scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE }, legend: null },
              tooltip: sharedTooltip,
            },
          },
        ],
      },
    ],
    spacing: 10,
  };
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

async function renderCharts(
  runs: PreparedRunRow[],
  toolRows: PreparedToolUsageRow[],
  data: DashboardData,
  _usePrecomputed: boolean,
  renderToken: number,
): Promise<void> {
  const scored = selectedScoredCompletedRuns(runs);
  const overallAvgSatisfaction = average(scored.map((run) => run.satisfaction ?? 0));

  // ── 1. Outcome trend with daily uncertainty and volume ──────────────────────
  const timeline = dailyOutcomeRows(runs);
  const timelineWithRolling = timeline.filter((row) => row.rollingMean !== null);
  setNote('timeline-note', `7-bucket rolling mean with 95% CI; ${timelineWithRolling.length}/${timeline.length} observed days pooled.`, renderToken);

  const timelineSpec: Record<string, unknown> | null = timeline.length === 0 ? null : {
    width: 'container',
    data: { values: timeline },
    vconcat: [
      {
        height: 200,
        layer: [
          ...(overallAvgSatisfaction !== null ? [{
            mark: { type: 'rule', strokeDash: [6, 4], strokeWidth: 1.5, opacity: 0.55 },
            encoding: {
              y: { datum: overallAvgSatisfaction },
              color: { value: CHART_COLORS.gold },
            },
          }] : []),
          {
            transform: [{ filter: 'datum.rollingMean != null' }],
            mark: { type: 'area', opacity: 0.18 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: 'Day' },
              y: { field: 'rollingLower', type: 'quantitative', title: 'Mean satisfaction', scale: { domain: [1, 5] } },
              y2: { field: 'rollingUpper' },
              color: { value: CHART_COLORS.accent },
            },
          },
          {
            transform: [{ filter: 'datum.rollingMean != null' }],
            mark: { type: 'line', strokeWidth: 2.5 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal' },
              y: { field: 'rollingMean', type: 'quantitative', scale: { domain: [1, 5] } },
              color: { value: CHART_COLORS.accent },
            },
          },
          {
            transform: [{ filter: 'datum.meanSatisfaction != null' }],
            mark: { type: 'point', filled: true, size: 50, opacity: 0.35 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal' },
              y: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
              color: { value: CHART_COLORS.muted },
              tooltip: [
                { field: 'bucketStart', type: 'temporal', title: 'Day' },
                { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
                { field: 'meanSatisfaction', type: 'quantitative', title: 'Daily mean', format: '.2f' },
                { field: 'ciLabel', type: 'nominal', title: 'Daily interval' },
                { field: 'rollingMean', type: 'quantitative', title: '7-bucket rolling mean', format: '.2f' },
                { field: 'rollingN', type: 'quantitative', title: 'Rolling pooled n' },
                { field: 'verificationRate', type: 'quantitative', title: 'Verification rate', format: '.0%' },
                { field: 'toolFailureRate', type: 'quantitative', title: 'Tool failure rate', format: '.1%' },
                { field: 'averageBusyMinutes', type: 'quantitative', title: 'Avg busy minutes', format: '.1f' },
                { field: 'modelMix', type: 'nominal', title: 'Model mix' },
              ],
            },
          },
        ],
      },
      {
        height: 82,
        layer: [
          {
            mark: { type: 'bar', opacity: 0.24, cornerRadiusTopLeft: 6, cornerRadiusTopRight: 6 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: null },
              y: { field: 'runCount', type: 'quantitative', title: 'Runs' },
              color: { value: CHART_COLORS.accent2 },
              tooltip: [
                { field: 'bucketStart', type: 'temporal', title: 'Day' },
                { field: 'runCount', type: 'quantitative', title: 'Total runs' },
                { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs' },
              ],
            },
          },
          {
            mark: { type: 'bar', opacity: 0.78, cornerRadiusTopLeft: 6, cornerRadiusTopRight: 6 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: null },
              y: { field: 'scoredRunCount', type: 'quantitative' },
              color: { value: CHART_COLORS.accent },
            },
          },
        ],
      },
    ],
    resolve: { scale: { y: 'independent' } },
  };
  await renderSpec('chart-timeline', timelineSpec, 'No runs match the current filters.', renderToken);

  // ── 1b. Model leaderboard (composite ranking) ──────────────────────────────
  // Historical transcript/review evidence is intentionally not present in run-summary.json, so the
  // canonical family leaderboard always uses its generated all-evidence artifact. Run filters still
  // apply to the surrounding run-level diagnostics.
  const lb = leaderboardRows(runs, data.modelLeaderboard);
  const leaderboardUserOutcomes = lb.rows.reduce((sum, row) => sum + row.userOutcomeCount, 0);
  const leaderboardAgentOutcomes = lb.rows.reduce((sum, row) => sum + row.agentOutcomeCount, 0);
  const leaderboardMixedModelExcluded = lb.rows.reduce((sum, row) => sum + row.mixedModelExcludedCount, 0);
  const leaderboardMixedTreatmentExcluded = lb.rows.reduce((sum, row) => sum + row.mixedTreatmentExcludedCount, 0);
  const targetMix = lb.caseMix.targetBandWeights;
  const caseMixSignalLabels = lb.caseMix.activeSignals.map((signal) => ({
    initialUserMessageChars: 'initial message size',
    attachmentCount: 'attachments',
    contextFileCount: 'context files',
  })[signal]);
  const caseMixSummary = `Standardized to the full privacy-safe ex-ante task distribution (L ${(targetMix.low * 100).toFixed(0)}% / M ${(targetMix.medium * 100).toFixed(0)}% / H ${(targetMix.high * 100).toFixed(0)}%)${caseMixSignalLabels.length ? ` using ${caseMixSignalLabels.join(', ')}` : ''}; missing family-band cells use source-band priors.`;
  setNote(
    'leaderboard-note',
    lb.composite.length === 0
      ? `No attributable model families are available. ${caseMixSummary}`
      : `${lb.composite.length} observed families ranked relative to this cohort and task mix; sparse rows shrink toward pooled source priors. ${caseMixSummary} Evidence: ${leaderboardUserOutcomes} canonical user mass; ${leaderboardAgentOutcomes} deduplicated agent-review mass; ${leaderboardMixedModelExcluded} mixed-model and ${leaderboardMixedTreatmentExcluded} mixed-treatment canonical outcomes omitted from user attribution. This is observational, not universal benchmark capability.`,
    renderToken,
  );
  renderLeaderboardTable(
    lb.tableRows,
    lb.minimumTaskScoringCoverage,
    lb.caseMix.minimumModelRatedTasksPerBand,
    renderToken,
  );

  const leaderboardOrder = lb.composite.map((row) => row.axisLabel);
  const leaderboardSpec: Record<string, unknown> | null = lb.composite.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(lb.composite.length, 30, 200, 600),
    data: { values: lb.composite },
    layer: [
      {
        mark: { type: 'bar', cornerRadiusEnd: 3, opacity: 0.82 },
        encoding: {
          y: { field: 'axisLabel', type: 'nominal', sort: leaderboardOrder, title: null, axis: { labelLimit: 320, labelPadding: 8 } },
          x: { field: 'compositeScore', type: 'quantitative', title: 'Regularized cohort-relative composite', scale: { domain: [0, 1] }, axis: { format: '.0%', tickCount: 6 } },
          color: {
            field: 'thinkingLevel', type: 'nominal', title: 'Reasoning',
            scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE },
            legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 },
          },
          tooltip: [
            { field: 'rankLabel', type: 'nominal', title: 'Rank' },
            { field: 'label', type: 'nominal', title: 'Model' },
            { field: 'scoreLabel', type: 'nominal', title: 'Strength score' },
            { field: 'unadjustedScoreLabel', type: 'nominal', title: 'Raw regularized score' },
            { field: 'adjustmentLabel', type: 'nominal', title: 'Case-mix adjustment' },
            { field: 'caseMixOverlapLabel', type: 'nominal', title: 'Case-mix overlap' },
            { field: 'evidenceWeightLabel', type: 'nominal', title: 'Evidence weight' },
            { field: 'nLabel', type: 'nominal', title: 'Outcomes / rated / attributable tasks / runs' },
            { field: 'scoringCoverageLabel', type: 'nominal', title: 'Task-level user-rating coverage' },
            { field: 'outcomeSourceLabel', type: 'nominal', title: 'Ranked / supplemental outcomes' },
            { field: 'mixedModelExcludedCount', type: 'quantitative', title: 'Mixed-model outcomes excluded' },
            { field: 'mixedTreatmentExcludedCount', type: 'quantitative', title: 'Mixed-treatment outcomes excluded' },
            { field: 'avgSatisfaction', type: 'nominal', title: 'Avg satisfaction' },
            { field: 'resolutionRate', type: 'nominal', title: 'Resolution rate' },
            { field: 'fileChurnRate', type: 'nominal', title: 'File churn' },
            { field: 'toolReliabilityRate', type: 'nominal', title: 'Tool reliability' },
            { field: 'verificationPassRate', type: 'nominal', title: 'Verification pass' },
            { field: 'tokenEfficiencyRate', type: 'nominal', title: 'Token efficiency' },
            { field: 'medianCostUsd', type: 'nominal', title: 'Median total cost / run' },
            { field: 'meanPreTaskComplexity', type: 'nominal', title: 'Mean ex-ante complexity' },
            { field: 'taskMixLabel', type: 'nominal', title: 'Observed task mix' },
            { field: 'meanWorkloadIntensity', type: 'nominal', title: 'Mean workload intensity (descriptive)' },
            { field: 'subagentRate', type: 'nominal', title: 'Subagent usage' },
          ],
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 6, fontSize: 11, fontWeight: 700, opacity: 0.9, clip: false },
        encoding: {
          y: { field: 'axisLabel', type: 'nominal', sort: leaderboardOrder },
          x: { field: 'compositeScore', type: 'quantitative' },
          text: { field: 'barLabel', type: 'nominal' },
          color: { value: CHART_COLORS.text },
        },
      },
    ],
  };
  await renderSpec('chart-leaderboard', leaderboardSpec, 'No attributable model families match the current filters.', renderToken);

  // ── 1c. Leaderboard dimension profile ─────────────────────────────────────
  setNote(
    'leaderboard-dimension-note',
    lb.dimensions.length === 0
      ? 'No ranked models to show.'
      : `Diagnostic dimensions are shown alongside the separately calibrated channels. User evidence combines satisfaction ${(LEADERBOARD_WEIGHTS.satisfaction * 100).toFixed(1)}% and resolution ${(LEADERBOARD_WEIGHTS.resolutionRate * 100).toFixed(1)}%; standardized user, agent, and process evidence combine at 60% / 25% / 15%. Cost, tokens, duration, file churn, and tool volume are diagnostic only.`,
    renderToken,
  );

  const dimensionSpec: Record<string, unknown> | null = lb.dimensions.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(lb.composite.length, 30, 200, 600),
    data: { values: lb.dimensions },
    mark: { type: 'point', filled: true, size: 180, opacity: 0.88, strokeWidth: 0.6 },
    encoding: {
      y: { field: 'axisLabel', type: 'nominal', sort: leaderboardOrder, title: null, axis: { labelLimit: 320, labelPadding: 8 } },
      x: { field: 'score', type: 'quantitative', title: 'Regularized estimate (0–1)', scale: { domain: [0, 1] }, axis: { format: '.0%', tickCount: 6 } },
      color: {
        field: 'dimension', type: 'nominal', title: 'Dimension',
        scale: { domain: DIMENSION_NAMES, range: DIMENSION_COLORS },
        legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 },
      },
      tooltip: [
        { field: 'label', type: 'nominal', title: 'Model' },
        { field: 'dimension', type: 'nominal', title: 'Dimension' },
        { field: 'score', type: 'quantitative', title: 'Regularized estimate', format: '.3f' },
        { field: 'rawLabel', type: 'nominal', title: 'Raw value' },
      ],
    },
  };
  await renderSpec('chart-leaderboard-dimensions', dimensionSpec, 'No ranked models to show dimension profiles.', renderToken);

  // ── 2. Model efficiency — median busy time by model/thinking ──────────
  const efficiency = modelEfficiencyRows(runs);
  setNote('model-efficiency-note', `${efficiency.length} model/thinking groups; bar = IQR (p25-p75), point = median.`, renderToken);

  const efficiencySpec: Record<string, unknown> | null = efficiency.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(efficiency.length),
    data: { values: efficiency },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.6 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianBusyMinutes', order: 'ascending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'p25BusyMinutes', type: 'quantitative', title: 'Busy duration (minutes)', scale: { type: 'log', nice: true } },
          x2: { field: 'p75BusyMinutes' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Group' },
            { field: 'nLabel', type: 'nominal', title: 'Runs' },
            { field: 'medianBusyLabel', type: 'nominal', title: 'Median' },
            { field: 'p25BusyLabel', type: 'nominal', title: 'P25' },
            { field: 'p75BusyLabel', type: 'nominal', title: 'P75' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true, size: 140 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianBusyMinutes', order: 'ascending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'medianBusyMinutes', type: 'quantitative', scale: { type: 'log', nice: true } },
          color: { field: 'thinkingLevel', type: 'nominal', title: 'Reasoning', scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE }, legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 } },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.7, clip: false },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianBusyMinutes', order: 'ascending' } },
          x: { field: 'p75BusyMinutes', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-model-efficiency', efficiencySpec, 'No completed runs match filters.', renderToken);

  // ── 3. Speed / resolution scorecard ──────────────────────────────────────
  const frontier = modelFrontierRows(runs);
  setNote(
    'frontier-note',
    frontier.length === 0
      ? 'Need scored runs grouped by model/thinking.'
      : `${frontier.length} model/thinking groups; rows sorted fastest → slowest; busy time uses completed runs in the filtered set, resolved share uses scored runs. ${sampleWarning(frontier)}`,
    renderToken,
  );

  await renderSpec(
    'chart-model-frontier',
    frontier.length === 0 ? null : frontierComparisonSpec(frontier),
    'No scored model/thinking groups match filters.',
    renderToken,
  );

  // ── 4. Observed time and outcomes by verification depth ───────────────────
  const verificationCost = verificationCostRows(runs);
  setNote(
    'verification-cost-note',
    verificationCost.length === 0
      ? 'Need scored runs with verification metadata.'
      : `${verificationCost.length} check-depth buckets; top = time for all completed runs, bottom = resolved share for scored runs.`,
    renderToken,
  );
  await renderSpec(
    'chart-verification-cost',
    outcomeTimeBucketSpec(verificationCost, {
      bucketTitle: 'Verification depth',
      timeTitle: 'Median busy duration (minutes)',
      rateTitle: 'Resolved share (Wilson 95% CI)',
    }),
    'No scored verification buckets match filters.',
    renderToken,
  );

  // ── 5. Time vs satisfaction correlation ───────────────────────────────────
  const timeQuality = timeQualityRows(runs);
  const showTimeQualityTrend = timeQuality.length >= 4 && new Set(timeQuality.map((row) => row.busyMinutes)).size >= 2;
  const logTicks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const busyMinutes = timeQuality.map((row) => row.busyMinutes).filter((value) => Number.isFinite(value) && value > 0);
  const minBusyMinutes = busyMinutes.length > 0 ? Math.min(...busyMinutes) : 0.01;
  const maxBusyMinutes = busyMinutes.length > 0 ? Math.max(...busyMinutes) : 10;
  const busyDomainMin = [...logTicks].reverse().find((tick) => tick <= minBusyMinutes) ?? 0.01;
  const busyDomainMax = logTicks.find((tick) => tick >= maxBusyMinutes) ?? maxBusyMinutes;
  const busyTickValues = logTicks.filter((tick) => tick >= busyDomainMin && tick <= busyDomainMax);
  setNote('time-quality-note', `${timeQuality.length} scored runs; subjective satisfaction view${showTimeQualityTrend ? ' with log trend' : ''}.`, renderToken);

  const timeQualitySpec: Record<string, unknown> | null = timeQuality.length === 0 ? null : {
    width: 'container',
    height: 300,
    data: { values: timeQuality },
    layer: [
      {
        mark: { type: 'point', filled: true, opacity: 0.55 },
        encoding: {
          x: {
            field: 'busyMinutes',
            type: 'quantitative',
            title: 'Busy duration (minutes)',
            scale: { type: 'log', domain: [busyDomainMin, Math.max(busyDomainMax, busyDomainMin)] },
            axis: { values: busyTickValues, format: '~g' },
          },
          y: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { domain: [1, 5] }, axis: { values: [1, 2, 3, 4, 5], tickMinStep: 1 } },
          color: {
            field: 'resolution',
            type: 'nominal',
            scale: {
              domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
              range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
            },
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
          },
          size: {
            field: 'lineMutationTotal',
            type: 'quantitative',
            title: 'Line changes',
            scale: { range: [45, 200] },
            legend: { orient: 'bottom', values: [0, 500, 1000, 2000, 4000, 6000], format: ',' },
          },
          tooltip: [
            { field: 'modelId', type: 'nominal', title: 'Model' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
            { field: 'busyMinutes', type: 'quantitative', title: 'Busy minutes', format: '.1f' },
            { field: 'toolFailureCount', type: 'quantitative', title: 'Tool failures' },
            { field: 'lineMutationTotal', type: 'quantitative', title: 'Line changes' },
          ],
        },
      },
      ...(showTimeQualityTrend ? [{
        // x-axis is log-scaled (busyMinutes is clamped ≥ 1/60 by busyMinutesForChart), so use a
        // log regression (y = a + b·ln(x)) which renders as a straight line on the log axis and
        // tracks the point cloud. A linear fit would curve on a log axis and mislead.
        transform: [{ regression: 'satisfaction', on: 'busyMinutes', method: 'log' }],
        mark: { type: 'line', strokeDash: [6, 4], strokeWidth: 2, opacity: 0.5 },
        encoding: {
          x: { field: 'busyMinutes', type: 'quantitative', scale: { type: 'log', domain: [busyDomainMin, Math.max(busyDomainMax, busyDomainMin)] }, axis: { values: busyTickValues, format: '~g' } },
          y: { field: 'satisfaction', type: 'quantitative', scale: { domain: [1, 5] }, axis: { values: [1, 2, 3, 4, 5], tickMinStep: 1 } },
          color: { value: CHART_COLORS.accent },
        },
      }] : []),
    ],
  };
  await renderSpec('chart-time-quality', timeQualitySpec, 'No scored runs match filters.', renderToken);

  // ── 2. Model/thinking scorecard — dot plot with 95% CIs ─────────────────────
  const modelRows = modelThinkingRows(runs);
  setNote('model-note', `${modelRows.length} groups; model outcomes use non-mixed user ratings only, CI shows uncertainty, and point size = user-outcome n. Agent ratings remain supplemental.`, renderToken);

  const modelSpec: Record<string, unknown> | null = modelRows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(modelRows.length),
    data: { values: modelRows },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.7 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Group' },
            { field: 'nLabel', type: 'nominal', title: 'User outcomes / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            { field: 'resolveRate', type: 'quantitative', title: 'Resolved rate', format: '.0%' },
            { field: 'resolveCiLabel', type: 'nominal', title: 'Resolved interval' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true, opacity: 0.95 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          size: { field: 'scoredRunCount', type: 'quantitative', title: 'User outcomes', scale: { range: [70, 420] }, legend: { orient: 'bottom', gradientLength: 120, labelLimit: 160 } },
          color: { field: 'thinkingLevel', type: 'nominal', title: 'Reasoning', scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE }, legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 } },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' } },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-model-quality', modelSpec, 'No model/thinking groups with non-mixed user outcomes match the current filters.', renderToken);

  // ── 3. Outcome composition by model ─────────────────────────────────────────
  const composition = compositionByModelRows(runs);
  const compositionModels = new Set(composition.map((row) => row.modelId));
  setNote('resolution-note', `${compositionModels.size} models; non-mixed user outcomes stacked by resolution type.`, renderToken);

  const resolutionDomain = ['resolved', 'partially_resolved', 'unresolved', 'unknown'];
  const resolutionRange = [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted];
  const resolutionSpec: Record<string, unknown> | null = composition.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(compositionModels.size),
    data: { values: composition },
    layer: [
      {
        mark: { type: 'bar' },
        encoding: {
          y: {
            field: 'modelId',
            type: 'nominal',
            sort: { field: 'resolvedShare', op: 'max', order: 'descending' },
            title: null,
            axis: { labelLimit: 220 },
          },
          x: {
            field: 'share',
            type: 'quantitative',
            stack: 'zero',
            axis: { format: '.0%' },
            scale: { domain: [0, 1] },
            title: 'Share of scored runs',
          },
          color: {
            field: 'resolution',
            type: 'nominal',
            scale: { domain: resolutionDomain, range: resolutionRange },
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
          },
          tooltip: [
            { field: 'modelId', type: 'nominal', title: 'Model' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'count', type: 'quantitative', title: 'Runs' },
            { field: 'share', type: 'quantitative', title: 'Share', format: '.1%' },
            { field: 'scoredRunCount', type: 'quantitative', title: 'Scored n' },
          ],
        },
      },
      {
        transform: [{ filter: "datum.resolution === 'resolved'" }],
        mark: { type: 'text', align: 'left', dx: 6, fontSize: 11, opacity: 0.78, clip: false },
        encoding: {
          y: {
            field: 'modelId',
            type: 'nominal',
            sort: { field: 'resolvedShare', op: 'max', order: 'descending' },
          },
          x: { datum: 1 },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-resolution-by-model', resolutionSpec, 'No resolved-rate groups match the current filters.', renderToken);

  // ── 7. Tool failure burden ─────────────────────────────────────────────────
  const failureBurden = toolFailureBurdenRows(runs);
  setNote(
    'failure-burden-note',
    failureBurden.length === 0
      ? 'Need scored runs with tool-call outcomes.'
      : `${failureBurden.length} failure buckets; top = time drag for all completed runs, bottom = resolved share for scored runs.`,
    renderToken,
  );
  await renderSpec(
    'chart-failure-burden',
    outcomeTimeBucketSpec(failureBurden, {
      bucketTitle: 'Tool failure count',
      timeTitle: 'Median busy duration (minutes)',
      rateTitle: 'Resolved share (Wilson 95% CI)',
    }),
    'No scored tool-failure buckets match filters.',
    renderToken,
  );

  // ── 8. Observed outcomes by verification state ─────────────────────────────
  const verificationContrast = verificationContrastRows(runs);
  const verificationMeans = verificationMeanRows(runs);
  const showVerificationContrast = verificationContrast.length > 0;
  setNote('verification-note', showVerificationContrast
    ? `${verificationContrast.length} contrasts vs no verification.`
    : `${verificationMeans.length} verification states; no baseline available.`,
  renderToken);

  const verificationSpec: Record<string, unknown> | null = showVerificationContrast ? {
    width: 'container',
    height: categoricalHeight(verificationContrast.length),
    data: { values: verificationContrast },
    layer: [
      {
        mark: { type: 'rule', strokeDash: [4, 4], opacity: 0.62 },
        encoding: {
          x: { datum: 0 },
          color: { value: CHART_COLORS.muted },
        },
      },
      {
        mark: { type: 'rule', strokeWidth: 2.4, opacity: 0.78 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: ['Passing checks', 'At least one failing check'], title: null, axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Observed satisfaction difference vs no verification (95% CI)', scale: { domain: [-4, 4] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Comparison' },
            { field: 'nLabel', type: 'nominal', title: 'Scored n' },
            { field: 'satisfactionDelta', type: 'quantitative', title: 'Mean difference', format: '+.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true, size: 160 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: ['Passing checks', 'At least one failing check'], title: null, axis: { labelLimit: 220 } },
          x: { field: 'satisfactionDelta', type: 'quantitative', scale: { domain: [-4, 4] } },
          color: {
            condition: { test: 'datum.satisfactionDelta >= 0', value: CHART_COLORS.accent },
            value: CHART_COLORS.coral,
          },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: ['Passing checks', 'At least one failing check'] },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  } : (verificationMeans.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(verificationMeans.length),
    data: { values: verificationMeans },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: ['No verification', 'Passing checks', 'At least one failing check'], title: null, axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
        },
      },
      {
        mark: { type: 'point', filled: true, size: 150 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: ['No verification', 'Passing checks', 'At least one failing check'], title: null, axis: { labelLimit: 220 } },
          x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          color: { value: CHART_COLORS.accent },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'State' },
            { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
          ],
        },
      },
    ],
  });
  await renderSpec('chart-verification-impact', verificationSpec, 'No scored verification groups match the current filters.', renderToken);

  // ── 5. Tool reliability × outcome association ───────────────────────────────
  const toolDiagnostics = toolDiagnosticRows(runs, toolRows);
  const reliabilityRows = [...toolDiagnostics]
    .sort((left, right) => right.failureRate - left.failureRate || right.callCount - left.callCount)
    .slice(0, 12);
  const deltaCandidates = toolDiagnostics.filter((row) =>
    row.usedScoredRunCount >= 3
    && row.unusedScoredRunCount >= 3
    && row.satisfactionDelta !== null
  );
  const deltaRows = [...deltaCandidates]
    .sort((left, right) => Math.abs(right.satisfactionDelta ?? 0) - Math.abs(left.satisfactionDelta ?? 0))
    .slice(0, 12);

  setNote('tool-note', `${reliabilityRows.length} tools by reliability; ${deltaRows.length} with usage contrast (n≥3).`, renderToken);

  const reliabilitySpec: Record<string, unknown> | null = reliabilityRows.length === 0 ? null : {
    height: categoricalHeight(reliabilityRows.length),
    data: { values: reliabilityRows },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.72 },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'failureRate', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'failureCiLower', type: 'quantitative', title: 'Failure rate (Wilson 95% CI)', axis: { format: '.0%' }, scale: { domain: [0, 1] } },
          x2: { field: 'failureCiUpper' },
          color: { value: CHART_COLORS.gold },
        },
      },
      {
        mark: { type: 'point', filled: true },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'failureRate', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'failureRate', type: 'quantitative', scale: { domain: [0, 1] } },
          size: { field: 'callCount', type: 'quantitative', title: 'Calls', scale: { range: [80, 440] }, legend: { orient: 'bottom', gradientLength: 120 } },
          color: { field: 'callCount', type: 'quantitative', title: 'Calls', legend: null, scale: { range: [CHART_COLORS.gold, CHART_COLORS.coral] } },
          tooltip: [
            { field: 'toolName', type: 'nominal', title: 'Tool' },
            { field: 'callCount', type: 'quantitative', title: 'Calls' },
            { field: 'failureCount', type: 'quantitative', title: 'Failures' },
            { field: 'failureRate', type: 'quantitative', title: 'Failure rate', format: '.1%' },
            { field: 'failureCiLabel', type: 'nominal', title: 'Interval' },
          ],
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'failureRate', order: 'descending' } },
          x: { field: 'failureCiUpper', type: 'quantitative' },
          text: { field: 'callCount', type: 'quantitative' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };

  const deltaSpec: Record<string, unknown> | null = deltaRows.length === 0 ? null : {
    height: categoricalHeight(deltaRows.length),
    data: { values: deltaRows.map((row) => ({ ...row, contrastLabel: `n=${row.usedScoredRunCount}/${row.unusedScoredRunCount}`, absDelta: Math.abs(row.satisfactionDelta ?? 0) })) },
    layer: [
      {
        mark: { type: 'rule', strokeDash: [4, 4], opacity: 0.55 },
        encoding: {
          x: { datum: 0 },
          color: { value: CHART_COLORS.muted },
        },
      },
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.78 },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'absDelta', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'deltaCiLower', type: 'quantitative', title: 'Δ satisfaction when used vs unused (95% CI)', scale: { domain: [-4, 4] } },
          x2: { field: 'deltaCiUpper' },
          color: { value: CHART_COLORS.accent2 },
        },
      },
      {
        mark: { type: 'point', filled: true, size: 140 },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'absDelta', order: 'descending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'satisfactionDelta', type: 'quantitative', scale: { domain: [-4, 4] } },
          color: {
            condition: { test: 'datum.satisfactionDelta >= 0', value: CHART_COLORS.accent },
            value: CHART_COLORS.coral,
          },
          tooltip: [
            { field: 'toolName', type: 'nominal', title: 'Tool' },
            { field: 'satisfactionDelta', type: 'quantitative', title: 'Mean delta', format: '+.2f' },
            { field: 'deltaCiLabel', type: 'nominal', title: 'Interval' },
            { field: 'usedScoredRunCount', type: 'quantitative', title: 'Scored used' },
            { field: 'unusedScoredRunCount', type: 'quantitative', title: 'Scored unused' },
            { field: 'callCount', type: 'quantitative', title: 'Calls' },
          ],
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
        encoding: {
          y: { field: 'toolName', type: 'nominal', sort: { field: 'absDelta', order: 'descending' } },
          x: { field: 'deltaCiUpper', type: 'quantitative' },
          text: { field: 'contrastLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };

  let toolSpec: Record<string, unknown> | null = null;
  if (reliabilitySpec && deltaSpec) {
    toolSpec = {
      width: 'container',
      vconcat: [
        { ...reliabilitySpec, width: 'container' },
        { ...deltaSpec, width: 'container' },
      ],
      spacing: 18,
    };
  } else if (reliabilitySpec) {
    toolSpec = { width: 'container', ...reliabilitySpec };
  } else if (deltaSpec) {
    toolSpec = { width: 'container', ...deltaSpec };
  }
  await renderSpec('chart-tool-failure-rate', toolSpec, 'No tool calls match the current filters.', renderToken);

  // ── 6. Subagent call-depth dose response ────────────────────────────────────
  const subagents = subagentDoseRows(runs);
  const bucketOrder = ['None', '1', '2–3', '4+'];
  setNote('subagent-note', `${subagents.length} call-depth buckets.`, renderToken);

  const subagentSpec: Record<string, unknown> | null = subagents.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(subagents.length),
    data: { values: subagents },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: bucketOrder, title: 'Subagent calls', axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Subagent calls' },
            { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: bucketOrder, title: 'Subagent calls', axis: { labelLimit: 220 } },
          x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [90, 420] }, legend: { orient: 'bottom', gradientLength: 120, labelLimit: 160 } },
          color: { field: 'meanSatisfaction', type: 'quantitative', legend: null, scale: { domain: [1, 5], range: [CHART_COLORS.coral, CHART_COLORS.accent] } },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: bucketOrder },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-subagent-usage', subagentSpec, 'No scored subagent buckets match the current filters.', renderToken);

  // ── 7. Prompt/config scorecard with intervals ───────────────────────────────
  const dimensionResult = dimensionComparisonRows(runs);
  const dimensionRows = dimensionResult.rows;
  setNote('treatment-note', `${dimensionResult.dimensionsWithContrast} config dimensions with variation.`, renderToken);

  const dimensionOrder = ['Experiment', 'Prompt', 'Tool set', 'Skill set'];
  const treatmentSpec: Record<string, unknown> | null = dimensionRows.length === 0 ? null : {
    width: 'container',
    data: { values: dimensionRows },
    facet: {
      row: {
        field: 'dimension',
        sort: dimensionOrder,
        header: { title: null, labelAngle: 0, labelAlign: 'left', labelFontWeight: 600 },
      },
    },
    spacing: 16,
    spec: {
      height: { step: 26 },
      layer: [
        {
          mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.72 },
          encoding: {
            y: { field: 'value', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' }, title: null, axis: { labelLimit: 340, labelFontSize: 10 } },
            x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
            x2: { field: 'ciUpper' },
            color: { value: CHART_COLORS.accent2 },
            tooltip: [
              { field: 'dimension', type: 'nominal', title: 'Dimension' },
              { field: 'value', type: 'nominal', title: 'Value' },
              { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
              { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
              { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            ],
          },
        },
        {
          mark: { type: 'point', filled: true },
          encoding: {
            y: { field: 'value', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' }, axis: { labelLimit: 340, labelFontSize: 10 } },
            x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
            size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [60, 240] }, legend: { orient: 'bottom', columns: 6, gradientLength: 160, labelLimit: 120 } },
            color: { value: CHART_COLORS.accent },
          },
        },
        {
          mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
          encoding: {
            y: { field: 'value', type: 'nominal', sort: { field: 'meanSatisfaction', order: 'descending' }, axis: { labelLimit: 340, labelFontSize: 10 } },
            x: { field: 'ciUpper', type: 'quantitative' },
            text: { field: 'nLabel', type: 'nominal' },
            color: { value: CHART_COLORS.muted },
          },
        },
      ],
    },
    resolve: { scale: { y: 'independent' } },
  };
  await renderSpec('chart-treatment-purity', treatmentSpec, 'No scored config groups match the current filters.', renderToken);

  // ── 8. Change size vs outcome — raw runs plus a trend guide ─────────────────
  const mutation = mutationRows(runs);
  const uniqueMutationX = new Set(mutation.map((row) => row.lineMutationTotal)).size;
  const showTrend = mutation.length >= 4 && uniqueMutationX >= 2;
  const bucketing = mutationBucketRows(mutation);
  setNote('mutation-note', bucketing
    ? `${bucketing.means.length} size buckets (quartile cuts); raw scatter below for context.`
    : `${mutation.length} scored runs${showTrend ? '; trend omitted (sqrt axis).' : '.'}`,
  renderToken);

  const scatterSpec: Record<string, unknown> = {
    height: 220,
    data: { values: mutation },
    layer: [
      {
        mark: { type: 'point', filled: true, opacity: 0.72, strokeWidth: 1 },
        encoding: {
          x: {
            field: 'lineMutationTotal',
            type: 'quantitative',
            title: 'Line mutation volume (sqrt scale)',
            scale: { type: 'sqrt', nice: true },
          },
          y: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { domain: [1, 5] } },
          color: {
            field: 'resolution',
            type: 'nominal',
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
            scale: {
              domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
              range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
            },
          },
          size: { field: 'touchedFileCount', type: 'quantitative', title: 'Touched files', scale: { range: [60, 420] }, legend: { orient: 'bottom', gradientLength: 120 } },
          tooltip: [
            { field: 'modelId', type: 'nominal', title: 'Model' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
            { field: 'lineMutationTotal', type: 'quantitative', title: 'Line mutations' },
            { field: 'touchedFileCount', type: 'quantitative', title: 'Touched files' },
            { field: 'toolFailureCount', type: 'quantitative', title: 'Tool failures' },
            { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
          ],
        },
      },
      // Trend line intentionally omitted: the x-axis is sqrt-scaled because lineMutationTotal is
      // zero-heavy (~65% of runs have 0 mutations, so a log scale would drop most points), and
      // Vega-Lite has no sqrt regression method. A linear OLS fit drawn on a sqrt axis would not
      // track the visual point cloud, so the misleading line is omitted rather than misfit.
    ],
  };

  let mutationSpec: Record<string, unknown> | null = null;
  if (mutation.length === 0) {
    mutationSpec = null;
  } else if (bucketing) {
    const bucketLabels = bucketing.composition
      .filter((row, idx, arr) => arr.findIndex((other) => other.bucketIndex === row.bucketIndex) === idx)
      .sort((a, b) => a.bucketIndex - b.bucketIndex)
      .map((row) => row.bucket);
    mutationSpec = {
      width: 'container',
      vconcat: [
        {
          width: 'container',
          height: 120,
          data: { values: bucketing.composition },
          mark: { type: 'bar' },
          encoding: {
            y: { field: 'bucket', type: 'nominal', sort: bucketLabels, title: 'Size bucket' },
            x: {
              field: 'share',
              type: 'quantitative',
              stack: 'zero',
              axis: { format: '.0%', tickCount: 6 },
              scale: { domain: [0, 1] },
              title: 'Share of scored runs',
            },
            color: {
              field: 'resolution',
              type: 'nominal',
              legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
              scale: {
                domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
                range: [CHART_COLORS.accent, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
              },
              title: 'Resolution',
            },
            tooltip: [
              { field: 'bucket', type: 'nominal', title: 'Bucket' },
              { field: 'resolution', type: 'nominal', title: 'Resolution' },
              { field: 'count', type: 'quantitative', title: 'Runs' },
              { field: 'share', type: 'quantitative', title: 'Share', format: '.1%' },
              { field: 'scoredRunCount', type: 'quantitative', title: 'Bucket n' },
            ],
          },
        },
        {
          width: 'container',
          height: 140,
          data: { values: bucketing.means },
          layer: [
            {
              mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: bucketLabels, title: 'Size bucket' },
                x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
                x2: { field: 'ciUpper' },
                color: { value: CHART_COLORS.accent2 },
              },
            },
            {
              mark: { type: 'point', filled: true },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: bucketLabels },
                x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
                size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [80, 420] }, legend: null },
                color: { value: CHART_COLORS.accent },
                tooltip: [
                  { field: 'bucket', type: 'nominal', title: 'Bucket' },
                  { field: 'nLabel', type: 'nominal', title: 'Scored n' },
                  { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
                  { field: 'ciLabel', type: 'nominal', title: 'Interval' },
                ],
              },
            },
            {
              mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: bucketLabels },
                x: { field: 'ciUpper', type: 'quantitative' },
                text: { field: 'nLabel', type: 'nominal' },
                color: { value: CHART_COLORS.muted },
              },
            },
          ],
        },
        { ...scatterSpec, width: 'container' },
      ],
      spacing: 18,
    };
  } else {
    mutationSpec = { width: 'container', height: 320, ...scatterSpec };
  }
  await renderSpec('chart-file-mutation', mutationSpec, 'No scored runs match the current filters.', renderToken);

  // ── 9. Time productivity by model (busy minutes per assistant turn) ──
  const productivity = timeProductivityRows(runs);
  setNote(
    'productivity-note',
    productivity.length === 0
      ? 'Need completed runs with assistant turns.'
      : `${productivity.length} model/thinking groups; bar = IQR (p25–p75) of minutes per assistant turn, point = median. Lower = more work per minute. ${sampleWarning(productivity, 'runCount')}`,
    renderToken,
  );

  const productivitySpec: Record<string, unknown> | null = productivity.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(productivity.length),
    data: { values: productivity },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.6 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianMinutesPerTurn', order: 'ascending' }, title: null, axis: { labelLimit: 220 } },
          x: { field: 'p25MinutesPerTurn', type: 'quantitative', title: 'Minutes per assistant turn (log)', scale: { type: 'log', nice: true } },
          x2: { field: 'p75MinutesPerTurn' },
          color: { value: CHART_COLORS.gold },
        },
      },
      {
        mark: { type: 'point', filled: true, size: 170, opacity: 0.95 },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianMinutesPerTurn', order: 'ascending' } },
          x: { field: 'medianMinutesPerTurn', type: 'quantitative', scale: { type: 'log', nice: true } },
          color: { field: 'thinkingLevel', type: 'nominal', title: 'Reasoning', scale: { domain: THINKING_LEVEL_DOMAIN, range: THINKING_LEVEL_RANGE }, legend: { orient: 'bottom', direction: 'horizontal', columns: 6, symbolLimit: 6, labelLimit: 160 } },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Group' },
            { field: 'nLabel', type: 'nominal', title: 'Runs' },
            { field: 'medianMinutesPerTurnLabel', type: 'nominal', title: 'Median per turn' },
            { field: 'p25MinutesPerTurnLabel', type: 'nominal', title: 'P25 per turn' },
            { field: 'p75MinutesPerTurnLabel', type: 'nominal', title: 'P75 per turn' },
          ],
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
        encoding: {
          y: { field: 'label', type: 'nominal', sort: { field: 'medianMinutesPerTurn', order: 'ascending' } },
          x: { field: 'p75MinutesPerTurn', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-time-productivity', productivitySpec, 'No completed runs with assistant turns match the current filters.', renderToken);

  // ── 10. Time investment Pareto ────────────────────────────────────────
  const paretoRows = timeParetoRows(runs);
  const totalParetoMinutes = paretoRows.length === 0 ? 0 : paretoRows.reduce((sum, row) => sum + row.busyMinutes, 0);
  setNote(
    'pareto-note',
    paretoRows.length === 0
      ? 'No completed runs with busy time match the current filters.'
      : `Top ${paretoRows.length} longest runs ranked; line = cumulative share of all completed busy time. Total shown: ${formatBusyDuration(totalParetoMinutes * 60000)}.`,
    renderToken,
  );

  const paretoSpec: Record<string, unknown> | null = paretoRows.length === 0 ? null : {
    width: 'container',
    height: 320,
    data: { values: paretoRows },
    layer: [
      {
        mark: { type: 'bar', opacity: 0.78 },
        encoding: {
          x: { field: 'rank', type: 'ordinal', title: 'Run rank (longest first)', axis: { labelAngle: 0 } },
          y: { field: 'busyMinutes', type: 'quantitative', title: 'Busy minutes' },
          color: {
            field: 'resolution',
            type: 'nominal',
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
            scale: {
              domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
              range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
            },
          },
          tooltip: [
            { field: 'rank', type: 'ordinal', title: 'Rank' },
            { field: 'startedAt', type: 'nominal', title: 'Started' },
            { field: 'modelId', type: 'nominal', title: 'Model' },
            { field: 'thinkingLevel', type: 'nominal', title: 'Thinking' },
            { field: 'busyLabel', type: 'nominal', title: 'Busy duration' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', format: '.1f' },
            { field: 'cumulativeShare', type: 'quantitative', title: 'Cumulative share', format: '.1%' },
          ],
        },
      },
      {
        mark: { type: 'line', point: { filled: true, size: 50 }, strokeWidth: 2, opacity: 0.9 },
        encoding: {
          x: { field: 'rank', type: 'ordinal' },
          y: { field: 'cumulativeShare', type: 'quantitative', title: 'Cumulative share of busy time', axis: { format: '.0%', orient: 'right' }, scale: { domain: [0, 1] } },
          color: { value: CHART_COLORS.accent },
        },
      },
    ],
    resolve: { scale: { y: 'independent' } },
  };
  await renderSpec('chart-time-pareto', paretoSpec, 'No completed runs with busy time match the current filters.', renderToken);

  // ── 11. Context saturation vs satisfaction (scatter + regression) ──
  const contextPoints = contextSaturationPoints(runs);
  const showContextSaturationTrend = contextPoints.length >= 4 && new Set(contextPoints.map((row) => row.fillShare)).size >= 2;
  setNote(
    'context-saturation-note',
    contextPoints.length === 0
      ? 'No scored runs with context fill data match the current filters.'
      : `${contextPoints.length} scored runs${showContextSaturationTrend ? '; point = run, line = OLS fit of satisfaction over fill share.' : '.'}`,
    renderToken,
  );

  const contextSatSpec: Record<string, unknown> | null = contextPoints.length === 0 ? null : {
    width: 'container',
    height: 320,
    data: { values: contextPoints },
    layer: [
      {
        mark: { type: 'point', filled: true, opacity: 0.78, size: 80, stroke: '#07140b', strokeWidth: 0.6 },
        encoding: {
          x: {
            field: 'fillShare',
            type: 'quantitative',
            title: 'Context fill (tokens / limit)',
            axis: { format: '.0%' },
            scale: { domain: [0, 1] },
          },
          y: {
            field: 'satisfaction',
            type: 'quantitative',
            title: 'Satisfaction',
            scale: { domain: [1, 5] },
          },
          color: {
            field: 'resolution',
            type: 'nominal',
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
            scale: {
              domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
              range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
            },
          },
          tooltip: [
            { field: 'modelId', type: 'nominal', title: 'Model' },
            { field: 'fillLabel', type: 'nominal', title: 'Context fill' },
            { field: 'contextTokens', type: 'quantitative', title: 'Tokens', format: ',' },
            { field: 'contextLimit', type: 'quantitative', title: 'Limit', format: ',' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'busyMinutes', type: 'quantitative', title: 'Busy minutes', format: '.1f' },
          ],
        },
      },
      ...(showContextSaturationTrend ? [{
        transform: [{ regression: 'satisfaction', on: 'fillShare', extent: [0, 1] }],
        mark: { type: 'line', strokeWidth: 2.4, opacity: 0.9, color: CHART_COLORS.accent },
        encoding: {
          x: { field: 'fillShare', type: 'quantitative' },
          y: { field: 'satisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
        },
      },
      {
        transform: [
          { regression: 'satisfaction', on: 'fillShare', params: true },
          { calculate: "'R\u00b2 = ' + (isValid(datum.rSquared) ? format(datum.rSquared, '.2f') : '—') + ' \u00b7 slope = ' + (datum.coef && datum.coef.length > 1 ? format(datum.coef[1], '.2f') : '—')", as: 'fitLabel' },
        ],
        mark: { type: 'text', align: 'left', baseline: 'top', dx: 8, dy: 8, fontSize: 11, opacity: 0.85 },
        encoding: {
          x: { datum: 0 },
          y: { datum: 5 },
          text: { field: 'fitLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      }] : []),
    ],
  };
  await renderSpec('chart-context-saturation', contextSatSpec, 'No scored runs with context fill data match the current filters.', renderToken);

  // ── 12. Subagent task depth — dose response by task count ────────────
  const subagentTaskRows = subagentTaskDoseRows(runs);
  const taskBucketOrder = ['None', '1', '2–3', '4+'];
  setNote('subagent-task-note', `${subagentTaskRows.length} task-count buckets.`, renderToken);

  const subagentTaskSpec: Record<string, unknown> | null = subagentTaskRows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(subagentTaskRows.length),
    data: { values: subagentTaskRows },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: taskBucketOrder, title: 'Subagent tasks', axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Subagent tasks' },
            { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            { field: 'resolveRate', type: 'quantitative', title: 'Resolved rate', format: '.0%' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: taskBucketOrder, title: 'Subagent tasks', axis: { labelLimit: 220 } },
          x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [90, 420] }, legend: { orient: 'bottom', gradientLength: 120, labelLimit: 160 } },
          color: { field: 'meanSatisfaction', type: 'quantitative', legend: null, scale: { domain: [1, 5], range: [CHART_COLORS.coral, CHART_COLORS.accent] } },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: taskBucketOrder },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-subagent-task-depth', subagentTaskSpec, 'No scored subagent task buckets match the current filters.', renderToken);

  // ── 13. Workload intensity & subagent delegation ──
  const complexityScatter = complexitySubagentScatterRows(runs);
  const complexityTiers = complexitySubagentTierRows(complexityScatter, runs);
  setNote(
    'complexity-subagent-note',
    complexityTiers
      ? `${complexityScatter.length} scored runs; ${complexityTiers.filter((t) => t.scoredRunCount > 0).length} workload-intensity tiers by line-mutation quartiles.`
      : `${complexityScatter.length} scored runs; scatter shows delegation vs workload size.`,
    renderToken,
  );

  let complexitySubagentSpec: Record<string, unknown> | null = null;
  if (complexityScatter.length === 0) {
    complexitySubagentSpec = null;
  } else if (complexityTiers) {
    const tierLabels = complexityTiers.filter((t) => t.scoredRunCount > 0).map((t) => t.bucket);
    complexitySubagentSpec = {
      width: 'container',
      vconcat: [
        {
          width: 'container',
          height: 130,
          data: { values: complexityTiers },
          layer: [
            {
              mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.72 },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels, title: 'Workload-intensity tier' },
                x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
                x2: { field: 'ciUpper' },
                color: { value: CHART_COLORS.accent2 },
                tooltip: [
                  { field: 'bucket', type: 'nominal', title: 'Tier' },
                  { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
                  { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
                  { field: 'meanLineMutations', type: 'quantitative', title: 'Avg line mutations', format: '.0f' },
                  { field: 'meanSubagentCalls', type: 'quantitative', title: 'Avg subagent calls', format: '.1f' },
                  { field: 'subagentUseRate', type: 'quantitative', title: 'Subagent use rate', format: '.0%' },
                ],
              },
            },
            {
              mark: { type: 'point', filled: true },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels },
                x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
                size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [80, 380] }, legend: { orient: 'bottom', gradientLength: 120 } },
                color: { value: CHART_COLORS.accent },
              },
            },
            {
              mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels },
                x: { field: 'ciUpper', type: 'quantitative' },
                text: { field: 'nLabel', type: 'nominal' },
                color: { value: CHART_COLORS.muted },
              },
            },
          ],
        },
        {
          width: 'container',
          height: 130,
          data: { values: complexityTiers },
          layer: [
            {
              mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.78 },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels, title: 'Workload-intensity tier' },
                x: { field: 'subagentUseCiLower', type: 'quantitative', title: 'Subagent use rate (Wilson 95% CI)', axis: { format: '.0%' }, scale: { domain: [0, 1] } },
                x2: { field: 'subagentUseCiUpper' },
                color: { value: CHART_COLORS.gold },
              },
            },
            {
              mark: { type: 'point', filled: true },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels },
                x: { field: 'subagentUseRate', type: 'quantitative', scale: { domain: [0, 1] } },
                size: { field: 'runCount', type: 'quantitative', title: 'Total runs', scale: { range: [80, 380] }, legend: null },
                color: { value: CHART_COLORS.gold },
                tooltip: [
                  { field: 'bucket', type: 'nominal', title: 'Tier' },
                  { field: 'subagentUseRate', type: 'quantitative', title: 'Subagent use rate', format: '.0%' },
                  { field: 'subagentUseCiLabel', type: 'nominal', title: 'Interval' },
                  { field: 'meanSubagentCalls', type: 'quantitative', title: 'Avg subagent calls', format: '.1f' },
                ],
              },
            },
            {
              mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72, clip: false },
              encoding: {
                y: { field: 'bucket', type: 'nominal', sort: tierLabels },
                x: { field: 'subagentUseCiUpper', type: 'quantitative' },
                text: { field: 'subagentUseCiLabel', type: 'nominal' },
                color: { value: CHART_COLORS.muted },
              },
            },
          ],
        },
        {
          width: 'container',
          height: 220,
          data: { values: complexityScatter },
          layer: [
            {
              mark: { type: 'point', filled: true, opacity: 0.55, strokeWidth: 0.6 },
              encoding: {
                x: { field: 'lineMutationTotal', type: 'quantitative', title: 'Line mutation total (sqrt scale)', scale: { type: 'sqrt', nice: true } },
                y: { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls', scale: { type: 'sqrt', nice: true } },
                color: {
                  field: 'resolution',
                  type: 'nominal',
                  title: 'Resolution',
                  legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
                  scale: {
                    domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
                    range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
                  },
                },
                size: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { range: [40, 180] }, legend: { orient: 'bottom', gradientLength: 120 } },
                tooltip: [
                  { field: 'modelId', type: 'nominal', title: 'Model' },
                  { field: 'resolution', type: 'nominal', title: 'Resolution' },
                  { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
                  { field: 'lineMutationTotal', type: 'quantitative', title: 'Line mutations' },
                  { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
                  { field: 'touchedFileCount', type: 'quantitative', title: 'Touched files' },
                  { field: 'busyMinutes', type: 'quantitative', title: 'Busy minutes', format: '.1f' },
                ],
              },
            },
          ],
        },
      ],
      spacing: 12,
    };
  } else {
    complexitySubagentSpec = {
      width: 'container',
      height: 320,
      data: { values: complexityScatter },
      layer: [
        {
          mark: { type: 'point', filled: true, opacity: 0.55, strokeWidth: 0.6 },
          encoding: {
            x: { field: 'lineMutationTotal', type: 'quantitative', title: 'Line mutation total (sqrt scale)', scale: { type: 'sqrt', nice: true } },
            y: { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls', scale: { type: 'sqrt', nice: true } },
            color: {
              field: 'resolution',
              type: 'nominal',
              title: 'Resolution',
              legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
              scale: {
                domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
                range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
              },
            },
            size: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { range: [40, 180] }, legend: { orient: 'bottom', gradientLength: 120 } },
            tooltip: [
              { field: 'modelId', type: 'nominal', title: 'Model' },
              { field: 'resolution', type: 'nominal', title: 'Resolution' },
              { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
              { field: 'lineMutationTotal', type: 'quantitative', title: 'Line mutations' },
              { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
              { field: 'touchedFileCount', type: 'quantitative', title: 'Touched files' },
              { field: 'busyMinutes', type: 'quantitative', title: 'Busy minutes', format: '.1f' },
            ],
          },
        },
      ],
    };
  }
  await renderSpec('chart-complexity-subagent', complexitySubagentSpec, 'No scored runs match the current filters.', renderToken);

  // ── 14. Subagent adoption trend ────────────────────────────────────────────
  const subagentTrend = subagentTrendRows(runs);
  const subagentTrendDays = subagentTrend.filter((row) => row.subagentPenetration !== null).length;
  setNote(
    'subagent-trend-note',
    subagentTrend.length === 0
      ? 'No completed runs match the current filters.'
      : `${subagentTrendDays} days with subagent activity; bars = subagent call volume, line = penetration rate (runs w/ subagents / total).`,
    renderToken,
  );

  const subagentTrendSpec: Record<string, unknown> | null = subagentTrend.length === 0 ? null : {
    width: 'container',
    data: { values: subagentTrend },
    vconcat: [
      {
        height: 180,
        layer: [
          {
            mark: { type: 'bar', opacity: 0.55, cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: null },
              y: { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
              color: { value: CHART_COLORS.accent },
              tooltip: [
                { field: 'bucketStart', type: 'temporal', title: 'Day' },
                { field: 'totalRunCount', type: 'quantitative', title: 'Total runs' },
                { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
                { field: 'subagentTaskCount', type: 'quantitative', title: 'Subagent tasks' },
                { field: 'subagentCallRateLabel', type: 'nominal', title: 'Call rate' },
                { field: 'runsWithSubagents', type: 'quantitative', title: 'Runs with subagents' },
              ],
            },
          },
          {
            mark: { type: 'bar', opacity: 0.35, cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: null },
              y: { field: 'subagentTaskCount', type: 'quantitative' },
              color: { value: CHART_COLORS.accent2 },
            },
          },
        ],
      },
      {
        height: 130,
        layer: [
          {
            mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.82 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal', title: 'Day' },
              y: { field: 'penetrationCiLower', type: 'quantitative', title: 'Runs with subagents (Wilson 95% CI)', axis: { format: '.0%' }, scale: { domain: [0, 1] } },
              y2: { field: 'penetrationCiUpper' },
              color: { value: CHART_COLORS.accent2 },
              tooltip: [
                { field: 'bucketStart', type: 'temporal', title: 'Day' },
                { field: 'subagentPenetration', type: 'quantitative', title: 'Penetration', format: '.0%' },
                { field: 'penetrationCiLabel', type: 'nominal', title: 'Interval' },
                { field: 'runsWithSubagents', type: 'quantitative', title: 'Runs with subagents' },
                { field: 'totalRunCount', type: 'quantitative', title: 'Total runs' },
              ],
            },
          },
          {
            mark: { type: 'point', filled: true, size: 80, opacity: 0.9 },
            encoding: {
              x: { field: 'bucketStart', type: 'temporal' },
              y: { field: 'subagentPenetration', type: 'quantitative', scale: { domain: [0, 1] } },
              color: { value: CHART_COLORS.gold },
            },
          },
        ],
      },
    ],
  };
  await renderSpec('chart-subagent-trend', subagentTrendSpec, 'No completed runs match the current filters.', renderToken);

  // ── 15. Observed outcomes by subagent use and workload size ────────────────
  const roiTierRows = subagentRoiTierRows(runs);
  const roiBucketLabels = [...new Set(roiTierRows.map((r) => r.bucket))];
  const roiContrastBuckets = roiBucketLabels.filter((label) => {
    const groups = roiTierRows.filter((r) => r.bucket === label).map((r) => r.group);
    return groups.includes('With subagents') && groups.includes('No subagents');
  }).length;
  setNote(
    'subagent-roi-tier-note',
    roiTierRows.length === 0
      ? 'Need at least 8 completed runs to bucket by line-mutation quartiles.'
      : `${roiTierRows.length} groups across ${roiBucketLabels.length} workload-size tiers; ${roiContrastBuckets} tier(s) compare both subagent presence groups.`,
    renderToken,
  );
  const roiTierSpec: Record<string, unknown> | null = roiTierRows.length === 0 ? null : {
    width: 'container',
    height: 240,
    data: { values: roiTierRows },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.4, opacity: 0.75 },
        encoding: {
          x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' }, title: 'Workload-size tier (line mutations)', axis: { labelAngle: 0 } },
          xOffset: { field: 'group', type: 'nominal' },
          y: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          y2: { field: 'ciUpper' },
          color: { field: 'group', type: 'nominal', title: null, scale: { domain: ['No subagents', 'With subagents'], range: [CHART_COLORS.coral, CHART_COLORS.accent] }, legend: { orient: 'bottom' } },
        },
      },
      {
        mark: { type: 'point', filled: true, size: 170, opacity: 0.95 },
        encoding: {
          x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' } },
          xOffset: { field: 'group', type: 'nominal' },
          y: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          color: { field: 'group', type: 'nominal', legend: null, scale: { domain: ['No subagents', 'With subagents'], range: [CHART_COLORS.coral, CHART_COLORS.accent] } },
          tooltip: [
            { field: 'bucket', type: 'nominal', title: 'Workload size' },
            { field: 'group', type: 'nominal', title: 'Group' },
            { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            { field: 'resolveRate', type: 'quantitative', title: 'Resolved share', format: '.0%' },
            { field: 'resolveCiLabel', type: 'nominal', title: 'Resolved interval' },
          ],
        },
      },
      {
        mark: { type: 'text', align: 'center', baseline: 'bottom', dy: -10, fontSize: 10, opacity: 0.72 },
        encoding: {
          x: { field: 'bucket', type: 'ordinal', sort: { field: 'bucketIndex' } },
          xOffset: { field: 'group', type: 'nominal' },
          y: { field: 'ciUpper', type: 'quantitative', scale: { domain: [1, 5] } },
          text: { field: 'nLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-subagent-roi-tier', roiTierSpec, 'Not enough completed runs to compare subagent presence across workload-size tiers.', renderToken);

  // ── 16. Subagent agent diversity dose response ────────────────────────────────────────────────
  const diversityRows = subagentDiversityRows(runs);
  const diversityBucketOrder = ['0', '1', '2', '3+'];
  setNote(
    'subagent-diversity-note',
    diversityRows.length === 0
      ? 'No completed runs match the current filters.'
      : `${diversityRows.length} agent-count buckets; size = scored runs, label = mean subagent calls/run.`,
    renderToken,
  );
  const diversitySpec: Record<string, unknown> | null = diversityRows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(diversityRows.length),
    data: { values: diversityRows.map((r) => ({ ...r, callRateLabel: `${r.subagentCallRate.toFixed(2)} calls/run` })) },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: diversityBucketOrder, title: 'Distinct subagents used', axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'label', type: 'nominal', title: 'Distinct subagents' },
            { field: 'nLabel', type: 'nominal', title: 'Scored / total' },
            { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            { field: 'callRateLabel', type: 'nominal', title: 'Subagent call rate' },
            { field: 'resolveRate', type: 'quantitative', title: 'Resolved share', format: '.0%' },
            { field: 'resolveCiLabel', type: 'nominal', title: 'Resolved interval' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: diversityBucketOrder },
          x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          size: { field: 'scoredRunCount', type: 'quantitative', title: 'Scored runs', scale: { range: [90, 420] }, legend: { orient: 'bottom', labelLimit: 160 } },
          color: { field: 'meanSatisfaction', type: 'quantitative', legend: null, scale: { domain: [1, 5], range: [CHART_COLORS.coral, CHART_COLORS.accent] } },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'label', type: 'ordinal', sort: diversityBucketOrder },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'callRateLabel', type: 'nominal' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-subagent-diversity', diversitySpec, 'No completed runs match the current filters.', renderToken);

  // ── 17. Workload-size distribution by resolution ──────────────────────────
  const taskSizeDist = taskSizeDistributionRows(runs);
  const totalTaskSizeRuns = taskSizeDist.reduce((sum, r) => sum + r.count, 0);
  setNote(
    'task-size-distribution-note',
    taskSizeDist.length === 0
      ? 'No completed runs match the current filters.'
      : `${totalTaskSizeRuns} completed runs binned by line mutations; stacked by resolution.`,
    renderToken,
  );
  const taskSizeResolutionDomain = ['resolved', 'partially_resolved', 'unresolved', 'unscored'];
  const taskSizeResolutionRange = [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted];
  const taskSizeBucketOrder = ['0', '1\u201310', '11\u2013100', '101\u20131k', '>1k'];
  const taskSizeDistSpec: Record<string, unknown> | null = taskSizeDist.length === 0 ? null : {
    width: 'container',
    height: 260,
    data: { values: taskSizeDist },
    mark: { type: 'bar', cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
    encoding: {
      x: { field: 'bucket', type: 'ordinal', sort: taskSizeBucketOrder, title: 'Line mutations', axis: { labelAngle: 0 } },
      y: { field: 'count', type: 'quantitative', title: 'Runs', stack: 'zero' },
      color: { field: 'resolution', type: 'nominal', title: 'Resolution', scale: { domain: taskSizeResolutionDomain, range: taskSizeResolutionRange }, legend: { orient: 'bottom' } },
      order: { field: 'bucketIndex', type: 'quantitative' },
      tooltip: [
        { field: 'bucket', type: 'nominal', title: 'Line mutations' },
        { field: 'resolution', type: 'nominal', title: 'Resolution' },
        { field: 'count', type: 'quantitative', title: 'Runs' },
      ],
    },
  };
  await renderSpec('chart-task-size-distribution', taskSizeDistSpec, 'No completed runs match the current filters.', renderToken);

  // ── 18. Workload size vs busy time ─────────────────────────────────────────
  const taskSizeTime = taskSizeTimeRows(runs);
  setNote(
    'task-size-time-note',
    taskSizeTime.length === 0
      ? 'Need at least 8 completed runs with duration to bucket by line-mutation quartiles.'
      : `${taskSizeTime.length} workload-size tiers; rule = busy-time IQR, point = median; bottom panel = resolved share with Wilson 95% CI.`,
    renderToken,
  );
  const taskSizeTimeSpec = outcomeTimeBucketSpec(taskSizeTime, {
    bucketTitle: 'Workload-size tier (line mutations)',
    timeTitle: 'Busy minutes (log)',
    rateTitle: 'Resolved share',
  });
  await renderSpec('chart-task-size-time', taskSizeTimeSpec, 'Not enough completed runs to bucket by line-mutation quartiles.', renderToken);

  // ── 19-22. Subagent task-score requirements ──────────────────────────────

  const dims = ['precision', 'creativity', 'reasoning', 'thoroughness'] as const;
  type DimName = typeof dims[number];
  const dimKey = (d: DimName) => ({
    precision: 'subagentMeanPrecision',
    creativity: 'subagentMeanCreativity',
    reasoning: 'subagentMeanReasoning',
    thoroughness: 'subagentMeanThoroughness',
  })[d];

  const dimMaxKey = (d: DimName) => ({
    precision: 'subagentMaxPrecision',
    creativity: 'subagentMaxCreativity',
    reasoning: 'subagentMaxReasoning',
    thoroughness: 'subagentMaxThoroughness',
  })[d];

  const scoredWithScores = scored.filter((r: PreparedRunRow) => r.subagentScoredTaskCount > 0);

  // ── (A) Subagent requirement profile ──────────────────────────────────────
  const profileRows: Array<{ dimension: string; dimMean: number; ciLower: number; ciUpper: number; ciLabel: string; n: number }> = [];
  for (const d of dims) {
    const values = scoredWithScores
      .map((r: PreparedRunRow) => (r as any)[dimKey(d)] as number)
      .filter((v: unknown): v is number => v !== null && typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) continue;
    const interval = meanInterval(values, { min: 0, max: 5 });
    if (!interval) continue;
    profileRows.push({
      dimension: d,
      dimMean: interval.mean,
      ciLower: interval.lower,
      ciUpper: interval.upper,
      ciLabel: interval.ciLabel,
      n: values.length,
    });
  }
  setNote('subagent-requirement-profile-note', profileRows.length === 0 ? 'No scored runs with subagent task scores.' : `${profileRows.length} dimensions; mean of per-run mean scores (runs with any scored subagent tasks).`, renderToken);

  const profileSpec: Record<string, unknown> | null = profileRows.length === 0 ? null : {
    width: 'container',
    height: categoricalHeight(profileRows.length),
    data: { values: profileRows },
    layer: [
      {
        mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
        encoding: {
          y: { field: 'dimension', type: 'nominal', sort: dims, title: null, axis: { labelLimit: 220 } },
          x: { field: 'ciLower', type: 'quantitative', title: 'Mean of per-run mean (95% CI)', scale: { domain: [0, 5] } },
          x2: { field: 'ciUpper' },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [
            { field: 'dimension', type: 'nominal', title: 'Dimension' },
            { field: 'dimMean', type: 'quantitative', title: 'Mean score', format: '.2f' },
            { field: 'ciLabel', type: 'nominal', title: 'Interval' },
            { field: 'n', type: 'quantitative', title: 'Runs' },
          ],
        },
      },
      {
        mark: { type: 'point', filled: true, size: 140 },
        encoding: {
          y: { field: 'dimension', type: 'nominal', sort: dims },
          x: { field: 'dimMean', type: 'quantitative', scale: { domain: [0, 5] } },
          color: { value: CHART_COLORS.accent },
        },
      },
      {
        mark: { type: 'text', align: 'left', dx: 8, fontSize: 11, opacity: 0.72 },
        encoding: {
          y: { field: 'dimension', type: 'nominal', sort: dims },
          x: { field: 'ciUpper', type: 'quantitative' },
          text: { field: 'n', type: 'quantitative' },
          color: { value: CHART_COLORS.muted },
        },
      },
    ],
  };
  await renderSpec('chart-subagent-requirement-profile', profileSpec, 'No scored runs with subagent task scores match the current filters.', renderToken);

  // ── (B) Subagent requirement dose-response ────────────────────────────────
  function doseBucket(v: number | null): string {
    if (v === null || !Number.isFinite(v)) return 'none';
    const r = Math.round(v);
    if (r <= 2) return 'low (0-2)';
    if (r === 3) return 'mid (3)';
    return 'high (4-5)';
  }

  const doseRows: Array<{ dimension: string; bucket: string; bucketOrder: number; meanSatisfaction: number; ciLower: number; ciUpper: number; ciLabel: string; n: number }> = [];
  for (const d of dims) {
    const buckets = ['none', 'low (0-2)', 'mid (3)', 'high (4-5)'];
    buckets.forEach((b, idx) => {
      const subset = scored.filter((r: PreparedRunRow) => doseBucket((r as any)[dimKey(d)]) === b);
      if (subset.length === 0) return;
      const interval = meanInterval(subset.map((r: PreparedRunRow) => r.satisfaction ?? 0), { min: 1, max: 5 });
      if (!interval) return;
      doseRows.push({
        dimension: d,
        bucket: b,
        bucketOrder: idx,
        meanSatisfaction: interval.mean,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        ciLabel: interval.ciLabel,
        n: subset.length,
      });
    });
  }
  setNote('subagent-requirement-dose-note', doseRows.length === 0 ? 'No scored runs with subagent task scores.' : `${doseRows.length} dose buckets across ${dims.length} dimensions; facet grid.`, renderToken);

  const doseSpec: Record<string, unknown> | null = doseRows.length === 0 ? null : {
    width: 'container',
    data: { values: doseRows },
    facet: { field: 'dimension', type: 'nominal', sort: dims, columns: 2, header: { title: null, labelAngle: 0, labelAlign: 'left', labelFontWeight: 600 } },
    spacing: 12,
    spec: {
      width: 280,
      height: { step: 26 },
      layer: [
        {
          mark: { type: 'rule', strokeWidth: 2.2, opacity: 0.74 },
          encoding: {
            y: { field: 'bucket', type: 'nominal', sort: { field: 'bucketOrder' }, title: null, axis: { labelLimit: 180 } },
            x: { field: 'ciLower', type: 'quantitative', title: 'Mean satisfaction (95% CI)', scale: { domain: [1, 5] } },
            x2: { field: 'ciUpper' },
            color: { value: CHART_COLORS.accent2 },
            tooltip: [
              { field: 'dimension', type: 'nominal', title: 'Dimension' },
              { field: 'bucket', type: 'nominal', title: 'Dose bucket' },
              { field: 'meanSatisfaction', type: 'quantitative', title: 'Mean satisfaction', format: '.2f' },
              { field: 'ciLabel', type: 'nominal', title: 'Interval' },
              { field: 'n', type: 'quantitative', title: 'Runs' },
            ],
          },
        },
        {
          mark: { type: 'point', filled: true, size: 80 },
          encoding: {
            y: { field: 'bucket', type: 'nominal', sort: { field: 'bucketOrder' }, axis: { labelLimit: 180 } },
            x: { field: 'meanSatisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
            color: { value: CHART_COLORS.accent },
          },
        },
        {
          mark: { type: 'text', align: 'left', dx: 6, fontSize: 10, opacity: 0.72, clip: false },
          encoding: {
            y: { field: 'bucket', type: 'nominal', sort: { field: 'bucketOrder' } },
            x: { field: 'ciUpper', type: 'quantitative' },
            text: { field: 'n', type: 'quantitative' },
            color: { value: CHART_COLORS.muted },
          },
        },
      ],
    },
    resolve: { scale: { y: 'independent' } },
  };
  await renderSpec('chart-subagent-requirement-dose', doseSpec, 'No scored runs with subagent task scores match the current filters.', renderToken);

  // ── (C) Subagent composite requirement scatter ────────────────────────────
  const compositeScatter = scored
    .filter((r: PreparedRunRow) => r.subagentCompositeMean !== null && r.subagentScoredTaskCount > 0)
    .map((r: PreparedRunRow) => ({
      compositeMean: r.subagentCompositeMean as number,
      satisfaction: r.satisfaction ?? 0,
      resolution: r.resolution ?? 'unknown',
      subagentCallCount: r.subagentCallCount,
    }));
  const showCompositeTrend = compositeScatter.length >= 4 && new Set(compositeScatter.map((row) => row.compositeMean)).size >= 2;
  setNote('subagent-composite-requirement-note', compositeScatter.length === 0 ? 'No scored runs with subagentCompositeMean.' : `${compositeScatter.length} scored runs; point = run, size = subagent calls, line = OLS fit.`, renderToken);

  const compositeSpec: Record<string, unknown> | null = compositeScatter.length === 0 ? null : {
    width: 'container',
    height: 300,
    data: { values: compositeScatter },
    layer: [
      {
        mark: { type: 'point', filled: true, opacity: 0.72, strokeWidth: 0.6 },
        encoding: {
          x: { field: 'compositeMean', type: 'quantitative', title: 'Subagent composite mean (0–5)', scale: { domain: [0, 5] } },
          y: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { domain: [1, 5] } },
          color: {
            field: 'resolution',
            type: 'nominal',
            title: 'Resolution',
            legend: { orient: 'bottom', direction: 'horizontal', columns: 4, symbolLimit: 4, labelLimit: 200 },
            scale: {
              domain: ['resolved', 'partially_resolved', 'unresolved', 'unknown'],
              range: [CHART_COLORS.success, CHART_COLORS.gold, CHART_COLORS.coral, CHART_COLORS.muted],
            },
          },
          size: { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls', scale: { range: [50, 400] }, legend: { orient: 'bottom', gradientLength: 120 } },
          tooltip: [
            { field: 'compositeMean', type: 'quantitative', title: 'Composite mean', format: '.2f' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
            { field: 'resolution', type: 'nominal', title: 'Resolution' },
            { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
          ],
        },
      },
      ...(showCompositeTrend ? [{
        transform: [{ regression: 'satisfaction', on: 'compositeMean', method: 'linear' }],
        mark: { type: 'line', strokeDash: [6, 4], strokeWidth: 2, opacity: 0.5 },
        encoding: {
          x: { field: 'compositeMean', type: 'quantitative' },
          y: { field: 'satisfaction', type: 'quantitative', scale: { domain: [1, 5] } },
          color: { value: CHART_COLORS.accent },
        },
      }] : []),
    ],
  };
  await renderSpec('chart-subagent-composite-requirement', compositeSpec, 'No scored runs with subagentCompositeMean match the current filters.', renderToken);

  // ── (D) Subagent requirement volume ────────────────────────────────────────
  const volumeScatter = scored
    .filter((r: PreparedRunRow) => r.subagentCallCount > 0 && r.subagentCompositeMean !== null && r.subagentScoredTaskCount > 0)
    .map((r: PreparedRunRow) => ({
      compositeMean: r.subagentCompositeMean as number,
      subagentCallCount: r.subagentCallCount,
      satisfaction: r.satisfaction ?? 0,
    }));
  const showVolumeTrend = volumeScatter.length >= 4 && new Set(volumeScatter.map((row) => row.compositeMean)).size >= 2;
  setNote('subagent-requirement-volume-note', volumeScatter.length === 0 ? 'No runs with both subagent calls and composite mean.' : `${volumeScatter.length} scored runs with subagent calls; point color = satisfaction, line = OLS fit.`, renderToken);

  const volumeSpec: Record<string, unknown> | null = volumeScatter.length === 0 ? null : {
    width: 'container',
    height: 300,
    data: { values: volumeScatter },
    layer: [
      {
        mark: { type: 'point', filled: true, opacity: 0.72, strokeWidth: 0.6 },
        encoding: {
          x: { field: 'compositeMean', type: 'quantitative', title: 'Subagent composite mean (0–5)', scale: { domain: [0, 5] } },
          y: { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls (sqrt scale)', scale: { type: 'sqrt', nice: true } },
          color: { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction', scale: { scheme: 'yellowgreenblue' }, legend: { orient: 'bottom', gradientLength: 120 } },
          tooltip: [
            { field: 'compositeMean', type: 'quantitative', title: 'Composite mean', format: '.2f' },
            { field: 'subagentCallCount', type: 'quantitative', title: 'Subagent calls' },
            { field: 'satisfaction', type: 'quantitative', title: 'Satisfaction' },
          ],
        },
      },
      ...(showVolumeTrend ? [{
        transform: [{ regression: 'subagentCallCount', on: 'compositeMean', method: 'linear' }],
        mark: { type: 'line', strokeDash: [6, 4], strokeWidth: 2, opacity: 0.5 },
        encoding: {
          x: { field: 'compositeMean', type: 'quantitative' },
          y: { field: 'subagentCallCount', type: 'quantitative', scale: { type: 'sqrt', nice: true } },
          color: { value: CHART_COLORS.accent },
        },
      }] : []),
    ],
  };
  await renderSpec('chart-subagent-requirement-volume', volumeSpec, 'No scored runs with subagent calls and composite mean match the current filters.', renderToken);

  // ── Registry-driven charts (cost, efficiency, pruning, errors, file-types, interruptions, inputs) ──
  const ctx: ChartContext = {
    runs,
    toolRows,
    turnThroughputRows: data.tokenThroughput.rows,
    retryTimingRows: data.retryTiming.rows,
    renderToken,
    pruning: data.pruningImpact,
    backendErrors: data.backendErrors,
    fileExtensions: data.fileExtensions,
    renderSpec,
    setNote,
  };
  await renderChartEntries(newCharts, ctx);
}

// ─── Filter controls ─────────────────────────────────────────────────────────

function currentFilters(): FilterState {
  return {
    startDate: byId<HTMLInputElement>('filter-start').value,
    endDate: byId<HTMLInputElement>('filter-end').value,
    modelId: byId<HTMLSelectElement>('filter-model').value,
    thinkingLevel: byId<HTMLSelectElement>('filter-thinking').value,
    experimentAssignment: byId<HTMLSelectElement>('filter-experiment').value,
    subagentParentModel: byId<HTMLSelectElement>('filter-subagent-parent').value,
    pruningMode: byId<HTMLSelectElement>('filter-pruning-mode').value,
    scoredOnly: byId<HTMLInputElement>('filter-scored-only').checked,
    pureOnly: byId<HTMLInputElement>('filter-pure-only').checked,
  };
}

function resetFilters(): void {
  byId<HTMLInputElement>('filter-start').value = DEFAULT_FILTERS.startDate;
  byId<HTMLInputElement>('filter-end').value = DEFAULT_FILTERS.endDate;
  byId<HTMLSelectElement>('filter-model').value = DEFAULT_FILTERS.modelId;
  byId<HTMLSelectElement>('filter-thinking').value = DEFAULT_FILTERS.thinkingLevel;
  byId<HTMLSelectElement>('filter-experiment').value = DEFAULT_FILTERS.experimentAssignment;
  byId<HTMLSelectElement>('filter-subagent-parent').value = DEFAULT_FILTERS.subagentParentModel;
  byId<HTMLSelectElement>('filter-pruning-mode').value = DEFAULT_FILTERS.pruningMode;
  byId<HTMLInputElement>('filter-scored-only').checked = DEFAULT_FILTERS.scoredOnly;
  byId<HTMLInputElement>('filter-pure-only').checked = DEFAULT_FILTERS.pureOnly;
}

// ─── Empty data shells ────────────────────────────────────────────────────────

function emptyOverviewData(schemaVersion: number): OverviewData {
  return {
    schemaVersion,
    totalCompletedRuns: 0,
    totalOpenRuns: 0,
    totalScoredRuns: 0,
    averageSatisfaction: null,
    resolutionCounts: { resolved: 0, partiallyResolved: 0, unresolved: 0 },
    medianBusyDurationMs: null,
    p90BusyDurationMs: null,
    p99BusyDurationMs: null,
    verificationRunRate: null,
    toolFailureRate: null,
    resultIssueRate: null,
    medianTokenEfficiency: null,
    averageContextUtilization: null,
    averageCacheHitRatio: null,
    firstAttemptSuccessRate: null,
    totalEstimatedCostUsd: null,
    medianEstimatedCostUsd: null,
    latestRunTimestamp: null,
  };
}

function emptyModelQualityData(schemaVersion: number): ModelQualityData {
  return { schemaVersion, rows: [], notes: [] };
}

function emptyVerificationImpactData(schemaVersion: number): VerificationImpactData {
  return { schemaVersion, rows: [], summaryRows: [], notes: [] };
}

function emptyToolUsageData(schemaVersion: number): ToolUsageData {
  return { schemaVersion, rows: [], summaryRows: [] };
}

function emptyTreatmentComparisonData(schemaVersion: number): TreatmentComparisonData {
  return { schemaVersion, rows: [] };
}

function emptyTimelineData(schemaVersion: number): TimelineData {
  return { schemaVersion, rows: [] };
}

function emptyPruningImpactData(schemaVersion: number): PruningImpactData {
  return {
    schemaVersion,
    rows: [],
    signalRows: [],
    summary: {
      totalEvents: 0,
      totalSkillTokensSaved: 0,
      totalToolTokensSaved: 0,
      medianLlmLatencyMs: null,
      modeCounts: {},
      skillReadCount: 0,
      skillMissCount: 0,
      shadowMissCandidateCount: 0,
      toolRecoveredCount: 0,
      decisionsThatPrunedTools: 0,
      pruneRecoveredRate: null,
      skillMissRate: null,
    },
  };
}

function emptyBackendErrorsData(schemaVersion: number): BackendErrorData {
  return {
    schemaVersion,
    rows: [],
    summary: { totalErrorEvents: 0, affectedRunCount: 0, byErrorCode: [] },
  };
}

function emptyFileExtensionsData(schemaVersion: number): FileExtensionData {
  return { schemaVersion, rows: [], summary: [] };
}

function emptyTokenThroughputData(schemaVersion: number): TokenThroughputData {
  return { schemaVersion, rows: [], notes: [] };
}

function emptyRetryTimingData(schemaVersion: number): RetryTimingData {
  return { schemaVersion, rows: [], notes: [] };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [manifest, runSummary] = await Promise.all([
    fetchJson<SiteManifest>('./data/manifest.json'),
    fetchJson<RunSummaryData>('./data/run-summary.json'),
  ]);

  const [overview, modelQuality, verificationImpact, toolUsage, treatmentComparison, timeline, pruningImpact, backendErrors, fileExtensions, tokenThroughput, retryTiming, modelLeaderboard] = await Promise.all([
    fetchOptionalJson<OverviewData>('./data/overview.json'),
    fetchOptionalJson<ModelQualityData>('./data/model-quality.json'),
    fetchOptionalJson<VerificationImpactData>('./data/verification-impact.json'),
    fetchOptionalJson<ToolUsageData>('./data/tool-usage.json'),
    fetchOptionalJson<TreatmentComparisonData>('./data/treatment-comparison.json'),
    fetchOptionalJson<TimelineData>('./data/timeline.json'),
    fetchOptionalJson<PruningImpactData>('./data/pruning-impact.json'),
    fetchOptionalJson<BackendErrorData>('./data/backend-errors.json'),
    fetchOptionalJson<FileExtensionData>('./data/file-types.json'),
    fetchOptionalJson<TokenThroughputData>('./data/token-throughput.json'),
    fetchOptionalJson<RetryTimingData>('./data/retry-timing.json'),
    fetchOptionalJson<ModelLeaderboardData>('./data/model-leaderboard.json'),
  ]);

  const precomputedAvailable = Boolean(
    overview && modelQuality && verificationImpact && toolUsage && treatmentComparison && timeline && pruningImpact && backendErrors && fileExtensions && tokenThroughput && retryTiming && modelLeaderboard,
  );

  if (!precomputedAvailable) {
    console.warn('[pie-analysis] Missing one or more generated JSON files. Falling back to run-summary-driven charts.');
  }

  const data: DashboardData = {
    manifest,
    overview: overview ?? emptyOverviewData(manifest.schemaVersion),
    runSummary,
    modelQuality: modelQuality ?? emptyModelQualityData(manifest.schemaVersion),
    verificationImpact: verificationImpact ?? emptyVerificationImpactData(manifest.schemaVersion),
    toolUsage: toolUsage ?? emptyToolUsageData(manifest.schemaVersion),
    treatmentComparison: treatmentComparison ?? emptyTreatmentComparisonData(manifest.schemaVersion),
    timeline: timeline ?? emptyTimelineData(manifest.schemaVersion),
    pruningImpact: pruningImpact ?? emptyPruningImpactData(manifest.schemaVersion),
    backendErrors: backendErrors ?? emptyBackendErrorsData(manifest.schemaVersion),
    fileExtensions: fileExtensions ?? emptyFileExtensionsData(manifest.schemaVersion),
    tokenThroughput: tokenThroughput ?? emptyTokenThroughputData(manifest.schemaVersion),
    retryTiming: retryTiming ?? emptyRetryTimingData(manifest.schemaVersion),
    modelLeaderboard: modelLeaderboard ?? createModelLeaderboardFromRuns(runSummary.rows),
  };

  setText('generated-at', formatDateTime(data.manifest.generatedAt));
  setText('workspace-key', data.manifest.sourceWorkspaceKey);
  setText('source-exported-at', formatDateTime(data.manifest.sourceExportedAt));
  setText('data-mode', data.manifest.dataMode);

  const allRuns = data.runSummary.rows;
  populateSelect('filter-model', sortNatural(uniqueNonEmpty(allRuns.map((run) => modelFamilyKey(run)))), 'All models');
  populateSelect(
    'filter-thinking',
    sortThinkingLevels(uniqueNonEmpty(allRuns.map((run) => normalizeThinkingLevel(run.thinkingLevel)))),
    'All levels',
    { labelForValue: formatThinkingLevelLabel },
  );
  populateSelect(
    'filter-experiment',
    sortNatural([...new Set(allRuns.map((run) => normalizedExperimentLabel(run.experimentAssignment)))]),
    'All assignments',
  );

  const subagentParentValues: string[] = [];
  if (allRuns.some((run) => run.fsSubagentAlwaysParentModel === true)) {
    subagentParentValues.push('true');
  }
  if (allRuns.some((run) => run.fsSubagentAlwaysParentModel === false)) {
    subagentParentValues.push('false');
  }
  populateSelect('filter-subagent-parent', subagentParentValues, 'All runs', {
    labelForValue: (value) => (value === 'true' ? 'On' : 'Off'),
  });
  populateSelect(
    'filter-pruning-mode',
    sortNatural(uniqueNonEmpty(allRuns.map((run) => run.fsPruningMode))),
    'All modes',
  );

  const render = async () => {
    const renderToken = ++activeRenderToken;
    const filters = currentFilters();
    const filteredRuns = applyFilters(data.runSummary.rows, filters);
    const usePrecomputed = precomputedAvailable && isDefaultFilterState(filters);
    renderCoverageBanner(filteredRuns);
    renderCards(filteredRuns, data.overview, usePrecomputed);
    await renderCharts(filteredRuns, data.toolUsage.rows, data, usePrecomputed, renderToken);
  };

  byId('filters').addEventListener('change', () => {
    void render();
  });
  byId('filter-reset').addEventListener('click', () => {
    resetFilters();
    void render();
  });

  await render();
}

// Only auto-run the dashboard entry point in a browser context. Guarding this keeps the
// module importable in Node (e.g. for unit-testing `leaderboardRows`) without touching `document`.
if (typeof document !== 'undefined') {
  main().catch((error) => {
    const message = toErrorMessage(error);
    document.body.innerHTML = `<div class="shell"><section class="panel chart-empty">${escapeHtml(message)}</section></div>`;
  });
}

export { leaderboardRows };
