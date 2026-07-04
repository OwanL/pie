/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

import type { AggregateStats, AggregateLastRun } from '../../../shared/protocol';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';

/**
 * Thin status strip anchored at the bottom of the panel (below the composer).
 * Focused on **recent + current** activity over long-term totals:
 *
 *   today $X · wk $Y · tok/s (live when running, else today's mean) · N tabs
 *
 * Per-provider breakdowns and all-time context live in each segment's scoped
 * `title` tooltip rather than dedicated inline chips, so the strip itself stays
 * a single thin line.
 *
 * Host-owned (STATE_CONTRACT § Webview-Local State): the strip is a pure
 * projection of `ViewState.aggregateStats`; it computes nothing itself.
 */

interface AggregateStatsStripProps {
  stats: AggregateStats;
}

function AggregateStatsStripView({ stats }: AggregateStatsStripProps) {
  const {
    ready,
    todayCost,
    weekCost,
    todayInputTokens,
    todayOutputTokens,
    todayTokensPerSecond,
    tokensPerSecond,
    liveTokensPerSecond,
    runningSessionCount,
    openTabCount,
    lastRun,
  } = stats;

  // Throughput headline: live when running, else today's mean, else all-time
  // mean (label-agnostic inline; the tooltip distinguishes the source).
  const running = runningSessionCount > 0;
  const headlineRate = running
    ? liveTokensPerSecond
    : (todayTokensPerSecond > 0 ? todayTokensPerSecond : tokensPerSecond);
  const rateSource = running
    ? 'live'
    : (todayTokensPerSecond > 0 ? 'today' : (tokensPerSecond > 0 ? 'all-time' : 'none'));

  return (
    <div
      class={cx('aggregate-strip', !ready && 'aggregate-strip--placeholder')}
      role="status"
      aria-label={ariaLabel(stats)}
    >
      <span
        class="aggregate-strip-seg aggregate-strip-seg--primary"
        title={todayTooltip(stats)}
      >
        today <span class="aggregate-strip-cost">{formatCostAdaptive(todayCost)}</span>
      </span>
      <Sep />
      <span class="aggregate-strip-seg" title={weekTooltip(stats)}>
        wk <span class="aggregate-strip-cost">{formatCostAdaptive(weekCost)}</span>
      </span>
      <Sep />
      <span class="aggregate-strip-seg aggregate-strip-tokens" title={todayTooltip(stats)}>
        <span class="aggregate-strip-tok-down">↓{formatCompactTokens(todayInputTokens)}</span>
        {' '}<span class="aggregate-strip-tok-up">↑{formatCompactTokens(todayOutputTokens)}</span>
      </span>
      <Sep />
      <span class="aggregate-strip-seg" title={throughputTooltip(stats, rateSource)}>
        {rateSource === 'live' && <span class="aggregate-strip-live-tag">live</span>}
        {rateSource === 'none'
          ? <span class="aggregate-strip-rate">—</span>
          : <span class="aggregate-strip-rate">{formatRate(headlineRate)}</span>}
        <span class="aggregate-strip-unit"> tok/s</span>
      </span>
      {lastRun && (
        <>
          <Sep />
          <span class="aggregate-strip-seg" title={lastRunTooltip(lastRun)}>
            last <span class="aggregate-strip-cost">{formatCostAdaptive(lastRun.cost)}</span>
            <span class="aggregate-strip-dur">{formatDuration(lastRun.durationMs)}</span>
          </span>
        </>
      )}
      <Sep />
      <span class="aggregate-strip-seg aggregate-strip-counts" title={sessionsTooltip(stats)}>
        {openTabCount} tab{openTabCount === 1 ? '' : 's'}
        {running && (
          <span class="aggregate-strip-active">
            {' · '}
            <span class="aggregate-strip-active-dot" aria-hidden="true" />
            {runningSessionCount} active
          </span>
        )}
      </span>
    </div>
  );
}

function Sep() {
  return <span class="aggregate-strip-sep" aria-hidden="true">·</span>;
}

export const AggregateStatsStrip = memo(AggregateStatsStripView, arePropsEqual);

