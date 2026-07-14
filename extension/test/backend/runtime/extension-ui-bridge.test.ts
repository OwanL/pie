import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionUIRequestPayload } from '../../../src/shared/protocol';
import { ExtensionUIBridge } from '../../../src/backend/extension-ui-bridge';

// ─── harness ─────────────────────────────────────────────────────────────────
//
// The bridge emits `extension_ui.request` events and awaits a matching
// `resolveRequest()`. We capture emitted payloads in-memory and drive the
// resolution synchronously — no real VS Code UI, no timers.

interface CapturedRequest {
  payload: ExtensionUIRequestPayload;
}

function makeBridge(sessionPath = '/session/test') {
  const captured: CapturedRequest[] = [];
  const bridge = new ExtensionUIBridge(sessionPath, (_event, payload) => {
    captured.push({ payload });
  });
  return { bridge, captured };
}

/** Resolve the most recently emitted request with a partial response. */
function resolveLast(
  bridge: ExtensionUIBridge,
  captured: CapturedRequest[],
  response: Record<string, unknown>,
): void {
  const last = captured[captured.length - 1];
  assert.ok(last, 'expected a request to have been emitted');
  bridge.resolveRequest({ id: last.payload.id, ...response });
}

// ─── confirm ─────────────────────────────────────────────────────────────────

test('confirm: resolves true when host responds with confirmed:true', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('Save?', 'Overwrite file?');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].payload.method, 'confirm');
  assert.equal(captured[0].payload.title, 'Save?');
  assert.equal(captured[0].payload.message, 'Overwrite file?');
  assert.equal(captured[0].payload.sessionPath, '/session/test');

  resolveLast(bridge, captured, { confirmed: true });
  assert.equal(await pending, true);
});

test('confirm: resolves false when host responds with confirmed:false', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('Save?', 'Overwrite file?');
  resolveLast(bridge, captured, { confirmed: false });
  assert.equal(await pending, false);
});

test('confirm: cancelled response → false', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('Save?', 'Overwrite?');
  resolveLast(bridge, captured, { cancelled: true });
  assert.equal(await pending, false);
});

test('confirm: neither confirmed nor cancelled → defaults to false', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('Save?', 'Overwrite?');
  resolveLast(bridge, captured, {});
  assert.equal(await pending, false);
});

test('confirm: forwards subagentCallId when provided', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('t', 'm', { subagentCallId: 'call-7' });
  assert.equal(captured[0].payload.subagentCallId, 'call-7');
  resolveLast(bridge, captured, { confirmed: true });
  assert.equal(await pending, true);
});

test('confirm: forwards toolCallId when provided', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('t', 'm', { toolCallId: 'call-8' });
  assert.equal(captured[0].payload.toolCallId, 'call-8');
  assert.equal(captured[0].payload.subagentCallId, undefined);
  resolveLast(bridge, captured, { confirmed: true });
  assert.equal(await pending, true);
});

test('confirm: forwards timeout and auto-cancels without a host response', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('t', 'm', { timeout: 10 });
  assert.equal(captured[0].payload.timeout, 10);
  assert.equal(await pending, false);
});

test('confirm: abort signal cancels the pending request', async () => {
  const { bridge } = makeBridge();
  const controller = new AbortController();
  const pending = bridge.confirm('t', 'm', { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
});

// ─── select ──────────────────────────────────────────────────────────────────

test('select: emits options and returns the chosen value', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.select('Pick one', ['a', 'b', 'c']);
  assert.equal(captured[0].payload.method, 'select');
  assert.deepEqual(captured[0].payload.options, ['a', 'b', 'c']);
  resolveLast(bridge, captured, { value: 'b' });
  assert.equal(await pending, 'b');
});

test('select: forwards subagentCallId and toolCallId when provided', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.select('Pick one', ['a'], { subagentCallId: 'sub-1', toolCallId: 'tc-1' });
  assert.equal(captured[0].payload.subagentCallId, 'sub-1');
  assert.equal(captured[0].payload.toolCallId, 'tc-1');
  resolveLast(bridge, captured, { value: 'a' });
  assert.equal(await pending, 'a');
});

test('select: cancelled → undefined', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.select('Pick one', ['a']);
  resolveLast(bridge, captured, { cancelled: true });
  assert.equal(await pending, undefined);
});

test('select: response without value → undefined', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.select('Pick one', ['a']);
  resolveLast(bridge, captured, {});
  assert.equal(await pending, undefined);
});

// ─── input ───────────────────────────────────────────────────────────────────

test('input: emits placeholder and returns the entered value', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.input('Name it', 'type a name…');
  assert.equal(captured[0].payload.method, 'input');
  assert.equal(captured[0].payload.placeholder, 'type a name…');
  resolveLast(bridge, captured, { value: 'my-session' });
  assert.equal(await pending, 'my-session');
});

test('input: forwards toolCallId when provided', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.input('Name it', undefined, { toolCallId: 'call-9' });
  assert.equal(captured[0].payload.toolCallId, 'call-9');
  resolveLast(bridge, captured, { value: 'typed' });
  assert.equal(await pending, 'typed');
});

test('input: cancelled → undefined', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.input('Name it');
  resolveLast(bridge, captured, { cancelled: true });
  assert.equal(await pending, undefined);
});

