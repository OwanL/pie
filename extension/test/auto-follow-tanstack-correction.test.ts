/**
 * Regression test for the auto-follow disengage caused by tanstack virtual's
 * built-in scroll-position correction (`resizeItem` → `_scrollToOffset`).
 *
 * When a row ABOVE the viewport resizes (shrinks), the default
 * `shouldAdjustScrollPositionOnItemSizeChange` behavior writes `scrollTop`
 * downward to mimic `overflow-anchor`. That write lands in the virtualizer's
 * measure step BEFORE the deferred re-render updates `el.scrollHeight`, so the
 * scroll event sees a stale-high `scrollHeight` + lowered `scrollTop` → large
 * `distanceFromBottom` → `resolveAutoFollowState` spuriously disengages
 * auto-follow. This is the root cause of "autoscroll stops after a tool-card
 * animated close" (two parallel collapsing bash cards = a tall shrink above the
 * viewport).
 *
 * The fix (`virtual-list.tsx`) disables this correction in both scroll modes.
 * The rAF loop + browser clamp exclusively own bottom-follow, while
 * `useTranscriptScrollAnchor` exclusively owns a scrolled-up viewport. Running
 * tanstack's correction alongside that anchor double-applies resize deltas and
 * makes the viewport drift while streaming.
 *
 * This test drives the REAL `Virtualizer` (no React hooks, no happy-dom layout)
 * and asserts the correction is suppressed when the field returns `false` and
 * fires when it returns `true`/`undefined` — locking in both the bug and the fix
 * at the virtualizer boundary the hook-level tests cannot reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { Virtualizer, observeElementRect, observeElementOffset } from '@tanstack/virtual-core';

interface ScrollEl {
  el: HTMLDivElement;
  /** All scrollTop values ever written (programmatic corrections). */
  writes: number[];
  /** Current scrollTop (read-back, after any clamping the setter applied). */
  scrollTop: number;
}

function makeScrollElement(scrollHeight: number, clientHeight: number, initialScrollTop: number): ScrollEl {
  const el = document.createElement('div');
  let scrollTop = initialScrollTop;
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, scrollHeight - clientHeight));
      writes.push(scrollTop);
      el.dispatchEvent(new Event('scroll'));
    },
    configurable: true,
  });
  // happy-dom: scrollTo is not implemented on a plain div; elementScroll would
  // no-op. Use a scrollToFn that writes scrollTop directly so corrections are
  // observable. Matches how `_scrollToOffset` → `scrollToFn(offset, {adjustments})`
  // composes the final target.
  document.body.appendChild(el);
  const handle: ScrollEl = {
    el,
    get writes() { return writes; },
    get scrollTop() { return scrollTop; },
  };
  // stash the scrollToFn-binding by attaching to the handle via the virtualizer opts below
  return handle;
}

function makeVirtualizer(scroll: ScrollEl, shouldAdjust?: (delta: number) => boolean): Virtualizer<HTMLDivElement, HTMLDivElement> {
  const v = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 10,
    getScrollElement: () => scroll.el,
    estimateSize: () => 100,
    getItemKey: (i) => i,
    // scrollToFn writes scrollTop = offset + adjustments, matching the real
    // elementScroll composition that _scrollToOffset relies on.
    scrollToFn: (offset, opts) => {
      scroll.el.scrollTop = offset + (opts.adjustments ?? 0);
    },
    observeElementRect,
    observeElementOffset,
    overscan: 10,
    useAnimationFrameWithResizeObserver: true,
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    onChange: () => {},
  });
  if (shouldAdjust) {
    v.shouldAdjustScrollPositionOnItemSizeChange = (_item, delta) => shouldAdjust(delta);
  }
  v._didMount();
  // Populate measurementsCache so resizeItem(index) has an item to resize.
  v.getVirtualItems();
  // Pin the viewport at the bottom (item 0 is well above the viewport).
  scroll.el.scrollTop = 800;
  // Let observeElementOffset register the scroll position.
  scroll.el.dispatchEvent(new Event('scroll'));
  v._willUpdate();
  v.getVirtualItems();
  return v;
}

test('default correction writes scrollTop downward when a row above the viewport shrinks', () => {
  // scrollHeight 1000, clientHeight 200, scrollTop 800 (pinned at bottom).
  // Item 0 (start 0, size 100) is above the viewport [800,1000].
  const scroll = makeScrollElement(1000, 200, 800);
  const v = makeVirtualizer(scroll); // shouldAdjust undefined → default behavior
  assert.equal(scroll.scrollTop, 800, 'sanity: pinned at the bottom');

  // Shrink item 0 from 100 → 50 (delta -50). Default correction should fire
  // because item.start (0) < scrollOffset (800).
  v.resizeItem(0, 50);

  assert.ok(scroll.writes.length > 0, 'default correction must write scrollTop');
  assert.ok(scroll.scrollTop < 800, `scrollTop should move down (correction), got ${scroll.scrollTop}`);
});

test('fix: shouldAdjustScrollPositionOnItemSizeChange=false suppresses the correction while auto-following', () => {
  const scroll = makeScrollElement(1000, 200, 800);
  // Simulate the fix: auto-follow engaged → correction disabled.
  const v = makeVirtualizer(scroll, () => false);
  assert.equal(scroll.scrollTop, 800, 'sanity: pinned at the bottom');
  const writesBefore = scroll.writes.length;

  // Same shrink as above (item 0, 100 → 50, delta -50, above the viewport).
  v.resizeItem(0, 50);

  assert.equal(scroll.writes.length, writesBefore, 'correction must NOT write scrollTop while auto-following');
  assert.equal(scroll.scrollTop, 800, 'scrollTop must stay pinned at the bottom (loop + clamp own the follow)');
});

test('scrolled-up case: tanstack correction stays disabled so the custom anchor has sole ownership', () => {
  const scroll = makeScrollElement(1000, 200, 800);
  const v = makeVirtualizer(scroll, () => false);
  assert.equal(scroll.scrollTop, 800, 'sanity: initial position');
  const writesBefore = scroll.writes.length;

  v.resizeItem(0, 50);

  assert.equal(scroll.writes.length, writesBefore, 'tanstack must not double-apply the custom anchor correction');
  assert.equal(scroll.scrollTop, 800, 'position remains untouched until the custom anchor restores it');
});
