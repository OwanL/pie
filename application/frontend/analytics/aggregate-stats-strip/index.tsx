/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { PROVIDER_UNLIMITED_CONCURRENCY } from '../../../lib/protocol/provider-concurrency.js';
import { concurrencySourceLabel } from '../../../../lib/concurrency-config.js';
import type {
  AggregateProductivityStats,
  AggregateProviderCost,
  AggregateSeriesPoint,
  AggregateStats,
  DeferredTriggerView,
  ProviderGateStats,
} from '../../../lib/protocol/index.js';
import { formatCompactTokens } from '../../lib/formatting/format-tokens';
import { cx } from '../../lib/components/cx';
import { StackedAreaChart } from '../stacked-area-chart';
import { colorsFor } from '../chart-colors';
import { MeasuredRow, type StripItem } from './measured-row';

/**
 * Thin status strip anchored at the bottom of the panel (below the composer).
 * Focused on **recent + current** activity over long-term totals:
 *
 *   tdy $X · wk $Y · N open
 *
 * Each segment's tooltip is a **rich** tooltip (JSX rendered into an
 * out-of-tree host via the `Tooltip` component's `contentNode`): the numeric
 * segments (today/week cost, tokens, sessions) carry a
 * small timeseries graph — a stacked-area chart with per-provider bands and a
 * per-model breakdown on hover — while the live-state segments (provider gate)
 * use richly-formatted text. Custom tooltips are used
 * instead of native `title` because the strip re-renders ~7×/sec during
 * streaming — native `title` tooltips close on every re-render and flicker.
 *
 * The strip is kept visually clean: incomplete billing provenance and token
 * coverage gaps are never marked on the numbers (no `*` or `~` suffixes); the
 * accessible labels and the scoped tooltips carry that detail explicitly, and
 * an unknown subtotal is never conflated with a verified zero.
 *
 * Host-owned (STATE_CONTRACT § Webview-Local State): the strip is a pure
 * projection of `ViewState.aggregateStats`; it computes nothing itself.
 */

interface AggregateStatsStripProps {
  stats: AggregateStats;
  snoozedSessionCount?: number;
  deferredTriggers: DeferredTriggerView[];
  onOpenDeferredMenu: (x: number, y: number, triggerEl: HTMLElement) => void;
}

