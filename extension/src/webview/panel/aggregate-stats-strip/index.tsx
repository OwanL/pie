/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type { JSX } from 'preact';

import type { AggregateStats, AggregateLastRun, DeferredTriggerView, WarmBashStats, ProviderGateStats, AggregateSeriesPoint } from '../../../shared/protocol';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';
import { Tooltip } from '../components/tooltip';
import { StackedAreaChart } from '../components/stacked-area-chart';
import { Sparkline } from '../components/sparkline';
import { colorFor } from '../components/chart-colors';

/**
 * Thin status strip anchored at the bottom of the panel (below the composer).
 * Focused on **recent + current** activity over long-term totals:
 *
 *   today $X · wk $Y · tok/s (live when running, else today's mean) · N tabs
 *
 * Each segment's tooltip is a **rich** tooltip (JSX rendered into an
 * out-of-tree host via the `Tooltip` component's `contentNode`): the numeric
 * segments (today/week cost, tokens, throughput, last run, sessions) carry a
 * small timeseries graph — a stacked-area chart with per-provider bands and a
 * per-model breakdown on hover — while the live-state segments (provider gate,
 * warm bash, deferred) use richly-formatted text. Custom tooltips are used
 * instead of native `title` because the strip re-renders ~7×/sec during
 * streaming — native `title` tooltips close on every re-render and flicker.
 *
 * Host-owned (STATE_CONTRACT § Webview-Local State): the strip is a pure
 * projection of `ViewState.aggregateStats`; it computes nothing itself.
 */

interface AggregateStatsStripProps {
  stats: AggregateStats;
  deferredTriggers: DeferredTriggerView[];
  onOpenDeferredMenu: (x: number, y: number) => void;
}

