/**
 * Reducer-level tests for the intentional-hidden running-tab marker
 * (`intentionallyHiddenRunningPaths`). The webview ready handshake repairs
 * only accidental omissions and must NOT resurrect a tab explicitly closed by
 * the user or by a durable closeReviewed/closeSelf outbox action. The reducer
 * clears the marker when the session is reopened or no longer running.
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

function buildState(running: string[], open: string[], intentionallyHidden: string[] = []): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [SUMMARY_TARGET, SUMMARY_SELF],
      openTabPaths: open,
      activeSessionPath: open[0] ?? null,
      runningSessionPaths: running,
      intentionallyHiddenRunningPaths: intentionallyHidden,
    },
  };
}

function closeCmd(corrId: string, sessionPath: string, reviewClosure = false): Event {
  return { kind: 'Command', cmd: { kind: 'CloseSession', corrId, sessionPath, ensureClosed: true, reviewClosure } };
}

test('a review-closure CloseSession on a running tab records intentional hide intent', () => {
  const state = buildState([TARGET], [TARGET]);
  const result = reducer(state, closeCmd('c1', TARGET, true));
  assert.deepEqual(result.state.sessions.openTabPaths, [], 'the running tab is hidden');
  assert.deepEqual(result.state.sessions.runningSessionPaths, [TARGET], 'the session stays running');
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [TARGET], 'the hide is marked intentional');
});

test('an ordinary CloseSession on a running tab records intentional hide intent', () => {
  const state = buildState([TARGET], [TARGET]);
  const result = reducer(state, closeCmd('c1', TARGET, false));
  assert.deepEqual(result.state.sessions.openTabPaths, []);
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [TARGET], 'an ordinary user close is marked intentional');
});

test('reopening an intentionally hidden running session clears the marker', () => {
  const state = buildState([TARGET], [], [TARGET]);
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'OpenSession', corrId: 'o1', sessionPath: TARGET, placeholderSummary: null, selectionToken: 't1' },
  });
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [], 'reopening clears intentional hide intent');
  assert.ok(result.state.sessions.openTabPaths.includes(TARGET));
});

test('a review-closure retry on an already-hidden running tab re-marks intentional hide intent', () => {
  const state = buildState([TARGET], [], []);
  const result = reducer(state, closeCmd('c1', TARGET, true));
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [TARGET]);
});

test('RunningSessionsChanged prunes intentional hide intent for sessions no longer running', () => {
  const state = buildState([TARGET], [], [TARGET, SELF]);
  const result = reducer(state, { kind: 'RunningSessionsChanged', sessionPaths: [SELF] });
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [SELF], 'only still-running intentional hides survive');
  assert.deepEqual(result.state.sessions.openTabPaths, [], 'terminalization does not force the hidden tab open');
});

test('BusyChanged terminalization prunes intent without reopening the hidden tab', () => {
  const state = buildState([TARGET], [], [TARGET]);
  const result = reducer(state, { kind: 'BusyChanged', sessionPath: TARGET, running: false });
  assert.deepEqual(result.state.sessions.runningSessionPaths, []);
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, []);
  assert.deepEqual(result.state.sessions.openTabPaths, []);
});

test('OpenTabsChanged prunes intentional hide intent for paths now open', () => {
  const state = buildState([TARGET, SELF], [], [TARGET, SELF]);
  const result = reducer(state, { kind: 'OpenTabsChanged', openTabPaths: [TARGET], pinnedTabPaths: [] });
  assert.deepEqual(result.state.sessions.intentionallyHiddenRunningPaths, [SELF], 'a reopened path is no longer intentionally hidden');
});