function AggregateStatsStripView({ stats, snoozedSessionCount = 0, deferredTriggers, onOpenDeferredMenu }: AggregateStatsStripProps) {
  const {
    ready,
    todayCost,
    weekCost,
    todayInputTokens,
    todayOutputTokens,
    runningSessionCount,
    openTabCount,
  } = stats;

  const visibleProviders = stats.providerGate.providers.filter((p) =>
    p.activeRequests > 0 && p.maxConcurrentRequests !== PROVIDER_UNLIMITED_CONCURRENCY
    && Number.isFinite(p.maxConcurrentRequests));
  // Reserve ordinary digit growth but measure large values in full. No compact
  // cost rounding: the exact adaptive precision remains available everywhere.
  const number = (value: number, format: (n: number) => string, width: number) => (
    <span class="aggregate-strip-num" style={`min-width:${Math.max(width, format(value).length)}ch`}>{format(value)}</span>
  );
  const items: StripItem[] = [{
    key: 'today', body: <span>tdy {number(todayCost, formatCostAdaptive, 8)}</span>,
    tooltip: todayCostTooltipNode(stats),
    label: `Today's estimated token cost ${formatCostAdaptive(todayCost)}${(stats.billableAccounting?.todayUnknownInvocationCount ?? 0) + (stats.billableAccounting?.todayUnpricedInvocationCount ?? 0) + (stats.billableAccounting?.todayInstrumentationGapInvocationCount ?? 0) > 0 ? '; incomplete billing provenance' : ''}. Focus for today's cost and provider details.`,
    className: 'aggregate-strip-seg--primary aggregate-strip-cost',
  }];
  if (deferredTriggers.length > 0) items.push({
    key: 'deferred', body: <span>⏳ {deferredTriggers.length} wakeup</span>,
    tooltip: deferredTooltipNode(deferredTriggers), className: 'aggregate-strip-deferred',
    label: `${deferredTriggers.length} pending wakeup timer${deferredTriggers.length === 1 ? '' : 's'}. Click to open cancel menu.`,
    onClick: (e) => onOpenDeferredMenu(e.clientX, e.clientY, e.currentTarget as HTMLElement),
  });
  items.push({
    key: 'week', body: <span>wk {number(weekCost, formatCostAdaptive, 8)}</span>,
    tooltip: weekCostTooltipNode(stats),
    label: `Estimated token cost this week ${formatCostAdaptive(weekCost)}${(stats.billableAccounting?.weekUnknownInvocationCount ?? 0) + (stats.billableAccounting?.weekUnpricedInvocationCount ?? 0) + (stats.billableAccounting?.weekInstrumentationGapInvocationCount ?? 0) > 0 ? '; incomplete billing provenance' : ''}. Focus for seven-day cost and provider details.`,
  });
  for (const kind of ['input', 'output'] as const) {
    const value = kind === 'input' ? todayInputTokens : todayOutputTokens;
    items.push({
      key: kind, body: <span>{kind === 'input' ? '↓' : '↑'}{number(value, formatCompactTokens, 5)}</span>,
      tooltip: tokensTooltipNode(stats, kind), className: 'aggregate-strip-tokens',
      label: `Today's ${kind} tokens: ${formatCompactTokens(value)}${(stats.billableAccounting?.todayInstrumentationGapInvocationCount ?? 0) > 0 ? '; known subtotal with incomplete invocation usage' : ''}. Focus for token chart and provider details.`,
    });
  }
  for (const [key, count] of [['open', openTabCount], ['working', runningSessionCount], ['snoozed', snoozedSessionCount]] as const) {
    items.push({key, body: <span>{count} {key}</span>, tooltip: workTooltipNode(stats, snoozedSessionCount),
      label: `${count} ${key}. Focus for 14-day work trend.`});
  }
  if (stats.providerGate.enabled && visibleProviders.length > 0) items.push({
    key: 'providers',
    body: <span>{visibleProviders.map((p) => <span key={p.provider} class={cx('aggregate-strip-provider', p.paused && 'aggregate-strip-provider--paused', !p.paused && p.queuedRequests > 0 && 'aggregate-strip-provider--queued')}>
      <span class="aggregate-strip-provider-name">{p.provider}</span>{' '}
      <span class="aggregate-strip-provider-counts">{p.activeRequests}/{providerLimitLabel(p.maxConcurrentRequests)}</span>
      {p.queuedRequests > 0 && <span class="aggregate-strip-provider-queued">+{p.queuedRequests}</span>}
    </span>)}</span>,
    tooltip: providerGateTooltipNode(stats.providerGate), className: 'aggregate-strip-providers',
    label: `Provider concurrency: ${visibleProviders.map((p) => `${p.provider} ${p.activeRequests} of ${providerLimitLabel(p.maxConcurrentRequests)} active${p.queuedRequests > 0 ? `, ${p.queuedRequests} queued` : ''}${p.paused ? ', paused' : ''}`).join('; ')}. Details also available in Settings.`,
  });
  return <div class={cx('aggregate-strip', !ready && 'aggregate-strip--placeholder')} role="status" aria-label={ariaLabel(stats, snoozedSessionCount)}>
    <MeasuredRow items={items} />
  </div>;
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
  return (prev.stats === next.stats || aggregateStatsSignature(prev.stats) === aggregateStatsSignature(next.stats))
    && (prev.snoozedSessionCount ?? 0) === (next.snoozedSessionCount ?? 0)
    && deferredSignature(prev.deferredTriggers) === deferredSignature(next.deferredTriggers)
    && prev.onOpenDeferredMenu === next.onOpenDeferredMenu;
}

/** Compact membership signature of the active deferred-trigger set, so the
 *  strip skips re-render when the set is unchanged across a fresh host-serialised
 *  `deferredTriggers` array reference (the host re-serialises every snapshot). */
function deferredSignature(t: DeferredTriggerView[]): string {
  return t.map((x) => `${x.id}:${x.sessionPath}:${x.targetSession ?? x.sessionPath}:${x.message?.trim() || x.note}:${x.deliveryState}:${x.recoveryState ?? ''}:${x.deliveryDetail ?? ''}:${x.wakeupMode ?? false}:${x.timerStartedAt ?? ''}`).sort().join(',');
}

function seriesSignature(series: AggregateSeriesPoint[]): string {
  return series.map((point) => [
    point.ms,
    point.byProvider.map((entry) => `${entry.key}:${entry.value}`).join(','),
    point.byModel.map((entry) => `${entry.provider}:${entry.model}:${entry.value}`).join(','),
  ].join(';')).join('/');
}

