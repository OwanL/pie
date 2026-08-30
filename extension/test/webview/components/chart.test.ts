import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { StackedAreaChart } from '../../../src/webview/panel/components/stacked-area-chart';
import { Sparkline } from '../../../src/webview/panel/components/sparkline';
import type { AggregateSeriesPoint } from '../../../src/shared/protocol/aggregate-stats';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const points: AggregateSeriesPoint[] = [
  { ms: 1_000, byProvider: [{ key: 'openai', value: 3 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 3 }] },
  { ms: 2_000, byProvider: [{ key: 'openai', value: 5 }, { key: 'anthropic', value: 2 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 5 }, { key: 'claude', provider: 'anthropic', model: 'claude', value: 2 }] },
  { ms: 3_000, byProvider: [{ key: 'openai', value: 5 }, { key: 'anthropic', value: 2 }], byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: 5 }, { key: 'claude', provider: 'anthropic', model: 'claude', value: 2 }] },
];

test('StackedAreaChart renders solid stacked paths for cumulative points', () => {
  render(
    h(StackedAreaChart, { points, mode: 'cumulative', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  const paths = container.querySelectorAll('path');
  assert.equal(paths.length, 2, 'expected one continuous area path per provider');
  assert.equal(new Set([...paths].map((path) => path.getAttribute('fill'))).size, 2,
    'providers in the same chart must have distinguishable fills');
  assert.equal(container.querySelectorAll('rect').length, 0, 'cumulative areas should not have rect seams');
  for (const path of paths) {
    const d = path.getAttribute('d') ?? '';
    assert.match(d, / C /, 'cumulative areas should use smooth cubic curves');
    assert.doesNotMatch(d, /\s[HV]\s/, 'smooth cumulative areas must not use stepped segments');
  }
  // Axis labels present (first + last x).
  const axis = container.querySelector('.chart-axis');
  assert.ok(axis);
});

test('StackedAreaChart renders spaced bars in rate mode', () => {
  render(
    h(StackedAreaChart, { points, mode: 'rate', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  const rects = container.querySelectorAll('rect');
  assert.ok(rects.length >= 3, `expected bars, got ${rects.length}`);
});

test('StackedAreaChart exposes all provider-qualified hover details in an SR table', () => {
  render(
    h(StackedAreaChart, { points, mode: 'cumulative', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  const table = container.querySelector('.chart-a11y-table');
  assert.ok(table, 'screen-reader table should accompany the visual chart');
  assert.match(table!.textContent ?? '', /openai/);
  assert.match(table!.textContent ?? '', /gpt \(openai\)/);
  assert.match(table!.textContent ?? '', /anthropic/);
  assert.match(table!.textContent ?? '', /claude \(anthropic\)/);
  assert.equal(table!.querySelectorAll('[tabindex]').length, 0, 'chart samples are not tab stops');
  assert.equal(table!.querySelectorAll('tbody tr').length, 10, 'provider and model rows cover every point');
});

test('StackedAreaChart bounds long-series accessibility tables with representative points', () => {
  const longSeries: AggregateSeriesPoint[] = Array.from({ length: 180 }, (_, index) => ({
    ms: index,
    byProvider: [{ key: 'openai', value: index }],
    byModel: [{ key: 'gpt', provider: 'openai', model: 'gpt', value: index }],
  }));
  render(
    h(StackedAreaChart, { points: longSeries, mode: 'rate', formatY: String, formatX: String }),
    container,
  );

  const table = container.querySelector('.chart-a11y-table')!;
  assert.match(table.querySelector('caption')?.textContent ?? '', /12 representative points from 180/);
  assert.equal(table.querySelectorAll('tbody tr').length, 24, '12 samples × provider and model rows');
  assert.match(table.textContent ?? '', /179/, 'the final sample remains represented');
});

test('StackedAreaChart shows empty state when there is no data', () => {
  render(
    h(StackedAreaChart, { points: [], mode: 'cumulative', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  assert.ok(container.querySelector('.chart-empty'));
  assert.equal(container.querySelectorAll('rect').length, 0);
});

test('StackedAreaChart hover crosshair + per-model box appears on mousemove', () => {
  render(
    h(StackedAreaChart, { points, mode: 'cumulative', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  const svg = container.querySelector('svg')!;
  assert.equal(container.querySelector('.chart-hover'), null, 'no hover box before mousemove');
  act(() => {
    svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 10 }));
  });
  assert.ok(container.querySelector('.chart-hover'), 'hover box should appear after mousemove');
  assert.ok(container.querySelector('.chart-hover-provider'), 'provider grouping should render');
  assert.ok(container.querySelector('.chart-hover-model'), 'provider-qualified model breakdown should render');
});

test('Sparkline renders a polyline for multiple points', () => {
  render(h(Sparkline, { data: [{ ms: 0, value: 1 }, { ms: 1, value: 5 }, { ms: 2, value: 3 }] }), container);
  assert.ok(container.querySelector('polyline'));
});

test('Sparkline shows empty state for no data', () => {
  render(h(Sparkline, { data: [] }), container);
  assert.ok(container.querySelector('.sparkline--empty'));
});
