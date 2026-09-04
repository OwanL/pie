import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import {
  hasRetiredInterruptEventFence,
  settleSessionOperationSucceeded,
  startSessionOperation,
} from '../../../../src/host/core/operation-registry';

const SESSION = '/repo/interrupted.jsonl';

function readyState(): ArchState {
  const interrupt = startSessionOperation({
    operationId: 'prior-stop', kind: 'message.interrupt', source: { kind: 'host' },
    pendingPath: SESSION, selectionToken: 'prior-stop', backendGeneration: 0,
  });
  const settled = settleSessionOperationSucceeded(interrupt, {
    pendingPath: SESSION, backendGeneration: 0,
  })!;
  return {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    operations: { [settled.operationId]: settled },
  };
}

test('Continue marks the session running, clears the interrupt fence, and emits no user-message mutation', () => {
  const state = readyState();
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Continue', corrId: 'continue-1', sessionPath: SESSION },
  });

  assert.deepEqual(result.effects, [{
    kind: 'ContinueRpc', corrId: 'continue-1', sessionPath: SESSION,
    operationId: 'continue-1', operationAttempt: 1, backendGeneration: 0,
  }]);
  assert.equal(result.state.operations['continue-1']?.kind, 'message.continue');
  assert.deepEqual(result.state.sessions.runningSessionPaths, [SESSION]);
  assert.equal(hasRetiredInterruptEventFence(result.state.operations, SESSION), false);
  assert.equal(result.state.transcript.bySession[SESSION], undefined);
  assert.deepEqual(result.state.pending.ops, {});
});

test('continuation acknowledgement ambiguity reconciles by operation and rejects stale generations', () => {
  let state = reducer(readyState(), {
    kind: 'Command',
    cmd: {
      kind: 'Continue', corrId: 'continue-race', sessionPath: SESSION,
      operationId: 'continue-op', operationAttempt: 1,
      operationSource: { kind: 'host' }, backendGeneration: 4,
    },
  }).state;

  state = reducer(state, {
    kind: 'MessageOperationDelayed', operationId: 'continue-op', operationKind: 'message.continue',
    sessionPath: SESSION, backendGeneration: 4, error: 'ack timeout',
  }).state;
  assert.equal(state.operations['continue-op']?.phase, 'ambiguous');

  const stale = reducer(state, {
    kind: 'MessageOperationStatus', operationId: 'continue-op', operationKind: 'message.continue',
    sessionPath: SESSION, backendGeneration: 3, state: 'failed', error: 'old worker',
  });
  assert.equal(stale.state, state);

  state = reducer(state, {
    kind: 'MessageOperationStatus', operationId: 'continue-op', operationKind: 'message.continue',
    sessionPath: SESSION, backendGeneration: 4, state: 'committed', requestId: 'request-1',
  }).state;
  assert.equal(state.operations['continue-op']?.terminal?.outcome, 'settled');
  assert.equal(state.operations['continue-op']?.phase, 'settled');
});

test('InterruptResult does not preempt earlier continuation commit evidence', () => {
  let state = reducer(readyState(), {
    kind: 'Command', cmd: { kind: 'Continue', corrId: 'continue-order', sessionPath: SESSION },
  }).state;
  state = reducer(state, {
    kind: 'ContinueResult', corrId: 'continue-order', operationId: 'continue-order',
    backendGeneration: 0, sessionPath: SESSION, ok: true, requestId: 'request-order',
  }).state;
  state = reducer(state, {
    kind: 'InterruptResult', corrId: 'stop-order', sessionPath: SESSION, ok: true,
  }).state;
  assert.equal(state.operations['continue-order']?.terminal, undefined);

  state = reducer(state, {
    kind: 'MessageStarted', requestId: 'request-order', operationId: 'continue-order',
    operationAttempt: 1, sessionPath: SESSION, messageId: 'assistant-order', timestamp: Date.now(),
  }).state;
  assert.equal(state.operations['continue-order']?.terminal?.outcome, 'settled');
});

test('start-gap continuation cancellation settles from its operation-bound terminal event', () => {
  let state = reducer(readyState(), {
    kind: 'Command', cmd: { kind: 'Continue', corrId: 'continue-cancel', sessionPath: SESSION },
  }).state;
  state = reducer(state, {
    kind: 'InterruptResult', corrId: 'stop-cancel', sessionPath: SESSION, ok: true,
  }).state;
  assert.equal(state.operations['continue-cancel']?.terminal, undefined);
  state = reducer(state, {
    kind: 'MessageAborted', requestId: 'request-cancel', operationId: 'continue-cancel',
    sessionPath: SESSION, outcome: 'cancelled', userInitiated: true,
  }).state;
  assert.equal(state.operations['continue-cancel']?.terminal?.outcome, 'cancelled');
});

test('late pre-start continuation failure settles once without creating a user row', () => {
  let state = reducer(readyState(), {
    kind: 'Command',
    cmd: { kind: 'Continue', corrId: 'continue-fail', sessionPath: SESSION },
  }).state;
  state = reducer(state, {
    kind: 'MessageAborted', requestId: 'request-fail', operationId: 'continue-fail',
    sessionPath: SESSION, outcome: 'failed', reason: 'start failed',
  }).state;
  assert.equal(state.operations['continue-fail']?.terminal?.outcome, 'failed');
  assert.equal(state.transcript.bySession[SESSION], undefined);

  const repeated = reducer(state, {
    kind: 'MessageAborted', requestId: 'request-fail', operationId: 'continue-fail',
    sessionPath: SESSION, outcome: 'cancelled', reason: 'late contradictory evidence',
  }).state;
  assert.equal(repeated.operations['continue-fail']?.terminal?.outcome, 'failed');
});

test('continuation cancelled during cold promotion is terminal without an operational error', () => {
  const started = reducer(readyState(), {
    kind: 'Command', cmd: { kind: 'Continue', corrId: 'continue-promotion-stop', sessionPath: SESSION },
  }).state;
  const cancelled = reducer(started, {
    kind: 'ContinueResult', corrId: 'continue-promotion-stop', operationId: 'continue-promotion-stop',
    backendGeneration: 0, sessionPath: SESSION, ok: false,
    error: 'SESSION_OPERATION_CANCELLED: interrupted before runtime promotion completed',
  }).state;
  assert.equal(cancelled.operations['continue-promotion-stop']?.terminal?.outcome, 'cancelled');
  assert.equal(cancelled.settings.notice, null);
});

test('failed continuation returns the session to idle and surfaces a session-owned notice', () => {
  const started = reducer(readyState(), {
    kind: 'Command',
    cmd: { kind: 'Continue', corrId: 'continue-2', sessionPath: SESSION },
  }).state;

  const failed = reducer(started, {
    kind: 'ContinueResult',
    corrId: 'continue-2',
    sessionPath: SESSION,
    ok: false,
    error: 'not interrupted',
  });

  assert.deepEqual(failed.state.sessions.runningSessionPaths, []);
  assert.equal(failed.state.settings.notice, 'Could not continue the interrupted response.');
  assert.equal(failed.state.settings.noticeRaw, 'not interrupted');
  assert.equal(failed.state.settings.noticeSessionPath, SESSION);
  assert.equal(failed.effects[0]?.kind, 'Log');
});
