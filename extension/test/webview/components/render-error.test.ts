import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBenignResizeObserverError,
  isSuspenseThenable,
  recordRenderEvidenceTarget,
  sanitizedRenderDiagnostic,
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

test('host-forwarded render logs retain bounded sanitized diagnostics', () => {
  const diagnostic = sanitizedRenderDiagnostic(
    Object.assign(new TypeError(`bad\n${'x'.repeat(700)}`), { stack: `TypeError: bad\r\n${'s'.repeat(1_500)}` }),
    {
      source: 'https://localhost/assets/panel.js?access_token=secret#fragment',
      line: 42,
      column: 9,
    },
  );
  const log = sanitizedRenderLog('unhandled_rejection', 'webview', diagnostic, {
    fatal: false,
    benign: false,
  });

  assert.equal(log.type, 'log');
  assert.equal(log.level, 'error');
  assert.equal(log.message, 'unhandled_rejection');
  assert.equal(log.data.errorName, 'TypeError');
  assert.equal(log.data.errorMessage.includes('\n'), false);
  assert.equal(log.data.errorMessage.endsWith('…'), true);
  assert.equal(log.data.stack?.includes('\r'), false);
  assert.equal(log.data.stack?.endsWith('…'), true);
  assert.equal(log.data.source, 'https://localhost/assets/panel.js');
  assert.equal(log.data.line, 42);
  assert.equal(log.data.column, 9);
  assert.equal(log.data.fatal, false);
  assert.equal(log.data.benign, false);
  assert.equal(JSON.stringify(log).includes('access_token'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(log.data), 'utf8') < 8_192);

  const hostileUnicodeLog = sanitizedRenderLog(
    'uncaught_error',
    'panel',
    sanitizedRenderDiagnostic(Object.assign(new Error('\uD800'.repeat(2_000)), {
      name: '\uD800'.repeat(300),
      stack: '\uD800'.repeat(3_000),
    }), { source: `https://localhost/${'\uD800'.repeat(1_000)}` }),
    { fatal: false },
  );
  assert.equal(JSON.stringify(hostileUnicodeLog.data).includes('\\ud800'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(hostileUnicodeLog.data), 'utf8') < 8_192);
});

test('recognizes only Chromium ResizeObserver loop notices as benign', () => {
  assert.equal(isBenignResizeObserverError('ResizeObserver loop limit exceeded'), true);
  assert.equal(
    isBenignResizeObserverError('ResizeObserver loop completed with undelivered notifications.'),
    true,
  );
  assert.equal(isBenignResizeObserverError('ResizeObserver callback threw'), false);
  assert.equal(isBenignResizeObserverError(new Error('ResizeObserver loop limit exceeded')), false);
});

test('renderer diagnostics survive hostile error getters', () => {
  const error = Object.create(null, {
    name: { get() { throw new Error('name getter failed'); } },
    message: { get() { throw new Error('message getter failed'); } },
    stack: { get() { throw new Error('stack getter failed'); } },
  });

  assert.deepEqual(sanitizedRenderDiagnostic(error, { message: 'fallback' }), {
    errorMessage: 'fallback',
  });
});
