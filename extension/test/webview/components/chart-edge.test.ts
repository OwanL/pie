/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';

import { Sparkline } from '../../../src/webview/panel/components/sparkline';
import { StackedAreaChart } from '../../../src/webview/panel/components/stacked-area-chart';
import { AggregateStatsStrip } from '../../../src/webview/panel/aggregate-stats-strip';
import { EMPTY_AGGREGATE_STATS } from '../../../src/shared/protocol';
import type { AggregateSeriesPoint } from '../../../src/shared/protocol/aggregate-stats';

/**
 * Zero / single-point boundary tests for the extension's status-strip charts.
 * These components render inside high-frequency tooltips and must never emit
 * `NaN`/`Infinity` geometry or crash on degenerate inputs (empty runs, a single
 * turn, all-zero throughput). Disjoint from chart.test.ts, which covers the
 * multi-point and hover paths.
 */

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const fmt = (n: number) => String(n);
const fmtX = (ms: number) => String(ms);

test('Sparkline renders a single point as a marker dot plus a degenerate polyline', () => {
  render(h(Sparkline, { data: [{ ms: 500, value: 7 }] }), container);
  const polyline = container.querySelector('polyline');
  assert.ok(polyline, 'single-point sparkline still emits a polyline');
  assert.ok(container.querySelector('circle'), 'single-point sparkline emits a marker dot');
  assert.doesNotMatch(polyline!.getAttribute('points') ?? '', /NaN|Infinity/, 'no NaN in points');
});

test('Sparkline with all-zero values renders without NaN geometry', () => {
  render(h(Sparkline, { data: [{ ms: 0, value: 0 }, { ms: 10, value: 0 }, { ms: 20, value: 0 }] }), container);
  const polyline = container.querySelector('polyline')!;
  assert.ok(polyline);
  assert.doesNotMatch(polyline.getAttribute('points') ?? '', /NaN|Infinity/, 'zero values must not produce NaN coordinates');
  assert.equal(container.querySelector('.sparkline--empty'), null, 'non-empty data is not the empty state');
});

test('Sparkline with a single zero value renders a marker without NaN', () => {
  render(h(Sparkline, { data: [{ ms: 0, value: 0 }] }), container);
  assert.ok(container.querySelector('circle'));
  const polyline = container.querySelector('polyline')!;
  assert.doesNotMatch(polyline.getAttribute('points') ?? '', /NaN|Infinity/);
});

test('StackedAreaChart renders a single cumulative point without crashing', () => {
  const single: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'openai', value: 4 }], byModel: [{ key: 'openai/gpt', value: 4 }] },
  ];
  render(h(StackedAreaChart, { points: single, mode: 'cumulative', formatY: fmt, formatX: fmtX }), container);
  assert.ok(container.querySelector('svg'), 'single-point chart still renders an svg');
  assert.equal(container.querySelector('.chart-empty'), null, 'a point with a positive value is not the empty state');
  // No NaN leaked into path geometry.
  const d = container.querySelector('path')?.getAttribute('d') ?? '';
  assert.doesNotMatch(d, /NaN|Infinity/, 'single-point path must not contain NaN');
});

test('StackedAreaChart with all-zero point totals renders no area paths and no NaN', () => {
  // yMax is floored to 1 when all points total zero, so the empty-state guard
  // (which only fires for points.length === 0) does not trigger; instead every
  // provider band is skipped as non-contributing, leaving an empty axis.
  const allZero: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'openai', value: 0 }], byModel: [{ key: 'openai/gpt', value: 0 }] },
    { ms: 2_000, byProvider: [{ key: 'openai', value: 0 }], byModel: [{ key: 'openai/gpt', value: 0 }] },
  ];
  render(h(StackedAreaChart, { points: allZero, mode: 'cumulative', formatY: fmt, formatX: fmtX }), container);
  assert.ok(container.querySelector('svg'), 'all-zero data still renders the svg shell');
  assert.equal(container.querySelectorAll('path').length, 0, 'no area paths for all-zero contributions');
  assert.equal(container.querySelector('.chart-empty'), null, 'all-zero is not the points-length-zero empty state');
});

test('StackedAreaChart rate mode renders a single bar without crashing', () => {
  const single: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'openai', value: 5 }], byModel: [{ key: 'openai/gpt', value: 5 }] },
  ];
  render(h(StackedAreaChart, { points: single, mode: 'rate', formatY: fmt, formatX: fmtX }), container);
  const rects = container.querySelectorAll('rect');
  assert.ok(rects.length >= 1, 'single rate point renders at least one bar');
  for (const rect of rects) {
    const y = Number(rect.getAttribute('y'));
    const height = Number(rect.getAttribute('height'));
    assert.ok(Number.isFinite(y) && Number.isFinite(height), 'bar geometry must be finite');
  }
});

test('AggregateStatsStrip renders a placeholder while not ready and a dash rate when idle', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: EMPTY_AGGREGATE_STATS,
  }));
  assert.match(html, /aggregate-strip--placeholder/);
  assert.match(html, /aggregate-strip-rate[^>]*>—</, 'no live rate while not ready → dash');
});

test('AggregateStatsStrip with ready zero stats shows a dash rate and no last-run segment', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true },
  }));
  assert.doesNotMatch(html, /aggregate-strip--placeholder/, 'ready state drops the placeholder class');
  assert.match(html, /aggregate-strip-rate[^>]*>—</, 'idle (0 tok/s) shows a dash, not 0 or NaN');
  assert.doesNotMatch(html, /aggregate-strip-dur/, 'no last-run segment when lastRun is null');
});