function AggregateStatsStripView({ stats, deferredTriggers, onOpenDeferredMenu }: AggregateStatsStripProps) {
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
      <Tooltip contentNode={todayCostTooltipNode(stats)} placement="top" freezeWhileVisible>
        <span class="aggregate-strip-seg aggregate-strip-seg--primary">
          today <span class="aggregate-strip-cost">{formatCostAdaptive(todayCost)}</span>
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={weekCostTooltipNode(stats)} placement="top" freezeWhileVisible>
        <span class="aggregate-strip-seg">
          wk <span class="aggregate-strip-cost">{formatCostAdaptive(weekCost)}</span>
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={tokensTooltipNode(stats)} placement="top" freezeWhileVisible>
        <span class="aggregate-strip-seg aggregate-strip-tokens">
          <span class="aggregate-strip-tok-down">↓{formatCompactTokens(todayInputTokens)}</span>
          {' '}<span class="aggregate-strip-tok-up">↑{formatCompactTokens(todayOutputTokens)}</span>
        </span>
      </Tooltip>
      <Sep />
      <Tooltip contentNode={throughputTooltipNode(stats, rateSource)} placement="top" freezeWhileVisible>
        <span class="aggregate-strip-seg">
          {rateSource === 'live' && <span class="aggregate-strip-live-tag">live</span>}
          {rateSource === 'none'
            ? <span class="aggregate-strip-rate">—</span>
            : <span class="aggregate-strip-rate">{formatRate(headlineRate)}</span>}
          <span class="aggregate-strip-unit"> tok/s</span>
        </span>
      </Tooltip>
      {lastRun && (
        <>
          <Sep />
          <Tooltip contentNode={lastRunTooltipNode(lastRun)} placement="top" freezeWhileVisible>
            <span class="aggregate-strip-seg">
              last <span class="aggregate-strip-cost">{formatCostAdaptive(lastRun.cost)}</span>
              <span class="aggregate-strip-dur">{formatDuration(lastRun.durationMs)}</span>
            </span>
          </Tooltip>
        </>
      )}
      {stats.providerGate.enabled && stats.providerGate.providers.length > 0 && (
        <>
          <Sep />
          <Tooltip contentNode={providerGateTooltipNode(stats.providerGate)} placement="top" freezeWhileVisible>
            <span class="aggregate-strip-seg aggregate-strip-providers">
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
      {stats.warmBash.enabled && (
        <>
          <Sep />
          <Tooltip contentNode={warmBashTooltipNode(stats.warmBash)} placement="top" freezeWhileVisible>
            <span class="aggregate-strip-seg aggregate-strip-warm">
              <span class="aggregate-strip-warm-label">warm</span>
              <span class="aggregate-strip-warm-counts">{stats.warmBash.ready}/{stats.warmBash.poolSize}</span>
              {stats.warmBash.warming > 0 && (
                <span class="aggregate-strip-warm-warming" aria-hidden="true">↑{stats.warmBash.warming}</span>
              )}
            </span>
          </Tooltip>
        </>
      )}
      {deferredTriggers.length > 0 && (
        <>
          <Sep />
          <Tooltip contentNode={deferredTooltipNode(deferredTriggers)} placement="top" freezeWhileVisible>
            <button
              type="button"
              class="aggregate-strip-seg aggregate-strip-deferred"
              title={`Pending deferred trigger${deferredTriggers.length === 1 ? '' : 's'} — click to cancel`}
              aria-label={`${deferredTriggers.length} pending deferred trigger${deferredTriggers.length === 1 ? '' : 's'}. Click to open cancel menu.`}
              onClick={(e) => onOpenDeferredMenu(e.clientX, e.clientY)}
            >
              <span class="aggregate-strip-deferred-icon" aria-hidden="true">⏳</span>
              <span class="aggregate-strip-deferred-count">{deferredTriggers.length} deferred</span>
            </button>
          </Tooltip>
        </>
      )}
      <Sep />
      <Tooltip contentNode={sessionsTooltipNode(stats)} placement="top" freezeWhileVisible triggerClassName="aggregate-strip-counts-trigger">
        <span class="aggregate-strip-seg aggregate-strip-counts">
          {openTabCount} tab{openTabCount === 1 ? '' : 's'}
          {running && (
            <span class="aggregate-strip-active">
              {' · '}
              <span class="aggregate-strip-active-dot" aria-hidden="true" />
              {runningSessionCount} active
            </span>
          )}
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
  return (prev.stats === next.stats || statsSignature(prev.stats) === statsSignature(next.stats))
    && deferredSignature(prev.deferredTriggers) === deferredSignature(next.deferredTriggers);
}

/** Compact membership signature of the active deferred-trigger set, so the
 *  strip skips re-render when the set is unchanged across a fresh host-serialised
 *  `deferredTriggers` array reference (the host re-serialises every snapshot). */
function deferredSignature(t: DeferredTriggerView[]): string {
  return t.map((x) => `${x.id}:${x.sessionPath}`).sort().join(',');
}

function seriesSignature(s: AggregateSeriesPoint[]): string {
  if (s.length === 0) return '0';
  const last = s[s.length - 1]!;
  return `${s.length}:${last.ms}:${last.byProvider.reduce((sum, p) => sum + p.value, 0).toFixed(6)}`;
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
    s.todayCostByProvider.map((p) => `${p.provider}:${p.cost}:${p.inputTokens}:${p.outputTokens}`).join(','),
    s.weekCostByProvider.map((p) => `${p.provider}:${p.cost}`).join(','),
    s.dailyCost.map((d) => `${d.date}:${d.totalCost}`).join(','),
    s.dailyRunCount.map((d) => `${d.date}:${d.runCount}`).join(','),
    seriesSignature(s.todayCostSeries),
    seriesSignature(s.todayTokenSeries),
    seriesSignature(s.todayThroughputSeries),
    s.tokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.todayTokensPerSecondByProvider.map((p) => `${p.provider}:${p.tokensPerSecond}`).join(','),
    s.lastRun ? `${s.lastRun.cost}:${s.lastRun.durationMs}:${s.lastRun.endedAt}:${s.lastRun.modelId}:${s.lastRun.turnSeries.length}` : '',
    s.warmBash.enabled, s.warmBash.poolSize, s.warmBash.ready, s.warmBash.warming,
    s.warmBash.fastPathEnabled, s.warmBash.totalFastPath, s.warmBash.totalWarm,
    s.warmBash.totalFallback, s.warmBash.totalWarmupFailures,
    s.providerGate.enabled,
    s.providerGate.providers.map((p) => `${p.provider}:${p.activeRequests}:${p.queuedRequests}:${p.maxConcurrentRequests}:${p.paused}`).join(','),
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

/** Local `YYYY-MM-DD` → ms epoch (local midnight). */
function dateToMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

// ── Rich tooltip building blocks ────────────────────────────────────────────

function Legend({ items }: { items: { key: string; value: string }[] }): JSX.Element {
  return (
    <div class="rich-tooltip-legend">
      {items.map((it) => (
        <span class="rich-tooltip-legend-item" key={it.key}>
          <span class="rich-tooltip-swatch" style={`background:${colorFor(it.key)}`} />
          <span>{it.key}</span>
          <span class="rich-tooltip-legend-val">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

function ariaLabel(s: AggregateStats): string {
  if (!s.ready) return 'Usage stats: computing.';
  return `Today ${formatCostAdaptive(s.todayCost)}. This week ${formatCostAdaptive(s.weekCost)}. `
    + `${s.openTabCount} open tabs, ${s.runningSessionCount} running.`;
}

// ── Scoped rich tooltips ────────────────────────────────────────────────────

function todayCostTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const sub: string[] = [`${s.todayRunCount} run${s.todayRunCount === 1 ? '' : 's'}`];
  if (s.todayInputTokens > 0 || s.todayOutputTokens > 0) {
    sub.push(`↓${formatCompactTokens(s.todayInputTokens)} in  ↑${formatCompactTokens(s.todayOutputTokens)} out`);
  }
  if (s.todayToolCallCount > 0 || s.todayTouchedFileCount > 0) {
    sub.push(`${s.todayToolCallCount} tool call${s.todayToolCallCount === 1 ? '' : 's'} · ${s.todayTouchedFileCount} file${s.todayTouchedFileCount === 1 ? '' : 's'}`);
  }
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Today</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.todayCost)}</span>
      </div>
      <div class="rich-tooltip-sub">{sub.join('  ·  ')}</div>
      <StackedAreaChart points={s.todayCostSeries} mode="cumulative" formatY={formatCostAdaptive} formatX={formatTimeOfDay} />
      {s.todayCostByProvider.length > 0 && (
        <Legend items={s.todayCostByProvider.map((p) => ({ key: p.provider, value: formatCostAdaptive(p.cost) }))} />
      )}
      <div class="rich-tooltip-sub">All-time {formatCostAdaptive(s.totalCost)} · {s.runCount} runs · {s.sessionCount} sessions</div>
    </div>
  );
}

function weekCostTooltipNode(s: AggregateStats): string | JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const weekPoints: AggregateSeriesPoint[] = s.dailyCost.slice(-7).map((d) => ({
    ms: dateToMs(d.date),
    byProvider: d.byProvider.map((p) => ({ key: p.provider, value: p.cost })),
    byModel: d.byModel.map((m) => ({ key: m.model, value: m.cost })),
  }));
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>This week (7d)</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(s.weekCost)}</span>
      </div>
      <div class="rich-tooltip-sub">{s.weekRunCount} run{s.weekRunCount === 1 ? '' : 's'}</div>
      <StackedAreaChart points={weekPoints} mode="rate" formatY={formatCostAdaptive} formatX={formatDateShort} />
      {s.weekCostByProvider.length > 0 && (
        <Legend items={s.weekCostByProvider.map((p) => ({ key: p.provider, value: formatCostAdaptive(p.cost) }))} />
      )}
    </div>
  );
}

function tokensTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Today tokens</span>
        <span class="rich-tooltip-head-value">↑{formatCompactTokens(s.todayOutputTokens)}</span>
      </div>
      <div class="rich-tooltip-sub">↓{formatCompactTokens(s.todayInputTokens)} in  ·  ↑{formatCompactTokens(s.todayOutputTokens)} out</div>
      <StackedAreaChart points={s.todayTokenSeries} mode="cumulative" formatY={formatCompactTokens} formatX={formatTimeOfDay} />
      {s.todayCostByProvider.length > 0 && (
        <Legend items={s.todayCostByProvider.map((p) => ({ key: p.provider, value: formatCompactTokens(p.outputTokens) }))} />
      )}
    </div>
  );
}

