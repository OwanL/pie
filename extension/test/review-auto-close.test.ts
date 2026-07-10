import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INITIAL_REVIEW_AUTO_CLOSE_STATE,
  computeReviewAutoCloseClosures,
} from '../src/shared/review-auto-close';
import { PENDING_SESSION_PREFIX } from '../src/shared/tab-behavior';

function summary(path: string, done?: boolean) {
  return { path, done };
}

test('review-auto-close: first call seeds known-done open tabs and closes nothing (no startup mass-close)', () => {
  const result = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', true), summary('/b', true), summary('/c', false)],
    openTabPaths: ['/a', '/b', '/c'],
    runningPaths: [],
  });
  assert.deepEqual(result.closures, []);
  assert.equal(result.next.initialized, true);
  assert.ok(result.next.knownDonePaths.has('/a'));
  assert.ok(result.next.knownDonePaths.has('/b'));
  assert.ok(!result.next.knownDonePaths.has('/c'));
});

test('review-auto-close: a fresh done transition on an open tab is closed once', () => {
  let state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', false)],
    openTabPaths: ['/a'],
    runningPaths: [],
  }).next;
  // /a flips to done -> one closure, then remembered.
  const r1 = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/a', true)],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(r1.closures, ['/a']);
  state = r1.next;
  // A second list with /a still done and still open closes nothing again.
  const r2 = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/a', true)],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(r2.closures, []);
});

test('review-auto-close: a done session that is not an open tab is not closed, but is remembered', () => {
  const state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [],
    openTabPaths: [],
    runningPaths: [],
  }).next;
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/x', true)],
    openTabPaths: [], // not open
    runningPaths: [],
  });
  assert.deepEqual(r.closures, []);
  // Remembered so a later reopen from the picker doesn't auto-close it.
  assert.ok(r.next.knownDonePaths.has('/x'));
});

test('review-auto-close: a running session is not closed while running, but closes once it stops', () => {
  let state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/r', false)],
    openTabPaths: ['/r'],
    runningPaths: [],
  }).next;
  // done arrives while still running -> not closed, not remembered yet.
  const r1 = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/r', true)],
    openTabPaths: ['/r'],
    runningPaths: ['/r'],
  });
  assert.deepEqual(r1.closures, []);
  assert.ok(!r1.next.knownDonePaths.has('/r'));
  state = r1.next;
  // session stops running, still done and open -> closes now.
  const r2 = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/r', true)],
    openTabPaths: ['/r'],
    runningPaths: [],
  });
  assert.deepEqual(r2.closures, ['/r']);
});

test('review-auto-close: a pending tab is never closed', () => {
  const pending = `${PENDING_SESSION_PREFIX}1-abc`;
  const state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary(pending, false)],
    openTabPaths: [pending],
    runningPaths: [],
  }).next;
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [summary(pending, true)],
    openTabPaths: [pending],
    runningPaths: [],
  });
  assert.deepEqual(r.closures, []);
});

test('review-auto-close: flip back to not-done forgets, so a later done re-closes', () => {
  let state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', true)],
    openTabPaths: ['/a'],
    runningPaths: [],
  }).next; // seeded, /a known-done
  // Reopen scenario: review flips to not-done -> forgotten.
  state = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/a', false)],
    openTabPaths: ['/a'],
    runningPaths: [],
  }).next;
  assert.ok(!state.knownDonePaths.has('/a'));
  // Now done again -> closes once more.
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/a', true)],
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(r.closures, ['/a']);
});

test('review-auto-close: multiple fresh done transitions close together', () => {
  const state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', false), summary('/b', false)],
    openTabPaths: ['/a', '/b'],
    runningPaths: [],
  }).next;
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/a', true), summary('/b', true)],
    openTabPaths: ['/a', '/b'],
    runningPaths: [],
  });
  assert.deepEqual(r.closures.sort(), ['/a', '/b']);
});

test('review-auto-close: a pinned tab with a fresh done transition is closed (pinned tabs are cleaned up too)', () => {
  // The helper treats pinned tabs as ordinary open tabs — it does not see
  // `pinnedTabPaths`. The host's `CloseSession` command drops them from
  // `pinnedTabPaths` via `evictSession`, so a done review on a pinned tab
  // unpins + closes it, matching the user's cleanup intent.
  const state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/p', false)],
    openTabPaths: ['/p'],
    runningPaths: [],
  }).next;
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [summary('/p', true)],
    openTabPaths: ['/p'],
    runningPaths: [],
  });
  assert.deepEqual(r.closures, ['/p']);
});

test('review-auto-close: a session missing from the incoming list is left alone', () => {
  const state = computeReviewAutoCloseClosures(INITIAL_REVIEW_AUTO_CLOSE_STATE, {
    incoming: [summary('/a', false)],
    openTabPaths: ['/a'],
    runningPaths: [],
  }).next;
  const r = computeReviewAutoCloseClosures(state, {
    incoming: [], // /a not in the backend list this refresh
    openTabPaths: ['/a'],
    runningPaths: [],
  });
  assert.deepEqual(r.closures, []);
});