import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import { projectSessionCapabilities } from '../../../../src/host/core/projection';
import {
  activeInterruptOperation,
  hasRetiredInterruptEventFence,
} from '../../../../src/host/core/operation-registry';
import type { ChatMessage } from '../../../../src/shared/protocol';
import type { TurnSemanticEnvelope } from '../../../../src/shared/live-pipeline-protocol';

const SESSION = '/session.jsonl';

function user(id: string, markdown: string): ChatMessage {
  return { id, role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown, status: 'completed' };
}

function assistant(id: string, markdown: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return { id, role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', markdown, status };
}

function readyState(running = false): ArchState {
  return {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: {
      ...initialArchState.sessions,
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
      runningSessionPaths: running ? [SESSION] : [],
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: { [SESSION]: [user('old-user', 'old'), assistant('old-assistant', 'old answer', running ? 'streaming' : 'completed')] },
    },
  };
}

function edit(state: ArchState): ReturnType<typeof reducer> {
  return reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Edit', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
      operationSource: { kind: 'renderer', rendererId: 'sidebar', rendererKind: 'vscode', rendererGeneration: 4 },
      backendGeneration: 7, sessionPath: SESSION, messageId: 'old-user', text: 'replacement',
      inputs: [], composedText: 'replacement', localId: 'replacement-local', timestamp: 10,
    },
  });
}

function ids(state: ArchState): string[] {
  return (state.transcript.bySession[SESSION] ?? []).map((message) => message.id);
}

test('edit ingress registers stable identity and emits one compound message.edit effect', () => {
  const result = edit(readyState(true));
  assert.deepEqual(result.state.operations['edit-op']?.source, {
    kind: 'renderer', rendererId: 'sidebar', rendererKind: 'vscode', rendererGeneration: 4,
  });
  assert.equal(result.state.operations['edit-op']?.attempt, 1);
  assert.equal(result.state.operations['edit-op']?.backendGeneration, 7);
  assert.deepEqual(ids(result.state), ['replacement-local']);
  assert.deepEqual(result.effects, [{
    kind: 'EditRpc', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, messageId: 'old-user', text: 'replacement',
    localId: 'replacement-local', composedText: 'replacement', inputs: [], userParts: undefined,
  }]);
});

test('edit rolls back and restores its editor only on definitive pre-destructive-commit failure', () => {
  const optimistic = edit(readyState()).state;
  const failed = reducer(optimistic, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'failed', committed: false,
    error: 'target rejected before truncate',
  });
  assert.deepEqual(ids(failed.state), ['old-user', 'old-assistant']);
  assert.equal(failed.state.transcript.editingMessageIdBySession[SESSION], 'old-user');
  assert.equal(failed.state.transcript.editingDraftBySession[SESSION]?.text, 'replacement');
  assert.equal(failed.state.operations['edit-op']?.commit, 'not-committed');
});

test('pre-commit edit cancellation restores the old tail with one cancelled terminal outcome', () => {
  const cancelled = reducer(edit(readyState()).state, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'cancelled', committed: false,
    error: 'cancelled before truncate',
  }).state;
  assert.deepEqual(ids(cancelled), ['old-user', 'old-assistant']);
  assert.equal(cancelled.operations['edit-op']?.terminal?.outcome, 'cancelled');
  assert.equal(cancelled.operations['edit-op']?.commit, 'not-committed');
});

test('post-commit edit failure keeps the optimistic replacement and never restores the old tail', () => {
  const acknowledged = reducer(edit(readyState()).state, {
    kind: 'EditResult', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, ok: true, committed: true, requestId: 'replacement-request',
  }).state;
  assert.equal(acknowledged.operations['edit-op']?.commit, 'committed');
  assert.ok(acknowledged.pending.promoted['edit-corr']);

  const failed = reducer(acknowledged, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'failed', committed: true,
    error: 'replacement preflight failed',
  }).state;
  assert.deepEqual(ids(failed), ['replacement-local']);
  assert.equal(failed.transcript.editingMessageIdBySession[SESSION], null);
  assert.equal(failed.operations['edit-op']?.terminal?.outcome, 'failed');
  assert.equal(failed.operations['edit-op']?.commit, 'committed');
  assert.equal(failed.pending.promoted['edit-corr'], undefined);
});

