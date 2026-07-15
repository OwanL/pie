/**
 * Steering — send a message while a turn is running.
 *
 * The reducer's `handleSend` busy branch (`runningSessionPaths` already includes
 * the session) inserts an optimistic user message with status 'queued', records
 * a `PendingOp` flagged `queued`, and emits `SendRpc` without re-adding the
 * session to `runningSessionPaths` (it is already running its original turn).
 * `SendResult{ok:true, queued:true}` promotes the op to `pending.promoted`
 * (retained for rollback-until-delivery) and keeps the message 'queued' — no
 * prepass chip, no `requestIdToLocalId` (a steering injection has no requestId).
 * When the agent loop injects the queued message into the current turn, `QueuedDelivered`
 * promotes the earliest 'queued' message to 'completed' and drops the promoted
 * snapshot. `ClearQueue` and `InterruptResult{ok:true}` both remove 'queued'
 * messages + drop the snapshots. A pre-ack `SendResult{ok:false}` rolls back the
 * 'queued' message WITHOUT clearing `runningSessionPaths` (the original turn is
 * still running).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary } from '../../../../src/shared/protocol';

const SESSION = '/workspace/session.jsonl';

function summary(path: string, name = 'Test'): SessionSummary {
  return { path, name, cwd: '/workspace', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0, isPlaceholder: false };
}

/** A session that is open, backend-ready, and already running a turn. */
function busyState(overrides: Partial<ArchState> = {}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION)],
      openTabPaths: [SESSION],
      runningSessionPaths: [SESSION],
    },
    settings: { ...initialArchState.settings, backendReady: true },
    ...overrides,
  };
}

function sendCmd(corrId: string, sessionPath: string, text = 'hello'): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId, sessionPath, text,
      inputs: [], composedText: text, localId: `local:${corrId}`,
      userParts: undefined, previousSummary: null, timestamp: 1000,
    },
  };
}

function sendResult(corrId: string, ok: boolean, queued?: boolean, error?: string): Event {
  return { kind: 'SendResult', corrId, sessionPath: SESSION, ok, queued, error };
}

function queuedDelivered(text = 'hello', localId?: string): Event {
  return { kind: 'QueuedDelivered', sessionPath: SESSION, text, localId };
}

function clearQueueCmd(corrId = 'cq'): Event {
  return { kind: 'Command', cmd: { kind: 'ClearQueue', corrId, sessionPath: SESSION } };
}

function interruptResult(ok = true): Event {
  return { kind: 'InterruptResult', corrId: 'ci', sessionPath: SESSION, ok };
}

// ─── Send while busy: optimistic 'queued' message + SendRpc ──────────────────

test('Send while busy: inserts an optimistic queued message, flags the PendingOp queued, emits SendRpc, leaves runningSessionPaths untouched', () => {
  const out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));

  assert.equal(out.effects.filter((e) => e.kind === 'SendRpc').length, 1, 'emits SendRpc');

  const list = out.state.transcript.bySession[SESSION];
  assert.equal(list?.length, 1);
  assert.equal(list?.[0]?.id, 'local:c1');
  assert.equal(list?.[0]?.role, 'user');
  assert.equal(list?.[0]?.status, 'queued', 'optimistic message is queued, not completed');

  assert.equal(out.state.pending.ops['c1']?.queued, true, 'PendingOp flagged queued');
  assert.equal(out.state.pending.ops['c1']?.localId, 'local:c1');

  // Already running — the busy branch must not re-add or remove the session.
  assert.deepEqual(out.state.sessions.runningSessionPaths, [SESSION]);
  // No prepass chip for a steering injection.
  assert.equal(out.state.pending.prepassBySession[SESSION], undefined);
});

// ─── SendResult{ok:true, queued:true}: promote + keep queued ─────────────────

