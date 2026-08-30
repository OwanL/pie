import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

import { enqueueClosure, enqueueClosureBatch, readClosureActions, readOpenTabRegistry, readReviewStore, recordReviewOnce } from '../src/store.js';
import { validReview } from './fixtures.js';

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-store-v2-'));
  previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
  else process.env.PIE_REVIEWS_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent production writes are once-only after lock-time re-read', async () => {
  const a = validReview({ reviewId: 'review-a' });
  const b = validReview({ reviewId: 'review-b' });
  const [first, second] = await Promise.all([recordReviewOnce(a), recordReviewOnce(b)]);
  assert.equal(Number(first.written) + Number(second.written), 1);
  const snapshot = readReviewStore();
  assert.equal(snapshot.v2.length, 1);
  assert.equal(snapshot.canonicalBySessionId.size, 1);
  const duplicate = first.written ? second : first;
  assert.equal(duplicate.written, false);
  if (!duplicate.written) assert.ok(duplicate.reviewId === 'review-a' || duplicate.reviewId === 'review-b');
});

test('calibration records do not collide with canonical production uniqueness', async () => {
  await recordReviewOnce(validReview({ kind: 'calibration', reviewId: 'cal-1' }));
  await recordReviewOnce(validReview({ kind: 'calibration', reviewId: 'cal-2' }));
  const production = await recordReviewOnce(validReview({ reviewId: 'prod-1' }));
  assert.equal(production.written, true);
  assert.equal(readReviewStore().v2.length, 3);
});

test('malformed lines are isolated and V2 records stay readable', async () => {
  fs.appendFileSync(path.join(dir, 'reviews.jsonl'), 'not-json\n');
  await recordReviewOnce(validReview());
  const snapshot = readReviewStore();
  assert.equal(snapshot.v2.length, 1);
});

test('open-tab authority rejects entries without explicit pin and running state', () => {
  const previousTabs = process.env.PIE_OPEN_TABS;
  const previousRevision = process.env.PIE_OPEN_TABS_REVISION;
  try {
    process.env.PIE_OPEN_TABS = JSON.stringify([
      { path: '/valid.jsonl', pinned: true, isRunning: false },
      { path: '/path-only.jsonl' },
      { path: '/unknown-running.jsonl', pinned: true },
      { path: '/unknown-pinning.jsonl', isRunning: false },
      { path: '   ', pinned: false, isRunning: false },
    ]);
    process.env.PIE_OPEN_TABS_REVISION = '0';
    const registry = readOpenTabRegistry();
    assert.deepEqual(registry.tabs, [
      { path: '/valid.jsonl', pinned: true, isRunning: false },
    ]);
    assert.equal(registry.revision, undefined, 'zero is not a valid live registry revision');
  } finally {
    if (previousTabs === undefined) delete process.env.PIE_OPEN_TABS;
    else process.env.PIE_OPEN_TABS = previousTabs;
    if (previousRevision === undefined) delete process.env.PIE_OPEN_TABS_REVISION;
    else process.env.PIE_OPEN_TABS_REVISION = previousRevision;
  }
});

test('shallow malformed V2 envelopes are ignored and do not block a valid production write', async () => {
  fs.appendFileSync(path.join(dir, 'reviews.jsonl'), `${JSON.stringify({
    schemaVersion: 2, kind: 'production', reviewId: 'shallow-review', sessionId: 'session-1',
    sessionPathAtReview: '/sessions/session-1.jsonl', rubricVersion: 'session-review-v2.1', indexVersion: 'v1', reviewedAt: '2026-07-24T10:20:00.000Z',
  })}\n`);
  const result = await recordReviewOnce(validReview());
  assert.equal(result.written, true);
  const snapshot = readReviewStore();
  assert.equal(snapshot.v2.length, 1);
  assert.equal(snapshot.canonicalBySessionId.get('session-1')?.reviewId, 'review-1');
});

test('closure actions are separate, idempotent while active, and never append a review', async () => {
  await recordReviewOnce(validReview());
  const reviewFile = path.join(dir, 'reviews.jsonl');
  const before = fs.readFileSync(reviewFile, 'utf8');
  const first = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: 'session-1', reviewId: 'review-1', targetSessionPath: '/sessions/session-1.jsonl' });
  const second = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: 'session-1', reviewId: 'review-1' });
  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(second.action.actionId, first.action.actionId);
  assert.equal(readClosureActions().length, 1);
  const wakeRecords = fs.readFileSync(path.join(dir, 'closure-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(wakeRecords.length, 2, 'active reuse appends a durable reconciliation wake record');
  assert.equal(wakeRecords[1]?.recordType, 'wake', 'the wake is state-neutral');
  assert.equal(wakeRecords[1]?.actionId, first.action.actionId, 'reuse never creates a new action ID');
  assert.equal(fs.readFileSync(reviewFile, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dir, 'closure-actions.jsonl')));
});

