import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { appendReview, readReviews } from '../src/store.js';
import type { ReviewRecord } from '../src/types.js';

/**
 * store.ts unit tests: the multi-reviewer provenance fields
 * (`reviewerBuckets` / `reviewerCount`) round-trip through the sidecar and
 * malformed values are dropped by `normalizeReview` without losing the rest of
 * the record. `normalizeReview` is not exported, so it is exercised through
 * `readReviews` (and `appendReview` for the write path).
 */

const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
const REVIEWS_FILE = 'reviews.jsonl';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reviewer-store-test-'));
  savedEnv = process.env[REVIEWS_DIR_ENV];
  process.env[REVIEWS_DIR_ENV] = dir;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[REVIEWS_DIR_ENV];
  } else {
    process.env[REVIEWS_DIR_ENV] = savedEnv;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write raw JSONL lines to the sidecar (one object per line). */
function writeLines(lines: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(dir, REVIEWS_FILE), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** A valid review record, typed, for the appendReview write path. */
function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    sessionPath: '/repo/sess.jsonl',
    done: true,
    rating: 4,
    completion: 'fully',
    reason: 'looks good',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A raw sidecar line, untyped, so malformed provenance values can be injected. */
function rawLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionPath: '/repo/sess.jsonl',
    done: true,
    rating: 4,
    completion: 'fully',
    reason: 'looks good',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('readReviews keeps reviewerBuckets and reviewerCount from a valid sidecar line', () => {
  writeLines([rawLine({ reviewerBuckets: ['medium', 'small'], reviewerCount: 2 })]);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r, 'record present');
  assert.deepEqual(r!.reviewerBuckets, ['medium', 'small']);
  assert.equal(r!.reviewerCount, 2);
});

test('readReviews keeps reviewerCount: 0 (non-negative integer)', () => {
  writeLines([rawLine({ reviewerCount: 0 })]);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.equal(r!.reviewerCount, 0);
  assert.equal(r!.reviewerBuckets, undefined);
});

test('readReviews drops malformed reviewerBuckets but keeps the rest of the record', () => {
  writeLines([
    { ...rawLine({ sessionPath: '/a.jsonl' }), reviewerBuckets: 'medium' },      // not an array
    { ...rawLine({ sessionPath: '/b.jsonl' }), reviewerBuckets: ['medium', 5] }, // array with non-string
  ]);
  const reviews = readReviews();
  assert.equal(reviews.get('/a.jsonl')?.reviewerBuckets, undefined);
  assert.equal(reviews.get('/b.jsonl')?.reviewerBuckets, undefined);
  // rest of the record is still normalized
  assert.equal(reviews.get('/a.jsonl')?.rating, 4);
  assert.equal(reviews.get('/b.jsonl')?.done, true);
});

test('readReviews drops malformed reviewerCount but keeps the rest of the record', () => {
  writeLines([
    { ...rawLine({ sessionPath: '/neg.jsonl' }), reviewerCount: -1 },   // negative
    { ...rawLine({ sessionPath: '/frac.jsonl' }), reviewerCount: 2.5 }, // non-integer
    { ...rawLine({ sessionPath: '/str.jsonl' }), reviewerCount: '2' },  // non-number
  ]);
  const reviews = readReviews();
  assert.equal(reviews.get('/neg.jsonl')?.reviewerCount, undefined);
  assert.equal(reviews.get('/frac.jsonl')?.reviewerCount, undefined);
  assert.equal(reviews.get('/str.jsonl')?.reviewerCount, undefined);
  assert.equal(reviews.get('/neg.jsonl')?.rating, 4);
});

test('readReviews omits provenance when the sidecar line has neither field', () => {
  writeLines([rawLine()]);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.equal(r!.reviewerBuckets, undefined);
  assert.equal(r!.reviewerCount, undefined);
});

test('readReviews keeps selfClose from a valid sidecar line', () => {
  writeLines([rawLine({ selfClose: true })]);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r, 'record present');
  assert.equal(r!.selfClose, true);
});

test('readReviews drops malformed selfClose but keeps the rest of the record', () => {
  writeLines([
    { ...rawLine({ sessionPath: '/str.jsonl' }), selfClose: 'yes' }, // not a boolean
    { ...rawLine({ sessionPath: '/num.jsonl' }), selfClose: 1 },      // not a boolean
  ]);
  const reviews = readReviews();
  assert.equal(reviews.get('/str.jsonl')?.selfClose, undefined);
  assert.equal(reviews.get('/num.jsonl')?.selfClose, undefined);
  // rest of the record is still normalized
  assert.equal(reviews.get('/str.jsonl')?.rating, 4);
  assert.equal(reviews.get('/num.jsonl')?.done, true);
});

test('appendReview writes selfClose and readReviews reads it back', () => {
  appendReview(record({ selfClose: true }));
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.equal(r!.selfClose, true);
});

test('appendReview omits selfClose from the JSONL when not provided', () => {
  appendReview(record());
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, REVIEWS_FILE), 'utf8').trim());
  assert.equal('selfClose' in parsed, false);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.equal(r!.selfClose, undefined);
});

test('appendReview writes reviewerBuckets/reviewerCount and readReviews reads them back', () => {
  appendReview(record({ reviewerBuckets: ['frontier', 'medium'], reviewerCount: 2 }));
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.deepEqual(r!.reviewerBuckets, ['frontier', 'medium']);
  assert.equal(r!.reviewerCount, 2);
});

test('appendReview omits provenance keys from the JSONL when not provided', () => {
  appendReview(record());
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, REVIEWS_FILE), 'utf8').trim());
  assert.equal('reviewerBuckets' in parsed, false);
  assert.equal('reviewerCount' in parsed, false);
  const r = readReviews().get('/repo/sess.jsonl');
  assert.ok(r);
  assert.equal(r!.reviewerBuckets, undefined);
  assert.equal(r!.reviewerCount, undefined);
});
