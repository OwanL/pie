import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArchState } from '../../../conversation-state/arch-state.js';
import type { CloseSessionCommand } from '../../../conversation-state/commands.js';
import { handleCloseSession } from '../../../conversation-state/reducers/command-session-handlers.js';
import {
  handlePersistTabsResult,
  handleCloseSessionResult,
  handleSessionCloseResponseDelivered,
} from '../../../conversation-state/reducers/misc-handlers.js';
import { observeCloseOperationAcknowledgement } from '../../../conversation-state/reducers/helpers.js';
import { createInitialArchState } from '../../../conversation-state/arch-state.js';

/** Minimal running-session state so the agent close reaches the stop-cleanup branch. */
function runningState(sessionPath: string): ArchState {
  const state = createInitialArchState();
  return {
    ...state,
    sessions: {
      ...state.sessions,
      openTabPaths: [sessionPath],
      activeSessionPath: sessionPath,
      runningSessionPaths: [sessionPath],
      sessions: [{
        path: sessionPath,
        name: 'Running',
        cwd: '/workspace',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        messageCount: 2,
      }],
      pinnedTabPaths: [],
      pinnedTabGroups: [] as string[][],
    },
    operations: {},
  };
}

function agentCloseCommand(overrides: Partial<CloseSessionCommand> = {}): CloseSessionCommand {
  return {
    kind: 'CloseSession',
    corrId: 'corr-close',
    operationId: 'close-op',
    operationAttempt: 1,
    operationSource: { kind: 'agent-session-control' },
    backendGeneration: 3,
    sessionPath: '/workspace/running.jsonl',
    privacyMode: false,
    closeRequestKey: 'tool-1:close',
    selfHandoffRequired: true,
    ...overrides,
  };
}

test('typed agent close holds its stop until the closeRequested response is handed to the caller', () => {
  const sessionPath = '/workspace/running.jsonl';
  const result = handleCloseSession(runningState(sessionPath), agentCloseCommand());
  assert.deepEqual(result.state.sessions.openTabPaths, []);
  assert.deepEqual(result.state.sessions.runningSessionPaths, [sessionPath]);
  const closeOperation = result.state.operations['close-op'];
  assert.equal(closeOperation?.kind, 'session.close');
  assert.equal(closeOperation?.closeMode, 'stop-cleanup');
  assert.equal(closeOperation?.closeRequestKey, 'tool-1:close');
  assert.deepEqual(closeOperation?.acknowledgements, {
    'persist-tabs': 'pending', cleanup: 'pending', stop: 'pending', 'caller-response': 'pending',
  });
  // The deferred cleanup lifecycle effect is not dispatched before the stop.
  assert.ok(!result.effects.some((effect) => effect.kind === 'CloseSession'));
  const stopOperation = result.state.operations[closeOperation!.closeStopOperationId!];
  assert.equal(stopOperation.kind, 'message.interrupt');
  assert.ok(!result.effects.some((effect) => effect.kind === 'InterruptRpc'));
  const ingressAcks = result.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck');
  assert.deepEqual(ingressAcks.map((effect) => (effect as { phase?: string }).phase), ['accepted']);

  const delivered = handleSessionCloseResponseDelivered(result.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  });
  const interrupt = delivered.effects.find((effect) => effect.kind === 'InterruptRpc');
  assert.equal(interrupt?.kind, 'InterruptRpc');
  assert.equal(delivered.state.operations['close-op']?.acknowledgements?.['caller-response'], 'succeeded');
  assert.equal(delivered.state.operations['close-op']?.closeStopDispatched, true);
  assert.deepEqual(handleSessionCloseResponseDelivered(delivered.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  }).effects, [], 'duplicate response-delivery observations cannot dispatch a second stop');
});

test('foreign agent close starts stopping after host acceptance without waiting for response delivery', () => {
  const sessionPath = '/workspace/running.jsonl';
  const foreign = handleCloseSession(runningState(sessionPath), agentCloseCommand({
    selfHandoffRequired: false,
  }));
  const acceptedIndex = foreign.effects.findIndex((effect) =>
    effect.kind === 'SessionCloseBridgeAck' && effect.phase === 'accepted',
  );
  const interruptIndex = foreign.effects.findIndex((effect) => effect.kind === 'InterruptRpc');
  assert.ok(acceptedIndex >= 0, 'host acceptance is reported');
  assert.ok(interruptIndex > acceptedIndex, 'interrupt is dispatched after acceptance');
  assert.equal(foreign.state.operations['close-op']?.closeStopDispatched, true);
  assert.equal(foreign.state.operations['close-op']?.closeSelfHandoffRequired, undefined);
  assert.equal(foreign.state.operations['close-op']?.acknowledgements?.['caller-response'], undefined);

  // The effect runner invokes the acknowledgement before the interrupt. No
  // response-delivered event or handoff timeout is needed for a foreign target.
  const observed: string[] = [];
  for (const effect of foreign.effects) {
    if (effect.kind === 'SessionCloseBridgeAck' && effect.phase === 'accepted') observed.push('accepted');
    if (effect.kind === 'InterruptRpc') {
      assert.ok(observed.includes('accepted'));
      observed.push('interrupted');
    }
  }
  assert.deepEqual(observed, ['accepted', 'interrupted']);
  assert.deepEqual(handleSessionCloseResponseDelivered(foreign.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  }).effects, [], 'foreign close is already progressing before response delivery');
});

