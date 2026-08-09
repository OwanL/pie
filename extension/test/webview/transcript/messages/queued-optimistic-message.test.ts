import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_VIEW_STATE,
  mergeOptimisticTranscript,
  type OptimisticUserMessage,
} from '../../../../src/webview/panel/hooks/use-host-sync';
import type { ChatMessage, ViewState } from '../../../../src/shared/protocol';

const SESSION = '/workspace/session.jsonl';

function viewState(transcript: ChatMessage[]): ViewState {
  return {
    ...EMPTY_VIEW_STATE,
    activeSession: {
      path: SESSION,
      name: 'Queue test',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: transcript.length,
      isPlaceholder: false,
    },
    transcript,
  };
}

function optimistic(queued: boolean): OptimisticUserMessage {
  return {
    localId: 'local-follow-up',
    text: 'follow up',
    sessionPath: SESSION,
    queued,
  };
}

test('busy optimistic sends appear as queued rows at the transcript bottom', () => {
  const activeReply: ChatMessage = {
    id: 'assistant-live',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'working',
    status: 'streaming',
  };

  const merged = mergeOptimisticTranscript(viewState([activeReply]), [optimistic(true)]);

  assert.deepEqual(merged.map((message) => [message.id, message.status]), [
    ['assistant-live', 'streaming'],
    ['local-follow-up', 'queued'],
  ]);
});

test('idle optimistic sends retain normal completed user-row treatment', () => {
  const merged = mergeOptimisticTranscript(viewState([]), [optimistic(false)]);
  assert.equal(merged[0]?.status, 'completed');
});
