/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

import type { AggregateStats, AggregateProviderCost } from '../../../shared/protocol';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';

/**
 * Thin status strip anchored at the bottom of the panel (below the composer).
 * Shows aggregate usage across ALL sessions — total cost with a per-provider
 * breakdown, today's spend, generation throughput (mean tok/s) with a
 * per-provider breakdown, live aggregate tok/s, token totals, and run/session
 * counts. The full breakdown (daily per-provider series, per-provider tokens,
 * per-provider throughput) is in the `title` tooltip so the strip itself stays
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
    totalCost,
    todayCost,
    costByProvider,
    tokensPerSecond,
    liveTokensPerSecond,
    runningSessionCount,
    totalInputTokens,
    totalOutputTokens,
    runCount,
    sessionCount,
    ready,
  } = stats;

  // Top providers for inline chips (cap to keep the strip thin; the tooltip
  // carries the full list).
  const inlineProviders = costByProvider.slice(0, 4);
  const hiddenProviderCount = Math.max(0, costByProvider.length - inlineProviders.length);

  return (
    <div
      class={cx('aggregate-strip', !ready && 'aggregate-strip--placeholder')}
      role="status"
      aria-label={ariaLabel(stats)}
      title={tooltip(stats)}
    >
      <span class="aggregate-strip-seg aggregate-strip-seg--primary">
        Σ <span class="aggregate-strip-cost">{formatCost4(totalCost)}</span>
      </span>
      <Sep />
      <span class="aggregate-strip-seg">
        today <span class="aggregate-strip-cost">{formatCost4(todayCost)}</span>
      </span>
      {inlineProviders.length > 0 && (
        <>
          <Sep />
          <span class="aggregate-strip-providers">
            {inlineProviders.map((entry) => (
              <span key={entry.provider} class="aggregate-strip-provider-chip">
                <span class="aggregate-strip-provider-name">{entry.provider}</span>
                {' '}
                <span class="aggregate-strip-cost">{formatCost4(entry.cost)}</span>
              </span>
            ))}
            {hiddenProviderCount > 0 && (
              <span class="aggregate-strip-provider-chip aggregate-strip-provider-more">
                +{hiddenProviderCount}
              </span>
            )}
          </span>
        </>
      )}
      <Sep />
      <span class="aggregate-strip-seg">
        <span class="aggregate-strip-rate">{formatRate(tokensPerSecond)}</span>
        <span class="aggregate-strip-unit"> tok/s</span>
        {runningSessionCount > 0 && (
          <span class="aggregate-strip-live">
            {' · live '}
            <span class="aggregate-strip-rate">{formatRate(liveTokensPerSecond)}</span>
          </span>
        )}
      </span>
      <Sep />
      <span class="aggregate-strip-seg aggregate-strip-tokens">
        <span class="aggregate-strip-tok-down">↓{formatCompactTokens(totalInputTokens)}</span>
        {' '}
        <span class="aggregate-strip-tok-up">↑{formatCompactTokens(totalOutputTokens)}</span>
      </span>
      <Sep />
      <span class="aggregate-strip-seg aggregate-strip-counts">
        {sessionCount} sess · {runCount} run{runCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function Sep() {
  return <span class="aggregate-strip-sep" aria-hidden="true">·</span>;
}

export const AggregateStatsStrip = memo(AggregateStatsStripView, arePropsEqual);

/** VS Code `postMessage` structured-clones the ViewState on every snapshot
 *  post, so `stats` is a fresh object reference even when content is
 *  identical. A plain `memo()` (ref equality) would re-render the strip — and
 *  rebuild the heavy multi-line tooltip (14-day × per-provider iteration) — on
 *  every debounced post during streaming (~7×/sec). Compare a compact content
 *  signature instead so the strip skips re-render when nothing perceptibly
 *  changed. */
function arePropsEqual(
  prev: AggregateStatsStripProps,
  next: AggregateStatsStripProps,
): boolean {
  return prev.stats === next.stats || statsSignature(prev.stats) === statsSignature(next.stats);
}

