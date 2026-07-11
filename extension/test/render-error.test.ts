import assert from 'node:assert/strict';
import test from 'node:test';

import { isSuspenseThenable } from '../src/webview/panel/render-error';

test('classifies Suspense promises as thenables instead of render errors', () => {
  assert.equal(isSuspenseThenable(Promise.resolve()), true);
  assert.equal(isSuspenseThenable({ then() {} }), true);
  assert.equal(isSuspenseThenable(() => undefined), false);
  assert.equal(isSuspenseThenable(new Error('render failed')), false);
  assert.equal(isSuspenseThenable('[object Promise]'), false);
  assert.equal(isSuspenseThenable(null), false);
});
