import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
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
  // gate would leave auto-follow re-pinning to the bottom and fighting the
  // reader.
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

test('resolveAutoFollowState respects a small deliberate upward scroll', () => {
  // The 24px near-bottom threshold is only a visual tolerance. Follow mode is
  // strict: once the user moves meaningfully upward, later growth must not
  // override them even if they are still visually close to the live edge.
  const nextAutoFollow = resolveAutoFollowState({
    previousAutoFollow: true,
    previousScrollTop: 600,
    nextScrollTop: 592,
    metrics: {
      scrollHeight: 1000,
      scrollTop: 592,
      clientHeight: 400,
    },
  });

  assert.equal(nextAutoFollow, false);
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
