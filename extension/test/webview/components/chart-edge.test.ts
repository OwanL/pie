/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';

import { Sparkline } from '../../../src/webview/panel/components/sparkline';
import {
  StackedAreaChart,
  monotoneTangents,
  stackedBoundaryCurves,
} from '../../../src/webview/panel/components/stacked-area-chart';
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
    { ms: 1_000, byProvider: [{ key: 'openai', value: 4 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 4 }] },
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
    { ms: 1_000, byProvider: [{ key: 'openai', value: 0 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 0 }] },
    { ms: 2_000, byProvider: [{ key: 'openai', value: 0 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 0 }] },
  ];
  render(h(StackedAreaChart, { points: allZero, mode: 'cumulative', formatY: fmt, formatX: fmtX }), container);
  assert.ok(container.querySelector('svg'), 'all-zero data still renders the svg shell');
  assert.equal(container.querySelectorAll('path').length, 0, 'no area paths for all-zero contributions');
  assert.equal(container.querySelector('.chart-empty'), null, 'all-zero is not the points-length-zero empty state');
});

test('StackedAreaChart rate mode renders a single bar without crashing', () => {
  const single: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'openai', value: 5 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 5 }] },
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

test('StackedAreaChart line mode draws one unstroked-stack line per series on a shared scale', () => {
  const points: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'sessions used', value: 3 }, { key: 'peak working', value: 2 }], byModel: [] },
    { ms: 86_400_000, byProvider: [{ key: 'sessions used', value: 5 }, { key: 'peak working', value: 4 }], byModel: [] },
  ];
  render(h(StackedAreaChart, {
    points, mode: 'line', formatY: fmt, formatX: fmtX,
    colorKeys: ['sessions used', 'peak working'],
  }), container);
  const paths = [...container.querySelectorAll('path')];
  assert.equal(paths.length, 2, 'one line path per series');
  for (const path of paths) {
    assert.equal(path.getAttribute('fill'), 'none', 'lines are not filled areas');
    assert.doesNotMatch(path.getAttribute('d') ?? '', /NaN|Infinity/);
  }
  // Dots mark the exact samples (2 series × 2 points).
  assert.equal(container.querySelectorAll('circle').length, 4);
  // yMax is the largest single value (5), not the stacked sum (8): the dot for
  // the peak series' 4 must sit strictly between the top of the plot and the
  // dot for the sessions series' 5, proving the series share one non-stacked scale.
  const cys = [...container.querySelectorAll('circle')]
    .map((c) => Number(c.getAttribute('cy')))
    .filter((cy) => Number.isFinite(cy));
  assert.equal(cys.length, 4, 'all dot geometry is finite');
  assert.equal(new Set(cys).size, 4, 'each of the four sample values (2,3,4,5) maps to its own non-stacked cy');
});

test('AggregateStatsStrip renders a placeholder while not ready and a dash rate when idle', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: EMPTY_AGGREGATE_STATS,
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
  assert.match(html, /aggregate-strip--placeholder/);
  assert.match(html, /aggregate-strip-rate[^>]*>—</, 'no live rate while not ready → dash');
});

test('AggregateStatsStrip with ready zero stats shows a dash rate and no last-run segment', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
  assert.doesNotMatch(html, /aggregate-strip--placeholder/, 'ready state drops the placeholder class');
  assert.match(html, /aggregate-strip-rate[^>]*>—</, 'idle (0 tok/s) shows a dash, not 0 or NaN');
  assert.doesNotMatch(html, /aggregate-strip-dur/, 'no last-run segment when lastRun is null');
});

const cubicAt = (y0: number, c0: number, c1: number, y1: number, u: number): number =>
  (1 - u) ** 3 * y0 + 3 * (1 - u) ** 2 * u * c0 + 3 * (1 - u) * u * u * c1 + u ** 3 * y1;

/** Sample one interval's cubic (control values in value space) at u ∈ (0,1). */
function sampleInterval(interval: { start: number; startControl: number; endControl: number; end: number }, steps = 64): number[] {
  const out: number[] = [];
  for (let k = 1; k < steps; k += 1) {
    out.push(cubicAt(interval.start, interval.startControl, interval.endControl, interval.end, k / steps));
  }
  return out;
}

interface ParsedCubic { startY: number; c1y: number; c2y: number; endY: number }

/** Walk an SVG path (numbers only — the chart's own output) and return each
 *  cubic's y controls threaded with the running point (y grows downward). */
function parsePathCubicsY(d: string): ParsedCubic[] {
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  const cubics: ParsedCubic[] = [];
  let currentY = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i]!;
    if (cmd === 'C') {
      cubics.push({
        startY: currentY,
        c1y: Number(tokens[i + 2]),
        c2y: Number(tokens[i + 4]),
        endY: Number(tokens[i + 6]),
      });
      currentY = Number(tokens[i + 6]);
      i += 7;
    } else if (cmd === 'M' || cmd === 'L') {
      currentY = Number(tokens[i + 2]);
      i += 3;
    } else {
      i += 1;
    }
  }
  return cubics;
}