function throughputTooltipNode(s: AggregateStats, source: 'live' | 'today' | 'all-time' | 'none'): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const lines: string[] = [];
  if (s.runningSessionCount > 0) {
    lines.push(`Live ${formatRate(s.liveTokensPerSecond)} tok/s · ${s.runningSessionCount} running`);
  }
  if (s.todayTokensPerSecond > 0) lines.push(`Today ${formatRate(s.todayTokensPerSecond)} tok/s`);
  if (s.tokensPerSecond > 0) lines.push(`All-time ${formatRate(s.tokensPerSecond)} tok/s`);
  if (lines.length === 0) lines.push(source === 'none' ? 'No throughput recorded yet.' : 'Measuring…');
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Throughput</span>
        <span class="rich-tooltip-head-value">{formatRate(source === 'live' ? s.liveTokensPerSecond : (s.todayTokensPerSecond > 0 ? s.todayTokensPerSecond : s.tokensPerSecond))} tok/s</span>
      </div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
      <StackedAreaChart points={s.todayThroughputSeries} mode="rate" formatY={(n) => formatRate(n)} formatX={formatTimeOfDay} unit="tok/s" />
      {s.todayTokensPerSecondByProvider.length > 0 && (
        <Legend items={s.todayTokensPerSecondByProvider.map((p) => ({ key: p.provider, value: `${formatRate(p.tokensPerSecond)} tok/s` }))} />
      )}
    </div>
  );
}