/** VS Code `postMessage` structured-clones the ViewState on every snapshot
 *  post, so `stats` is a fresh object reference even when content is identical.
 *  A plain `memo()` (ref equality) would re-render the strip — and rebuild the
 *  scoped tooltips — on every debounced post during streaming (~7×/sec).
 *  Compare a compact content signature instead so the strip skips re-render
 *  when nothing perceptibly changed. */
function arePropsEqual(
  prev: AggregateStatsStripProps,
  next: AggregateStatsStripProps,
): boolean {
  return prev.stats === next.stats || statsSignature(prev.stats) === statsSignature(next.stats);
}

function statsSignature(s: AggregateStats): string {
  return [
    s.ready,
    s.todayCost, s.weekCost,
    s.todayInputTokens, s.todayOutputTokens,
    s.todayTokensPerSecond, s.tokensPerSecond, s.liveTokensPerSecond,
    s.todayRunCount, s.todayToolCallCount, s.todayTouchedFileCount, s.weekRunCount,
    s.runningSessionCount, s.openTabCount,
    s.totalCost, s.totalInputTokens, s.totalOutputTokens,
    s.totalCacheReadTokens, s.totalCacheWriteTokens,
    s.runCount, s.sessionCount,
    s.costByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.todayCostByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.weekCostByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.dailyCost.map((d) => `${d.date}:${d.totalCost}`).join(','),
    s.tokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.todayTokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.lastRun ? `${s.lastRun.cost}:${s.lastRun.durationMs}:${s.lastRun.endedAt}:${s.lastRun.modelId}` : '',
  ].join('|');
}

// ── Formatters ──────────────────────────────────────────────────────────────

/** Adaptive USD: 4 fraction digits below $1 (today's sub-cent spend matters),
 *  2 above (week totals get noisy at 4). Matches the per-session detail's
 *  sub-cent precision where it counts. */
function formatCostAdaptive(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** tok/s: round when ≥10, one decimal below (matches `formatRate` in token-rate). */
function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(1);
}

