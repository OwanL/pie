import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSuspenseThenable,
  recordRenderEvidenceTarget,
  sanitizedRenderFailure,
  sanitizedRenderLog,
} from '../../../src/webview/panel/render-error';

test('classifies Suspense promises as thenables instead of render errors', () => {
  assert.equal(isSuspenseThenable(Promise.resolve()), true);
  assert.equal(isSuspenseThenable({ then() {} }), true);
  assert.equal(isSuspenseThenable(() => undefined), false);
  assert.equal(isSuspenseThenable(new Error('render failed')), false);
  assert.equal(isSuspenseThenable('[object Promise]'), false);
  assert.equal(isSuspenseThenable(null), false);
});

test('render failures contain only typed protocol metadata and no error content', () => {
  recordRenderEvidenceTarget({ revision: 7, viewGeneration: 3 }, 'transcript');
  const payload = sanitizedRenderFailure('component_error');

  assert.deepEqual(payload, {
    viewGeneration: 3,
    revision: 7,
    surface: 'transcript',
    classification: 'component_error',
  });
  assert.equal('error' in payload, false);
  assert.equal('stack' in payload, false);
  assert.equal(JSON.stringify(payload).includes('secret render content'), false);
});

test('host-forwarded render logs contain only their classification', () => {
  const log = sanitizedRenderLog('unhandled_rejection', 'webview');
  assert.deepEqual(log, {
    type: 'log',
    level: 'error',
    scope: 'webview',
    message: 'unhandled_rejection',
  });
  assert.equal('data' in log, false);
  assert.equal(JSON.stringify(log).includes('stack'), false);
  assert.equal(JSON.stringify(log).includes('reason'), false);
});
