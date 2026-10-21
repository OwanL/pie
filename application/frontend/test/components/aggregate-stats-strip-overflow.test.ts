import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { EMPTY_AGGREGATE_STATS } from '../../../lib/protocol/index.js';
import { AggregateStatsStrip } from '../../analytics/aggregate-stats-strip';
import { allocateAggregateStrip } from '../../analytics/aggregate-stats-strip/allocation';

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

test('measured row shrinks, restores, remeasures large values and keeps hidden copies inert', () => {
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
  const draw = (ready = true, pending = false, cost = 0) => act(() => render(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready, todayCost: cost },
    deferredTriggers: pending ? [{ id: 'timer', sessionPath: '/session', triggers: [{ kind: 'timer', ms: 10 }], note: 'resume', registeredAt: '', deliveryState: 'pending' }] : [],
    onOpenDeferredMenu: () => {},
  }), root));
  const keys = () => [...root.querySelectorAll('[data-stat]')].map((el) => el.getAttribute('data-stat'));
  try {
    draw(false);
    assert.deepEqual(keys(), ['today', 'week', 'input', 'output', 'open']);
    draw(true, true);
    assert.deepEqual(keys(), ['today', 'deferred', 'week', 'input', 'output']);
    const today = root.querySelector('[data-stat="today"] [tabindex]');
    width = 100;
    act(() => notify());
    assert.deepEqual(keys(), ['today'], 'deferred is not reserved ahead of today');
    width = 1000;
    act(() => notify());
    assert.deepEqual(keys(), ['today', 'deferred', 'week', 'input', 'output', 'open', 'working', 'snoozed']);
    assert.equal(root.querySelector('[data-stat="today"] [tabindex]'), today);
    width = 0;
    act(() => notify());
    assert.equal(keys().length, 8, 'transient hidden width does not clear the row');
    width = 360;
    todayWidth = 280;
    draw(true, true, 123456789.12);
    assert.deepEqual(keys(), ['today', 'deferred']);
    assert.match(root.querySelector('[data-stat="today"]')!.textContent!, /\$123456789\.12/);
    const measurement = root.querySelector('.aggregate-strip-measurements')!;
    assert.equal(measurement.getAttribute('aria-hidden'), 'true');
    assert.ok(measurement.hasAttribute('inert'));
    assert.equal(measurement.querySelectorAll('button, [tabindex], [id], .pie-tooltip-trigger').length, 0);
    todayWidth = 80;
    draw(true, false);
    assert.deepEqual(keys(), ['today', 'week', 'input', 'output', 'open']);
    act(() => render(null, root));
    assert.ok(disconnected > 0);
  } finally {
    render(null, root);
    root.remove();
    globalThis.ResizeObserver = original;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});
