import test from 'node:test';
import assert from 'node:assert/strict';

import { syncCollapsibleOpenState } from '../../../src/webview/panel/collapsible-state';

test('syncCollapsibleOpenState preserves manual state while the default stays unchanged', () => {
  assert.equal(syncCollapsibleOpenState(true, false, false), true);
  assert.equal(syncCollapsibleOpenState(false, true, true), false);
});

test('syncCollapsibleOpenState follows preference changes when the default toggles', () => {
  assert.equal(syncCollapsibleOpenState(false, false, true), true);
  assert.equal(syncCollapsibleOpenState(true, true, false), false);
});
