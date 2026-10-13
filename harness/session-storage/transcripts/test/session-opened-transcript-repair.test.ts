import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDanglingTranscript } from '../normalize-dangling-transcript';

test('inactive session reopen repairs parts-only tools without replacing authoritative terminal parts', () => {
  const terminal = { id: 'done', name: 'write', input: {}, result: 'durable', status: 'completed' as const, durableEntryId: 'result-entry' };
  const message = {
    id: 'assistant', role: 'assistant' as const, createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '', status: 'completed' as const,
    parts: [
      { kind: 'toolCall' as const, toolCall: terminal },
      { kind: 'toolCall' as const, toolCall: { id: 'pending', name: 'bash', input: {}, status: 'running' as const } },
    ],
  };
  for (const toolCalls of [undefined, [{ ...terminal, status: 'running' as const, result: undefined, durableEntryId: undefined }]]) {
    const [repaired] = normalizeDanglingTranscript([{ ...message, toolCalls }]);
    assert.equal(repaired?.status, 'interrupted');
    const done = repaired?.parts?.[0];
    const pending = repaired?.parts?.[1];
    assert.equal(done?.kind === 'toolCall' ? done.toolCall : undefined, terminal);
    assert.equal(pending?.kind === 'toolCall' ? pending.toolCall.status : undefined, 'failed');
    assert.equal(message.parts[1]?.toolCall.status, 'running', 'repair does not mutate the source');
  }
});

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