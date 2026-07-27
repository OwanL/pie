import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldApplyScrollAnchorDelta } from '../../../../src/webview/panel/transcript/use-transcript-scroll-anchor';

test('scroll anchor yields while the user moves toward the bottom', () => {
  assert.equal(
    shouldApplyScrollAnchorDelta(-24, true),
    false,
    'an upward correction must not fight a downward scrollbar or middle-button drag',
  );
  assert.equal(
    shouldApplyScrollAnchorDelta(24, true),
    false,
    'all anchoring should pause until the active downward interaction settles',
  );
});

test('scroll anchor still preserves an idle scrolled-up viewport', () => {
  assert.equal(shouldApplyScrollAnchorDelta(-24, false), true);
  assert.equal(shouldApplyScrollAnchorDelta(24, false), true);
  assert.equal(shouldApplyScrollAnchorDelta(0.5, false), false, 'sub-pixel jitter stays ignored');
  assert.equal(shouldApplyScrollAnchorDelta(null, false), false, 'a missing anchor cannot be restored');
});
