import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addAssistantUsage,
  appendAssistantParts,
  applyToolResultToParts,
  assistantPartsFromContent,
  assistantStatus,
  isoDate,
  normalizeThinkingLevel,
  systemMessage,
  textFromParts,
  thinkingFromParts,
  usageFromMessage,
  userPartsFromContent,
} from '../../../src/backend/transcript/content';
import type { ChatMessage, ChatMessagePart } from '../../../src/shared/protocol';
import { mapAssistantMessage, mapTranscript, type SessionEntryLike } from '../../../src/backend/transcript';
import type { ContentPart, MessageLike } from '../../../src/backend/transcript/types';

function assistantTarget(parts?: ChatMessagePart[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    status: 'streaming',
    parts,
  };
}

test('isoDate prefers message timestamps and part extractors ignore missing fields', () => {
  const fromMessageTimestamp = isoDate('2026-01-01T00:00:00.000Z', Date.UTC(2026, 0, 2));
  const fromEntryTimestamp = isoDate('2026-01-03T00:00:00.000Z');
  const parts: ContentPart[] = [
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'trace' },
    { type: 'text', text: ' world' },
    { type: 'thinking', thinking: ' more' },
    { type: 'image', data: 'ignored' },
  ];

  assert.equal(fromMessageTimestamp, '2026-01-02T00:00:00.000Z');
  assert.equal(fromEntryTimestamp, '2026-01-03T00:00:00.000Z');
  assert.equal(textFromParts(parts), 'hello world');
  assert.equal(textFromParts(undefined), '');
  assert.equal(thinkingFromParts(parts), 'trace more');
  assert.equal(thinkingFromParts(undefined), undefined);
});

test('userPartsFromContent lowers text and valid image parts only', () => {
  const parts = userPartsFromContent([
    { type: 'text', text: 'Inspect this screenshot' },
    { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png', name: 'shot.png', width: 100, height: 50 },
    { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'image', data: 'abc', mimeType: '' },
  ]);

  assert.deepEqual(parts, [
    { kind: 'text', text: 'Inspect this screenshot' },
    { kind: 'image', dataBase64: 'ZmFrZQ==', mimeType: 'image/png', name: 'shot.png', width: 100, height: 50 },
  ]);
  assert.equal(userPartsFromContent('plain text'), undefined);
});

test('normalizeThinkingLevel accepts known values and rejects unknown ones', () => {
  assert.equal(normalizeThinkingLevel('high'), 'high');
  assert.equal(normalizeThinkingLevel('xhigh'), 'xhigh');
  assert.equal(normalizeThinkingLevel('max'), undefined);
  assert.equal(normalizeThinkingLevel(undefined), undefined);
});

test('assistantPartsFromContent builds ordered assistant parts and returns undefined when empty', () => {
  const parts = assistantPartsFromContent([
    { type: 'text', text: 'alpha' },
    { type: 'text', text: ' beta' },
    { type: 'thinking', thinking: 'reason' },
    { type: 'thinking', thinking: 'ing' },
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'ls' } },
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
  ], 'completed');

  assert.deepEqual(parts, [
    { kind: 'text', text: 'alpha beta' },
    { kind: 'reasoning', text: 'reasoning' },
    { kind: 'toolCall', toolCall: { id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'completed' } },
  ]);
  assert.equal(assistantPartsFromContent(undefined), undefined);
  assert.equal(assistantPartsFromContent([{ type: 'image', data: 'abc' }]), undefined);
});

test('appendAssistantParts preserves boundaries when requested and tool results update in place', () => {
  const target = assistantTarget([{ kind: 'text', text: 'existing' }]);

  appendAssistantParts(target, [
    { kind: 'text', text: 'next' },
    { kind: 'reasoning', text: 'think' },
    { kind: 'toolCall', toolCall: { id: 'tool-1', name: 'read', input: { path: 'README.md' }, status: 'running' } },
    { kind: 'text', text: 'after tool' },
  ], true);

  assert.deepEqual(target.parts, [
    { kind: 'text', text: 'existing\n\nnext' },
    { kind: 'reasoning', text: 'think' },
    { kind: 'toolCall', toolCall: { id: 'tool-1', name: 'read', input: { path: 'README.md' }, status: 'running' } },
    { kind: 'text', text: 'after tool' },
  ]);

  applyToolResultToParts(target.parts, 'tool-1', { ok: true }, 'completed');
  assert.deepEqual((target.parts?.[2] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall.result, { ok: true });
  assert.equal((target.parts?.[2] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall.status, 'completed');

  applyToolResultToParts(target.parts, undefined, 'ignored', 'failed');
  applyToolResultToParts(undefined, 'tool-1', 'ignored', 'failed');
  applyToolResultToParts(target.parts, 'missing', 'ignored', 'failed');
});

test('usageFromMessage preserves reasoning as an output subset without double-counting it', () => {
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1_000,
      total_tokens: 1_100,
      completion_tokens_details: { reasoning_tokens: 800 },
    },
  }), {
    inputTokens: 100,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_100,
    reasoningTokens: 800,
  });

  const clamped = usageFromMessage({
    role: 'assistant',
    usage: { input: 10, output: 20, reasoning_tokens: 50 },
  });
  assert.equal(clamped?.reasoningTokens, 20);
  assert.equal(clamped?.totalTokens, 30, 'reasoning is already included in output');

  assert.deepEqual(addAssistantUsage(
    { inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11, reasoningTokens: 7 },
    { inputTokens: 2, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7, reasoningTokens: 3 },
  ), {
    inputTokens: 3,
    outputTokens: 15,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 18,
    reasoningTokens: 10,
  });
});

