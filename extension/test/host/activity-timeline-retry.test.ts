import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ActivityTimeline } from '../../src/host/activity-timeline/service';
import type { ActivityIntervalRecord } from '../../src/shared/activity-interval';

function interval(id: string): ActivityIntervalRecord {
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
  };
}

function withTimeline(now: () => number): {
  timeline: ActivityTimeline;
  cleanup: () => void;
  setWriteFailure: (failure: boolean) => void;
  getWriteAttempts: () => number;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-activity-timeline-retry-'));
  const timelinePath = path.join(directory, 'activity-intervals.json');
  const timeline = new ActivityTimeline(timelinePath, { now });
  const internals = timeline as unknown as {
    writeUnlocked: (...args: unknown[]) => void;
  };
  const write = internals.writeUnlocked.bind(timeline);
  let failure = true;
  let writeAttempts = 0;
  internals.writeUnlocked = (...args: unknown[]) => {
    writeAttempts += 1;
    if (failure) throw new Error('injected activity write failure');
    write(...args);
  };
  return {
    timeline,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    setWriteFailure: (value) => { failure = value; },
    getWriteAttempts: () => writeAttempts,
  };
}

test('best-effort activity mutations stay queued through backoff and recover on projection', () => {
  let now = 0;
  const h = withTimeline(() => now);
  try {
    h.timeline.start(interval('busy-a'));
    h.timeline.start(interval('busy-b'));
    h.timeline.settle('busy-a', '2026-09-05T10:00:03.000Z', 'succeeded');
    assert.equal(h.getWriteAttempts(), 1, 'new mutations must not bypass the retry window');

    now = 999;
    assert.deepEqual(h.timeline.projectAll(), []);
    assert.equal(h.getWriteAttempts(), 1, 'projection before the deadline does not retry');

    now = 1_000;
    h.setWriteFailure(false);
    const recovered = h.timeline.projectAll();
    assert.equal(h.getWriteAttempts(), 2, 'the due projection performs one queued retry');
    assert.deepEqual(recovered.map((record) => [record.intervalId, record.outcome]), [
      ['busy-a', 'succeeded'],
      ['busy-b', undefined],
    ]);
  } finally {
    h.cleanup();
  }
});

test('explicit flush bypasses automatic backoff and surfaces a persistent failure', () => {
  const h = withTimeline(() => 0);
  try {
    h.timeline.start(interval('busy-a'));
    assert.equal(h.getWriteAttempts(), 1);
    assert.throws(() => h.timeline.flush(), /injected activity write failure/);
    assert.equal(h.getWriteAttempts(), 2, 'explicit flush is not delayed by automatic backoff');

    h.timeline.start(interval('busy-b'));
    assert.equal(h.getWriteAttempts(), 2, 'the failed explicit flush re-arms automatic backoff');
  } finally {
    h.cleanup();
  }
});

test('durable-required mutations still attempt immediately and are not queued on failure', () => {
  let now = 0;
  const h = withTimeline(() => now);
  try {
    h.timeline.start(interval('best-effort'));
    assert.throws(
      () => h.timeline.start(interval('durable'), { durableRequired: true }),
      /injected activity write failure/,
    );
    assert.equal(h.getWriteAttempts(), 2, 'durableRequired bypasses automatic backoff');

    h.setWriteFailure(false);
    now = 1_000;
    const recovered = h.timeline.projectAll();
    assert.deepEqual(recovered.map((record) => record.intervalId), ['best-effort']);
  } finally {
    h.cleanup();
  }
});
