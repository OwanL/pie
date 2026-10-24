import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { EMPTY_AGGREGATE_STATS } from '../../../lib/protocol/index.js';
import { AggregateStatsStrip } from '../../analytics/aggregate-stats-strip';
import { allocateAggregateStrip } from '../../analytics/aggregate-stats-strip/allocation';
import { MeasuredRow } from '../../analytics/aggregate-stats-strip/measured-row';

// The cost pair no longer uses allocation, but the standalone helper retains its contract.
test('strict priority allocation fits complete prefixes, including gaps and unready measurements', () => {
  assert.equal(allocateAggregateStrip(200, [80, 50, 60]), 2);
  assert.equal(allocateAggregateStrip(79, [80, 10]), 0);
  assert.equal(allocateAggregateStrip(138, [80, 50]), 2);
  assert.equal(allocateAggregateStrip(137.9, [80, 50]), 1);
  assert.equal(allocateAggregateStrip(0, [80]), 0);
  assert.equal(allocateAggregateStrip(400, [80, 0, 60]), 1);
  assert.equal(allocateAggregateStrip(400, []), 0);
  assert.equal(allocateAggregateStrip(400, [Infinity]), 0);
});

test('standalone measured row shrinks, restores, remeasures, and keeps measurement copies inert', () => {
  const original = globalThis.ResizeObserver;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let notify = () => {};
  let width = 360;
  let todayWidth = 80;
  let disconnected = 0;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { notify = callback; }
    observe() {}
    disconnect() { disconnected++; }
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.classList.contains('aggregate-strip-metrics') ? width : this.getAttribute('data-measure-stat') === 'today' ? todayWidth : 60 } as DOMRect;
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const draw = () => act(() => render(h(MeasuredRow, {
    items: ['today', 'week', 'input'].map((key) => ({ key, body: h('span', null, key), tooltip: h('span', null, key), label: key })),
  }), root));
  const keys = () => [...root.querySelectorAll('[data-stat]')].map((el) => el.getAttribute('data-stat'));
  try {
    draw();
    assert.deepEqual(keys(), ['today', 'week', 'input']);
    const today = root.querySelector('[data-stat="today"] [tabindex]');
    width = 100;
    act(() => notify());
    assert.deepEqual(keys(), ['today']);
    width = 1000;
    act(() => notify());
    assert.deepEqual(keys(), ['today', 'week', 'input']);
    assert.equal(root.querySelector('[data-stat="today"] [tabindex]'), today);
    width = 0;
    act(() => notify());
    assert.equal(keys().length, 3, 'transient hidden width does not clear the row');
    width = 360;
    todayWidth = 280;
    draw();
    assert.deepEqual(keys(), ['today', 'week']);
    const measurement = root.querySelector('.aggregate-strip-measurements')!;
    assert.equal(measurement.getAttribute('aria-hidden'), 'true');
    assert.ok(measurement.hasAttribute('inert'));
    assert.equal(measurement.querySelectorAll('button, [tabindex], [id], .pie-tooltip-trigger').length, 0);
    act(() => render(null, root));
    assert.ok(disconnected > 0);
  } finally {
    act(() => render(null, root));
    root.remove();
    globalThis.ResizeObserver = original;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test('intrinsic cost pair retains both anchors at zero width and through large-value updates', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () { return { width: 0 } as DOMRect; };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const draw = (ready: boolean, cost: number) => act(() => render(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready, todayCost: cost },
  }), root));
  const keys = () => [...root.querySelectorAll('[data-stat]')].map((el) => el.getAttribute('data-stat'));
  try {
    draw(false, 0);
    assert.deepEqual(keys(), ['today', 'week']);
    assert.match(root.innerHTML, /Usage stats: computing/);
    const today = root.querySelector('[data-stat="today"] [tabindex]');
    draw(true, 123456789.12);
    assert.deepEqual(keys(), ['today', 'week']);
    assert.equal(root.querySelector('[data-stat="today"] [tabindex]'), today);
    assert.match(root.textContent!, /\$123456789\.12/);
    assert.equal(root.querySelector('[data-measure-stat]'), null);
    assert.equal(root.querySelector('[inert]'), null);
  } finally {
    act(() => render(null, root));
    root.remove();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});
