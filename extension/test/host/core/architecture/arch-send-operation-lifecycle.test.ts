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
      kind: 'Send', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 1,
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

test('reducer owns send reconciliation attempts, backoff, exhaustion, and stale observations', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, error: 'ack timeout',
  });
  assert.deepEqual(delayed.state.operations['op-1']?.reconciliation, {
    attempts: 0, maxAttempts: 4,
  });
  assert.deepEqual(delayed.effects, [{
    kind: 'ScheduleOperationReconciliation', corrId: 'corr-1',
    operationId: 'op-1', operationKind: 'message.send', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: 1, delayMs: 0,
  }]);

  const firstPending = reducer(delayed.state, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: 1, state: 'pending',
  });
  assert.equal(firstPending.state.operations['op-1']?.reconciliation?.attempts, 1);
  assert.equal(firstPending.effects[0]?.kind, 'ScheduleOperationReconciliation');
  if (firstPending.effects[0]?.kind === 'ScheduleOperationReconciliation') {
    assert.equal(firstPending.effects[0].reconciliationAttempt, 2);
    assert.equal(firstPending.effects[0].delayMs, 1_000);
  }

  const duplicate = reducer(firstPending.state, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: 1, state: 'committed',
  });
  assert.strictEqual(duplicate.state, firstPending.state);
  assert.deepEqual(duplicate.effects, []);

  const staleAttempt = reducer(firstPending.state, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 2, reconciliationAttempt: 2, state: 'committed',
  });
  assert.strictEqual(staleAttempt.state, firstPending.state);

  let current = firstPending;
  for (const [attempt, expectedDelay] of [[2, 2_000], [3, 4_000]] as const) {
    current = reducer(current.state, {
      kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
      backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: attempt, state: 'pending',
    });
    assert.equal(current.effects[0]?.kind, 'ScheduleOperationReconciliation');
    if (current.effects[0]?.kind === 'ScheduleOperationReconciliation') {
      assert.equal(current.effects[0].delayMs, expectedDelay);
    }
  }
  const exhausted = reducer(current.state, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: 4,
    state: 'reconciliation-unavailable', error: 'ledger unavailable',
  });
  assert.equal(exhausted.state.operations['op-1']?.reconciliation?.attempts, 4);
  assert.equal(exhausted.state.operations['op-1']?.phase, 'ambiguous');
  assert.equal(exhausted.state.operations['op-1']?.recovery, 'restart-backend');
  assert.equal(exhausted.effects[0]?.kind, 'ReleaseOperationResources');
});

test('accepted reconciliation status is retained across its synthetic acknowledgement and schedules bounded follow-up', () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7,
  });
  const acceptedStatus = reducer(delayed.state, {
    kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: 1,
    state: 'accepted', committed: false, requestId: 'request-1',
  });
  assert.equal(acceptedStatus.state.operations['op-1']?.acceptance, 'accepted');
  assert.equal(acceptedStatus.state.operations['op-1']?.reconciliation?.attempts, 1);
  assert.equal(acceptedStatus.effects[0]?.kind, 'ScheduleOperationReconciliation');
  if (acceptedStatus.effects[0]?.kind === 'ScheduleOperationReconciliation') {
    assert.equal(acceptedStatus.effects[0].reconciliationAttempt, 2);
  }
  assert.equal(acceptedStatus.effects.some((effect) => effect.kind === 'ReleaseOperationResources'), false);

  const syntheticAck = reducer(acceptedStatus.state, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, reconciled: true,
    ok: true, requestId: 'request-1',
  });
  assert.equal(syntheticAck.state.operations['op-1']?.reconciliation?.attempts, 1);
  assert.equal(syntheticAck.state.pending.ops['corr-1'], undefined);
  assert.equal(syntheticAck.state.pending.promoted['corr-1']?.requestId, 'request-1');
  assert.deepEqual(syntheticAck.effects, []);
});

test('accepted-but-uncommitted send reconciliation exhausts after the reducer-owned bound', () => {
  let current = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', sessionPath: SESSION,
    backendGeneration: 7,
  });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    current = reducer(current.state, {
      kind: 'SendOperationStatus', operationId: 'op-1', sessionPath: SESSION,
      backendGeneration: 7, operationAttempt: 1, reconciliationAttempt: attempt,
      state: 'accepted', committed: false, requestId: 'request-1',
    });
    if (attempt < 4) {
      assert.equal(current.effects[0]?.kind, 'ScheduleOperationReconciliation');
      assert.equal(current.effects.some((effect) => effect.kind === 'ReleaseOperationResources'), false);
    }
  }
  assert.equal(current.state.operations['op-1']?.phase, 'ambiguous');
  assert.equal(current.state.operations['op-1']?.recovery, 'restart-backend');
  assert.equal(current.state.operations['op-1']?.reconciliation?.attempts, 4);
  assert.ok(current.effects.some((effect) => effect.kind === 'ReleaseOperationResources'));
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

