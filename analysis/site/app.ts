import embed from 'vega-embed';

import { createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { renderChartEntries, type ChartContext } from './lib.ts';
import { newCharts } from './charts/index.ts';
import { toErrorMessage } from '../../shared/error-message.js';

import type {
  BackendErrorData,
  FileExtensionData,
  ModelLeaderboardData,
  ModelLeaderboardRow,
  OverviewData,
  PreparedRunRow,
  PreparedToolUsageRow,
  PruningImpactData,
  RetryTimingData,
  RunSummaryData,
  SessionReviewAnalyticsData,
  SiteManifest,
  TokenThroughputData,
  ToolUsageData,
} from '../scripts/contracts.ts';

interface DashboardData {
  manifest: SiteManifest;
  overview: OverviewData;
  runSummary: RunSummaryData;
  toolUsage: ToolUsageData;
  pruningImpact: PruningImpactData;
  backendErrors: BackendErrorData;
  fileExtensions: FileExtensionData;
  tokenThroughput: TokenThroughputData;
  retryTiming: RetryTimingData;
  modelLeaderboard: ModelLeaderboardData;
  sessionReviewAnalytics: SessionReviewAnalyticsData | null;
}

export interface FilterState {
  startDate: string;
  endDate: string;
  modelId: string;
  thinkingLevel: string;
  experimentAssignment: string;
  subagentParentModel: string;
  pruningMode: string;
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
  pureOnly: false,
};

const CHART_COLORS = {
  accent: '#8de3ff',
  accent2: '#c0ff72',
  gold: '#ffd479',
  text: '#f6f1e8',
  muted: '#b9b1a3',
  grid: 'rgba(255,255,255,0.05)',
};
const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const chartViews = new Map<string, { finalize: () => void }>();
let activeRenderToken = 0;

function byId<TElement extends HTMLElement>(id: string): TElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as TElement;
}

