/**
 * Shared infrastructure for the analytics dashboard.
 *
 * Part of the chart-registry refactor: per-domain chart modules
 * (`charts/*.ts`) import pure helpers, colors, and the registry types from
 * here, and receive `renderSpec` / `setNote` (which stay single-sourced in
 * `app.ts`, including the active-render-token state) via `ChartContext`.
 *
 * Pure helpers are duplicated from `app.ts` intentionally: they are stateless,
 * so duplication carries no correctness risk, and avoiding surgery on the
 * existing 29 working charts keeps the refactor low-risk. (De-duplicating the
 * pure helpers by importing them into `app.ts` is a safe follow-up.)
 */
import type {
  BackendErrorData,
  EvidenceReliabilityData,
  FileExtensionData,
  OutcomeCorrelationData,
  PreparedRetryTimingRow,
  PreparedRunRow,
  PreparedToolUsageRow,
  PreparedTurnThroughputRow,
  PruningImpactData,
  ReviewJoinUnmatchedReason,
} from '../scripts/contracts.ts';
import { meanDifferenceInterval, meanInterval, wilsonInterval } from './chart-stats.ts';
import { toErrorMessage } from '../../shared/error-message.js';

export { meanDifferenceInterval, meanInterval, wilsonInterval };

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

export type ChartRenderer = 'svg' | 'canvas';

export type RenderSpecFn = (
  targetId: string,
  spec: Record<string, unknown> | null,
  emptyMessage: string,
  renderToken: number,
  renderer?: ChartRenderer,
) => Promise<void>;

export type SetNoteFn = (id: string, text: string, renderToken: number) => void;

/** Context handed to every chart entry's render function. */
export interface ChartContext {
  /** Runs after global filters have been applied. */
  runs: PreparedRunRow[];
  /** All tool-usage rows (filter to ctx.runs via runId when needed). */
  toolRows: PreparedToolUsageRow[];
  /** All per-turn throughput rows (filter to ctx.runs via runId when needed). */
  turnThroughputRows: PreparedTurnThroughputRow[];
  /** All per-attempt retry timing rows (filter to ctx.runs via runId when needed). */
  retryTimingRows: PreparedRetryTimingRow[];
  /** Token used to abort superseded renders. */
  renderToken: number;
  pruning: PruningImpactData;
  backendErrors: BackendErrorData;
  fileExtensions: FileExtensionData;
  /** Observational qualityIndexV1 associations across reviewed sessions (cohort-level). */
  outcomeCorrelations: OutcomeCorrelationData | null;
  /** Evidence-reliability diagnostics that qualify qualityIndexV1-based recommendations. */
  evidenceReliability: EvidenceReliabilityData | null;
  /** Render a Vega-Lite spec into a slot (single-sourced in app.ts). */
  renderSpec: RenderSpecFn;
  /** Set a chart's note caption (single-sourced in app.ts). */
  setNote: SetNoteFn;
}

export interface ChartEntry {
  /** DOM id of the chart slot (`<div id="chart-...">`). */
  id: string;
  /** Render this chart into its slot. Should be resilient to empty data. */
  render: (ctx: ChartContext) => Promise<void>;
}

export const CHART_COLORS = {
  accent: '#8de3ff',
  accent2: '#c0ff72',
  coral: '#ff8578',
  gold: '#ffd479',
  success: '#59e17f',
  text: '#f6f1e8',
  muted: '#b9b1a3',
  grid: 'rgba(255,255,255,0.05)',
};

/**
 * Extended categorical palette for model-family color scales. The first five
 * entries are the brand accents; the rest are supplementary distinguishable
 * hues so charts with more than five model families no longer collide. All
 * entries are light/bright enough for readable contrast on the dark panels.
 */
export const MODEL_PALETTE = [
  '#8de3ff', // accent (cyan)
  '#c0ff72', // accent2 (green)
  '#ffd479', // gold
  '#ff8578', // coral
  '#59e17f', // success
  '#b9a3ff', // violet
  '#ff9ec7', // pink
  '#7fd4ff', // sky
  '#ffe08a', // pale gold
  '#a3ffeb', // mint
  '#ffac6b', // orange
  '#d4b3ff', // lavender
];

/**
 * A categorical color scale for model-family series. Uses the extended brand
 * palette so more than five families remain distinguishable; falls back to a
 * 20-color scheme only when a cohort exceeds the palette (rare).
 */
export function modelColorScale(models?: readonly string[]): { range: string[] } | { scheme: string } {
  const count = models?.length ?? 0;
  if (count > MODEL_PALETTE.length) {
    return { scheme: 'tableau20' };
  }
  return { range: MODEL_PALETTE };
}

export const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

export function median(values: number[]): number | null {
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

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower] ?? null;
  }
  return (sorted[lower]! * (1 - (index - lower))) + (sorted[upper]! * (index - lower));
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function percentage(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function formatUsd(value: number | null): string {
  if (value === null) {
    return '—';
  }
  if (value > 0 && value < 0.01) {
    return `<$0.01`;
  }
  return `$${Math.round(value * 100) / 100}`;
}

export function formatUsdPrecise(value: number | null): string {
  if (value === null) {
    return '—';
  }
  return `$${value.toFixed(4)}`;
}

export function normalizeThinkingLevel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'max') {
    return 'xhigh';
  }
  return normalized;
}

export function formatThinkingLevelLabel(value: string): string {
  return value === 'xhigh' ? 'max' : value;
}

