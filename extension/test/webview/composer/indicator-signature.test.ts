import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry } from '../../../src/shared/protocol';
import {
  streamingContentSignature,
  subagentCostSignature,
  systemPromptsSignature,
  transcriptUsageSignature,
} from '../../../src/webview/panel/composer/indicator-signature';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hi',
    status: 'completed',
    ...overrides,
  };
}

function prompt(overrides: Partial<SystemPromptEntry> = {}): SystemPromptEntry {
  return {
    source: 'user',
    title: 'p',
    text: 'abcd',
    summary: 'abcd',
    availability: 'available',
    ...overrides,
  };
}

// ── transcriptUsageSignature ────────────────────────────────────────────────

test('transcriptUsageSignature is stable while only the streaming message grows', () => {
  const base = [msg({ id: 'a', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 } }), msg({ id: 's', status: 'streaming', markdown: 'w0' })];
  const sig = transcriptUsageSignature(base);
  // Growing the streaming message's markdown/thinking must NOT change the
  // signature (usage sums are unaffected — the streaming message has no usage).
  const grown = structuredClone(base);
  grown[1].markdown += ' more tokens here';
  grown[1].thinking = 'reasoning';
  assert.equal(transcriptUsageSignature(grown), sig);
});

test('transcriptUsageSignature changes when a message is appended', () => {
  const base = [msg({ id: 'a' })];
  const sig = transcriptUsageSignature(base);
  const appended = [...base, msg({ id: 'b' })];
  assert.notEqual(transcriptUsageSignature(appended), sig);
});

test('transcriptUsageSignature changes when the last message finishes (usage lands)', () => {
  const streaming = [msg({ id: 's', status: 'streaming' })];
  const before = transcriptUsageSignature(streaming);
  const finished = structuredClone(streaming);
  finished[0].status = 'completed';
  finished[0].usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 };
  assert.notEqual(transcriptUsageSignature(finished), before);
});

test('transcriptUsageSignature tracks the active assistant before queued follow-ups', () => {
  const base = [
    msg({ id: 's', status: 'streaming' }),
    msg({ id: 'q', role: 'user', status: 'queued', markdown: 'follow-up' }),
  ];
  const before = transcriptUsageSignature(base);
  const finished = structuredClone(base);
  finished[0].status = 'completed';
  finished[0].usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 };
  assert.notEqual(transcriptUsageSignature(finished), before);
});

test('transcriptUsageSignature changes when the last message id changes (same length, different tail)', () => {
  // Guards against a stale summary when the loaded window is replaced with a
  // same-length but different-tail window (e.g. truncate-then-load).
  const a = [msg({ id: 'a' }), msg({ id: 'b' })];
  const b = [msg({ id: 'a' }), msg({ id: 'c' })];
  assert.notEqual(transcriptUsageSignature(a), transcriptUsageSignature(b));
});

// ── streamingContentSignature ───────────────────────────────────────────────

test('streamingContentSignature is empty when nothing is streaming', () => {
  assert.equal(streamingContentSignature([msg({ status: 'completed' })]), '');
  assert.equal(streamingContentSignature([]), '');
});

test('streamingContentSignature changes as the streaming message grows', () => {
  const base = [msg({ id: 's', status: 'streaming', markdown: 'w0' })];
  const before = streamingContentSignature(base);
  const grown = structuredClone(base);
  grown[0].markdown += ' w1 w2';
  assert.notEqual(streamingContentSignature(grown), before);
});

// ── systemPromptsSignature ──────────────────────────────────────────────────

test('systemPromptsSignature is stable for byte-identical content under a fresh ref', () => {
  const a = [prompt({ text: 'hello' }), prompt({ source: 'provider', text: 'world' })];
  const b = structuredClone(a); // fresh refs, identical content
  assert.equal(systemPromptsSignature(a), systemPromptsSignature(b));
});

test('systemPromptsSignature changes when availability or text content changes', () => {
  const base = [prompt({ text: 'hello', availability: 'available' })];
  const sig = systemPromptsSignature(base);
  const hidden = structuredClone(base);
  hidden[0].availability = 'hidden';
  assert.notEqual(systemPromptsSignature(hidden), sig);
  const edited = structuredClone(base);
  edited[0].text = 'hello world';
  assert.notEqual(systemPromptsSignature(edited), sig);
});

test('systemPromptsSignature detects a same-length content edit (a length proxy would miss this)', () => {
  // Regression guard: the context-window breakdown values the system-prompt
  // contributor via estimateTextTokens (a content-dependent BPE count), so a
  // same-length system-prompt text edit changes the breakdown. A text.length
  // signature would not change here → a stale tooltip. Including the full text
  // detects any edit regardless of length.
  const a = [prompt({ text: 'aaaaaaaaaaaaaaaaaaaa' })];
  const b = [prompt({ text: 'bbbbbbbbbbbbbbbbbbbb' })];
  assert.equal(a[0].text.length, b[0].text.length, 'sanity: same length');
  assert.notEqual(systemPromptsSignature(a), systemPromptsSignature(b));
});

// ── subagentCostSignature ───────────────────────────────────────────────────

test('subagentCostSignature is stable while only the streaming message text grows', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1 }],
  })];
  const sig = subagentCostSignature(base);
  const grown = structuredClone(base);
  grown[0].markdown += ' growing prose';
  assert.equal(subagentCostSignature(grown), sig);
});

test('subagentCostSignature changes when the last message tool call completes (result lands)', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1 }],
  })];
  const sig = subagentCostSignature(base);
  const completed = structuredClone(base);
  completed[0].toolCalls![0].status = 'completed';
  completed[0].toolCalls![0].result = { content: [], details: { mode: 'single', results: [] } };
  assert.notEqual(subagentCostSignature(completed), sig);
});

test('subagentCostSignature tracks the active assistant before queued follow-ups', () => {
  const base = [
    msg({
      id: 's',
      status: 'streaming',
      toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1 }],
    }),
    msg({ id: 'q', role: 'user', status: 'queued', markdown: 'follow-up' }),
  ];
  const before = subagentCostSignature(base);
  const completed = structuredClone(base);
  completed[0].toolCalls![0].status = 'completed';
  completed[0].toolCalls![0].result = { content: [], details: { mode: 'single', results: [] } };
  assert.notEqual(subagentCostSignature(completed), before);
});

test('subagentCostSignature uses the parts tool-call path when toolCalls is absent', () => {
  // Mirrors toolCallsFromMessage: parts[toolCall] is read only when the legacy
  // toolCalls array is empty/absent. A completion on the parts path must change
  // the signature.
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    parts: [{ kind: 'text', text: 'w0' }, { kind: 'toolCall', toolCall: { id: 'tc1', name: 'subagent', input: {}, status: 'running' } }],
  })];
  const sig = subagentCostSignature(base);
  const completed = structuredClone(base);
  const toolCall = (completed[0].parts![1] as { kind: 'toolCall'; toolCall: { id: string; name?: string; input: unknown; status: string; result?: unknown } }).toolCall;
  toolCall.status = 'completed';
  toolCall.result = { content: [], details: { mode: 'single', results: [] } };
  assert.notEqual(subagentCostSignature(completed), sig);
});
