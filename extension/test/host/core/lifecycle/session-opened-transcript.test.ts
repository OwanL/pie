import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSessionOpenedTranscript } from '../../../../src/host/core/session-opened-transcript';
import type { ChatMessage, TranscriptWindow } from '../../../../src/shared/protocol';

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'completed',
  };
}

function assistantMessage(id: string, markdown: string, status: ChatMessage['status']): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status,
  };
}

function window(overrides: Partial<TranscriptWindow> = {}): TranscriptWindow {
  return {
    totalCount: 2,
    loadedStart: 0,
    loadedEnd: 2,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: true,
    ...overrides,
  };
}

test('busy session.opened keeps the local streaming transcript', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    assistantMessage('req-1:1', 'Partial reply', 'streaming'),
  ];
  const incomingTranscript = [userMessage('user-1', 'Prompt')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 1, hasNewer: true, isPartial: true }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript, localTranscript);
  assert.equal(result.transcriptWindow.loadedEnd, 2);
  assert.equal(result.transcriptWindow.hasNewer, true);
});

test('busy session.opened keeps optimistic local transcript rows when not yet persisted', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    userMessage('local:send:1', 'Prompt with attachment'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript: [userMessage('user-1', 'Prompt')],
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 1, hasNewer: true, isPartial: true }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript, localTranscript);
  assert.equal(result.transcriptWindow.loadedEnd, 2);
  assert.equal(result.transcriptWindow.hasNewer, true);
});

test('busy session.opened drops an optimistic local user row already persisted under another id', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    {
      ...userMessage('local:send:1', 'Prompt with attachment'),
      userParts: [{ kind: 'text' as const, text: 'Prompt with attachment' }],
    },
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Prompt'),
    userMessage('user-2', 'Prompt with attachment'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 2);
  assert.equal(result.transcriptWindow.loadedEnd, 2);
});

test('busy session.opened deduplicates optimistic image prompts despite metadata drift', () => {
  const localTranscript = [
    userMessage('user-1', 'Earlier prompt'),
    {
      ...userMessage('local:send:1', 'Inspect this screenshot'),
      userParts: [
        { kind: 'text' as const, text: 'Inspect this screenshot' },
        {
          kind: 'image' as const,
          mimeType: 'image/png',
          dataBase64: 'ZmFrZQ==',
          name: 'image.png',
          width: 1600,
          height: 900,
        },
      ],
    },
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Earlier prompt'),
    {
      ...userMessage('user-2', 'Inspect this screenshot'),
      userParts: [
        { kind: 'text' as const, text: 'Inspect this screenshot' },
        {
          kind: 'image' as const,
          mimeType: 'image/png',
          dataBase64: 'ZmFrZQ==',
        },
      ],
    },
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 2);
  assert.equal(result.transcriptWindow.loadedEnd, 2);
});

test('busy session.opened keeps repeated optimistic user text when the current send is not persisted', () => {
  const localTranscript = [
    userMessage('user-1', 'Repeat'),
    assistantMessage('assistant-1', 'Previous answer', 'completed'),
    userMessage('local:send:1', 'Repeat'),
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Repeat'),
    assistantMessage('assistant-1', 'Previous answer', 'completed'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 3, loadedEnd: 2, hasNewer: true, isPartial: true }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['user-1', 'assistant-1', 'local:send:1'],
  );
  assert.equal(result.transcriptWindow.loadedEnd, 3);
});

