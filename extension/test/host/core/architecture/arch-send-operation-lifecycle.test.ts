import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';

const SESSION = '/repo/session.jsonl';

function readyState(): ArchState {
  return {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
  };
}

function send(state: ArchState, overrides: Partial<Extract<Event, { kind: 'Command' }>['cmd']> = {}): ArchState {
  return reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'corr-1', operationId: 'op-1',
      operationSource: {
        kind: 'renderer', rendererId: 'renderer-1', rendererKind: 'sidebar', rendererGeneration: 3,
      },
      backendGeneration: 7, sessionPath: SESSION, text: 'hello', inputs: [],
      composedText: 'hello', localId: 'local-1', previousSummary: null,
      timestamp: 100, ...overrides,
    },
  } as Event).state;
}

test('event-before-ack commits message.send once and a late ack is idempotent', () => {
  const started = reducer(send(readyState()), {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: 'assistant-1',
    requestId: 'request-1', operationId: 'op-1', timestamp: 101,
  });
  const terminal = started.state.operations['op-1']?.terminal;
  assert.equal(terminal?.outcome, 'settled');
  assert.equal(started.state.pending.ops['corr-1'], undefined);

  const lateAck = reducer(started.state, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, requestId: 'request-1',
  });
  assert.strictEqual(lateAck.state, started.state);
  assert.strictEqual(lateAck.state.operations['op-1']?.terminal, terminal);
});

test('ack timeout records ambiguity without rollback and a correlated start commits', () => {
  const optimistic = send(readyState());
  const delayed = reducer(optimistic, {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, error: 'timeout',
  });
  assert.equal(delayed.state.operations['op-1']?.phase, 'ambiguous');
  assert.ok(delayed.state.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'));
  assert.ok(delayed.state.pending.ops['corr-1']);

  const committed = reducer(delayed.state, {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: 'assistant-1',
    requestId: 'request-1', operationId: 'op-1', timestamp: 102,
  });
  assert.equal(committed.state.operations['op-1']?.terminal?.outcome, 'settled');
});

test('read-only committed status drops rollback ownership even when the semantic event was lost', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7,
  }).state;
  const committed = reducer(delayed, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, state: 'committed', requestId: 'request-1',
  });
  assert.equal(committed.state.operations['op-1']?.terminal?.outcome, 'settled');
  assert.equal(committed.state.pending.ops['corr-1'], undefined);
  assert.ok(committed.effects.some((effect) => effect.kind === 'ClearSendTimer'));
});

test('bounded reconciliation exhaustion exposes restart recovery without rollback', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7,
  }).state;
  const exhausted = reducer(delayed, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, state: 'reconciliation-exhausted', error: 'status unavailable',
  }).state;
  assert.equal(exhausted.operations['op-1']?.phase, 'ambiguous');
  assert.equal(exhausted.operations['op-1']?.recovery, 'restart-backend');
  assert.equal(exhausted.settings.noticeKind, 'backend-exit');
  assert.ok(exhausted.pending.ops['corr-1']);
  assert.ok(exhausted.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'));
});

test('stale-generation reconciliation cannot settle the current send operation', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7,
  }).state;
  const stale = reducer(delayed, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 6, state: 'committed',
  });
  assert.strictEqual(stale.state, delayed);
  assert.equal(stale.state.operations['op-1']?.terminal, undefined);
});

test('confirmed backend generation death terminalizes once and rolls back exactly', () => {
  const optimistic = send(readyState());
  const endedResult = reducer(optimistic, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, state: 'generation-ended', error: 'worker exited',
  });
  const ended = endedResult.state;
  const terminal = ended.operations['op-1']?.terminal;
  assert.equal(terminal?.outcome, 'failed');
  assert.equal(terminal?.reason, 'backend-generation-ended');
  assert.equal(ended.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'), false);
  assert.equal(ended.pending.ops['corr-1'], undefined);
  assert.ok(endedResult.effects.some((effect) => effect.kind === 'ClearSendTimer'));

  const duplicate = reducer(ended, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, state: 'failed', error: 'contradictory late failure',
  });
  assert.strictEqual(duplicate.state, ended);
  assert.strictEqual(duplicate.state.operations['op-1']?.terminal, terminal);
});