async function fetchJson<TValue>(relativePath: string): Promise<TValue> {
  const response = await fetch(relativePath, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load ${relativePath}: ${response.status} ${response.statusText}`);
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
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function countRowsLabel(rows: Array<{ value: string; count: number }>): string {
  return rows.length ? rows.map((row) => `${escapeHtml(row.value)}: ${row.count}`).join(' · ') : 'none';
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Static V2 review diagnostics; review artifacts are cohort-level and do not follow run filters. */
export function sessionReviewAnalyticsHtml(data: SessionReviewAnalyticsData | null): string {
  if (!data) return '<p class="empty-state">session-review-analytics.json is unavailable.</p>';
  const summary = data.summary;
  const diagnostics = data.diagnostics;
  const rejectionReasons = Object.entries(diagnostics.rejectedByReason)
    .map(([reason, count]) => `${escapeHtml(reason)}: ${count}`)
    .join(' · ');
  const process = Object.entries(data.process)
    .map(([field, rows]) => `<li><strong>${escapeHtml(field)}</strong>: ${countRowsLabel(rows)}</li>`)
    .join('');
  const diagnosticClass = diagnostics.rejectedCount > 0 ? ' review-ingestion-warning' : '';
  return `
    <div class="review-diagnostic-grid">
      <article class="${diagnosticClass.trim()}"><h4>V2 ingestion diagnostics</h4><p><strong>Raw:</strong> ${diagnostics.rawProductionCount} · <strong>Accepted:</strong> ${diagnostics.acceptedCount} · <strong>Rejected:</strong> ${diagnostics.rejectedCount}</p><p><strong>Rejected by reason:</strong> ${rejectionReasons || 'none'}</p></article>
      <article><h4>Criterion attainment</h4><p><strong>Delivered:</strong> ${countRowsLabel(summary.deliveredOverall)}</p><p><strong>Controllable:</strong> ${countRowsLabel(summary.controllableOverall)}</p><p><strong>qualityIndexV1:</strong> ${summary.meanQualityIndexV1 ?? '—'} (${summary.qualityIndexCount} assessable · ${summary.notAssessableReviewCount} not-assessable)</p></article>
      <article><h4>Coverage, confidence &amp; blockers</h4><p><strong>Criterion coverage:</strong> ${percentage(summary.criterionCoverage)}</p><p><strong>External blocker rate:</strong> ${percentage(summary.externalBlockerRate)}</p><p><strong>Confidence:</strong> ${countRowsLabel(summary.confidence)}</p><p>${summary.joinedReviewCount}/${summary.reviewCount} joined · ${summary.identityFallbackCount} fallback identities</p></article>
      <article><h4>Process diagnostics</h4><ul>${process}</ul></article>
      <article><h4>Evidence diagnostics</h4><p><strong>Requirements:</strong> ${countRowsLabel(data.evidence.requirements)}</p><p><strong>Artifacts:</strong> ${countRowsLabel(data.evidence.artifacts)}</p><p><strong>Execution:</strong> ${countRowsLabel(data.evidence.execution)}</p><p><strong>Human:</strong> ${countRowsLabel(data.evidence.human)}</p><p><strong>Limitations:</strong> ${data.evidence.limitationCount}</p></article>
      <article><h4>Disagreement &amp; reviewers</h4><p>${data.disagreement.materialCount} material · ${data.disagreement.adjudicatedCount} adjudicated · ${data.disagreement.disputedFieldCount} disputed fields</p><p>${data.reviewers.callCount} reviewer calls · ${data.reviewers.bucketDowngradeCount} bucket downgrades · ${data.reviewers.diversityAchievedCount} diverse reviews</p><p><strong>Roles:</strong> ${countRowsLabel(data.reviewers.byRole)}</p><p><strong>Families:</strong> ${countRowsLabel(data.reviewers.byFamily)}</p></article>
    </div>`;
}

function normalizeThinkingLevel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized === 'max' ? 'xhigh' : normalized;
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
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return left.localeCompare(right);
  });
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function modelFamilyKey(run: { modelFamily: string | null; modelId?: string | null }): string {
  return run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)';
}

export function applyFilters(runs: PreparedRunRow[], filters: FilterState): PreparedRunRow[] {
  return runs.filter((run) => {
    if (filters.startDate && run.startedDay < filters.startDate) return false;
    if (filters.endDate && run.startedDay > filters.endDate) return false;
    if (filters.modelId && modelFamilyKey(run) !== filters.modelId) return false;
    if (normalizeThinkingLevel(filters.thinkingLevel) && normalizeThinkingLevel(run.thinkingLevel) !== normalizeThinkingLevel(filters.thinkingLevel)) return false;
    if (filters.experimentAssignment && (run.experimentAssignment ?? '(none)') !== filters.experimentAssignment) return false;
    if (filters.subagentParentModel) {
      const matches = filters.subagentParentModel === 'true' ? run.fsSubagentAlwaysParentModel === true : run.fsSubagentAlwaysParentModel === false;
      if (!matches) return false;
    }
    if (filters.pruningMode && run.fsPruningMode !== filters.pruningMode) return false;
    if (filters.pureOnly && run.mixedTreatmentConfig) return false;
    return true;
  });
}

function estimatedRunCostUsd(run: PreparedRunRow): number | null {
  return typeof run.totalEstimatedCostUsd === 'number' && Number.isFinite(run.totalEstimatedCostUsd) ? run.totalEstimatedCostUsd : null;
}

function hasReportedParentTokenUsage(run: PreparedRunRow): boolean {
  return run.tokenReportedTurnCount > 0 || run.inputTokens > 0 || run.outputTokens > 0 || run.cacheReadTokens > 0 || run.cacheWriteTokens > 0;
}

export interface CoverageMetric { count: number; percentage: number | null }
export interface CoverageSummary {
  selectedRunCount: number;
  completed: CoverageMetric;
  priced: CoverageMetric;
  tokenTelemetry: CoverageMetric;
  mixedModel: CoverageMetric;
}

export function coverageSummary(runs: PreparedRunRow[]): CoverageSummary {
  const completed = runs.filter((run) => run.status !== 'open');
  const metric = (count: number, denominator: number): CoverageMetric => ({ count, percentage: denominator === 0 ? null : count / denominator });
  return {
    selectedRunCount: runs.length,
    completed: metric(completed.length, runs.length),
    priced: metric(completed.filter((run) => estimatedRunCostUsd(run) !== null).length, completed.length),
    tokenTelemetry: metric(completed.filter(hasReportedParentTokenUsage).length, completed.length),
    mixedModel: metric(completed.filter((run) => run.mixedModelConfig).length, completed.length),
  };
}

function renderCoverageBanner(runs: PreparedRunRow[]): void {
  const coverage = coverageSummary(runs);
  const item = (label: string, metric: CoverageMetric) => `<span class="coverage-item"><strong>${label}</strong><span>${metric.count}/${label === 'Completed' ? coverage.selectedRunCount : coverage.completed.count} (${percentage(metric.percentage)})</span></span>`;
  byId('coverage-banner').innerHTML = `<div class="coverage-copy"><strong>Filtered cohort: ${coverage.selectedRunCount} runs</strong><span>Runtime cards and charts use this cohort. V2 review analytics and ranks remain cohort-level.</span></div><div class="coverage-metrics">${item('Completed', coverage.completed)}${item('Priced', coverage.priced)}${item('Token telemetry', coverage.tokenTelemetry)}${item('Mixed-model', coverage.mixedModel)}</div>`;
}

function renderCards(runs: PreparedRunRow[], overview: OverviewData, usePrecomputed: boolean): void {
  const completed = runs.filter((run) => run.status !== 'open');
  const costs = completed.map(estimatedRunCostUsd).filter((value): value is number => value !== null);
  const toolCalls = completed.reduce((sum, run) => sum + run.toolCallCount, 0);
  const toolFailures = completed.reduce((sum, run) => sum + run.toolFailureCount, 0);
  const busy = [...completed.map((run) => run.busyDurationMs)].sort((a, b) => a - b);
  const medianBusy = busy.length === 0 ? null : busy[Math.floor((busy.length - 1) / 2)] ?? null;
  const values = usePrecomputed ? {
    completed: overview.totalCompletedRuns,
    open: overview.totalOpenRuns,
    verification: overview.verificationRunRate,
    failures: overview.toolFailureRate,
    busy: overview.medianBusyDurationMs,
    cost: overview.totalEstimatedCostUsd,
  } : {
    completed: completed.length,
    open: runs.filter((run) => run.status === 'open').length,
    verification: completed.length ? completed.filter((run) => run.verificationTotalCount > 0).length / completed.length : null,
    failures: toolCalls ? toolFailures / toolCalls : null,
    busy: medianBusy,
    cost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
  };
  const cards = [
    { label: 'Runs', value: String(values.completed + values.open), detail: `${values.completed} completed · ${values.open} open` },
    { label: 'Verification', value: percentage(values.verification), detail: 'completed runs with checks' },
    { label: 'Tool failures', value: percentage(values.failures), detail: 'of tool calls' },
    { label: 'Median time', value: values.busy === null ? '—' : `${Math.round(values.busy / 1000)}s`, detail: 'busy duration' },
    { label: 'Cost', value: values.cost === null ? '—' : `$${values.cost.toFixed(2)}`, detail: 'complete estimated spend' },
  ];
  byId('overview-cards').innerHTML = cards.map((card) => `<article class="metric-card"><p>${card.label}</p><strong>${card.value}</strong><p>${card.detail}</p></article>`).join('');
}

function chartConfig(): Record<string, unknown> {
  return {
    autosize: { type: 'pad', contains: 'padding', resize: true },
    background: 'transparent',
    config: {
      view: { stroke: 'transparent' },
      axis: { labelColor: CHART_COLORS.muted, titleColor: CHART_COLORS.text, domainColor: CHART_COLORS.grid, gridColor: CHART_COLORS.grid, tickColor: CHART_COLORS.grid },
      legend: { labelColor: CHART_COLORS.text, titleColor: CHART_COLORS.text, labelLimit: 300 },
    },
  };
}

function isCurrentRender(renderToken: number): boolean { return renderToken === activeRenderToken; }

async function renderSpec(targetId: string, spec: Record<string, unknown> | null, emptyMessage: string, renderToken: number): Promise<void> {
  if (!isCurrentRender(renderToken)) return;
  const target = byId(targetId);
  chartViews.get(targetId)?.finalize();
  chartViews.delete(targetId);
  if (!spec) {
    target.innerHTML = `<div class="chart-empty">${emptyMessage}</div>`;
    return;
  }
  const resolved = { ...spec };
  if (resolved.width === 'container') resolved.width = Math.max(320, Math.floor(target.getBoundingClientRect().width || 760) - 8);
  target.innerHTML = '';
  try {
    const result = await embed(target, { ...chartConfig(), ...resolved } as any, { actions: false, renderer: 'svg' });
    if (!isCurrentRender(renderToken)) {
      result.view.finalize();
      return;
    }
    chartViews.set(targetId, result.view);
  } catch (error) {
    target.innerHTML = `<div class="chart-empty">Unable to render chart: ${escapeHtml(toErrorMessage(error))}</div>`;
  }
}

function setNote(id: string, text: string, renderToken: number): void {
  if (isCurrentRender(renderToken)) byId(id).textContent = text;
}

interface LeaderboardDisplayRow {
  modelId: string;
  providersLabel: string;
  rank: number | null;
  rankLabel: string;
  score: number | null;
  scoreLabel: string;
  intervalLabel: string;
  rankRangeLabel: string;
  evidenceTier: string;
  evidenceWarning: string;
  reviewLabel: string;
  coverageLabel: string;
  taskLabel: string;
  costLabel: string;
  durationLabel: string;
  fileChurnLabel: string;
  toolReliabilityLabel: string;
  verificationLabel: string;
  tokenEfficiencyLabel: string;
}

export function leaderboardRows(runs: PreparedRunRow[], precomputed?: ModelLeaderboardData): {
  composite: LeaderboardDisplayRow[];
  tableRows: LeaderboardDisplayRow[];
  rows: ModelLeaderboardRow[];
  caseMix: ModelLeaderboardData['caseMix'];
} {
  const leaderboard = precomputed ?? createModelLeaderboardFromRuns(runs);
  const fmtPct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(0)}%`;
  const tableRows = leaderboard.rows.map((row) => {
    const providers = row.providers.map((provider) => provider.modelId);
    const providersLabel = providers.length > 1 ? `${providers.length} providers · ${providers.join(', ')}` : providers[0] !== row.modelId ? providers[0] ?? '' : '';
    const intervalLabel = row.scoreInterval80 ? `${(row.scoreInterval80.lower * 100).toFixed(1)}–${(row.scoreInterval80.upper * 100).toFixed(1)}%` : 'unavailable';
    const rankRangeLabel = row.scoreInterval80 ? `#${row.scoreInterval80.bestRank}–#${row.scoreInterval80.worstRank}` : 'unresolved';
    const sparse = row.evidenceTier !== 'review-backed' || row.effectiveTaskCount < 5;
    const uncertain = row.scoreInterval80 !== null && row.scoreInterval80.bestRank !== row.scoreInterval80.worstRank;
    return {
      modelId: row.modelId,
      providersLabel,
      rank: row.rank,
      rankLabel: row.rank === null ? '—' : `#${row.rank}`,
      score: row.compositeScore,
      scoreLabel: row.compositeScore === null ? '—' : `${(row.compositeScore * 100).toFixed(1)}%`,
      intervalLabel,
      rankRangeLabel,
      evidenceTier: row.evidenceTier,
      evidenceWarning: [sparse ? 'SPARSE EVIDENCE' : '', uncertain ? 'RANK UNCERTAIN' : ''].filter(Boolean).join(' · ') || 'evidence adequate for this cohort',
      reviewLabel: `${row.v2ReviewCount} reviews · ${row.reviewEvidenceMass.toFixed(1)} mass · ${row.meanQualityIndexV1?.toFixed(1) ?? '—'} mean index`,
      coverageLabel: `${fmtPct(row.scoringCoverage)} task coverage · ${fmtPct(row.evidenceWeight)} evidence weight`,
      taskLabel: `${row.effectiveTaskCount} reviewed / ${row.attributableTaskCount} attributable tasks · ${row.runCount} runs`,
      costLabel: row.medianCostUsd === null ? '—' : `$${row.medianCostUsd.toFixed(4)}`,
      durationLabel: row.medianDurationMs === null ? '—' : `${Math.round(row.medianDurationMs / 1000)}s`,
      fileChurnLabel: fmtPct(row.dimensions.fileChurn.value),
      toolReliabilityLabel: fmtPct(row.dimensions.toolReliability.value),
      verificationLabel: fmtPct(row.dimensions.verificationPassRate.value),
      tokenEfficiencyLabel: row.dimensions.tokenEfficiency.value?.toFixed(1) ?? '—',
    } satisfies LeaderboardDisplayRow;
  });
  return { composite: tableRows.filter((row) => row.rank !== null && row.score !== null), tableRows, rows: leaderboard.rows, caseMix: leaderboard.caseMix };
}

function renderLeaderboardTable(rows: LeaderboardDisplayRow[]): void {
  byId('leaderboard-table').innerHTML = rows.length === 0 ? '' : `<table class="data-table leaderboard-table"><caption>Provisional cohort-relative ranks stay visible. Sparse evidence and overlapping 80% intervals are warnings that row order is uncertain, not reasons to hide a model.</caption><thead><tr><th>Rank</th><th>Model family</th><th>Evidence warning</th><th>V2 score</th><th>80% score interval</th><th>Rank range</th><th>V2 review evidence</th><th>Coverage</th><th>Tasks / runs</th><th>Median cost</th><th>Median time</th><th>File churn</th><th>Tool clean</th><th>Verification pass</th><th>Tok/line</th></tr></thead><tbody>${rows.map((row) => `<tr class="${row.evidenceWarning === 'evidence adequate for this cohort' ? 'ranked-row' : 'uncertain-rank-row'}"><td class="rank-cell">${row.rankLabel}</td><th scope="row"><span class="model-name">${escapeHtml(row.modelId)}</span>${row.providersLabel ? `<span class="model-providers">${escapeHtml(row.providersLabel)}</span>` : ''}</th><td><strong>${escapeHtml(row.evidenceWarning)}</strong><br>${escapeHtml(row.evidenceTier)}</td><td class="numeric strong-cell">${row.scoreLabel}</td><td class="numeric">${row.intervalLabel}</td><td class="numeric">${row.rankRangeLabel}</td><td>${escapeHtml(row.reviewLabel)}</td><td>${escapeHtml(row.coverageLabel)}</td><td>${escapeHtml(row.taskLabel)}</td><td>${row.costLabel}</td><td>${row.durationLabel}</td><td>${row.fileChurnLabel}</td><td>${row.toolReliabilityLabel}</td><td>${row.verificationLabel}</td><td>${row.tokenEfficiencyLabel}</td></tr>`).join('')}</tbody></table>`;
}

async function renderLeaderboard(data: ModelLeaderboardData, renderToken: number): Promise<void> {
  const display = leaderboardRows([], data);
  const sparseCount = display.tableRows.filter((row) => row.evidenceWarning.includes('SPARSE')).length;
  const uncertainCount = display.tableRows.filter((row) => row.evidenceWarning.includes('UNCERTAIN')).length;
  setNote('leaderboard-note', `${display.composite.length} provisional ranks · ${sparseCount} sparse-evidence families · ${uncertainCount} uncertain rank intervals. Review-only scoring; runtime telemetry remains diagnostic.`, renderToken);
  renderLeaderboardTable(display.tableRows);
  const spec = display.composite.length === 0 ? null : {
    width: 'container',
    height: Math.max(220, display.composite.length * 34),
    data: { values: display.composite },
    layer: [
      { mark: { type: 'rule', strokeWidth: 4, opacity: 0.55 }, encoding: { y: { field: 'modelId', type: 'nominal', sort: { field: 'rank' }, title: null }, x: { field: 'score', type: 'quantitative', title: 'Regularized V2 review quality', scale: { domain: [0, 1] } }, color: { value: CHART_COLORS.gold }, tooltip: [{ field: 'rankLabel', title: 'Rank' }, { field: 'rankRangeLabel', title: 'Rank range' }, { field: 'intervalLabel', title: '80% interval' }, { field: 'evidenceWarning', title: 'Uncertainty' }] } },
      { mark: { type: 'point', filled: true, size: 160 }, encoding: { y: { field: 'modelId', type: 'nominal', sort: { field: 'rank' } }, x: { field: 'score', type: 'quantitative' }, color: { field: 'evidenceTier', type: 'nominal', legend: { orient: 'bottom' } }, tooltip: [{ field: 'rankLabel', title: 'Provisional rank' }, { field: 'scoreLabel', title: 'Score' }, { field: 'rankRangeLabel', title: 'Rank range' }, { field: 'reviewLabel', title: 'Review evidence' }, { field: 'coverageLabel', title: 'Coverage' }, { field: 'evidenceWarning', title: 'Warning' }] } },
    ],
  } as Record<string, unknown>;
  await renderSpec('chart-leaderboard', spec, 'No V2-ranked model families are available.', renderToken);
}

function runtimeTimelineRows(runs: PreparedRunRow[]) {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of runs.filter((row) => row.status !== 'open')) groups.set(run.startedDay, [...(groups.get(run.startedDay) ?? []), run]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([day, rows]) => ({ day, runCount: rows.length, averageBusyMinutes: rows.reduce((sum, row) => sum + row.busyDurationMs, 0) / rows.length / 60000 }));
}