export function sortNatural(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

export function sortThinkingLevels(values: string[]): string[] {
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

export function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];
}

export function completedRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return runs.filter((run) => run.status !== 'open');
}

export function selectedCompletedRuns(runs: PreparedRunRow[]): PreparedRunRow[] {
  return completedRuns(runs);
}

export function selectedRunIds(runs: PreparedRunRow[]): Set<string> {
  return new Set(runs.map((run) => run.runId));
}

/** Canonical provider-agnostic key used by every model-grouped chart. */
export function modelFamilyKey(model: { modelFamily?: string | null; modelId?: string | null }): string {
  return model.modelFamily?.trim() || model.modelId?.trim() || '(unknown)';
}

/** Complete total run cost; parent-only estimates are never substituted for unknown totals. */
export function estimatedRunCostUsd(
  run: Pick<PreparedRunRow, 'totalEstimatedCostUsd'>,
): number | null {
  return typeof run.totalEstimatedCostUsd === 'number' && Number.isFinite(run.totalEstimatedCostUsd)
    ? run.totalEstimatedCostUsd
    : null;
}

/** A short, stable label for a model/thinking cell in categorical charts. */
export function modelAxisLabel(modelId: string | null, thinkingLevel: string | null | undefined): string {
  const model = modelId?.trim() || '(unknown)';
  const thinking = normalizeThinkingLevel(thinkingLevel);
  if (!thinking || thinking === 'off') {
    return model;
  }
  return `${model} · ${formatThinkingLevelLabel(thinking)}`;
}

/** Height for a categorical (bar) chart with `rowCount` entries. */
export function categoricalHeight(rowCount: number, rowHeight = 30, min = 260, max = 560): number {
  return Math.min(max, Math.max(min, rowCount * rowHeight));
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Concise friendly label + precise description for a review↔run unmatched
 * reason. The label is what the user sees; the description retains the exact
 * meaning (why the review could not be joined) and is exposed via a `title`
 * attribute in the rendered HTML. The underlying data identifiers
 * (`no_run_for_identity` / `identity_conflict_at_path`) are never shown raw.
 */
export interface JoinUnmatchedReasonLabel {
  label: string;
  description: string;
}

/** Canonical display order for the two unmatched reasons. */
export const JOIN_UNMATCHED_REASONS: readonly ReviewJoinUnmatchedReason[] = [
  'no_run_for_identity',
  'identity_conflict_at_path',
];

const JOIN_UNMATCHED_REASON_LABELS: Record<ReviewJoinUnmatchedReason, JoinUnmatchedReasonLabel> = {
  no_run_for_identity: {
    label: 'No run found',
    description: 'No run in the export carries the review\u2019s stable session identity, and no run sits at the review\u2019s exact normalized session path \u2014 the reviewed session is absent from this export.',
  },
  identity_conflict_at_path: {
    label: 'Identity conflict',
    description: 'A run exists at the review\u2019s exact normalized session path but is attributed to a different session identity; joining would risk a false attribution, so the review is deliberately left unmatched.',
  },
};

/** Friendly label + precise description for an unmatched reason. */
export function joinUnmatchedReasonLabel(reason: ReviewJoinUnmatchedReason): JoinUnmatchedReasonLabel {
  return JOIN_UNMATCHED_REASON_LABELS[reason];
}

/**
 * Render the unmatched-by-reason breakdown as accessible HTML: each reason
 * shows a concise friendly label with its precise meaning exposed via the
 * `title` attribute (hover/focus tooltip). Counts are data and are unchanged.
 */
export function renderJoinUnmatchedReasonsHtml(
  unmatchedByReason: Record<ReviewJoinUnmatchedReason, number>,
): string {
  return JOIN_UNMATCHED_REASONS.map((reason) => {
    const { label, description } = joinUnmatchedReasonLabel(reason);
    return `<abbr class="join-reason" title="${escapeHtml(description)}">${escapeHtml(label)}</abbr>: ${unmatchedByReason[reason]}`;
  }).join(' \u00b7 ');
}

/**
 * Plain-text rendering of the same breakdown (for contexts that escape their
 * output and cannot carry HTML, e.g. insight-card evidence lines). Uses the
 * friendly labels; the precise per-reason meaning remains available in the
 * parallel HTML reliability card and the contracts.
 */
export function renderJoinUnmatchedReasonsText(
  unmatchedByReason: Record<ReviewJoinUnmatchedReason, number>,
): string {
  return JOIN_UNMATCHED_REASONS.map((reason) => {
    const { label } = joinUnmatchedReasonLabel(reason);
    return `${label}: ${unmatchedByReason[reason]}`;
  }).join(' \u00b7 ');
}

/**
 * Run chart entries with bounded concurrency, isolating failures so one bad
 * chart doesn't abort the rest of the render pass. Bounded parallelism keeps
 * the dashboard responsive on cohorts with many charts without spiking memory
 * by embedding every Vega view at once.
 */
export async function renderChartEntries(entries: ChartEntry[], ctx: ChartContext): Promise<void> {
  const concurrency = Math.min(6, Math.max(1, entries.length));
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor]!;
      cursor += 1;
      try {
        await entry.render(ctx);
      } catch (error) {
        const target = document.getElementById(entry.id);
        if (target) {
          const message = toErrorMessage(error);
          target.innerHTML = `<div class="chart-empty">Unable to render chart: ${escapeHtml(message)}</div>`;
        }
        console.warn(`[pie-analysis] chart ${entry.id} failed:`, error);
      }
    }
  });
  await Promise.all(workers);
}
