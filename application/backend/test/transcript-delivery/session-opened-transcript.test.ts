import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSessionOpenedTranscript } from '../../transcript-delivery/session-opened-transcript';
import { reducer, createInitialArchState } from '../../conversation-state/reducer';
import type { ChatMessage, TranscriptWindow } from '../../../lib/protocol/index.js';
import {
  createSessionControlSender,
  formatSessionControlPrompt,
} from '../../../../harness/agent-processes/lib/rpc/session-control-attribution.js';
import { AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY } from '../../../../harness/agent-processes/workers/agent-message-provenance.js';
import { mapTranscript, type SessionEntryLike } from '../../../../harness/session-storage/transcripts/transcript.js';

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

const AGENT_SESSION_PATH = '/workspace/recipient-session.jsonl';
const AGENT_SENDER = createSessionControlSender(
  { sessionId: 'coordinator-session-id', identityFallback: false },
  'Coordinator session',
);

function hostAgentRows(messages: Array<{
  localId: string;
  text: string;
  status: 'queued' | 'completed';
  timestamp: number;
  sender?: typeof AGENT_SENDER;
}>, deliveredLocalIds: string[] = []): ChatMessage[] {
  let state = createInitialArchState();
  for (const message of messages) {
    state = reducer(state, {
      kind: 'AgentMessageReceived',
      sessionPath: AGENT_SESSION_PATH,
      ...message,
    }).state;
  }
  for (const localId of deliveredLocalIds) {
    state = reducer(state, {
      kind: 'QueuedDelivered',
      sessionPath: AGENT_SESSION_PATH,
      localId,
      text: messages.find((message) => message.localId === localId)?.text ?? '',
    }).state;
  }
  return state.transcript.bySession[AGENT_SESSION_PATH] ?? [];
}

function durableAgentEntry(id: string, text: string): { entry: SessionEntryLike; formattedModelInput: string } {
  const formattedModelInput = formatSessionControlPrompt(text, AGENT_SENDER);
  const message = Object.assign(
    {
      role: 'user' as const,
      content: formattedModelInput,
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    },
    { [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { sender: AGENT_SENDER } },
  );
  return {
    entry: {
      id,
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: message as SessionEntryLike['message'],
    },
    formattedModelInput,
  };
}

function completeWindow(count: number): TranscriptWindow {
  return window({ totalCount: count, loadedStart: 0, loadedEnd: count, hasUserMessages: count > 0 });
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

test('busy session.opened deduplicates the first optimistic user against its SDK echo', () => {
  const localTranscript = [userMessage('local:send:1', 'First prompt')];
  const incomingTranscript = [userMessage('sdk-user-1', 'First prompt')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
    localTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
  });

  assert.equal(result.preserveLocal, true);
  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 1);
});

test('busy session.opened deduplicates a first image-only optimistic user against its SDK echo', () => {
  const localTranscript = [{
    ...userMessage('local:send:image', ''),
    userParts: [{
      kind: 'image' as const,
      mimeType: 'image/png',
      dataBase64: 'ZmFrZQ==',
      name: 'screenshot.png',
      width: 1600,
      height: 900,
    }],
  }];
  const incomingTranscript = [{
    ...userMessage('sdk-user-image', ''),
    userParts: [{
      kind: 'image' as const,
      mimeType: 'image/png',
      dataBase64: 'ZmFrZQ==',
    }],
  }];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
    localTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
  });

  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 1);
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

