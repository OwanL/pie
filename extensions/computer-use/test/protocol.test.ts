import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonlDecoder, JsonlProtocolError, encodeJsonl } from '../src/protocol.js';
import { SidecarCore, SidecarJsonlDecoder } from '../src/sidecar-core.mjs';

test('parent JSONL decoder handles split records and rejects malformed/oversized input explicitly', () => {
  const decoder = new JsonlDecoder();
  assert.deepEqual(decoder.push('{"v":1'), []);
  assert.deepEqual(decoder.push(',"kind":"response","id":"1","ok":true}\n'), [{ v: 1, kind: 'response', id: '1', ok: true }]);
  assert.throws(() => new JsonlDecoder().push('{bad}\n'), (error: unknown) => error instanceof JsonlProtocolError && error.code === 'MALFORMED_JSONL');
  assert.throws(() => new JsonlDecoder().push('x'.repeat(1024 * 1024 + 1)), (error: unknown) => error instanceof JsonlProtocolError && error.code === 'OVERSIZED_JSONL');
  assert.throws(() => encodeJsonl({ text: 'x'.repeat(1024 * 1024) }), /exceeds/);
});

test('sidecar JSONL decoder rejects malformed and oversized records', () => {
  assert.throws(() => new SidecarJsonlDecoder().push('{]\n'), (error: any) => error.code === 'MALFORMED_JSONL');
  assert.throws(() => new SidecarJsonlDecoder().push('x'.repeat(1024 * 1024 + 1)), (error: any) => error.code === 'OVERSIZED_JSONL');
});

test('sidecar reports malformed, duplicate, unknown, and stale cancellation requests', async () => {
  const output: any[] = [];
  const backend = { async handle(method: string) { if (method === 'known') return { ok: true }; throw Object.assign(new Error('unknown'), { code: 'UNKNOWN_METHOD' }); }, async shutdown() {} };
  const core = new SidecarCore(backend, (record: any) => output.push(record));
  core.accept({ nope: true });
  core.accept({ v: 1, kind: 'request', id: 'a', method: 'known', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  core.accept({ v: 1, kind: 'request', id: 'a', method: 'known', params: {} });
  core.accept({ v: 1, kind: 'request', id: 'b', method: 'missing', params: {} });
  core.accept({ v: 1, kind: 'cancel', id: 'stale' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(output.some((record) => record.kind === 'protocol_error' && record.error.code === 'MALFORMED_REQUEST'));
  assert.ok(output.some((record) => record.id === 'a' && record.error?.code === 'DUPLICATE_REQUEST'));
  assert.ok(output.some((record) => record.id === 'b' && record.error?.code === 'UNKNOWN_METHOD'));
  assert.ok(output.some((record) => record.id === 'stale' && record.error?.code === 'STALE_REQUEST'));
});

test('sidecar error responses include truthful post-cleanup held state and surface release failure', async () => {
  const output: any[] = [];
  const backend = {
    async handle() { throw Object.assign(new Error('action failed'), { code: 'REQUEST_FAILED' }); },
    async releaseForRequest() { return { keys: ['W'], buttons: ['left'] }; },
    async shutdown() {},
  };
  const core = new SidecarCore(backend, (record: any) => output.push(record));
  core.accept({ v: 1, kind: 'request', id: 'release-fails', method: 'act', params: { sessionId: 's' } });
  await new Promise((resolve) => setImmediate(resolve));
  const response = output.find((record) => record.id === 'release-fails');
  assert.equal(response.error.code, 'RELEASE_FAILED');
  assert.equal(response.error.retryable, true);
  assert.deepEqual(response.error.held, { keys: ['W'], buttons: ['left'] });
});

test('sidecar cancellation propagates an AbortSignal and releases cumulative request state', async () => {
  const output: any[] = []; const released: unknown[] = [];
  const backend = {
    async handle(_method: string, _params: unknown, signal: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' })), { once: true });
      });
    },
    async releaseForRequest(params: unknown) { released.push(params); },
    async shutdown() {},
  };
  const core = new SidecarCore(backend, (record: any) => output.push(record));
  core.accept({ v: 1, kind: 'request', id: 'cancel-me', method: 'wait', params: {} });
  core.accept({ v: 1, kind: 'cancel', id: 'cancel-me' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(output.some((record) => record.id === 'cancel-me' && record.error?.code === 'CANCELLED'));
  assert.deepEqual(released, [{}]);
});
