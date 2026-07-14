/**
 * Phase 3 chunk 1 — collapsing `QueueManager.pendingSendQueue` into `ArchState`.
 *
 * The reducer owns the pending-send queue (`pending.sendQueueBySession`). When
 * a `Send` Command targets a pending tab path, the reducer queues the entry +
 * inserts the optimistic message + clears the draft — but does NOT emit
 * `SendRpc` (no backend call yet) and does NOT mark the session running. When
 * `PendingPathReplaced` resolves the pending path, the reducer emits a
 * `DrainPendingSendQueue` effect carrying the queued entries; the runner
 * re-dispatches each as a `Send` Command with the resolved path (which goes
 * through the normal non-pending path: optimistic insert + running + SendRpc).
 * `SessionScopeCleared` clears the queue (tab close / creation failure).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { Effect } from '../../../../src/host/core/effects';
import { PENDING_SESSION_PREFIX } from '../../../../src/shared/tab-behavior';
import type { ComposerInput, SessionSummary } from '../../../../src/shared/protocol';

const PENDING = `${PENDING_SESSION_PREFIX}abc-123`;
const RESOLVED = '/workspace/sessions/real-session.jsonl';

function placeholderSummary(path: string, name = 'New Chat'): SessionSummary {
  return {
    path,
    name,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
}

function buildState(overrides: Partial<ArchState> = {}): ArchState {
  return { ...initialArchState, ...overrides };
}

function sendCmd(corrId: string, sessionPath: string, text: string, extra: Partial<{
  inputs: ComposerInput[];
  composedText: string;
  localId: string;
  previousSummary: SessionSummary | null;
  timestamp: number;
}> = {}): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId,
      sessionPath,
      text,
      inputs: extra.inputs ?? [],
      composedText: extra.composedText ?? text,
      localId: extra.localId ?? `local:${corrId}`,
      userParts: undefined,
      previousSummary: extra.previousSummary ?? null,
      timestamp: extra.timestamp ?? 1000,
    },
  };
}

function pendingPathReplaced(oldPendingPath: string, newSessionPath: string): Event {
  return { kind: 'PendingPathReplaced', oldPendingPath, newSessionPath };
}

function sessionScopeCleared(sessionPath: string, removeSessionSummary = false): Event {
  return { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary };
}

// ─── Send Command: pending path → queue, no SendRpc ───────────────────────────

test('Send to pending path: inserts optimistic message, queues entry, clears draft, no SendRpc', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
    composer: {
      ...initialArchState.composer,
      draftTextBySession: { [PENDING]: 'hello world' },
    },
  });

  const out = reducer(state, sendCmd('c1', PENDING, 'hello world'));

  // No SendRpc — the send is queued, not sent to the backend yet.
  assert.deepEqual(out.effects, []);

  // Optimistic message inserted into the transcript.
  const transcript = out.state.transcript.bySession[PENDING];
  assert.equal(transcript?.length, 1);
  assert.equal(transcript?.[0]?.role, 'user');
  assert.equal(transcript?.[0]?.id, 'local:c1');
  assert.equal(transcript?.[0]?.markdown, 'hello world');

  // Queued in pending.sendQueueBySession.
  const queue = out.state.pending.sendQueueBySession[PENDING];
  assert.equal(queue?.length, 1);
  assert.equal(queue?.[0]?.corrId, 'c1');
  assert.equal(queue?.[0]?.text, 'hello world');
  assert.equal(queue?.[0]?.localId, 'local:c1');

  // Draft cleared.
  assert.equal(out.state.composer.draftTextBySession[PENDING], undefined);

  // Session NOT marked running (the backend hasn't received the send yet).
  assert.equal(out.state.sessions.runningSessionPaths.includes(PENDING), false);

  // No pending.ops entry (no RPC to reconcile yet).
  assert.equal(out.state.pending.ops['c1'], undefined);
});

test('Send to pending path: previousSummary is null in the queue entry (not the placeholder)', () => {
  const placeholder = placeholderSummary(PENDING);
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholder],
      openTabPaths: [PENDING],
    },
  });

  // The Send Command carries previousSummary = placeholder (from onSend's
  // SessionNameDerived logic), but the reducer stores null in the queue entry
  // to prevent a SendResult{ok:false} from reverting the name to the placeholder
  // after the session has resolved to a real one.
  const out = reducer(state, sendCmd('c1', PENDING, 'hello', {
    previousSummary: placeholder,
  }));

  const queue = out.state.pending.sendQueueBySession[PENDING];
  assert.equal(queue?.[0]?.previousSummary, null);
});

test('Send to pending path: multiple sends queue in order', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
    },
  });

  let s = state;
  s = reducer(s, sendCmd('c1', PENDING, 'first')).state;
  s = reducer(s, sendCmd('c2', PENDING, 'second')).state;

  const queue = s.pending.sendQueueBySession[PENDING];
  assert.equal(queue?.length, 2);
  assert.equal(queue?.[0]?.text, 'first');
  assert.equal(queue?.[1]?.text, 'second');

  // Both optimistic messages in the transcript.
  assert.equal(s.transcript.bySession[PENDING]?.length, 2);
});

test('Send to non-pending path: normal path (SendRpc emitted, session running, pending.ops set)', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(RESOLVED, 'Real')],
      openTabPaths: [RESOLVED],
    },
    settings: { ...initialArchState.settings, backendReady: true },
  });

  const out = reducer(state, sendCmd('c1', RESOLVED, 'hello'));

  // SendRpc emitted.
  assert.equal(out.effects.length, 1);
  assert.equal(out.effects[0]?.kind, 'SendRpc');

  // Session marked running.
  assert.equal(out.state.sessions.runningSessionPaths.includes(RESOLVED), true);

  // pending.ops set.
  assert.equal(out.state.pending.ops['c1']?.kind, 'send');

  // Not queued.
  assert.equal(out.state.pending.sendQueueBySession[RESOLVED], undefined);
});

// ─── PendingPathReplaced: drain the queue ─────────────────────────────────────

test('PendingPathReplaced: emits DrainPendingSendQueue effect with queued entries + resolved path', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
    pending: {
      ...initialArchState.pending,
      sendQueueBySession: {
        [PENDING]: [
          { corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
          { corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
        ],
      },
    },
  });

  const out = reducer(state, pendingPathReplaced(PENDING, RESOLVED));

  // Queue cleared from the old pending path.
  assert.equal(out.state.pending.sendQueueBySession[PENDING], undefined);

  // DrainPendingSendQueue effect emitted.
  assert.equal(out.effects.length, 1);
  const effect = out.effects[0] as Extract<Effect, { kind: 'DrainPendingSendQueue' }>;
  assert.equal(effect.kind, 'DrainPendingSendQueue');
  assert.equal(effect.resolvedSessionPath, RESOLVED);
  assert.equal(effect.entries.length, 2);
  assert.equal(effect.entries[0]?.corrId, 'c1');
  assert.equal(effect.entries[1]?.corrId, 'c2');
});

test('PendingPathReplaced: no effect when queue is empty', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
    },
  });

  const out = reducer(state, pendingPathReplaced(PENDING, RESOLVED));

  assert.deepEqual(out.effects, []);
  assert.equal(out.state.pending.sendQueueBySession[PENDING], undefined);
});

test('PendingPathReplaced: rekeys openTabPaths + composer inputs (existing behavior preserved)', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
    },
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { [PENDING]: [{ kind: 'filesystemPathRef', id: 'x', name: 'f.ts', path: '/f.ts', source: 'picker' }] },
    },
  });

  const out = reducer(state, pendingPathReplaced(PENDING, RESOLVED));

  assert.deepEqual(out.state.sessions.openTabPaths, [RESOLVED]);
  assert.equal(out.state.composer.pendingComposerInputsBySession[PENDING], undefined);
  assert.equal(out.state.composer.pendingComposerInputsBySession[RESOLVED]?.length, 1);
});

// ─── SessionScopeCleared: clears the queue ────────────────────────────────────

test('SessionScopeCleared: clears sendQueueBySession for the closed session', () => {
  const state = buildState({
    pending: {
      ...initialArchState.pending,
      sendQueueBySession: {
        [PENDING]: [{ corrId: 'c1', text: 'hello', inputs: [], composedText: 'hello', localId: 'local:c1', previousSummary: null, timestamp: 1000 }],
      },
    },
  });

  const out = reducer(state, sessionScopeCleared(PENDING, true));

  assert.equal(out.state.pending.sendQueueBySession[PENDING], undefined);
});

test('SessionScopeCleared: preserves sendQueueBySession for other sessions', () => {
  const OTHER = '/workspace/other.jsonl';
  const state = buildState({
    pending: {
      ...initialArchState.pending,
      sendQueueBySession: {
        [PENDING]: [{ corrId: 'c1', text: 'a', inputs: [], composedText: 'a', localId: 'l1', previousSummary: null, timestamp: 1000 }],
        [OTHER]: [{ corrId: 'c2', text: 'b', inputs: [], composedText: 'b', localId: 'l2', previousSummary: null, timestamp: 2000 }],
      },
    },
  });

  const out = reducer(state, sessionScopeCleared(PENDING, true));

  assert.equal(out.state.pending.sendQueueBySession[PENDING], undefined);
  assert.equal(out.state.pending.sendQueueBySession[OTHER]?.length, 1);
});

// ─── E2E: pending send → resolve → drain → re-dispatched Send goes through ────

test('E2E: pending send queued → PendingPathReplaced drains → re-dispatched Send goes through normal path', () => {
  // Step 1: Send to pending path → queued.
  let state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
  });

  const sendResult = reducer(state, sendCmd('c1', PENDING, 'hello'));
  state = sendResult.state;
  assert.equal(sendResult.effects.length, 0); // no SendRpc
  assert.equal(state.pending.sendQueueBySession[PENDING]?.length, 1);

  // Step 2: PendingPathReplaced → drain effect emitted, queue cleared.
  const replaceResult = reducer(state, pendingPathReplaced(PENDING, RESOLVED));
  state = replaceResult.state;
  assert.equal(replaceResult.effects.length, 1);
  const drainEffect = replaceResult.effects[0] as Extract<Effect, { kind: 'DrainPendingSendQueue' }>;
  assert.equal(drainEffect.entries.length, 1);
  assert.equal(state.pending.sendQueueBySession[PENDING], undefined);

  // Step 3: The runner re-dispatches the entry as a Send Command with the
  // resolved path. Simulate that here by dispatching the Send Command.
  const entry = drainEffect.entries[0]!;
  const reDispatched: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: entry.corrId,
      sessionPath: RESOLVED, // resolved path, NOT pending
      text: entry.text,
      inputs: entry.inputs,
      composedText: entry.composedText,
      localId: entry.localId,
      userParts: entry.userParts,
      previousSummary: entry.previousSummary, // null
      timestamp: entry.timestamp,
    },
  };

  // Add the real session to state (as session.opened would).
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: [{ ...placeholderSummary(RESOLVED, 'Real Session'), isPlaceholder: false }],
      openTabPaths: [RESOLVED],
    },
    settings: { ...state.settings, backendReady: true },
  };

  const reDispatchResult = reducer(state, reDispatched);

  // Now the normal path fires: SendRpc emitted, session running, pending.ops set.
  assert.equal(reDispatchResult.effects.length, 1);
  assert.equal(reDispatchResult.effects[0]?.kind, 'SendRpc');
  assert.equal(reDispatchResult.state.sessions.runningSessionPaths.includes(RESOLVED), true);
  assert.equal(reDispatchResult.state.pending.ops['c1']?.kind, 'send');
  assert.equal(reDispatchResult.state.pending.ops['c1']?.sessionPath, RESOLVED);
});
