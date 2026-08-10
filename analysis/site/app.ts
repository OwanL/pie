import embed from 'vega-embed';

import { createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { renderChartEntries, type ChartContext, modelColorScale, renderJoinUnmatchedReasonsHtml } from './lib.ts';
import { newCharts } from './charts/index.ts';
import { deriveActionabilityInsights, renderInsightCards } from './actionability.ts';
import { evidenceReliabilityHtml } from './charts/outcomes.ts';
import { toErrorMessage } from '../../shared/error-message.js';

import type {
  BackendErrorData,
  EvidenceReliabilityData,
  FileExtensionData,
  ModelLeaderboardData,
  ModelLeaderboardRow,
  OutcomeCorrelationData,
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
  outcomeCorrelations: OutcomeCorrelationData | null;
  evidenceReliability: EvidenceReliabilityData | null;
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
const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Minimal Vega view handle stored for cleanup on re-render. */
interface VegaView {
  finalize(): void;
}
const chartViews = new Map<string, VegaView>();
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
  const joinCoverage = data.joinCoverage;
  const rejectionReasons = Object.entries(diagnostics.rejectedByReason)
    .map(([reason, count]) => `${escapeHtml(reason)}: ${count}`)
    .join(' · ');
  const process = Object.entries(data.process)
    .map(([field, rows]) => `<li><strong>${escapeHtml(field)}</strong>: ${countRowsLabel(rows)}</li>`)
    .join('');
  const diagnosticClass = diagnostics.rejectedCount > 0 ? ' review-ingestion-warning' : '';
  const joinLossRate = joinCoverage.totalReviews > 0 ? joinCoverage.unmatchedCount / joinCoverage.totalReviews : null;
  return `
    <div class="review-diagnostic-grid">
      <details class="review-details" open>
        <summary>V2 ingestion diagnostics</summary>
        <article class="${diagnosticClass.trim()}"><p><strong>Raw:</strong> ${diagnostics.rawProductionCount} · <strong>Accepted:</strong> ${diagnostics.acceptedCount} · <strong>Rejected:</strong> ${diagnostics.rejectedCount}</p><p><strong>Rejected by reason:</strong> ${rejectionReasons || 'none'}</p></article>
      </details>
      <details class="review-details">
        <summary>Review↔run join coverage</summary>
        <article><p><strong>Total:</strong> ${joinCoverage.totalReviews} · <strong>Joined:</strong> ${joinCoverage.joinedCount} · <strong>Unmatched:</strong> ${joinCoverage.unmatchedCount}${joinLossRate !== null ? ` (${percentage(joinLossRate)})` : ''}</p><p><strong>By join key:</strong> session_id ${joinCoverage.byJoinKey.session_id} · path_fallback ${joinCoverage.byJoinKey.path_fallback} · unmatched ${joinCoverage.byJoinKey.unmatched}</p><p><strong>Unmatched reasons:</strong> ${renderJoinUnmatchedReasonsHtml(joinCoverage.unmatchedByReason)}</p></article>
      </details>
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
  return normalized;
}

function formatThinkingLevelLabel(value: string): string {
  return value;
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

/** Cohort-level insight cards, evidence-reliability banner, and quality-vs-cost — render once at startup. */
function renderCohortInsights(data: DashboardData): void {
  const joinCoverage = data.sessionReviewAnalytics?.joinCoverage ?? null;
  const result = deriveActionabilityInsights({
    correlations: data.outcomeCorrelations,
    reliability: data.evidenceReliability,
    joinCoverage,
  });
  byId('actionability-insights').innerHTML = renderInsightCards(result);
  byId('evidence-reliability-banner').innerHTML = evidenceReliabilityHtml(data.outcomeCorrelations, data.evidenceReliability, joinCoverage);
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

async function renderSpec(targetId: string, spec: Record<string, unknown> | null, emptyMessage: string, renderToken: number, renderer: 'svg' | 'canvas' = 'svg'): Promise<void> {
  if (!isCurrentRender(renderToken)) return;
  const target = byId(targetId);
  chartViews.get(targetId)?.finalize();
  chartViews.delete(targetId);
  if (!spec) {
    target.innerHTML = `<div class="chart-empty">${emptyMessage}</div>`;
    return;
  }
  const resolved = { ...spec };
  // Resolve container width to a concrete pixel value so the chart always has a
  // non-zero size on first paint; a debounced resize listener in main()
  // re-renders so charts reflow when the viewport changes.
  if (resolved.width === 'container') resolved.width = Math.max(320, Math.floor(target.getBoundingClientRect().width || 760) - 8);
  target.innerHTML = '';
  try {
    const result = await embed(target, { ...chartConfig(), ...resolved } as any, { actions: false, renderer });
    if (!isCurrentRender(renderToken)) {
      result.view.finalize();
      return;
    }
    chartViews.set(targetId, result.view as VegaView);
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

/** Responsive card-based leaderboard (reflows on mobile; no wide horizontal-scroll table). */
function renderLeaderboardCards(rows: LeaderboardDisplayRow[]): void {
  const html = rows.length === 0 ? '<p class="empty-state">No model families with V2 ranking evidence.</p>' : `<div class="lb-card-grid" role="list">${rows.map((row) => {
    const warningClass = row.evidenceWarning === 'evidence adequate for this cohort' ? '' : 'lb-card-uncertain';
    return `<article class="lb-card ${row.evidenceTier} ${warningClass}" role="listitem" aria-label="${escapeHtml(row.modelId)} rank ${row.rankLabel}">
      <div class="lb-card-head"><span class="lb-rank">${row.rankLabel}</span><span class="lb-model">${escapeHtml(row.modelId)}</span><span class="lb-tier">${escapeHtml(row.evidenceTier)}</span></div>
      <div class="lb-score-row">
        <div class="lb-stat"><strong>${row.scoreLabel}</strong><span>V2 score</span></div>
        <div class="lb-stat"><strong>${row.intervalLabel}</strong><span>80% interval</span></div>
        <div class="lb-stat"><strong>${row.rankRangeLabel}</strong><span>rank range</span></div>
      </div>
      <div class="lb-meta">
        <span>${escapeHtml(row.reviewLabel)}</span>
        <span>median cost ${row.costLabel}</span>
        <span>median time ${row.durationLabel}</span>
        <span>verification ${row.verificationLabel}</span>
        <span>tool clean ${row.toolReliabilityLabel}</span>
      </div>
      ${row.providersLabel ? `<p class="lb-providers">${escapeHtml(row.providersLabel)}</p>` : ''}
      ${row.evidenceWarning === 'evidence adequate for this cohort' ? '' : `<p class="lb-warning">${escapeHtml(row.evidenceWarning)}</p>`}
    </article>`;
  }).join('')}</div>`;
  byId('leaderboard-cards').innerHTML = html;
}

async function renderLeaderboard(data: ModelLeaderboardData, renderToken: number): Promise<void> {
  const display = leaderboardRows([], data);
  const sparseCount = display.tableRows.filter((row) => row.evidenceWarning.includes('SPARSE')).length;
  const uncertainCount = display.tableRows.filter((row) => row.evidenceWarning.includes('UNCERTAIN')).length;
  setNote('leaderboard-note', `${display.composite.length} provisional ranks · ${sparseCount} sparse-evidence families · ${uncertainCount} uncertain rank intervals. Review-only scoring; runtime telemetry remains diagnostic.`, renderToken);
  renderLeaderboardCards(display.tableRows);
  const spec = display.composite.length === 0 ? null : {
    width: 'container',
    height: Math.max(220, display.composite.length * 34),
    description: 'V2 review-quality leaderboard: regularized composite score per model family with an 80% interval and a rank range derived from interval overlap.',
    data: { values: display.composite },
    layer: [
      { mark: { type: 'rule', strokeWidth: 4, opacity: 0.55 }, encoding: { y: { field: 'modelId', type: 'nominal', sort: { field: 'rank' }, title: null }, x: { field: 'score', type: 'quantitative', title: 'Regularized V2 review quality', scale: { domain: [0, 1] } }, color: { value: CHART_COLORS.gold }, tooltip: [{ field: 'rankLabel', title: 'Rank' }, { field: 'rankRangeLabel', title: 'Rank range' }, { field: 'intervalLabel', title: '80% interval' }, { field: 'evidenceWarning', title: 'Uncertainty' }] } },
      { mark: { type: 'point', filled: true, size: 160 }, encoding: { y: { field: 'modelId', type: 'nominal', sort: { field: 'rank' } }, x: { field: 'score', type: 'quantitative' }, color: { field: 'evidenceTier', type: 'nominal', legend: { orient: 'bottom' } }, tooltip: [{ field: 'rankLabel', title: 'Provisional rank' }, { field: 'scoreLabel', title: 'Score' }, { field: 'rankRangeLabel', title: 'Rank range' }, { field: 'reviewLabel', title: 'Review evidence' }, { field: 'coverageLabel', title: 'Coverage' }, { field: 'evidenceWarning', title: 'Warning' }] } },
    ],
  } as Record<string, unknown>;
  await renderSpec('chart-leaderboard', spec, 'No V2-ranked model families are available.', renderToken);
}

/** Honest quality-vs-cost scatter: V2 score (with 80% interval) against median cost. */
async function renderQualityVsCost(data: ModelLeaderboardData, renderToken: number): Promise<void> {
  const points = data.rows
    .filter((row) => row.compositeScore !== null && row.medianCostUsd !== null)
    .map((row) => ({
      model: row.modelId,
      score: row.compositeScore!,
      lower: row.scoreInterval80?.lower ?? row.compositeScore!,
      upper: row.scoreInterval80?.upper ?? row.compositeScore!,
      cost: row.medianCostUsd!,
      tier: row.evidenceTier,
      reviews: row.v2ReviewCount,
      interval: row.scoreInterval80 ? `${(row.scoreInterval80.lower * 100).toFixed(1)}–${(row.scoreInterval80.upper * 100).toFixed(1)}%` : 'unavailable',
    }));
  setNote('quality-vs-cost-note', `${points.length} ranked families. Up-and-left = better quality for less cost. The 80% interval shows how uncertain each score is; sparse families have wide intervals. Cost is median complete spend per run, not part of the V2 score.`, renderToken);
  const spec = points.length === 0 ? null : {
    width: 'container',
    height: 320,
    description: 'Quality versus cost: V2 review-quality score (with 80% interval) plotted against median cost per run for each ranked model family.',
    data: { values: points },
    layer: [
      { mark: { type: 'rule', size: 2, opacity: 0.5 }, encoding: { x: { field: 'cost', type: 'quantitative', title: 'Median cost per run (USD)', scale: { zero: true, nice: true } }, y: { field: 'lower', type: 'quantitative', scale: { domain: [0, 1] } }, y2: { field: 'upper' }, color: { field: 'tier', type: 'nominal', legend: null } } },
      { mark: { type: 'circle', filled: true, size: 220, opacity: 0.85 }, encoding: { x: { field: 'cost', type: 'quantitative' }, y: { field: 'score', type: 'quantitative', title: 'V2 review quality (80% interval)', scale: { domain: [0, 1] }, axis: { format: '.0%' } }, color: { field: 'tier', type: 'nominal', title: 'Evidence tier', scale: modelColorScale(points.map((p) => p.tier)), legend: { orient: 'bottom' } }, size: { field: 'reviews', type: 'quantitative', legend: null }, tooltip: [{ field: 'model', title: 'Model' }, { field: 'score', title: 'Score', format: '.1%' }, { field: 'interval', title: '80% interval' }, { field: 'cost', title: 'Median cost / run', format: '$.4f' }, { field: 'tier', title: 'Evidence tier' }, { field: 'reviews', title: 'V2 reviews' }] } },
    ],
  } as Record<string, unknown>;
  await renderSpec('chart-quality-vs-cost', spec, 'No ranked model families with both a V2 score and median cost.', renderToken);
}

function runtimeTimelineRows(runs: PreparedRunRow[]) {
  const groups = new Map<string, PreparedRunRow[]>();
  for (const run of runs.filter((row) => row.status !== 'open')) groups.set(run.startedDay, [...(groups.get(run.startedDay) ?? []), run]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([day, rows]) => ({ day, runCount: rows.length, averageBusyMinutes: rows.reduce((sum, row) => sum + row.busyDurationMs, 0) / rows.length / 60000 }));
}

async function renderRuntimeSummary(runs: PreparedRunRow[], renderToken: number): Promise<void> {
  const timeline = runtimeTimelineRows(runs);
  setNote('timeline-note', `${timeline.length} active days; top panel shows completed-run volume, bottom panel shows average busy time (separate axes, not overlaid).`, renderToken);
  // Two stacked panels sharing the x-axis instead of a single dual-axis chart:
  // run count and busy minutes have different units, so overlaying them on
  // independent y-axes is misleading. Each panel keeps its own honest scale.
  const timelineSpec = timeline.length === 0 ? null : {
    width: 'container',
    vconcat: [
      {
        height: 140,
        data: { values: timeline },
        mark: { type: 'bar', opacity: 0.55, cornerRadiusEnd: 2 },
        encoding: {
          x: { field: 'day', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Day' },
          y: { field: 'runCount', type: 'quantitative', title: 'Completed runs', scale: { zero: true, nice: true } },
          color: { value: CHART_COLORS.accent2 },
          tooltip: [{ field: 'day', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Day' }, { field: 'runCount', title: 'Runs' }],
        },
      },
      {
        height: 140,
        data: { values: timeline },
        mark: { type: 'line', point: { filled: true, size: 35, opacity: 0.6 }, strokeWidth: 2 },
        encoding: {
          x: { field: 'day', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Day' },
          y: { field: 'averageBusyMinutes', type: 'quantitative', title: 'Average busy minutes', scale: { zero: true, nice: true } },
          color: { value: CHART_COLORS.gold },
          tooltip: [{ field: 'day', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Day' }, { field: 'averageBusyMinutes', title: 'Avg busy min', format: '.1f' }],
        },
      },
    ],
  } as Record<string, unknown>;
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
  await renderQualityVsCost(data.modelLeaderboard, renderToken);
  await renderRuntimeSummary(runs, renderToken);
  const context: ChartContext = {
    runs,
    toolRows,
    turnThroughputRows: data.tokenThroughput.rows,
    retryTimingRows: data.retryTiming.rows,
    renderToken,
    pruning: data.pruningImpact,
    backendErrors: data.backendErrors,
    fileExtensions: data.fileExtensions,
    outcomeCorrelations: data.outcomeCorrelations,
    evidenceReliability: data.evidenceReliability,
    renderSpec,
    setNote,
  };
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

/** Count how many filters differ from the defaults (for the mobile filter badge). */
export function activeFilterCount(filters: FilterState): number {
  let count = 0;
  if (filters.startDate) count++;
  if (filters.endDate) count++;
  if (filters.modelId) count++;
  if (filters.thinkingLevel) count++;
  if (filters.experimentAssignment) count++;
  if (filters.subagentParentModel) count++;
  if (filters.pruningMode) count++;
  if (filters.pureOnly) count++;
  return count;
}

/** Surface the active-filter count on the collapsed mobile filter summary. */
function updateFiltersActiveCount(filters: FilterState): void {
  const badge = document.getElementById('filters-active-count');
  if (!badge) return;
  const count = activeFilterCount(filters);
  badge.textContent = count > 0 ? String(count) : '';
  badge.hidden = count === 0;
}

function debounce<T extends (...args: never[]) => void>(fn: T, waitMs: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

async function main(): Promise<void> {
  const [manifest, runSummary] = await Promise.all([fetchJson<SiteManifest>('./data/manifest.json'), fetchJson<RunSummaryData>('./data/run-summary.json')]);
  const [overview, toolUsage, pruningImpact, backendErrors, fileExtensions, tokenThroughput, retryTiming, modelLeaderboard, sessionReviewAnalytics, outcomeCorrelations, evidenceReliability] = await Promise.all([
    fetchJson<OverviewData>('./data/overview.json'),
    fetchJson<ToolUsageData>('./data/tool-usage.json'),
    fetchJson<PruningImpactData>('./data/pruning-impact.json'),
    fetchJson<BackendErrorData>('./data/backend-errors.json'),
    fetchJson<FileExtensionData>('./data/file-types.json'),
    fetchJson<TokenThroughputData>('./data/token-throughput.json'),
    fetchJson<RetryTimingData>('./data/retry-timing.json'),
    fetchOptionalJson<ModelLeaderboardData>('./data/model-leaderboard.json'),
    fetchOptionalJson<SessionReviewAnalyticsData>('./data/session-review-analytics.json'),
    fetchOptionalJson<OutcomeCorrelationData>('./data/outcome-correlations.json'),
    fetchOptionalJson<EvidenceReliabilityData>('./data/evidence-reliability.json'),
  ]);
  const data: DashboardData = { manifest, overview, runSummary, toolUsage, pruningImpact, backendErrors, fileExtensions, tokenThroughput, retryTiming, modelLeaderboard: modelLeaderboard ?? createModelLeaderboardFromRuns(runSummary.rows), sessionReviewAnalytics, outcomeCorrelations, evidenceReliability };
  byId('session-review-analytics').innerHTML = sessionReviewAnalyticsHtml(sessionReviewAnalytics);
  renderCohortInsights(data);
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
    updateFiltersActiveCount(filters);
    const filtered = applyFilters(allRuns, filters);
    renderCoverageBanner(filtered);
    renderCards(filtered, overview, JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS));
    await renderCharts(filtered, toolUsage.rows, data, renderToken);
  };
  byId('filters').addEventListener('change', () => void render());
  byId('filter-reset').addEventListener('click', () => { resetFilters(); void render(); });

  // Collapsible filters (mobile): keep the panel open on desktop and let the
  // user collapse it on mobile. Crossing back into desktop re-opens it so the
  // controls are never stranded hidden behind a removed summary.
  const filtersPanel = document.getElementById('filters-panel');
  if (filtersPanel instanceof HTMLDetailsElement) {
    const desktopMq = window.matchMedia('(min-width: 721px)');
    const syncFiltersOpenState = () => { if (desktopMq.matches) filtersPanel.open = true; };
    syncFiltersOpenState();
    desktopMq.addEventListener('change', syncFiltersOpenState);
  }

  // Section jump links: opening a collapsed diagnostics <details> on jump so
  // the user lands on visible content, not a closed summary.
  const sectionNav = document.getElementById('section-nav');
  sectionNav?.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a[href^="#"]');
    const href = anchor?.getAttribute('href');
    if (!href || href === '#') return;
    const target = document.querySelector(href);
    if (target instanceof HTMLDetailsElement && !target.open) target.open = true;
  });

  // Responsive reflow: re-render charts (debounced) when the viewport changes so
  // each chart recomputes its width from its slot and reflows.
  window.addEventListener('resize', debounce(() => void render(), 200));

  await render();
}

if (typeof document !== 'undefined') {
  main().catch((error) => { document.body.innerHTML = `<div class="shell"><section class="panel chart-empty">${escapeHtml(toErrorMessage(error))}</section></div>`; });
}