test('replacement abort before edit acknowledgement preserves destructive commit evidence', () => {
  const optimistic = edit(readyState()).state;
  const aborted = reducer(optimistic, {
    kind: 'MessageAborted', sessionPath: SESSION, requestId: 'replacement-request',
    operationId: 'edit-op', outcome: 'cancelled', reason: 'stopped during replacement preflight',
  }).state;
  assert.deepEqual(ids(aborted), ['replacement-local']);
  assert.equal(aborted.transcript.editingMessageIdBySession[SESSION], null);
  assert.equal(aborted.operations['edit-op']?.commit, 'committed');
  assert.equal(aborted.operations['edit-op']?.terminal?.outcome, 'failed');
  assert.equal(aborted.operations['edit-op']?.terminal?.reason, 'execution-failed');
});

test('edit acknowledgement ambiguity reconciles commit evidence and semantic start settles exactly once', () => {
  const delayed = reducer(edit(readyState()).state, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, error: 'ack lost',
  }).state;
  assert.equal(delayed.operations['edit-op']?.commit, 'unknown');
  assert.deepEqual(ids(delayed), ['replacement-local']);

  const status = reducer(delayed, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'accepted', committed: true,
    requestId: 'replacement-request',
  }).state;
  assert.equal(status.operations['edit-op']?.terminal, undefined);
  assert.equal(status.operations['edit-op']?.commit, 'committed');
  assert.equal(status.settings.notice, null, 'accepted status clears the acknowledgement-delay notice');
  const stalePrecommitStatus = reducer(status, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'accepted', committed: false,
    requestId: 'replacement-request',
  }).state;
  assert.equal(stalePrecommitStatus.operations['edit-op']?.commit, 'committed',
    'accepted observations cannot regress destructive commit evidence');

  const started = reducer(stalePrecommitStatus, {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: 'assistant-new',
    requestId: 'replacement-request', operationId: 'edit-op', operationAttempt: 1, timestamp: 20,
  }).state;
  const terminal = started.operations['edit-op']?.terminal;
  assert.equal(terminal?.outcome, 'settled');
  assert.equal(started.pending.ops['edit-corr'], undefined);

  const contradictory = reducer(started, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'failed', committed: true, error: 'late failure',
  });
  assert.equal(contradictory.state, started);
  assert.equal(contradictory.state.operations['edit-op']?.terminal, terminal);
});

test('edit reconciliation policy is reducer-owned and ignores duplicate attempt observations', () => {
  const delayed = reducer(edit(readyState()).state, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, error: 'ack lost',
  });
  assert.deepEqual(delayed.state.operations['edit-op']?.reconciliation, {
    attempts: 0, maxAttempts: 4,
  });
  assert.equal(delayed.effects[0]?.kind, 'ScheduleOperationReconciliation');
  if (delayed.effects[0]?.kind === 'ScheduleOperationReconciliation') {
    assert.equal(delayed.effects[0].reconciliationAttempt, 1);
    assert.equal(delayed.effects[0].delayMs, 0);
  }

  const pending = reducer(delayed.state, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, operationAttempt: 1,
    reconciliationAttempt: 1, state: 'pending',
  });
  assert.equal(pending.state.operations['edit-op']?.reconciliation?.attempts, 1);
  assert.equal(pending.effects[0]?.kind, 'ScheduleOperationReconciliation');
  if (pending.effects[0]?.kind === 'ScheduleOperationReconciliation') {
    assert.equal(pending.effects[0].reconciliationAttempt, 2);
    assert.equal(pending.effects[0].delayMs, 1_000);
  }

  const duplicate = reducer(pending.state, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, operationAttempt: 1,
    reconciliationAttempt: 1, state: 'failed', committed: false,
  });
  assert.strictEqual(duplicate.state, pending.state);
  assert.deepEqual(duplicate.effects, []);
});

test('replacement preflight failure before edit acknowledgement proves commit and cannot restore stale history', () => {
  const optimistic = edit(readyState()).state;
  const failed = reducer(optimistic, {
    kind: 'PreflightFailed', sessionPath: SESSION, operationId: 'edit-op',
    requestId: 'replacement-request', error: 'replacement preflight failed before edit ack',
  }).state;
  assert.deepEqual(ids(failed), ['replacement-local']);
  assert.equal(failed.transcript.editingMessageIdBySession[SESSION], null);
  assert.equal(failed.operations['edit-op']?.commit, 'committed');
  assert.equal(failed.operations['edit-op']?.terminal?.outcome, 'failed');
  assert.equal(failed.pending.ops['edit-corr'], undefined);
});

