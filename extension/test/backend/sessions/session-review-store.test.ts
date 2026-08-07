import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  REVIEWS_DIR_ENV,
  appendClosureActionRecords,
  mergeReviewIntoSummary,
  mergeReviewsIntoSummaries,
  readReviews,
  resolveSessionIdentity,
} from '../../../src/backend/session-review-store';
import { REVIEW_CLOSURE_ACTIONS_FILE, type SessionSummary } from '../../../src/shared/protocol';
import { validReview } from '../../../../extensions/session-reviewer/test/fixtures.js';

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

function v2Review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(validReview()),
    kind: 'production',
    reviewId: 'review-1',
    sessionId: SESSION_ID,
    sessionPathAtReview: sessionPath,
    reviewedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  } as unknown as Record<string, unknown>;
}

test('V2 production status is keyed by sessionId across a path move', () => {
  const movedPath = path.join(dir, 'moved.jsonl');
  fs.renameSync(sessionPath, movedPath);
  writeLines(REVIEWS_FILE, [v2Review()]);

  const merged = mergeReviewIntoSummary(baseSummary(movedPath), readReviews());
  assert.equal(merged.sessionId, SESSION_ID);
  assert.equal(merged.reviewed, true);
  assert.equal(merged.reviewId, 'review-1');
  assert.equal(merged.reviewedAt, '2026-07-24T00:00:00.000Z');
});

test('the first V2 production review is canonical and calibration is non-canonical', () => {
  writeLines(REVIEWS_FILE, [
    v2Review({ kind: 'calibration', reviewId: 'calibration-1' }),
    v2Review({ reviewId: 'review-first' }),
    v2Review({ reviewId: 'review-duplicate' }),
  ]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewed, true);
  assert.equal(merged.reviewId, 'review-first');
});

test('a shallow V2 envelope without canonical evidence is ignored', () => {
  writeLines(REVIEWS_FILE, [{
    schemaVersion: 2,
    kind: 'production',
    reviewId: 'shallow-review',
    sessionId: SESSION_ID,
    sessionPathAtReview: sessionPath,
    rubricVersion: 'session-review-v2.1',
    indexVersion: 'v1',
    reviewedAt: '2026-07-24T00:00:00.000Z',
  }]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewed, undefined);
});

test('records without the V2 rubric and index are ignored', () => {
  writeLines(REVIEWS_FILE, [
    v2Review({ rubricVersion: 'session-review-v2' }),
    v2Review({ indexVersion: 'v2' }),
  ]);
  const merged = mergeReviewIntoSummary(baseSummary(), readReviews());
  assert.equal(merged.reviewed, undefined);
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

test('closure outbox latest state is attached by sessionId', () => {
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
  assert.equal(merged.closureActions?.length, 1);
  assert.equal(merged.closureActions?.[0]?.status, 'retrying');
  assert.equal(merged.closureActions?.[0]?.attempts, 1);
});

test('active closure target absent from the SDK catalog is exposed for bounded host reconciliation', () => {
  writeLines(REVIEW_CLOSURE_ACTIONS_FILE, [{
    actionId: 'missing-target-close',
    kind: 'closeSelf',
    targetSessionId: SESSION_ID,
    targetSessionPath: path.join(dir, 'already-missing.jsonl'),
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
  }]);

  const merged = mergeReviewsIntoSummaries([], readReviews());
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.sessionId, SESSION_ID);
  assert.equal(merged[0]?.isPlaceholder, true);
  assert.equal(merged[0]?.closureActions?.[0]?.actionId, 'missing-target-close');
});

test('terminal closure target absent from the SDK catalog does not create a synthetic summary', () => {
  writeLines(REVIEW_CLOSURE_ACTIONS_FILE, [{
    actionId: 'settled-missing-target',
    kind: 'closeSelf',
    targetSessionId: SESSION_ID,
    targetSessionPath: path.join(dir, 'already-missing.jsonl'),
    status: 'failed',
    attempts: 3,
    requestedAt: '2026-07-24T00:00:00.000Z',
    settledAt: '2026-07-24T00:01:00.000Z',
  }]);

  assert.deepEqual(mergeReviewsIntoSummaries([], readReviews()), []);
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
