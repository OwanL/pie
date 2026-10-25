import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useToolPreviewMotion } from '../../../transcript/tool-call-card/use-tool-preview-motion';

test('preview height motion is immediate-content, reversible, reduced-motion safe and cleaned up', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const prototype = window.HTMLElement.prototype;
  const originalAnimate = prototype.animate;
  const originalRect = prototype.getBoundingClientRect;
  const originalMedia = window.matchMedia;
  const originalObserver = globalThis.ResizeObserver;
  let height = 26;
  let current = 34;
  let resize = () => {};
  let disconnected = false;
  let reduced = false;
  let mediaChange = () => {};
  const entries: Array<{ frames: Keyframe[]; duration: number; cancelled: boolean; finish: () => void }> = [];
  prototype.getBoundingClientRect = function () { return { height: this.className === 'content' ? height : current } as unknown as DOMRect; };
  prototype.animate = function (frames, options) {
    const { duration, easing } = options as KeyframeAnimationOptions;
    assert.equal(easing, duration === 200 ? 'ease-in-out' : 'ease-out');
    let finish = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const entry = { frames: frames as Keyframe[], duration: Number(duration), cancelled: false, finish };
    entries.push(entry);
    return { finished, cancel: () => { entry.cancelled = true; } } as unknown as Animation;
  };
  window.matchMedia = (() => ({ get matches() { return reduced; }, addEventListener: (_: string, cb: () => void) => { mediaChange = cb; }, removeEventListener: () => { mediaChange = () => {}; } })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() { disconnected = true; } } as unknown as typeof ResizeObserver;
  function Preview({ text, open = false }: { text: string; open?: boolean }) {
    const motion = useToolPreviewMotion(text, open);
    return h('div', { ref: motion.wrapperRef }, h('div', { ref: motion.contentRef, class: 'content' }, text));
  }
  const paint = (text: string, open = false) => { act(() => { render(h(Preview, { text, open }), container); }); };
  try {
    paint('one'); assert.equal(entries.length, 0);
    height = 42; paint('one\ntwo');
    assert.equal(container.textContent, 'one\ntwo');
    assert.deepEqual(entries[0].frames, [{ height: '26px' }, { height: '42px' }]);
    height = 58; paint('one\ntwo\nthree');
    assert.equal(entries[0].cancelled, true);
    assert.equal(entries[1].frames[0].height, '34px');
    height = 0; paint('');
    assert.equal(container.textContent, '');
    assert.equal(entries[2].frames[1].height, '0px');
    await act(async () => { entries[0].finish(); await Promise.resolve(); });
    assert.ok(container.firstElementChild?.hasAttribute('data-preview-moving'));
    reduced = true; act(() => { mediaChange(); });
    assert.equal(entries[2].cancelled, true);
    assert.equal((container.firstElementChild as HTMLElement).style.height, '');
    reduced = false; height = 26; paint('new');
    height = 42; act(() => { resize(); });
    assert.equal(entries.at(-1)?.frames[1].height, '42px', 'active resize retargets');
    await act(async () => { entries.at(-1)!.finish(); await Promise.resolve(); });
    const count = entries.length;
    height = 58; act(() => { resize(); }); assert.equal(entries.length, count, 'idle resize stays natural');
    height = 0; paint('', true); assert.equal(entries.length, count + 1, 'preview space collapses alongside the manual disclosure');
    assert.equal(entries.at(-1)?.duration, 200);
    height = 26; paint('return', false); assert.equal(entries.length, count + 2);
    assert.equal(entries.at(-1)?.duration, 200);
    height = 42; paint('updated');
    act(() => { render(null, container); });
    assert.equal(entries.at(-1)?.cancelled, true);
    assert.equal(disconnected, true);
  } finally {
    act(() => { render(null, container); }); container.remove();
    prototype.animate = originalAnimate; prototype.getBoundingClientRect = originalRect;
    window.matchMedia = originalMedia; globalThis.ResizeObserver = originalObserver;
  }
});
