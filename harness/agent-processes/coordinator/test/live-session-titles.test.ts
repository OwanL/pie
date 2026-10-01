import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_SESSION_TITLE_BASE_MAX_CHARS,
  LiveSessionTitleBaseInvalidError,
  LiveSessionTitles,
  LiveTitleNamespaceUnavailableError,
} from '../live-session-titles';

function entry(
  sessionPath: string,
  sessionId: string,
  options: { title?: string; headerTimestamp?: string } = {},
) {
  return { sessionPath, sessionId, ...options };
}

/** Collect (path, title) cold mutation calls for reconciliation evidence. */
function trackingPersists() {
  const calls: Array<{ sessionPath: string; title: string }> = [];
  return {
    persist: async (sessionPath: string, title: string): Promise<void> => {
      calls.push({ sessionPath, title });
    },
    calls,
  };
}

test('reconciliation publishes restored titles and establishes the namespace', async () => {
  const titles = new LiveSessionTitles();
  assert.equal(titles.ready, false);

  const tracker = trackingPersists();
  const result = await titles.reconcile([
    entry('/s/a.jsonl', 'id-a', { title: 'Review Control', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
    entry('/s/b.jsonl', 'id-b'), // provisional session: never publishes a title
  ], tracker.persist);

  assert.equal(titles.ready, true);
  assert.equal(result.restoredEntries, 2);
  assert.deepEqual(result.suffixed, []);
  assert.deepEqual(tracker.calls, []);
  assert.deepEqual(titles.resolve(' Review Control '), {
    sessionPath: '/s/a.jsonl',
    sessionId: 'id-a',
  });
  assert.equal(titles.resolve('Review Control'.toUpperCase()), undefined, 'matching stays exact');
  assert.equal(titles.resolve('review control'), undefined, 'no fuzzy matching');
  assert.equal(titles.assigned('/s/a.jsonl'), 'Review Control');
  assert.equal(titles.assigned('/s/b.jsonl'), undefined, 'provisional labels never resolve as titles');
});

test('the oldest durable creation timestamp keeps a colliding title and persistence precedes publication', async () => {
  const titles = new LiveSessionTitles();
  const tracker = trackingPersists();
  const result = await titles.reconcile([
    entry('/s/newer.jsonl', 'id-newer', { title: 'Review', headerTimestamp: '2026-02-01T00:00:00.000Z' }),
    entry('/s/older.jsonl', 'id-older', { title: 'Review', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
  ], tracker.persist);

  assert.deepEqual(result.suffixed, [{
    sessionPath: '/s/newer.jsonl',
    sessionId: 'id-newer',
    from: 'Review',
    to: 'Review (2)',
  }]);
  // The collision suffix is persisted before the assignment is published.
  assert.deepEqual(tracker.calls, [{ sessionPath: '/s/newer.jsonl', title: 'Review (2)' }]);
  assert.deepEqual(titles.resolve('Review'), { sessionPath: '/s/older.jsonl', sessionId: 'id-older' });
  assert.deepEqual(titles.resolve('Review (2)'), { sessionPath: '/s/newer.jsonl', sessionId: 'id-newer' });
  assert.equal(titles.assigned('/s/newer.jsonl'), 'Review (2)');
});

test('invalid and missing creation timestamps sort after valid ones and session identity breaks ties', async () => {
  const titles = new LiveSessionTitles();
  const tracker = trackingPersists();
  await titles.reconcile([
    entry('/s/no-time.jsonl', 'id-no-time', { title: 'Review' }),
    entry('/s/valid.jsonl', 'id-valid', { title: 'Review', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
    entry('/s/garbage.jsonl', 'id-b-fallback', { title: 'Review', headerTimestamp: 'not-a-date' }),
  ], tracker.persist);

  assert.equal(titles.assigned('/s/valid.jsonl'), 'Review');
  assert.equal(titles.assigned('/s/garbage.jsonl'), 'Review (2)');
  assert.equal(titles.assigned('/s/no-time.jsonl'), 'Review (3)');
  assert.deepEqual(tracker.calls, [
    { sessionPath: '/s/garbage.jsonl', title: 'Review (2)' },
    { sessionPath: '/s/no-time.jsonl', title: 'Review (3)' },
  ]);
});

test('literal existing suffixes are reserved before allocating new ones', async () => {
  const titles = new LiveSessionTitles();
  const tracker = trackingPersists();
  const result = await titles.reconcile([
    entry('/s/literal-two.jsonl', 'id-two', { title: 'Review (2)', headerTimestamp: '2026-01-03T00:00:00.000Z' }),
    entry('/s/newer.jsonl', 'id-newer', { title: 'Review', headerTimestamp: '2026-02-01T00:00:00.000Z' }),
    entry('/s/older.jsonl', 'id-older', { title: 'Review', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
  ], tracker.persist);

  assert.deepEqual(result.suffixed, [{
    sessionPath: '/s/newer.jsonl',
    sessionId: 'id-newer',
    from: 'Review',
    to: 'Review (3)',
  }]);
  assert.deepEqual(titles.resolve('Review (2)'), {
    sessionPath: '/s/literal-two.jsonl',
    sessionId: 'id-two',
  });
  assert.deepEqual(titles.resolve('Review (3)'), {
    sessionPath: '/s/newer.jsonl',
    sessionId: 'id-newer',
  });
});

test('legacy titles longer than the new base limit are preserved verbatim', async () => {
  const titles = new LiveSessionTitles();
  await titles.reconcile([
    entry('/s/legacy.jsonl', 'id-legacy', { title: 'Long historical assigned title exceeding budget' }),
  ], trackingPersists().persist);

  assert.equal(titles.assigned('/s/legacy.jsonl'), 'Long historical assigned title exceeding budget');
  assert.deepEqual(titles.resolve('Long historical assigned title exceeding budget'), {
    sessionPath: '/s/legacy.jsonl',
    sessionId: 'id-legacy',
  });
});

test('failed persistence frees the reservation and readiness fails closed with retryable determinism', async () => {
  const titles = new LiveSessionTitles();
  let failPersist = true;
  const persist = async (sessionPath: string, title: string): Promise<void> => {
    if (failPersist) throw new Error('injected cold write failure');
    await trackingPersists().persist(sessionPath, title);
  };

  await assert.rejects(
    () => titles.reconcile([
      entry('/s/newer.jsonl', 'id-newer', { title: 'Review', headerTimestamp: '2026-02-01T00:00:00.000Z' }),
      entry('/s/older.jsonl', 'id-older', { title: 'Review', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
    ], persist),
    /injected cold write failure/,
  );
  assert.equal(titles.ready, false);
  assert.throws(() => titles.resolve('Review'), LiveTitleNamespaceUnavailableError);
  assert.throws(() => titles.reserve('New Base', { sessionPath: '/s/x.jsonl', sessionId: 'id-x' }),
    LiveTitleNamespaceUnavailableError);

  // Deterministic retry on recovery.
  failPersist = false;
  const tracker = trackingPersists();
  const retry = await titles.reconcile(
    [
      entry('/s/newer.jsonl', 'id-newer', { title: 'Review', headerTimestamp: '2026-02-01T00:00:00.000Z' }),
      entry('/s/older.jsonl', 'id-older', { title: 'Review', headerTimestamp: '2026-01-01T00:00:00.000Z' }),
    ],
    tracker.persist,
  );
  assert.deepEqual(retry.suffixed, [{
    sessionPath: '/s/newer.jsonl',
    sessionId: 'id-newer',
    from: 'Review',
    to: 'Review (2)',
  }]);
  assert.deepEqual(tracker.calls, [{ sessionPath: '/s/newer.jsonl', title: 'Review (2)' }]);
  assert.equal(titles.ready, true);
});

test('reservation allocation is synchronous, suffixes stay outside the 25-character base allowance', async () => {
  const titles = new LiveSessionTitles();
  await titles.reconcile(
    [entry('/s/a.jsonl', 'id-a', { title: 'Taken Base', headerTimestamp: '2026-01-01T00:00:00.000Z' })],
    trackingPersists().persist,
  );

  const base25 = 'Check Flaky Windows Tests'; // exactly 25 characters
  assert.equal(base25.length, LIVE_SESSION_TITLE_BASE_MAX_CHARS);
  const reservation = titles.reserve(base25, { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  assert.equal(reservation.title, base25, 'a clean 25-character base needs no suffix');

  // Concurrent allocations reserve synchronously: the second cannot re-take it.
  const second = titles.reserve(base25, { sessionPath: '/s/c.jsonl', sessionId: 'id-c' });
  assert.equal(second.title, `${base25} (2)`);
  assert.equal(second.reservationId !== reservation.reservationId, true);
  // A still-reserved title is occupied but never published.
  assert.equal(titles.resolve(base25), undefined);
  assert.equal(titles.assigned('/s/b.jsonl'), undefined);

  // The base remains resolvable once the owner confirmed persistence.
  titles.confirm(reservation);
  assert.deepEqual(titles.resolve(base25), { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  assert.equal(titles.assigned('/s/b.jsonl'), base25);
  const records = titles.list();
  assert.deepEqual(records, [
    { sessionPath: '/s/b.jsonl', sessionId: 'id-b', title: base25, state: 'assigned' },
    { sessionPath: '/s/c.jsonl', sessionId: 'id-c', title: `${base25} (2)`, state: 'reserved' },
    { sessionPath: '/s/a.jsonl', sessionId: 'id-a', title: 'Taken Base', state: 'assigned' },
  ]);

  assert.throws(
    () => titles.reserve('Reject oversize create input, never shorten', { sessionPath: '/s/d.jsonl', sessionId: 'id-d' }),
    LiveSessionTitleBaseInvalidError,
  );
  assert.throws(
    () => titles.reserve('   ', { sessionPath: '/s/d.jsonl', sessionId: 'id-d' }),
    LiveSessionTitleBaseInvalidError,
  );
  // Occupied non-base names also block suffix allocation in reserve().
  const blockedSuffix = titles.reserve(base25, { sessionPath: '/s/d.jsonl', sessionId: 'id-d' });
  assert.equal(blockedSuffix.title, `${base25} (3)`, 'both the published base and the reserved (2) are skipped');
  titles.release(blockedSuffix);
});

test('release retains the reservation until closing confirms, then frees the name without historical aliases', async () => {
  const titles = new LiveSessionTitles();
  await titles.reconcile(
    [entry('/s/a.jsonl', 'id-a', { title: 'Review' })],
    trackingPersists().persist,
  );

  const reservation = titles.reserve('Review', { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  assert.equal(reservation.title, 'Review (2)');

  titles.confirm(reservation);
  assert.deepEqual(titles.resolve('Review (2)'), { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });

  // While the session is live the assigned name stays stable.
  const stillAssigned = titles.reserve('Review (2)', { sessionPath: '/s/c.jsonl', sessionId: 'id-c' });
  assert.equal(stillAssigned.title, 'Review (2) (2)', 'suffix allocation stays deterministic on any occupied base');
  titles.release(stillAssigned);

  titles.release(reservation);
  assert.equal(titles.resolve('Review (2)'), undefined);
  assert.equal(titles.assigned('/s/b.jsonl'), undefined);

  const again = titles.reserve('Review (2)', { sessionPath: '/s/c.jsonl', sessionId: 'id-c' });
  assert.equal(again.title, 'Review (2)', 'a released name is reusable; no historical alias is retained');

  assert.throws(() => titles.release(reservation), /stale/, 'duplicate frees are rejected');
  assert.throws(() => titles.confirm(reservation), /stale/, 'stale confirms never publish');
});

test('repeatable reconciliation preserves published and in-flight reservations', async () => {
  const titles = new LiveSessionTitles();
  const tracker = trackingPersists();
  await titles.reconcile(
    [entry('/s/a.jsonl', 'id-a', { title: 'Review' })],
    tracker.persist,
  );
  titles.reserve('Follow-up', { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });

  // Re-restoration with a new live member must not free the in-flight name,
  // and published titles stay idempotent without new persistence.
  const beforePersistCalls = tracker.calls.length;
  const repeat = await titles.reconcile([
    entry('/s/a.jsonl', 'id-a', { title: 'Review' }),
    entry('/s/c.jsonl', 'id-c', { title: 'Review (2)' }),
  ], tracker.persist);

  assert.equal(titles.ready, true);
  assert.deepEqual(tracker.calls.slice(beforePersistCalls), []);
  assert.deepEqual(repeat.preserved, [
    { sessionPath: '/s/a.jsonl', sessionId: 'id-a', title: 'Review' },
    { sessionPath: '/s/c.jsonl', sessionId: 'id-c', title: 'Review (2)' },
  ]);
  assert.deepEqual(titles.resolve('Follow-up'), undefined, 'unconfirmed reservations never publish');
  const allocated = titles.reserve('Follow-up', { sessionPath: '/s/d.jsonl', sessionId: 'id-d' });
  assert.equal(allocated.title, 'Follow-up (2)', 'the in-flight reservation stays occupied');
});

test('concurrent incoming collisions reserve different suffixes before owner persistence settles', async () => {
  const titles = new LiveSessionTitles();
  await titles.reconcile([entry('/s/old.jsonl', 'old', { title: 'Review' })], trackingPersists().persist);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const first = titles.admit([entry('/s/new.jsonl', 'new', { title: 'Review' })], async () => blocked);
  await Promise.resolve();
  const second = titles.admit([entry('/s/third.jsonl', 'third', { title: 'Review' })], async (path, title) => {
    assert.equal(path, '/s/third.jsonl');
    assert.equal(title, 'Review (3)');
  });
  await second;
  assert.equal(titles.resolve('Review (2)'), undefined, 'unconfirmed suffix is not addressable');
  unblock();
  await first;
  assert.equal(titles.assigned('/s/new.jsonl'), 'Review (2)');
  assert.equal(titles.assigned('/s/third.jsonl'), 'Review (3)');
});

test('a stale hydration pass cannot report ready after membership changes during persistence', async () => {
  const titles = new LiveSessionTitles();
  let current = true;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const hydration = titles.reconcile([
    entry('/s/old.jsonl', 'old', { title: 'Review' }),
    entry('/s/new.jsonl', 'new', { title: 'Review' }),
  ], async () => blocked, () => current);
  await Promise.resolve();
  current = false;
  unblock();
  await assert.rejects(hydration, LiveTitleNamespaceUnavailableError);
  assert.equal(titles.ready, false);
  assert.throws(() => titles.resolve('Review'), LiveTitleNamespaceUnavailableError);
});

test('a durable restored title outranks an in-flight reservation holding the same name', async () => {
  const titles = new LiveSessionTitles();
  await titles.reconcile(
    [entry('/s/a.jsonl', 'id-a', { title: 'Review' })],
    trackingPersists().persist,
  );
  const inFlight = titles.reserve('Restored Name', { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  assert.equal(inFlight.title, 'Restored Name');

  const repeat = await titles.reconcile([
    entry('/s/c.jsonl', 'id-c', { title: 'Restored Name' }),
    entry('/s/a.jsonl', 'id-a', { title: 'Review' }),
  ], trackingPersists().persist);

  assert.equal(titles.assigned('/s/c.jsonl'), 'Restored Name', 'the durable restored title is published');
  assert.deepEqual(repeat.suffixed, [], 'no churn for the published name');
  // The in-flight reservation can no longer publish that name: an entry's
  // durable name outranks a still-unpublished reservation. Its owning flow
  // fails closed, releases, and re-reserves under the resolved namespace.
  assert.throws(() => titles.confirm(inFlight), /conflicts/);
  titles.release(inFlight);
  const retaken = titles.reserve('Restored Name', { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  assert.equal(retaken.title, 'Restored Name (2)');
  titles.confirm(retaken);
  assert.deepEqual(titles.resolve('Restored Name (2)'), { sessionPath: '/s/b.jsonl', sessionId: 'id-b' });
  const next = titles.reserve('Restored Name', { sessionPath: '/s/d.jsonl', sessionId: 'id-d' });
  assert.equal(next.title, 'Restored Name (3)');
});