test('preflight failure cannot roll an acknowledgement-ambiguous edit back', () => {
  const acknowledged = reducer(edit(readyState()).state, {
    kind: 'EditResult', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, ok: true, requestId: 'replacement-request',
  }).state;
  const delayed = reducer(acknowledged, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const failed = reducer(delayed, {
    kind: 'PreflightFailed', sessionPath: SESSION, corrId: 'edit-corr',
    requestId: 'replacement-request', error: 'replacement preflight failed',
  }).state;
  assert.deepEqual(ids(failed), ['replacement-local']);
  assert.equal(failed.operations['edit-op']?.commit, 'unknown');
  assert.equal(failed.operations['edit-op']?.terminal?.outcome, 'failed');
});

test('stale preflight identity cannot consume or roll back the authoritative edit owner', () => {
  const optimistic = edit(readyState()).state;
  const stale = reducer(optimistic, {
    kind: 'PreflightFailed', sessionPath: SESSION, corrId: 'edit-corr', operationId: 'stale-edit-op',
    requestId: 'stale-request', error: 'late stale failure',
  });
  assert.equal(stale.state, optimistic);
  assert.deepEqual(ids(stale.state), ['replacement-local']);
  assert.ok(stale.state.pending.ops['edit-corr']);
  assert.equal(stale.state.operations['edit-op']?.terminal, undefined);
});

test('authoritative committed:false status rolls an ambiguous edit back', () => {
  const delayed = reducer(edit(readyState()).state, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const rejected = reducer(delayed, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'failed', committed: false,
    error: 'validation failed before truncate',
  }).state;
  assert.deepEqual(ids(rejected), ['old-user', 'old-assistant']);
  assert.equal(rejected.operations['edit-op']?.commit, 'not-committed');
});

test('edit retry keeps one logical operation and preserves the original rollback snapshot', () => {
  const first = edit(readyState()).state;
  const delayed = reducer(first, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const retried = reducer(delayed, {
    kind: 'Command', cmd: {
      kind: 'Edit', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 2,
      operationSource: { kind: 'renderer', rendererId: 'sidebar', rendererKind: 'vscode', rendererGeneration: 4 },
      backendGeneration: 7, sessionPath: SESSION, messageId: 'old-user', text: 'replacement',
      inputs: [], composedText: 'replacement', localId: 'replacement-local', timestamp: 10,
    },
  });
  assert.equal(retried.state.operations['edit-op']?.attempt, 2);
  assert.deepEqual(ids(retried.state), ['replacement-local']);
  assert.deepEqual(retried.state.pending.ops['edit-corr']?.removedTail?.map((message) => message.id),
    ['old-user', 'old-assistant']);
  assert.equal(retried.effects.length, 1);
  assert.equal(retried.effects[0]?.kind, 'EditRpc');
  if (retried.effects[0]?.kind === 'EditRpc') assert.equal(retried.effects[0].operationAttempt, 2);
});

test('generation death before edit commit rolls back with backend recovery provenance', () => {
  const ended = reducer(edit(readyState()).state, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'generation-ended', committed: false,
    error: 'backend exited',
  }).state;
  assert.deepEqual(ids(ended), ['old-user', 'old-assistant']);
  assert.equal(ended.operations['edit-op']?.terminal?.reason, 'backend-generation-ended');
  assert.equal(ended.operations['edit-op']?.terminal?.recovery, 'restart-backend');
  assert.equal(ended.settings.noticeKind, 'backend-exit');
});

test('generation death terminalizes an ambiguous edit once without rolling back its old tail', () => {
  const delayed = reducer(edit(readyState()).state, {
    kind: 'MessageOperationDelayed', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7,
  }).state;
  const ended = reducer(delayed, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'generation-ended', error: 'backend exited',
  }).state;
  assert.deepEqual(ids(ended), ['replacement-local']);
  assert.equal(ended.operations['edit-op']?.terminal?.reason, 'backend-generation-ended');
  assert.equal(ended.operations['edit-op']?.commit, 'unknown');

  const late = reducer(ended, {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: 'late', requestId: 'late',
    operationId: 'edit-op', timestamp: 30,
  });
  assert.equal(late.state, ended);
  assert.equal(late.state.operations['edit-op']?.terminal, ended.operations['edit-op']?.terminal);
});

test('backend exit without edit status preserves unknown commit authority and one terminal', () => {
  const optimistic = edit(readyState()).state;
  const ended = reducer(optimistic, {
    kind: 'SessionsInterrupted', sessionPaths: [SESSION], reason: 'backend exited', occurredAt: 40,
  }).state;
  assert.deepEqual(ids(ended), ['replacement-local']);
  assert.equal(ended.transcript.editingMessageIdBySession[SESSION], null);
  assert.equal(ended.operations['edit-op']?.commit, 'unknown');
  assert.equal(ended.operations['edit-op']?.terminal?.reason, 'backend-generation-ended');

  const contradictory = reducer(ended, {
    kind: 'MessageOperationStatus', operationId: 'edit-op', operationKind: 'message.edit',
    sessionPath: SESSION, backendGeneration: 7, state: 'failed', committed: false,
    error: 'late pre-commit report',
  });
  assert.equal(contradictory.state, ended);
  assert.deepEqual(ids(contradictory.state), ['replacement-local']);
});