test('busy session.opened matches distinct same-text first sends one-to-one from branch origin', () => {
  const localTranscript = [
    { ...userMessage('local:send:1', 'continue'), status: 'queued' as const },
    { ...userMessage('local:send:2', 'continue'), status: 'queued' as const },
  ];
  const incomingTranscript = [
    userMessage('sdk-continue-1', 'continue'),
    userMessage('sdk-continue-2', 'continue'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
    localTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 2);
});

test('busy session.opened leaves a queued repeated prompt local after one SDK echo', () => {
  const localTranscript = [
    { ...userMessage('local:send:1', 'continue'), status: 'queued' as const },
    { ...userMessage('local:send:2', 'continue'), status: 'queued' as const },
  ];
  const incomingTranscript = [userMessage('sdk-continue-1', 'continue')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
    localTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['sdk-continue-1', 'local:send:2'],
  );
  assert.equal(result.transcriptWindow.totalCount, 2);
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

test('busy session.opened preserves a new repeated prompt when the snapshot predates its send', () => {
  const localTranscript = [
    userMessage('host-old-user', 'continue'),
    {
      ...assistantMessage('local:assistant-old', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-old',
    },
    userMessage('local:send:new', 'continue'),
  ];
  const incomingTranscript = [
    userMessage('sdk-old-user', 'continue'),
    {
      ...assistantMessage('sdk-assistant-old', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-old',
    },
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 2, loadedEnd: 2, hasNewer: true, isPartial: true }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['sdk-old-user', 'sdk-assistant-old', 'local:send:new'],
    'the latest optimistic continue must survive a snapshot that predates its send',
  );
  assert.equal(result.transcriptWindow.totalCount, 3);
  assert.equal(result.transcriptWindow.loadedEnd, 3);
});

test('busy session.opened matches repeated optimistic users one-to-one', () => {
  const localTranscript = [
    userMessage('user-1', 'Earlier prompt'),
    {
      ...assistantMessage('assistant-1', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-1',
    },
    userMessage('local:send:1', 'continue'),
    userMessage('local:send:2', 'continue'),
  ];
  const incomingTranscript = [
    userMessage('user-1', 'Earlier prompt'),
    {
      ...assistantMessage('assistant-sdk-1', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-1',
    },
    userMessage('sdk-continue-1', 'continue'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 3, loadedEnd: 3, hasNewer: true, isPartial: true }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['user-1', 'assistant-sdk-1', 'sdk-continue-1', 'local:send:2'],
    'one incoming echo may reconcile only one of two identical local prompts',
  );
  assert.equal(result.transcriptWindow.totalCount, 4);
  assert.equal(result.transcriptWindow.loadedEnd, 4);
});

test('busy session.opened does not scan from branch origin past an unmatched completed prefix', () => {
  const localTranscript = [
    userMessage('host-old-user', 'continue'),
    userMessage('local:send:new', 'continue'),
  ];
  const incomingTranscript = [userMessage('sdk-old-user', 'continue')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
    localTranscriptWindow: window({ totalCount: 2, loadedEnd: 2 }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['sdk-old-user', 'local:send:new'],
    'an unmatched completed prefix keeps the repeated current prompt ambiguous',
  );
});

test('busy session.opened preserves ambiguity when a partial local window lacks its prefix', () => {
  const localTranscript = [userMessage('local:send:new', 'continue')];
  const incomingTranscript = [userMessage('sdk-continue', 'continue')];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({
      totalCount: 5,
      loadedStart: 4,
      loadedEnd: 5,
      hasOlder: true,
      isPartial: true,
    }),
    localTranscriptWindow: window({
      totalCount: 5,
      loadedStart: 4,
      loadedEnd: 5,
      hasOlder: true,
      isPartial: true,
    }),
  });

  assert.deepEqual(
    result.transcript.map((message) => message.id),
    ['sdk-continue', 'local:send:new'],
    'without the older prefix, same text cannot prove that the SDK row is this send',
  );
});

test('busy session.opened still deduplicates the repeated prompt when its durable echo is present', () => {
  const localTranscript = [
    userMessage('host-old-user', 'continue'),
    {
      ...assistantMessage('local:assistant-old', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-old',
    },
    userMessage('local:send:new', 'continue'),
  ];
  const incomingTranscript = [
    userMessage('sdk-old-user', 'continue'),
    {
      ...assistantMessage('sdk-assistant-old', 'Previous answer', 'completed'),
      durableEntryId: 'assistant-entry-old',
    },
    userMessage('sdk-new-user', 'continue'),
  ];

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: window({ totalCount: 3, loadedEnd: 3 }),
  });

  assert.deepEqual(result.transcript, incomingTranscript);
  assert.equal(result.transcriptWindow.totalCount, 3);
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

test('idle session.opened falls back to exact durable message id without carrying authoritative tool fields', () => {
  const localCall = {
    id: 'tool-1', name: 'local-name', input: { local: true }, result: 'local-result',
    status: 'completed' as const, parallelGroupId: 'batch-1', executionId: 'execution-1',
    startedAt: 10, durationMs: 20, seq: 3,
  };
  const incomingCall = {
    id: 'tool-1', name: 'durable-name', input: { durable: true }, result: 'durable-result',
    status: 'failed' as const,
  };
  const result = resolveSessionOpenedTranscript({
    busy: false,
    localTranscript: [{
      ...assistantMessage('assistant-1', 'local', 'completed'), renderIdentity: 'live-row',
      parts: [{ kind: 'toolCall', toolCall: localCall }], toolCalls: [localCall],
    }],
    incomingTranscript: [{
      ...assistantMessage('assistant-1', 'authoritative', 'error'),
      parts: [{ kind: 'toolCall', toolCall: incomingCall }], toolCalls: [incomingCall],
    }],
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
  });

  const message = result.transcript[0];
  const part = message?.parts?.[0];
  const call = part?.kind === 'toolCall' ? part.toolCall : undefined;
  assert.equal(message?.renderIdentity, 'live-row');
  assert.equal(message?.markdown, 'authoritative');
  assert.equal(call?.name, 'durable-name');
  assert.deepEqual(call?.input, { durable: true });
  assert.equal(call?.result, 'durable-result');
  assert.equal(call?.status, 'failed');
  assert.equal(call?.parallelGroupId, 'batch-1');
  assert.equal(call?.executionId, 'execution-1');
  assert.deepEqual(message?.toolCalls?.[0], call);
});

test('idle session.opened does not copy metadata across different durable entries sharing an id', () => {
  const result = resolveSessionOpenedTranscript({
    busy: false,
    localTranscript: [{
      ...assistantMessage('assistant-1', 'old', 'completed'), durableEntryId: 'old-entry', renderIdentity: 'old-row',
    }],
    incomingTranscript: [{
      ...assistantMessage('assistant-1', 'new', 'completed'), durableEntryId: 'new-entry',
    }],
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
  });
  assert.equal(result.transcript[0]?.renderIdentity, undefined);
});

test('session.opened restores deduplicated tool result mirrors from complete ordered parts', () => {
  const fullSubagentResult = {
    content: [{ type: 'text', text: 'child answer' }],
    details: {
      mode: 'single',
      results: [{
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'child reasoning' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
        ],
      }],
    },
  };
  const incoming: ChatMessage = {
    ...assistantMessage('assistant-with-subagent', '', 'completed'),
    parts: [{
      kind: 'toolCall',
      toolCall: {
        id: 'subagent-1',
        name: 'subagent',
        input: { task: 'inspect everything' },
        result: fullSubagentResult,
        status: 'completed',
      },
    }],
    toolCalls: [{
      id: 'subagent-1',
      name: 'subagent',
      input: { task: 'inspect everything' },
      status: 'completed',
    }],
  };

  const result = resolveSessionOpenedTranscript({
    busy: false,
    localTranscript: [],
    incomingTranscript: [incoming],
    incomingTranscriptWindow: window({ totalCount: 1, loadedEnd: 1 }),
  });

  assert.strictEqual(result.transcript[0]?.toolCalls?.[0]?.result, fullSubagentResult);
  const orderedPart = result.transcript[0]?.parts?.[0];
  assert.strictEqual(
    orderedPart?.kind === 'toolCall' ? orderedPart.toolCall.result : undefined,
    fullSubagentResult,
  );
  assert.match(JSON.stringify(result.transcript), /child reasoning/);
});

test('session.opened reconciles a direct agent send with its attributed durable SDK row', () => {
  const body = 'Inspect the recipient session';
  const durable = durableAgentEntry('sdk-direct-agent-user', body);
  const incomingTranscript = mapTranscript([durable.entry]);
  const localTranscript = hostAgentRows([{
    localId: 'local:agent-session:direct-send',
    text: body,
    status: 'completed',
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    sender: AGENT_SENDER,
  }]);

  assert.equal(durable.entry.message?.content, durable.formattedModelInput,
    'the SDK model input retains the authenticated wrapper verbatim');
  assert.equal(incomingTranscript[0]?.markdown, body,
    'only the display row omits the authenticated envelope; the SDK input stays intact');
  assert.deepEqual(incomingTranscript[0]?.sender, AGENT_SENDER);
  assert.deepEqual(localTranscript[0]?.sender, AGENT_SENDER);

  const result = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript,
    incomingTranscriptWindow: completeWindow(1),
    localTranscriptWindow: completeWindow(1),
  });

  assert.deepEqual(result.transcript.map((message) => message.id), ['sdk-direct-agent-user']);
  assert.deepEqual(result.transcript[0]?.sender, AGENT_SENDER);
  assert.equal(result.transcript[0]?.markdown, body);
});

test('session.opened preserves a queued agent row before delivery and deduplicates its durable echo', () => {
  const body = 'Summarize the changed files';
  const localId = 'local:agent-session:queued-send';
  const queuedMessages = [{
    localId,
    text: body,
    status: 'queued' as const,
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    sender: AGENT_SENDER,
  }];
  const queuedLocalTranscript = hostAgentRows(queuedMessages);
  const beforeDelivery = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript: queuedLocalTranscript,
    incomingTranscript: [],
    incomingTranscriptWindow: completeWindow(0),
    localTranscriptWindow: completeWindow(1),
  });

  assert.deepEqual(beforeDelivery.transcript, queuedLocalTranscript,
    'an accepted queued message remains visible until the SDK delivers it');
  assert.deepEqual(beforeDelivery.transcript[0]?.sender, AGENT_SENDER);

  const durable = durableAgentEntry('sdk-queued-agent-user', body);
  const incomingTranscript = mapTranscript([durable.entry]);
  const deliveredLocalTranscript = hostAgentRows(queuedMessages, [localId]);
  assert.equal(durable.entry.message?.content, durable.formattedModelInput);
  assert.equal(incomingTranscript[0]?.markdown, body);
  assert.deepEqual(incomingTranscript[0]?.sender, AGENT_SENDER);
  assert.deepEqual(deliveredLocalTranscript[0]?.sender, AGENT_SENDER);
  assert.equal(deliveredLocalTranscript[0]?.status, 'completed');

  const afterDelivery = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript: deliveredLocalTranscript,
    incomingTranscript,
    incomingTranscriptWindow: completeWindow(1),
    localTranscriptWindow: completeWindow(1),
  });

  assert.deepEqual(afterDelivery.transcript.map((message) => message.id), ['sdk-queued-agent-user']);
  assert.deepEqual(afterDelivery.transcript[0]?.sender, AGENT_SENDER);
  assert.equal(afterDelivery.transcript[0]?.markdown, body);
});

