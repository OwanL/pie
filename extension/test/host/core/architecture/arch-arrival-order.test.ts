/**
 * Phase 4 arrival-order tests.
 *
 * These verify that removing the event-buffering window in backend-client.ts
 * is safe: the CQRS reducer's pending state correctly survives arbitrary
 * interleaving of events between command dispatch and result arrival.
 *
 * Scenarios:
 *  - send-then-success: Send → SendResult{ok:true}
 *  - send-then-failure: Send → SendResult{ok:false}
 *  - send-then-delta-before-ack: Send → unrelated event → SendResult
 *  - send-then-delta-after-ack: Send → SendResult → unrelated event
 *  - edit-truncate-then-stream: Edit → EditResult{ok:true} → unrelated event
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';

// A state with backendReady=true — needed because the Send Command handler
// queues into backendReadyQueueBySession when !backendReady (Phase 3 chunk 2).
const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendCommand(corrId: string, sessionPath: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId,
      sessionPath,
      text: 'hello',
      inputs: [],
      composedText: 'hello',
      localId: `local:${corrId}`,
      userParts: [{ kind: 'text', text: 'hello' }],
      previousSummary: null,
      timestamp: 1,
    },
  };
}

function editCommand(corrId: string, sessionPath: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId,
      sessionPath,
      messageId: 'msg-1',
      text: 'edited text',
      inputs: [],
      composedText: 'edited text',
      userParts: undefined,
      localId: `local:${corrId}`,
      timestamp: 1,
    },
  };
}

// ─── send-then-success (full round-trip sequence) ───────────────────────────

test('arrival-order: send → success produces pending then clears it', () => {
  // 1. Dispatch Send command.
  const r1 = reducer(readyState, sendCommand('c1', '/s'));
  assert.ok(r1.state.pending.ops['c1'], 'pending should exist after Send');
  // Now only SendRpc effect — optimistic message is in transcript state directly
  assert.equal(r1.effects.length, 1);
  assert.equal(r1.effects[0]?.kind, 'SendRpc');

  // Optimistic message in transcript.
  const transcript = r1.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist for session');
  assert.equal(transcript!.length, 1);
  assert.equal(transcript![0]?.role, 'user');
  assert.equal(transcript![0]?.id, 'local:c1');

  // 2. Dispatch SendResult{ok:true}.
  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c1', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending.ops['c1'], undefined, 'pending should be cleared after success');
  // Composer inputs cleared directly in state — no effect
  assert.equal(r2.effects.length, 0);
});

// ─── send-then-failure (full round-trip sequence) ───────────────────────────

test('arrival-order: send → failure rolls back pending and notifies', () => {
  const r1 = reducer(readyState, sendCommand('c2', '/s'));
  assert.ok(r1.state.pending.ops['c2']);

  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c2', sessionPath: '/s', ok: false, error: 'network' });
  assert.equal(r2.state.pending.ops['c2'], undefined, 'pending should be cleared on failure');
  // Optimistic message removed from transcript directly
  assert.ok(!r2.state.transcript.bySession['/s']?.some((m: import('../../../../src/shared/protocol').ChatMessage) => m.id === 'local:c2'), 'optimistic message should be removed');
  // Notice set directly in state
  assert.ok(r2.state.settings.notice);
  assert.ok(r2.effects.some((effect) => effect.kind === 'PostImperative'));
  assert.ok(r2.effects.some((effect) => effect.kind === 'ClearSendTimer'));
  assert.ok(r2.effects.some((effect) => effect.kind === 'ReleaseOperationResources'));
});

// ─── send-then-delta-before-ack ─────────────────────────────────────────────

test('arrival-order: send → unhandled event (simulated delta) → success — pending preserved through interleaving', () => {
  // 1. Dispatch Send command.
  const r1 = reducer(readyState, sendCommand('c3', '/s'));
  assert.ok(r1.state.pending.ops['c3']);

  // 2. An unrelated InterruptResult arrives (simulates interleaved event).
  const deltaEvent: Event = {
    kind: 'InterruptResult',
    corrId: 'unrelated-corr',
    sessionPath: '/other-session',
    ok: true,
  };
  const r2 = reducer(r1.state, deltaEvent);
  // Pending for 'c3' must survive — the interleaved event must NOT corrupt it.
  assert.ok(r2.state.pending.ops['c3'], 'pending must survive unrelated event');
  assert.equal(r2.state.pending.ops['c3']?.kind, 'send');
  assert.equal(r2.state.pending.ops['c3']?.localId, 'local:c3');

  // 3. Now the actual SendResult arrives — still works correctly.
  const r3 = reducer(r2.state, { kind: 'SendResult', corrId: 'c3', sessionPath: '/s', ok: true });
  assert.equal(r3.state.pending.ops['c3'], undefined, 'pending cleared after ack');
  // No effects (state mutation only)
  assert.equal(r3.effects.length, 0);
});

test('arrival-order: send → multiple interleaved events → success — pending still intact', () => {
  const r1 = reducer(readyState, sendCommand('c4', '/s'));

  // Simulate multiple events arriving while RPC is in-flight.
  let state = r1.state;
  for (let i = 0; i < 5; i++) {
    const interleaved: Event = {
      kind: 'InterruptResult',
      corrId: `noise-${i}`,
      sessionPath: `/unrelated-${i}`,
      ok: true,
    };
    const r = reducer(state, interleaved);
    state = r.state;
  }

  // Pending still intact after 5 interleaved events.
  assert.ok(state.pending.ops['c4'], 'pending survives multiple interleavings');
  assert.equal(state.pending.ops['c4']?.kind, 'send');

  // SendResult still resolves correctly.
  const final = reducer(state, { kind: 'SendResult', corrId: 'c4', sessionPath: '/s', ok: true });
  assert.equal(final.state.pending.ops['c4'], undefined);
});

test('arrival-order: legacy stream start before send acknowledgement commits the pending operation', () => {
  const sent = reducer(readyState, sendCommand('c-early-legacy', '/s'));

  const started = reducer(sent.state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'assistant-early',
    requestId: 'request-early',
    timestamp: 2,
  });

  assert.equal(started.state.pending.ops['c-early-legacy'], undefined);
  assert.deepEqual(started.effects, [{ kind: 'ClearSendTimer', corrId: 'c-early-legacy' }]);
  assert.ok(started.state.transcript.bySession['/s']?.some((message) => message.id === 'local:c-early-legacy'));
  const lateAck = reducer(started.state, {
    kind: 'SendResult', corrId: 'c-early-legacy', sessionPath: '/s', ok: true, requestId: 'request-early',
  });
  assert.equal(lateAck.state, started.state, 'late acknowledgement is a no-op after the commit point');
});

test('arrival-order: live turn start before send acknowledgement commits the pending operation', () => {
  const sent = reducer(readyState, sendCommand('c-early-live', '/s'));

  const started = reducer(sent.state, {
    kind: 'TurnSemanticEventReceived',
    envelope: {
      protocolVersion: 7,
      kind: 'turn.started',
      sessionPath: '/s',
      requestId: 'request-live',
      turnId: 'turn-live',
      attemptId: 'attempt-live',
      seq: 1,
      occurredAt: 2,
      checkpointBytes: 30 * 1024 * 1024,
      canonicalMessageId: 'assistant-live',
      startedAt: 2,
    },
  });

  assert.equal(started.state.pending.ops['c-early-live'], undefined);
  assert.deepEqual(started.effects, [{ kind: 'ClearSendTimer', corrId: 'c-early-live' }]);
  const lateAck = reducer(started.state, {
    kind: 'SendResult', corrId: 'c-early-live', sessionPath: '/s', ok: true, requestId: 'request-live',
  });
  assert.equal(lateAck.state, started.state, 'late acknowledgement is a no-op after the live commit point');
});

test('arrival-order: message finished before acknowledgement settles the pending operation timer', () => {
  const sent = reducer(readyState, sendCommand('c-finished-early', '/s'));

  const finished = reducer(sent.state, {
    kind: 'MessageFinished',
    sessionPath: '/s',
    requestId: 'request-finished-early',
    message: {
      id: 'assistant-finished-early',
      role: 'assistant',
      createdAt: new Date(2).toISOString(),
      markdown: 'provider rejected the request',
      status: 'error',
    },
  });

  assert.equal(finished.state.pending.ops['c-finished-early'], undefined);
  assert.deepEqual(finished.effects, [{ kind: 'ClearSendTimer', corrId: 'c-finished-early' }]);
  const lateAck = reducer(finished.state, {
    kind: 'SendResult', corrId: 'c-finished-early', sessionPath: '/s', ok: true,
    requestId: 'request-finished-early',
  });
  assert.equal(lateAck.state, finished.state);
});

test('arrival-order: message abort before acknowledgement settles the pending operation timer', () => {
  const sent = reducer(readyState, sendCommand('c-aborted-early', '/s'));

  const aborted = reducer(sent.state, {
    kind: 'MessageAborted',
    sessionPath: '/s',
    requestId: 'request-aborted-early',
    userInitiated: false,
    reason: 'provider rejected the request',
  });

  assert.equal(aborted.state.pending.ops['c-aborted-early'], undefined);
  assert.deepEqual(aborted.effects, [{ kind: 'ClearSendTimer', corrId: 'c-aborted-early' }]);
  const lateAck = reducer(aborted.state, {
    kind: 'SendResult', corrId: 'c-aborted-early', sessionPath: '/s', ok: true,
    requestId: 'request-aborted-early',
  });
  assert.equal(lateAck.state, aborted.state);
});

test('arrival-order: terminal abort before message start settles the promoted operation timer', () => {
  const sent = reducer(readyState, sendCommand('c-terminal', '/s'));
  const acknowledged = reducer(sent.state, {
    kind: 'SendResult', corrId: 'c-terminal', sessionPath: '/s', ok: true, requestId: 'request-terminal',
  });
  assert.ok(acknowledged.state.pending.promoted['c-terminal']);

  const aborted = reducer(acknowledged.state, {
    kind: 'MessageAborted',
    sessionPath: '/s',
    requestId: 'request-terminal',
    userInitiated: false,
    reason: 'provider rejected the request',
  });

  assert.equal(aborted.state.pending.promoted['c-terminal'], undefined);
  assert.deepEqual(aborted.effects, [{ kind: 'ClearSendTimer', corrId: 'c-terminal' }]);
  assert.ok(aborted.state.transcript.bySession['/s']?.some((message) => message.id === 'local:c-terminal'));
});

test('arrival-order: typed pre-start continuation settlement cannot consume a newer pending operation', () => {
  const newSend = reducer(readyState, sendCommand('c-new-after-continue', '/s'));

  const lateContinueSettlement = reducer(newSend.state, {
    kind: 'MessageAborted',
    sessionPath: '/s',
    requestId: 'request-old-continue',
    outcome: 'superseded',
  });

  assert.ok(lateContinueSettlement.state.pending.ops['c-new-after-continue']);
  assert.deepEqual(lateContinueSettlement.effects, []);
});

test('arrival-order: duplicate terminal from the current turn cannot consume a newer pending operation', () => {
  const oldTurn = reducer(readyState, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'assistant-old',
    requestId: 'request-old',
    timestamp: 1,
  });
  const newSend = reducer(oldTurn.state, sendCommand('c-new', '/s'));

  const duplicate = reducer(newSend.state, {
    kind: 'MessageAborted',
    sessionPath: '/s',
    requestId: 'request-old',
    messageId: 'assistant-old',
    userInitiated: false,
    reason: 'duplicate terminal',
  });

  assert.ok(duplicate.state.pending.ops['c-new']);
  assert.deepEqual(duplicate.effects, []);
});

// ─── send-then-delta-after-ack ──────────────────────────────────────────────

test('arrival-order: send → success → unhandled event — clean state post-ack', () => {
  // Send + ack.
  const r1 = reducer(readyState, sendCommand('c5', '/s'));
  const r2 = reducer(r1.state, { kind: 'SendResult', corrId: 'c5', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending.ops['c5'], undefined);

  // Subsequent event has no pending to corrupt.
  const after: Event = {
    kind: 'InterruptResult',
    corrId: 'later',
    sessionPath: '/other',
    ok: true,
  };
  const r3 = reducer(r2.state, after);
  // State remains clean — no orphan pending entries.
  assert.deepEqual(r3.state.pending.ops, {});
});

// ─── edit-truncate-then-stream ──────────────────────────────────────────────

test('arrival-order: edit → success → unhandled event — edit pending cleared, no corruption', () => {
  // 1. Dispatch Edit command.
  const r1 = reducer(initialArchState, editCommand('c6', '/s'));
  assert.ok(r1.state.pending.ops['c6']);
  assert.equal(r1.state.pending.ops['c6']?.kind, 'edit');
  // Only EditRpc effect now
  assert.equal(r1.effects.length, 1);
  assert.equal(r1.effects[0]?.kind, 'EditRpc');

  // 2. EditResult{ok:true} arrives.
  const r2 = reducer(r1.state, { kind: 'EditResult', corrId: 'c6', sessionPath: '/s', ok: true });
  assert.equal(r2.state.pending.ops['c6'], undefined, 'edit pending cleared');
  assert.equal(r2.effects[0]?.kind, 'ScheduleOperationReconciliation');

  // 3. Streaming events arrive after edit ack — state stays clean.
  const stream: Event = {
    kind: 'InterruptResult',
    corrId: 'stream-noise',
    sessionPath: '/s',
    ok: true,
  };
  const r3 = reducer(r2.state, stream);
  assert.deepEqual(r3.state.pending.ops, {});
});

test('arrival-order: edit → interleaved event before ack → success — pending preserved', () => {
  const r1 = reducer(initialArchState, editCommand('c7', '/s'));
  assert.ok(r1.state.pending.ops['c7']);

  // Interleaved event while edit RPC is in-flight.
  const noise: Event = {
    kind: 'SendResult',
    corrId: 'unrelated',
    sessionPath: '/other',
    ok: true,
  };
  const r2 = reducer(r1.state, noise);
  // SendResult for unknown corrId is a no-op, state unchanged.
  assert.ok(r2.state.pending.ops['c7'], 'edit pending survives unrelated SendResult');

  // EditResult arrives correctly.
  const r3 = reducer(r2.state, { kind: 'EditResult', corrId: 'c7', sessionPath: '/s', ok: true });
  assert.equal(r3.state.pending.ops['c7'], undefined);
});

// ─── Concurrent sends on different sessions ─────────────────────────────────

test('arrival-order: two concurrent sends — results resolve independently', () => {
  // Two sends on different sessions, dispatched back-to-back.
  const r1 = reducer(readyState, sendCommand('ca', '/session-a'));
  const r2 = reducer(r1.state, sendCommand('cb', '/session-b'));

  assert.ok(r2.state.pending.ops['ca']);
  assert.ok(r2.state.pending.ops['cb']);

  // 'cb' ack arrives first (out-of-order w.r.t. dispatch).
  const r3 = reducer(r2.state, { kind: 'SendResult', corrId: 'cb', sessionPath: '/session-b', ok: true });
  assert.equal(r3.state.pending.ops['cb'], undefined);
  assert.ok(r3.state.pending.ops['ca'], 'ca still pending');

  // 'ca' ack arrives second.
  const r4 = reducer(r3.state, { kind: 'SendResult', corrId: 'ca', sessionPath: '/session-a', ok: true });
  assert.equal(r4.state.pending.ops['ca'], undefined);
  assert.deepEqual(r4.state.pending.ops, {});
});