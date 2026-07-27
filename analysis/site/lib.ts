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
  FileExtensionData,
  PreparedRetryTimingRow,
  PreparedRunRow,
  PreparedToolUsageRow,
  PreparedTurnThroughputRow,
  PruningImpactData,
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

export type RenderSpecFn = (
  targetId: string,
  spec: Record<string, unknown> | null,
  emptyMessage: string,
  renderToken: number,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Run a sequence of chart entries, isolating failures so one bad chart doesn't
 * abort the rest of the render pass.
 */
export async function renderChartEntries(entries: ChartEntry[], ctx: ChartContext): Promise<void> {
  for (const entry of entries) {
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
}
