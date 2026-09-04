import test from 'node:test';
import assert from 'node:assert/strict';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionOpenedPayload, SessionSummary } from '../../../../src/shared/protocol';

const SESSION = '/sessions/lifecycle.jsonl';
const OTHER = '/sessions/other.jsonl';

function summary(path = SESSION, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    path,
    name: path === SESSION ? 'Lifecycle' : 'Other',
    cwd: '/workspace',
    modifiedAt: '2026-09-05T00:00:00.000Z',
    messageCount: 0,
    ...extra,
  };
}

function baseState(options: { running?: boolean; private?: boolean } = {}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION, { sessionId: 'session-1' }), summary(OTHER)],
      openTabPaths: [SESSION, OTHER],
      activeSessionPath: SESSION,
      runningSessionPaths: options.running ? [SESSION] : [],
      privacyModeBySession: options.private ? { [SESSION]: true } : {},
      settlementGenerationBySession: {
        [SESSION]: { backendGeneration: 7, workerGeneration: 3 },
      },
    },
    transcript: {
      ...initialArchState.transcript,
      sessionUsageBySession: {
        [SESSION]: { samples: [], branchId: 'branch-1' },
      },
    },
    settings: { ...initialArchState.settings, backendReady: true },
  };
}

function openedPayload(operationId: string): SessionOpenedPayload {
  return {
    session: summary(SESSION, { sessionId: 'session-authoritative' }),
    transcript: [],
    transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    },
    busy: false,
    capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
    runtimeReady: false,
    selectionToken: 'selection-1',
    operationId,
    operationAttempt: 1,
    workerGeneration: 5,
    sessionUsage: { samples: [], branchId: 'branch-authoritative' },
  };
}

function openedEvent(operationId: string): Event {
  return {
    kind: 'SessionOpened',
    sessionPath: SESSION,
    payload: openedPayload(operationId),
    backendGeneration: 7,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
  };
}

function startOpen() {
  return reducer(baseState(), {
    kind: 'Command',
    cmd: {
      kind: 'OpenSession',
      corrId: 'open-corr',
      sessionPath: SESSION,
      placeholderSummary: null,
      selectionToken: 'selection-1',
      operationId: 'open-operation',
      operationAttempt: 1,
      operationSource: {
        kind: 'renderer', rendererId: 'browser-1', rendererKind: 'browser', rendererGeneration: 4,
      },
      causalParentOperationId: 'parent-operation',
      backendGeneration: 7,
    },
  });
}

const openResponse: Event = {
  kind: 'OpenSessionResult', corrId: 'open-corr', sessionPath: SESSION,
  operationId: 'open-operation', operationAttempt: 1, backendGeneration: 7, ok: true,
};

test('session.open records trusted renderer/source, causality, session branch, and process generations', () => {
  const started = startOpen();
  const operation = started.state.operations['open-operation'];
  assert.deepEqual(operation?.source, {
    kind: 'renderer', rendererId: 'browser-1', rendererKind: 'browser', rendererGeneration: 4,
  });
  assert.equal(operation?.causal.parentOperationId, 'parent-operation');
  assert.equal(operation?.session.sessionId, 'session-1');
  assert.equal(operation?.session.branchId, 'branch-1');
  assert.equal(operation?.backendGeneration, 7);
  assert.equal(operation?.workerGeneration, 3);
  assert.equal(started.effects.find((effect) => effect.kind === 'OpenSession')?.operationId, 'open-operation');
});

test('session.open response/event order converges and cannot produce a second terminal outcome', () => {
  for (const events of [[openResponse, openedEvent('open-operation')], [openedEvent('open-operation'), openResponse]]) {
    let state = startOpen().state;
    for (const event of events) state = reducer(state, event).state;
    const settled = state.operations['open-operation'];
    assert.equal(settled?.terminal?.outcome, 'settled');
    assert.equal(settled?.session.sessionId, 'session-authoritative');
    assert.equal(settled?.session.branchId, 'branch-authoritative');
    assert.equal(settled?.workerGeneration, 5);

    const contradictionEvent: Event = {
      kind: 'OpenSessionResult', corrId: 'open-corr', sessionPath: SESSION,
      operationId: 'open-operation', operationAttempt: 1, backendGeneration: 7,
      ok: false, error: 'late contradictory rejection',
    };
    const contradictedOperation = reducer(state, contradictionEvent).state.operations['open-operation'];
    assert.deepEqual(contradictedOperation?.terminal, settled?.terminal);
  }
});

