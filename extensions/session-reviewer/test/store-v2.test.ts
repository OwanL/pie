import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

import { enqueueClosure, readClosureActions, readReviewStore, recordReviewOnce } from '../src/store.js';
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
  assert.equal(fs.readFileSync(reviewFile, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dir, 'closure-actions.jsonl')));
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