test('settled stop releases the deferred cleanup lifecycle once through the stop acknowledgement', () => {
  const sessionPath = '/workspace/running.jsonl';
  const first = handleCloseSession(runningState(sessionPath), agentCloseCommand());
  const handed = handleSessionCloseResponseDelivered(first.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  });
  assert.ok(handed.effects.some((effect) => effect.kind === 'InterruptRpc'));
  const stopOperationId = handed.state.operations['close-op']!.closeStopOperationId!;
  // First persist-tabs acknowledgement observes the independently ordered barrier.
  const persisted = handlePersistTabsResult(handed.state, {
    kind: 'PersistTabsResult', corrId: 'corr-close', operationId: 'close-op', backendGeneration: 3, ok: true,
  });
  assert.deepEqual(persisted.effects, []);
  const interruptSettled: ArchState = {
    ...persisted.state,
    operations: {
      ...persisted.state.operations,
      [stopOperationId]: {
        ...persisted.state.operations[stopOperationId],
        terminal: { outcome: 'settled', reason: 'durable-commit-observed', recovery: 'none' },
      },
    },
  };
  // The harness resolves the stop ack through closeStopAcknowledgement in the
  // InterruptResult reducer; drive the shared barrier directly here.
  const released = observeCloseOperationAcknowledgement(
    interruptSettled, 'close-op', 3, 'stop', true,
  );
  const operation = released.state.operations['close-op'];
  assert.equal(operation?.closeCleanupDispatched, true);
  assert.ok(!operation?.terminal);
  const cleanup = released.effects.find((effect) => effect.kind === 'CloseSession');
  assert.equal(cleanup?.kind, 'CloseSession');
  // A duplicate stop observation cannot dispatch the cleanup lifecycle twice.
  const repeat = observeCloseOperationAcknowledgement(released.state, 'close-op', 3, 'stop', true);
  assert.ok(!repeat.effects.some((effect) => effect.kind === 'CloseSession'));
});

test('terminal agent close barrier emits exactly one terminal typed bridge acknowledgement effect', () => {
  const sessionPath = '/workspace/running.jsonl';
  const started = handleCloseSession(runningState(sessionPath), agentCloseCommand());
  const handed = handleSessionCloseResponseDelivered(started.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  });
  assert.ok(handed.effects.some((effect) => effect.kind === 'InterruptRpc'));
  const persisted = handlePersistTabsResult(handed.state, {
    kind: 'PersistTabsResult', corrId: 'corr-close', operationId: 'close-op', backendGeneration: 3, ok: true,
  });
  const stopped = observeCloseOperationAcknowledgement(persisted.state, 'close-op', 3, 'stop', true);
  const cleaned = handleCloseSessionResult(stopped.state, {
    kind: 'CloseSessionResult', corrId: 'corr-close', sessionPath, operationId: 'close-op', backendGeneration: 3, ok: true,
  });
  const operation = cleaned.state.operations['close-op'];
  assert.ok(operation?.terminal);
  const bridgeAcks = cleaned.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck');
  assert.equal(bridgeAcks.length, 1);
  assert.equal(bridgeAcks[0].requestKey, 'tool-1:close');
  assert.equal(bridgeAcks[0].phase, 'completed');
  assert.equal(bridgeAcks[0].sessionPath, sessionPath);
  // Repeated observations of the terminal close cannot emit a second ack.
  const repeat = handleCloseSessionResult(cleaned.state, {
    kind: 'CloseSessionResult', corrId: 'corr-close', sessionPath, operationId: 'close-op', backendGeneration: 3, ok: true,
  });
  assert.deepEqual(repeat.effects, []);

  // A fully failed non-committed barrier reports failure and restores the
  // surviving tab without stealing focus or reissuing the close.
  const failedStarted = handleCloseSession(runningState(sessionPath), agentCloseCommand({
    operationId: 'close-op-failed',
    closeRequestKey: 'tool-2:close',
  }));
  const failedHandoff = handleSessionCloseResponseDelivered(failedStarted.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-2:close',
  });
  assert.ok(failedHandoff.effects.some((effect) => effect.kind === 'InterruptRpc'));
  const stopOp = failedHandoff.state.operations['close-op-failed']!.closeStopOperationId!;
  const failedPersist = handlePersistTabsResult(failedHandoff.state, {
    kind: 'PersistTabsResult', corrId: 'corr-failed', operationId: 'close-op-failed', backendGeneration: 3,
    ok: false, error: 'persist failed',
  });
  const failedState: ArchState = {
    ...failedPersist.state,
    operations: {
      ...failedPersist.state.operations,
      [stopOp]: { ...failedPersist.state.operations[stopOp], terminal: { outcome: 'failed', reason: 'definitive-rejection', recovery: 'none' } },
    },
  };
  const failedStop = observeCloseOperationAcknowledgement(failedState, 'close-op-failed', 3, 'stop', false, 'stop failed');
  assert.ok(failedStop.state.sessions.openTabPaths.includes(sessionPath));
  assert.equal(failedStop.state.sessions.activeSessionPath, failedStarted.state.sessions.activeSessionPath);
  const failedAck = failedStop.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck');
  assert.equal(failedAck.length, 1);
  assert.equal(failedAck[0].phase, 'failed');
  assert.equal(failedAck[0].error, 'stop failed');
});