test('session.open ignores stale backend-generation settlements', () => {
  const started = startOpen().state;
  for (const stale of [
    { ...openResponse, backendGeneration: 6 },
    { ...openedEvent('open-operation'), backendGeneration: 6 },
  ]) {
    const result = reducer(started, stale);
    assert.equal(result.state.operations['open-operation']?.terminal, undefined);
  }
});

test('session.open is fenced when its owning backend generation dies', () => {
  let state = startOpen().state;
  state = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'RestartBackend', corrId: 'restart-for-open', operationId: 'restart-for-open',
      operationSource: { kind: 'host' }, backendGeneration: 7,
    },
  }).state;
  state = reducer(state, {
    kind: 'BackendRestartDrainCompleted', operationId: 'restart-for-open', backendGeneration: 7,
  }).state;
  state = reducer(state, {
    kind: 'BackendRestartOldGenerationDied', operationId: 'restart-for-open', backendGeneration: 7,
  }).state;

  const ended = state.operations['open-operation'];
  assert.equal(ended?.terminal?.reason, 'backend-generation-ended');
  assert.equal(ended?.commit, 'not-committed');
  const late = reducer(state, openResponse).state.operations['open-operation'];
  assert.deepEqual(late?.terminal, ended?.terminal);
});

test('session.open dropped acknowledgement is ambiguous without rollback and late opened settles it', () => {
  const started = startOpen();
  const ambiguous = reducer(started.state, {
    ...openResponse,
    ok: false,
    ambiguous: true,
    error: 'request timeout',
  });
  assert.equal(ambiguous.state.operations['open-operation']?.phase, 'ambiguous');
  assert.equal(ambiguous.state.operations['open-operation']?.terminal, undefined);
  assert.equal(ambiguous.state.sessions.activeSessionPath, SESSION);
  assert.equal(ambiguous.state.sessions.openTabPaths.includes(SESSION), true);
  assert.equal(ambiguous.effects[0]?.kind, 'ScheduleOpenSessionReconciliation');

  const settled = reducer(ambiguous.state, openedEvent('open-operation')).state.operations['open-operation'];
  assert.equal(settled?.terminal?.outcome, 'settled');
  assert.equal(settled?.commit, 'committed');
});

test('session.open lost acknowledgement and event retries repeat-safe reads with one identity then reaches bounded recovery', () => {
  let state = startOpen().state;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ambiguous = reducer(state, {
      ...openResponse,
      operationAttempt: attempt,
      ok: false,
      ambiguous: true,
      error: `request timeout ${attempt}`,
    });
    state = ambiguous.state;
    assert.equal(state.operations['open-operation']?.phase, 'ambiguous');
    assert.equal(state.operations['open-operation']?.operationId, 'open-operation');
    assert.equal(ambiguous.effects[0]?.kind, 'ScheduleOpenSessionReconciliation');

    const due = reducer(state, {
      kind: 'OpenSessionReconciliationDue',
      operationId: 'open-operation',
      sessionPath: SESSION,
      operationAttempt: attempt,
      backendGeneration: 7,
    });
    state = due.state;
    if (attempt < 3) {
      const retry = due.effects[0];
      assert.equal(retry?.kind, 'OpenSession');
      if (retry?.kind === 'OpenSession') {
        assert.equal(retry.operationId, 'open-operation');
        assert.equal(retry.operationAttempt, attempt + 1);
        assert.equal(retry.selectionToken, 'selection-1');
      }
      assert.equal(state.operations['open-operation']?.attempt, attempt + 1);
      assert.equal(state.operations['open-operation']?.terminal, undefined);
    } else {
      const exhausted = state.operations['open-operation'];
      assert.equal(exhausted?.terminal?.outcome, 'failed');
      assert.equal(exhausted?.commit, 'unknown');
      assert.equal(exhausted?.terminal?.recovery, 'retry');
      assert.equal(due.effects[0]?.kind, 'RecoverOpenSession');
    }
  }
});

