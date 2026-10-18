import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry } from '../../../lib/protocol/index.js';
import {
  contextBreakdownTranscriptSignature,
  streamingContentSignature,
  systemPromptsSignature,
  toolCallContextSignature,
} from '../../composer/indicator-signature';

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

test('streamingContentSignature changes as tool-call arguments stream', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: '',
    toolCalls: [{
      id: 'tool-1',
      name: 'bash',
      input: '{"command":"ec',
      argumentsText: '{"command":"ec',
      status: 'drafting',
      seq: 1,
    }],
  })];
  const before = streamingContentSignature(base);
  const grown = structuredClone(base);
  grown[0].toolCalls![0].input = '{"command":"echo generated output"';
  grown[0].toolCalls![0].argumentsText = '{"command":"echo generated output"';
  grown[0].toolCalls![0].seq = 2;
  assert.notEqual(streamingContentSignature(grown), before);
});

test('streamingContentSignature tracks legacy tool-call drafts', () => {
  const base = [msg({
    id: 's',
    status: 'streaming',
    markdown: '',
    draftingToolCall: { id: 'tool-1', name: 'bash', argumentsText: '{"co' },
  })];
  const before = streamingContentSignature(base);
  const grown = structuredClone(base);
  grown[0].draftingToolCall!.argumentsText = '{"command":"pwd"}';
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