test('SendResult{ok:true, queued:true}: moves op to pending.promoted, keeps message queued, sets no prepass/requestIdToLocalId', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));

  assert.equal(out.state.pending.ops['c1'], undefined, 'op left pending.ops');
  assert.ok(out.state.pending.promoted['c1'], 'promoted snapshot retained for rollback-until-delivery');
  assert.equal(out.state.pending.promoted['c1']?.queued, true);

  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.status, 'queued', 'message stays queued');
  assert.equal(out.state.pending.prepassBySession[SESSION], undefined, 'no prepass for a steering injection');
  assert.equal(Object.keys(out.state.pending.requestIdToLocalId).length, 0, 'no requestId binding');
});

// ─── QueuedDelivered: promote earliest queued → completed ────────────────────

test('QueuedDelivered: promotes the earliest queued message to completed and drops its promoted snapshot', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, queuedDelivered('first'));

  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.status, 'completed', 'queued message promoted on delivery');
  assert.equal(out.state.pending.promoted['c1'], undefined, 'promoted snapshot dropped at delivery');
});

test('QueuedDelivered: with multiple queued messages, promotes them in FIFO order (earliest first)', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, sendCmd('c2', SESSION, 'second'));
  out = reducer(out.state, sendResult('c2', true, true));

  // Both queued, in order.
  const list = out.state.transcript.bySession[SESSION];
  assert.equal(list?.[0]?.status, 'queued');
  assert.equal(list?.[1]?.status, 'queued');
  assert.equal(list?.[0]?.id, 'local:c1');
  assert.equal(list?.[1]?.id, 'local:c2');

  // First delivery promotes the EARLIEST (c1), not c2, and relocates it to
  // the authoritative delivery boundary at the transcript tail.
  out = reducer(out.state, queuedDelivered('first'));
  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.status, 'queued');
  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.id, 'local:c2');
  assert.equal(out.state.transcript.bySession[SESSION]?.[1]?.status, 'completed');
  assert.equal(out.state.transcript.bySession[SESSION]?.[1]?.id, 'local:c1');
  assert.equal(out.state.pending.promoted['c1'], undefined);
  assert.ok(out.state.pending.promoted['c2'], 'second queued message still has its rollback snapshot');
});

test('QueuedDelivered: a correlated out-of-order delivery promotes only its exact local id', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, sendCmd('c2', SESSION, 'second'));
  out = reducer(out.state, sendResult('c2', true, true));

  out = reducer(out.state, queuedDelivered('second', 'local:c2'));
  assert.equal(out.state.transcript.bySession[SESSION]?.find((message) => message.id === 'local:c1')?.status, 'queued');
  assert.equal(out.state.transcript.bySession[SESSION]?.at(-1)?.id, 'local:c2');
  assert.equal(out.state.transcript.bySession[SESSION]?.at(-1)?.status, 'completed');
  assert.ok(out.state.pending.promoted['c1']);
  assert.equal(out.state.pending.promoted['c2'], undefined);

  const duplicate = reducer(out.state, queuedDelivered('second', 'local:c2'));
  assert.deepEqual(duplicate.state, out.state, 'a duplicate correlated delivery must not fall back to FIFO');
});

// ─── EditQueued: replace the backend queue without interrupt/truncate ────────

test('EditQueued preserves queue order and updates only after ReplaceQueueResult succeeds', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, sendCmd('c2', SESSION, 'second'));
  out = reducer(out.state, sendResult('c2', true, true));
  out = reducer(out.state, {
    kind: 'Command',
    cmd: {
      kind: 'EditQueued', corrId: 'eq', sessionPath: SESSION, messageId: 'local:c1',
      text: 'edited first', inputs: [], composedText: 'edited first', userParts: [{ kind: 'text', text: 'edited first' }],
    },
  });

  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.markdown, 'first', 'waits for backend acknowledgement');
  const effect = out.effects.find((entry) => entry.kind === 'ReplaceQueueRpc');
  assert.ok(effect && effect.kind === 'ReplaceQueueRpc');
  assert.deepEqual(effect.messages.map((message) => [message.localId, message.text]), [
    ['local:c1', 'edited first'], ['local:c2', 'second'],
  ]);
  assert.deepEqual(effect.fallbackMessages.map((message) => message.text), ['first', 'second']);
  assert.deepEqual(out.state.sessions.runningSessionPaths, [SESSION], 'does not interrupt the current turn');

  out = reducer(out.state, {
    kind: 'ReplaceQueueResult', corrId: 'eq', sessionPath: SESSION, messageId: 'local:c1', ok: true,
    text: 'edited first', inputs: [], composedText: 'edited first', userParts: [{ kind: 'text', text: 'edited first' }],
  });
  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.markdown, 'edited first');
  assert.equal(out.state.pending.promoted['c1']?.text, 'edited first');
});

