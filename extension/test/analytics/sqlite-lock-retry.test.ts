import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSqliteLockRetryBudget,
  isSqliteLockContention,
  retrySqliteLock,
  type SqliteLockRetryBudget,
} from '../../src/analytics/sqlite-lock-retry.js';

function busyError(): Error & { code: string } {
  const error = new Error('database is locked');
  Object.assign(error, { code: 'SQLITE_BUSY' });
  return error as Error & { code: string };
}

test('recognizes SQLite lock codes and leaves ordinary failures alone', () => {
  assert.equal(isSqliteLockContention(busyError()), true);
  assert.equal(isSqliteLockContention(new Error('schema is malformed')), false);
  assert.equal(isSqliteLockContention({ code: 'SQLITE_CONSTRAINT', message: 'database is locked' }), false);
  assert.equal(isSqliteLockContention({ code: 'ERR_SQLITE_ERROR', errcode: 19, message: 'database is locked' }), false);
  assert.equal(isSqliteLockContention({ code: 'ERR_SQLITE_ERROR', errcode: 517 }), true);
  assert.equal(isSqliteLockContention({ code: 'ERR_SQLITE_ERROR', errcode: 262 }), true);
  assert.equal(isSqliteLockContention({ code: { toString: null }, message: { toString: null } }), false);
});

test('returns a successful first attempt without introducing a wait', async () => {
  const budget = createSqliteLockRetryBudget();
  let attempts = 0;
  const startedAt = performance.now();
  const result = await retrySqliteLock(() => {
    attempts += 1;
    return 'accepted';
  }, budget);
  assert.equal(result, 'accepted');
  assert.equal(attempts, 1);
  assert.ok(performance.now() - startedAt < 100, 'a non-contended write must not sleep');
});

test('uses one budget across partial subject transactions without replay accounting', async () => {
  const budget = createSqliteLockRetryBudget();
  const committed: string[] = [];
  let accepted = 0;
  const replayed = 0;
  let laterSubjectReleased = false;
  const releaseTimer = setTimeout(() => { laterSubjectReleased = true; }, 40);
  let laterAttempts = 0;
  try {
    await retrySqliteLock(() => {
      committed.push('first-subject');
      accepted += 1;
    }, budget);
    await retrySqliteLock(() => {
      laterAttempts += 1;
      if (!laterSubjectReleased) throw busyError();
      committed.push('later-subject');
      accepted += 1;
    }, budget);
  } finally {
    clearTimeout(releaseTimer);
  }
  assert.deepEqual(committed, ['first-subject', 'later-subject']);
  assert.ok(laterAttempts >= 2, 'the later subject must cross the transient lock boundary');
  assert.equal(accepted, 2, 'each subject transaction commits once');
  assert.equal(replayed, 0, 'failed lock attempts must not be counted as replayed rows');
  assert.equal((budget as SqliteLockRetryBudget).lastLockError !== undefined, true);
});

test('rethrows non-lock failures immediately without retrying', async () => {
  const budget = createSqliteLockRetryBudget();
  const original = new Error('schema is malformed');
  let attempts = 0;
  await assert.rejects(
    retrySqliteLock(() => {
      attempts += 1;
      throw original;
    }, budget),
    (error: unknown) => error === original,
  );
  assert.equal(attempts, 1);
});

test('shared budget prevents a later operation from starting after lock exhaustion', async () => {
  const budget = { deadlineMs: performance.now() + 15 } satisfies SqliteLockRetryBudget;
  const original = busyError();
  let attempts = 0;
  await assert.rejects(
    retrySqliteLock(() => {
      attempts += 1;
      throw original;
    }, budget),
    (error: unknown) => error === original,
  );
  const attemptsAtExhaustion = attempts;
  await assert.rejects(
    retrySqliteLock(() => {
      attempts += 1;
      throw new Error('must not start after shared deadline');
    }, budget),
    (error: unknown) => error === original,
  );
  assert.equal(attempts, attemptsAtExhaustion);
});
