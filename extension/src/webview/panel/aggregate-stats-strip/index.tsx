/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type {
  AggregateLastRun,
  AggregateProductivityStats,
  AggregateSeriesPoint,
  AggregateStats,
  DeferredTriggerView,
  ProviderGateStats,
} from '../../../shared/protocol';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';
import { Tooltip } from '../components/tooltip';
import { StackedAreaChart } from '../components/stacked-area-chart';
import { Sparkline } from '../components/sparkline';
import { colorsFor } from '../components/chart-colors';
import { Num } from './num';

/**
 * Thin status strip anchored at the bottom of the panel (below the composer).
 * Focused on **recent + current** activity over long-term totals:
 *
 *   today $X · wk $Y · tok/s (active generation / rolling experienced) · N tabs
 *
 * Each segment's tooltip is a **rich** tooltip (JSX rendered into an
 * out-of-tree host via the `Tooltip` component's `contentNode`): the numeric
 * segments (today/week cost, tokens, throughput, last run, sessions) carry a
 * small timeseries graph — a stacked-area chart with per-provider bands and a
 * per-model breakdown on hover — while the live-state segments (provider gate)
 * use richly-formatted text. Custom tooltips are used
 * instead of native `title` because the strip re-renders ~7×/sec during
 * streaming — native `title` tooltips close on every re-render and flicker.
 *
 * Host-owned (STATE_CONTRACT § Webview-Local State): the strip is a pure
 * projection of `ViewState.aggregateStats`; it computes nothing itself.
 */

interface AggregateStatsStripProps {
  stats: AggregateStats;
  deferredTriggers: DeferredTriggerView[];
  onOpenDeferredMenu: (x: number, y: number, triggerEl: HTMLElement) => void;
}

