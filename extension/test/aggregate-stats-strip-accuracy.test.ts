import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  AggregateStatsStrip,
  formatProxyStripSummary,
  summarizeProxyStrip,
} from '../src/webview/panel/aggregate-stats-strip';
import type {
  AggregateStats,
  DeferredTriggerView,
  ProxyProviderMetrics,
} from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// Accuracy tests for the bottom status strip (aggregate-stats-strip).
//
// `aggregate-stats.test.ts` already covers the happy path of the pure
// `summarizeProxyStrip` / `formatProxyStripSummary` helpers (mixed providers,
// one idle provider, empty → null). This file extends coverage to the edges
// that render to users and were untested:
//   • concurrency overflow (active > max) — does the headline show the real
//     active count over max, and the `!`/`+Nq` suffix pick correctly?
//   • queued-only providers (0 active, N queued).
//   • deferred-trigger counts shown to the user equal the source array length
//     (singular/plural), rendered via the JSX strip.
//   • the rendered strip string never leaks `undefined` / `NaN` for a matrix
//     of inputs (empty / single / overflow / queued / deferred / running).
// The strip is a pure projection of host-owned `AggregateStats`, so SSR
// rendering it to a string and asserting on the markup is a faithful check of
// what users see.
// ---------------------------------------------------------------------------

const noop = () => undefined;

function makeStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
  return {
    todayCost: 0,
    todayCostByProvider: [],
    todayTokensPerSecond: 0,
    todayTokensPerSecondByProvider: [],
    todayRunCount: 0,
    todayInputTokens: 0,
    todayOutputTokens: 0,
    todayToolCallCount: 0,
    todayTouchedFileCount: 0,
    weekCost: 0,
    weekCostByProvider: [],
    weekRunCount: 0,
    dailyCost: [],
    liveTokensPerSecond: 0,
    runningSessionCount: 0,
    openTabCount: 1,
    warmBash: {
      enabled: false,
      poolSize: 0,
      ready: 0,
      warming: 0,
      fastPathEnabled: false,
      totalFastPath: 0,
      totalWarm: 0,
      totalFallback: 0,
      totalWarmupFailures: 0,
    },
    totalCost: 0,
    costByProvider: [],
    tokensPerSecond: 0,
    tokensPerSecondByProvider: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    runCount: 0,
    sessionCount: 0,
    lastRun: null,
    ready: true,
    ...overrides,
  };
}

function metric(
  provider: string,
  active: number,
  queued: number,
  max: number,
): ProxyProviderMetrics {
  return {
    provider,
    modelInfoId: `${provider}-shared`,
    activeRequests: active,
    queuedRequests: queued,
    maxConcurrentRequests: max,
  };
}

function trigger(id: string, sessionPath = `/s/${id}`): DeferredTriggerView {
  return {
    id,
    sessionPath,
    triggers: [{ kind: 'timer', ms: 5 * 60_000 }],
    note: `task ${id}`,
    registeredAt: '2026-07-07T10:00:00.000Z',
  };
}

/** Render the strip to a string with the given props. */
function render(
  stats: AggregateStats,
  opts: { proxyMetrics?: ProxyProviderMetrics[]; deferredTriggers?: DeferredTriggerView[] } = {},
): string {
  return renderToString(
    h(AggregateStatsStrip, {
      stats,
      proxyMetrics: opts.proxyMetrics,
      deferredTriggers: opts.deferredTriggers ?? [],
      onOpenDeferredMenu: noop,
    }),
  );
}

/** A user-facing string must never literally contain the tokens `undefined`
 *  or `NaN` (those would surface a missing/invalid computation to users). */
function assertNoUndefinedOrNaNo(s: string): void {
  assert.doesNotMatch(s, /undefined/, `strip leaked "undefined": ${s}`);
  assert.doesNotMatch(s, /NaN/, `strip leaked "NaN": ${s}`);
}

// ── summarizeProxyStrip / formatProxyStripSummary edge cases ────────────────

test('summarizeProxyStrip: concurrency overflow (active > max) keeps the real active count and marks maxedOut', () => {
  // active (5) exceeds max (3): the headline must show the truthful 5/3, and
  // maxedOut is true even though active > max (>= not ===). With no queue the
  // `!` suffix fires; with a queue the `+Nq` suffix takes precedence.
  const summaries = summarizeProxyStrip([metric('umans', 5, 0, 3)]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.activeRequests, 5);
  assert.equal(summaries[0]!.maxConcurrentRequests, 3);
  assert.equal(summaries[0]!.maxedOut, true);
  assert.equal(formatProxyStripSummary(summaries), 'umans 5/3!');
});

