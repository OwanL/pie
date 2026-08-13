import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestTracker } from '../../../src/shared/request-tracker';

/**
 * `RequestTracker` is a promise + timeout bookkeeping map keyed by request id.
 * Every `create` either is settled (resolve/reject/rejectAll, which clear the
 * timer) or has a short timeout that fires — so no test leaves a dangling
 * timer that would keep the process alive. The only real wall-clock wait is
 * the 2ms timeout case; everything else settles synchronously.
 */

// A long-enough timeout that the timer is never expected to fire during a test;
// resolve/reject/rejectAll clear it, so no real wait occurs.
const LONG_TIMEOUT = 1_000;

test('resolve settles the pending promise with the stored value and returns true', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.resolve('id', 'value'), true);
  assert.equal(await p, 'value');
});

test('resolve removes the entry so a second resolve is a no-op returning false', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.resolve('id', 'first'), true);
  assert.equal(tracker.resolve('id', 'second'), false); // already removed
  assert.equal(await p, 'first');
});

test('resolve returns false for an unknown id', () => {
  const tracker = new RequestTracker<string>();
  assert.equal(tracker.resolve('nope', 'x'), false);
});

test('reject propagates the given error to the pending promise and returns true', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.reject('id', new Error('boom')), true);
  await assert.rejects(p, /boom/);
});

test('reject removes the entry so a second reject is a no-op returning false', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', LONG_TIMEOUT);
  assert.equal(tracker.reject('id', new Error('boom')), true);
  assert.equal(tracker.reject('id', new Error('again')), false);
  await assert.rejects(p, /boom/);
});

test('reject returns false for an unknown id', () => {
  const tracker = new RequestTracker<string>();
  assert.equal(tracker.reject('nope', new Error('x')), false);
});

test('rejectAll rejects every pending request with the given error', async () => {
  const tracker = new RequestTracker<string>();
  const p1 = tracker.create('a', LONG_TIMEOUT);
  const p2 = tracker.create('b', LONG_TIMEOUT);
  const p3 = tracker.create('c', LONG_TIMEOUT);
  tracker.rejectAll(new Error('shutdown'));
  await assert.rejects(p1, /shutdown/);
  await assert.rejects(p2, /shutdown/);
  await assert.rejects(p3, /shutdown/);
  // All entries cleared: subsequent resolves/rejects are no-ops.
  assert.equal(tracker.resolve('a', 'x'), false);
  assert.equal(tracker.reject('b', new Error('x')), false);
});

test('rejectAll with no pending requests is a no-op', () => {
  const tracker = new RequestTracker<string>();
  assert.doesNotThrow(() => tracker.rejectAll(new Error('shutdown')));
});

test('create rejects with a timeout error after the configured timeout', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('slow', 2); // 2ms
  await assert.rejects(p, (err: Error) => err.message === 'Timed out waiting for response to slow');
});

test('a timed-out request is removed so a later resolve is a no-op', async () => {
  const tracker = new RequestTracker<string>();
  const p = tracker.create('slow', 2);
  await assert.rejects(p, /Timed out waiting for response to slow/);
  assert.equal(tracker.resolve('slow', 'x'), false); // entry already deleted by the timeout
});

test('resolve clears the pending timer so no late timeout rejection fires', async () => {
  // If resolve failed to clear the timer, the 3ms timeout would later reject
  // the already-resolved promise. Settled promises ignore further settle calls,
  // so the only observable proof is that the resolved value wins and no
  // unhandled rejection surfaces after the timeout window elapses.
  const tracker = new RequestTracker<string>();
  const p = tracker.create('id', 3);
  assert.equal(tracker.resolve('id', 'value'), true);
  assert.equal(await p, 'value');
  // Wait past the timeout window to surface any late rejection.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(await p, 'value');
});