function closeCommand(operationId: string): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'CloseSession', corrId: `${operationId}:corr`, sessionPath: SESSION,
      operationId, operationAttempt: 1, operationSource: { kind: 'host' }, backendGeneration: 7,
    },
  };
}

function closeAck(
  kind: 'PersistTabsResult' | 'CloseSessionResult',
  operationId: string,
  ok = true,
  acknowledgementKey?: 'privacy-marker-removal',
): Event {
  return kind === 'PersistTabsResult'
    ? {
        kind, corrId: `${operationId}:corr`, operationId, backendGeneration: 7, ok,
        ...(acknowledgementKey ? { acknowledgementKey } : {}),
        ...(!ok ? { error: acknowledgementKey ? 'marker removal failed' : 'persist failed' } : {}),
      }
    : { kind, corrId: `${operationId}:corr`, sessionPath: SESSION, operationId, backendGeneration: 7, ok, ...(!ok ? { error: 'cleanup failed' } : {}) };
}

const privateCloseAcknowledgements = [
  'initial-persist',
  'cleanup',
  'marker-removal',
] as const;

type PrivateCloseAcknowledgement = typeof privateCloseAcknowledgements[number];

function privateCloseAck(acknowledgement: PrivateCloseAcknowledgement, operationId: string, ok = true): Event {
  if (acknowledgement === 'cleanup') return closeAck('CloseSessionResult', operationId, ok);
  return closeAck(
    'PersistTabsResult',
    operationId,
    ok,
    acknowledgement === 'marker-removal' ? 'privacy-marker-removal' : undefined,
  );
}

const privateCloseOrders: readonly (readonly PrivateCloseAcknowledgement[])[] = [
  ['initial-persist', 'cleanup', 'marker-removal'],
  ['initial-persist', 'marker-removal', 'cleanup'],
  ['cleanup', 'initial-persist', 'marker-removal'],
  ['cleanup', 'marker-removal', 'initial-persist'],
  ['marker-removal', 'initial-persist', 'cleanup'],
  ['marker-removal', 'cleanup', 'initial-persist'],
];

test('session.close running hide settles from tab persistence only', () => {
  const started = reducer(baseState({ running: true }), closeCommand('close-running'));
  assert.equal(started.state.operations['close-running']?.closeMode, 'running-hide');
  assert.deepEqual(started.state.operations['close-running']?.acknowledgements, { 'persist-tabs': 'pending' });
  assert.deepEqual(started.effects.map((effect) => effect.kind), ['PersistTabs', 'NotifySessionViewed']);

  const settledState = reducer(started.state, closeAck('PersistTabsResult', 'close-running')).state;
  const settled = settledState.operations['close-running'];
  assert.equal(settled?.terminal?.outcome, 'settled');
  const lateFailure = reducer(settledState, closeAck('PersistTabsResult', 'close-running', false)).state;
  assert.deepEqual(lateFailure.operations['close-running']?.terminal, settled?.terminal);
});

test('session.close idle cleanup settles after out-of-order required acknowledgements', () => {
  for (const order of [
    ['PersistTabsResult', 'CloseSessionResult'],
    ['CloseSessionResult', 'PersistTabsResult'],
  ] as const) {
    const operationId = `close-idle-${order[0]}`;
    let state = reducer(baseState(), closeCommand(operationId)).state;
    assert.equal(state.operations[operationId]?.closeMode, 'idle-cleanup');
    state = reducer(state, closeAck(order[0], operationId)).state;
    assert.equal(state.operations[operationId]?.terminal, undefined);
    state = reducer(state, closeAck(order[1], operationId)).state;
    assert.equal(state.operations[operationId]?.terminal?.outcome, 'settled');
    assert.deepEqual(state.operations[operationId]?.acknowledgements, {
      'persist-tabs': 'succeeded', cleanup: 'succeeded',
    });
  }
});