test('StackedAreaChart cumulative bands never cross even when independently smoothed boundaries would', () => {
  // Adversarial cumulative series: the baseline provider rises steeply and
  // then flats while the top provider stays flat and then jumps. Every ordered
  // sample keeps upper ≥ lower, but independently Fritsch–Carlson-smoothing
  // the two boundary series DOES cross mid-interval (proved below), so the
  // chart must build bands from summed per-provider contribution curves.
  const base = [0, 10, 10];
  const top = [0, 1, 10];
  const xs = [0, 1, 2];
  const upperSeries = base.map((v, i) => v + top[i]!);

  // Premise: the same smoothing applied independently to the ordered
  // boundaries produces a negative band (the old construction's defect).
  const upperTangents = monotoneTangents(xs, upperSeries);
  const lowerTangents = monotoneTangents(xs, base);
  const interval = (ys: number[], tangents: number[], i: number) => ({
    start: ys[i]!,
    startControl: ys[i]! + tangents[i]! * (xs[i + 1]! - xs[i]!) / 3,
    endControl: ys[i + 1]! - tangents[i + 1]! * (xs[i + 1]! - xs[i]!) / 3,
    end: ys[i + 1]!,
  });
  let independentMinGap = Infinity;
  for (let i = 0; i < 2; i += 1) {
    const upper = interval(upperSeries, upperTangents, i);
    const lower = interval(base, lowerTangents, i);
    const upperSamples = sampleInterval(upper);
    const lowerSamples = sampleInterval(lower);
    for (let k = 0; k < upperSamples.length; k += 1) {
      independentMinGap = Math.min(independentMinGap, upperSamples[k]! - lowerSamples[k]!);
    }
  }
  assert.ok(independentMinGap < 0, 'premise: independently smoothed ordered boundaries would cross');

  // The construction: thickness of the top band equals its own non-negative
  // contribution curve on every interval, and knots stay exact.
  const bands = stackedBoundaryCurves([base, top], xs);
  assert.equal(bands.length, 2);
  assert.deepEqual(bands[0]!.upper.map((c) => [c.start, c.end]).flat(), [0, 10, 10, 10],
    'first stack boundary passes through the exact base samples');
  assert.deepEqual(bands[1]!.upper.map((c) => [c.start, c.end]).flat(), [0, 11, 11, 20],
    'stacked totals stay exact at every knot');
  assert.deepEqual(bands[1]!.lower.map((c) => [c.start, c.end]).flat(), [0, 10, 10, 10],
    'the top band sits on the base boundary');
  for (const i of [0, 1]) {
    const thickness = sampleInterval({
      ...bands[1]!.upper[i]!,
      start: bands[1]!.upper[i]!.start - bands[1]!.lower[i]!.start,
      startControl: bands[1]!.upper[i]!.startControl - bands[1]!.lower[i]!.startControl,
      endControl: bands[1]!.upper[i]!.endControl - bands[1]!.lower[i]!.endControl,
      end: bands[1]!.upper[i]!.end - bands[1]!.lower[i]!.end,
    });
    for (const t of thickness) {
      assert.ok(t >= -1e-9, `top band thickness must never go negative, got ${t} on interval ${i}`);
    }
  }

  // End to end: the rendered top-band path samples with non-negative pixel
  // thickness (y grows downward, so the upper boundary has the smaller y).
  const points: AggregateSeriesPoint[] = [
    { ms: 1_000, byProvider: [{ key: 'base', value: 0 }, { key: 'top', value: 0 }], byModel: [] },
    { ms: 2_000, byProvider: [{ key: 'base', value: 10 }, { key: 'top', value: 1 }], byModel: [] },
    { ms: 3_000, byProvider: [{ key: 'base', value: 10 }, { key: 'top', value: 10 }], byModel: [] },
  ];
  render(h(StackedAreaChart, { points, mode: 'cumulative', formatY: fmt, formatX: fmtX }), container);
  const paths = [...container.querySelectorAll('path')];
  assert.equal(paths.length, 2, 'both providers render a band');
  const topBand = parsePathCubicsY(paths[1]!.getAttribute('d') ?? '');
  assert.equal(topBand.length, 4, 'two upper + two reversed lower intervals');
  for (let i = 0; i < 2; i += 1) {
    const upper = topBand[i]!;
    // The lower boundary is traversed right→left: reverse the parameter.
    const lower = topBand[3 - i]!;
    for (let k = 1; k < 64; k += 1) {
      const u = k / 64;
      const upperY = cubicAt(upper.startY, upper.c1y, upper.c2y, upper.endY, u);
      const lowerY = cubicAt(lower.startY, lower.c1y, lower.c2y, lower.endY, 1 - u);
      assert.ok(lowerY - upperY >= -1e-9,
        `rendered band inverted at interval ${i}, u=${u}: upper ${upperY} below lower ${lowerY}`);
    }
  }
  assert.doesNotMatch(paths[1]!.getAttribute('d') ?? '', /NaN|Infinity/);
});
