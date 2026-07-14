import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  REVIEWS_DIR_ENV,
  mergeReviewIntoSummary,
  readReviews,
} from '../../../src/backend/session-review-store';
import type { SessionSummary } from '../../../src/shared/protocol';

/**
 * session-review-store merge tests: a review sidecar carrying the
 * multi-reviewer provenance fields (`reviewerBuckets` / `reviewerCount`)
 * merges into a `SessionSummary`, malformed provenance is dropped (while the
 * rest of the review still merges), and summaries without a matching review
 * are returned unchanged.
 */

const REVIEWS_FILE = 'reviews.jsonl';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-session-review-store-test-'));
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

function writeLines(lines: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(dir, REVIEWS_FILE), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function baseSummary(pathOverride = '/repo/sess.jsonl'): SessionSummary {
  return {
    path: pathOverride,
    name: 'Session',
    cwd: '/repo',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
  };
}

function rawReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

test('mergeReviewIntoSummary merges reviewerBuckets/reviewerCount from the sidecar onto the summary', () => {
  writeLines([rawReview({ reviewerBuckets: ['medium', 'small'], reviewerCount: 2 })]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.done, true);
  assert.equal(merged.rating, 4);
  assert.equal(merged.completion, 'fully');
  assert.deepEqual(merged.reviewerBuckets, ['medium', 'small']);
  assert.equal(merged.reviewerCount, 2);
});

test('mergeReviewIntoSummary keeps reviewerCount: 0 (non-negative integer)', () => {
  writeLines([rawReview({ reviewerCount: 0 })]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewerCount, 0);
  assert.equal(merged.reviewerBuckets, undefined);
});

test('mergeReviewIntoSummary drops malformed reviewerBuckets but keeps the rest of the review', () => {
  // Two lines, same path → latest wins; the latest carries a non-string bucket.
  writeLines([
    rawReview({ reviewerBuckets: 'medium' }),
    rawReview({ reviewerBuckets: ['medium', 5] }),
  ]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewerBuckets, undefined);
  assert.equal(merged.done, true);
  assert.equal(merged.rating, 4);
});

test('mergeReviewIntoSummary drops malformed reviewerCount but keeps the rest', () => {
  writeLines([rawReview({ reviewerCount: -3 })]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewerCount, undefined);
  assert.equal(merged.rating, 4);
});

test('mergeReviewIntoSummary leaves the summary unchanged when no review exists for the path', () => {
  writeLines([rawReview({ sessionPath: '/other.jsonl' })]);
  const summary = baseSummary();
  const merged = mergeReviewIntoSummary(summary, readReviews());
  assert.equal(merged, summary); // same reference — no review, no copy
  assert.equal(merged.reviewerBuckets, undefined);
  assert.equal(merged.reviewerCount, undefined);
});