function statsSignature(s: AggregateStats): string {
  return [
    s.ready,
    s.totalCost, s.todayCost,
    s.tokensPerSecond, s.liveTokensPerSecond,
    s.totalInputTokens, s.totalOutputTokens, s.totalCacheReadTokens, s.totalCacheWriteTokens,
    s.runCount, s.sessionCount, s.runningSessionCount,
    s.costByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.todayCostByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.dailyCost.map((d) => `${d.date}:${d.totalCost}`).join(','),
    s.tokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}:${p.outputTokens}`).join(','),
  ].join('|');
}

// ── Formatters ──────────────────────────────────────────────────────────────

/** 4-fraction-digit USD (matches the per-session cost detail convention). */
function formatCost4(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.0000';
  return `$${n.toFixed(4)}`;
}

/** tok/s: round when ≥10, one decimal below (matches `formatRate` in token-rate). */
function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10) return String(Math.round(n));
  return n.toFixed(1);
}

// ── Tooltip + aria ──────────────────────────────────────────────────────────

function ariaLabel(s: AggregateStats): string {
  if (!s.ready) return 'Aggregate stats: computing.';
  return `Total cost ${formatCost4(s.totalCost)}. Today ${formatCost4(s.todayCost)}. `
    + `${formatRate(s.tokensPerSecond)} tokens per second average. `
    + `${s.runCount} runs across ${s.sessionCount} sessions.`;
}

function tooltip(s: AggregateStats): string {
  if (!s.ready) return 'Computing aggregate stats…';
  const lines: string[] = [];
  lines.push('Aggregate across all sessions');
  lines.push(`Total: ${formatCost4(s.totalCost)}  (today ${formatCost4(s.todayCost)})`);
  lines.push('');

  if (s.costByProvider.length > 0) {
    lines.push('Cost by provider:');
    for (const entry of s.costByProvider) {
      lines.push(`  ${pad(entry.provider, 14)}${formatCost4(entry.cost)}  (↑${formatCompactTokens(entry.outputTokens)} ↓${formatCompactTokens(entry.inputTokens)})`);
    }
    lines.push('');
  }

  if (s.todayCostByProvider.length > 0) {
    lines.push('Today by provider:');
    for (const entry of s.todayCostByProvider) {
      lines.push(`  ${pad(entry.provider, 14)}${formatCost4(entry.cost)}`);
    }
    lines.push('');
  }

  if (s.dailyCost.length > 0) {
    lines.push(`Last ${s.dailyCost.length} days:`);
    for (const day of s.dailyCost) {
      const providers = day.byProvider.length > 1
        ? `  [${day.byProvider.map((p) => `${p.provider} ${formatCost4(p.cost)}`).join(', ')}]`
        : '';
      lines.push(`  ${day.date}  ${formatCost4(day.totalCost)}${providers}`);
    }
    lines.push('');
  }

  if (s.tokensPerSecondByProvider.length > 0) {
    lines.push('Throughput (generation-weighted, completed turns):');
    lines.push(`  ${pad('overall', 14)}${formatRate(s.tokensPerSecond)} tok/s`);
    for (const entry of s.tokensPerSecondByProvider) {
      lines.push(`  ${pad(entry.provider, 14)}${formatRate(entry.tokensPerSecond)} tok/s  (${formatCompactTokens(entry.outputTokens)} out / ${(entry.generationDurationMs / 1000).toFixed(1)}s, ${entry.sampleCount} samples)`);
    }
    lines.push('');
  }

  if (s.runningSessionCount > 0) {
    lines.push(`Live: ${formatRate(s.liveTokensPerSecond)} tok/s across ${s.runningSessionCount} running session${s.runningSessionCount === 1 ? '' : 's'}`);
    lines.push('');
  }

  lines.push(
    `Tokens: ↓${formatCompactTokens(s.totalInputTokens)} in  ↑${formatCompactTokens(s.totalOutputTokens)} out  `
    + `(cache ${formatCompactTokens(s.totalCacheReadTokens)} read / ${formatCompactTokens(s.totalCacheWriteTokens)} write)`,
  );
  lines.push(`Runs: ${s.runCount}   Sessions: ${s.sessionCount}   Running: ${s.runningSessionCount}`);
  return lines.join('\n');
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

export type { AggregateProviderCost };