test("accepted committed status clears optimistic ownership before its synthetic SendResult", () => {
  const delayed = reducer(send(readyState()), {
    kind: 'SendOperationDelayed', operationId: 'op-1', operationAttempt: 1,
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const committed = reducer(delayed, {
    kind: 'SendOperationStatus', operationId: 'op-1', operationAttempt: 1,
    sessionPath: SESSION, backendGeneration: 7, reconciliationAttempt: 1,
    state: 'accepted', committed: true, requestId: 'request-1',
  });

  assert.equal(committed.state.operations['op-1']?.terminal?.outcome, 'settled');
  assert.equal(committed.state.pending.ops['corr-1'], undefined);
  assert.equal(committed.state.pending.promoted['corr-1'], undefined);
  assert.ok(committed.effects.some((effect) => effect.kind === 'ClearSendTimer'));
  assert.ok(committed.effects.some((effect) => effect.kind === 'ReleaseOperationResources'));

  const synthetic = reducer(committed.state, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, reconciled: true,
    ok: true, requestId: 'request-1',
  });
  assert.strictEqual(synthetic.state, committed.state);
  assert.deepEqual(synthetic.effects, []);

  const promoted = reducer(send(readyState()), {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, ok: true, requestId: 'request-1',
  }).state;
  assert.ok(promoted.pending.promoted['corr-1']);
  const committedAfterAck = reducer(promoted, {
    kind: 'SendOperationStatus', operationId: 'op-1', operationAttempt: 1,
    sessionPath: SESSION, backendGeneration: 7,
    state: 'accepted', committed: true, requestId: 'request-1',
  });
  assert.equal(committedAfterAck.state.pending.promoted['corr-1'], undefined);
  assert.ok(committedAfterAck.effects.some((effect) => effect.kind === 'ClearSendTimer'));
});

test('message.send retry keeps its operation identity and increments the transport attempt', () => {
  const first = send(readyState());
  const delayed = reducer(first, {
    kind: 'SendOperationDelayed', operationId: 'op-1', operationAttempt: 1,
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const retried = reducer(delayed, {
    kind: 'Command', cmd: {
      kind: 'Send', corrId: 'retry-corr', operationId: 'op-1', operationAttempt: 2,
      operationSource: { kind: 'host' }, backendGeneration: 7,
      sessionPath: SESSION, text: 'hello', inputs: [], composedText: 'hello',
      localId: 'local-1', previousSummary: null, timestamp: 200,
    },
  });

  assert.equal(retried.state.operations['op-1']?.attempt, 2);
  assert.equal(retried.state.operations['op-1']?.reconciliation, undefined);
  assert.equal(retried.state.pending.ops['corr-1']?.operationAttempt, 2);
  assert.equal(retried.state.transcript.bySession[SESSION]?.filter((message) => message.id === 'local-1').length, 1);
  assert.deepEqual(retried.effects, [
    {
      kind: 'ReleaseOperationResources', corrId: 'corr-1',
      operationId: 'op-1', operationAttempt: 1,
    },
    {
      kind: 'SendRpc', corrId: 'corr-1', operationId: 'op-1', operationAttempt: 2,
      backendGeneration: 7, sessionPath: SESSION, text: 'hello', inputs: [],
      localId: 'local-1', composedText: 'hello', userParts: undefined,
      priorPruningMode: undefined,
    },
  ]);
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

test('preflight phase is reducer-owned and duplicate observations cannot regress it', () => {
  const optimistic = send(readyState());
  assert.equal(optimistic.operations['op-1']?.executionPhase, 'prepass');
  const acknowledged = reducer(optimistic, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, requestId: 'request-1',
  }).state;
  const succeeded = reducer(acknowledged, {
    kind: 'CustomMessage', sessionPath: SESSION,
    message: { id: 'preflight', role: 'system', createdAt: '2026-01-01T00:00:00.000Z', markdown: '', status: 'completed', customType: 'preflight-succeeded' },
  });
  assert.equal(succeeded.state.operations['op-1']?.executionPhase, 'model-start');
  const duplicate = reducer(succeeded.state, {
    kind: 'CustomMessage', sessionPath: SESSION,
    message: { id: 'preflight-duplicate', role: 'system', createdAt: '2026-01-01T00:00:01.000Z', markdown: '', status: 'completed', customType: 'preflight-succeeded' },
  });
  assert.equal(duplicate.state.operations['op-1']?.executionPhase, 'model-start');
  assert.deepEqual(duplicate.effects, []);
});

test('registered pruning restoration is reducer-described at the send commit boundary', () => {
  const optimistic = send(readyState(), { priorPruningMode: 'auto' });
  const acknowledged = reducer(optimistic, {
    kind: 'SendResult', corrId: 'corr-1', operationId: 'op-1', backendGeneration: 7,
    sessionPath: SESSION, ok: true, requestId: 'request-1',
  }).state;
  const committed = reducer(acknowledged, {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: 'assistant-1',
    requestId: 'request-1', operationId: 'op-1', timestamp: 101,
  });
  assert.ok(committed.effects.some((effect) => effect.kind === 'ClearSendTimer'
    && effect.corrId === 'corr-1' && effect.restorePruningMode === 'auto'));
});

test('interrupt describes registered pre-ack send cancellation to the runner', () => {
  const optimistic = send(readyState());
  const interrupted = reducer(optimistic, {
    kind: 'Command',
    cmd: {
      kind: 'Interrupt', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
      operationSource: { kind: 'host' }, backendGeneration: 7, sessionPath: SESSION,
    },
  });
  const effect = interrupted.effects.find((candidate) => candidate.kind === 'InterruptRpc');
  assert.equal(effect?.kind, 'InterruptRpc');
  if (effect?.kind === 'InterruptRpc') {
    assert.deepEqual(effect.abortSendCorrIds, ['corr-1']);
    assert.equal(effect.usePriorityLane, undefined);
  }
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