function lastRunTooltipNode(r: AggregateLastRun): JSX.Element {
  const modelLine = r.modelId ? `${r.modelId}  (${r.provider})` : `Provider: ${r.provider}`;
  const outcomeLine = r.outcome
    ? `${r.outcome.resolution.replace('_', ' ')}  ·  satisfaction ${r.outcome.satisfaction}`
    : 'Outcome: unscored';
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>Last run</span>
        <span class="rich-tooltip-head-value">{formatCostAdaptive(r.cost)}</span>
      </div>
      <div class="rich-tooltip-sub">{formatDuration(r.durationMs)}  ·  ↓{formatCompactTokens(r.inputTokens)} in  ↑{formatCompactTokens(r.outputTokens)} out</div>
      <Sparkline data={r.turnSeries.map((t) => ({ ms: t.ms, value: t.outputTokens }))} />
      <div class="rich-tooltip-sub">{[modelLine, outcomeLine, `${r.startedAt} → ${r.endedAt}`].join('\n')}</div>
    </div>
  );
}

function warmBashTooltipNode(w: WarmBashStats): JSX.Element {
  const lines: string[] = [
    `Pool ${w.poolSize}  ·  ${w.ready} ready  ·  ${w.warming} warming`,
    `Fast path: ${w.fastPathEnabled ? 'on' : 'off'}`,
  ];
  const totalExecs = w.totalFastPath + w.totalWarm + w.totalFallback;
  if (totalExecs > 0) {
    lines.push(`Executions: ${totalExecs} total`);
    lines.push(`  ${w.totalFastPath} fast path  ·  ${w.totalWarm} warm  ·  ${w.totalFallback} fallback`);
  }
  if (w.totalWarmupFailures > 0) lines.push(`Warmup failures: ${w.totalWarmupFailures}`);
  lines.push('Tune in Settings → Bash (pool size, fast path, timeouts).');
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head"><span>Warm bash</span><span class="rich-tooltip-head-value">{w.ready}/{w.poolSize}</span></div>
      <div class="rich-tooltip-sub">{lines.join('\n')}</div>
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

function sessionsTooltipNode(s: AggregateStats): JSX.Element {
  if (!s.ready) return <div class="rich-tooltip"><div class="rich-tooltip-sub">Computing usage stats…</div></div>;
  const runPoints: AggregateSeriesPoint[] = s.dailyRunCount.map((d) => ({
    ms: dateToMs(d.date),
    byProvider: [{ key: 'runs', value: d.runCount }],
    byModel: [],
  }));
  return (
    <div class="rich-tooltip">
      <div class="rich-tooltip-head">
        <span>{s.openTabCount} open tab{s.openTabCount === 1 ? '' : 's'}</span>
        <span class="rich-tooltip-head-value">{s.runningSessionCount} running</span>
      </div>
      <StackedAreaChart points={runPoints} mode="rate" formatY={(n) => String(Math.round(n))} formatX={formatDateShort} unit="runs" />
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