test('idle SessionOpened replaces all four optimistic agent cards with their displayed SDK echoes', () => {
  const bodies = ['Initial instruction', 'Wait then continue', 'Queued marker', 'Reply-reference instruction'];
  const durable = bodies.map((body, index) => durableAgentEntry(`sdk-agent-${index}`, body));
  const entries = durable.map(({ entry, formattedModelInput }) => ({
    ...entry,
    message: { ...entry.message, role: 'user' as const, content: [{ type: 'text', text: formattedModelInput }] },
  }));
  const incomingTranscript = mapTranscript(entries);
  const state = createInitialArchState();
  state.transcript.bySession[AGENT_SESSION_PATH] = hostAgentRows(bodies.map((text, index) => ({
    localId: `local:agent-session:card-${index}`, text, status: 'completed',
    timestamp: Date.parse('2026-01-01T00:00:00.000Z') + index, sender: AGENT_SENDER,
  })));
  state.transcript.windowBySession[AGENT_SESSION_PATH] = completeWindow(bodies.length);

  const opened = reducer(state, {
    kind: 'SessionOpened', sessionPath: AGENT_SESSION_PATH,
    backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    payload: {
      session: { path: AGENT_SESSION_PATH, name: 'Recipient', cwd: '/workspace', modifiedAt: '', messageCount: bodies.length },
      busy: false, transcript: incomingTranscript, transcriptWindow: completeWindow(bodies.length),
    },
  }).state;
  const rows = opened.transcript.bySession[AGENT_SESSION_PATH] ?? [];

  assert.deepEqual(rows.map((row) => row.id), durable.map(({ entry }) => entry.id));
  assert.deepEqual(rows.map((row) => row.markdown), bodies);
  assert.deepEqual(rows.map((row) => row.sender), bodies.map(() => AGENT_SENDER));
  assert.deepEqual(entries.map((entry) => entry.message.content[0]?.text),
    durable.map(({ formattedModelInput }) => formattedModelInput), 'SDK model input is unchanged');
});

