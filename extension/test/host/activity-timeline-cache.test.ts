import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { ActivityTimeline } from '../../src/host/activity-timeline/service';
import type { ActivityIntervalRecord } from '../../src/shared/activity-interval';

let directory: string;
let timelinePath: string;
let journalPath: string;
let privacyPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-activity-timeline-cache-'));
  timelinePath = path.join(directory, 'activity-intervals.json');
  journalPath = path.join(directory, 'activity-intervals.journal.jsonl');
  privacyPath = path.join(directory, 'accounting-private-sessions.json');
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

function writeLegacySnapshot(records: readonly ActivityIntervalRecord[]): void {
  fs.writeFileSync(timelinePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function compact(id: string, index: number): ActivityIntervalRecord {
  return {
    schemaVersion: 1,
    intervalId: id,
    sessionId: `session-${index % 7}`,
    sessionPath: `/session/${index % 7}.jsonl`,
    parentRunId: `run-${index}`,
    parentOperationId: null,
    invocationId: `invocation-${index}`,
    toolId: null,
    kind: 'provider',
    startedAt: '2026-09-05T10:00:00.000Z',
    endedAt: '2026-09-05T10:00:01.000Z',
    outcome: 'succeeded',
  };
}

test('signature-gated cache serves projections without re-reading unchanged history', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-a'));
  const before = timeline.getDiagnostics();
  assert.deepEqual([...timeline.projectAll()], [interval('busy-a')]);
  assert.deepEqual([...timeline.projectAll()], [interval('busy-a')]);
  const after = timeline.getDiagnostics();
  assert.equal(after.readCount - before.readCount, 0, 'unchanged history is not re-parsed');
  assert.equal(after.bytesRead - before.bytesRead, 0);
  assert.equal(after.cacheRevalidationHits - before.cacheRevalidationHits, 2);
});

test('warm instances observe sibling appends and settlements via signature revalidation', () => {
  const first = new ActivityTimeline(timelinePath);
  const second = new ActivityTimeline(timelinePath);
  first.start(interval('busy-a'));
  second.start(interval('busy-b'));

  assert.deepEqual(first.projectAll().map((record) => record.intervalId), ['busy-a', 'busy-b']);
  second.settle('busy-a', '2026-09-05T10:00:04.000Z', 'succeeded');
  const observed = first.projectAll();
  const settled = observed.find((record) => record.intervalId === 'busy-a');
  assert.equal(settled?.endedAt, '2026-09-05T10:00:04.000Z');
  // Settlement is immutable: a stale sibling cannot re-settle it.
  first.settle('busy-a', '2026-09-05T10:00:09.000Z', 'failed');
  assert.equal(first.projectAll().find((record) => record.intervalId === 'busy-a')?.endedAt,
    '2026-09-05T10:00:04.000Z');
});

test('routine mutations append journal deltas and never rewrite the legacy snapshot', () => {
  writeLegacySnapshot([compact('snapshot-0', 0)]);
  const snapshotBefore = fs.readFileSync(timelinePath);
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-new', { sessionPath: '/session/z.jsonl', sessionId: 'session-z' }));
  const after = timeline.getDiagnostics();

  assert.equal(after.writeCount, 0, 'no full snapshot rewrite for a routine start');
  assert.equal(after.journalAppendCount, 1);
  assert.equal(after.fsyncCount, 1);
  assert.deepEqual(fs.readFileSync(timelinePath), snapshotBefore, 'snapshot bytes untouched');
  assert.ok(fs.existsSync(journalPath), 'journal carries the delta');

  const restarted = new ActivityTimeline(timelinePath);
  const records = restarted.projectAll();
  assert.deepEqual(records.map((record) => record.intervalId), ['snapshot-0', 'busy-new']);
});

test('small mutation cost is independent of snapshot size', () => {
  writeLegacySnapshot(Array.from({ length: 5_000 }, (_, index) => compact(`snapshot-${index}`, index)));
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-seed', { sessionPath: '/session/z.jsonl', sessionId: 'session-z' }));
  const before = timeline.getDiagnostics();
  timeline.start(interval('busy-small', { sessionPath: '/session/z.jsonl', sessionId: 'session-z' }));
  const after = timeline.getDiagnostics();

  assert.equal(after.writeCount - before.writeCount, 0);
  assert.equal(after.journalAppendCount - before.journalAppendCount, 1);
  assert.ok(after.journalAppendedBytes - before.journalAppendedBytes < 1_000,
    `journal append must stay small, saw ${after.journalAppendedBytes - before.journalAppendedBytes} bytes`);
});

test('external snapshot replacement is picked up by a warm cache', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-old'));
  // An external writer replaces the canonical snapshot (e.g. restore).
  writeLegacySnapshot([compact('external-0', 0), compact('external-1', 1)]);
  const records = timeline.projectAll();
  // The journal is part of canonical state: replacement + journal replay merge.
  assert.deepEqual(records.map((record) => record.intervalId).sort(),
    ['busy-old', 'external-0', 'external-1'].sort());
});

