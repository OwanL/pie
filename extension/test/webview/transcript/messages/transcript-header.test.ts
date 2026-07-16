import test from 'node:test';
import assert from 'node:assert/strict';

import { assistantReplyMeta, formatThinkingLevelLabel, formatAssistantMetaTooltip, formatRequestTime } from '../../../../src/webview/panel/transcript/header';
import type { ChatMessage } from '../../../../src/shared/protocol';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Reply',
    status: 'completed',
    ...overrides,
  };
}

test('formatRequestTime renders valid request timestamps in local time', () => {
  const createdAt = '2026-01-01T12:34:56.000Z';
  const requestedAt = new Date(createdAt);

  assert.deepEqual(formatRequestTime(createdAt), {
    compactText: requestedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    title: `Request made ${requestedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}`,
  });
  assert.equal(formatRequestTime('not-a-date'), null);
  assert.equal(formatRequestTime(undefined), null);
});

test('assistantReplyMeta returns compact inline assistant metadata', () => {
  const meta = assistantReplyMeta(assistantMessage({
    modelId: 'claude-sonnet-4.6',
    thinkingLevel: 'high',
  }));

  assert.deepEqual(meta, {
    model: 'claude-sonnet-4.6',
    reasoning: 'high',
    compactText: 'claude-sonnet-4.6 high',
  });
});

test('assistantReplyMeta omits missing pieces instead of rendering placeholders', () => {
  assert.deepEqual(
    assistantReplyMeta(assistantMessage({ modelId: 'claude-sonnet-4.6' })),
    {
      model: 'claude-sonnet-4.6',
      reasoning: null,
      compactText: 'claude-sonnet-4.6',
    },
  );

  assert.deepEqual(
    assistantReplyMeta(assistantMessage({ thinkingLevel: 'xhigh' })),
    {
      model: null,
      reasoning: 'max',
      compactText: 'max',
    },
  );
});

test('assistantReplyMeta returns null when no assistant header metadata exists', () => {
  assert.equal(assistantReplyMeta(assistantMessage()), null);
  assert.equal(
    assistantReplyMeta({
      id: 'user-1',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Prompt',
      status: 'completed',
      modelId: 'claude-sonnet-4.6',
      thinkingLevel: 'high',
    }),
    null,
  );
});

test('formatThinkingLevelLabel uses lower-case compact transcript labels', () => {
  assert.equal(formatThinkingLevelLabel('minimal'), 'minimal');
  assert.equal(formatThinkingLevelLabel('high'), 'high');
  assert.equal(formatThinkingLevelLabel('xhigh'), 'max');
  assert.equal(formatThinkingLevelLabel(undefined), null);
});

test('formatAssistantMetaTooltip surfaces token usage and duration for hover', () => {
  const tooltip = formatAssistantMetaTooltip(assistantMessage({
    durationMs: 4200,
    usage: {
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 1801,
    },
  }));

  assert.ok(tooltip);
  assert.match(tooltip, /Tokens — in 1,234 · out 567 · total 1,801/);
  assert.match(tooltip, /Cache — read 100 · write 50/);
  assert.match(tooltip, /Duration — 4\.2s/);
});

test('formatAssistantMetaTooltip omits the cache line when no cache tokens are used', () => {
  const tooltip = formatAssistantMetaTooltip(assistantMessage({
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
    },
  }));

  assert.ok(tooltip);
  assert.doesNotMatch(tooltip, /Cache/);
});

test('formatAssistantMetaTooltip returns null without usage or duration, and for non-assistant roles', () => {
  assert.equal(formatAssistantMetaTooltip(assistantMessage()), null);
  assert.equal(
    formatAssistantMetaTooltip({
      id: 'user-1',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Prompt',
      status: 'completed',
      durationMs: 1000,
    }),
    null,
  );
});
