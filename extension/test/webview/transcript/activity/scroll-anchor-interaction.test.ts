import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { act } from 'preact/test-utils';
import type { VirtualItem, Virtualizer } from '@tanstack/virtual-core';
import {
  didScrollAnchorGeometryChange,
  shouldApplyScrollAnchorDelta,
  useTranscriptScrollAnchor,
} from '../../../../src/webview/panel/transcript/use-transcript-scroll-anchor';

test('scroll anchor yields throughout manual interaction in either direction', () => {
  assert.equal(
    shouldApplyScrollAnchorDelta(-24, true),
    false,
    'an upward correction must not fight a manual scrollbar or middle-button drag',
  );
  assert.equal(
    shouldApplyScrollAnchorDelta(24, true),
    false,
    'all anchoring should pause until the manual interaction settles',
  );
});

test('scroll anchor notices equal-height transcript identity changes', () => {
  assert.equal(didScrollAnchorGeometryChange(800, 800, ['a', 'b'], ['a', 'c']), true);
  assert.equal(didScrollAnchorGeometryChange(800, 800, ['a', 'b'], ['a', 'b']), false);
  assert.equal(didScrollAnchorGeometryChange(800, 820, ['a', 'b'], ['a', 'b']), true);
});

test('scroll anchor still preserves an idle scrolled-up viewport', () => {
  assert.equal(shouldApplyScrollAnchorDelta(-24, false), true);
  assert.equal(shouldApplyScrollAnchorDelta(24, false), true);
  assert.equal(shouldApplyScrollAnchorDelta(0.5, false), false, 'sub-pixel jitter stays ignored');
  assert.equal(shouldApplyScrollAnchorDelta(null, false), false, 'a missing anchor cannot be restored');
});

test('rendered anchor keeps the reading passage fixed when a tall row above it grows', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const model: {
    scrollHeight: number;
    scrollTop: number;
    items: VirtualItem[];
  } = {
    scrollHeight: 2_000,
    scrollTop: 650,
    items: [
      { key: 'tool-above', index: 0, start: 0, size: 600 } as VirtualItem,
      { key: 'reading', index: 1, start: 600, size: 120 } as VirtualItem,
      { key: 'later', index: 2, start: 720, size: 1_280 } as VirtualItem,
    ],
  };
  const autoFollowRef = { current: false };
  const manualScrollActiveRef = { current: false };
  const programmaticScrollTargetRef = { current: null as number | null };
  const navigationActiveRef = { current: false };

  function Probe({ totalSize }: { totalSize: number }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
    if (!virtualizerRef.current) {
      virtualizerRef.current = {
        getVirtualItems: () => model.items,
      } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>;
    }
    // Install observable layout metrics before the anchor hook's layout effect
    // runs. The hook itself remains a real Preact/DOM layout feedback loop.
    useLayoutEffect(() => {
      const element = scrollRef.current!;
      Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => model.scrollHeight,
      });
      Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => model.scrollTop,
        set: (value: number) => { model.scrollTop = value; },
      });
    }, []);
    useTranscriptScrollAnchor({
      scrollRef,
      virtualizer: virtualizerRef.current,
      autoFollowRef,
      manualScrollActiveRef,
      programmaticScrollTargetRef,
      totalSize,
      rowKeys: model.items.map((item) => String(item.key)),
      navigationActiveRef,
      isLoadingOlder: false,
      isLoadingNewer: false,
    });
    return h('div', { id: 'anchor-host', ref: scrollRef });
  }

  try {
    act(() => { render(h(Probe, { totalSize: model.scrollHeight }), root); });
    const initialOffset = model.items[1].start - model.scrollTop;
    assert.equal(initialOffset, -50, 'sanity: the reading row starts partly above the viewport');

    // The tall tool row grows by 300px. The reading row's document start moves
    // with it, but its viewport-relative position must not.
    model.scrollHeight = 2_300;
    model.items = [
      { key: 'tool-above', index: 0, start: 0, size: 900 } as VirtualItem,
      { key: 'reading', index: 1, start: 900, size: 120 } as VirtualItem,
      { key: 'later', index: 2, start: 1_020, size: 1_280 } as VirtualItem,
    ];
    act(() => { render(h(Probe, { totalSize: model.scrollHeight }), root); });

    assert.equal(model.scrollTop, 950, 'anchor correction should offset the 300px growth');
    assert.equal(model.items[1].start - model.scrollTop, initialOffset, 'the same reading passage stays in view');
    assert.equal(programmaticScrollTargetRef.current, 950, 'the correction is tagged as app-owned');
  } finally {
    act(() => { render(null, root); });
    root.remove();
  }
});