test('torn journal tail is skipped and later appends stay well-formed', () => {
  fs.writeFileSync(journalPath, `${JSON.stringify(interval('busy-good'))}\n{"schemaVersion":1,"intervalId":"tor`, 'utf8');
  const timeline = new ActivityTimeline(timelinePath);
  assert.deepEqual(timeline.projectAll().map((record) => record.intervalId), ['busy-good']);

  timeline.start(interval('busy-next', { sessionPath: '/session/z.jsonl', sessionId: 'session-z' }));
  const restarted = new ActivityTimeline(timelinePath);
  const records = restarted.projectAll();
  assert.deepEqual(records.map((record) => record.intervalId).sort(), ['busy-good', 'busy-next'].sort());
  assert.ok(records.every((record) => record.sessionPath.length > 0), 'no torn record leaked');
});

test('compaction is explicit and asynchronous rather than a mutation-path rewrite', async () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.recordMany(Array.from({ length: 1_500 }, (_, index) => compact(`batch-a-${index}`, index)), { durableRequired: true });
  timeline.recordMany(Array.from({ length: 600 }, (_, index) => compact(`batch-b-${index}`, index)), { durableRequired: true });

  const before = timeline.getDiagnostics();
  assert.equal(before.journalCompactionCount, 0, 'large routine writes do not compact synchronously');
  assert.equal(before.writeCount, 0);
  assert.equal(before.journalAppendCount, 2);
  assert.ok(fs.existsSync(journalPath), 'routine writes remain journaled');

  assert.equal(await timeline.compact(), true);
  const diagnostics = timeline.getDiagnostics();
  assert.equal(diagnostics.journalCompactionCount, 1);
  assert.equal(diagnostics.writeCount, 1);
  assert.equal(diagnostics.journalAppendCount, 2);
  assert.ok(!fs.existsSync(journalPath), 'explicit compaction resets the journal');
  assert.equal(timeline.projectAll().length, 2_100);

  const restarted = new ActivityTimeline(timelinePath);
  assert.equal(restarted.projectAll().length, 2_100, 'compacted snapshot carries the full history');
});

test('privacy scrub physically removes attributed data from snapshot and journal with no resurrection', () => {
  writeLegacySnapshot([
    interval('private-0', { endedAt: '2026-09-05T10:00:01.000Z', outcome: 'succeeded' }),
    compact('keeper-1', 1),
  ]);
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('private-busy', { sessionId: 'session-a', sessionPath: '/session/a.jsonl' }));
  timeline.start(interval('keeper-busy', { sessionId: 'session-keeper', sessionPath: '/session/keeper.jsonl' }));

  // A second instance holds a warm cache across the scrub (stale host).
  const stale = new ActivityTimeline(timelinePath);
  stale.projectAll();

  fs.writeFileSync(privacyPath, `${JSON.stringify([{ sessionPath: '/session/a.jsonl', sessionId: 'session-a' }])}\n`, 'utf8');
  timeline.forgetSession('/session/a.jsonl', 'session-a');

  const snapshotText = fs.existsSync(timelinePath) ? fs.readFileSync(timelinePath, 'utf8') : '';
  const journalText = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '';
  const artifact = `${snapshotText}${journalText}`;
  assert.ok(!artifact.includes('session-a'), 'no private session id artifact in durable files');
  assert.ok(!artifact.includes('/session/a.jsonl'), 'no private session path artifact in durable files');
  assert.ok(artifact.includes('keeper-1'));

  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual(restarted.projectAll().map((record) => record.intervalId), ['keeper-1', 'keeper-busy']);
  // The stale warm cache must not resurrect scrubbed data.
  assert.deepEqual(stale.projectAll().map((record) => record.intervalId), ['keeper-1', 'keeper-busy']);
});

