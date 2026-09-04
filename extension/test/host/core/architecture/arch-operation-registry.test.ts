import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import {
  activeInterruptOperation,
  clearRetiredInterruptEventFence,
  hasRetiredInterruptEventFence,
  settleSessionOperationSucceeded,
  startSessionOperation,
} from '../../../../src/host/core/operation-registry';
import { selectViewState } from '../../../../src/host/core/projection';
import { reducer } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary } from '../../../../src/shared/protocol';

const PENDING = '/__pending__:operation-registry';
const PLACEHOLDER: SessionSummary = {
  path: PENDING,
  name: 'New Session',
  cwd: '/workspace',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 0,
  isPlaceholder: true,
};

function createCommand(overrides: Record<string, unknown> = {}): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'CreateSession',
      corrId: 'create-1',
      sessionPath: PENDING,
      cwd: '/workspace',
      placeholderSummary: PLACEHOLDER,
      selectionToken: 'selection-1',
      operationId: 'operation-1',
      operationAttempt: 1,
      backendGeneration: 7,
      operationSource: {
        kind: 'renderer',
        rendererId: 'browser-1',
        rendererKind: 'browser',
        rendererGeneration: 3,
      },
      ...overrides,
    },
  } as Event;
}

test('create uses the common registry across ambiguity, stable-id retry, and late success', () => {
  const created = reducer(createInitialArchState(), createCommand());
  const initial = created.state.operations['operation-1'];
  assert.deepEqual(initial, {
    operationId: 'operation-1',
    kind: 'session.create',
    source: {
      kind: 'renderer',
      rendererId: 'browser-1',
      rendererKind: 'browser',
      rendererGeneration: 3,
    },
    session: { pendingPath: PENDING },
    causal: { parentOperationId: null, selectionToken: 'selection-1' },
    backendGeneration: 7,
    attempt: 1,
    phase: 'awaiting-acceptance',
    acceptance: 'pending',
    commit: 'pending',
    recovery: null,
    cwd: '/workspace',
  });

  const staleGeneration = reducer(created.state, {
    kind: 'CreateOperationDelayed',
    operationId: 'operation-1',
    pendingPath: PENDING,
    selectionToken: 'selection-1',
    attempt: 1,
    backendGeneration: 6,
  });
  assert.equal(staleGeneration.state, created.state);

  const delayed = reducer(created.state, {
    kind: 'CreateOperationDelayed',
    operationId: 'operation-1',
    pendingPath: PENDING,
    selectionToken: 'selection-1',
    attempt: 1,
    backendGeneration: 7,
  });
  assert.deepEqual(
    selectViewState(delayed.state).sessionCapabilitiesBySession[PENDING]?.primaryOperation,
    {
      operationId: 'operation-1',
      kind: 'session.create',
      phase: 'ambiguous',
      attempt: 1,
      committed: false,
      recovery: 'retry',
    },
  );
  assert.equal(delayed.state.sessions.sessions[0]?.creationState, 'delayed');

  const retried = reducer(delayed.state, createCommand({ corrId: 'create-retry', operationAttempt: 2 }));
  const retry = retried.state.operations['operation-1'];
  assert.equal(retry?.operationId, 'operation-1');
  assert.equal(retry?.attempt, 2);
  assert.equal(retry?.phase, 'awaiting-acceptance');
  assert.equal(retry?.commit, 'unknown', 'retry cannot erase prior commit ambiguity');
  assert.equal(
    retried.effects.find((effect) => effect.kind === 'CreateSession')?.operationAttempt,
    2,
  );

  const staleFailure = reducer(retried.state, {
    kind: 'CreateOperationFailed',
    operationId: 'operation-1',
    pendingPath: PENDING,
    error: 'old waiter rejected',
    attempt: 1,
    backendGeneration: 7,
  });
  assert.equal(staleFailure.state, retried.state);

  // A late durable event from attempt 1 is valid evidence for the same
  // idempotent operation while attempt 2 owns the local waiter.
  const succeeded = reducer(retried.state, {
    kind: 'CreateOperationSucceeded',
    operationId: 'operation-1',
    pendingPath: PENDING,
    sessionPath: '/sessions/created.jsonl',
    attempt: 1,
    backendGeneration: 7,
  });
  assert.deepEqual(succeeded.state.operations['operation-1']?.terminal, {
    outcome: 'settled',
    reason: 'durable-commit-observed',
    recovery: 'none',
  });
  assert.equal(succeeded.state.operations['operation-1']?.commit, 'committed');
  assert.equal(
    selectViewState(succeeded.state).sessionCapabilitiesBySession[PENDING]?.primaryOperation,
    undefined,
  );

  const duplicateTerminal = reducer(succeeded.state, {
    kind: 'CreateOperationFailed',
    operationId: 'operation-1',
    pendingPath: PENDING,
    error: 'late contradictory failure',
    attempt: 2,
    backendGeneration: 7,
  });
  assert.equal(duplicateTerminal.state, succeeded.state, 'a terminal operation settles exactly once');

  const mismatchedReuse = reducer(succeeded.state, createCommand({ cwd: '/different' }));
  assert.equal(mismatchedReuse.state, succeeded.state, 'a terminal operationId cannot be resurrected with changed intent');
  assert.deepEqual(mismatchedReuse.effects, []);
});