test('ReplaceQueueResult updates an already-delivered row and catastrophic restore failure clears stale queue state', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, queuedDelivered('edited first', 'local:c1'));
  out = reducer(out.state, {
    kind: 'ReplaceQueueResult', corrId: 'eq', sessionPath: SESSION, messageId: 'local:c1', ok: true,
    text: 'edited first', inputs: [], composedText: 'edited first', userParts: [{ kind: 'text', text: 'edited first' }],
  });
  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.markdown, 'edited first');

  out = reducer(out.state, sendCmd('c2', SESSION, 'second'));
  out = reducer(out.state, sendResult('c2', true, true));
  out = reducer(out.state, {
    kind: 'ReplaceQueueResult', corrId: 'eq2', sessionPath: SESSION, messageId: 'local:c2', ok: false,
    text: 'edited second', inputs: [], composedText: 'edited second', error: 'QUEUE_REPLACE_FAILED: restore failed',
  });
  assert.equal(out.state.transcript.bySession[SESSION]?.some((message) => message.status === 'queued'), false);
  assert.equal(out.state.pending.promoted['c2'], undefined);
  assert.match(out.state.settings.notice ?? '', /were cleared/);
});

// ─── ClearQueue command: remove queued messages + ClearQueueRpc ──────────────

test('ClearQueue command: removes queued transcript messages, drops pending snapshots, emits ClearQueueRpc', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, clearQueueCmd('cq'));

  assert.equal(out.state.transcript.bySession[SESSION]?.length, 0, 'queued message removed');
  assert.equal(out.state.pending.promoted['c1'], undefined, 'promoted snapshot dropped on clear');
  assert.equal(out.effects.filter((e) => e.kind === 'ClearQueueRpc').length, 1, 'emits ClearQueueRpc');
  // runningSessionPaths untouched — clear does not interrupt the current turn.
  assert.deepEqual(out.state.sessions.runningSessionPaths, [SESSION]);
});

// ─── InterruptResult{ok:true}: also clears queued messages ───────────────────

test('InterruptResult{ok:true}: removes queued transcript messages and drops pending snapshots (Stop cancels the queue too)', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', true, true));
  out = reducer(out.state, interruptResult(true));

  assert.equal(out.state.transcript.bySession[SESSION]?.length, 0, 'queued message removed on interrupt');
  assert.equal(out.state.pending.promoted['c1'], undefined, 'promoted snapshot dropped on interrupt');
});

// ─── Pre-ack failure of a queued send: rollback without clearing running ─────

test('SendResult{ok:false} for a queued send: removes the queued message, fires sendRejected, and preserves runningSessionPaths', () => {
  let out = reducer(busyState(), sendCmd('c1', SESSION, 'first'));
  out = reducer(out.state, sendResult('c1', false, undefined, 'boom'));

  assert.equal(out.state.transcript.bySession[SESSION]?.length, 0, 'queued message rolled back on pre-ack failure');
  assert.equal(out.state.pending.ops['c1'], undefined);
  // The original turn is still running — runningSessionPaths MUST be preserved.
  assert.deepEqual(out.state.sessions.runningSessionPaths, [SESSION]);
  // A sendRejected imperative fires so the webview restores the draft.
  assert.ok(out.effects.some((e) => e.kind === 'PostImperative'), 'sendRejected imperative fired');
});
