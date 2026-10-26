/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';

import type {
  AggregateProductivityStats,
  AggregateSeriesPoint,
  AggregateStats,
  DeferredTriggerView,
} from '../../../lib/protocol/index.js';
import { formatCompactTokens } from '../../lib/formatting/format-tokens';
import { cx } from '../../lib/components/cx';
import { StackedAreaChart } from '../stacked-area-chart';
import { colorsFor } from '../chart-colors';
import { Tooltip } from '../../lib/components/tooltip';

/** Intrinsic global cost pair; the toolbar owns placement and overflow as one item. */
interface AggregateStatsStripProps { stats: AggregateStats; }
interface DeferredTriggersIndicatorProps {
  deferredTriggers: DeferredTriggerView[];
  onOpenDeferredMenu: (x: number, y: number, triggerEl: HTMLElement) => void;
}
type TokenSeriesKind = 'input' | 'output';

function AggregateStatsStripView({ stats }: AggregateStatsStripProps) {
  const anchors = [
    { key: 'today', value: stats.todayCost, tooltip: todayCostTooltipNode(stats), label: "Today's estimated token cost", incomplete: (stats.billableAccounting?.todayUnknownInvocationCount ?? 0) + (stats.billableAccounting?.todayUnpricedInvocationCount ?? 0) + (stats.billableAccounting?.todayInstrumentationGapInvocationCount ?? 0) },
    { key: 'week', value: stats.weekCost, tooltip: weekCostTooltipNode(stats), label: 'Estimated token cost this week', incomplete: (stats.billableAccounting?.weekUnknownInvocationCount ?? 0) + (stats.billableAccounting?.weekUnpricedInvocationCount ?? 0) + (stats.billableAccounting?.weekInstrumentationGapInvocationCount ?? 0) },
  ];
  return <div class={cx('aggregate-strip', !stats.ready && 'aggregate-strip--placeholder')} role="status" aria-label={ariaLabel(stats)}>
    {anchors.map((anchor) => <span key={anchor.key} class="aggregate-strip-item" data-stat={anchor.key}>
      <Tooltip contentNode={anchor.tooltip} placement="top" freezeWhileVisible richRole="region" returnFocusOnEscape>
        <span class="aggregate-strip-seg aggregate-strip-cost" tabIndex={0}
          aria-label={anchor.label + ' ' + formatCostAdaptive(anchor.value) + (anchor.incomplete > 0 ? '; incomplete billing provenance' : '') + (stats.ready ? '. Focus for cost chart and provider details.' : '. Computing usage stats.')}>
          {formatCostAdaptive(anchor.value)}
        </span>
      </Tooltip>
    </span>)}
  </div>;
}
export const AggregateStatsStrip = memo(AggregateStatsStripView, (prev, next) =>
  prev.stats === next.stats || aggregateStatsSignature(prev.stats) === aggregateStatsSignature(next.stats));

/** Separate pending-wakeup action; cancellation remains owned by the existing menu. */
export function DeferredTriggersIndicator({ deferredTriggers, onOpenDeferredMenu }: DeferredTriggersIndicatorProps) {
  if (deferredTriggers.length === 0) return null;
  return <Tooltip contentNode={deferredTooltipNode(deferredTriggers)} placement="top" freezeWhileVisible richRole="region" returnFocusOnEscape>
    <button type="button" class="aggregate-strip-seg aggregate-strip-deferred"
      aria-label={deferredTriggers.length + ' pending wakeup timer' + (deferredTriggers.length === 1 ? '' : 's') + '. Click to open cancel menu.'}
      onClick={(event) => onOpenDeferredMenu(event.clientX, event.clientY, event.currentTarget)}>
      ⏳ {deferredTriggers.length} wakeup
    </button>
  </Tooltip>;
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
export function ProviderLegend({ items }: { items: ProviderLegendItem[] }): JSX.Element {
  // Unique per legend instance (not a module render counter): `useId` is stable
  // across re-renders and deterministic per instance, so a legend's described-by
  // ids never drift between renders or depend on how many legends rendered before.
  const idBase = useId();
  const colors = colorsFor(items.map((item) => item.key));
  return (
    <div class="rich-tooltip-legend">
      {items.map((it, index) => {
        const detailId = `pie-provider-legend-detail-${idBase}-${index}`;
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
                        {model.model}
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
  omitZeroValues = false,
): ProviderLegendItem['models'] {
  const final = series.at(-1);
  if (!final) return [];
  return final.byModel
    .filter((entry) => entry.provider === provider && (!omitZeroValues || entry.value > 0))
    .map((entry) => ({ provider: entry.provider, model: entry.model, value: format(entry.value) }));
}

function ariaLabel(s: AggregateStats): string {
  if (!s.ready) return 'Usage stats: computing.';
  return 'Estimated API-equivalent token cost across all runs today ' + formatCostAdaptive(s.todayCost) + '. This week ' + formatCostAdaptive(s.weekCost) + '.';
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
      <StackedAreaChart points={s.todayCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatTimeOfDay}
        colorKeys={s.todayCostByProvider.map((p) => p.provider)} />
      {s.todayCostByProvider.length > 0 && (
        <ProviderLegend items={s.todayCostByProvider.map((p) => ({
          key: p.provider,
          value: formatCostAdaptive(p.cost),
          models: modelValuesForProvider(s.todayCostSeries, p.provider, formatCostAdaptive, true),
        }))} />
      )}
    </div>
  );
}

export function weekCostTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated token cost (7d)</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.weekCost)}</span>
      </div>
      <StackedAreaChart points={s.weekCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatDateTimeShort}
        colorKeys={s.weekCostByProvider.map((p) => p.provider)} />
      {s.weekCostByProvider.length > 0 && (
        <ProviderLegend items={s.weekCostByProvider.map((p) => ({
          key: p.provider,
          value: formatCostAdaptive(p.cost),
          models: modelValuesForProvider(s.weekCostSeries, p.provider, formatCostAdaptive, true),
        }))} />
      )}
    </div>
  );
}

/** `initialKind` is required: each token anchor must name its own matching
 *  series, so an input anchor never silently falls back to the (misleading)
 *  output default. The selection is parent-owned (see the strip's
 *  per-anchor state) and reaches the tooltip through these props. */
export function tokensTooltipNode(
  s: AggregateStats,
  initialKind: TokenSeriesKind,
  onKindChange?: (kind: TokenSeriesKind) => void,
): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return <TokensTooltip stats={s} initialKind={initialKind} onKindChange={onKindChange} />;
}

function TokensTooltip({ stats, initialKind, onKindChange }: {
  stats: AggregateStats;
  initialKind: TokenSeriesKind;
  onKindChange?: (kind: TokenSeriesKind) => void;
}): JSX.Element {
  const [kind, setKind] = useState<TokenSeriesKind>(initialKind);
  /** The popover subtree stays frozen while visible, so the toggle updates its
   *  own internal state; the parent's per-anchor copy (via `onKindChange`) is
   *  what replays the explicit selection on the next reopen. */
  const selectKind = (next: TokenSeriesKind) => {
    setKind(next);
    onKindChange?.(next);
  };
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
      <div class="rich-tooltip-toggle" role="group" aria-label="Token chart series">
        <button type="button" aria-pressed={input} onClick={() => selectKind('input')}>Input</button>
        <button type="button" aria-pressed={!input} onClick={() => selectKind('output')}>Output</button>
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