test('summarizeProxyStrip: overflow with a queue shows +Nq (not the ! suffix)', () => {
  const summaries = summarizeProxyStrip([metric('umans', 5, 2, 3)]);
  assert.equal(formatProxyStripSummary(summaries), 'umans 5/3 +2q');
});

test('summarizeProxyStrip: queued-only provider (0 active, N queued) is not maxedOut and renders 0/N +Nq', () => {
  const summaries = summarizeProxyStrip([metric('openrouter', 0, 4, 3)]);
  assert.equal(summaries[0]!.maxedOut, false);
  assert.equal(formatProxyStripSummary(summaries), 'openrouter 0/3 +4q');
});

test('summarizeProxyStrip: sorts by queued desc then active desc then provider name', () => {
  const summaries = summarizeProxyStrip([
    metric('bravo', 1, 0, 4), // no queue, some active
    metric('alpha', 0, 5, 4), // biggest queue → first
    metric('charlie', 3, 5, 4), // tied queue, more active → before alpha
    metric('delta', 1, 0, 4), // tied (0q,1a) with bravo → name tiebreak: bravo before delta
  ]);
  assert.deepEqual(
    summaries.map((s) => s.provider),
    ['charlie', 'alpha', 'bravo', 'delta'],
  );
  assert.equal(
    formatProxyStripSummary(summaries),
    'charlie 3/4 +5q, alpha 0/4 +5q, bravo 1/4, delta 1/4',
  );
});

// ── Rendered strip: deferred-trigger counts equal the source length ─────────

test('rendered strip: deferred count equals the source deferredTriggers.length (plural)', () => {
  const triggers = [trigger('1'), trigger('2'), trigger('3')];
  const html = render(makeStats({ runningSessionCount: 0 }), { deferredTriggers: triggers });
  // The visible count chip.
  assert.match(html, /<span class="aggregate-strip-deferred-count">3 deferred<\/span>/);
  // The native title + aria-label carry the plural form.
  assert.match(html, /title="Pending deferred triggers — click to cancel"/);
  assert.match(
    html,
    /aria-label="3 pending deferred triggers\. Click to open cancel menu\."/,
  );
  assertNoUndefinedOrNaNo(html);
});

test('rendered strip: a single deferred trigger uses the singular form', () => {
  const triggers = [trigger('1')];
  const html = render(makeStats({ runningSessionCount: 0 }), { deferredTriggers: triggers });
  assert.match(html, /<span class="aggregate-strip-deferred-count">1 deferred<\/span>/);
  assert.match(html, /title="Pending deferred trigger — click to cancel"/);
  assert.match(
    html,
    /aria-label="1 pending deferred trigger\. Click to open cancel menu\."/,
  );
  assertNoUndefinedOrNaNo(html);
});

test('rendered strip: no deferred segment when there are no deferred triggers', () => {
  const html = render(makeStats({ runningSessionCount: 0 }), { deferredTriggers: [] });
  assert.doesNotMatch(html, /aggregate-strip-deferred/);
  assert.doesNotMatch(html, /Pending deferred/);
});

// ── Rendered strip: proxy headline is the source-derived value ──────────────

test('rendered strip: proxy segment shows the exact formatProxyStripSummary headline', () => {
  const proxyMetrics = [metric('umans', 5, 2, 3), metric('openrouter', 1, 0, 2)];
  const html = render(makeStats(), { proxyMetrics });
  const expected = formatProxyStripSummary(summarizeProxyStrip(proxyMetrics));
  assert.equal(expected, 'umans 5/3 +2q, openrouter 1/2');
  assert.match(html, /<span class="aggregate-strip-proxy-value">umans 5\/3 \+2q, openrouter 1\/2<\/span>/);
  assertNoUndefinedOrNaNo(html);
});

test('rendered strip: no proxy segment when there are no providers', () => {
  const html = render(makeStats(), { proxyMetrics: [] });
  assert.doesNotMatch(html, /aggregate-strip-proxy/);
});

test('rendered strip: idle proxy provider renders 0/N and the idle modifier', () => {
  const proxyMetrics = [metric('openrouter', 0, 0, 4)];
  const html = render(makeStats(), { proxyMetrics });
  assert.equal(formatProxyStripSummary(summarizeProxyStrip(proxyMetrics)), 'openrouter 0/4');
  assert.match(html, /<span class="aggregate-strip-proxy-value">openrouter 0\/4<\/span>/);
  assert.match(html, /aggregate-strip-proxy--idle/);
  assertNoUndefinedOrNaNo(html);
});

