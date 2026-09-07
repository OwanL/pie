import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { ActivityTimeline } from '../../src/host/activity-timeline/service';
import type { ActivityIntervalRecord } from '../../src/shared/activity-interval';

let directory: string;
let timelinePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-activity-timeline-'));
  timelinePath = path.join(directory, 'activity-intervals.json');
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function interval(id: string, overrides: Partial<ActivityIntervalRecord> = {}): ActivityIntervalRecord {
  return {
    schemaVersion: 1,
    intervalId: id,
    sessionId: 'session-a',
    sessionPath: '/session/a.jsonl',
    parentRunId: 'run-a',
    parentOperationId: 'operation-a',
    invocationId: null,
    toolId: null,
    kind: 'busy',
    startedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

test('multi-instance starts merge and an open interval settles once after restart', () => {
  const first = new ActivityTimeline(timelinePath);
  const second = new ActivityTimeline(timelinePath);
  first.start(interval('busy-a'));
  second.start(interval('provider-b', {
    kind: 'provider',
    sessionId: 'session-b',
    sessionPath: '/session/b.jsonl',
    parentRunId: 'run-b',
    parentOperationId: 'operation-b',
    invocationId: 'invocation-b',
  }));

  const restarted = new ActivityTimeline(timelinePath);
  assert.equal(restarted.projectAll().length, 2);
  restarted.settle('busy-a', '2026-09-05T10:00:05.000Z', 'succeeded');
  second.settle('busy-a', '2026-09-05T10:00:06.000Z', 'failed');

  const settled = restarted.projectSession('/session/a.jsonl')[0];
  assert.equal(settled?.endedAt, '2026-09-05T10:00:05.000Z');
  assert.equal(settled?.outcome, 'succeeded');
});

test('standalone start survives a transient write failure and later settlement', () => {
  const timeline = new ActivityTimeline(timelinePath);
  const internals = timeline as unknown as { appendJournalUnlocked: (...args: unknown[]) => void };
  const append = internals.appendJournalUnlocked.bind(timeline);
  let fail = true;
  internals.appendJournalUnlocked = (...args: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error('injected activity write failure');
    }
    append(...args);
  };

  timeline.start(interval('busy-retry'));
  timeline.settle('busy-retry', '2026-09-05T10:00:03.000Z', 'succeeded');
  timeline.flush();
  const recovered = new ActivityTimeline(timelinePath).projectAll();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.endedAt, '2026-09-05T10:00:03.000Z');
});

test('invocation activity preserves operation/run/invocation conservation identities', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.record(interval('provider-a', {
    kind: 'provider',
    invocationId: 'invocation-a',
    endedAt: '2026-09-05T10:00:02.000Z',
    outcome: 'succeeded',
  }));
  const row = timeline.projectAll()[0];
  assert.deepEqual(
    [row?.parentOperationId, row?.parentRunId, row?.invocationId],
    ['operation-a', 'run-a', 'invocation-a'],
  );
});

test('a published projection is frozen and cannot corrupt index caches', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('immutable'));

  const all = timeline.projectAll() as ActivityIntervalRecord[];
  assert.ok(Object.isFrozen(all));
  assert.throws(() => all.push(interval('corrupt')));
  assert.equal(timeline.projectAll().length, 1);

  const session = timeline.projectSession('/session/a.jsonl') as ActivityIntervalRecord[];
  assert.ok(Object.isFrozen(session));
  assert.throws(() => session.splice(0, 1));
  assert.equal(timeline.projectAll().length, 1);
});

test('a failed durable scrub restores pendingScrub so the next mutation retries the physical scrub', () => {
  const journalPath = `${timelinePath.slice(0, -'.json'.length)}.journal.jsonl`;
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('private-0'));
  assert.deepEqual(timeline.projectAll().map((record) => record.intervalId), ['private-0']);

  // A privacy fence appears after the cache warmed: the next reload filters
  // the durable record out of the cache and schedules a physical scrub.
  fs.writeFileSync(path.join(directory, 'accounting-private-sessions.json'),
    `${JSON.stringify([{ sessionPath: '/session/a.jsonl' }])}\n`, 'utf8');
  assert.deepEqual(timeline.projectAll(), []);

  const internals = timeline as unknown as { writeUnlocked: (...args: unknown[]) => void };
  const scrub = internals.writeUnlocked.bind(timeline);
  let fail = true;
  internals.writeUnlocked = (...args: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error('injected activity scrub failure');
    }
    scrub(...args);
  };

  assert.throws(() => timeline.forgetSession('/session/a.jsonl'), /injected activity scrub failure/);
  // The failed scrub must not have rewritten anything durable.
  assert.ok(fs.readFileSync(journalPath, 'utf8').includes('private-0'));

  // With the writer repaired, a no-op mutation must still perform the
  // pending scrub instead of appending a routine journal delta.
  timeline.start(interval('keeper-1', { sessionId: 'session-keeper', sessionPath: '/session/keeper.jsonl' }));
  assert.ok(!fs.existsSync(journalPath), 'the scrub replaced the journal instead of appending');
  const snapshotText = fs.readFileSync(timelinePath, 'utf8');
  assert.ok(!snapshotText.includes('private-0'), 'no fenced record survives in the durable snapshot');
  assert.ok(snapshotText.includes('keeper-1'));
  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual(restarted.projectAll().map((record) => record.intervalId), ['keeper-1']);
});

test('recordMany handles batches larger than the argument spread limit', () => {
  const timeline = new ActivityTimeline(timelinePath);
  const records: ActivityIntervalRecord[] = [];
  for (let index = 0; index < 200_001; index += 1) {
    records.push(interval(`large-batch-${index}`, {
      kind: 'provider',
      invocationId: `invocation-${index}`,
      endedAt: '2026-09-05T10:00:02.000Z',
      outcome: 'succeeded',
    }));
  }

  timeline.recordMany(records, { durableRequired: true });
  assert.equal(timeline.projectAll().length, records.length);
  assert.equal(timeline.getDiagnostics().writeCount, 0);
});

test('recordMany applies a batch in one append cycle and replays idempotently', () => {
  const timeline = new ActivityTimeline(timelinePath);
  const before = timeline.getDiagnostics();

  const records = Array.from({ length: 500 }, (_, index) => interval(`batch-${index}`, {
    kind: 'provider',
    invocationId: `invocation-${index}`,
    endedAt: '2026-09-05T10:00:02.000Z',
    outcome: 'succeeded',
  }));
  timeline.recordMany(records, { durableRequired: true });
  const after = timeline.getDiagnostics();
  // One journal append (one fsync) for the whole batch, and no canonical
  // snapshot rewrite at all — not one per record.
  assert.equal(after.journalAppendCount - before.journalAppendCount, 1);
  assert.equal(after.fsyncCount - before.fsyncCount, 1);
  assert.equal(after.writeCount - before.writeCount, 0);
  assert.equal(timeline.projectAll().length, 500);

  // Replaying the same batch (the heal re-runs on every restart) must not
  // duplicate intervals or append/rewrite anything.
  const beforeReplay = timeline.getDiagnostics();
  timeline.recordMany(records, { durableRequired: true });
  const afterReplay = timeline.getDiagnostics();
  assert.equal(afterReplay.journalAppendCount, beforeReplay.journalAppendCount);
  assert.equal(afterReplay.writeCount, beforeReplay.writeCount);
  assert.equal(afterReplay.readCount, beforeReplay.readCount);
  assert.equal(timeline.projectAll().length, 500);
});
