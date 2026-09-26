import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDanglingTranscript } from '../normalize-dangling-transcript';

test('inactive session reopen interrupts dangling tools but preserves durability-confirmed terminals', () => {
  const transcript = normalizeDanglingTranscript([{
    id: 'assistant', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '', status: 'completed',
    toolCalls: [
      { id: 'done', name: 'write', input: {}, result: 'ok', status: 'completed', durableEntryId: 'tool-result-entry' },
      { id: 'dangling', name: 'bash', input: {}, status: 'running' },
    ],
    parts: [
      { kind: 'toolCall', toolCall: { id: 'done', name: 'write', input: {}, result: 'ok', status: 'completed', durableEntryId: 'tool-result-entry' } },
      { kind: 'toolCall', toolCall: { id: 'dangling', name: 'bash', input: {}, status: 'running' } },
    ],
  }]);

  assert.equal(transcript[0]?.status, 'interrupted');
  assert.equal(transcript[0]?.toolCalls?.[0]?.status, 'completed');
  assert.equal(transcript[0]?.toolCalls?.[0]?.durableEntryId, 'tool-result-entry');
  assert.equal(transcript[0]?.toolCalls?.[1]?.status, 'failed');
  const danglingPart = transcript[0]?.parts?.[1];
  assert.equal(danglingPart?.kind === 'toolCall' ? danglingPart.toolCall.status : undefined, 'failed');
});