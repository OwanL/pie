import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAssistantTextPart,
  assistantPartsFromMessage,
  cloneMessagePart,
  cloneToolCall,
  legacyAssistantParts,
  mergeAssistantParts,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
  upsertAssistantToolPart,
} from '../../../src/shared/chat-message-parts';
import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'read',
    input: { path: '/repo/README.md' },
    status: 'running',
    ...overrides,
  };
}

function makeAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'assistant text',
    status: 'completed',
    ...overrides,
  };
}

test('clone helpers return independent copies for tool-call and text parts', () => {
  const toolCall = makeToolCall({ result: { ok: true } });
  const textPart: ChatMessagePart = { kind: 'text', text: 'hello' };
  const toolPart: ChatMessagePart = { kind: 'toolCall', toolCall };

  const clonedTool = cloneToolCall(toolCall);
  const clonedTextPart = cloneMessagePart(textPart);
  const clonedToolPart = cloneMessagePart(toolPart);

  assert.deepEqual(clonedTool, toolCall);
  assert.notStrictEqual(clonedTool, toolCall);
  assert.deepEqual(clonedTextPart, textPart);
  assert.notStrictEqual(clonedTextPart, textPart);
  assert.deepEqual(clonedToolPart, toolPart);
  assert.notStrictEqual(clonedToolPart, toolPart);
  assert.notStrictEqual(clonedToolPart.toolCall, toolCall);
});

test('appendAssistantTextPart merges contiguous parts of the same kind and ignores empty text', () => {
  const parts: ChatMessagePart[] = [];

  appendAssistantTextPart(parts, 'text', 'hello');
  appendAssistantTextPart(parts, 'text', ' world');
  appendAssistantTextPart(parts, 'reasoning', 'think');
  appendAssistantTextPart(parts, 'reasoning', ' harder');
  appendAssistantTextPart(parts, 'text', '');

  assert.deepEqual(parts, [
    { kind: 'text', text: 'hello world' },
    { kind: 'reasoning', text: 'think harder' },
  ]);
});

test('upsertAssistantToolPart appends new tool calls and replaces existing ids', () => {
  const parts: ChatMessagePart[] = [
    { kind: 'text', text: 'before' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', status: 'running' }) },
  ];

  upsertAssistantToolPart(parts, makeToolCall({ id: 'tool-2', name: 'bash' }));
  upsertAssistantToolPart(parts, makeToolCall({ id: 'tool-1', status: 'completed', result: { ok: true } }));

  assert.equal(parts.length, 3);
  const updated = parts[1] as Extract<ChatMessagePart, { kind: 'toolCall' }>;
  assert.equal(updated.toolCall.status, 'completed');
  assert.deepEqual(updated.toolCall.result, { ok: true });
  const appended = parts[2] as Extract<ChatMessagePart, { kind: 'toolCall' }>;
  assert.equal(appended.toolCall.id, 'tool-2');
});

test('upsertAssistantToolPart preserves previous input when an update has no meaningful input', () => {
  const parts: ChatMessagePart[] = [
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', input: { command: 'ls -la' }, status: 'running' }) },
  ];

  upsertAssistantToolPart(parts, { id: 'tool-1', name: 'bash', input: {}, status: 'running' });

  assert.equal(parts.length, 1);
  const updated = parts[0] as Extract<ChatMessagePart, { kind: 'toolCall' }>;
  assert.deepEqual(updated.toolCall.input, { command: 'ls -la' });
  assert.equal(updated.toolCall.status, 'running');
});

test('upsertAssistantToolPart replaces previous input when the update carries real arguments', () => {
  const parts: ChatMessagePart[] = [
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', input: { command: 'ls' }, status: 'running' }) },
  ];

  upsertAssistantToolPart(parts, { id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'running' });

  const updated = parts[0] as Extract<ChatMessagePart, { kind: 'toolCall' }>;
  assert.deepEqual(updated.toolCall.input, { command: 'pwd' });
});

test('legacyAssistantParts preserves reasoning, tool call ordering, and markdown text', () => {
  const message = makeAssistantMessage({
    markdown: 'final answer',
    thinking: 'step by step',
    toolCalls: [makeToolCall({ id: 'tool-a' }), makeToolCall({ id: 'tool-b', name: 'bash' })],
  });

  const parts = legacyAssistantParts(message);

  assert.deepEqual(parts, [
    { kind: 'reasoning', text: 'step by step' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-a' }) },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-b', name: 'bash' }) },
    { kind: 'text', text: 'final answer' },
  ]);
});

test('assistantPartsFromMessage returns explicit assistant parts, legacy fallback, or undefined', () => {
  const explicitParts: ChatMessagePart[] = [{ kind: 'text', text: 'explicit' }];
  const explicit = assistantPartsFromMessage(makeAssistantMessage({ parts: explicitParts }));
  const legacy = assistantPartsFromMessage(makeAssistantMessage({ parts: [], markdown: 'legacy' }));
  const userResult = assistantPartsFromMessage({
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'user text',
    status: 'completed',
  });

  assert.strictEqual(explicit, explicitParts);
  assert.deepEqual(legacy, [{ kind: 'text', text: 'legacy' }]);
  assert.equal(userResult, undefined);
});

test('mergeAssistantParts merges text/reasoning segments and upserts tool results', () => {
  const baseParts: ChatMessagePart[] = [
    { kind: 'text', text: 'alpha' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', status: 'running' }) },
    { kind: 'reasoning', text: 'think' },
  ];
  const appendedParts: ChatMessagePart[] = [
    { kind: 'text', text: ' beta' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', status: 'completed', result: 'done' }) },
    { kind: 'reasoning', text: ' more' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-2', name: 'bash' }) },
  ];

  const merged = mergeAssistantParts(baseParts, appendedParts);

  assert.deepEqual(merged, [
    { kind: 'text', text: 'alpha' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-1', status: 'completed', result: 'done' }) },
    { kind: 'reasoning', text: 'think' },
    { kind: 'text', text: ' beta' },
    { kind: 'reasoning', text: ' more' },
    { kind: 'toolCall', toolCall: makeToolCall({ id: 'tool-2', name: 'bash' }) },
  ]);
  assert.notStrictEqual((merged?.[1] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall, (baseParts[1] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall);
  assert.equal(mergeAssistantParts(undefined, undefined), undefined);
});

test('message-part extractors return text, reasoning, and cloned tool calls', () => {
  const originalToolCall = makeToolCall({ id: 'tool-extract', status: 'completed' });
  const parts: ChatMessagePart[] = [
    { kind: 'text', text: 'hello' },
    { kind: 'reasoning', text: 'trace' },
    { kind: 'text', text: ' world' },
    { kind: 'toolCall', toolCall: originalToolCall },
    { kind: 'reasoning', text: ' more' },
  ];

  const toolCalls = toolCallsFromMessageParts(parts);

  assert.equal(textFromMessageParts(parts), 'hello world');
  assert.equal(reasoningFromMessageParts(parts), 'trace more');
  assert.deepEqual(toolCalls, [originalToolCall]);
  assert.notStrictEqual(toolCalls?.[0], originalToolCall);
  assert.equal(textFromMessageParts(undefined), '');
  assert.equal(reasoningFromMessageParts(undefined), undefined);
  assert.equal(toolCallsFromMessageParts(undefined), undefined);
});
