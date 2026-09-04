/**
 * Unit tests for `chatMessageEqual` — the content comparer backing
 * `MessageItem`'s `memo()` barrier.
 *
 * The contract under test: two `ChatMessage` values with different references
 * but byte-identical content must compare equal (so `MessageItem` can bail out
 * of re-rendering unchanged rows on host snapshot posts), and a difference in
 * ANY single field must compare unequal (so a stale render is never served).
 *
 * The "any single field" coverage is the safety guarantee that lets us use a
 * content comparer instead of reference equality: if a future field is added to
 * `ChatMessage` and not covered here or in `chatMessageEqual`, this test should
 * be extended — that is the review checkpoint for the completeness invariant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chatMessageEqual } from '../../../../src/webview/panel/transcript/message-equal';
import type { ChatMessage, ToolCall } from '../../../../src/shared/protocol';

const CHAT_MESSAGE_TOP_LEVEL_FIELDS = [
  'id', 'renderIdentity', 'role', 'createdAt', 'markdown', 'userParts', 'parts',
  'thinking', 'thinkingDetailRef', 'draftingToolCall', 'modelId', 'provider',
  'thinkingLevel', 'status', 'errorDetail', 'toolCalls', 'toolStateRevision',
  'durationMs', 'turnLatencyMs', 'overheadMs', 'providerLatencyMs',
  'providerQueueMs', 'providerQueueAttemptCount', 'usage', 'customType',
  'customDetails', 'durableEntryId', 'billingSourceEntryIds',
] as const satisfies readonly (keyof ChatMessage)[];
type MissingChatMessageField = Exclude<keyof ChatMessage, typeof CHAT_MESSAGE_TOP_LEVEL_FIELDS[number]>;

function makeBaseMessage(): ChatMessage {
  const toolCall: ToolCall = {
    id: 'tc-1',
    name: 'bash',
    input: { command: 'echo hi' },
    result: 'hi',
    status: 'completed',
    startedAt: 1700000000000,
    durationMs: 12,
  };
  return {
    id: 'msg-1',
    renderIdentity: 'render-msg-1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Hello **world**.',
    userParts: undefined,
    parts: [
      { kind: 'text', text: 'Hello **world**.' },
      { kind: 'reasoning', text: 'deciding what to say' },
      { kind: 'toolCall', toolCall },
    ],
    thinking: 'deciding what to say',
    thinkingDetailRef: {
      key: 'reasoning:msg-1', kind: 'reasoning', source: 'durable', sessionPath: '/s',
      messageId: 'msg-1', sizeBytes: 22, summary: 'deciding', available: true,
    },
    modelId: 'claude-test',
    provider: 'anthropic',
    thinkingLevel: 'medium',
    status: 'completed',
    errorDetail: undefined,
    toolCalls: [toolCall],
    toolStateRevision: 3,
    durationMs: 800,
    turnLatencyMs: 420,
    overheadMs: 120,
    providerLatencyMs: 300,
    providerQueueMs: 40,
    providerQueueAttemptCount: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
    },
    customType: undefined,
    customDetails: undefined,
    durableEntryId: 'entry-msg-1',
    billingSourceEntryIds: ['entry-msg-1'],
  };
}

/** Deep-clone via JSON so the result is a fresh reference (no shared identity). */
function freshClone(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message)) as ChatMessage;
}

test('ChatMessage top-level equality coverage is compile-time complete', () => {
  const complete: [MissingChatMessageField] extends [never] ? true : never = true;
  assert.equal(complete, true);
  assert.equal(new Set(CHAT_MESSAGE_TOP_LEVEL_FIELDS).size, CHAT_MESSAGE_TOP_LEVEL_FIELDS.length);
});

test('chatMessageEqual returns true for the same reference', () => {
  const m = makeBaseMessage();
  assert.equal(chatMessageEqual(m, m), true);
});

test('chatMessageEqual returns true for byte-identical messages with different references', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  assert.notEqual(a, b);
  assert.equal(chatMessageEqual(a, b), true);
});

// ─── Per-field difference detection ─────────────────────────────────────────
// Each case mutates exactly one field on a fresh clone and asserts unequal.

