/**
 * Reducer-level tests for `handleSessionScopeCleared` cleanup of
 * `pending.ops` and `pending.requestIdToLocalId`.
 *
 * Bug: `handleSessionScopeCleared` cleared per-session transcript/maps but
 * did NOT clean `pending.ops` or `pending.requestIdToLocalId`. Without this,
 * a pending.ops entry is orphaned if the matching `SendResult`/`EditResult`
 * never arrives (backend crash, dropped event). Mirrors the cleanup already
 * performed in `removeSessionFromState` (helpers.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { SessionSummary } from '../src/shared/protocol';

// A state with backendReady=true — needed because the Send Command handler
// only records a `pending.ops` entry on the normal (non-queued) path, which
// requires the backend to be ready.
const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

function summary(path: string): SessionSummary {
  return {
    path,
    name: 'Test',
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: false,
  };
}

function sendCmd(corrId: string, sessionPath: string, localId: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId,
      sessionPath,
      text: 'hello',
      inputs: [],
      composedText: 'hello',
      localId,
      userParts: [{ kind: 'text', text: 'hello' }],
      previousSummary: null,
      timestamp: 1,
    },
  };
}

function editCmd(corrId: string, sessionPath: string, localId: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId,
      sessionPath,
      messageId: 'msg-1',
      text: 'edited',
      inputs: [],
      composedText: 'edited',
      userParts: undefined,
      localId,
      timestamp: 1,
    },
  };
}

function scopeCleared(sessionPath: string, removeSessionSummary: boolean): Event {
  return { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary };
}

// ─── pending.ops ────────────────────────────────────────────────────────────

test('SessionScopeCleared{removeSessionSummary:false} drops pending.ops for the closed session', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a')],
      openTabPaths: ['/a'],
      activeSessionPath: '/a',
    },
  };

  // Dispatch a Send for /a (corrId c1) → pending.ops['c1'] recorded.
  const afterSend = reducer(state, sendCmd('c1', '/a', 'loc-1'));
  assert.ok(afterSend.state.pending.ops['c1'], 'pending.ops[c1] should exist after Send');
  assert.equal(afterSend.state.pending.ops['c1']?.sessionPath, '/a');

  // Close the tab for /a (scope cleared, summary kept).
  const out = reducer(afterSend.state, scopeCleared('/a', false));

  // The c1 entry was removed.
  assert.equal('c1' in out.state.pending.ops, false, 'pending.ops[c1] should be removed');
  assert.deepEqual(out.state.pending.ops, {}, 'pending.ops should be empty');
});

test('SessionScopeCleared preserves pending.ops for OTHER sessions', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a'), summary('/b')],
      openTabPaths: ['/a', '/b'],
      activeSessionPath: '/a',
    },
  };

  // Dispatch sends for both /a and /b.
  const afterA = reducer(state, sendCmd('c1', '/a', 'loc-a'));
  const afterB = reducer(afterA.state, sendCmd('c2', '/b', 'loc-b'));
  assert.ok(afterB.state.pending.ops['c1'], 'pending.ops[c1] (/a) should exist');
  assert.ok(afterB.state.pending.ops['c2'], 'pending.ops[c2] (/b) should exist');

  // Close the tab for /a only.
  const out = reducer(afterB.state, scopeCleared('/a', false));

  // /a's entry removed; /b's entry preserved.
  assert.equal('c1' in out.state.pending.ops, false, 'pending.ops[c1] (/a) should be removed');
  assert.equal('c2' in out.state.pending.ops, true, 'pending.ops[c2] (/b) should survive');
  assert.equal(out.state.pending.ops['c2']?.sessionPath, '/b');
});

test('SessionScopeCleared{removeSessionSummary:true} also cleans pending.ops (no regression vs removeSessionFromState)', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a')],
      openTabPaths: ['/a'],
      activeSessionPath: '/a',
    },
  };

  const afterSend = reducer(state, sendCmd('c1', '/a', 'loc-1'));
  assert.ok(afterSend.state.pending.ops['c1'], 'pending.ops[c1] should exist after Send');

  // Full eviction path (removeSessionSummary=true).
  const out = reducer(afterSend.state, scopeCleared('/a', true));

  assert.deepEqual(out.state.pending.ops, {}, 'pending.ops should be empty');
});

// ─── pending.requestIdToLocalId ─────────────────────────────────────────────

test('SessionScopeCleared drops pending.requestIdToLocalId entries for the closed session', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a')],
      openTabPaths: ['/a'],
      activeSessionPath: '/a',
    },
  };

  // Send → then SendResult{ok:true} with a requestId → requestIdToLocalId mapping.
  const afterSend = reducer(state, sendCmd('c1', '/a', 'loc-1'));
  assert.ok(afterSend.state.pending.ops['c1'], 'pending.ops[c1] should exist after Send');

  const sendResult: Event = {
    kind: 'SendResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
    requestId: 'req-1',
  };
  const afterResult = reducer(afterSend.state, sendResult);
  assert.ok(
    afterResult.state.pending.requestIdToLocalId['req-1'],
    'requestIdToLocalId[req-1] should exist after SendResult{ok:true}',
  );
  assert.equal(afterResult.state.pending.requestIdToLocalId['req-1']?.sessionPath, '/a');

  // Close the tab for /a (scope cleared, summary kept).
  const out = reducer(afterResult.state, scopeCleared('/a', false));

  assert.equal(
    'req-1' in out.state.pending.requestIdToLocalId,
    false,
    'requestIdToLocalId[req-1] should be removed for closed session /a',
  );
  assert.deepEqual(out.state.pending.requestIdToLocalId, {}, 'requestIdToLocalId should be empty');
});

test('SessionScopeCleared preserves requestIdToLocalId entries for OTHER sessions', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a'), summary('/b')],
      openTabPaths: ['/a', '/b'],
      activeSessionPath: '/a',
    },
  };

  // /a: send + result
  const afterA = reducer(state, sendCmd('c1', '/a', 'loc-a'));
  const afterAResult = reducer(afterA.state, {
    kind: 'SendResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
    requestId: 'req-a',
  } as Event);
  // /b: send + result
  const afterB = reducer(afterAResult.state, sendCmd('c2', '/b', 'loc-b'));
  const afterBResult = reducer(afterB.state, {
    kind: 'SendResult',
    corrId: 'c2',
    sessionPath: '/b',
    ok: true,
    requestId: 'req-b',
  } as Event);
  assert.ok(afterBResult.state.pending.requestIdToLocalId['req-a'], 'req-a mapping should exist');
  assert.ok(afterBResult.state.pending.requestIdToLocalId['req-b'], 'req-b mapping should exist');

  // Close the tab for /a only.
  const out = reducer(afterBResult.state, scopeCleared('/a', false));

  assert.equal('req-a' in out.state.pending.requestIdToLocalId, false, 'req-a (/a) should be removed');
  assert.equal('req-b' in out.state.pending.requestIdToLocalId, true, 'req-b (/b) should survive');
  assert.equal(out.state.pending.requestIdToLocalId['req-b']?.sessionPath, '/b');
});

// ─── edit ops ───────────────────────────────────────────────────────────────

test('SessionScopeCleared also cleans pending.ops for edit ops', () => {
  const state: ArchState = {
    ...readyState,
    sessions: {
      ...readyState.sessions,
      sessions: [summary('/a')],
      openTabPaths: ['/a'],
      activeSessionPath: '/a',
    },
  };

  // Dispatch an Edit for /a → pending.ops has the edit entry.
  const afterEdit = reducer(state, editCmd('c-edit', '/a', 'loc-e1'));
  assert.ok(afterEdit.state.pending.ops['c-edit'], 'pending.ops[c-edit] should exist after Edit');
  assert.equal(afterEdit.state.pending.ops['c-edit']?.kind, 'edit');
  assert.equal(afterEdit.state.pending.ops['c-edit']?.sessionPath, '/a');

  // Close the tab for /a.
  const out = reducer(afterEdit.state, scopeCleared('/a', false));

  assert.deepEqual(out.state.pending.ops, {}, 'pending.ops should be empty after SessionScopeCleared');
});