test('privacy-fenced starts are filtered from journal appends and later reloads', () => {
  fs.writeFileSync(privacyPath, `${JSON.stringify([{ sessionPath: '/session/a.jsonl' }])}\n`, 'utf8');
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('fenced'));
  timeline.start(interval('keeper', { sessionId: 'session-keeper', sessionPath: '/session/keeper.jsonl' }));
  const after = timeline.getDiagnostics();
  assert.equal(after.journalAppendCount, 1, 'the fenced start never reaches the journal');
  assert.deepEqual(timeline.projectAll().map((record) => record.intervalId), ['keeper']);

  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual(restarted.projectAll().map((record) => record.intervalId), ['keeper']);
});

test('a reset-marker journal recovers an in-flight empty tombstone without resurrection', () => {
  writeLegacySnapshot([interval('old-record')]);
  fs.writeFileSync(journalPath, '{"__activityTimeline":"reset"}\n', 'utf8');

  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual(restarted.projectAll(), []);
});

test('forgetting every record leaves a durable empty snapshot tombstone', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-a'));
  timeline.forgetSession('/session/a.jsonl');
  assert.ok(fs.existsSync(timelinePath), 'empty timeline keeps the tombstone snapshot');
  assert.deepEqual(JSON.parse(fs.readFileSync(timelinePath, 'utf8')), []);
  assert.ok(!fs.existsSync(journalPath), 'empty timeline removes the journal');
  assert.deepEqual([...timeline.projectAll()], []);

  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual([...restarted.projectAll()], []);
});

test('initialize() warms the cache with bounded yields and a superseded warmup cannot overwrite the live cache', async () => {
  writeLegacySnapshot(Array.from({ length: 30_000 }, (_, index) => compact(`snapshot-${index}`, index)));
  const timeline = new ActivityTimeline(timelinePath);

  let yields = 0;
  let ticking = true;
  const tick = (): void => {
    if (!ticking) return;
    yields += 1;
    setImmediate(tick);
  };
  setImmediate(tick);

  const initialization = timeline.initialize();
  // A synchronous mutation races the warm-up and must survive it.
  timeline.start(interval('live-during-warmup', { sessionId: 'session-live', sessionPath: '/session/live.jsonl' }));
  await initialization;
  ticking = false;

  const diagnostics = timeline.getDiagnostics();
  assert.equal(diagnostics.initializeCount, 1);
  assert.ok(yields > 0, 'warm-up yields to the event loop while parsing');
  const records = timeline.projectAll();
  assert.equal(records.length, 30_001, 'staged and live records both survive the warm-up');

  const restarted = new ActivityTimeline(timelinePath);
  assert.equal(restarted.projectAll().length, 30_001);
});

