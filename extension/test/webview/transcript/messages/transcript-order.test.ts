import test from 'node:test';
import assert from 'node:assert/strict';

import { mapTranscript, type SessionEntryLike } from '../../../../src/backend/transcript';
import { formatToolCallResultForDisplay, getRenderableSubagentResult } from '../../../../src/webview/panel/transcript';

test('mapTranscript preserves assistant part ordering from session entries', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'user-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:05.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:02.000Z'),
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolCall', id: 'tc-1', name: 'write', arguments: { path: 'a.txt' } },
          { type: 'text', text: 'after write' },
          { type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: 'a.txt' } },
          { type: 'thinking', thinking: 'done' },
        ],
      },
    },
    {
      id: 'tool-result-1',
      timestamp: '2026-01-01T00:00:05.500Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        details: { ok: true },
      },
    },
    {
      id: 'tool-result-2',
      timestamp: '2026-01-01T00:00:06.000Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-2',
        details: { ok: true },
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const assistant = transcript.find((message) => message.id === 'assistant-1');

  assert.equal(assistant?.durableEntryId, 'assistant-1');
  assert.deepEqual(
    assistant?.toolCalls?.map((toolCall) => [toolCall.id, toolCall.durableEntryId]),
    [['tc-1', 'tool-result-1'], ['tc-2', 'tool-result-2']],
    'session reopen preserves stable durability-confirmed tool-result entries',
  );

  assert.deepEqual(
    assistant?.parts?.map((part) =>
      part.kind === 'toolCall'
        ? `${part.kind}:${part.toolCall.id}:${part.toolCall.status}`
        : `${part.kind}:${part.text}`,
    ),
    [
      'reasoning:plan',
      'toolCall:tc-1:completed',
      'text:after write',
      'toolCall:tc-2:completed',
      'reasoning:done',
    ],
  );
});

test('mapTranscript attaches assistant reply metadata from session settings', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'model-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'model_change',
      modelId: 'gpt-5.4',
    },
    {
      id: 'thinking-1',
      timestamp: '2026-01-01T00:00:00.100Z',
      type: 'thinking_level_change',
      thinkingLevel: 'xhigh',
    },
    {
      id: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:02.000Z'),
        content: [
          { type: 'text', text: 'hi there' },
        ],
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const assistant = transcript.find((message) => message.id === 'assistant-1');

  assert.equal(assistant?.modelId, 'gpt-5.4');
  assert.equal(assistant?.thinkingLevel, 'xhigh');
});

test('mapTranscript preserves continuation separators in assistant parts', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'user-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
        content: [
          { type: 'text', text: 'first answer' },
        ],
      },
    },
    {
      id: 'assistant-2',
      timestamp: '2026-01-01T00:00:06.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:04.000Z'),
        content: [
          { type: 'text', text: 'second answer' },
        ],
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const assistant = transcript.find((message) => message.id === 'assistant-1');

  assert.equal(assistant?.markdown, 'first answer\n\nsecond answer');
  assert.deepEqual(
    assistant?.parts?.map((part) =>
      part.kind === 'toolCall'
        ? `${part.kind}:${part.toolCall.id}`
        : `${part.kind}:${part.text}`,
    ),
    [
      'text:first answer\n\nsecond answer',
    ],
  );
});

test('mapTranscript merges mid-turn model_change assistant segments into one bubble', () => {
  // Real sessions emit model_change entries BETWEEN assistant segments of the
  // same reply (e.g. user -> asst -> toolResult -> model_change -> asst ...).
  // Resetting the assistant bubble on model_change split one reply into many
  // panels; only the tracked model id should update, not the bubble.
  const entries: SessionEntryLike[] = [
    {
      id: 'user-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
        content: [
          { type: 'text', text: 'first' },
          { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'a.txt' } },
        ],
      },
    },
    {
      id: 'tool-result-1',
      timestamp: '2026-01-01T00:00:03.500Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-1',
        details: { ok: true },
      },
    },
    {
      id: 'model-1',
      timestamp: '2026-01-01T00:00:04.000Z',
      type: 'model_change',
      modelId: 'gpt-5.4',
    },
    {
      id: 'assistant-2',
      timestamp: '2026-01-01T00:00:06.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:04.500Z'),
        content: [
          { type: 'text', text: 'second' },
          { type: 'toolCall', id: 'tc-2', name: 'write', arguments: { path: 'b.txt' } },
        ],
      },
    },
    {
      id: 'tool-result-2',
      timestamp: '2026-01-01T00:00:06.500Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-2',
        details: { ok: true },
      },
    },
    {
      id: 'assistant-3',
      timestamp: '2026-01-01T00:00:09.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:07.000Z'),
        content: [
          { type: 'text', text: 'third' },
        ],
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const assistants = transcript.filter((message) => message.role === 'assistant');

  assert.equal(assistants.length, 1, 'mid-turn model_change must not split the reply into multiple panels');
  const assistant = assistants[0];
  assert.equal(assistant.id, 'assistant-1');
  assert.equal(assistant.markdown, 'first\n\nsecond\n\nthird');
  assert.equal(assistant.modelId, 'gpt-5.4', 'merged bubble should adopt the last segment model id');
  assert.deepEqual(
    assistant.toolCalls?.map((toolCall) => `${toolCall.id}:${toolCall.status}`),
    ['tc-1:completed', 'tc-2:completed'],
    'mid-turn toolResults following model_change must still attach to the bubble',
  );
  assert.deepEqual(
    assistant.parts?.map((part) =>
      part.kind === 'toolCall'
        ? `${part.kind}:${part.toolCall.id}:${part.toolCall.status}`
        : `${part.kind}:${part.text}`,
    ),
    [
      'text:first',
      'toolCall:tc-1:completed',
      'text:second',
      'toolCall:tc-2:completed',
      'text:third',
    ],
  );
});

test('mapTranscript keeps assistant turns separated by user messages', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'user-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
        content: [{ type: 'text', text: 'first answer' }],
      },
    },
    {
      id: 'user-2',
      timestamp: '2026-01-01T00:00:10.000Z',
      type: 'message',
      message: {
        role: 'user',
        content: 'again',
      },
    },
    {
      id: 'assistant-2',
      timestamp: '2026-01-01T00:00:13.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:11.000Z'),
        content: [{ type: 'text', text: 'second answer' }],
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const assistants = transcript.filter((message) => message.role === 'assistant');

  assert.equal(assistants.length, 2, 'turn separation by user messages must be preserved');
  assert.equal(assistants[0].markdown, 'first answer');
  assert.equal(assistants[1].markdown, 'second answer');
});

test('mapTranscript preserves subagent failure content for reopened sessions', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
        content: [
          { type: 'toolCall', id: 'tc-sub', name: 'subagent', arguments: { tasks: [{ agent: 'scout', task: 'Investigate' }] } },
        ],
      },
    },
    {
      id: 'tool-result-1',
      timestamp: '2026-01-01T00:00:03.500Z',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tc-sub',
        content: [{ type: 'text', text: 'Too many parallel tasks (6). Max is 5.' }],
        details: { mode: 'parallel', results: [] },
        isError: true,
      },
    },
  ];

  const transcript = mapTranscript(entries);
  const toolCall = transcript.find((message) => message.id === 'assistant-1')?.toolCalls?.[0];

  assert.equal(toolCall?.status, 'failed');
  assert.equal(getRenderableSubagentResult(toolCall?.result), undefined);
  assert.equal(formatToolCallResultForDisplay(toolCall as any), 'Too many parallel tasks (6). Max is 5.');
});