test('session.close private final marker-removal command preserves operation correlation in its effect', () => {
  const operationId = 'close-private-final-command';
  const started = reducer(baseState({ private: true }), closeCommand(operationId));
  const final = reducer(started.state, {
    kind: 'Command',
    cmd: {
      kind: 'PersistTabs', corrId: 'private-final', operationId, backendGeneration: 7,
      acknowledgementKey: 'privacy-marker-removal', openTabPaths: [OTHER],
      activeSessionPath: OTHER, pinnedTabPaths: [], pinnedTabGroups: [], privateSessionPaths: [],
    },
  });

  assert.equal(final.state, started.state);
  assert.deepEqual(final.effects, [{
    kind: 'PersistTabs', corrId: 'private-final', operationId, backendGeneration: 7,
    acknowledgementKey: 'privacy-marker-removal', openTabPaths: [OTHER],
    activeSessionPath: OTHER, pinnedTabPaths: [], pinnedTabGroups: [], privateSessionPaths: [],
  }]);
});

test('session.close private cleanup joins initial persistence, cleanup, and final marker removal in every order', () => {
  for (const order of privateCloseOrders) {
    const operationId = `close-private-${order.join('-')}`;
    let state = reducer(baseState({ private: true }), closeCommand(operationId)).state;
    assert.equal(state.operations[operationId]?.closeMode, 'private-cleanup');
    assert.deepEqual(state.operations[operationId]?.acknowledgements, {
      'persist-tabs': 'pending', cleanup: 'pending', 'privacy-marker-removal': 'pending',
    });

    for (let index = 0; index < order.length; index += 1) {
      state = reducer(state, privateCloseAck(order[index]!, operationId)).state;
      assert.equal(
        state.operations[operationId]?.terminal?.outcome,
        index === order.length - 1 ? 'settled' : undefined,
      );
    }
    assert.deepEqual(state.operations[operationId]?.acknowledgements, {
      'persist-tabs': 'succeeded', cleanup: 'succeeded', 'privacy-marker-removal': 'succeeded',
    });
  }
});

test('session.close private final marker-removal failure never follows a prior success terminal', () => {
  for (const order of privateCloseOrders) {
    const operationId = `close-private-final-failure-${order.join('-')}`;
    let state = reducer(baseState({ private: true }), closeCommand(operationId)).state;

    for (let index = 0; index < order.length; index += 1) {
      const acknowledgement = order[index]!;
      state = reducer(
        state,
        privateCloseAck(acknowledgement, operationId, acknowledgement !== 'marker-removal'),
      ).state;
      if (index < order.length - 1) assert.equal(state.operations[operationId]?.terminal, undefined);
    }

    const failed = state.operations[operationId];
    assert.equal(failed?.terminal?.outcome, 'failed');
    assert.equal(failed?.commit, 'committed');
    assert.equal(failed?.terminal?.recovery, 'reconcile');
    assert.match(failed?.terminal?.detail ?? '', /marker removal failed/);
  }
});

test('session.close partial commit failure requires reconciliation and stale acknowledgements are ignored', () => {
  const operationId = 'close-partial-failure';
  let state = reducer(baseState(), closeCommand(operationId)).state;
  const stale = reducer(state, {
    kind: 'PersistTabsResult', corrId: `${operationId}:corr`, operationId,
    backendGeneration: 6, ok: true,
  });
  assert.equal(stale.state, state);

  state = reducer(state, closeAck('PersistTabsResult', operationId)).state;
  const failed = reducer(state, closeAck('CloseSessionResult', operationId, false)).state.operations[operationId];
  assert.equal(failed?.terminal?.outcome, 'failed');
  assert.equal(failed?.commit, 'committed');
  assert.equal(failed?.terminal?.recovery, 'reconcile');
});