function AggregateStatsStripView({ stats, deferredTriggers, onOpenDeferredMenu }: AggregateStatsStripProps) {
  const {
    ready,
    todayCost,
    weekCost,
    todayInputTokens,
    todayOutputTokens,
    activeGenerationTokensPerSecond,
    liveTokensPerSecond,
    runningSessionCount,
    openTabCount,
    lastRun,
  } = stats;

  // Prefer the host-computed active-generation sum while work is producing
  // output. The 30-second wall-clock rate remains the experienced fallback
  // through tools and briefly after completion; if neither has a value while a
  // session is running, say so instead of rendering a misleading zero.
  const running = runningSessionCount > 0;
  const hasActiveRate = activeGenerationTokensPerSecond > 0;
  const hasRollingRate = liveTokensPerSecond > 0;
  const rateSource: 'active' | 'rolling' | 'measuring' | 'none' = hasActiveRate
    ? 'active'
    : hasRollingRate
      ? 'rolling'
      : running ? 'measuring' : 'none';
  const headlineRate = rateSource === 'active' ? activeGenerationTokensPerSecond : liveTokensPerSecond;

  return (
    <div
      class={cx('aggregate-strip', !ready && 'aggregate-strip--placeholder')}
      role="status"
      aria-label={ariaLabel(stats)}
    >
      <Tooltip contentNode={todayCostTooltipNode(stats)} placement="top" freezeWhileVisible richRole="region">
        <span
          class="aggregate-strip-seg aggregate-strip-seg--primary"
          tabIndex={0}
          aria-label={`Today's estimated token cost ${formatCostAdaptive(todayCost)}. Focus for today's cost and provider details.`}
        >
          today <Num value={todayCost} format={formatCostAdaptive} width={8} class="aggregate-strip-cost" />
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={weekCostTooltipNode(stats)} placement="top" freezeWhileVisible richRole="region">
        <span
          class="aggregate-strip-seg"
          tabIndex={0}
          aria-label={`Estimated token cost this week ${formatCostAdaptive(weekCost)}. Focus for seven-day cost and provider details.`}
        >
          wk <Num value={weekCost} format={formatCostAdaptive} width={8} class="aggregate-strip-cost" />
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={tokensTooltipNode(stats)} placement="top" freezeWhileVisible richRole="region">
        <span
          class="aggregate-strip-seg aggregate-strip-tokens"
          tabIndex={0}
          aria-label={`Today's tokens: ${formatCompactTokens(todayInputTokens)} input and ${formatCompactTokens(todayOutputTokens)} output. Focus for token chart and provider details.`}
        >
          <span class="aggregate-strip-tok-down">↓<Num value={todayInputTokens} format={formatCompactTokens} width={5} /></span>
          {' '}<span class="aggregate-strip-tok-up">↑<Num value={todayOutputTokens} format={formatCompactTokens} width={5} /></span>
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={throughputTooltipNode(stats, rateSource)} placement="top" freezeWhileVisible richRole="region">
        <span
          class="aggregate-strip-seg"
          tabIndex={0}
          aria-label={`Throughput: ${rateSource === 'measuring' ? 'measuring' : rateSource === 'none' ? 'unavailable' : `${formatRate(headlineRate)} tokens per second`}. Focus for active and rolling throughput details.`}
        >
          {rateSource === 'measuring'
            ? <span class="aggregate-strip-rate aggregate-strip-num" style="min-width:4ch">…</span>
            : rateSource === 'none'
              ? <span class="aggregate-strip-rate aggregate-strip-num" style="min-width:4ch">—</span>
              : <Num value={headlineRate} format={formatRate} width={4} class="aggregate-strip-rate" />}
          <span class="aggregate-strip-unit"> tok/s</span>
        </span>
      </Tooltip>
      {lastRun && (
        <>
          <Sep />
          <Tooltip contentNode={lastRunTooltipNode(lastRun)} placement="top" freezeWhileVisible richRole="region">
            <span
              class="aggregate-strip-seg"
              tabIndex={0}
              aria-label={`Latest completed run across all sessions: cost ${formatCostAdaptive(lastRun.cost)}, duration ${formatDuration(lastRun.durationMs)}. Focus for model, token, and timing details.`}
            >
              last <Num value={lastRun.cost} format={formatCostAdaptive} width={8} class="aggregate-strip-cost" />
              <Num value={lastRun.durationMs} format={formatDuration} width={4} class="aggregate-strip-dur" />
            </span>
          </Tooltip>
        </>
      )}
      {stats.providerGate.enabled && stats.providerGate.providers.length > 0 && (
        <>
          <Sep />
          <Tooltip contentNode={providerGateTooltipNode(stats.providerGate)} placement="top" freezeWhileVisible richRole="region">
            <span
              class="aggregate-strip-seg aggregate-strip-providers"
              tabIndex={0}
              aria-label={`Provider concurrency: ${stats.providerGate.providers.map((p) => `${p.provider} ${p.activeRequests} of ${p.maxConcurrentRequests} active${p.queuedRequests > 0 ? `, ${p.queuedRequests} queued` : ''}${p.paused ? ', paused' : ''}`).join('; ')}. Focus for provider gate details.`}
            >
              {stats.providerGate.providers.map((p, i) => (
                <span
                  key={p.provider}
                  class={cx(
                    'aggregate-strip-provider',
                    p.paused && 'aggregate-strip-provider--paused',
                    !p.paused && p.queuedRequests > 0 && 'aggregate-strip-provider--queued',
                  )}
                >
                  {i > 0 && ' '}
                  <span class="aggregate-strip-provider-name">{p.provider}</span>{' '}
                  <span class="aggregate-strip-provider-counts">{p.activeRequests}/{p.maxConcurrentRequests}</span>
                  {p.queuedRequests > 0 && <span class="aggregate-strip-provider-queued">+{p.queuedRequests}</span>}
                </span>
              ))}
            </span>
          </Tooltip>
        </>
      )}
      {deferredTriggers.length > 0 && (
        <>
          <Sep />
          <Tooltip contentNode={deferredTooltipNode(deferredTriggers)} placement="top" freezeWhileVisible richRole="region">
            <button
              type="button"
              class="aggregate-strip-seg aggregate-strip-deferred"
              title={`Pending deferred trigger${deferredTriggers.length === 1 ? '' : 's'} — click to cancel`}
              aria-label={`${deferredTriggers.length} pending deferred trigger${deferredTriggers.length === 1 ? '' : 's'}. Click to open cancel menu.`}
              onClick={(e) => onOpenDeferredMenu(e.clientX, e.clientY, e.currentTarget as HTMLElement)}
            >
              <span class="aggregate-strip-deferred-icon" aria-hidden="true">⏳</span>
              <span class="aggregate-strip-deferred-count">{deferredTriggers.length} deferred</span>
            </button>
          </Tooltip>
        </>
      )}
      <Sep />
      <Tooltip contentNode={workTooltipNode(stats)} placement="top" freezeWhileVisible richRole="region" triggerClassName="aggregate-strip-counts-trigger">
        <span
          class="aggregate-strip-seg aggregate-strip-counts"
          tabIndex={0}
          aria-label={`${runningSessionCount} session${runningSessionCount === 1 ? '' : 's'} working, ${openTabCount} open. Focus for work trend and productivity details.`}
        >
          {running && (
            <span class="aggregate-strip-active">
              <span class="aggregate-strip-active-dot" aria-hidden="true" />
              {runningSessionCount} working
            </span>
          )}
          {running && ' · '}
          {openTabCount} open
        </span>
      </Tooltip>
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
  return (prev.stats === next.stats || aggregateStatsSignature(prev.stats) === aggregateStatsSignature(next.stats))
    && deferredSignature(prev.deferredTriggers) === deferredSignature(next.deferredTriggers);
}

/** Compact membership signature of the active deferred-trigger set, so the
 *  strip skips re-render when the set is unchanged across a fresh host-serialised
 *  `deferredTriggers` array reference (the host re-serialises every snapshot). */
function deferredSignature(t: DeferredTriggerView[]): string {
  return t.map((x) => `${x.id}:${x.sessionPath}`).sort().join(',');
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
    p.sendCount, p.promptCharSamples, p.promptChars, p.promptTokenSamples,
    p.promptTokens, p.inputTokens, p.filesystemPathRefCount, p.imageInputCount,
    p.imageInputBytes, p.askUserAnsweredCount, p.askUserCancelledCount, p.askUserTrackedRuns,
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
    s.todayTokensPerSecond, s.tokensPerSecond, s.activeGenerationTokensPerSecond, s.liveTokensPerSecond,
    s.todayRunCount, s.todayToolCallCount, s.todayTouchedFileCount, s.weekRunCount,
    s.runningSessionCount, s.openTabCount,
    s.totalCost, s.totalInputTokens, s.totalOutputTokens,
    s.totalCacheReadTokens, s.totalCacheWriteTokens,
    s.runCount, s.sessionCount,
    s.costByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.todayCostByProvider.map((p) => `${p.provider}:${p.cost}:${p.inputTokens}:${p.outputTokens}`).join(','),
    s.weekCostByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
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
    seriesSignature(s.todayThroughputSeries),
    seriesSignature(s.weekCostSeries),
    s.tokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.todayTokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.lastRun ? `${s.lastRun.cost}:${s.lastRun.durationMs}:${s.lastRun.startedAt}:${s.lastRun.endedAt}:${s.lastRun.modelId}:${s.lastRun.provider}:${s.lastRun.inputTokens}:${s.lastRun.outputTokens}:${s.lastRun.turnSeries.map((t) => `${t.ms}:${t.outputTokens}`).join(',')}` : '',
    s.providerGate.enabled,
    s.providerGate.providers.map((p) => `${p.provider}:${p.activeRequests}:${p.queuedRequests}:${p.maxConcurrentRequests}:${p.afterburnSeconds}:${p.queueWaitSeconds ?? ''}:${p.paused}:${p.pausedUntilMs}:${p.strikeCount}`).join(','),
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
  /** Qualifies model values that use a sampled view instead of the headline rollup. */
  detailLabel?: string;
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
              aria-label={`${it.key} ${it.value}. Focus for model breakdown${it.detailLabel ? ` (${it.detailLabel})` : ''}.`}
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
              {it.detailLabel && <span class="rich-tooltip-sub">Model values: {it.detailLabel}</span>}
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
  view: 'final' | 'latestByModel' = 'final',
): ProviderLegendItem['models'] {
  if (view === 'final') {
    const final = series.at(-1);
    if (!final) return [];
    return final.byModel
      .filter((entry) => entry.provider === provider)
      .map((entry) => ({ provider: entry.provider, model: entry.model, value: format(entry.value) }));
  }

  // Throughput points are per-hour rates, while the provider legend is a
  // generation-time-weighted day rollup. Do not add rates across hours or
  // present the last hour as today's total; retain each model's latest sampled
  // rate and label that view explicitly in the nested detail.
  const latestByModel = new Map<string, { provider: string; model: string; value: string }>();
  for (const point of series) {
    for (const entry of point.byModel) {
      if (entry.provider === provider) {
        latestByModel.set(entry.model, { provider: entry.provider, model: entry.model, value: format(entry.value) });
      }
    }
  }
  return [...latestByModel.values()];
}

function ariaLabel(s: AggregateStats): string {
  if (!s.ready) return 'Usage stats: computing.';
  const active = s.activeGenerationTokensPerSecond > 0
    ? `Active-generation speed ${formatRate(s.activeGenerationTokensPerSecond)} tokens per second.`
    : s.runningSessionCount > 0 ? 'Active-generation speed is measuring or paused.' : 'Active-generation speed unavailable.';
  const rolling = s.liveTokensPerSecond > 0
    ? `30-second end-to-end throughput ${formatRate(s.liveTokensPerSecond)} tokens per second.`
    : '30-second end-to-end throughput unavailable.';
  const throughput = `${active} ${rolling}`;
  return `Estimated API-equivalent token cost across all runs today ${formatCostAdaptive(s.todayCost)}. This week ${formatCostAdaptive(s.weekCost)}. `
    + `${throughput} ${s.runningSessionCount} session${s.runningSessionCount === 1 ? '' : 's'} working, ${s.openTabCount} open.`;
}

// ── Scoped rich tooltips ────────────────────────────────────────────────────

function todayCostTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const sub: string[] = [`Across all sessions · ${s.todayRunCount} run${s.todayRunCount === 1 ? '' : 's'}`];
  if (s.todayInputTokens > 0 || s.todayOutputTokens > 0) {
    sub.push(`↓${formatCompactTokens(s.todayInputTokens)} in  ↑${formatCompactTokens(s.todayOutputTokens)} out`);
  }
  if (s.todayToolCallCount > 0 || s.todayTouchedFileCount > 0) {
    sub.push(`${s.todayToolCallCount} tool call${s.todayToolCallCount === 1 ? '' : 's'} · ${s.todayTouchedFileCount} file${s.todayTouchedFileCount === 1 ? '' : 's'}`);
  }
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated token cost today</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.todayCost)}</span>
      </div>
      <div class="rich-tooltip-sub">API-equivalent catalog estimate · subscriptions, plan allowances, and invoices are not reconciled</div>
      <div class="rich-tooltip-sub">{sub.join('  ·  ')}</div>
      <StackedAreaChart points={s.todayCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatTimeOfDay}
        colorKeys={s.todayCostByProvider.map((p) => p.provider)} />
      {s.todayCostByProvider.length > 0 && (
        <ProviderLegend items={s.todayCostByProvider.map((p) => ({
          key: p.provider,
          value: formatCostAdaptive(p.cost),
          models: modelValuesForProvider(s.todayCostSeries, p.provider, formatCostAdaptive),
        }))} />
      )}
      <div class="rich-tooltip-sub">All-time {formatCostAdaptive(s.totalCost)} · {s.runCount} runs · {s.sessionCount} sessions</div>
    </div>
  );
}

