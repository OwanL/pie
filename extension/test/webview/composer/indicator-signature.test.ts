import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry, ToolCall } from '../../../src/shared/protocol';
import {
  contextBreakdownTranscriptSignature,
  streamingContentSignature,
  subagentCostSignature,
  subagentToolCallRevision,
  systemPromptsSignature,
  toolCallContextSignature,
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

test('systemPromptsSignature changes when availability, disabled state, or text content changes', () => {
  const base = [prompt({ text: 'hello', availability: 'available' })];
  const sig = systemPromptsSignature(base);
  const hidden = structuredClone(base);
  hidden[0].availability = 'hidden';
  assert.notEqual(systemPromptsSignature(hidden), sig);
  const disabled = structuredClone(base);
  disabled[0].disabled = true;
  assert.notEqual(systemPromptsSignature(disabled), sig);
  const edited = structuredClone(base);
  edited[0].text = 'hello world';
  assert.notEqual(systemPromptsSignature(edited), sig);
});

test('systemPromptsSignature detects a same-length content edit without copying prompt bodies', () => {
  // Regression guard: the context-window breakdown values the system-prompt
  // contributor via estimateTextTokens (a content-dependent BPE count), so a
  // same-length system-prompt edit must invalidate the key.
  const a = [prompt({ text: 'a'.repeat(10_000) })];
  const b = [prompt({ text: 'b'.repeat(10_000) })];
  assert.equal(a[0].text.length, b[0].text.length, 'sanity: same length');
  assert.notEqual(systemPromptsSignature(a), systemPromptsSignature(b));
  assert.ok(systemPromptsSignature(a).length < a[0].text.length, 'signature remains bounded');
});

test('contextBreakdownTranscriptSignature invalidates generic tool result content and seq revisions', () => {
  const base = [msg({
    id: 'tool-message',
    toolCalls: [{ id: 'generic-1', name: 'bash', input: { command: 'pwd' }, result: 'a'.repeat(500), status: 'completed' }],
  })];
  const before = contextBreakdownTranscriptSignature(base);
  const resultChanged = structuredClone(base);
  resultChanged[0].toolCalls![0].result = 'different-token '.repeat(500);
  assert.notEqual(contextBreakdownTranscriptSignature(resultChanged), before);

  const live = structuredClone(base);
  live[0].toolCalls![0].status = 'running';
  live[0].toolCalls![0].seq = 4;
  const liveBefore = contextBreakdownTranscriptSignature(live);
  const liveRevisionChanged = structuredClone(live);
  liveRevisionChanged[0].toolCalls![0].seq = 5;
  assert.notEqual(contextBreakdownTranscriptSignature(liveRevisionChanged), liveBefore);
  assert.equal(toolCallContextSignature(live[0].toolCalls![0]).includes('result:'), false,
    'revisioned previews use the bounded seq gate instead of copying their body');

  const durable = structuredClone(live);
  durable[0].toolCalls![0].status = 'completed';
  durable[0].toolCalls![0].durableEntryId = 'durable-tool-result';
  durable[0].toolCalls![0].result = 'authoritative durable result';
  assert.notEqual(contextBreakdownTranscriptSignature(durable), liveBefore,
    'durable reconciliation must invalidate a preserved live seq');

  const queued = [msg({ id: 'queued', role: 'user', status: 'queued', markdown: 'draft one' })];
  const queuedBefore = contextBreakdownTranscriptSignature(queued);
  queued[0].markdown = 'draft two';
  assert.notEqual(contextBreakdownTranscriptSignature(queued), queuedBefore,
    'editable queued message content must invalidate its contributor estimate');
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

test('subagentCostSignature changes as live typed child usage grows', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    toolCalls: [{
      id: 'tc1', name: 'subagent', input: {}, status: 'running', seq: 1,
      result: {
        kind: 'subagent', mode: 'single', children: [{
          id: 'worker', phase: 'running', provider: 'github-copilot', model: 'gpt-5.6-sol',
          usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.1 },
        }],
      },
    }],
  })];
  const before = subagentCostSignature(base);
  const grown = structuredClone(base);
  const result = grown[0].toolCalls![0].result as { children: Array<{ usage: { cost: number } }> };
  result.children[0].usage.cost = 2.5;

  assert.notEqual(subagentCostSignature(grown), before);
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

// ── subagentToolCallRevision (REM-04: cheap revision gate for subagentCostSignature) ──

test('subagentToolCallRevision is stable while only the streaming message text grows', () => {
  // The revision is built from the tool call's monotonic `seq`, not the growing
  // streaming prose. Growing the message markdown must NOT change the revision
  // — this is what lets the `subagentCostSignature` useMemo skip its recursive
  // walk on unchanged snapshots.
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1, seq: 5 }],
  })];
  const rev = subagentToolCallRevision(base);
  const grown = structuredClone(base);
  grown[0].markdown += ' growing prose';
  assert.equal(subagentToolCallRevision(grown), rev);
});

test('subagentToolCallRevision changes when the subagent seq advances (preview change)', () => {
  // A seq advance signals a structural preview change (streaming-text append,
  // usage update, etc.). The revision must change so the fingerprint memo
  // re-runs and reflects the new content.
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1, seq: 5 }],
  })];
  const rev = subagentToolCallRevision(base);
  const advanced = structuredClone(base);
  (advanced[0].toolCalls![0] as ToolCall).seq = 6;
  assert.notEqual(subagentToolCallRevision(advanced), rev);
});

test('subagentToolCallRevision changes when the last message tool call completes (result lands)', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1 }],
  })];
  const rev = subagentToolCallRevision(base);
  const completed = structuredClone(base);
  completed[0].toolCalls![0].status = 'completed';
  completed[0].toolCalls![0].result = { content: [], details: { mode: 'single', results: [] } };
  assert.notEqual(subagentToolCallRevision(completed), rev);
});

test('subagentToolCallRevision changes when a nested subagent completes (parent seq advances)', () => {
  // Correctness for nested completion changes: a nested subagent completing
  // causes the backend to emit a progress event for the parent tool, advancing
  // its `seq`. The revision must change so the cost fingerprint re-runs and
  // picks up the nested result's new exitCode/usage/cost.
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{
      id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1, seq: 5,
      result: { mode: 'single', results: [{ agent: 'a', task: 't', exitCode: -1, messages: [] }] },
    }],
  })];
  const rev = subagentToolCallRevision(base);
  const nested = structuredClone(base);
  (nested[0].toolCalls![0] as ToolCall).seq = 6;
  assert.notEqual(subagentToolCallRevision(nested), rev,
    'parent seq advance (nested completion) changes the revision');
});

test('subagentToolCallRevision and subagentCostSignature are stable together (memo skip proof)', () => {
  // The revision gates the fingerprint memo: when the revision is unchanged,
  // the memo skips `subagentCostSignature` entirely. This proves both are
  // stable under the same "only streaming prose grew" condition, so the memo
  // skip is sound — the fingerprint would not have changed anyway.
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: 'w0',
    toolCalls: [{ id: 'tc1', name: 'subagent', input: {}, status: 'running', startedAt: 1, seq: 5,
      result: { mode: 'single', results: [{ agent: 'a', task: 't', exitCode: -1, messages: [] }] } }],
  })];
  const rev = subagentToolCallRevision(base);
  const sig = subagentCostSignature(base);
  const grown = structuredClone(base);
  grown[0].markdown += ' more streaming prose';
  assert.equal(subagentToolCallRevision(grown), rev, 'revision stable');
  assert.equal(subagentCostSignature(grown), sig, 'fingerprint stable');
});