function interrupt(state: ArchState): ReturnType<typeof reducer> {
  return reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Interrupt', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
      operationSource: { kind: 'renderer', rendererId: 'sidebar', rendererKind: 'vscode', rendererGeneration: 4 },
      backendGeneration: 7, sessionPath: SESSION,
    },
  });
}

test('capability projection deterministically gives interrupt precedence over the edit it stops', () => {
  const editing = edit(readyState(true)).state;
  const stopping = interrupt(editing).state;
  assert.equal(
    projectSessionCapabilities(stopping)[SESSION]?.primaryOperation?.kind,
    'message.interrupt',
  );
});

test('interrupt stays stopping and blocks stop-to-send until authoritative settlement', () => {
  const stopping = interrupt(readyState(true));
  assert.equal(stopping.state.operations['stop-op']?.kind, 'message.interrupt');
  assert.equal(activeInterruptOperation(stopping.state.operations, SESSION)?.operationId, 'stop-op');
  assert.ok(stopping.state.sessions.runningSessionPaths.includes(SESSION));

  const staleIdle = reducer(stopping.state, { kind: 'BusyChanged', sessionPath: SESSION, running: false });
  assert.equal(staleIdle.state, stopping.state);
  const staleRunningSnapshot = reducer(stopping.state, {
    kind: 'RunningSessionsChanged', sessionPaths: [],
  });
  assert.equal(staleRunningSnapshot.state.sessions.runningSessionPaths.includes(SESSION), true);

  const send = reducer(stopping.state, {
    kind: 'Command', cmd: {
      kind: 'Send', corrId: 'send-corr', operationId: 'send-op', operationSource: { kind: 'host' },
      backendGeneration: 7, sessionPath: SESSION, text: 'too soon', inputs: [], composedText: 'too soon',
      localId: 'too-soon', previousSummary: null, timestamp: 11,
    },
  });
  assert.equal(send.state, stopping.state);
  assert.equal(send.effects.some((effect) => effect.kind === 'SendRpc'), false);

  const settled = reducer(stopping.state, {
    kind: 'MessageOperationStatus', operationId: 'stop-op', operationKind: 'message.interrupt',
    sessionPath: SESSION, backendGeneration: 7, state: 'committed', committed: true,
    interrupted: true, settled: true,
  }).state;
  assert.equal(settled.operations['stop-op']?.terminal?.outcome, 'settled');
  assert.equal(activeInterruptOperation(settled.operations, SESSION), undefined);
  assert.equal(hasRetiredInterruptEventFence(settled.operations, SESSION), true);
  assert.equal(settled.sessions.runningSessionPaths.includes(SESSION), false);
  const staleRunningSnapshotAfterSettlement = reducer(settled, {
    kind: 'RunningSessionsChanged', sessionPaths: [SESSION],
  }).state;
  assert.equal(staleRunningSnapshotAfterSettlement.sessions.runningSessionPaths.includes(SESSION), false);
});

