import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from 'preact';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });

let nextFrameId = 1;
const frames = new Map<number, FrameRequestCallback>();
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  },
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  value: (id: number) => { frames.delete(id); },
});

let useJumpToLatest: typeof import('../../../../src/webview/panel/transcript/use-transcript-scroll-jump').useJumpToLatest;
test.before(async () => {
  ({ useJumpToLatest } = await import('../../../../src/webview/panel/transcript/use-transcript-scroll-jump'));
});

function flushFrame(): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

test('jump settles at the measured bottom after the virtual row range grows', () => {
  const root = document.getElementById('root')!;
  let scrollHeight = 1_000;
  let scrollTop = 0;
  const element = {
    clientHeight: 100,
    get scrollHeight() { return scrollHeight; },
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) { scrollTop = Math.min(value, scrollHeight - 100); },
    style: { scrollBehavior: '' },
  } as unknown as HTMLDivElement;
  const autoFollowRef = { current: false };
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  let jump: (() => void) | undefined;
  const scrollToBottom = () => { element.scrollTop = element.scrollHeight; };

  function Probe() {
    jump = useJumpToLatest(
      { current: element },
      autoFollowRef,
      (next) => { autoFollowRef.current = next; },
      false,
      () => {},
      scrollToBottom,
      { current: false },
    );
    return null;
  }

  render(h(Probe, {}), root);
  assert.ok(jump);
  jump();
  assert.equal(element.scrollTop, 900, 'the click owns an immediate first snap');

  scrollHeight = 2_000;
  now = 16;
  flushFrame();
  assert.equal(element.scrollTop, 1_900, 'the next frame follows the newly measured bottom');
  now = 1_516;
  flushFrame();
  now = 1_532;
  flushFrame();
  assert.equal(frames.size, 0, 'the loop stops after the height is stable');

  render(null, root);
  Date.now = originalNow;
});