test('closure batches take one outbox snapshot while preserving per-item results', async () => {
  const outbox = path.join(dir, 'closure-actions.jsonl');
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const original = mutableFs.readFileSync;
  let outboxReads = 0;
  mutableFs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file !== 'number' && path.resolve(String(file)) === path.resolve(outbox)) outboxReads += 1;
    return (original as (...values: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let results;
  try {
    results = await enqueueClosureBatch([
      { kind: 'closeReviewed', targetSessionId: 'batch-1', reviewId: 'review-1' },
      { kind: 'closeReviewed', targetSessionId: 'batch-2', reviewId: 'review-2' },
    ]);
  } finally {
    mutableFs.readFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(outboxReads, 1);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => !('error' in result) && result.existing === false), true);
  assert.equal(readClosureActions().length, 2);
});

test('a reopened tab gets a new closure action after the prior action succeeded', async () => {
  const first = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: 'reopened', reviewId: 'review-1' });
  fs.appendFileSync(path.join(dir, 'closure-actions.jsonl'), `${JSON.stringify({
    ...first.action,
    status: 'succeeded',
    attempts: 1,
    settledAt: '2026-07-24T10:21:00.000Z',
  })}\n`);

  // The caller only invokes enqueue after confirming that the tab is currently
  // open. A terminal success therefore belongs to an older tab generation.
  const reopened = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: 'reopened', reviewId: 'review-1' });
  assert.equal(reopened.existing, false);
  assert.notEqual(reopened.action.actionId, first.action.actionId);
  assert.equal(reopened.action.status, 'pending');
  assert.equal(readClosureActions().length, 2);
});

test('a concurrent host terminal append cannot be reactivated by an active-action wake', async () => {
  const initial = await enqueueClosure({ kind: 'closeSelf', targetSessionId: 'racing-reviewer' });
  const outbox = path.join(dir, 'closure-actions.jsonl');
  const terminal = {
    ...initial.action,
    status: 'succeeded' as const,
    attempts: 1,
    settledAt: '2026-07-24T10:21:00.000Z',
  };

  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalOpen = mutableFs.openSync;
  const originalWrite = mutableFs.writeSync;
  const originalFsync = mutableFs.fsyncSync;
  const originalClose = mutableFs.closeSync;
  let injected = false;
  mutableFs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (!injected && path.resolve(String(file)) === path.resolve(outbox) && flags === 'a') {
      injected = true;
      const descriptor = originalOpen(file, 'a');
      try {
        originalWrite(descriptor, `${JSON.stringify(terminal)}\n`, undefined, 'utf8');
        originalFsync(descriptor);
      } finally {
        originalClose(descriptor);
      }
    }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const reused = await enqueueClosure({ kind: 'closeSelf', targetSessionId: 'racing-reviewer' });
    assert.equal(reused.existing, true);
  } finally {
    mutableFs.openSync = originalOpen;
    syncBuiltinESMExports();
  }

  assert.equal(injected, true, 'the terminal append lands between the enqueue read and wake append');
  assert.equal(readClosureActions()[0]?.status, 'succeeded', 'the later wake cannot overwrite terminal state');
  const records = fs.readFileSync(outbox, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[records.length - 1]?.recordType, 'wake');
});

test('initial closure append is fsynced before enqueue resolves', async () => {
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const original = mutableFs.fsyncSync;
  let calls = 0;
  mutableFs.fsyncSync = ((descriptor: number) => { calls += 1; return original(descriptor); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    await enqueueClosure({ kind: 'closeSelf', targetSessionId: 'durable-reviewer' });
  } finally {
    mutableFs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 1);
});

test('canonical review record append is fsynced before record resolves', async () => {
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const original = mutableFs.fsyncSync;
  let calls = 0;
  mutableFs.fsyncSync = ((descriptor: number) => { calls += 1; return original(descriptor); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try {
    const result = await recordReviewOnce(validReview());
    assert.equal(result.written, true);
  } finally {
    mutableFs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 1);
});

test('closeSelf action carries no reviewId and creates no reviews file', async () => {
  const result = await enqueueClosure({ kind: 'closeSelf', targetSessionId: 'reviewer-session', targetSessionPath: '/reviewer.jsonl' });
  assert.equal(result.action.reviewId, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'reviews.jsonl')), false);
});