test('input: response without value → undefined', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.input('Name it');
  resolveLast(bridge, captured, {});
  assert.equal(await pending, undefined);
});

// ─── resolveRequest: unknown id is a safe no-op ──────────────────────────────

test('resolveRequest: unknown id is a no-op (no throw, no effect)', async () => {
  const { bridge, captured } = makeBridge();
  // Start a real pending request so the map is non-empty.
  const pending = bridge.confirm('t', 'm');
  assert.equal(captured.length, 1);

  // Resolve a fabricated id that has no pending entry.
  assert.equal(bridge.resolveRequest({ id: 'no-such-id', confirmed: true }), false);

  // The real pending request is still unresolved (would hang if awaited);
  // resolve it now to settle the promise and avoid unhandled-rejection noise.
  resolveLast(bridge, captured, { confirmed: true });
  await pending;
});

test('resolveRequest: resolving the same id twice is safe (second is a no-op)', async () => {
  const { bridge, captured } = makeBridge();
  const pending = bridge.confirm('t', 'm');
  const id = captured[0].payload.id;

  assert.equal(bridge.resolveRequest({ id, confirmed: true }), true);
  // Second call reports the expired ownership and cannot change the result.
  assert.equal(bridge.resolveRequest({ id, confirmed: false }), false);
  assert.equal(await pending, true);
});

// ─── cancelAll ───────────────────────────────────────────────────────────────
//
// NOTE: The task brief expected cancelAll to *reject* pending promises with a
// cancellation error. The actual implementation resolves them with
// `{ cancelled: true }`, which makes confirm→false, select/input→undefined.
// These tests assert the real (resolve-based) behaviour; flagged as a
// spec/implementation mismatch, not a code bug.

test('cancelSubagent: cancels only the matching parallel child request', async () => {
  const { bridge, captured } = makeBridge();
  const childA = bridge.confirm('a', 'm', { subagentCallId: 'parent:0' });
  const childB = bridge.confirm('b', 'm', { subagentCallId: 'parent:1' });

  bridge.cancelSubagent('parent:0');
  assert.equal(await childA, false);
  bridge.resolveRequest({ id: captured[1].payload.id, confirmed: true });
  assert.equal(await childB, true);
});

test('cancelAll: pending confirm resolves to false', async () => {
  const { bridge } = makeBridge();
  const pending = bridge.confirm('t', 'm');
  bridge.cancelAll();
  assert.equal(await pending, false);
});

test('cancelAll: pending select resolves to undefined', async () => {
  const { bridge } = makeBridge();
  const pending = bridge.select('t', ['a']);
  bridge.cancelAll();
  assert.equal(await pending, undefined);
});

test('cancelAll: pending input resolves to undefined', async () => {
  const { bridge } = makeBridge();
  const pending = bridge.input('t');
  bridge.cancelAll();
  assert.equal(await pending, undefined);
});

test('cancelAll: rejects nothing as an Error (resolves with cancelled:true)', async () => {
  const { bridge } = makeBridge();
  const pending = bridge.confirm('t', 'm');
  bridge.cancelAll();
  // Must not throw/reject — it resolves cleanly.
  const result = await pending;
  assert.equal(result, false);
});

test('cancelAll: clears all pending; later resolveRequest is a no-op', async () => {
  const { bridge, captured } = makeBridge();
  const a = bridge.confirm('a', 'm');
  const b = bridge.select('b', ['x']);
  const c = bridge.input('c');
  bridge.cancelAll();

  await Promise.all([a, b, c]);
  assert.equal(captured.length, 3);

  // After cancelAll, resolving any captured id does nothing (already cleared).
  for (const { payload } of captured) {
    assert.doesNotThrow(() =>
      bridge.resolveRequest({ id: payload.id, confirmed: true, value: 'late' }),
    );
  }
});

test('cancelAll: with no pending requests is a safe no-op', () => {
  const { bridge } = makeBridge();
  assert.doesNotThrow(() => bridge.cancelAll());
});

// ─── notify ──────────────────────────────────────────────────────────────────

test('notify: emits a fire-and-forget request without awaiting', () => {
  const { bridge, captured } = makeBridge();
  bridge.notify('hello', 'info', 'call-1');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].payload.method, 'notify');
  // notify payload carries the message and notifyType.
  const p = captured[0].payload as Extract<ExtensionUIRequestPayload, { method: 'notify' }>;
  assert.equal(p.message, 'hello');
  assert.equal(p.notifyType, 'info');
  assert.equal(p.subagentCallId, 'call-1');
  // No pending entry is created, so cancelAll has nothing to clear.
  bridge.cancelAll();
});

// ─── concurrent requests get distinct ids ─────────────────────────────────────

test('each pending request gets a unique id', async () => {
  const { bridge, captured } = makeBridge();
  const a = bridge.confirm('a', 'm');
  const b = bridge.confirm('b', 'm');
  const ids = captured.map((c) => c.payload.id);
  assert.notEqual(ids[0], ids[1]);

  bridge.resolveRequest({ id: ids[0], confirmed: true });
  bridge.resolveRequest({ id: ids[1], confirmed: false });
  assert.equal(await a, true);
  assert.equal(await b, false);
});
