import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../../helpers/dom';
installDom();
import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { useTranscriptLatestDock } from '../../../transcript/use-transcript-latest-dock';

test('Latest uses dock-independent geometry across appearance, removal and near-bottom resize', () => {
  const original = globalThis.ResizeObserver;
  const callbacks = new Set<() => void>();
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) { callbacks.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() { callbacks.delete(this.callback); }
  } as unknown as typeof ResizeObserver;
  const root = document.createElement('div');
  document.body.append(root);
  let top = 700;
  let viewport = 200;
  let following = false;
  let hasNewer = false;
  let hidden = false;
  let revision = 0;
  function Probe() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(false);
    followRef.current = following;
    const dock = useTranscriptLatestDock({ scrollRef, autoFollowRef: followRef, hasNewer, hidden, totalSize: revision, isAtBottom: false });
    return h('div', {}, [
      h('div', { ref: (el: HTMLDivElement | null) => {
        scrollRef.current = el;
        if (!el) return;
        Object.defineProperties(el, {
          scrollHeight: { configurable: true, get: () => 1000 },
          clientHeight: { configurable: true, get: () => viewport },
          scrollTop: { configurable: true, get: () => top },
        });
      } }),
      dock.visible ? h('div', { id: 'dock' }, 'Latest') : null,
    ]);
  }
  const visible = () => !!root.querySelector('#dock');
  const refresh = () => act(() => { revision++; render(h(Probe, {}), root); });
  const resize = () => act(() => { for (const callback of [...callbacks]) callback(); });
  try {
    refresh();
    assert.equal(visible(), true);
    assert.equal(top, 700, 'appearance must preserve reading position');
    top = 775; // 25px from bottom without the dock
    resize();
    assert.equal(visible(), true);
    for (let i = 0; i < 5; i++) resize();
    assert.equal(visible(), true, 'dock must not oscillate near the 24px boundary');
    viewport = 201; // now exactly 24px from the dock-independent bottom
    resize();
    assert.equal(visible(), false);
    for (let i = 0; i < 5; i++) resize();
    assert.equal(visible(), false, 'removal must remain stable');
    viewport = 199;
    resize();
    assert.equal(visible(), true, 'real viewport resize can reveal Latest');
    following = true;
    top = 500; // bounded streaming follow deliberately trails its target
    refresh();
    assert.equal(visible(), false, 'no streaming-follow flash');
    hasNewer = true;
    refresh();
    assert.equal(visible(), true, 'unloaded newer history always offers navigation');
    hasNewer = false;
    refresh();
    assert.equal(visible(), false);
    hidden = true;
    hasNewer = true;
    refresh();
    assert.equal(visible(), false, 'initial positioning never flashes Latest');
  } finally {
    act(() => render(null, root));
    root.remove();
    globalThis.ResizeObserver = original;
  }
});