test('assistantStatus, usage helpers, and systemMessage normalize edge cases', () => {
  const aborted: MessageLike = { role: 'assistant', stopReason: 'aborted' };
  const errored: MessageLike = { role: 'assistant', stopReason: 'error' };
  const withErrorMessage: MessageLike = { role: 'assistant', errorMessage: 'bad' };
  const completed: MessageLike = { role: 'assistant' };

  assert.equal(assistantStatus(aborted), 'interrupted');
  assert.equal(assistantStatus(errored), 'error');
  assert.equal(assistantStatus(withErrorMessage), 'error');
  assert.equal(assistantStatus(completed), 'completed');

  assert.equal(usageFromMessage({ role: 'assistant' }), undefined);
  assert.equal(usageFromMessage({ role: 'assistant', usage: { input: -1, output: Number.NaN, totalTokens: 0 } }), undefined);
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: { input: 2.9, output: 3.2, cacheRead: 1.8, cacheWrite: 0.4, totalTokens: 99.7 },
  }), {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    totalTokens: 99,
  });
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
  }), {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 4,
    totalTokens: 10,
  });
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: {
        cached_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    },
  }), {
    inputTokens: 3,
    outputTokens: 7,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    totalTokens: 18,
  });
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    },
  }), {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    totalTokens: 160,
  });
  assert.deepEqual(usageFromMessage({
    role: 'assistant',
    usage: { prompt_eval_count: 13, eval_count: 4 },
  }), {
    inputTokens: 13,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 17,
  });

  assert.deepEqual(addAssistantUsage(undefined, undefined), undefined);
  assert.deepEqual(addAssistantUsage(undefined, {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
  }), {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
  });
  assert.deepEqual(addAssistantUsage({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 3,
  }, {
    inputTokens: 4,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    totalTokens: 12,
  }), {
    inputTokens: 5,
    outputTokens: 7,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    totalTokens: 15,
  });

  assert.deepEqual(systemMessage('system-1', '2026-01-01T00:00:00.000Z', 'hello'), {
    id: 'system-1',
    role: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hello',
    status: 'completed',
  });
});

test('assistant transcript mapping surfaces WebSocket phase and automatic SSE recovery', () => {
  const mapped = mapAssistantMessage('assistant-ws', {
    role: 'assistant',
    provider: 'openai-codex',
    model: 'gpt-test',
    stopReason: 'error',
    errorMessage: 'WebSocket closed 1000',
    content: [],
    diagnostics: [{
      type: 'provider_transport_failure',
      timestamp: 1,
      error: { name: 'WebSocketCloseError', message: 'WebSocket closed 1000', code: 1000 },
      details: {
        configuredTransport: 'auto',
        eventsEmitted: true,
        phase: 'after_message_stream_start',
        requestBytes: 525_643,
      },
    }],
  });

  assert.equal(
    mapped.errorDetail,
    'WebSocket closed 1000. WebSocket transport failed after output began (configured: auto; request: 513.3 KiB; close code: 1000). If this turn is retried, it and later requests for this session will use SSE.',
  );

  const beforeStart = mapAssistantMessage('assistant-ws-before-start', {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'SSE fallback also failed',
    content: [],
    diagnostics: [{
      type: 'provider_transport_failure',
      details: {
        configuredTransport: 'auto',
        fallbackTransport: 'sse',
        eventsEmitted: false,
        phase: 'before_message_stream_start',
        requestBytes: 512,
      },
    }],
  });
  assert.equal(
    beforeStart.errorDetail,
    'SSE fallback also failed. WebSocket transport failed before output began (configured: auto; request: 512 B). SSE fallback was attempted.',
  );
});

test('assistant transcript mapping preserves the serving provider', () => {
  const mapped = mapAssistantMessage('assistant-1', {
    role: 'assistant',
    provider: 'openai-codex',
    model: 'shared-model',
    content: [{ type: 'text', text: 'done' }],
  });
  assert.equal(mapped.provider, 'openai-codex');

  const entries: SessionEntryLike[] = [{
    id: 'assistant-2',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'github-copilot',
      model: 'shared-model',
      content: [{ type: 'text', text: 'persisted' }],
    },
  }];
  assert.equal(mapTranscript(entries)[0]?.provider, 'github-copilot');
});
