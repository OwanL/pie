import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../lib/protocol/messages.js';
import { estimateLiveAssistantOutputTokens } from '../../../lib/analytics/live-output-tokens.js';
import { estimateTextTokens } from '../../../../lib/token-estimation.js';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    status: 'streaming',
    ...overrides,
  };
}

test('live output estimate counts visible fields and current tool-call drafts only', () => {
  const current = message({
    markdown: 'reply text',
    thinking: 'reasoning text',
    toolCalls: [
      { id: 'draft', name: 'bash', input: {}, argumentsText: '{"cmd":"ls"}', status: 'drafting' },
      { id: 'ready', name: 'read', input: 'file.txt', status: 'ready' },
      { id: 'done', name: 'completed', input: 'ignored', status: 'completed' },
    ],
    draftingToolCall: { id: 'draft', name: 'bash', argumentsText: '{"cmd":"ls"}' },
  });

  assert.equal(
    estimateLiveAssistantOutputTokens(current),
    estimateTextTokens('reply text')
      + estimateTextTokens('reasoning text')
      + estimateTextTokens('bash')
      + estimateTextTokens('{"cmd":"ls"}')
      + estimateTextTokens('read')
      + estimateTextTokens('file.txt'),
  );
  assert.equal(estimateLiveAssistantOutputTokens(null), 0);
});

test('long visible fields preserve the token-rate tail-density estimate', () => {
  const text = `${'prefix '.repeat(1_400)}${'tail wording '.repeat(1_400)}`;
  const tail = text.slice(-8_192);
  const expected = Math.round(estimateTextTokens(tail) * (text.length / tail.length));

  assert.equal(estimateLiveAssistantOutputTokens(message({ markdown: text })), expected);
});