for (const stopFirst of [true, false]) {
  for (const privateClose of [true, false]) {
    test(`failed tab persistence settles close without stranded cleanup (stopFirst=${stopFirst}, private=${privateClose})`, () => {
      const sessionPath = '/workspace/running.jsonl';
      const started = handleCloseSession(runningState(sessionPath), agentCloseCommand({ privacyMode: privateClose }));
      const handed = handleSessionCloseResponseDelivered(started.state, {
        kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
      });
      assert.ok(handed.effects.some((effect) => effect.kind === 'InterruptRpc'));
      const stop = (state: ArchState) => observeCloseOperationAcknowledgement(state, 'close-op', 3, 'stop', true);
      const failPersistence = (state: ArchState) => handlePersistTabsResult(state, {
        kind: 'PersistTabsResult', corrId: 'corr-close', operationId: 'close-op', backendGeneration: 3,
        ok: false, error: 'tab persistence failed',
      });
      const first = stopFirst ? stop(handed.state) : failPersistence(handed.state);
      assert.equal(first.state.operations['close-op'].terminal, undefined);
      const terminal = stopFirst ? failPersistence(first.state) : stop(first.state);
      assert.ok(terminal.state.operations['close-op'].terminal);
      assert.ok(terminal.state.sessions.openTabPaths.includes(sessionPath));
      assert.equal(terminal.state.sessions.activeSessionPath, started.state.sessions.activeSessionPath);
      assert.ok(![...first.effects, ...terminal.effects].some((effect) => effect.kind === 'CloseSession'));
      const acknowledgements = terminal.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck');
      assert.equal(acknowledgements.length, 1);
      assert.notEqual(acknowledgements[0].phase, 'completed');
    });
  }
}

test('agent close during a pending UI close reports unknown instead of inferring completion from the summary', () => {
  const sessionPath = '/workspace/running.jsonl';
  const uiClose = handleCloseSession(runningState(sessionPath), {
    kind: 'CloseSession',
    corrId: 'ui-close',
    operationId: 'ui-close-op',
    operationAttempt: 1,
    operationSource: { kind: 'host' },
    backendGeneration: 3,
    sessionPath,
    privacyMode: false,
  });
  assert.deepEqual(uiClose.state.sessions.openTabPaths, []);
  assert.equal(uiClose.state.operations['ui-close-op']?.terminal, undefined);

  const agentClose = handleCloseSession(uiClose.state, agentCloseCommand({
    corrId: 'agent-close',
    operationId: 'agent-close-op',
    closeRequestKey: 'tool-racing-ui-close:close',
    selfHandoffRequired: false,
  }));
  const acknowledgements = agentClose.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck');
  assert.deepEqual(acknowledgements.map((effect) => effect.phase), ['accepted', 'unknown']);
});