function weekCostTooltipNode(s: AggregateStats): string | JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated token cost (7d)</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.weekCost)}</span>
      </div>
      <div class="rich-tooltip-sub">API-equivalent catalog estimate · subscriptions, plan allowances, and invoices are not reconciled</div>
      <div class="rich-tooltip-sub">{s.weekRunCount} run{s.weekRunCount === 1 ? '' : 's'}</div>
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

function tokensTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return <TokensTooltip stats={s} />;
}

function TokensTooltip({ stats }: { stats: AggregateStats }): JSX.Element {
  const [kind, setKind] = useState<'input' | 'output'>('output');
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
      <div class="rich-tooltip-sub">↓{formatCompactTokens(stats.todayInputTokens)} in  ·  ↑{formatCompactTokens(stats.todayOutputTokens)} out</div>
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

export function throughputTooltipNode(s: AggregateStats, source: 'active' | 'rolling' | 'measuring' | 'none'): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const activeLine = s.activeGenerationTokensPerSecond > 0
    ? `Active-generation speed ${formatRate(s.activeGenerationTokensPerSecond)} tok/s`
    : s.runningSessionCount > 0
      ? 'Active-generation speed measuring or paused'
      : 'Active-generation speed unavailable';
  const rollingLine = s.liveTokensPerSecond > 0
    ? `30-second wall-clock throughput ${formatRate(s.liveTokensPerSecond)} tok/s`
    : '30-second wall-clock throughput unavailable';
  const lines: string[] = [activeLine, rollingLine];
  if (s.runningSessionCount > 0) lines.push(`${s.runningSessionCount} running`);
  if (s.todayTokensPerSecond > 0) lines.push(`Today ${formatRate(s.todayTokensPerSecond)} tok/s`);
  if (s.tokensPerSecond > 0) lines.push(`All-time ${formatRate(s.tokensPerSecond)} tok/s`);
  lines.push('Active-generation speed sums per-session output over generation time; it excludes TTFT, tools, and between-turn waits.');
  lines.push('30-second wall-clock throughput includes the experienced waits and remains after a burst while its rolling window decays.');
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Throughput</span>
        <span class="rich-tooltip-head-value">{source === 'active'
          ? formatRate(s.activeGenerationTokensPerSecond)
          : source === 'rolling'
            ? formatRate(s.liveTokensPerSecond)
            : source === 'measuring' ? '…' : '—'} tok/s</span>
      </div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
      <StackedAreaChart points={s.todayThroughputSeries} mode="rate" formatY={(n) => formatRate(n)} formatX={formatTimeOfDay} unit="tok/s"
        colorKeys={s.todayTokensPerSecondByProvider.map((p) => p.provider)} />
      {s.todayTokensPerSecondByProvider.length > 0 && (
        <ProviderLegend items={s.todayTokensPerSecondByProvider.map((p) => ({
          key: p.provider,
          value: `${formatRate(p.tokensPerSecond)} tok/s`,
          models: modelValuesForProvider(s.todayThroughputSeries, p.provider, (value) => `${formatRate(value)} tok/s`, 'latestByModel'),
          detailLabel: 'latest sampled rate',
        }))} />
      )}
    </div>
  );
}