test('detects markdown difference (the streaming-message hot path)', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  b.markdown += ' more tokens';
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects markdown difference by content even when length is unchanged', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  b.markdown = b.markdown.replace('world', 'WORLD');
  assert.equal(b.markdown.length, a.markdown.length);
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects identity / role / status / provider-model differences', () => {
  for (const [field, value] of [
    ['id', 'msg-2'],
    ['renderIdentity', 'render-msg-2'],
    ['role', 'user'],
    ['status', 'streaming'],
    ['createdAt', '2026-02-02T00:00:00.000Z'],
    ['modelId', 'gpt-test'],
    ['provider', 'openai'],
    ['thinkingLevel', 'high'],
  ] as const) {
    const a = makeBaseMessage();
    const b = freshClone(a);
    (b as unknown as Record<string, unknown>)[field] = value;
    assert.equal(chatMessageEqual(a, b), false, `should detect ${field} difference`);
  }
});

test('detects thinking / errorDetail / customType / latency / duration / usage differences', () => {
  const cases: Array<{ field: string; value: unknown }> = [
    { field: 'thinking', value: 'changed reasoning' },
    { field: 'errorDetail', value: 'boom' },
    { field: 'customType', value: 'pruning-result' },
    { field: 'toolStateRevision', value: 4 },
    { field: 'durationMs', value: 999 },
    { field: 'turnLatencyMs', value: 1 },
    { field: 'overheadMs', value: 2 },
    { field: 'providerLatencyMs', value: 3 },
    { field: 'providerQueueMs', value: 4 },
    { field: 'providerQueueAttemptCount', value: 2 },
    { field: 'durableEntryId', value: 'entry-msg-2' },
    { field: 'usage', value: { inputTokens: 999, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 } },
  ];
  for (const { field, value } of cases) {
    const a = makeBaseMessage();
    const b = freshClone(a);
    (b as unknown as Record<string, unknown>)[field] = value;
    assert.equal(chatMessageEqual(a, b), false, `should detect ${field} difference`);
  }
});

test('detects thinking detail identity differences', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  b.thinkingDetailRef!.key = 'reasoning:msg-2';
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects nested parts difference (toolCall result landing)', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  // A tool call that just resolved: result appears / changes, primitives
  // (status already 'completed', markdown unchanged) would match, so the
  // nested parts/toolCalls comparison must catch it.
  const toolPart = b.parts!.find((p) => p.kind === 'toolCall');
  if (toolPart && toolPart.kind === 'toolCall') {
    toolPart.toolCall.result = 'different output';
  }
  b.toolCalls![0].result = 'different output';
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects parts array growth (assistant text appended without markdown change)', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  // Append a text part but keep markdown identical — only `parts` differs.
  b.parts!.push({ kind: 'text', text: 'extra' });
  assert.equal(a.markdown, b.markdown);
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects toolCalls array growth', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  b.toolCalls!.push({ ...b.toolCalls![0], id: 'tc-2' });
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects a growing transient tool-call draft', () => {
  const a = makeBaseMessage();
  a.draftingToolCall = { id: 'tc-2', name: 'bash', argumentsText: '{"command":' };
  const b = freshClone(a);
  b.draftingToolCall!.argumentsText += '"npm test"}';
  assert.equal(chatMessageEqual(a, b), false);
});

test('detects userParts difference (structured user input)', () => {
  const a: ChatMessage = { ...makeBaseMessage(), role: 'user', userParts: [{ kind: 'text', text: 'hi' }] };
  const b = freshClone(a);
  (b.userParts![0] as { text: string }).text = 'hi there';
  assert.equal(chatMessageEqual(a, b), false);
});

test('treats absent vs present optional fields as unequal (fails safe, not stale)', () => {
  const a = makeBaseMessage();
  const b = freshClone(a);
  delete (b as Partial<ChatMessage>).usage;
  assert.equal(chatMessageEqual(a, b), false);
  // And the reverse: present on b, absent on a.
  const c = freshClone(a);
  delete (c as Partial<ChatMessage>).usage;
  assert.equal(chatMessageEqual(c, a), false);
});

test('treats both-absent optional fields as equal', () => {
  const a = makeBaseMessage();
  delete (a as Partial<ChatMessage>).usage;
  const b = freshClone(a);
  delete (b as Partial<ChatMessage>).usage;
  assert.equal(chatMessageEqual(a, b), true);
});

test('detects customDetails difference (pruning-result messages)', () => {
  const a: ChatMessage = {
    ...makeBaseMessage(),
    customType: 'pruning-result',
    customDetails: { includedSkills: ['debugging'], excludedSkills: [], includedTools: [], excludedTools: [], mode: 'auto', skillTokensSaved: 1, toolTokensSaved: 2, prepassThinking: 'x' } as never,
  };
  const b = freshClone(a);
  (b.customDetails as { skillTokensSaved: number }).skillTokensSaved = 999;
  assert.equal(chatMessageEqual(a, b), false);
});
