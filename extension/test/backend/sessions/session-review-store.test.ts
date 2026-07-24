import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  REVIEWS_DIR_ENV,
  appendClosureActionRecords,
  mergeReviewIntoSummary,
  readReviews,
  resolveSessionIdentity,
} from '../../../src/backend/session-review-store';
import { REVIEW_CLOSURE_ACTIONS_FILE, type SessionSummary } from '../../../src/shared/protocol';

const REVIEWS_FILE = 'reviews.jsonl';
const SESSION_ID = 'session-stable-id';

let dir: string;
let sessionPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-session-review-store-test-'));
  sessionPath = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(sessionPath, `\n${JSON.stringify({ type: 'session', id: SESSION_ID })}\n`, 'utf8');
  savedEnv = process.env[REVIEWS_DIR_ENV];
  process.env[REVIEWS_DIR_ENV] = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[REVIEWS_DIR_ENV];
  else process.env[REVIEWS_DIR_ENV] = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLines(fileName: string, lines: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(dir, fileName), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

function baseSummary(pathOverride = sessionPath): SessionSummary {
  return {
    path: pathOverride,
    name: 'Session',
    cwd: dir,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 3,
  };
}

function rawReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionPath,
    done: true,
    rating: 4,
    completion: 'fully',
    reason: 'looks good',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function v2Review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'production',
    reviewId: 'review-1',
    sessionId: SESSION_ID,
    sessionPathAtReview: sessionPath,
    reviewedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

test('V1 remains readable with provenance and reserves its resolved stable session ID', () => {
  writeLines(REVIEWS_FILE, [rawReview({ reviewerBuckets: ['medium', 'small'], reviewerCount: 2 })]);
  const reviews = readReviews();
  const merged = mergeReviewIntoSummary(baseSummary(), reviews);
  assert.equal(merged.sessionId, SESSION_ID);
  assert.equal(merged.reviewed, true);
  assert.equal(merged.legacyReview, true);
  assert.equal(merged.done, true);
  assert.equal(merged.rating, 4);
  assert.equal(merged.completion, 'fully');
  assert.deepEqual(merged.reviewerBuckets, ['medium', 'small']);
  assert.equal(merged.reviewerCount, 2);
  assert.equal(reviews.reservedLegacyBySessionId.get(SESSION_ID)?.sessionPath, sessionPath);
});

test('V1 latest per path wins and malformed optional fields are dropped', () => {
  writeLines(REVIEWS_FILE, [
    rawReview({ reviewerBuckets: ['medium'], reviewerCount: 1, selfClose: false }),
    rawReview({ reviewerBuckets: ['medium', 5], reviewerCount: -3, selfClose: 'yes' }),
  ]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewed, true);
  assert.equal(merged.rating, 4);
  assert.equal(merged.reviewerBuckets, undefined);
  assert.equal(merged.reviewerCount, undefined);
  assert.equal(merged.selfClose, undefined);
});

test('V2 production status is keyed by sessionId across a path move and does not coerce to V1 fields', () => {
  const movedPath = path.join(dir, 'moved.jsonl');
  fs.renameSync(sessionPath, movedPath);
  writeLines(REVIEWS_FILE, [v2Review()]);

  const merged = mergeReviewIntoSummary(baseSummary(movedPath), readReviews());
  assert.equal(merged.sessionId, SESSION_ID);
  assert.equal(merged.reviewed, true);
  assert.equal(merged.reviewId, 'review-1');
  assert.equal(merged.reviewedAt, '2026-07-24T00:00:00.000Z');
  assert.equal(merged.rating, undefined);
  assert.equal(merged.done, undefined);
  assert.equal(merged.legacyReview, undefined);
});

test('the first V2 production review is canonical and calibration does not mark a session reviewed', () => {
  writeLines(REVIEWS_FILE, [
    v2Review({ kind: 'calibration', reviewId: 'calibration-1' }),
    v2Review({ reviewId: 'review-first' }),
    v2Review({ reviewId: 'review-duplicate' }),
  ]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewId, 'review-first');
});

test('resolved V1 review reserves the session after the summary path changes only when the old header remains resolvable', () => {
  writeLines(REVIEWS_FILE, [rawReview()]);
  const aliasPath = path.join(dir, 'alias.jsonl');
  fs.copyFileSync(sessionPath, aliasPath);

  const merged = mergeReviewIntoSummary(baseSummary(aliasPath), readReviews());
  assert.equal(merged.sessionId, SESSION_ID);
  assert.equal(merged.reviewed, true);
  assert.equal(merged.legacyReview, true);
});

test('missing or malformed session headers expose a deterministic identity fallback', () => {
  const malformedPath = path.join(dir, 'malformed.jsonl');
  fs.writeFileSync(malformedPath, '{not-json}\n', 'utf8');
  const first = resolveSessionIdentity(malformedPath);
  const second = resolveSessionIdentity(malformedPath);
  assert.equal(first.identityFallback, true);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.sessionId.length, 16);

  const merged = mergeReviewIntoSummary(baseSummary(malformedPath), readReviews());
  assert.equal(merged.sessionId, first.sessionId);
  assert.equal(merged.identityFallback, true);
});

test('closure outbox latest state is attached by sessionId without becoming V1 review data', () => {
  writeLines(REVIEWS_FILE, [v2Review()]);
  const pending = {
    actionId: 'close-1',
    kind: 'closeReviewed',
    targetSessionId: SESSION_ID,
    targetSessionPath: sessionPath,
    reviewId: 'review-1',
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:01:00.000Z',
  };
  writeLines(REVIEW_CLOSURE_ACTIONS_FILE, [
    pending,
    { ...pending, status: 'retrying', attempts: 1 },
    { malformed: true },
  ]);

  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewed, true);
  assert.equal(merged.reviewId, 'review-1');
  assert.equal(merged.done, undefined);
  assert.equal(merged.closureActions?.length, 1);
  assert.equal(merged.closureActions?.[0]?.status, 'retrying');
  assert.equal(merged.closureActions?.[0]?.attempts, 1);
});

test('closeReviewed action without its linked canonical review is not drained', () => {
  writeLines(REVIEW_CLOSURE_ACTIONS_FILE, [{
    actionId: 'orphan-close',
    kind: 'closeReviewed',
    targetSessionId: SESSION_ID,
    reviewId: 'missing-review',
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
  }]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.closureActions, undefined);
});

test('durable closure append writes only the outbox and preserves retry records', () => {
  appendClosureActionRecords(dir, [{
    actionId: 'retry-1',
    kind: 'closeSelf',
    targetSessionId: SESSION_ID,
    status: 'retrying',
    attempts: 1,
    lastError: 'tab persistence failed',
    requestedAt: '2026-07-24T00:00:00.000Z',
  }]);

  assert.equal(fs.existsSync(path.join(dir, REVIEWS_FILE)), false);
  const reviews = readReviews();
  assert.equal(reviews.closureActionsBySessionId.get(SESSION_ID)?.[0]?.status, 'retrying');
});

test('malformed review and outbox lines do not break session listing', () => {
  fs.writeFileSync(path.join(dir, REVIEWS_FILE), '{bad}\n', 'utf8');
  fs.writeFileSync(path.join(dir, REVIEW_CLOSURE_ACTIONS_FILE), '{bad}\n', 'utf8');
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.sessionId, SESSION_ID);
  assert.equal(merged.reviewed, undefined);
  assert.equal(merged.closureActions, undefined);
});
