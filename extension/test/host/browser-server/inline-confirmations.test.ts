/**
 * Inline confirmation service tests (browser server plan §2.2/§9): the host
 * proceeds only on the INITIATING renderer's explicit response; decline,
 * timeout, and disconnect cancel.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InlineConfirmationService } from '../../../src/host/browser-server/inline-confirmations';
import type { HostToWebviewMessage } from '../../../src/shared/protocol';

interface Harness {
  service: InlineConfirmationService;
  posted: Array<HostToWebviewMessage & { rendererId: string }>;
  fireTimers: () => void;
}

function createHarness(timeoutMs = 120_000): Harness {
  const posted: Array<HostToWebviewMessage & { rendererId: string }> = [];
  const timers: Array<() => void> = [];
  const service = new InlineConfirmationService({
    postToRenderer: (rendererId, message) => posted.push({ ...message, rendererId } as HostToWebviewMessage & { rendererId: string }),
    now: () => 0,
    timeoutMs,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  return {
    service,
    posted,
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
  };
}

test('request posts the imperative to the initiating renderer and resolves on explicit confirm', async () => {
  const { service, posted } = createHarness();
  const promise = service.request('renderer-1', {
    kind: 'model-switch',
    sessionPath: '/session/a',
    message: 'Switch model?',
    confirmChoice: 'Switch Model',
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, 'inlineConfirm');
  if (posted[0]?.type === 'inlineConfirm') {
    assert.equal(posted[0].rendererId, 'renderer-1');
    assert.equal(posted[0].kind, 'model-switch');
    assert.equal(posted[0].sessionPath, '/session/a');
    assert.equal(posted[0].confirmChoice, 'Switch Model');
    assert.equal(typeof posted[0].confirmId, 'string');
    assert.equal(service.handleResponse('renderer-1', posted[0].confirmId, true), true);
  }
  assert.equal(await promise, true);
  assert.equal(service.pendingCount('renderer-1'), 0);
});

test('explicit decline resolves false; a response from another renderer is ignored', async () => {
  const { service, posted } = createHarness();
  const promise = service.request('renderer-1', {
    kind: 'destructive-revert',
    message: 'Revert file?',
    confirmChoice: 'Revert File',
  });
  const confirm = posted[0];
  assert.equal(confirm?.type, 'inlineConfirm');
  if (confirm?.type === 'inlineConfirm') {
    assert.equal(service.handleResponse('renderer-2', confirm.confirmId, true), false, 'foreign renderer cannot settle');
    assert.equal(service.handleResponse('renderer-1', confirm.confirmId, false), true);
  }
  assert.equal(await promise, false);
});

test('timeout cancels the pending confirmation', async () => {
  const { service, fireTimers } = createHarness(120_000);
  const promise = service.request('renderer-1', {
    kind: 'model-switch',
    message: 'Switch model?',
    confirmChoice: 'Switch Model',
  });
  fireTimers();
  assert.equal(await promise, false);
  assert.equal(service.pendingCount('renderer-1'), 0);
});

test('disconnect cancels every pending confirmation for that renderer', async () => {
  const { service } = createHarness();
  const first = service.request('renderer-1', { kind: 'model-switch', message: 'A?', confirmChoice: 'Yes' });
  const second = service.request('renderer-1', { kind: 'destructive-revert', message: 'B?', confirmChoice: 'Yes' });
  const other = service.request('renderer-2', { kind: 'model-switch', message: 'C?', confirmChoice: 'Yes' });

  service.cancelForRenderer('renderer-1');
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(service.pendingCount('renderer-1'), 0);
  assert.equal(service.pendingCount('renderer-2'), 1, 'other renderers are untouched');
  service.cancelForRenderer('renderer-2');
  assert.equal(await other, false);
});

test('a stale response after settlement is a no-op', async () => {
  const { service, posted } = createHarness();
  const promise = service.request('renderer-1', { kind: 'model-switch', message: 'A?', confirmChoice: 'Yes' });
  const confirm = posted[0];
  assert.equal(confirm?.type, 'inlineConfirm');
  if (confirm?.type === 'inlineConfirm') {
    assert.equal(service.handleResponse('renderer-1', confirm.confirmId, true), true);
    assert.equal(service.handleResponse('renderer-1', confirm.confirmId, false), false, 'settled confirmations ignore late responses');
  }
  assert.equal(await promise, true);
});