test('interrupt settlement tombstones the retired live turn and a correlated next turn can stream', () => {
  const semanticBase = {
    protocolVersion: 7, sessionPath: SESSION, requestId: 'old-request', turnId: 'old-turn',
    attemptId: 'old-attempt', occurredAt: 100, checkpointBytes: 1_000,
  };
  let state = reducer(readyState(true), {
    kind: 'TurnSemanticEventReceived', envelope: {
      ...semanticBase, kind: 'turn.started', seq: 1, canonicalMessageId: 'old-live', startedAt: 90,
    } satisfies TurnSemanticEnvelope,
  }).state;
  state = reducer(state, {
    kind: 'TurnSemanticEventReceived', envelope: {
      ...semanticBase, kind: 'turn.text', seq: 2, delta: 'partial',
    } satisfies TurnSemanticEnvelope,
  }).state;
  assert.equal(state.livePipeline.turnsBySession[SESSION]?.turnId, 'old-turn');

  state = interrupt(state).state;
  state = reducer(state, {
    kind: 'MessageOperationStatus', operationId: 'stop-op', operationKind: 'message.interrupt',
    sessionPath: SESSION, backendGeneration: 7, state: 'committed', committed: true,
    interrupted: true, settled: true, occurredAt: 200,
  }).state;
  assert.equal(state.livePipeline.turnsBySession[SESSION], undefined);
  assert.ok(state.livePipeline.terminalAttempts['old-turn\u0000old-attempt']);

  state = reducer(state, {
    kind: 'Command', cmd: {
      kind: 'Send', corrId: 'next-corr', operationId: 'next-op', operationSource: { kind: 'host' },
      backendGeneration: 7, sessionPath: SESSION, text: 'next', inputs: [], composedText: 'next',
      localId: 'next-local', previousSummary: null, timestamp: 210,
    },
  }).state;
  const nextBase = {
    protocolVersion: 7, sessionPath: SESSION, requestId: 'next-request', operationId: 'next-op',
    turnId: 'next-turn', attemptId: 'next-attempt', occurredAt: 220, checkpointBytes: 1_000,
  };
  state = reducer(state, {
    kind: 'TurnSemanticEventReceived', envelope: {
      ...nextBase, kind: 'turn.started', seq: 1, canonicalMessageId: 'next-message', startedAt: 215,
    } satisfies TurnSemanticEnvelope,
  }).state;
  assert.equal(state.operations['next-op']?.terminal?.outcome, 'settled');
  state = reducer(state, {
    kind: 'TurnSemanticEventReceived', envelope: {
      ...nextBase, kind: 'turn.text', seq: 2, delta: 'healthy',
    } satisfies TurnSemanticEnvelope,
  }).state;
  assert.equal(state.livePipeline.turnsBySession[SESSION]?.parts[0]?.kind, 'text');
});

test('idle interrupt is a terminal accepted no-op and late contradictory events cannot re-arm it', () => {
  const stopping = interrupt(readyState(false)).state;
  const settled = reducer(stopping, {
    kind: 'InterruptResult', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, ok: true, committed: true,
    interrupted: false, alreadyStopped: true, settled: true,
  }).state;
  const terminal = settled.operations['stop-op']?.terminal;
  assert.equal(terminal?.outcome, 'settled');

  const lateBusy = reducer(settled, { kind: 'BusyChanged', sessionPath: SESSION, running: true });
  assert.equal(lateBusy.state, settled);
  const contradictory = reducer(settled, {
    kind: 'InterruptResult', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: SESSION, ok: false, committed: false, error: 'late rejection',
  });
  assert.equal(contradictory.state, settled);
  assert.equal(contradictory.state.operations['stop-op']?.terminal, terminal);
});

test('bounded interrupt acknowledgement ambiguity unblocks with explicit restart recovery', () => {
  const stopping = interrupt(readyState(true)).state;
  const exhausted = reducer(stopping, {
    kind: 'MessageOperationStatus', operationId: 'stop-op', operationKind: 'message.interrupt',
    sessionPath: SESSION, backendGeneration: 7, state: 'reconciliation-exhausted',
    error: 'status unavailable',
  }).state;
  assert.equal(exhausted.operations['stop-op']?.terminal?.outcome, 'failed');
  assert.equal(exhausted.operations['stop-op']?.terminal?.recovery, 'restart-backend');
  assert.equal(exhausted.operations['stop-op']?.commit, 'unknown');
  assert.equal(activeInterruptOperation(exhausted.operations, SESSION), undefined);
  assert.equal(hasRetiredInterruptEventFence(exhausted.operations, SESSION), false);
  assert.equal(exhausted.sessions.runningSessionPaths.includes(SESSION), false);
});

test('interrupt generation death is terminal exactly once', () => {
  const stopping = interrupt(readyState(true)).state;
  const ended = reducer(stopping, {
    kind: 'MessageOperationStatus', operationId: 'stop-op', operationKind: 'message.interrupt',
    sessionPath: SESSION, backendGeneration: 7, state: 'generation-ended', committed: false,
    error: 'backend exited',
  }).state;
  const terminal = ended.operations['stop-op']?.terminal;
  assert.equal(terminal?.reason, 'backend-generation-ended');
  assert.equal(activeInterruptOperation(ended.operations, SESSION), undefined);

  const duplicate = reducer(ended, {
    kind: 'MessageOperationStatus', operationId: 'stop-op', operationKind: 'message.interrupt',
    sessionPath: SESSION, backendGeneration: 7, state: 'committed', committed: true,
  });
  assert.equal(duplicate.state, ended);
  assert.equal(duplicate.state.operations['stop-op']?.terminal, terminal);
});