async function renderRuntimeSummary(runs: PreparedRunRow[], renderToken: number): Promise<void> {
  const timeline = runtimeTimelineRows(runs);
  setNote('timeline-note', `${timeline.length} active days; bars show completed-run volume and line shows average busy time.`, renderToken);
  const timelineSpec = timeline.length === 0 ? null : { width: 'container', height: 260, data: { values: timeline }, layer: [
    { mark: { type: 'bar', opacity: 0.35 }, encoding: { x: { field: 'day', type: 'temporal', title: 'Day' }, y: { field: 'runCount', type: 'quantitative', title: 'Completed runs' }, color: { value: CHART_COLORS.accent2 }, tooltip: [{ field: 'day', type: 'temporal' }, { field: 'runCount', title: 'Runs' }] } },
    { mark: { type: 'line', point: true, strokeWidth: 2 }, encoding: { x: { field: 'day', type: 'temporal' }, y: { field: 'averageBusyMinutes', type: 'quantitative', title: 'Average busy minutes' }, color: { value: CHART_COLORS.gold }, tooltip: [{ field: 'averageBusyMinutes', title: 'Avg busy min', format: '.1f' }] } },
  ], resolve: { scale: { y: 'independent' } } } as Record<string, unknown>;
  await renderSpec('chart-timeline', timelineSpec, 'No completed runs match the filters.', renderToken);

  const groups = new Map<string, number[]>();
  for (const run of runs.filter((row) => row.status !== 'open')) {
    const key = `${modelFamilyKey(run)} · ${formatThinkingLevelLabel(normalizeThinkingLevel(run.thinkingLevel) ?? 'off')}`;
    groups.set(key, [...(groups.get(key) ?? []), run.busyDurationMs / 60000]);
  }
  const efficiency = [...groups.entries()].map(([model, values]) => ({ model, medianBusyMinutes: [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0, runCount: values.length })).sort((a, b) => a.medianBusyMinutes - b.medianBusyMinutes);
  setNote('model-efficiency-note', `${efficiency.length} model/reasoning groups; median completed-run busy duration.`, renderToken);
  await renderSpec('chart-model-efficiency', efficiency.length === 0 ? null : { width: 'container', height: Math.max(220, efficiency.length * 30), data: { values: efficiency }, mark: { type: 'bar', cornerRadiusEnd: 3 }, encoding: { y: { field: 'model', type: 'nominal', sort: efficiency.map((row) => row.model), title: null }, x: { field: 'medianBusyMinutes', type: 'quantitative', title: 'Median busy minutes' }, color: { value: CHART_COLORS.accent }, tooltip: [{ field: 'model' }, { field: 'medianBusyMinutes', format: '.1f' }, { field: 'runCount', title: 'Runs' }] } }, 'No completed runs match the filters.', renderToken);
}

async function renderCharts(runs: PreparedRunRow[], toolRows: PreparedToolUsageRow[], data: DashboardData, renderToken: number): Promise<void> {
  await renderLeaderboard(data.modelLeaderboard, renderToken);
  await renderRuntimeSummary(runs, renderToken);
  const context: ChartContext = { runs, toolRows, turnThroughputRows: data.tokenThroughput.rows, retryTimingRows: data.retryTiming.rows, renderToken, pruning: data.pruningImpact, backendErrors: data.backendErrors, fileExtensions: data.fileExtensions, renderSpec, setNote };
  await renderChartEntries(newCharts, context);
}

function populateSelect(id: string, values: string[], placeholder: string, labelForValue: (value: string) => string = (value) => value): void {
  const select = byId<HTMLSelectElement>(id);
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labelForValue(value);
    select.append(option);
  }
}