test('agent close without a tab requires confirmed successful close evidence, not a retained summary', () => {
  const state = runningState('/workspace/other.jsonl');
  const missing = handleCloseSession(state, agentCloseCommand({ sessionPath: '/workspace/gone.jsonl' }));
  assert.deepEqual(missing.effects.map((effect) => effect.kind), ['SessionCloseBridgeAck', 'SessionCloseBridgeAck']);
  assert.equal(missing.effects[0].kind === 'SessionCloseBridgeAck' && missing.effects[0].phase, 'accepted');
  assert.equal(missing.effects[1].kind === 'SessionCloseBridgeAck' && missing.effects[1].phase, 'unknown');

  // A retained summary alone is not cleanup evidence for a hidden/historical
  // member, even when there is no close currently pending.
  const summaryOnly = handleCloseSession({
    ...state,
    sessions: { ...state.sessions, openTabPaths: [] },
  }, agentCloseCommand({ sessionPath: '/workspace/other.jsonl' }));
  assert.deepEqual(summaryOnly.effects.map((effect) => (effect as { phase?: string }).phase), ['accepted', 'unknown']);
});

test('agent close without a tab recognizes successful prior cleanup only while target is not live again', () => {
  const sessionPath = '/workspace/other.jsonl';
  const beforeClose = runningState(sessionPath);
  const prior = handleCloseSession({
    ...beforeClose,
    sessions: { ...beforeClose.sessions, runningSessionPaths: [] },
  }, {
    kind: 'CloseSession', corrId: 'prior-ui-close', operationId: 'prior-close-op', operationAttempt: 1,
    operationSource: { kind: 'host' }, backendGeneration: 3, sessionPath, privacyMode: false,
  });
  const persisted = handlePersistTabsResult(prior.state, {
    kind: 'PersistTabsResult', corrId: 'prior-ui-close', operationId: 'prior-close-op', backendGeneration: 3, ok: true,
  });
  const cleaned = handleCloseSessionResult(persisted.state, {
    kind: 'CloseSessionResult', corrId: 'prior-ui-close', sessionPath, operationId: 'prior-close-op', backendGeneration: 3, ok: true,
  });
  assert.equal(cleaned.state.operations['prior-close-op']?.terminal?.outcome, 'settled');
  assert.equal(cleaned.state.operations['prior-close-op']?.acknowledgements?.cleanup, 'succeeded');

  const confirmed = handleCloseSession(cleaned.state, agentCloseCommand({ sessionPath }));
  assert.deepEqual(confirmed.effects.map((effect) => (effect as { phase?: string }).phase), ['accepted', 'completed']);

  const unrelatedSummary = runningState('/workspace/unrelated.jsonl').sessions.sessions[0];
  const unrelatedTarget = handleCloseSession({
    ...cleaned.state,
    sessions: {
      ...cleaned.state.sessions,
      sessions: [...cleaned.state.sessions.sessions, unrelatedSummary],
    },
  }, agentCloseCommand({ sessionPath: unrelatedSummary.path }));
  assert.deepEqual(unrelatedTarget.effects.map((effect) => (effect as { phase?: string }).phase), ['accepted', 'unknown']);

  // A member that is running again is newer live state; the old terminal close
  // cannot prove this close completed, even if the UI tab remains hidden.
  const liveAgain = {
    ...cleaned.state,
    sessions: {
      ...cleaned.state.sessions,
      runningSessionPaths: [sessionPath],
      intentionallyHiddenRunningPaths: [sessionPath],
    },
  };
  const hiddenRunning = handleCloseSession(liveAgain, agentCloseCommand({ sessionPath }));
  assert.deepEqual(hiddenRunning.effects.filter((effect) => effect.kind === 'SessionCloseBridgeAck')
    .map((effect) => (effect as { phase?: string }).phase), ['accepted']);
  assert.equal(hiddenRunning.state.operations['close-op']?.acknowledgements?.stop, 'pending');
  assert.ok(Object.values(hiddenRunning.state.operations).some((operation) =>
    operation.kind === 'session.close' && !operation.terminal && operation.closeMode === 'stop-cleanup'));
});

test('UI close keeps its immediate interrupt and idle agent close defers cleanup to response delivery', () => {
  const sessionPath = '/workspace/running.jsonl';
  const uiClose = handleCloseSession(runningState(sessionPath), agentCloseCommand({
    operationSource: { kind: 'host' }, closeRequestKey: undefined,
  }));
  assert.ok(uiClose.effects.some((effect) => effect.kind === 'InterruptRpc'));
  assert.ok(!uiClose.effects.some((effect) => effect.kind === 'SessionCloseBridgeAck'));

  const base = runningState(sessionPath);
  const idle = { ...base, sessions: { ...base.sessions, runningSessionPaths: [] } };
  const started = handleCloseSession(idle, agentCloseCommand());
  assert.ok(!started.effects.some((effect) => effect.kind === 'CloseSession'));
  const delivered = handleSessionCloseResponseDelivered(started.state, {
    kind: 'SessionCloseResponseDelivered', sessionPath, requestId: 'tool-1:close',
  });
  assert.ok(delivered.effects.some((effect) => effect.kind === 'CloseSession'));
});