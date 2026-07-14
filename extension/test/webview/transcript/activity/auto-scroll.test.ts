import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  advanceSmoothScrollTop,
  captureScrollAnchor,
  distanceFromBottom,
  isNearBottom,
  resolveAutoFollowState,
  resolveScrollAnchorDelta,
} from '../../../../src/webview/panel/auto-scroll';

test('distanceFromBottom clamps at zero', () => {
  assert.equal(
    distanceFromBottom({ scrollHeight: 900, scrollTop: 700, clientHeight: 250 }),
    0,
  );
});

test('isNearBottom uses the shared threshold', () => {
  assert.equal(
    isNearBottom({
      scrollHeight: 1000,
      scrollTop: 1000 - 400 - AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      clientHeight: 400,
    }),
    true,
  );

  assert.equal(
    isNearBottom({
      scrollHeight: 1000,
      scrollTop: 1000 - 400 - AUTO_SCROLL_BOTTOM_THRESHOLD_PX - 1,
      clientHeight: 400,
    }),
    false,
  );
});

test('resolveAutoFollowState disengages on upward scroll regardless of input device', () => {
  // Detection is direction-based, not gated on manual intent: keyboard scroll-up
  // (Page Up / Home / ↑ / Shift+Space) fires no wheel/touch/pointer event, so a
  // gate would leave the auto-follow rAF loop re-pinning to the bottom every
  // frame and fighting the reader.
  const nextAutoFollow = resolveAutoFollowState({
    previousAutoFollow: true,
    previousScrollTop: 600, // pinned at the bottom (distance 0)
    nextScrollTop: 500, // scrolled up 100px -> distance 100 > 24px threshold
    metrics: {
      scrollHeight: 1000,
      scrollTop: 500,
      clientHeight: 400,
    },
  });

  assert.equal(nextAutoFollow, false);
});

test('resolveAutoFollowState stays engaged for upward nudges within the bottom threshold', () => {
  // A small upward nudge that stays inside the 24px near-bottom zone keeps
  // follow engaged. This also prevents a content-shrink clamp (the browser
  // clamping scrollTop down to the new bottom when content above shrinks, e.g.
  // a tool card collapsing or context pruning) from falsely disengaging.
  const nextAutoFollow = resolveAutoFollowState({
    previousAutoFollow: true,
    previousScrollTop: 600, // distance 0
    nextScrollTop: 592, // distance 8 <= 24px threshold
    metrics: {
      scrollHeight: 1000,
      scrollTop: 592,
      clientHeight: 400,
    },
  });

  assert.equal(nextAutoFollow, true);
});

test('resolveAutoFollowState stays disengaged until the viewport reaches the bottom again', () => {
  const stillDetached = resolveAutoFollowState({
    previousAutoFollow: false,
    previousScrollTop: 500,
    nextScrollTop: 540,
    metrics: {
      scrollHeight: 1000,
      scrollTop: 540,
      clientHeight: 400,
    },
  });

  const reattached = resolveAutoFollowState({
    previousAutoFollow: false,
    previousScrollTop: 540,
    nextScrollTop: 600,
    metrics: {
      scrollHeight: 1000,
      scrollTop: 600,
      clientHeight: 400,
    },
  });

  assert.equal(stillDetached, false);
  assert.equal(reattached, true);
});

test('resolveAutoFollowState preserves follow mode while scrolling downward toward the live edge', () => {
  const nextAutoFollow = resolveAutoFollowState({
    previousAutoFollow: true,
    previousScrollTop: 500,
    nextScrollTop: 540,
    metrics: {
      scrollHeight: 1000,
      scrollTop: 540,
      clientHeight: 400,
    },
  });

  assert.equal(nextAutoFollow, true);
});

test('captureScrollAnchor returns the first visible item and its offset', () => {
  const anchor = captureScrollAnchor([
    { key: 'hidden', top: -48, bottom: -4 },
    { key: 'visible', top: 12, bottom: 92 },
    { key: 'later', top: 120, bottom: 180 },
  ]);

  assert.deepEqual(anchor, { key: 'visible', offsetTop: 12 });
});

test('resolveScrollAnchorDelta restores the anchored item to its previous offset', () => {
  const delta = resolveScrollAnchorDelta(
    { key: 'm-2', offsetTop: 16 },
    [
      { key: 'm-1', top: -60, bottom: -10 },
      { key: 'm-2', top: 40, bottom: 140 },
      { key: 'm-3', top: 160, bottom: 220 },
    ],
  );

  assert.equal(delta, 24);
});

test('resolveScrollAnchorDelta returns null when the anchored item disappears', () => {
  const delta = resolveScrollAnchorDelta(
    { key: 'gone', offsetTop: 8 },
    [{ key: 'm-1', top: 16, bottom: 72 }],
  );

  assert.equal(delta, null);
});

test('advanceSmoothScrollTop eases toward the target without overshooting', () => {
  const next = advanceSmoothScrollTop(100, 200);

  assert.equal(next, 170);
});

test('advanceSmoothScrollTop moves upward when the target shrinks', () => {
  const next = advanceSmoothScrollTop(220, 120);

  assert.equal(next, 150);
});

test('advanceSmoothScrollTop snaps when already within epsilon of the target', () => {
  const next = advanceSmoothScrollTop(199.5, 200);

  assert.equal(next, 200);
});

test('advanceSmoothScrollTop eases typical tool-body deltas instead of snapping', () => {
  // A ~420px delta (a single expanded section / terminal pane expand/collapse)
  // is below the large-delta snap threshold (480), so it must ease toward the
  // target rather than jump there in a single frame. With interpolation 0.7 +
  // max step 240 the first step is the capped 240 (420 * 0.7 = 294 > 240).
  const next = advanceSmoothScrollTop(0, 420);
  assert.ok(next > 0 && next < 420, `expected an eased step < 420, got ${next}`);
  assert.equal(next, 240);
});

test('advanceSmoothScrollTop snaps two-section bursts so the viewport stays pinned', () => {
  // Two expanded sections opening in the same snapshot (≈528px+) exceed the
  // 480 snap threshold, so the follow snaps to the new bottom instead of easing
  // behind it for ~100ms+ (the drift the cap raise alone couldn't eliminate).
  assert.equal(advanceSmoothScrollTop(0, 528), 528);
  assert.equal(advanceSmoothScrollTop(0, 1500), 1500);
});

test('advanceSmoothScrollTop treats the large-delta threshold as exclusive', () => {
  // `> threshold` snaps; exactly at the threshold eases, one above snaps.
  assert.ok(advanceSmoothScrollTop(0, 480) < 480, 'delta == threshold eases');
  assert.equal(advanceSmoothScrollTop(0, 481), 481, 'delta > threshold snaps');
});
