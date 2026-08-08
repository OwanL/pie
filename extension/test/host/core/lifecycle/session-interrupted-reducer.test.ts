/**
 * Reducer tests for the `SessionsInterrupted` event — covers the backend-exit
 * case where the PI process dies while one or more sessions are streaming.
 * No `message.aborted` event ever fires in that case (the backend is gone), so
 * `handleSessionsInterrupted` is the only thing that marks orphaned streaming
 * assistant messages `interrupted` and stamps an `errorDetail` reason so the
 * user is alerted inline in each affected tab.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { ChatMessage } from '../../../../src/shared/protocol';

function withStreamingAssistant(state: ArchState, sessionPath: string, messageId: string): ArchState {
  return produce(state, (draft) => {
    draft.transcript.bySession[sessionPath] = [
      {
        id: `${messageId}:user`,
        role: 'user',
        createdAt: '2026-07-03T10:00:00.000Z',
        markdown: 'do the thing',
        status: 'completed',
      },
      {
        id: messageId,
        role: 'assistant',
        createdAt: '2026-07-03T10:00:01.000Z',
        markdown: 'streaming…',
        status: 'streaming',
      } satisfies ChatMessage,
    ];
    draft.sessions.runningSessionPaths = Array.from(
      new Set([...draft.sessions.runningSessionPaths, sessionPath]),
    );
  });
}

test('SessionsInterrupted marks streaming assistant messages interrupted and stamps errorDetail with the reason', () => {
  const initial = withStreamingAssistant(createInitialArchState(), '/s1', 'a1');

  const { state } = reducer(initial, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s1'],
    reason: 'PI backend stopped unexpectedly (code 1)',
  });

  const list = state.transcript.bySession['/s1']!;
  const assistant = list.find((m) => m.id === 'a1')!;
  assert.equal(assistant.status, 'interrupted');
  assert.equal(assistant.errorDetail, 'PI backend stopped unexpectedly (code 1)');
});

test('SessionsInterrupted leaves completed messages untouched', () => {
  const initial = withStreamingAssistant(createInitialArchState(), '/s2', 'a2');
  // Mark the assistant message completed before the interrupt fires.
  const completed = produce(initial, (draft) => {
    draft.transcript.bySession['/s2']![1]!.status = 'completed';
  });

  const { state } = reducer(completed, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s2'],
    reason: 'PI backend stopped unexpectedly',
  });

  const assistant = state.transcript.bySession['/s2']!.find((m) => m.id === 'a2')!;
  assert.equal(assistant.status, 'completed');
  assert.equal(assistant.errorDetail, undefined);
});

test('SessionsInterrupted handles multiple affected sessions in one dispatch', () => {
  let s = createInitialArchState();
  s = withStreamingAssistant(s, '/s1', 'a1');
  s = withStreamingAssistant(s, '/s2', 'a2');

  const { state } = reducer(s, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s1', '/s2'],
    reason: 'PI backend stopped unexpectedly (code 137)',
  });

  for (const [path, id] of [['/s1', 'a1'], ['/s2', 'a2']] as const) {
    const assistant = state.transcript.bySession[path]!.find((m) => m.id === id)!;
    assert.equal(assistant.status, 'interrupted');
    assert.equal(assistant.errorDetail, 'PI backend stopped unexpectedly (code 137)');
  }
});

test('SessionsInterrupted is a no-op when no sessions are listed', () => {
  const initial = withStreamingAssistant(createInitialArchState(), '/s3', 'a3');

  const { state } = reducer(initial, {
    kind: 'SessionsInterrupted',
    sessionPaths: [],
    reason: 'unused',
  });

  const assistant = state.transcript.bySession['/s3']!.find((m) => m.id === 'a3')!;
  assert.equal(assistant.status, 'streaming', 'untouched — no session was interrupted');
  assert.equal(assistant.errorDetail, undefined);
});

test('SessionsInterrupted does not overwrite an existing errorDetail on a streaming message', () => {
  // A pre-existing errorDetail (e.g. from an earlier partial failure) should
  // not be clobbered by the generic backend-exit reason — preserve the most
  // specific detail already attached.
  const initial = produce(withStreamingAssistant(createInitialArchState(), '/s4', 'a4'), (draft) => {
    draft.transcript.bySession['/s4']![1]!.errorDetail = 'provider returned 503';
  });

  const { state } = reducer(initial, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s4'],
    reason: 'PI backend stopped unexpectedly',
  });

  const assistant = state.transcript.bySession['/s4']!.find((m) => m.id === 'a4')!;
  assert.equal(assistant.status, 'interrupted');
  assert.equal(assistant.errorDetail, 'provider returned 503');
});

test('SessionsInterrupted terminalizes tools and clears crash transients', () => {
  const initial = produce(withStreamingAssistant(createInitialArchState(), '/s6', 'a6'), (draft) => {
    draft.transcript.bySession['/s6']![1]!.toolCalls = [{ id: 't1', name: 'bash', input: {}, status: 'running' }];
    draft.sessions.retryStatusBySession['/s6'] = { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'retry' };
    draft.sessions.interruptInFlightBySession['/s6'] = true;
    draft.settings.pendingExtensionUIRequestsBySession['/s6'] = { req: { id: 'req', sessionPath: '/s6', extensionId: 'x', method: 'input', title: 'Input' } };
  });
  const { state } = reducer(initial, { kind: 'SessionsInterrupted', sessionPaths: ['/s6'], reason: 'backend exited' });
  const tool = state.transcript.bySession['/s6']![1]!.toolCalls![0]!;
  assert.equal(tool.status, 'failed');
  assert.deepEqual(tool.result, { error: 'backend exited' });
  assert.equal(state.sessions.retryStatusBySession['/s6'], undefined);
  assert.equal(state.sessions.interruptInFlightBySession['/s6'], undefined);
  assert.equal(state.settings.pendingExtensionUIRequestsBySession['/s6'], undefined);
});

test('SessionsInterrupted rolls back a pre-ack optimistic send and late rejection is a no-op', () => {
  const initial = produce(createInitialArchState(), (draft) => {
    draft.transcript.bySession['/send'] = [{ id: 'local-send', role: 'user', createdAt: 'now', markdown: 'hello', status: 'completed' }];
    draft.pending.ops['send-corr'] = {
      kind: 'send', sessionPath: '/send', localId: 'local-send', previousSummary: null,
      text: 'hello', inputs: [], startedAt: 1,
    };
  });
  const rolledBack = reducer(initial, { kind: 'SessionsInterrupted', sessionPaths: ['/send'], reason: 'backend exited' });
  assert.deepEqual(rolledBack.state.transcript.bySession['/send'], []);
  assert.equal(rolledBack.state.composer.draftTextBySession['/send'], 'hello');
  assert.equal(rolledBack.state.pending.ops['send-corr'], undefined);
  assert.equal(rolledBack.effects.some((effect) => effect.kind === 'PostImperative'), true);

  const late = reducer(rolledBack.state, { kind: 'SendResult', corrId: 'send-corr', sessionPath: '/send', ok: false, error: 'late' });
  assert.equal(late.state, rolledBack.state);
  assert.deepEqual(late.effects, []);
});

test('SessionsInterrupted restores the removed tail for a promoted optimistic edit', () => {
  const oldUser: ChatMessage = { id: 'old-user', role: 'user', createdAt: 'old', markdown: 'old', status: 'completed' };
  const oldReply: ChatMessage = { id: 'old-reply', role: 'assistant', createdAt: 'old', markdown: 'reply', status: 'completed' };
  const initial = produce(createInitialArchState(), (draft) => {
    draft.transcript.bySession['/edit'] = [{ id: 'local-edit', role: 'user', createdAt: 'now', markdown: 'new', status: 'completed' }];
    draft.pending.promoted['edit-corr'] = {
      kind: 'edit', sessionPath: '/edit', localId: 'local-edit', previousSummary: null,
      removedTail: [oldUser, oldReply], startedAt: 1, requestId: 'request-edit',
      editDraft: {
        messageId: 'old-user', text: 'submitted replacement',
        inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }],
      },
    };
  });
  const result = reducer(initial, { kind: 'SessionsInterrupted', sessionPaths: ['/edit'], reason: 'backend exited' });
  assert.deepEqual(result.state.transcript.bySession['/edit'], [oldUser, oldReply]);
  assert.equal(result.state.pending.promoted['edit-corr'], undefined);
  assert.equal(result.state.transcript.editingMessageIdBySession['/edit'], 'old-user');
  assert.deepEqual(result.state.transcript.editingDraftBySession['/edit'], {
    messageId: 'old-user', text: 'submitted replacement',
    inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }],
  });
  assert.equal(result.effects.some((effect) => effect.kind === 'PostImperative'), false);
});

test('SessionsInterrupted tombstones the active attempt and clears every pending event for the crashed session', () => {
  const base = {
    protocolVersion: 6, sessionPath: '/live', requestId: 'request',
    turnId: 'turn-active', attemptId: 'attempt-active', occurredAt: 100,
    checkpointBytes: 30 * 1024 * 1024,
  } as const;
  let state = reducer(createInitialArchState(), {
    kind: 'TurnSemanticEventReceived',
    envelope: { ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'assistant', startedAt: 90 },
  }).state;
  state = reducer(state, {
    kind: 'TurnSemanticEventReceived',
    envelope: {
      ...base, turnId: 'turn-orphan', attemptId: 'attempt-orphan',
      kind: 'turn.text', seq: 2, delta: 'late',
    },
  }).state;
  assert.equal(Object.keys(state.livePipeline.pendingOwnerEvents).length, 1);

  state = reducer(state, {
    kind: 'SessionsInterrupted', sessionPaths: ['/live'], reason: 'backend exited', occurredAt: 110,
  }).state;
  assert.equal(state.livePipeline.terminalAttempts['turn-active\u0000attempt-active']?.terminalKind, 'interrupted');
  assert.equal(state.livePipeline.terminalAttempts['turn-orphan\u0000attempt-orphan']?.terminalKind, 'interrupted');
  assert.deepEqual(state.livePipeline.pendingOwnerEvents, {});

  const late = reducer(state, {
    kind: 'TurnSemanticEventReceived',
    envelope: { ...base, occurredAt: 120, kind: 'turn.started', seq: 1, canonicalMessageId: 'revived', startedAt: 90 },
  });
  assert.equal(late.state.livePipeline.turnsBySession['/live'], undefined);
  const lateOrphan = reducer(state, {
    kind: 'TurnSemanticEventReceived',
    envelope: {
      ...base, turnId: 'turn-orphan', attemptId: 'attempt-orphan', occurredAt: 120,
      kind: 'turn.started', seq: 1, canonicalMessageId: 'revived-orphan', startedAt: 90,
    },
  });
  assert.equal(lateOrphan.state.livePipeline.turnsBySession['/live'], undefined);
});

test('SessionsInterrupted clears non-transcript crash state when no transcript is loaded', () => {
  const s = produce(createInitialArchState(), (draft) => {
    draft.sessions.interruptInFlightBySession['/s5'] = true;
    draft.sessions.retryStatusBySession['/s5'] = { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'retry' };
    draft.settings.pendingExtensionUIRequestsBySession['/s5'] = { req: { id: 'req', sessionPath: '/s5', extensionId: 'x', method: 'input', title: 'Input' } };
    draft.pending.prepassBySession['/s5'] = { phase: 'running', latencyMs: null };
  });

  const { state } = reducer(s, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s5'],
    reason: 'PI backend stopped unexpectedly',
  });

  assert.equal(state.transcript.bySession['/s5'], undefined);
  assert.equal(state.sessions.interruptInFlightBySession['/s5'], undefined);
  assert.equal(state.sessions.retryStatusBySession['/s5'], undefined);
  assert.equal(state.settings.pendingExtensionUIRequestsBySession['/s5'], undefined);
  assert.equal(state.pending.prepassBySession['/s5'], undefined);
});
