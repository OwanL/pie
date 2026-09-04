/**
 * Regression tests for edit rollback: a failed edit must restore the original
 * user message + assistant reply (and any continuation turns) that were
 * optimistically truncated when the edit was confirmed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import { restoreRemovedTail } from '../../../../src/host/core/reducer/helpers';
import { selectViewState } from '../../../../src/host/core/projection';
import type { Event } from '../../../../src/host/core/events';
import type { ChatMessage, SessionSummary, TranscriptWindow } from '../../../../src/shared/protocol';

const sessionSummary: SessionSummary = {
  path: '/s',
  name: 'Session',
  cwd: '/workspace',
  modifiedAt: new Date().toISOString(),
  messageCount: 4,
  isPlaceholder: false,
};

const fullWindow: TranscriptWindow = {
  totalCount: 4,
  loadedStart: 0,
  loadedEnd: 4,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'completed',
  };
}

function assistantMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:01.000Z',
    markdown,
    status: 'completed',
  };
}

test('reducer: Edit command optimistically truncates the original message + reply', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('older-user', 'older'),
          assistantMessage('older-assistant', 'older answer'),
          userMessage('user-1', 'original question'),
          assistantMessage('assistant-1', 'original answer'),
        ],
      },
      windowBySession: { '/s': { ...fullWindow } },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c-edit',
      sessionPath: '/s',
      messageId: 'user-1',
      text: 'edited question',
      inputs: [],
      composedText: 'edited question',
      userParts: undefined,
      localId: 'local:edit:abc',
      timestamp: 1,
    },
  };

  const result = reducer(state, event);

  // Running state set optimistically.
  assert.ok(result.state.sessions.runningSessionPaths.includes('/s'));

  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist');
  // The older prefix is preserved, the edited message + reply are gone, and
  // the optimistic replacement is appended.
  assert.equal(transcript.length, 3);
  assert.equal(transcript[0]?.id, 'older-user');
  assert.equal(transcript[1]?.id, 'older-assistant');
  assert.equal(transcript[2]?.id, 'local:edit:abc');
  assert.equal(transcript[2]?.markdown, 'edited question');

  // The pending op captures the removed tail for rollback.
  const op = result.state.pending.ops['c-edit'];
  assert.ok(op);
  assert.equal(op.kind, 'edit');
  assert.equal(op.removedTail?.length, 2);
  assert.equal(op.removedTail?.[0]?.id, 'user-1');
  assert.equal(op.removedTail?.[1]?.id, 'assistant-1');
  assert.deepEqual(op.editDraft, { messageId: 'user-1', text: 'edited question', inputs: [] });

  // EditRpc effect emitted.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'EditRpc');
  if (result.effects[0]?.kind === 'EditRpc') {
    assert.equal(result.effects[0].operationId, 'c-edit');
  }
});

test('reducer: Edit command remains one compound backend operation while running', () => {
  const result = reducer({
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      runningSessionPaths: ['/s'],
    },
  }, {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c-running-edit',
      sessionPath: '/s',
      messageId: 'user-1',
      text: 'edited question',
      inputs: [],
      composedText: 'edited question',
      userParts: undefined,
      localId: 'local:edit:running',
      timestamp: 1,
    },
  });

  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'EditRpc');
  assert.equal(result.effects.filter((effect) => effect.kind === 'EditRpc').length, 1);
});

test('restoreRemovedTail appends only missing message ids and keeps the transcript window in sync', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('older-user', 'older'),
          userMessage('user-1', 'already restored'),
        ],
      },
      windowBySession: {
        '/s': {
          ...fullWindow,
          totalCount: 2,
          loadedEnd: 2,
        },
      },
    },
  };

  restoreRemovedTail(state, '/s', [
    userMessage('user-1', 'already restored'),
    assistantMessage('assistant-1', 'restored answer'),
  ]);

  const transcript = state.transcript.bySession['/s'];
  const window = state.transcript.windowBySession['/s'];
  assert.ok(transcript);
  assert.ok(window);
  assert.deepEqual(transcript.map((message) => message.id), ['older-user', 'user-1', 'assistant-1']);
  assert.equal(new Set(transcript.map((message) => message.id)).size, transcript.length);
  assert.equal(transcript.length, window.totalCount);
});

test('reducer: edit snapshot reinstatement followed by rollback does not duplicate restored rows', () => {
  const initialState: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('older-user', 'older'),
          assistantMessage('older-assistant', 'older answer'),
          userMessage('user-1', 'original question'),
          assistantMessage('assistant-1', 'original answer'),
        ],
      },
      windowBySession: { '/s': { ...fullWindow } },
    },
  };

  const edited = reducer(initialState, {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c-snapshot-rollback',
      sessionPath: '/s',
      messageId: 'user-1',
      text: 'edited question',
      inputs: [],
      composedText: 'edited question',
      userParts: undefined,
      localId: 'local:edit:snapshot',
      timestamp: 1,
    },
  });

  const snapshot = reducer(edited.state, {
    kind: 'SessionOpened',
    backendGeneration: 0,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
    sessionPath: '/s',
    payload: {
      session: sessionSummary,
      transcript: [
        userMessage('older-user', 'older'),
        assistantMessage('older-assistant', 'older answer'),
        userMessage('user-1', 'original question'),
        assistantMessage('assistant-1', 'original answer'),
      ],
      transcriptWindow: { ...fullWindow },
      busy: false,
    },
  });

  const reinstated = snapshot.state.transcript.bySession['/s'];
  assert.ok(reinstated);
  assert.deepEqual(reinstated.map((message) => message.id), [
    'older-user',
    'older-assistant',
    'user-1',
    'assistant-1',
    'local:edit:snapshot',
  ]);

  const rolledBack = reducer(snapshot.state, {
    kind: 'EditResult',
    corrId: 'c-snapshot-rollback',
    sessionPath: '/s',
    ok: false,
    error: 'denied',
  });

  const transcript = rolledBack.state.transcript.bySession['/s'];
  const window = rolledBack.state.transcript.windowBySession['/s'];
  assert.ok(transcript);
  assert.ok(window);
  assert.deepEqual(transcript.map((message) => message.id), [
    'older-user',
    'older-assistant',
    'user-1',
    'assistant-1',
  ]);
  assert.equal(new Set(transcript.map((message) => message.id)).size, transcript.length);
  assert.equal(transcript.length, window.totalCount);
});

test('reducer: EditResult{ok:false} restores the truncated original message + reply', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
      runningSessionPaths: ['/s'],
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('older-user', 'older'),
          assistantMessage('older-assistant', 'older answer'),
          userMessage('local:edit:abc', 'edited question'),
        ],
      },
      windowBySession: {
        '/s': {
          totalCount: 3,
          loadedStart: 0,
          loadedEnd: 3,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: true,
        },
      },
    },
    pending: {
      ...initialArchState.pending,
      ops: {
        'c-edit': {
          kind: 'edit',
          sessionPath: '/s',
          localId: 'local:edit:abc',
          previousSummary: null,
          startedAt: 1,
          editDraft: { messageId: 'user-1', text: 'edited question', inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }] },
          removedTail: [
            userMessage('user-1', 'original question'),
            assistantMessage('assistant-1', 'original answer'),
          ],
        },
      },
    },
  };

  const result = reducer(state, {
    kind: 'EditResult',
    corrId: 'c-edit',
    sessionPath: '/s',
    ok: false,
    error: 'denied',
  });

  // Pending op removed.
  assert.equal(result.state.pending.ops['c-edit'], undefined);

  // Running state cleared.
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/s'));

  // Rollback restored the original conversation.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript);
  assert.equal(transcript.length, 4);
  assert.equal(transcript[0]?.id, 'older-user');
  assert.equal(transcript[1]?.id, 'older-assistant');
  assert.equal(transcript[2]?.id, 'user-1');
  assert.equal(transcript[3]?.id, 'assistant-1');

  // Optimistic edit message is gone.
  assert.ok(!transcript.some((m) => m.id === 'local:edit:abc'));

  // The original row is reopened from host-owned submitted content (not the
  // bottom-composer sendRejected imperative), including its attachments.
  assert.equal(result.state.transcript.editingMessageIdBySession['/s'], 'user-1');
  assert.deepEqual(result.state.transcript.editingDraftBySession['/s'], {
    messageId: 'user-1', text: 'edited question', inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }],
  });
  assert.deepEqual(selectViewState(result.state).editingDraft, result.state.transcript.editingDraftBySession['/s']);

  // Failure notice surfaced.
  assert.match(result.state.settings.notice!, /Couldn't edit/);
  assert.deepEqual(result.effects, []);
});

test('reducer: PreflightFailed restores the truncated original message + reply for edits', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
      runningSessionPaths: ['/s'],
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('older-user', 'older'),
          assistantMessage('older-assistant', 'older answer'),
          userMessage('local:edit:abc', 'edited question'),
        ],
      },
      windowBySession: {
        '/s': {
          totalCount: 3,
          loadedStart: 0,
          loadedEnd: 3,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: true,
        },
      },
    },
    pending: {
      ...initialArchState.pending,
      promoted: {
        'c-edit': {
          kind: 'edit',
          sessionPath: '/s',
          localId: 'local:edit:abc',
          previousSummary: null,
          startedAt: 1,
          requestId: 'req-edit',
          editDraft: { messageId: 'user-1', text: 'edited question', inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }] },
          removedTail: [
            userMessage('user-1', 'original question'),
            assistantMessage('assistant-1', 'original answer'),
          ],
        },
      },
    },
  };

  const result = reducer(state, {
    kind: 'PreflightFailed',
    corrId: 'c-edit',
    requestId: 'req-edit',
    sessionPath: '/s',
    error: 'prepass failed',
  });

  // Promoted op removed.
  assert.equal(result.state.pending.promoted['c-edit'], undefined);

  // Running state cleared.
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/s'));

  // Rollback restored the original conversation.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript);
  assert.equal(transcript.length, 4);
  assert.equal(transcript[0]?.id, 'older-user');
  assert.equal(transcript[1]?.id, 'older-assistant');
  assert.equal(transcript[2]?.id, 'user-1');
  assert.equal(transcript[3]?.id, 'assistant-1');

  // Optimistic edit message is gone.
  assert.ok(!transcript.some((m) => m.id === 'local:edit:abc'));

  assert.equal(result.state.transcript.editingMessageIdBySession['/s'], 'user-1');
  assert.deepEqual(result.state.transcript.editingDraftBySession['/s'], {
    messageId: 'user-1', text: 'edited question', inputs: [{ id: 'edited-input', kind: 'filesystemPathRef', path: '/edited', name: 'edited', source: 'picker' }],
  });

  // Failure notice surfaced as an edit failure.
  assert.match(result.state.settings.notice!, /edit/);
  assert.deepEqual(result.effects, []);
});