/** Compact duration: `45s` / `1.2m` / `2.3h` (0 → `0s`). */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${trimDec(min)}m`;
  const hr = min / 60;
  return `${trimDec(hr)}h`;
}

function trimDec(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

// ── Scoped tooltips ─────────────────────────────────────────────────────────

function ariaLabel(s: AggregateStats): string {
  if (!s.ready) return 'Usage stats: computing.';
  return `Today ${formatCostAdaptive(s.todayCost)}. This week ${formatCostAdaptive(s.weekCost)}. `
    + `${s.openTabCount} open tabs, ${s.runningSessionCount} running.`;
}

function todayTooltip(s: AggregateStats): string {
  if (!s.ready) return 'Computing usage stats…';
  const lines: string[] = [`Today: ${formatCostAdaptive(s.todayCost)}  ·  ${s.todayRunCount} run${s.todayRunCount === 1 ? '' : 's'}`];
  if (s.todayInputTokens > 0 || s.todayOutputTokens > 0) {
    lines.push(`Tokens: ↓${formatCompactTokens(s.todayInputTokens)} in  ↑${formatCompactTokens(s.todayOutputTokens)} out`);
  }
  if (s.todayToolCallCount > 0 || s.todayTouchedFileCount > 0) {
    lines.push(`Activity: ${s.todayToolCallCount} tool call${s.todayToolCallCount === 1 ? '' : 's'} · ${s.todayTouchedFileCount} file${s.todayTouchedFileCount === 1 ? '' : 's'} touched`);
  }
  if (s.todayCostByProvider.length > 0) {
    lines.push('Cost by provider:');
    for (const e of s.todayCostByProvider) {
      lines.push(`  ${pad(e.provider, 14)}${formatCostAdaptive(e.cost)}  (↑${formatCompactTokens(e.outputTokens)} ↓${formatCompactTokens(e.inputTokens)})`);
    }
  }
  lines.push('');
  lines.push(`All-time: ${formatCostAdaptive(s.totalCost)}  ·  ${s.runCount} runs · ${s.sessionCount} sessions`);
  return lines.join('\n');
}

function weekTooltip(s: AggregateStats): string {
  if (!s.ready) return 'Computing usage stats…';
  const lines: string[] = [`This week (7d): ${formatCostAdaptive(s.weekCost)}  ·  ${s.weekRunCount} run${s.weekRunCount === 1 ? '' : 's'}`];
  if (s.weekCostByProvider.length > 0) {
    lines.push('By provider:');
    for (const e of s.weekCostByProvider) {
      lines.push(`  ${pad(e.provider, 14)}${formatCostAdaptive(e.cost)}`);
    }
  }
  // Last 7 days of the 14-day series (most recent first for skimming).
  const recent = s.dailyCost.slice(-7).reverse();
  if (recent.length > 0) {
    lines.push('');
    lines.push('Daily:');
    for (const d of recent) {
      lines.push(`  ${d.date}  ${formatCostAdaptive(d.totalCost)}`);
    }
  }
  return lines.join('\n');
}

function throughputTooltip(s: AggregateStats, source: 'live' | 'today' | 'all-time' | 'none'): string {
  if (!s.ready) return 'Computing usage stats…';
  const lines: string[] = [];
  if (s.runningSessionCount > 0) {
    lines.push(`Live: ${formatRate(s.liveTokensPerSecond)} tok/s across ${s.runningSessionCount} running session${s.runningSessionCount === 1 ? '' : 's'}`);
  }
  if (s.todayTokensPerSecond > 0) {
    lines.push('');
    lines.push(`Today: ${formatRate(s.todayTokensPerSecond)} tok/s (generation-weighted)`);
    for (const e of s.todayTokensPerSecondByProvider) {
      lines.push(`  ${pad(e.provider, 14)}${formatRate(e.tokensPerSecond)} tok/s  (${formatCompactTokens(e.outputTokens)} / ${(e.generationDurationMs / 1000).toFixed(1)}s)`);
    }
  }
  if (s.tokensPerSecond > 0) {
    lines.push('');
    lines.push(`All-time: ${formatRate(s.tokensPerSecond)} tok/s`);
    for (const e of s.tokensPerSecondByProvider) {
      lines.push(`  ${pad(e.provider, 14)}${formatRate(e.tokensPerSecond)} tok/s  (${formatCompactTokens(e.outputTokens)} / ${(e.generationDurationMs / 1000).toFixed(1)}s)`);
    }
  }
  if (lines.length === 0) {
    lines.push(source === 'none' ? 'No throughput recorded yet.' : 'Measuring…');
  }
  return lines.join('\n');
}

function lastRunTooltip(r: AggregateLastRun): string {
  const lines: string[] = [`Last run: ${formatCostAdaptive(r.cost)}  ·  ${formatDuration(r.durationMs)}`];
  if (r.modelId) {
    lines.push(`Model: ${r.modelId}  (${r.provider})`);
  } else {
    lines.push(`Provider: ${r.provider}`);
  }
  lines.push(`Tokens: ↓${formatCompactTokens(r.inputTokens)} in  ↑${formatCompactTokens(r.outputTokens)} out`);
  if (r.outcome) {
    lines.push(`Outcome: ${r.outcome.resolution.replace('_', ' ')}  ·  satisfaction ${r.outcome.satisfaction}`);
  } else {
    lines.push('Outcome: unscored');
  }
  lines.push(`${r.startedAt} → ${r.endedAt}`);
  return lines.join('\n');
}

function sessionsTooltip(s: AggregateStats): string {
  if (!s.ready) return 'Computing usage stats…';
  const lines: string[] = [
    `${s.openTabCount} open tab${s.openTabCount === 1 ? '' : 's'}`,
    `${s.runningSessionCount} running`,
    `${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'} (all-time)`,
  ];
  lines.push('');
  lines.push(`All-time tokens: ↓${formatCompactTokens(s.totalInputTokens)} in  ↑${formatCompactTokens(s.totalOutputTokens)} out`);
  lines.push(`  cache ${formatCompactTokens(s.totalCacheReadTokens)} read / ${formatCompactTokens(s.totalCacheWriteTokens)} write`);
  lines.push(`${s.runCount} runs (all-time)`);
  return lines.join('\n');
}
