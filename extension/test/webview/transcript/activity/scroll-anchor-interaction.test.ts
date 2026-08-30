import test from 'node:test';
import assert from 'node:assert/strict';

import {
  didScrollAnchorGeometryChange,
  shouldApplyScrollAnchorDelta,
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
