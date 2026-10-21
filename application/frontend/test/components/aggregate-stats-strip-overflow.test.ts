import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { EMPTY_AGGREGATE_STATS } from '../../../lib/protocol/index.js';
import { AggregateStatsStrip } from '../../analytics/aggregate-stats-strip';

test('metric fades follow overflow edges, resize and content updates without changing targets', () => {
  const original = globalThis.ResizeObserver;
  let notify = () => {};
  let disconnected = 0;
  const observed = new Set<Element>();
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { notify = callback; }
    observe(el: Element) { observed.add(el); }
    disconnect() { disconnected++; }
  } as unknown as typeof ResizeObserver;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const draw = (cost = 0) => act(() => render(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true, todayCost: cost },
    deferredTriggers: [], onOpenDeferredMenu: () => {},
  }), root));
  try {
    draw();
    const metrics = root.querySelector<HTMLElement>('.aggregate-strip-metrics')!;
    const targets = metrics.querySelectorAll('[tabindex="0"]');
    const fades = (left: boolean, right: boolean) => {
      assert.equal(metrics.classList.contains('aggregate-strip-metrics--fade-left'), left);
      assert.equal(metrics.classList.contains('aggregate-strip-metrics--fade-right'), right);
    };
    const size = (width: number, content: number) => {
      Object.defineProperty(metrics, 'clientWidth', { configurable: true, value: width });
      Object.defineProperty(metrics, 'scrollWidth', { configurable: true, value: content });
    };
    fades(false, false);
    size(344, 366);
    act(() => notify());
    fades(false, true);
    assert.ok(observed.has(metrics));
    assert.ok(observed.has(metrics.firstElementChild!));
    act(() => { metrics.scrollLeft = 11; metrics.dispatchEvent(new Event('scroll')); });
    fades(true, true);
    act(() => { metrics.scrollLeft = 22; metrics.dispatchEvent(new Event('scroll')); });
    fades(true, false);
    size(500, 366);
    act(() => notify());
    fades(false, false);
    metrics.scrollLeft = 0;
    size(344, 366);
    draw(1);
    fades(false, true);
    size(344, 340);
    draw(2);
    fades(false, false);
    assert.deepEqual([...metrics.querySelectorAll('[tabindex="0"]')], [...targets]);
    act(() => render(null, root));
    assert.ok(disconnected > 0);
  } finally {
    render(null, root);
    root.remove();
    globalThis.ResizeObserver = original;
  }
});