// ── Rendered strip: cost / tab / active numbers are source-accurate ──────────

test('rendered strip: today/week cost segments render exact source values', () => {
  // 0.5 → 4 fraction digits (< $1); 12.34 → 2 fraction digits (≥ $1).
  const html = render(makeStats({ todayCost: 0.5, weekCost: 12.34 }));
  assert.match(html, /<span class="aggregate-strip-cost">\$0\.5000<\/span>/);
  assert.match(html, /<span class="aggregate-strip-cost">\$12\.34<\/span>/);
  assertNoUndefinedOrNaNo(html);
});

test('rendered strip: zero cost renders $0.00 (not $0 or empty)', () => {
  const html = render(makeStats({ todayCost: 0, weekCost: 0 }));
  // Both visible cost segments render the zero placeholder. (The aria-label
  // also embeds $0.00, so scope the count to the visible cost span.)
  const zeros = (html.match(/aggregate-strip-cost">\$0\.00/g) ?? []).length;
  assert.equal(zeros, 2);
  assertNoUndefinedOrNaNo(html);
});

test('rendered strip: tab count is source-accurate with singular/plural', () => {
  const one = render(makeStats({ openTabCount: 1 }));
  // The counts segment carries two classes; assert on the visible content.
  assert.match(one, /aggregate-strip-counts">1 tab</);
  // No plural "tabs" in the visible counts segment (aria-label says "open tabs"
  // but with "open" between, so "1 tabs" never appears).
  assert.doesNotMatch(one, /1 tabs/);
  const three = render(makeStats({ openTabCount: 3 }));
  assert.match(three, /aggregate-strip-counts">3 tabs</);
  assertNoUndefinedOrNaNo(three);
});

test('rendered strip: running session count is source-accurate and only shown when running', () => {
  const idle = render(makeStats({ runningSessionCount: 0 }));
  assert.doesNotMatch(idle, /aggregate-strip-active/);
  assert.doesNotMatch(idle, /0 active/);

  // 5.5 tok/s (< 10) renders with one decimal (formatRate), exercising the
  // sub-10 path; values >= 10 are integer-rounded.
  const running = render(makeStats({ runningSessionCount: 2, liveTokensPerSecond: 5.5 }));
  assert.match(running, /aggregate-strip-active/);
  assert.match(running, /2 active/);
  // Live tag + live rate surface when running (rateSource === 'live').
  assert.match(running, /aggregate-strip-live-tag/);
  assert.match(running, /aggregate-strip-rate">5\.5/);
  assertNoUndefinedOrNaNo(running);
});

// ── Rendered strip: undefined/NaN leak guard across an input matrix ─────────

test('rendered strip: never leaks undefined/NaN across empty/single/overflow/queued/deferred matrix', () => {
  const cases: Array<{ name: string; stats: AggregateStats; proxyMetrics?: ProxyProviderMetrics[]; deferred?: DeferredTriggerView[] }> = [
    { name: 'empty (not ready)', stats: makeStats({ ready: false, openTabCount: 0 }) },
    { name: 'idle single tab', stats: makeStats({ openTabCount: 1 }) },
    {
      name: 'overflow + queued + running + deferred',
      stats: makeStats({
        runningSessionCount: 2,
        liveTokensPerSecond: 100,
        todayCost: 0.25,
        weekCost: 9.99,
        todayInputTokens: 1_234_567,
        todayOutputTokens: 89_012,
      }),
      proxyMetrics: [metric('umans', 5, 3, 3), metric('openrouter', 2, 0, 4)],
      deferred: [trigger('1'), trigger('2')],
    },
    {
      name: 'queued-only proxy',
      stats: makeStats(),
      proxyMetrics: [metric('openrouter', 0, 7, 4)],
    },
    {
      name: 'many deferred triggers',
      stats: makeStats({ runningSessionCount: 1, liveTokensPerSecond: 12.5 }),
      deferred: [trigger('1'), trigger('2'), trigger('3'), trigger('4')],
    },
    {
      name: 'last run present',
      stats: makeStats({
        lastRun: {
          cost: 0.1234,
          durationMs: 90_000,
          modelId: 'gpt-test',
          provider: 'openai',
          outcome: null,
          startedAt: '2026-07-07T09:00:00.000Z',
          endedAt: '2026-07-07T09:01:30.000Z',
          inputTokens: 5_000,
          outputTokens: 1_200,
        },
      }),
    },
  ];

  for (const c of cases) {
    const html = render(c.stats, { proxyMetrics: c.proxyMetrics, deferredTriggers: c.deferred });
    assertNoUndefinedOrNaNo(html);
  }
});