test('initialize() yields while replaying a large journal', async () => {
  const writer = new ActivityTimeline(timelinePath);
  writer.recordMany(Array.from({ length: 30_000 }, (_, index) => compact(`journal-${index}`, index)), {
    durableRequired: true,
  });
  const timeline = new ActivityTimeline(timelinePath);
  let yields = 0;
  let ticking = true;
  const tick = (): void => {
    if (!ticking) return;
    yields += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  await timeline.initialize();
  ticking = false;

  assert.equal(timeline.projectAll().length, 30_000);
  assert.ok(yields > 0, 'large journal replay yields to the event loop');
});

test('initialize() filters a cache loaded during warmup when a privacy fence appears before commit', async () => {
  writeLegacySnapshot([
    interval('private-warm', { sessionPath: '/session/private.jsonl', sessionId: 'private' }),
    compact('keeper-warm', 1),
  ]);
  const timeline = new ActivityTimeline(timelinePath);
  const initialization = timeline.initialize();
  // Force the loaded-merge branch while initialize() is between async reads
  // and its locked publish, then create the fence before that publish.
  assert.equal(timeline.projectAll().length, 2);
  fs.writeFileSync(privacyPath, `${JSON.stringify([{ sessionPath: '/session/private.jsonl' }])}\n`, 'utf8');
  await initialization;

  assert.deepEqual(timeline.projectAll().map((record) => record.intervalId), ['keeper-warm']);
  const restarted = new ActivityTimeline(timelinePath);
  assert.deepEqual(restarted.projectAll().map((record) => record.intervalId), ['keeper-warm']);
});

test('initialize() revalidation after a warm cache performs no disk read', async () => {
  writeLegacySnapshot([compact('snapshot-0', 0)]);
  const timeline = new ActivityTimeline(timelinePath);
  await timeline.initialize();
  const before = timeline.getDiagnostics();
  await timeline.initialize();
  const after = timeline.getDiagnostics();
  assert.equal(after.readCount, before.readCount);
  assert.equal(after.initializeCount, before.initializeCount, 'a warm initialize() only revalidates');
  assert.equal(after.cacheRevalidationHits, before.cacheRevalidationHits + 1);
});

test('sibling journal appends on a large warmed base replay only the tail', () => {
  writeLegacySnapshot(Array.from({ length: 5_000 }, (_, index) => compact(`snapshot-${index}`, index)));
  const hostA = new ActivityTimeline(timelinePath);
  const hostB = new ActivityTimeline(timelinePath);
  // Warm both caches (each performs one full load), then absorb the journal
  // creation with its unavoidable full reload before measuring the tail.
  assert.equal(hostB.projectAll().length, 5_000);
  assert.equal(hostA.projectAll().length, 5_000);
  hostA.start(interval('seed', { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
  assert.equal(hostB.projectAll().length, 5_001);

  const beforeB = hostB.getDiagnostics();
  const rounds = 6;
  for (let index = 0; index < rounds; index += 1) {
    hostA.start(interval(`a-${index}`, { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
    assert.equal(hostB.projectAll().length, 5_002 + 2 * index, 'hostB observes the sibling append');
    hostB.start(interval(`b-${index}`, { sessionId: 'session-y', sessionPath: '/session/y.jsonl' }));
    assert.equal(hostA.projectAll().length, 5_003 + 2 * index, 'hostA observes the sibling append');
  }
  // Settlements also arrive through the tail replay.
  hostA.settle('a-0', '2026-09-05T10:00:05.000Z', 'succeeded');
  const settledB = hostB.projectAll().find((record) => record.intervalId === 'a-0');
  assert.equal(settledB?.endedAt, '2026-09-05T10:00:05.000Z');
  assert.equal(settledB?.outcome, 'succeeded');

  const afterB = hostB.getDiagnostics();
  const deltaB = {
    readCount: afterB.readCount - beforeB.readCount,
    bytesRead: afterB.bytesRead - beforeB.bytesRead,
    tailReplays: afterB.journalTailReplayCount - beforeB.journalTailReplayCount,
    tailBytes: afterB.journalTailReplayedBytes - beforeB.journalTailReplayedBytes,
  };
  assert.ok(deltaB.tailReplays >= rounds, 'sibling appends are observed via incremental tail replays');
  assert.equal(deltaB.tailReplays, deltaB.readCount,
    'every reload in the measured window is an incremental tail replay');
  assert.equal(deltaB.bytesRead, deltaB.tailBytes, 'tail bytes are the only bytes read');
  const snapshotBytes = Buffer.byteLength(fs.readFileSync(timelinePath));
  assert.ok(deltaB.bytesRead < 20_000,
    `tail reads must stay bounded, saw ${deltaB.bytesRead} bytes`);
  assert.ok(deltaB.bytesRead < snapshotBytes / 10,
    `the full snapshot must not be reread, read ${deltaB.bytesRead} of ${snapshotBytes} bytes`);
});

test('journal truncation and replacement fall back to a full reload', () => {
  const hostA = new ActivityTimeline(timelinePath);
  const hostB = new ActivityTimeline(timelinePath);
  hostA.start(interval('keep-1', { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
  hostA.start(interval('keep-2', { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
  hostA.start(interval('dropped-3', { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
  assert.deepEqual(hostB.projectAll().map((record) => record.intervalId), ['keep-1', 'keep-2', 'dropped-3']);

  // External truncation (crash remnant) shrinks the journal.
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(journalPath, `${lines.slice(0, 2).join('\n')}\n`, 'utf8');
  const beforeTruncate = hostB.getDiagnostics();
  assert.deepEqual(hostB.projectAll().map((record) => record.intervalId), ['keep-1', 'keep-2']);
  assert.equal(hostB.getDiagnostics().journalTailReplayCount - beforeTruncate.journalTailReplayCount, 0,
    'a truncated journal is never replayed incrementally');

  // External replacement by rename (actual replacement) also falls back.
  const replacement = path.join(directory, 'replacement.journal.jsonl');
  fs.writeFileSync(replacement, `${JSON.stringify(interval('replaced-1'))}\n`, 'utf8');
  fs.renameSync(replacement, journalPath);
  const beforeReplace = hostB.getDiagnostics();
  assert.deepEqual(hostB.projectAll().map((record) => record.intervalId), ['replaced-1']);
  assert.equal(hostB.getDiagnostics().journalTailReplayCount - beforeReplace.journalTailReplayCount, 0,
    'a replaced journal is never replayed incrementally');
});

test('bytesWritten totals every written byte: journal appends, snapshot rewrites, and recovery journals', () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.start(interval('busy-a'));
  let diagnostics = timeline.getDiagnostics();
  assert.ok(diagnostics.bytesWritten > 0, 'routine journal appends are counted as written IO');
  assert.equal(diagnostics.bytesWritten, diagnostics.journalAppendedBytes);
  assert.equal(diagnostics.snapshotBytesWritten, 0);

  timeline.forgetSession('/session/a.jsonl');
  diagnostics = timeline.getDiagnostics();
  assert.ok(diagnostics.snapshotBytesWritten > 0, 'the scrub snapshot rewrite is accounted');
  assert.ok(diagnostics.journalCompactionBytes > 0, 'the recovery journal is accounted');
  assert.equal(diagnostics.bytesWritten,
    diagnostics.snapshotBytesWritten + diagnostics.journalAppendedBytes + diagnostics.journalCompactionBytes,
    'bytesWritten is the exact total of snapshot + journal + recovery IO');
});

test('compaction counts staging IO even when the first attempt conflicts', async () => {
  const timeline = new ActivityTimeline(timelinePath);
  timeline.recordMany(Array.from({ length: 1_500 }, (_, index) => compact(`batch-${index}`, index)), {
    durableRequired: true,
  });
  const before = timeline.getDiagnostics();
  const compaction = timeline.compact();
  // A sibling append races the staged rewrite: the first attempt commits a
  // journal delta, so the staged attempt conflicts and retries.
  timeline.start(interval('conflict-during-compaction', { sessionId: 'session-x', sessionPath: '/session/x.jsonl' }));
  assert.equal(await compaction, true);

  const delta = {
    bytesWritten: timeline.getDiagnostics().bytesWritten - before.bytesWritten,
    snapshotBytesWritten: timeline.getDiagnostics().snapshotBytesWritten - before.snapshotBytesWritten,
    journalCompactionBytes: timeline.getDiagnostics().journalCompactionBytes - before.journalCompactionBytes,
  };
  assert.ok(delta.snapshotBytesWritten > 0);
  assert.ok(delta.bytesWritten > delta.snapshotBytesWritten + delta.journalCompactionBytes,
    `the conflicted attempt's staging IO must be counted, saw ${JSON.stringify(delta)}`);
});