test('interrupt registry helpers derive active ownership and clear retired fencing purely', () => {
  const active = startSessionOperation({
    operationId: 'stop-1', kind: 'message.interrupt', source: { kind: 'host' },
    pendingPath: '/sessions/stop.jsonl', selectionToken: 'stop-1', backendGeneration: 5,
  });
  const activeRegistry = { [active.operationId]: active };
  assert.equal(activeInterruptOperation(activeRegistry, '/sessions/stop.jsonl'), active);
  assert.equal(hasRetiredInterruptEventFence(activeRegistry, '/sessions/stop.jsonl'), false);

  const settled = settleSessionOperationSucceeded(active, {
    pendingPath: '/sessions/stop.jsonl', backendGeneration: 5,
  })!;
  const settledRegistry = { [settled.operationId]: settled };
  assert.equal(activeInterruptOperation(settledRegistry, '/sessions/stop.jsonl'), undefined);
  assert.equal(hasRetiredInterruptEventFence(settledRegistry, '/sessions/stop.jsonl'), true);

  const cleared = clearRetiredInterruptEventFence(settledRegistry, '/sessions/stop.jsonl');
  assert.notEqual(cleared, settledRegistry);
  assert.equal(hasRetiredInterruptEventFence(cleared, '/sessions/stop.jsonl'), false);
  assert.equal(hasRetiredInterruptEventFence(settledRegistry, '/sessions/stop.jsonl'), true);
  assert.equal(cleared['stop-1']?.terminal, settled.terminal, 'clearing the fence preserves the one terminal outcome');
  assert.equal(
    clearRetiredInterruptEventFence(cleared, '/sessions/stop.jsonl'),
    cleared,
    'an already-cleared registry is returned by reference',
  );
});

test('Send, Edit, Continue, and Compact execution commands clear a retired interrupt fence', () => {
  const sessionPath = '/sessions/retired.jsonl';
  const base = {
    ...createInitialArchState(),
    settings: { ...createInitialArchState().settings, backendReady: true },
    transcript: {
      ...createInitialArchState().transcript,
      bySession: {
        [sessionPath]: [{
          id: 'user-1', role: 'user' as const, createdAt: '2026-01-01T00:00:00.000Z',
          markdown: 'old', status: 'completed' as const,
        }],
      },
    },
  };
  const stopping = reducer(base, {
    kind: 'Command', cmd: { kind: 'Interrupt', corrId: 'stop', sessionPath },
  }).state;
  const retired = reducer(stopping, {
    kind: 'InterruptResult', corrId: 'stop', operationId: 'stop',
    backendGeneration: 0, sessionPath, ok: true, committed: true, settled: true,
  }).state;
  assert.equal(hasRetiredInterruptEventFence(retired.operations, sessionPath), true);

  const cases: Array<{ name: string; command: Event; effect: string }> = [
    {
      name: 'Send', effect: 'SendRpc', command: {
        kind: 'Command', cmd: {
          kind: 'Send', corrId: 'send', sessionPath, text: 'new', inputs: [],
          composedText: 'new', localId: 'local-send', previousSummary: null, timestamp: 1,
        },
      },
    },
    {
      name: 'Edit', effect: 'EditRpc', command: {
        kind: 'Command', cmd: {
          kind: 'Edit', corrId: 'edit', sessionPath, messageId: 'user-1', text: 'replacement',
          inputs: [], composedText: 'replacement', localId: 'local-edit', timestamp: 1,
        },
      },
    },
    {
      name: 'Continue', effect: 'ContinueRpc', command: {
        kind: 'Command', cmd: { kind: 'Continue', corrId: 'continue', sessionPath },
      },
    },
    {
      name: 'Compact', effect: 'CompactRpc', command: {
        kind: 'Command', cmd: { kind: 'Compact', corrId: 'compact', sessionPath },
      },
    },
  ];

  for (const candidate of cases) {
    const result = reducer(retired, candidate.command);
    assert.equal(
      hasRetiredInterruptEventFence(result.state.operations, sessionPath),
      false,
      `${candidate.name} clears the retired fence`,
    );
    assert.equal(result.effects.some((effect) => effect.kind === candidate.effect), true);
  }
});

test('duplicate records source/session/causal identity and generation death terminalizes once', () => {
  const duplicate = reducer(createInitialArchState(), {
    kind: 'Command',
    cmd: {
      kind: 'DuplicateSession',
      corrId: 'duplicate-1',
      sessionPath: PENDING,
      sourceSessionPath: '/sessions/source.jsonl',
      placeholderSummary: { ...PLACEHOLDER, name: 'Source (copy)' },
      selectionToken: 'selection-duplicate',
      operationId: 'operation-duplicate',
      backendGeneration: 11,
      causalParentOperationId: 'operation-parent',
    },
  });
  const operation = duplicate.state.operations['operation-duplicate'];
  assert.equal(operation?.kind, 'session.duplicate');
  assert.deepEqual(operation?.session, {
    pendingPath: PENDING,
    sourcePath: '/sessions/source.jsonl',
  });
  assert.deepEqual(operation?.causal, {
    parentOperationId: 'operation-parent',
    selectionToken: 'selection-duplicate',
  });
  assert.equal(operation?.backendGeneration, 11);

  const failed = reducer(duplicate.state, {
    kind: 'CreateOperationFailed',
    operationId: 'operation-duplicate',
    pendingPath: PENDING,
    error: 'backend exited',
    attempt: 1,
    backendGeneration: 11,
    reason: 'backend-generation-ended',
  });
  assert.deepEqual(failed.state.operations['operation-duplicate']?.terminal, {
    outcome: 'failed',
    reason: 'backend-generation-ended',
    recovery: 'restart-backend',
    detail: 'backend exited',
  });

  const duplicateDeath = reducer(failed.state, {
    kind: 'CreateOperationFailed',
    operationId: 'operation-duplicate',
    pendingPath: PENDING,
    error: 'same exit observed again',
    attempt: 1,
    backendGeneration: 11,
    reason: 'backend-generation-ended',
  });
  assert.equal(duplicateDeath.state, failed.state);
});
