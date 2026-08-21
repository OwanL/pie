import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SessionSummary, ViewState } from '../../../src/shared/protocol';
import {
  compactRendererViewState,
  rendererSessionCatalog,
} from '../../../src/host/renderers/renderer-view-state';

const session = (path: string): SessionSummary => ({
  path,
  name: path,
  cwd: '/',
  modifiedAt: '',
  messageCount: 0,
});

test('renderer catalog includes only open, active, and deferred-trigger sessions', () => {
  const sessions = ['/old-a', '/open', '/trigger', '/old-b'].map(session);
  const selected = rendererSessionCatalog({
    sessions,
    openTabPaths: ['/open'],
    activeSession: sessions[1]!,
    deferredTriggers: [{ triggerId: 'trigger-1', sessionPath: '/trigger', kind: 'manual' } as never],
  });
  assert.deepEqual(selected.map((item) => item.path), ['/open', '/trigger']);
});

test('renderer catalog retains the first durable recovery candidate with no tabs', () => {
  const sessions = ['/recovery', '/unrelated'].map(session);
  const selected = rendererSessionCatalog({
    sessions,
    openTabPaths: [],
    activeSession: null,
    deferredTriggers: [],
  });
  assert.deepEqual(selected.map((item) => item.path), ['/recovery']);
});

test('renderer transcript omits only a proven identical flat tool mirror', () => {
  const tool = { id: 'tool-1', name: 'read', input: {}, status: 'completed' as const, result: { text: 'large' } };
  const redundant: ChatMessage = {
    id: 'assistant', role: 'assistant', createdAt: '', markdown: '', status: 'completed',
    toolCalls: [tool],
    parts: [{ kind: 'toolCall', toolCall: tool }],
  };
  const distinct = { ...tool, result: { text: 'different' } };
  const inconsistent: ChatMessage = {
    ...redundant,
    id: 'inconsistent',
    parts: [{ kind: 'toolCall', toolCall: distinct }],
  };
  const state = {
    sessions: [session('/open'), session('/old')],
    openTabPaths: ['/open'],
    activeSession: session('/open'),
    deferredTriggers: [],
    transcript: [redundant, inconsistent],
  } as unknown as ViewState;

  const compacted = compactRendererViewState(state);
  assert.equal(compacted.transcript[0]?.toolCalls, undefined);
  assert.equal(compacted.transcript[0]?.parts?.[0]?.kind, 'toolCall');
  assert.equal(compacted.transcript[1], inconsistent, 'a non-identical compatibility mirror must fail open');
  assert.deepEqual(compacted.sessions.map((item) => item.path), ['/open']);
});
