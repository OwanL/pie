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

import { createInitialArchState, type ArchState } from '../src/host/core/arch-state';
import { reducer } from '../src/host/core/reducer';
import type { ChatMessage } from '../src/shared/protocol';

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

test('SessionsInterrupted skips sessions with no transcript loaded', () => {
  const s = createInitialArchState();
  // No transcript loaded for /s5 — the reducer must not throw.

  const { state } = reducer(s, {
    kind: 'SessionsInterrupted',
    sessionPaths: ['/s5'],
    reason: 'PI backend stopped unexpectedly',
  });

  assert.equal(state.transcript.bySession['/s5'], undefined);
});