function lastRunTooltipNode(r: AggregateLastRun): JSX.Element {
  const modelLine = r.modelId ? `${r.modelId}  (${r.provider})` : `Provider: ${r.provider}`;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Latest completed run · all sessions</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(r.cost)}</span>
      </div>
      <div class="rich-tooltip-sub">{formatDuration(r.durationMs)}  ·  ↓{formatCompactTokens(r.inputTokens)} in  ↑{formatCompactTokens(r.outputTokens)} out</div>
      <Sparkline data={r.turnSeries.map((t) => ({ ms: t.ms, value: t.outputTokens }))} />
      <div class="rich-tooltip-sub">{[modelLine, `${r.startedAt} → ${r.endedAt}`].join('\n')}</div>
    </div>
  );
}

function providerGateTooltipNode(g: ProviderGateStats): JSX.Element {
  const lines: string[] = [];
  for (const p of g.providers) {
    let line = `${pad(p.provider, 14)}${p.activeRequests}/${p.maxConcurrentRequests} active`;
    if (p.queuedRequests > 0) line += `  · ${p.queuedRequests} queued`;
    if (p.paused) {
      const seconds = Math.max(0, Math.ceil((p.pausedUntilMs - Date.now()) / 1000));
      line += `  · PAUSED (${seconds}s, ${p.strikeCount} strike${p.strikeCount === 1 ? '' : 's'})`;
    } else if (p.afterburnSeconds > 0) {
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

/** Compact human-readable byte size for attachment summaries. */
function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1_048_576) return `${trimDec(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${trimDec(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** One window's productivity summary line, coverage-aware: tracked-sample
 *  fractions are surfaced when only part of the window's runs recorded a
 *  metric, and unknown averages are never rendered as a zero. */
function productivityLine(label: string, p: AggregateProductivityStats, runCount: number): string {
  const parts: string[] = [`${p.sendCount} send${p.sendCount === 1 ? '' : 's'}`];
  if (p.promptCharSamples > 0) {
    parts.push(`${formatCompactTokens(p.promptChars)} chars prompt text`
      + (p.averagePromptChars !== null ? ` · avg ${Math.round(p.averagePromptChars)}` : ''));
    if (runCount > 0 && p.promptCharSamples < runCount) {
      parts.push(`chars tracked ${p.promptCharSamples}/${runCount}`);
    }
  }
  if (p.promptTokenSamples > 0) parts.push(`≈${formatCompactTokens(p.promptTokens)} prompt tok`);
  if (p.inputTokens > 0) parts.push(`↓${formatCompactTokens(p.inputTokens)} in`);
  // Filesystem references and images are separate attachment kinds: image
  // bytes describe images only, never generic attachment bytes.
  if (p.filesystemPathRefCount > 0) {
    parts.push(`${p.filesystemPathRefCount} file ref${p.filesystemPathRefCount === 1 ? '' : 's'}`);
  }
  if (p.imageInputCount > 0) {
    parts.push(`${p.imageInputCount} image${p.imageInputCount === 1 ? '' : 's'} (${formatAttachmentBytes(p.imageInputBytes)})`);
  }
  if (p.filesystemPathRefCount > 0 && p.imageInputCount > 0) {
    parts.push(`${p.filesystemPathRefCount + p.imageInputCount} attachments total`);
  }
  if (p.askUserAnsweredCount > 0) {
    parts.push(`${p.askUserAnsweredCount} question${p.askUserAnsweredCount === 1 ? '' : 's'} answered`);
  }
  if (p.askUserCancelledCount > 0) {
    parts.push(`${p.askUserCancelledCount} question${p.askUserCancelledCount === 1 ? '' : 's'} cancelled`);
  }
  if (p.askUserTrackedRuns > 0 && runCount > 0 && p.askUserTrackedRuns < runCount) {
    parts.push(`ask tracked ${p.askUserTrackedRuns}/${runCount}`);
  }
  return `${label}: ${parts.join(' · ') || 'no tracked activity'}`;
}

/** Work segment tooltip: current state (working/open) in the header, the
 *  14-day dual-series work trend (sessions used vs peak concurrently working —
 *  historical run evidence, never open-tab history), and today/7-day
 *  productivity summaries with their tracked-sample coverage. */
/** Exported for the focused Work-tooltip render test. */
export function workTooltipNode(s: AggregateStats): JSX.Element {
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
        <span class="rich-tooltip-head-value">{s.openTabCount} open</span>
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
      <div class="rich-tooltip-sub">
        {productivityLine('Today', s.todayProductivity, s.todayRunCount) + '\n' + productivityLine('7-day', s.weekProductivity, s.weekRunCount)}
      </div>
      <div class="rich-tooltip-sub">{`${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'} (all-time) · ${s.runCount} runs\nAll-time ↓${formatCompactTokens(s.totalInputTokens)} in  ↑${formatCompactTokens(s.totalOutputTokens)} out`}</div>
    </div>
  );
}

/** Tooltip for the waiting-trigger segment: one line per active trigger
 *  (session + condition + note), so the user can preview before opening the
 *  cancel popup. */
function deferredTooltipNode(triggers: DeferredTriggerView[]): JSX.Element {
  const lines: string[] = [`${triggers.length} pending — click to cancel`, ''];
  for (const t of triggers) {
    const note = t.note.trim() || '(no note)';
    const head = `${t.sessionPath.split(/[\\/]/).pop() ?? t.sessionPath}: ${note}`;
    lines.push(head.length > 80 ? `${head.slice(0, 77)}…` : head);
  }
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head"><span>Deferred triggers</span><span class="rich-tooltip-head-value">{triggers.length}</span></div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
    </div>
  );
}