test('busy session.opened keeps local streaming rows while adopting incoming latest window metadata', () => {
  const localTranscript = [assistantMessage('req-1:1', 'Partial reply', 'streaming')];
  const incomingTranscript = [assistantMessage('assistant-5', 'Latest persisted row', 'completed')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({
      totalCount: 5,
      loadedStart: 3,
      loadedEnd: 5,
      hasOlder: true,
      hasNewer: false,
      isPartial: true,
    }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript.map((message) => message.id), ['assistant-5', 'req-1:1']);
  assert.equal(result.transcriptWindow.hasNewer, false);
  assert.equal(result.transcriptWindow.loadedEnd, 6);
});

test('busy session.opened dedupes equivalent assistant messages with different ids (regression: streaming assistant message with stable tool-call id was appended twice)', () => {
  // The local host synthesizes assistant message ids as `req-uuid:N` while
  // the SDK persists the same message under an SDK-assigned id. A
  // `session.opened` arriving mid-stream can therefore carry the persisted
  // form of a message that the local is still streaming. Both rows refer
  // to the SAME logical assistant message; merging must not produce a
  // duplicate transcript row. It must also report the alias so the reducer
  // can map later SDK-id events to the local streaming row we kept.
  const localAssistant: ChatMessage = {
    id: 'req-abc:1',
    role: 'assistant',
    createdAt: '2026-06-13T05:20:00.000Z',
    markdown: 'Let me first capture the pending question, then update the doc.',
    thinking: 'Reasoning about plan',
    status: 'streaming',
    toolCalls: [{
      id: 'call_function_xyz_1',
      name: 'ask_user',
      input: { question: 'How should the quality tolerance for cost-preference within buckets work?' },
      status: 'running' as const,
    }],
  };
  const incomingAssistant: ChatMessage = {
    id: 'session-msg-uuid-zzz',
    role: 'assistant',
    createdAt: '2026-06-13T05:20:00.000Z',
    markdown: 'Let me first capture the pending question, then update the doc.',
    thinking: 'Reasoning about plan',
    status: 'completed',
    toolCalls: [{
      id: 'call_function_xyz_1',
      name: 'ask_user',
      input: { question: 'How should the quality tolerance for cost-preference within buckets work?' },
      status: 'running' as const,
    }],
  };
  const localTranscript: ChatMessage[] = [
    userMessage('user-1', 'Earlier prompt'),
    userMessage('user-2', 'update the plans to reflect our decisions'),
    localAssistant,
  ];
  const incomingTranscript: ChatMessage[] = [
    userMessage('user-1', 'Earlier prompt'),
    userMessage('user-2', 'update the plans to reflect our decisions'),
    incomingAssistant,
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 3, loadedEnd: 3 }),
  });

  const assistantMessages = result.transcript.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1, 'expected one assistant message, not duplicates');
  // The local streaming row (with live tool-call running state) wins.
  assert.equal(assistantMessages[0]?.id, 'req-abc:1');
  assert.equal(assistantMessages[0]?.status, 'streaming');
  // The merge must expose the id alias for the reducer.
  assert.deepEqual(result.aliases, [{ aliasId: 'session-msg-uuid-zzz', canonicalId: 'req-abc:1' }]);
});

test('busy session.opened preserves messages with running tool calls', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    {
      ...assistantMessage('req-1:1', 'I will run a subagent', 'completed'),
      toolCalls: [{
        id: 'tc-1',
        name: 'subagent',
        input: { prompt: 'do something' },
        result: { streamingText: 'partial result...' },
        status: 'running' as const,
      }],
    },
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Prompt'),
    {
      ...assistantMessage('req-1:1', 'I will run a subagent', 'completed'),
      toolCalls: [],
    },
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.equal(result.preserveLocal, true);
  // Local message with running tool call should replace incoming message
  assert.equal(result.transcript.length, 2);
  assert.equal(result.transcript[1].id, 'req-1:1');
  assert.equal(result.transcript[1].toolCalls?.length, 1);
  assert.equal(result.transcript[1].toolCalls?.[0].status, 'running');
  assert.equal((result.transcript[1].toolCalls?.[0].result as any)?.streamingText, 'partial result...');
});

test('idle session.opened drops messages with running tool calls (no preserve)', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    {
      ...assistantMessage('req-1:1', 'I will run a subagent', 'completed'),
      toolCalls: [{
        id: 'tc-1',
        name: 'subagent',
        input: { prompt: 'do something' },
        result: { streamingText: 'partial result...' },
        status: 'running' as const,
      }],
    },
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Prompt'),
    {
      ...assistantMessage('req-1:1', 'I will run a subagent', 'completed'),
      toolCalls: [],
    },
  ];

  const result = resolveSessionOpenedTranscript({
    busy: false,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  // When not busy, incoming transcript should replace local, even if local has running tool calls
  assert.equal(result.preserveLocal, false);
  assert.deepEqual(result.transcript, incomingTranscript);
});

test('idle session.opened prefers the incoming transcript', () => {
  const localTranscript = [
    userMessage('user-1', 'Prompt'),
    assistantMessage('req-1:1', 'Partial reply', 'streaming'),
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Prompt'),
    assistantMessage('req-1:1', 'Final reply', 'completed'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: false,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.equal(result.preserveLocal, false);
  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.loadedEnd, 2);
});