function currentFilters(): FilterState {
  return {
    startDate: byId<HTMLInputElement>('filter-start').value,
    endDate: byId<HTMLInputElement>('filter-end').value,
    modelId: byId<HTMLSelectElement>('filter-model').value,
    thinkingLevel: byId<HTMLSelectElement>('filter-thinking').value,
    experimentAssignment: byId<HTMLSelectElement>('filter-experiment').value,
    subagentParentModel: byId<HTMLSelectElement>('filter-subagent-parent').value,
    pruningMode: byId<HTMLSelectElement>('filter-pruning-mode').value,
    pureOnly: byId<HTMLInputElement>('filter-pure-only').checked,
  };
}

function resetFilters(): void {
  for (const id of ['filter-start', 'filter-end', 'filter-model', 'filter-thinking', 'filter-experiment', 'filter-subagent-parent', 'filter-pruning-mode']) (byId<HTMLInputElement | HTMLSelectElement>(id)).value = '';
  byId<HTMLInputElement>('filter-pure-only').checked = false;
}

async function main(): Promise<void> {
  const [manifest, runSummary] = await Promise.all([fetchJson<SiteManifest>('./data/manifest.json'), fetchJson<RunSummaryData>('./data/run-summary.json')]);
  const [overview, toolUsage, pruningImpact, backendErrors, fileExtensions, tokenThroughput, retryTiming, modelLeaderboard, sessionReviewAnalytics] = await Promise.all([
    fetchJson<OverviewData>('./data/overview.json'),
    fetchJson<ToolUsageData>('./data/tool-usage.json'),
    fetchJson<PruningImpactData>('./data/pruning-impact.json'),
    fetchJson<BackendErrorData>('./data/backend-errors.json'),
    fetchJson<FileExtensionData>('./data/file-types.json'),
    fetchJson<TokenThroughputData>('./data/token-throughput.json'),
    fetchJson<RetryTimingData>('./data/retry-timing.json'),
    fetchOptionalJson<ModelLeaderboardData>('./data/model-leaderboard.json'),
    fetchOptionalJson<SessionReviewAnalyticsData>('./data/session-review-analytics.json'),
  ]);
  const data: DashboardData = { manifest, overview, runSummary, toolUsage, pruningImpact, backendErrors, fileExtensions, tokenThroughput, retryTiming, modelLeaderboard: modelLeaderboard ?? createModelLeaderboardFromRuns(runSummary.rows), sessionReviewAnalytics };
  byId('session-review-analytics').innerHTML = sessionReviewAnalyticsHtml(sessionReviewAnalytics);
  byId('generated-at').textContent = new Date(manifest.generatedAt).toLocaleString();
  byId('workspace-key').textContent = manifest.sourceWorkspaceKey;
  byId('source-exported-at').textContent = new Date(manifest.sourceExportedAt).toLocaleString();
  byId('data-mode').textContent = manifest.dataMode;

  const allRuns = runSummary.rows;
  populateSelect('filter-model', sortNatural(uniqueNonEmpty(allRuns.map((run) => modelFamilyKey(run)))), 'All models');
  populateSelect('filter-thinking', sortThinkingLevels(uniqueNonEmpty(allRuns.map((run) => normalizeThinkingLevel(run.thinkingLevel)))), 'All levels', formatThinkingLevelLabel);
  populateSelect('filter-experiment', sortNatural([...new Set(allRuns.map((run) => run.experimentAssignment ?? '(none)'))]), 'All assignments');
  populateSelect('filter-subagent-parent', ['true', 'false'].filter((value) => allRuns.some((run) => run.fsSubagentAlwaysParentModel === (value === 'true'))), 'All runs', (value) => value === 'true' ? 'On' : 'Off');
  populateSelect('filter-pruning-mode', sortNatural(uniqueNonEmpty(allRuns.map((run) => run.fsPruningMode))), 'All modes');

  const render = async () => {
    const renderToken = ++activeRenderToken;
    const filters = currentFilters();
    const filtered = applyFilters(allRuns, filters);
    renderCoverageBanner(filtered);
    renderCards(filtered, overview, JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS));
    await renderCharts(filtered, toolUsage.rows, data, renderToken);
  };
  byId('filters').addEventListener('change', () => void render());
  byId('filter-reset').addEventListener('click', () => { resetFilters(); void render(); });
  await render();
}

if (typeof document !== 'undefined') {
  main().catch((error) => { document.body.innerHTML = `<div class="shell"><section class="panel chart-empty">${escapeHtml(toErrorMessage(error))}</section></div>`; });
}