/** Every rendered productivity field participates; average is derived from the
 *  pooled samples so only the exact inputs are signed. */
function productivitySignature(p: AggregateProductivityStats): string {
  return [
    p.sendCount, p.adjustedUserInputChars, p.knownUserInputCharSampleCount,
    p.expectedUserInputCharSampleCount, p.cappedUserInputCharSampleCount,
    p.userInputCharCap, p.promptCharSamples, p.promptChars,
    p.promptTokenSamples, p.promptTokens, p.inputTokens,
    p.filesystemPathRefCount, p.imageInputCount, p.imageInputBytes,
    p.askUserAnsweredCount, p.askUserCancelledCount, p.askUserTrackedRuns,
  ].join(':');
}

/** Exported for the focused memo-regression test. Every chart point and
 * redistribution-driving breakdown participates; endpoint totals alone are
 * insufficient because interior/provider/model changes alter tooltips. */
export function aggregateStatsSignature(s: AggregateStats): string {
  return [
    s.ready,
    s.todayCost, s.weekCost,
    s.todayInputTokens, s.todayOutputTokens,
    s.todayRunCount, s.todayToolCallCount, s.todayTouchedFileCount, s.weekRunCount,
    s.runningSessionCount, s.openTabCount,
    s.totalCost, s.totalInputTokens, s.totalOutputTokens,
    s.totalCacheReadTokens, s.totalCacheWriteTokens,
    s.runCount, s.sessionCount,
    s.billableAccounting ? [
      s.billableAccounting.invocationCount,
      s.billableAccounting.todayUnknownInvocationCount,
      s.billableAccounting.todayUnpricedInvocationCount,
      s.billableAccounting.todayInstrumentationGapInvocationCount,
      s.billableAccounting.weekUnknownInvocationCount,
      s.billableAccounting.weekUnpricedInvocationCount,
      s.billableAccounting.weekInstrumentationGapInvocationCount,
      s.billableAccounting.unknownInvocationCount,
      s.billableAccounting.unpricedInvocationCount,
      s.billableAccounting.instrumentationGapInvocationCount,
    ].join(':') : '',
    s.costByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.todayCostByProvider.map((p) => `${p.provider}:${p.cost}:${p.inputTokens}:${p.outputTokens}`).join(','),
    s.weekCostByProvider.map((p) => `${p.provider}:${p.cost}:${p.inputTokens}:${p.outputTokens}:${p.cacheReadTokens}:${p.cacheWriteTokens}`).join(','),
    s.dailyCost.map((d) => [
      d.date,
      d.totalCost,
      d.byProvider.map((p) => `${p.provider}:${p.cost}:${p.inputTokens}:${p.outputTokens}:${p.cacheReadTokens}:${p.cacheWriteTokens}`).join(','),
      d.byModel.map((m) => `${m.provider}:${m.model}:${m.cost}`).join(','),
    ].join(';')).join('/'),
    s.dailyRunCount.map((d) => `${d.date}:${d.runCount}`).join(','),
    s.dailyWorkTrend.map((d) => [
      d.date,
      d.sessionsUsed,
      d.peakWorkingSessions,
      productivitySignature(d.productivity),
    ].join(':')).join('/'),
    `${productivitySignature(s.todayProductivity)}#${productivitySignature(s.weekProductivity)}`,
    seriesSignature(s.todayCostSeries),
    seriesSignature(s.todayInputTokenSeries),
    seriesSignature(s.todayTokenSeries),
    seriesSignature(s.weekCostSeries),
    s.providerGate.enabled,
    s.providerGate.providers.map((p) => `${p.provider}:${p.activeRequests}:${p.queuedRequests}:${p.maxConcurrentRequests}:${p.maxConcurrentRequestsSource ?? ''}:${p.afterburnSeconds}:${p.queueWaitSeconds ?? ''}:${p.paused}:${p.pausedUntilMs}:${p.strikeCount}`).join(','),
    s.providerGate.subagentConcurrency ? [
      s.providerGate.subagentConcurrency.scope,
      s.providerGate.subagentConcurrency.configured.value,
      s.providerGate.subagentConcurrency.configured.source,
      s.providerGate.subagentConcurrency.effective?.value ?? '',
      s.providerGate.subagentConcurrency.effective?.source ?? '',
      s.providerGate.subagentConcurrency.workerCount,
      s.providerGate.subagentConcurrency.pendingWorkers,
    ].join(':') : '',
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

/** Character volume is exact only when every expected event in the displayed
 * input-time window has a known numeric length. */
function userInputTrackingKnown(p: AggregateProductivityStats): boolean {
  return p.knownUserInputCharSampleCount >= p.expectedUserInputCharSampleCount;
}

function userInputCharsLabel(p: AggregateProductivityStats): string {
  const chars = formatCompactTokens(p.adjustedUserInputChars);
  return userInputTrackingKnown(p) ? chars : `≥${chars}`;
}

function trimDec(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

/** Local time-of-day for intraday chart axes (`9:30a` / `11:45p`). */
function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`;
}

/** Short local date for daily chart axes (`Jul 4`). */
function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Compact date + time for the granular rolling-week chart. */
function formatDateTimeShort(ms: number): string {
  return `${formatDateShort(ms)} ${formatTimeOfDay(ms)}`;
}

/** Local `YYYY-MM-DD` → ms epoch (local midnight). */
function dateToMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

// ── Rich tooltip building blocks ────────────────────────────────────────────

interface ProviderLegendItem {
  key: string;
  value: string;
  models: { provider: string; model: string; value: string }[];
}

/** Provider legend buttons expose a second, focus-associated tooltip. The
 * detail is a sibling rather than a descendant of the button so its model rows
 * remain in the accessibility tree while the outer rich surface uses a valid
 * non-tooltip role for its interactive controls. */
let providerLegendDetailId = 0;

export function ProviderLegend({ items }: { items: ProviderLegendItem[] }): JSX.Element {
  const colors = colorsFor(items.map((item) => item.key));
  return (
    <div class="rich-tooltip-legend">
      {items.map((it, index) => {
        providerLegendDetailId += 1;
        const detailId = `pie-provider-legend-detail-${providerLegendDetailId}-${index}`;
        return (
          <div class="rich-tooltip-legend-item" key={it.key}>
            <button
              type="button"
              class="rich-tooltip-legend-trigger"
              aria-label={`${it.key} ${it.value}. Focus for model breakdown.`}
              aria-describedby={detailId}
            >
              <span class="rich-tooltip-swatch" style={`background:${colors.get(it.key)}`} />
              <span>{it.key}</span>
              <span class="rich-tooltip-legend-val">{it.value}</span>
            </button>
            <span id={detailId} class="rich-tooltip-legend-detail" role="tooltip">
              <span class="rich-tooltip-legend-detail-head">
                <span>{it.key}</span><span>{it.value}</span>
              </span>
              {it.models.length > 0
                ? it.models.map((model) => (
                    <span class="rich-tooltip-legend-detail-row" key={`${model.provider}\u0000${model.model}`}>
                      <span class="rich-tooltip-legend-detail-model" title={`${model.model} (${model.provider})`}>
                        {model.model} <span class="rich-tooltip-legend-provider">({model.provider})</span>
                      </span>
                      <span class="rich-tooltip-legend-detail-value">{model.value}</span>
                    </span>
                  ))
                : <span class="rich-tooltip-sub">No model detail recorded</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function modelValuesForProvider(
  series: AggregateSeriesPoint[],
  provider: string,
  format: (value: number) => string,
): ProviderLegendItem['models'] {
  const final = series.at(-1);
  if (!final) return [];
  return final.byModel
    .filter((entry) => entry.provider === provider)
    .map((entry) => ({ provider: entry.provider, model: entry.model, value: format(entry.value) }));
}

function providerTokenSummary(providers: AggregateProviderCost[]): string {
  return providers
    .filter((provider) => provider.inputTokens > 0 || provider.outputTokens > 0)
    .map((provider) => `${provider.provider} ↓${formatCompactTokens(provider.inputTokens)} in ↑${formatCompactTokens(provider.outputTokens)} out`)
    .join('  ·  ');
}

function ariaLabel(s: AggregateStats, snoozedSessionCount: number): string {
  if (!s.ready) return 'Usage stats: computing.';
  return `Estimated API-equivalent token cost across all runs today ${formatCostAdaptive(s.todayCost)}. This week ${formatCostAdaptive(s.weekCost)}. `
    + `${s.runningSessionCount} session${s.runningSessionCount === 1 ? '' : 's'} working, ${s.openTabCount} open, ${snoozedSessionCount} snoozed.`;
}

// ── Scoped rich tooltips ────────────────────────────────────────────────────

export function todayCostTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated token cost today</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.todayCost)}</span>
      </div>
      {!!s.billableAccounting && (
        s.billableAccounting.todayUnknownInvocationCount > 0
        || s.billableAccounting.todayUnpricedInvocationCount > 0
        || s.billableAccounting.todayInstrumentationGapInvocationCount > 0
      ) && (
        <div class="rich-tooltip-sub">
          Incomplete billing provenance: {s.billableAccounting.todayUnknownInvocationCount} unknown and{' '}
          {s.billableAccounting.todayUnpricedInvocationCount} unpriced invocation(s) today
          {s.billableAccounting.todayInstrumentationGapInvocationCount > 0
            ? ` (${s.billableAccounting.todayInstrumentationGapInvocationCount} instrumentation gap(s))`
            : ''}.
        </div>
      )}
      <StackedAreaChart points={s.todayCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatTimeOfDay}
        colorKeys={s.todayCostByProvider.map((p) => p.provider)} />
      {s.todayCostByProvider.length > 0 && (
        <ProviderLegend items={s.todayCostByProvider.map((p) => ({
          key: p.provider,
          value: formatCostAdaptive(p.cost),
          models: modelValuesForProvider(s.todayCostSeries, p.provider, formatCostAdaptive),
        }))} />
      )}
    </div>
  );
}

export function weekCostTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const tokenSummary = providerTokenSummary(s.weekCostByProvider);
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated token cost (7d)</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.weekCost)}</span>
      </div>
      {tokenSummary && <div class="rich-tooltip-sub">Token counts by provider · {tokenSummary}</div>}
      {!!s.billableAccounting && (s.billableAccounting.weekUnknownInvocationCount > 0
        || s.billableAccounting.weekUnpricedInvocationCount > 0
        || s.billableAccounting.weekInstrumentationGapInvocationCount > 0) && (
        <div class="rich-tooltip-sub">
          Incomplete billing provenance: {s.billableAccounting.weekUnknownInvocationCount} unknown and{' '}
          {s.billableAccounting.weekUnpricedInvocationCount} unpriced invocation(s)
          {s.billableAccounting.weekInstrumentationGapInvocationCount > 0
            ? ` (${s.billableAccounting.weekInstrumentationGapInvocationCount} instrumentation gap(s))`
            : ''}.
        </div>
      )}
      <StackedAreaChart points={s.weekCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatDateTimeShort}
        colorKeys={s.weekCostByProvider.map((p) => p.provider)} />
      {s.weekCostByProvider.length > 0 && (
        <ProviderLegend items={s.weekCostByProvider.map((p) => ({
          key: p.provider,
          value: formatCostAdaptive(p.cost),
          models: modelValuesForProvider(s.weekCostSeries, p.provider, formatCostAdaptive),
        }))} />
      )}
    </div>
  );
}

export function tokensTooltipNode(s: AggregateStats, initialKind: 'input' | 'output' = 'output'): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return <TokensTooltip stats={s} initialKind={initialKind} />;
}

function TokensTooltip({ stats, initialKind }: { stats: AggregateStats; initialKind: 'input' | 'output' }): JSX.Element {
  const [kind, setKind] = useState<'input' | 'output'>(initialKind);
  const input = kind === 'input';
  const series = input ? stats.todayInputTokenSeries : stats.todayTokenSeries;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Today tokens</span>
        <span class="rich-tooltip-head-value">
          ↓{formatCompactTokens(stats.todayInputTokens)} · ↑{formatCompactTokens(stats.todayOutputTokens)}
        </span>
      </div>
      {(stats.billableAccounting?.todayInstrumentationGapInvocationCount ?? 0) > 0 && (
        <div class="rich-tooltip-sub">
          Known subtotal · {stats.billableAccounting?.todayInstrumentationGapInvocationCount} invocation(s) have incomplete token usage
        </div>
      )}
      <div class="rich-tooltip-toggle" role="group" aria-label="Token chart series">
        <button type="button" aria-pressed={input} onClick={() => setKind('input')}>Input</button>
        <button type="button" aria-pressed={!input} onClick={() => setKind('output')}>Output</button>
      </div>
      <StackedAreaChart points={series} mode="cumulative" formatY={formatCompactTokens} formatX={formatTimeOfDay}
        colorKeys={stats.todayCostByProvider.map((p) => p.provider)} />
      {stats.todayCostByProvider.length > 0 && (
        <ProviderLegend items={stats.todayCostByProvider.map((provider) => ({
          key: provider.provider,
          value: formatCompactTokens(input ? provider.inputTokens : provider.outputTokens),
          models: modelValuesForProvider(series, provider.provider, formatCompactTokens),
        }))} />
      )}
    </div>
  );
}

function providerLimitLabel(maxConcurrentRequests: number): string {
  return maxConcurrentRequests === PROVIDER_UNLIMITED_CONCURRENCY ? '∞' : String(maxConcurrentRequests);
}

function providerGateTooltipNode(g: ProviderGateStats): JSX.Element {
  const lines: string[] = [];
  for (const p of g.providers) {
    let line = `${pad(p.provider, 14)}${p.activeRequests}/${providerLimitLabel(p.maxConcurrentRequests)} active · ${concurrencySourceLabel(p.maxConcurrentRequestsSource)}`;
    if (p.queuedRequests > 0) line += `  · ${p.queuedRequests} queued`;
    if (p.paused) {
      const seconds = Math.max(0, Math.ceil((p.pausedUntilMs - Date.now()) / 1000));
      line += `  · PAUSED (${seconds}s, ${p.strikeCount} strike${p.strikeCount === 1 ? '' : 's'})`;
    } else if (p.maxConcurrentRequests !== PROVIDER_UNLIMITED_CONCURRENCY && p.afterburnSeconds > 0) {
      line += `  · afterburn ${p.afterburnSeconds}s`;
    }
    lines.push(line);
  }
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head"><span>Provider concurrency</span></div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
    </div>
  );
}

/** Series keys for the Work tooltip's dual-series trend chart. The tuple is
 *  shared with the legend so swatches and chart strokes always match. */
const WORK_TREND_SERIES = ['sessions used', 'peak working'] as const;

/** One additive character-volume series: prompts and ask_user answers are
 * already flattened into the daily adjusted total by the host. */
const USER_INPUT_SERIES = ['adjusted chars'] as const;

/** Compact human-readable byte size for attachment summaries. */
function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1_048_576) return `${trimDec(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${trimDec(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Supporting character-volume detail. Filesystem references and images stay
 * distinct because image bytes do not describe generic attachments. */
function userInputDetailsLine(p: AggregateProductivityStats): string {
  const parts = [
    `${p.knownUserInputCharSampleCount}/${p.expectedUserInputCharSampleCount} known`,
    p.userInputCharCap === null
      ? 'P95 cap unavailable'
      : `P95 cap ${formatCompactTokens(p.userInputCharCap)} chars`,
    `${p.cappedUserInputCharSampleCount} capped outlier${p.cappedUserInputCharSampleCount === 1 ? '' : 's'}`,
  ];
  if (!userInputTrackingKnown(p)) parts.push('≥ value is a lower bound');
  if (p.filesystemPathRefCount > 0) {
    parts.push(`${p.filesystemPathRefCount} file ref${p.filesystemPathRefCount === 1 ? '' : 's'}`);
  }
  if (p.imageInputCount > 0) {
    parts.push(`${p.imageInputCount} image${p.imageInputCount === 1 ? '' : 's'} (${formatAttachmentBytes(p.imageInputBytes)})`);
  }
  if (p.filesystemPathRefCount > 0 && p.imageInputCount > 0) {
    parts.push(`${p.filesystemPathRefCount + p.imageInputCount} attachments total`);
  }
  if (p.askUserCancelledCount > 0) {
    parts.push(`${p.askUserCancelledCount} ask${p.askUserCancelledCount === 1 ? '' : 's'} cancelled`);
  }
  return parts.join(' · ');
}

function userInputSummaryNode(label: string, p: AggregateProductivityStats): JSX.Element {
  return (
    <div class="aggregate-strip-user-input-section">
      <div class="rich-tooltip-head">
        <span>{label}</span>
        <span class="rich-tooltip-head-value">{userInputCharsLabel(p)} chars</span>
      </div>
      <div class="rich-tooltip-sub">{userInputDetailsLine(p)}</div>
    </div>
  );
}

function userInputTrendPoints(s: AggregateStats): AggregateSeriesPoint[] {
  return s.dailyWorkTrend.slice(-7).map((day) => ({
    ms: dateToMs(day.date),
    byProvider: [{ key: USER_INPUT_SERIES[0], value: Math.max(0, day.productivity.adjustedUserInputChars) }],
    byModel: [],
  }));
}

/** User-input segment tooltip: one continuous daily adjusted-character line,
 * compact Today/7-day totals, coverage, cap, attachment, and cancellation
 * context. Prompt/answer counts and provider-token prose are intentionally
 * omitted because character volume is the productivity heuristic. */
export function userInputTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head"><span>Adjusted user input</span></div>
      {userInputSummaryNode('Today', s.todayProductivity)}
      {userInputSummaryNode('7-day', s.weekProductivity)}
      <div
        class="aggregate-strip-user-input-trend rich-tooltip-chart-group"
        role="group"
        aria-label="7-day daily adjusted user-input character volume. One continuous line; values use the shared rolling P95 cap."
      >
        <StackedAreaChart
          points={userInputTrendPoints(s)}
          mode="line"
          formatY={formatCompactTokens}
          formatX={formatDateShort}
          colorKeys={[...USER_INPUT_SERIES]}
        />
      </div>
      <div class="rich-tooltip-sub aggregate-strip-user-input-note">
        Prompt and answered ask_user characters, adjusted by the rolling 14-day P95 cap. ≥ marks incomplete legacy or malformed-answer coverage.
      </div>
    </div>
  );
}

/** Work segment tooltip: current state (working/open) in the header, the
 *  14-day dual-series work trend (sessions used vs peak concurrently working —
 *  historical run evidence, never open-tab history). */
/** Exported for the focused Work-tooltip render test. */
export function workTooltipNode(s: AggregateStats, snoozedSessionCount = 0): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const trendPoints: AggregateSeriesPoint[] = s.dailyWorkTrend.map((d) => ({
    ms: dateToMs(d.date),
    byProvider: [
      { key: WORK_TREND_SERIES[0], value: d.sessionsUsed },
      { key: WORK_TREND_SERIES[1], value: d.peakWorkingSessions },
    ],
    byModel: [],
  }));
  const colors = colorsFor([...WORK_TREND_SERIES]);
  const latest = s.dailyWorkTrend.at(-1);
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>{s.runningSessionCount} working</span>
        <span class="rich-tooltip-head-value">{s.openTabCount} open · {snoozedSessionCount} snoozed</span>
      </div>
      <div
        class="rich-tooltip-chart-group"
        role="group"
        aria-label="14-day work trend: daily distinct sessions used and peak concurrently working sessions. Open-tab history is not tracked."
      >
        <StackedAreaChart points={trendPoints} mode="line" formatY={(n) => String(Math.round(n))} formatX={formatDateShort}
          colorKeys={[...WORK_TREND_SERIES]} />
      </div>
      <div class="rich-tooltip-legend">
        {WORK_TREND_SERIES.map((key, index) => (
          <span class="rich-tooltip-legend-item" key={key}>
            <span class="rich-tooltip-swatch" style={`background:${colors.get(key)}`} />
            <span>{key}</span>
            <span class="rich-tooltip-legend-val">{index === 0 ? (latest?.sessionsUsed ?? 0) : (latest?.peakWorkingSessions ?? 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Tooltip for the waiting-trigger segment: one line per active trigger
 *  (target + condition + message), so the user can preview before opening the
 *  cancel popup. */
function deferredTooltipNode(triggers: DeferredTriggerView[]): JSX.Element {
  const lines: string[] = [`${triggers.length} pending — click to cancel`, ''];
  for (const t of triggers) {
    const targetPath = t.targetSession ?? t.sessionPath;
    const message = (t.message?.trim() || t.note.trim()) || '(no message)';
    const waitingForResponse = t.deliveryState === 'pending' && t.wakeupMode === true
      && !t.timerStartedAt && t.triggers.some((spec) => spec.kind === 'timer');
    const status = t.deliveryState === 'pending' ? '' : ` [${t.deliveryState}]`;
    if (waitingForResponse) lines.push('Waiting for response to finish');
    const head = `${targetPath.split(/[\\/]/).pop() ?? targetPath}${status}: ${message}`;
    lines.push(head.length > 80 ? `${head.slice(0, 77)}…` : head);
  }
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head"><span>Wakeup timers</span><span class="rich-tooltip-head-value">{triggers.length}</span></div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
    </div>
  );
}