test('session.opened reconciles identical agent prompts one-to-one without collapsing either send', () => {
  const body = 'Continue with the next item';
  const localMessages = [1, 2].map((sequence) => ({
    localId: `local:agent-session:repeat-${sequence}`,
    text: body,
    status: 'completed' as const,
    timestamp: Date.parse('2026-01-01T00:00:00.000Z') + sequence,
    sender: AGENT_SENDER,
  }));
  const localTranscript = hostAgentRows(localMessages);
  const firstDurable = durableAgentEntry('sdk-repeat-agent-user-1', body);
  const secondDurable = durableAgentEntry('sdk-repeat-agent-user-2', body);
  const firstEcho = mapTranscript([firstDurable.entry]);
  const bothEchoes = mapTranscript([firstDurable.entry, secondDurable.entry]);

  assert.equal(firstDurable.entry.message?.content, firstDurable.formattedModelInput);
  assert.equal(secondDurable.entry.message?.content, secondDurable.formattedModelInput);
  assert.deepEqual(firstEcho[0]?.sender, AGENT_SENDER);
  assert.deepEqual(bothEchoes.map((message) => message.markdown), [body, body]);
  assert.deepEqual(localTranscript.map((message) => message.sender), [AGENT_SENDER, AGENT_SENDER]);

  const afterOneEcho = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript: firstEcho,
    incomingTranscriptWindow: completeWindow(1),
    localTranscriptWindow: completeWindow(2),
  });
  assert.deepEqual(afterOneEcho.transcript.map((message) => message.id), [
    'sdk-repeat-agent-user-1',
    'local:agent-session:repeat-2',
  ], 'one SDK echo reconciles only one of two same-text sends');
  assert.deepEqual(afterOneEcho.transcript.map((message) => message.sender), [AGENT_SENDER, AGENT_SENDER]);

  const afterBothEchoes = resolveSessionOpenedTranscript({
    busy: true,
    localTranscript,
    incomingTranscript: bothEchoes,
    incomingTranscriptWindow: completeWindow(2),
    localTranscriptWindow: completeWindow(2),
  });
  assert.deepEqual(afterBothEchoes.transcript.map((message) => message.id), [
    'sdk-repeat-agent-user-1',
    'sdk-repeat-agent-user-2',
  ]);
  assert.deepEqual(afterBothEchoes.transcript.map((message) => message.sender), [AGENT_SENDER, AGENT_SENDER]);
  assert.deepEqual(afterBothEchoes.transcript.map((message) => message.markdown), [body, body]);
  assert.equal(firstDurable.entry.message?.content, firstDurable.formattedModelInput,
    'reconciliation must not rewrite the first durable model input');
  assert.equal(secondDurable.entry.message?.content, secondDurable.formattedModelInput,
    'reconciliation must not rewrite the second durable model input');
});
