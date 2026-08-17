import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import { enforceLoadedWindowBudget } from '../../../../src/host/core/reducer/helpers';
import type { ChatMessage, SessionOpenedPayload, SessionSummary, TranscriptWindow } from '../../../../src/shared/protocol';

const sessionPath = '/long-session';
const editingMessageId = 'msg-490';

function message(index: number): ChatMessage {
  return {
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: `message ${index}`,
    status: 'completed',
  };
}

function window(loadedStart: number, loadedEnd: number, totalCount = 500): TranscriptWindow {
  return {
    totalCount,
    loadedStart,
    loadedEnd,
    hasOlder: loadedStart > 0,
    hasNewer: loadedEnd < totalCount,
    isPartial: loadedStart > 0 || loadedEnd < totalCount,
    hasUserMessages: true,
  };
}

const session: SessionSummary = {
  path: sessionPath,
  name: 'Long session',
  cwd: '/workspace',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 500,
  isPlaceholder: false,
};

function editingState(activeEditingMessageId = editingMessageId): ArchState {
  const transcript = Array.from({ length: 240 }, (_, offset) => message(260 + offset));
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [session],
      openTabPaths: [sessionPath],
      activeSessionPath: sessionPath,
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: { [sessionPath]: transcript },
      windowBySession: { [sessionPath]: window(260, 500) },
      editingMessageIdBySession: { [sessionPath]: activeEditingMessageId },
    },
  };
}

test('TranscriptPageLoaded cannot replace a window with one that omits the active inline editor', () => {
  const before = editingState();
  const incoming = Array.from({ length: 240 }, (_, offset) => message(220 + offset));

  const result = reducer(before, {
    kind: 'TranscriptPageLoaded',
    sessionPath,
    transcript: incoming,
    transcriptWindow: window(220, 460),
  });

  assert.strictEqual(result.state.transcript.bySession[sessionPath], before.transcript.bySession[sessionPath]);
  assert.strictEqual(result.state.transcript.windowBySession[sessionPath], before.transcript.windowBySession[sessionPath]);
  assert.deepEqual(result.state.transcript.deferredWindowReplacementBySession[sessionPath], {
    transcript: incoming,
    transcriptWindow: window(220, 460),
  });
  assert.equal(result.state.transcript.editingMessageIdBySession[sessionPath], editingMessageId);

  const cancelled = reducer(result.state, {
    kind: 'Command',
    cmd: { kind: 'SetEditingMessage', corrId: 'cancel-page-edit', sessionPath, messageId: null },
  });
  assert.deepEqual(cancelled.state.transcript.bySession[sessionPath], incoming);
  assert.deepEqual(cancelled.state.transcript.windowBySession[sessionPath], window(220, 460));
  assert.equal(cancelled.state.transcript.deferredWindowReplacementBySession[sessionPath], undefined);
});

test('Save discards a deferred replacement because the edit becomes the newer authority', () => {
  const before = editingState();
  const deferred = reducer(before, {
    kind: 'TranscriptPageLoaded',
    sessionPath,
    transcript: Array.from({ length: 240 }, (_, offset) => message(220 + offset)),
    transcriptWindow: window(220, 460),
  }).state;

  const saved = reducer(deferred, {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'save-edit',
      sessionPath,
      messageId: editingMessageId,
      text: 'replacement',
      inputs: [],
      composedText: 'replacement',
      localId: 'local:edit:replacement',
      timestamp: Date.parse('2026-01-02T00:00:00.000Z'),
    },
  });

  assert.equal(saved.state.transcript.deferredWindowReplacementBySession[sessionPath], undefined);
  assert.ok(saved.state.transcript.bySession[sessionPath].some((entry) => entry.id === 'local:edit:replacement'));
});

test('an authoritative SessionOpened tail refresh cannot omit the active inline editor', () => {
  const historicalEditingMessageId = 'msg-300';
  const before = editingState(historicalEditingMessageId);
  const incoming = Array.from({ length: 61 }, (_, offset) => message(440 + offset));
  const payload: SessionOpenedPayload = {
    session: { ...session, messageCount: 501 },
    transcript: incoming,
    transcriptWindow: window(440, 501, 501),
    busy: false,
  };

  const result = reducer(before, { kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath, payload });

  assert.strictEqual(result.state.transcript.bySession[sessionPath], before.transcript.bySession[sessionPath]);
  assert.strictEqual(result.state.transcript.windowBySession[sessionPath], before.transcript.windowBySession[sessionPath]);
  assert.deepEqual(result.state.transcript.deferredWindowReplacementBySession[sessionPath], {
    transcript: incoming,
    transcriptWindow: window(440, 501, 501),
  });
  assert.equal(result.state.transcript.editingMessageIdBySession[sessionPath], historicalEditingMessageId);

  const cancelled = reducer(result.state, {
    kind: 'Command',
    cmd: { kind: 'SetEditingMessage', corrId: 'cancel-tail-edit', sessionPath, messageId: null },
  });
  assert.deepEqual(cancelled.state.transcript.bySession[sessionPath], incoming);
  assert.deepEqual(cancelled.state.transcript.windowBySession[sessionPath], window(440, 501, 501));
  assert.equal(cancelled.state.transcript.deferredWindowReplacementBySession[sessionPath], undefined);
});

test('an authoritative shrink deferred during editing is applied on Cancel', () => {
  const before = editingState('msg-300');
  const incoming = Array.from({ length: 200 }, (_, index) => message(index));
  const incomingWindow = window(0, 200, 200);
  const result = reducer(before, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    sessionPath,
    payload: {
      session: { ...session, messageCount: 200 },
      transcript: incoming,
      transcriptWindow: incomingWindow,
      busy: false,
    },
  });

  assert.strictEqual(result.state.transcript.bySession[sessionPath], before.transcript.bySession[sessionPath]);
  const cancelled = reducer(result.state, {
    kind: 'Command',
    cmd: { kind: 'SetEditingMessage', corrId: 'cancel-after-shrink', sessionPath, messageId: null },
  });
  assert.deepEqual(cancelled.state.transcript.bySession[sessionPath], incoming);
  assert.deepEqual(cancelled.state.transcript.windowBySession[sessionPath], incomingWindow);
});

test('streaming window-budget culling retains the active inline editor row', () => {
  const state = structuredClone(editingState('msg-260'));
  state.transcript.bySession[sessionPath].push(message(500));
  state.transcript.windowBySession[sessionPath] = window(260, 501, 501);

  enforceLoadedWindowBudget(state, sessionPath);

  assert.ok(state.transcript.bySession[sessionPath].some((entry) => entry.id === 'msg-260'));
  assert.equal(state.transcript.bySession[sessionPath].length, 241);
});

test('session cleanup removes a deferred inline-edit window replacement', () => {
  const before = editingState();
  before.transcript.deferredWindowReplacementBySession[sessionPath] = {
    transcript: [message(1)],
    transcriptWindow: window(0, 1, 1),
  };

  const result = reducer(before, {
    kind: 'SessionScopeCleared',
    sessionPath,
    removeSessionSummary: false,
  });

  assert.equal(result.state.transcript.deferredWindowReplacementBySession[sessionPath], undefined);
});

test('automatic transcript paging is suppressed while an inline editor owns a local draft', () => {
  const before = editingState();
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'page-while-editing', sessionPath },
  };

  const result = reducer(before, event);

  assert.strictEqual(result.state, before);
  assert.deepEqual(result.effects, []);
});
