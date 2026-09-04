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
  const internals = timeline as unknown as { writeUnlocked: (...args: unknown[]) => void };
  const write = internals.writeUnlocked.bind(timeline);
  let fail = true;
  internals.writeUnlocked = (...args: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error('injected activity write failure');
    }
    write(...args);
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
