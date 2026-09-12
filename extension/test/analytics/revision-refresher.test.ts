import assert from 'node:assert/strict';
import test from 'node:test';

import { CanonicalRevisionRefresher } from '../../src/analytics/revision-refresher.js';

function fakeReadModel(values: Array<string | Error>) {
  let index = 0;
  return {
    calls: 0,
    readRevision(): Promise<string> {
      this.calls += 1;
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('baseline read does not notify, later changes do, and the interval is bounded', async () => {
  const model = fakeReadModel(['7', '7', '8', '8', '9']);
  const changes: string[] = [];
  const refresher = new CanonicalRevisionRefresher({
    readModel: model as any,
    onRevisionChange: (revision) => changes.push(revision),
    intervalMs: 100,
  });
  try {
    const baseline = await refresher.start();
    assert.equal(baseline, '7', 'start returns the baseline revision');
    assert.deepEqual(changes, [], 'establishing the baseline must not notify');

    // Wait on the observable condition rather than a wall-clock count: under
    // parallel test load a timer can be delayed, and asserting an exact number
    // of checks after a fixed sleep is inherently flaky.
    const deadline = Date.now() + 5_000;
    while (changes.length < 2 && Date.now() < deadline) {
      await wait(25);
    }
    refresher.stop();
    assert.deepEqual(changes, ['8', '9'], 'each observed change notifies once, in order');
    const stats = refresher.getStats();
    assert.equal(stats.changes, 2);
    assert.equal(stats.revision, '9');
    assert.equal(stats.failing, false);
  } finally {
    refresher.stop();
  }
});

test('a failing read reports the transition once and keeps checking', async () => {
  const model = fakeReadModel([new Error('database unavailable'), new Error('database unavailable'), '4']);
  const errors: unknown[] = [];
  const refresher = new CanonicalRevisionRefresher({
    readModel: model as any,
    onRevisionChange: () => {},
    onError: (error) => errors.push(error),
    intervalMs: 100,
  });
  try {
    const baseline = await refresher.start();
    assert.equal(baseline, null, 'an unreadable revision is not an error at startup');
    // Wait on the recovery condition rather than a fixed sleep, for the same
    // reason as above: a delayed timer must not fail an otherwise-correct loop.
    const deadline = Date.now() + 5_000;
    while (refresher.getStats().revision !== '4' && Date.now() < deadline) {
      await wait(25);
    }
    refresher.stop();
    assert.equal(errors.length, 1, `expected one failure notification, got ${errors.length}`);
    assert.equal(refresher.getStats().revision, '4', 'recovery updates the tracked revision');
    assert.equal(refresher.getStats().failing, false);
  } finally {
    refresher.stop();
  }
});

test('stop is terminal and releases the timer', async () => {
  const model = fakeReadModel(['1', '2', '3']);
  const refresher = new CanonicalRevisionRefresher({
    readModel: model as any,
    onRevisionChange: () => {},
    intervalMs: 100,
  });
  await refresher.start();
  refresher.stop();
  const callsAtStop = model.calls;
  await wait(300);
  assert.equal(model.calls, callsAtStop, 'no checks may occur after stop');
  await assert.rejects(() => refresher.start(), /stopped/);
});

test('rejects a poll interval below the floor', () => {
  assert.throws(
    () => new CanonicalRevisionRefresher({
      readModel: fakeReadModel(['1']) as any,
      onRevisionChange: () => {},
      intervalMs: 10,
    }),
    /at least 100/,
  );
});
