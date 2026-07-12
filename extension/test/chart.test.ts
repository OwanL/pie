import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { StackedAreaChart } from '../src/webview/panel/components/stacked-area-chart';
import { Sparkline } from '../src/webview/panel/components/sparkline';
import type { AggregateSeriesPoint } from '../src/shared/protocol/aggregate-stats';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const points: AggregateSeriesPoint[] = [
  { ms: 1_000, byProvider: [{ key: 'openai', value: 3 }], byModel: [{ key: 'openai/gpt', value: 3 }] },
  { ms: 2_000, byProvider: [{ key: 'openai', value: 5 }, { key: 'anthropic', value: 2 }], byModel: [{ key: 'openai/gpt', value: 5 }, { key: 'anthropic/claude', value: 2 }] },
  { ms: 3_000, byProvider: [{ key: 'openai', value: 5 }, { key: 'anthropic', value: 2 }], byModel: [{ key: 'openai/gpt', value: 5 }, { key: 'anthropic/claude', value: 2 }] },
];

test('StackedAreaChart renders solid stacked paths for cumulative points', () => {
  render(
    h(StackedAreaChart, { points, mode: 'cumulative', formatY: (n) => String(n), formatX: (ms) => String(ms) }),
    container,
  );
  const paths = container.querySelectorAll('path');
  assert.equal(paths.length, 2, 'expected one continuous area path per provider');
  assert.equal(container.querySelectorAll('rect').length, 0, 'cumulative areas should not have rect seams');
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
  assert.ok(container.querySelector('.chart-hover-model'), 'per-model breakdown should render');
});

test('Sparkline renders a polyline for multiple points', () => {
  render(h(Sparkline, { data: [{ ms: 0, value: 1 }, { ms: 1, value: 5 }, { ms: 2, value: 3 }] }), container);
  assert.ok(container.querySelector('polyline'));
});

test('Sparkline shows empty state for no data', () => {
  render(h(Sparkline, { data: [] }), container);
  assert.ok(container.querySelector('.sparkline--empty'));
});