test('queued follow-up keeps its operation identity until delivery commits it', () => {
  const busy: ArchState = {
    ...readyState(),
    sessions: { ...readyState().sessions, runningSessionPaths: [SESSION] },
  };
  const optimistic = send(busy);
  const accepted = reducer(optimistic, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  assert.equal(accepted.operations['op-1']?.phase, 'awaiting-commit');
  assert.equal(accepted.operations['op-1']?.delivery, 'queued');
  assert.equal(accepted.operations['op-1']?.terminal, undefined);
  assert.equal(accepted.pending.promoted['corr-1']?.operationId, 'op-1');

  const delivered = reducer(accepted, {
    kind: 'QueuedDelivered', sessionPath: SESSION, text: 'hello',
    localId: 'local-1', operationId: 'op-1',
  });
  assert.equal(delivered.state.operations['op-1']?.terminal?.outcome, 'settled');
});

test('worker generation death terminalizes every accepted queued follow-up independently', () => {
  const busy: ArchState = {
    ...readyState(),
    sessions: { ...readyState().sessions, runningSessionPaths: [SESSION] },
  };
  const first = reducer(send(busy), {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  const secondOptimistic = send(first, {
    corrId: 'corr-2', operationId: 'op-2', localId: 'local-2', text: 'second', composedText: 'second',
  });
  const second = reducer(secondOptimistic, {
    kind: 'SendResult', corrId: 'corr-2', operationId: 'op-2', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;

  const exited = reducer(second, {
    kind: 'SessionsInterrupted', sessionPaths: [SESSION], reason: 'worker exited', occurredAt: 200,
  }).state;
  for (const operationId of ['op-1', 'op-2']) {
    assert.equal(exited.operations[operationId]?.terminal?.outcome, 'failed');
    assert.equal(exited.operations[operationId]?.terminal?.reason, 'backend-generation-ended');
  }
  assert.equal(Object.values(exited.pending.promoted).length, 0);
});

test('queued cancellation event settles and removes its row without an interrupt acknowledgement', () => {
  const busy: ArchState = {
    ...readyState(),
    sessions: { ...readyState().sessions, runningSessionPaths: [SESSION] },
  };
  const accepted = reducer(send(busy), {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  const cancelled = reducer(accepted, {
    kind: 'MessageAborted', sessionPath: SESSION, requestId: 'queued:op-1',
    operationId: 'op-1', localId: 'local-1', outcome: 'cancelled', userInitiated: true,
  }).state;
  assert.equal(cancelled.operations['op-1']?.terminal?.outcome, 'cancelled');
  assert.equal(cancelled.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'), false);
  assert.equal(cancelled.pending.promoted['corr-1'], undefined);
});

test('status reconciliation preserves queued cancellation when its abort event was lost', () => {
  const busy: ArchState = {
    ...readyState(),
    sessions: { ...readyState().sessions, runningSessionPaths: [SESSION] },
  };
  const accepted = reducer(send(busy), {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  const cancelled = reducer(accepted, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, state: 'cancelled', error: 'queue cleared',
  }).state;

  assert.equal(cancelled.operations['op-1']?.terminal?.outcome, 'cancelled');
  assert.equal(cancelled.operations['op-1']?.terminal?.reason, 'queue-cleared');
  assert.equal(cancelled.pending.promoted['corr-1'], undefined);
  assert.equal(cancelled.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'), false);
  assert.equal(cancelled.settings.notice, null);
});

test('queue clear cancellation and a racing earlier delivery each produce one terminal outcome', () => {
  const busy: ArchState = {
    ...readyState(),
    sessions: { ...readyState().sessions, runningSessionPaths: [SESSION] },
  };
  const accepted = reducer(send(busy), {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, queued: true,
  }).state;
  const clearing = reducer(accepted, {
    kind: 'Command', cmd: { kind: 'ClearQueue', corrId: 'clear-1', sessionPath: SESSION },
  }).state;
  const cancelled = reducer(clearing, {
    kind: 'ClearQueueResult', corrId: 'clear-1', sessionPath: SESSION, ok: true,
  }).state;
  assert.equal(cancelled.operations['op-1']?.terminal?.outcome, 'cancelled');
  assert.equal(cancelled.operations['op-1']?.terminal?.reason, 'queue-cleared');

  const delivered = reducer(accepted, {
    kind: 'QueuedDelivered', sessionPath: SESSION, text: 'hello', localId: 'local-1', operationId: 'op-1',
  }).state;
  const clearAfterDelivery = reducer(delivered, {
    kind: 'ClearQueueResult', corrId: 'clear-2', sessionPath: SESSION, ok: true,
  }).state;
  assert.strictEqual(clearAfterDelivery.operations['op-1']?.terminal, delivered.operations['op-1']?.terminal);
  assert.equal(clearAfterDelivery.operations['op-1']?.terminal?.outcome, 'settled');
});

test('pre-commit cancellation and supersession preserve their typed terminal outcome', () => {
  for (const outcome of ['cancelled', 'superseded'] as const) {
    const optimistic = send(readyState());
    const terminal = reducer(optimistic, {
      kind: 'MessageAborted', sessionPath: SESSION, requestId: 'request-1', operationId: 'op-1',
      outcome, reason: `${outcome} before start`,
    }).state.operations['op-1']?.terminal;
    assert.equal(terminal?.outcome, outcome);
    assert.equal(terminal?.reason, outcome === 'cancelled'
      ? 'interrupted-before-commit'
      : 'superseded-before-commit');
  }
});

test('a second send is blocked while prior commit remains ambiguous', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const second = send(delayed, {
    corrId: 'corr-2', operationId: 'op-2', localId: 'local-2', text: 'again', composedText: 'again',
  });
  assert.equal(second.operations['op-2'], undefined);
  assert.equal(second.transcript.bySession[SESSION]?.some((message) => message.id === 'local-2'), false);
});

test('backend generation shutdown resolves an ambiguous send and restores its draft', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const ended = reducer(delayed, { kind: 'BackendReadyChanged', ready: false });
  assert.equal(ended.state.operations['op-1']?.terminal?.reason, 'backend-generation-ended');
  assert.equal(ended.state.transcript.bySession[SESSION]?.some((message) => message.id === 'local-1'), false);
  assert.equal(ended.state.composer.draftTextBySession[SESSION], 'hello');
});

test('changed intent reuse is rejected without emitting another send effect', () => {
  const first = send(readyState());
  const changed = reducer(first, {
    kind: 'Command', cmd: {
      kind: 'Send', corrId: 'corr-2', operationId: 'op-1',
      operationSource: { kind: 'host' }, backendGeneration: 7,
      sessionPath: SESSION, text: 'changed', inputs: [], composedText: 'changed',
      localId: 'local-2', previousSummary: null, timestamp: 110,
    },
  });
  assert.equal(changed.effects.some((effect) => effect.kind === 'SendRpc'), false);
  assert.ok(changed.effects.some((effect) => effect.kind === 'Log'
    && effect.message.includes('Rejected changed message.send intent')));
  assert.equal(changed.state.transcript.bySession[SESSION]?.filter((message) => message.role === 'user').length, 1);
});