test('RequestTracker resolves typed values via the generic parameter', async () => {
  // TResult = number; resolve must accept a number and the promise yields it.
  const tracker = new RequestTracker<number>();
  const p = tracker.create('n', LONG_TIMEOUT);
  tracker.resolve('n', 42);
  assert.equal(await p, 42);
});

// ─── Brief B: cancellation + per-call override ────────────────────────────────

test('create with an AbortSignal rejects with a cancel error when the signal aborts', async () => {
  const tracker = new RequestTracker<string>();
  const controller = new AbortController();
  const p = tracker.create('id', LONG_TIMEOUT, controller.signal);
  controller.abort();
  await assert.rejects(p, /was cancelled/);
});

test('create with an already-aborted signal rejects synchronously and does not store the entry', async () => {
  const tracker = new RequestTracker<string>();
  const controller = new AbortController();
  controller.abort();
  const p = tracker.create('pre', LONG_TIMEOUT, controller.signal);
  await assert.rejects(p, /was cancelled/);
  // Not stored: a later resolve is a no-op (no dangling timer).
  assert.equal(tracker.resolve('pre', 'x'), false);
});

test('transport settlement remains observable after local cancellation', async () => {
  const tracker = new RequestTracker<string>();
  const controller = new AbortController();
  let transportSettlements = 0;
  const p = tracker.create('preload', LONG_TIMEOUT, controller.signal, () => {
    transportSettlements += 1;
  });

  controller.abort();
  await assert.rejects(p, /was cancelled/);
  assert.equal(transportSettlements, 0, 'local cancellation is not physical transport settlement');
  assert.equal(tracker.resolve('preload', 'late response'), true, 'correlation tombstone accepts the late response');
  assert.equal(transportSettlements, 1);
  assert.equal(tracker.resolve('preload', 'duplicate response'), false);
});

test('resolve detaches the abort listener so a later abort is a no-op (no late reject, no leak)', async () => {
  const tracker = new RequestTracker<string>();
  const controller = new AbortController();
  const p = tracker.create('id', LONG_TIMEOUT, controller.signal);
  assert.equal(tracker.resolve('id', 'value'), true);
  assert.equal(await p, 'value');
  // Aborting after resolve must not reject the settled promise nor throw.
  controller.abort();
  await new Promise<void>((r) => setTimeout(r, 5));
  assert.equal(await p, 'value');
});

test('rejectAll detaches abort listeners (a later abort does not throw)', async () => {
  const tracker = new RequestTracker<string>();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = tracker.create('a', LONG_TIMEOUT, c1.signal);
  const p2 = tracker.create('b', LONG_TIMEOUT, c2.signal);
  tracker.rejectAll(new Error('shutdown'));
  await assert.rejects(p1, /shutdown/);
  await assert.rejects(p2, /shutdown/);
  // Aborting after rejectAll must not throw (listeners detached, entries gone).
  c1.abort();
  c2.abort();
  // Subsequent resolves/rejects are no-ops.
  assert.equal(tracker.resolve('a', 'x'), false);
  assert.equal(tracker.reject('b', new Error('x')), false);
});

test('create honours a per-call timeout budget (override) — fires at the given budget', async () => {
  // RequestTracker.create takes timeoutMs per-call; callers that know they are
  // prepass-gated or trivial pass an appropriate value (Brief B).
  const tracker = new RequestTracker<string>();
  const p = tracker.create('fast', 2); // 2ms override
  await assert.rejects(p, /Timed out waiting for response to fast/);
});

test('create with a per-call timeout override is shorter than the method default (no opaque 30s wait)', async () => {
  // The override lets callers shrink the window: a 2ms budget fires in ~2ms,
  // not the 30s default. Asserts the override is honoured, not ignored.
  const tracker = new RequestTracker<string>();
  const start = Date.now();
  try {
    await tracker.create('fast', 2);
  } catch {
    // elapsed well under a second → override honoured.
    assert.ok(Date.now() - start < 1000, 'override timeout did not fire promptly');
  }
});
