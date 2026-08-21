import assert from 'node:assert/strict';
import test from 'node:test';

import { allowsContextBreakdownWorker } from '../../../src/webview/panel/context-window/worker-policy';

test('allows an explicit same-origin worker policy', () => {
  assert.equal(allowsContextBreakdownWorker("default-src 'none'; script-src 'nonce-test'; worker-src 'self'"), true);
});

test('rejects the legacy nonce-only script policy before attempting a worker', () => {
  assert.equal(allowsContextBreakdownWorker("default-src 'none'; script-src 'nonce-test'"), false);
});

test('honours explicit worker denial and CSP fallback sources', () => {
  assert.equal(allowsContextBreakdownWorker("script-src 'self'; worker-src 'none'"), false);
  assert.equal(allowsContextBreakdownWorker("default-src 'none'; child-src blob:"), true);
});

test('allows an absent policy so header-only policies can be enforced by the browser', () => {
  assert.equal(allowsContextBreakdownWorker(null), true);
});