test('session.close failure-first permutations wait for the whole barrier and preserve later commit evidence', () => {
  for (const failedFirst of ['PersistTabsResult', 'CloseSessionResult'] as const) {
    const succeedingLater = failedFirst === 'PersistTabsResult' ? 'CloseSessionResult' : 'PersistTabsResult';
    const operationId = `close-failure-first-${failedFirst}`;
    let state = reducer(baseState(), closeCommand(operationId)).state;

    state = reducer(state, closeAck(failedFirst, operationId, false)).state;
    const awaiting = state.operations[operationId];
    assert.equal(awaiting?.terminal, undefined, `${failedFirst} must not terminalize before the barrier completes`);
    assert.equal(awaiting?.phase, 'awaiting-commit');
    assert.equal(awaiting?.commit, 'pending');

    state = reducer(state, closeAck(succeedingLater, operationId, true)).state;
    const failed = state.operations[operationId];
    assert.equal(failed?.terminal?.outcome, 'failed');
    assert.equal(failed?.commit, 'committed');
    assert.equal(failed?.terminal?.recovery, 'reconcile');
    assert.match(failed?.terminal?.detail ?? '', /failed/);
  }
});

test('session.close all-failure barrier derives a non-committed terminal only after every acknowledgement', () => {
  const operationId = 'close-all-failed';
  let state = reducer(baseState(), closeCommand(operationId)).state;
  state = reducer(state, closeAck('CloseSessionResult', operationId, false)).state;
  assert.equal(state.operations[operationId]?.terminal, undefined);
  state = reducer(state, closeAck('PersistTabsResult', operationId, false)).state;
  const failed = state.operations[operationId];
  assert.equal(failed?.terminal?.outcome, 'failed');
  assert.equal(failed?.commit, 'not-committed');
  assert.equal(failed?.terminal?.recovery, 'none');
});

test('backend.restart is reducer-owned through drain, confirmed death, commit, and one terminal', () => {
  const command: Event = {
    kind: 'Command',
    cmd: {
      kind: 'RestartBackend', corrId: 'restart-corr', operationId: 'restart-operation',
      operationSource: { kind: 'renderer', rendererId: 'sidebar', rendererKind: 'vscode', rendererGeneration: 2 },
      backendGeneration: 7,
    },
  };
  let result = reducer(baseState(), command);
  assert.equal(result.state.operations['restart-operation']?.phase, 'draining');
  assert.equal(result.state.settings.backendReady, false);
  assert.deepEqual(result.effects.map((effect) => effect.kind), ['RestartBackend']);

  const coalesced = reducer(result.state, {
    kind: 'Command',
    cmd: {
      kind: 'RestartBackend', corrId: 'restart-2', operationId: 'restart-operation-2',
      operationSource: { kind: 'host' }, backendGeneration: 7,
    },
  });
  assert.equal(coalesced.state, result.state);
  assert.deepEqual(coalesced.effects, []);

  result = reducer(result.state, {
    kind: 'BackendRestartDrainCompleted', operationId: 'restart-operation', backendGeneration: 7,
  });
  assert.equal(result.state.operations['restart-operation']?.phase, 'awaiting-old-generation-death');
  result = reducer(result.state, {
    kind: 'BackendRestartOldGenerationDied', operationId: 'restart-operation', backendGeneration: 7,
  });
  assert.equal(result.state.operations['restart-operation']?.phase, 'awaiting-commit');
  assert.equal(result.state.operations['restart-operation']?.commit, 'committed');
  result = reducer(result.state, {
    kind: 'BackendRestartResult', corrId: 'restart-corr', operationId: 'restart-operation',
    backendGeneration: 7, replacementBackendGeneration: 8, ok: true,
  });
  const restarted = result.state.operations['restart-operation'];
  const terminal = restarted?.terminal;
  assert.equal(terminal?.outcome, 'settled');
  assert.equal(restarted?.replacementBackendGeneration, 8);

  const duplicate = reducer(result.state, {
    kind: 'BackendRestartResult', corrId: 'restart-corr', operationId: 'restart-operation',
    backendGeneration: 7, replacementBackendGeneration: 8, ok: false, error: 'late failure',
  });
  assert.deepEqual(duplicate.state.operations['restart-operation']?.terminal, terminal);
});
