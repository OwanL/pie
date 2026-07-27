import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INITIAL_REVIEW_AUTO_CLOSE_STATE,
  computeReviewAutoCloseClosures,
} from '../../../src/shared/review-auto-close';
import { PENDING_SESSION_PREFIX } from '../../../src/shared/tab-behavior';
import type { ClosureAction } from '../../../src/shared/protocol';

function action(
  actionId: string,
  overrides: Partial<ClosureAction> = {},
): ClosureAction {
  return {
    actionId,
    kind: 'closeReviewed',
    targetSessionId: `session-${actionId}`,
    reviewId: `review-${actionId}`,
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

function summary(path: string, closureActions?: ClosureAction[]) {
  return { path, closureActions };
}

test('review-auto-close: explicit pending action is claimed on the first refresh', () => {
  const close = action('a');
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [close])],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(result.attempts, [{
    sessionPath: '/a',
    actions: [close],
    requiresCloseCompletion: true,
  }]);
  assert.ok(result.next.claimedActionIds.has('a'));
});

test('review-auto-close: claimed action is not attempted twice', () => {
  const close = action('a');
  const first = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [close])],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  const second = computeReviewAutoCloseClosures(first.next, {
    incoming: [summary('/a', [close])],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(second.attempts, []);
});

test('review-auto-close: already-hidden idle target still requires cleanup and persistence confirmation', () => {
  const close = action('a');
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [close])],
    openTabPaths: [],
    runningPaths: [],
  });
  assert.equal(result.attempts[0]?.requiresCloseCompletion, true);
});

test('review-auto-close: running target is attempted as a persist-confirmed tab hide', () => {
  const close = action('a');
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [close])],
    openTabPaths: ['/a'],
    runningPaths: ['/a'],
  });
  assert.deepEqual(result.attempts, [{
    sessionPath: '/a',
    actions: [close],
    requiresCloseCompletion: false,
  }]);
});

test('review-auto-close: pending tab is never claimed', () => {
  const pending = `${PENDING_SESSION_PREFIX}1-abc`;
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary(pending, [action('pending')])],
    openTabPaths: [pending],
    runningPaths: [],
  });
  assert.deepEqual(result.attempts, []);
  assert.ok(!result.next.claimedActionIds.has('pending'));
});

test('review-auto-close: retrying closeSelf is drained like closeReviewed', () => {
  const closeSelf = action('self', {
    kind: 'closeSelf',
    reviewId: undefined,
    status: 'retrying',
    attempts: 1,
  });
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/reviewer', [closeSelf])],
    openTabPaths: ['/reviewer'],
    runningPaths: [],
  });
  assert.deepEqual(result.attempts[0]?.actions, [closeSelf]);
});

test('review-auto-close: succeeded and failed terminal actions are not retried', () => {
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [
      action('done', { status: 'succeeded' }),
      action('failed', { status: 'failed' }),
    ])],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(result.attempts, []);
  assert.ok(result.next.claimedActionIds.has('done'));
  assert.ok(result.next.claimedActionIds.has('failed'));
});

test('review-auto-close: duplicate actions for one path share one correlated attempt', () => {
  const first = action('a');
  const second = action('b', { targetSessionId: first.targetSessionId });
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', [first, second])],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0]?.actions, [first, second]);
});
