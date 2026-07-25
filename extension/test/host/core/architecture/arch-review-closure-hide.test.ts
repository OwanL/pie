/**
 * Reducer-level tests for the review-closure-hidden running-tab marker
 * (`reviewClosedRunningPaths`). The webview ready handshake restores ordinary
 * hidden running tabs but must NOT resurrect a tab the reviewer intentionally
 * closed via a durable closeReviewed/closeSelf outbox action. The reducer marks
 * such hides and clears the marker when the session is reopened or no longer
 * running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary } from '../../../../src/shared/protocol';

const SELF = '/self';
const TARGET = '/target';

const SUMMARY_TARGET: SessionSummary = { path: TARGET, name: 'Target', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
const SUMMARY_SELF: SessionSummary = { path: SELF, name: 'Self', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };

function buildState(running: string[], open: string[], reviewClosed: string[] = []): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [SUMMARY_TARGET, SUMMARY_SELF],
      openTabPaths: open,
      activeSessionPath: open[0] ?? null,
      runningSessionPaths: running,
      reviewClosedRunningPaths: reviewClosed,
    },
  };
}

function closeCmd(corrId: string, sessionPath: string, reviewClosure = false): Event {
  return { kind: 'Command', cmd: { kind: 'CloseSession', corrId, sessionPath, ensureClosed: true, reviewClosure } };
}

test('a review-closure CloseSession on a running tab marks it review-closed-hidden', () => {
  const state = buildState([TARGET], [TARGET]);
  const result = reducer(state, closeCmd('c1', TARGET, true));
  assert.deepEqual(result.state.sessions.openTabPaths, [], 'the running tab is hidden');
  assert.deepEqual(result.state.sessions.runningSessionPaths, [TARGET], 'the session stays running');
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [TARGET], 'the hide is marked review-closure');
});

test('an ordinary CloseSession on a running tab does NOT mark it review-closed-hidden', () => {
  const state = buildState([TARGET], [TARGET]);
  const result = reducer(state, closeCmd('c1', TARGET, false));
  assert.deepEqual(result.state.sessions.openTabPaths, []);
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [], 'an ordinary user close is not marked');
});

test('reopening a review-closure-hidden running session clears the marker', () => {
  const state = buildState([TARGET], [], [TARGET]);
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'OpenSession', corrId: 'o1', sessionPath: TARGET, placeholderSummary: null, selectionToken: 't1' },
  });
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [], 'reopening clears the review-closure marker');
  assert.ok(result.state.sessions.openTabPaths.includes(TARGET));
});

test('a review-closure retry on an already-hidden running tab re-marks it', () => {
  const state = buildState([TARGET], [], []);
  const result = reducer(state, closeCmd('c1', TARGET, true));
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [TARGET]);
});

test('RunningSessionsChanged prunes the marker for sessions no longer running', () => {
  const state = buildState([TARGET], [], [TARGET, SELF]);
  const result = reducer(state, { kind: 'RunningSessionsChanged', sessionPaths: [SELF] });
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [SELF], 'only still-running review-closed paths survive');
});

test('OpenTabsChanged prunes the marker for paths now open', () => {
  const state = buildState([TARGET, SELF], [], [TARGET, SELF]);
  const result = reducer(state, { kind: 'OpenTabsChanged', openTabPaths: [TARGET], pinnedTabPaths: [] });
  assert.deepEqual(result.state.sessions.reviewClosedRunningPaths, [SELF], 'a reopened path is no longer review-closed-hidden');
});
