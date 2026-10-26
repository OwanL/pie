import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });

let useScrollEventsEffect: typeof import('../../../transcript/use-transcript-scroll-events').useScrollEventsEffect;
test.before(async () => {
  ({ useScrollEventsEffect } = await import('../../../transcript/use-transcript-scroll-events'));
});

for (const intent of [null, 'pointerdown', 'wheel', 'keydown', 'touchstart'] as const) {
  test(`pending follow write clamped by measurement: ${intent ?? 'no input'}`, () => {
    const root = document.getElementById('root')!;
    const element = document.createElement('div');
    // The write targeted 17186 under an estimated max of 17248. Measurement
    // clamps it to 17168, then the range grows 6px before the event arrives.
    Object.defineProperty(element, 'scrollHeight', { value: 17274 });
    Object.defineProperty(element, 'clientHeight', { value: 100 });
    element.scrollTop = 17168;
    const autoFollow = { current: true };
    const manual = { current: false };
    const expected = { current: 17186 as number | null };
    const previous = { current: 17186 };
    function Probe() {
      useScrollEventsEffect(
        { current: element }, autoFollow, previous, manual,
        (value) => { manual.current = value; }, expected, () => {},
        (value) => { autoFollow.current = value; }, false, () => {}, 'session', { current: false },
      );
      return null;
    }
    try {
      act(() => { render(h(Probe, {}), root); });
      if (intent) {
        const event = intent === 'keydown'
          ? new dom.window.KeyboardEvent(intent, { key: 'ArrowUp' })
          : intent === 'pointerdown'
            ? new dom.window.MouseEvent(intent, { button: 0 })
            : new dom.window.Event(intent);
        element.dispatchEvent(event);
      }
      element.dispatchEvent(new dom.window.Event('scroll'));
      assert.equal(expected.current, null, 'the pending write is consumed');
      assert.equal(manual.current, intent !== null);
      assert.equal(autoFollow.current, intent === null, 'only the layout-owned clamp retains follow');
      // With no pending write, upward movement still catches native gutter
      // scrolling even on browsers that omit pointerdown.
      if (!intent) {
        element.scrollTop -= 6;
        element.dispatchEvent(new dom.window.Event('scroll'));
        assert.equal(manual.current, true);
        assert.equal(autoFollow.current, false);
      }
    } finally {
      act(() => { render(null, root); });
    }
  });
}
