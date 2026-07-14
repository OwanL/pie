import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureAssistantParts,
  withAssistantParts,
  markdownFromUserParts,
  appendAssistantTextPart,
  appendContinuationSeparator,
  upsertAssistantToolCall,
  mergeContinuationToolCalls,
  assistantToolCallsFromMessage,
  mergeAssistantToolCallsPreservingResolvedState,
} from '../../../../src/host/core/transcript-helpers';
import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../../src/shared/protocol';

// All helpers operate on a ChatMessage in place (or return a lightly-cloned
// one). They keep the legacy aggregate fields (`markdown`, `thinking`,
// `toolCalls`) and the `parts` array consistent. The merge/continuation
// resolve path below is exercised by streaming indirectly but never asserted
// directly elsewhere.

function assistant(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2024-01-01T00:00:00Z',
    markdown: '',
    status: 'completed',
    ...over,
  };
}

function tc(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', input: { path: '/x' }, status: 'running', ...over };
}

// ─── ensureAssistantParts ────────────────────────────────────────────────────

test('ensureAssistantParts returns existing parts by reference without rebuilding', () => {
  const parts: ChatMessagePart[] = [{ kind: 'text', text: 'prebuilt' }];
  const msg = assistant('m', { parts });
  assert.equal(ensureAssistantParts(msg), parts); // same reference
});

test('ensureAssistantParts builds [reasoning, toolCall, text] in that fixed order from legacy fields', () => {
  const msg = assistant('m', {
    thinking: 'why',
    toolCalls: [tc('t1')],
    markdown: 'body',
  });
  const parts = ensureAssistantParts(msg);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['reasoning', 'toolCall', 'text'],
  );
  assert.equal(parts[0].kind === 'reasoning' && parts[0].text, 'why');
  assert.equal(parts[2].kind === 'text' && parts[2].text, 'body');
  // The built parts are cached on the message.
  assert.equal(msg.parts, parts);
});

test('ensureAssistantParts with only markdown yields a single text part', () => {
  const msg = assistant('m', { markdown: 'solo' });
  const parts = ensureAssistantParts(msg);
  assert.deepEqual(parts.map((p) => p.kind), ['text']);
});

// ─── withAssistantParts ──────────────────────────────────────────────────────

test('withAssistantParts leaves a user message untouched (no parts built)', () => {
  const msg: ChatMessage = { id: 'u', role: 'user', createdAt: 't', markdown: 'hi', status: 'completed' };
  const returned = withAssistantParts(msg);
  assert.equal(returned, msg); // same reference
  assert.equal(msg.parts, undefined);
});

test('withAssistantParts clones (does not mutate) an assistant message when building parts', () => {
  const msg = assistant('m', { markdown: 'body' });
  const returned = withAssistantParts(msg);
  assert.notEqual(returned, msg);
  assert.ok(returned.parts);
  assert.equal(msg.parts, undefined); // original untouched
  assert.equal(returned.parts?.[0].kind, 'text');
});

test('withAssistantParts returns an assistant that already has parts unchanged', () => {
  const parts: ChatMessagePart[] = [{ kind: 'text', text: 'x' }];
  const msg = assistant('m', { parts });
  assert.equal(withAssistantParts(msg), msg);
});

// ─── markdownFromUserParts ───────────────────────────────────────────────────

test('markdownFromUserParts falls back when parts are absent or empty', () => {
  assert.equal(markdownFromUserParts(undefined, 'fallback'), 'fallback');
  assert.equal(markdownFromUserParts([], 'fallback'), 'fallback');
});

test('markdownFromUserParts falls back when no text parts are present', () => {
  const parts = [{ kind: 'image', mimeType: 'image/png', dataBase64: 'x' }];
  assert.equal(markdownFromUserParts(parts as any, 'fallback'), 'fallback');
});

test('markdownFromUserParts concatenates only the text parts', () => {
  const parts = [
    { kind: 'image', mimeType: 'image/png', dataBase64: 'x' },
    { kind: 'text', text: 'hello ' },
    { kind: 'text', text: 'world' },
  ];
  assert.equal(markdownFromUserParts(parts as any, 'fallback'), 'hello world');
});

test('markdownFromUserParts falls back when text parts join to an empty string', () => {
  const parts = [{ kind: 'text', text: '' }];
  assert.equal(markdownFromUserParts(parts as any, 'fallback'), 'fallback');
});

// ─── appendAssistantTextPart (incl. the needsSeparator resolve path) ─────────

test('appendAssistantTextPart is a no-op for empty text', () => {
  const msg = assistant('m', { markdown: 'keep', parts: [{ kind: 'text', text: 'keep' }] });
  appendAssistantTextPart(msg, 'text', '');
  assert.equal(msg.markdown, 'keep');
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'keep');
});

test('appendAssistantTextPart appends to the last same-kind part instead of adding a new one', () => {
  const msg = assistant('m', { markdown: 'first', parts: [{ kind: 'text', text: 'first' }] });
  appendAssistantTextPart(msg, 'text', ' second');
  assert.equal(msg.parts?.length, 1);
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'first second');
  assert.equal(msg.markdown, 'first second');
});

test('appendAssistantTextPart injects a paragraph separator into the part when the aggregate already ends with one (needsSeparator path)', () => {
  // This is the resolve path streaming hits after appendContinuationSeparator:
  // the aggregate carries '\n\n', the last part does not, so the separator is
  // injected into the new part text — but NOT re-appended to the aggregate.
  const msg = assistant('m', {
    markdown: 'first\n\n',
    parts: [{ kind: 'text', text: 'first' }],
  });
  appendAssistantTextPart(msg, 'text', 'second');
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'first\n\nsecond');
  // Aggregate gets only the raw delta (the '\n\n' was already there).
  assert.equal(msg.markdown, 'first\n\nsecond');
});

test('appendAssistantTextPart does not inject a separator when the aggregate lacks a trailing double-newline', () => {
  const msg = assistant('m', { markdown: 'first', parts: [{ kind: 'text', text: 'first' }] });
  appendAssistantTextPart(msg, 'text', 'second');
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'firstsecond');
});

test('appendAssistantTextPart does not inject a separator when the last part already ends with one', () => {
  const msg = assistant('m', {
    markdown: 'first\n\n',
    parts: [{ kind: 'text', text: 'first\n\n' }],
  });
  appendAssistantTextPart(msg, 'text', 'second');
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'first\n\nsecond');
});

test('appendAssistantTextPart starts a new part when the kind changes and sets the thinking aggregate for reasoning', () => {
  const msg = assistant('m', { markdown: 'answer', parts: [{ kind: 'text', text: 'answer' }] });
  appendAssistantTextPart(msg, 'reasoning', 'why');
  assert.equal(msg.parts?.length, 2);
  assert.equal(msg.parts?.[1].kind, 'reasoning');
  assert.equal(msg.thinking, 'why');
});

// ─── appendContinuationSeparator ─────────────────────────────────────────────

test('appendContinuationSeparator appends \\n\\n to markdown, thinking, and the last text part', () => {
  const msg = assistant('m', {
    markdown: 'a',
    thinking: 'b',
    parts: [{ kind: 'text', text: 'a' }],
  });
  appendContinuationSeparator(msg);
  assert.equal(msg.markdown, 'a\n\n');
  assert.equal(msg.thinking, 'b\n\n');
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'a\n\n');
});

test('appendContinuationSeparator does not touch a missing thinking aggregate', () => {
  const msg = assistant('m', { markdown: 'a', parts: [{ kind: 'text', text: 'a' }] });
  appendContinuationSeparator(msg);
  assert.equal(msg.markdown, 'a\n\n');
  assert.equal(msg.thinking, undefined);
});

test('appendContinuationSeparator appends to aggregates but not to a trailing toolCall part', () => {
  const msg = assistant('m', {
    markdown: 'a',
    parts: [{ kind: 'text', text: 'a' }, { kind: 'toolCall', toolCall: tc('t1') }],
  });
  appendContinuationSeparator(msg);
  assert.equal(msg.markdown, 'a\n\n');
  // Last part is a toolCall → no part text updated; the toolCall part is untouched.
  const last = msg.parts?.[msg.parts.length - 1];
  assert.equal(last?.kind, 'toolCall');
});

test('appendContinuationSeparator is idempotent on the last part but NOT on the aggregate', () => {
  // Aggregate always appends (not guarded); the part is guarded by endsWith.
  const msg = assistant('m', {
    markdown: 'a\n\n',
    parts: [{ kind: 'text', text: 'a\n\n' }],
  });
  appendContinuationSeparator(msg);
  assert.equal(msg.markdown, 'a\n\n\n\n'); // aggregate appended again
  assert.equal(msg.parts?.[0].kind === 'text' && msg.parts[0].text, 'a\n\n'); // part unchanged
});

// ─── upsertAssistantToolCall ─────────────────────────────────────────────────

test('upsertAssistantToolCall inserts a new tool call into both toolCalls and parts', () => {
  const msg = assistant('m', { markdown: 'hi', parts: [{ kind: 'text', text: 'hi' }] });
  upsertAssistantToolCall(msg, tc('t1', { name: 'write', status: 'running' }));
  assert.equal(msg.toolCalls?.length, 1);
  assert.equal(msg.toolCalls?.[0].id, 't1');
  assert.equal(msg.toolCalls?.[0].name, 'write');
  const part = msg.parts?.find((p) => p.kind === 'toolCall');
  assert.equal(part?.kind === 'toolCall' && part.toolCall.id, 't1');
});

test('upsertAssistantToolCall merges live updates by id while preserving an omitted result', () => {
  const msg = assistant('m', {
    toolCalls: [tc('t1', { name: 'read', input: { path: '/old' }, result: 'partial', status: 'running' })],
  });
  // The tc() helper defaults the incoming call to input {path:'/x'} and status
  // 'running'; result is absent (undefined), so it must NOT clobber the existing result.
  upsertAssistantToolCall(msg, tc('t1', { name: 'write' }));
  const merged = msg.toolCalls?.[0];
  assert.equal(merged?.name, 'write');
  assert.deepEqual(merged?.input, { path: '/x' });
  assert.equal(merged?.result, 'partial');
  assert.equal(merged?.status, 'running');
});

test('upsertAssistantToolCall preserves valid live state when opaque progress markers arrive', () => {
  const markerFirst = assistant('marker-first');
  upsertAssistantToolCall(markerFirst, tc('t0', {
    name: 'subagent',
    result: { $toolProgress: 'unserializable' },
    status: 'running',
  }));
  assert.equal(markerFirst.toolCalls?.[0].result, undefined);

  const liveResult = { details: { results: [{ activityPhase: 'running_tool' }] } };
  const msg = assistant('m', {
    toolCalls: [tc('t1', { name: 'subagent', result: liveResult, status: 'running' })],
  });

  upsertAssistantToolCall(msg, tc('t1', {
    name: 'subagent',
    result: { $toolProgress: 'unserializable' },
    status: 'running',
  }));
  assert.equal(msg.toolCalls?.[0].result, liveResult);

  upsertAssistantToolCall(msg, tc('t1', {
    name: 'subagent',
    result: { $toolProgress: 'truncated', preview: 'opaque' },
    status: 'running',
  }));
  assert.equal(msg.toolCalls?.[0].result, liveResult);
});

test('upsertAssistantToolCall accepts compact renderable progress markers', () => {
  const msg = assistant('m', {
    toolCalls: [tc('t1', { name: 'subagent', result: { old: true }, status: 'running' })],
  });
  const compact = {
    $toolProgress: 'truncated',
    details: { results: [{ activityPhase: 'streaming' }] },
  };

  upsertAssistantToolCall(msg, tc('t1', { name: 'subagent', result: compact, status: 'running' }));
  assert.equal(msg.toolCalls?.[0].result, compact);
});

test('upsertAssistantToolCall ignores late progress that would revive a terminal call', () => {
  const msg = assistant('m', {
    toolCalls: [tc('t1', { result: 'final', status: 'failed', durationMs: 42 })],
  });

  upsertAssistantToolCall(msg, tc('t1', { result: 'late partial', status: 'running' }));

  assert.equal(msg.toolCalls?.[0].status, 'failed');
  assert.equal(msg.toolCalls?.[0].result, 'final');
  const part = msg.parts?.find((candidate) => candidate.kind === 'toolCall');
  assert.equal(part?.kind === 'toolCall' && part.toolCall.status, 'failed');
  assert.equal(part?.kind === 'toolCall' && part.toolCall.result, 'final');
});

test('upsertAssistantToolCall does not clobber existing input with an empty object', () => {
  const msg = assistant('m', { toolCalls: [tc('t1', { input: { path: '/x' } })] });
  upsertAssistantToolCall(msg, tc('t1', { input: {} }));
  assert.deepEqual(msg.toolCalls?.[0].input, { path: '/x' });
});

test('upsertAssistantToolCall replaces input with a non-empty incoming input', () => {
  const msg = assistant('m', { toolCalls: [tc('t1', { input: { path: '/x' } })] });
  upsertAssistantToolCall(msg, tc('t1', { input: { path: '/y', force: true } }));
  assert.deepEqual(msg.toolCalls?.[0].input, { path: '/y', force: true });
});

test('upsertAssistantToolCall preserves an existing result when the incoming result is undefined', () => {
  const msg = assistant('m', { toolCalls: [tc('t1', { result: 'kept' })] });
  upsertAssistantToolCall(msg, tc('t1', { status: 'completed' }));
  assert.equal(msg.toolCalls?.[0].result, 'kept');
  assert.equal(msg.toolCalls?.[0].status, 'completed');
});

test('upsertAssistantToolCall carries an incoming parallelGroupId onto an existing tool call', () => {
  // Existing call has no group id (e.g. a tool.started that arrived before its
  // parallel sibling). A later update carrying the group id must stamp it so
  // the batch stays connected through message-end replacement.
  const msg = assistant('m', { toolCalls: [tc('t1', { status: 'running' })] });
  assert.equal(msg.toolCalls?.[0].parallelGroupId, undefined);
  upsertAssistantToolCall(msg, tc('t1', { parallelGroupId: 'batch-1' }));
  assert.equal(msg.toolCalls?.[0].parallelGroupId, 'batch-1');
  assert.equal(
    msg.parts?.find((p) => p.kind === 'toolCall')?.kind === 'toolCall' &&
      msg.parts?.find((p) => p.kind === 'toolCall')?.toolCall.parallelGroupId,
    'batch-1',
  );
});

test('upsertAssistantToolCall preserves an existing parallelGroupId when the incoming update omits it', () => {
  // A tool.finished/tool.progress update (no parallelGroupId in payload) must
  // not wipe a group id stamped at tool.started.
  const msg = assistant('m', { toolCalls: [tc('t1', { parallelGroupId: 'batch-1', status: 'running' })] });
  upsertAssistantToolCall(msg, tc('t1', { status: 'completed', result: 'ok' }));
  assert.equal(msg.toolCalls?.[0].parallelGroupId, 'batch-1');
  assert.equal(msg.toolCalls?.[0].status, 'completed');
});

// ─── mergeContinuationToolCalls ──────────────────────────────────────────────

test('mergeContinuationToolCalls upserts every tool call carried by incoming parts', () => {
  const msg = assistant('m', { markdown: 'hi' });
  const incoming = assistant('c', {
    parts: [{ kind: 'toolCall', toolCall: tc('t1') }, { kind: 'toolCall', toolCall: tc('t2') }],
  });
  mergeContinuationToolCalls(msg, incoming);
  assert.deepEqual(msg.toolCalls?.map((t) => t.id), ['t1', 't2']);
});

test('mergeContinuationToolCalls falls back to incoming.toolCalls when incoming has no parts', () => {
  const msg = assistant('m', { markdown: 'hi' });
  const incoming = assistant('c', { toolCalls: [tc('t1')] });
  mergeContinuationToolCalls(msg, incoming);
  assert.deepEqual(msg.toolCalls?.map((t) => t.id), ['t1']);
});

test('mergeContinuationToolCalls prefers parts over toolCalls: a toolCall only in toolCalls is dropped when parts exist', () => {
  const msg = assistant('m', { markdown: 'hi' });
  const incoming = assistant('c', {
    parts: [{ kind: 'text', text: 'no tool calls here' }],
    toolCalls: [tc('ghost')], // present in toolCalls but parts exist → ignored
  });
  mergeContinuationToolCalls(msg, incoming);
  assert.equal(msg.toolCalls, undefined);
});

// ─── assistantToolCallsFromMessage ───────────────────────────────────────────

test('assistantToolCallsFromMessage returns [] for non-assistant messages', () => {
  const msg: ChatMessage = { id: 'u', role: 'user', createdAt: 't', markdown: 'hi', status: 'completed' };
  assert.deepEqual(assistantToolCallsFromMessage(msg), []);
});

test('assistantToolCallsFromMessage prefers toolCall parts when present', () => {
  const msg = assistant('m', {
    parts: [{ kind: 'toolCall', toolCall: tc('from-parts') }],
    toolCalls: [tc('from-legacy')], // should be ignored because parts carry tool calls
  });
  assert.deepEqual(assistantToolCallsFromMessage(msg).map((t) => t.id), ['from-parts']);
});

test('assistantToolCallsFromMessage falls back to toolCalls when parts lack tool calls', () => {
  const msg = assistant('m', {
    parts: [{ kind: 'text', text: 'hi' }],
    toolCalls: [tc('from-legacy')],
  });
  assert.deepEqual(assistantToolCallsFromMessage(msg).map((t) => t.id), ['from-legacy']);
});

test('assistantToolCallsFromMessage returns clones (mutating the result does not affect the message)', () => {
  const msg = assistant('m', { toolCalls: [tc('t1', { name: 'read' })] });
  const calls = assistantToolCallsFromMessage(msg);
  calls[0].name = 'mutated';
  assert.equal(msg.toolCalls?.[0].name, 'read');
});

// ─── mergeAssistantToolCallsPreservingResolvedState (the merge-resolve path) ─

test('mergePreservingResolvedState is a no-op when target is not an assistant message', () => {
  const target: ChatMessage = { id: 'u', role: 'user', createdAt: 't', markdown: 'hi', status: 'completed' };
  const previous = assistant('p', { toolCalls: [tc('t1')] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls, undefined);
});

test('mergePreservingResolvedState is a no-op when previous is not an assistant message', () => {
  const target = assistant('t', { toolCalls: [tc('t1')] });
  const previous: ChatMessage = { id: 'u', role: 'user', createdAt: 't', markdown: 'hi', status: 'completed' };
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.deepEqual(target.toolCalls?.map((x) => x.id), ['t1']);
});

test('mergePreservingResolvedState inserts tool calls that only exist in previous', () => {
  const target = assistant('t', { toolCalls: [tc('t1')] });
  const previous = assistant('p', { toolCalls: [tc('t2', { name: 'write' })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.deepEqual(target.toolCalls?.map((x) => x.id), ['t1', 't2']);
});

test('mergePreservingResolvedState fills empty input and missing result from previous', () => {
  // Target is mid-stream: input is empty and no result yet; previous had resolved.
  // Target is mid-stream: input empty and no result yet; previous had resolved.
  // Input + result are copied from previous, but the target's live (non-failed)
  // status is preserved — only a *failed* status propagates from previous.
  const target = assistant('t', { toolCalls: [tc('t1', { input: {}, result: undefined, status: 'running' })] });
  const previous = assistant('p', {
    toolCalls: [tc('t1', { input: { path: '/x' }, result: 'ok', status: 'completed' })],
  });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  const merged = target.toolCalls?.[0];
  assert.deepEqual(merged?.input, { path: '/x' });
  assert.equal(merged?.result, 'ok');
  assert.equal(merged?.status, 'running');
});

test('mergePreservingResolvedState preserves target non-empty input and defined result over previous', () => {
  const target = assistant('t', {
    toolCalls: [tc('t1', { input: { path: '/mine' }, result: 'mine', status: 'running' })],
  });
  const previous = assistant('p', {
    toolCalls: [tc('t1', { input: { path: '/theirs' }, result: 'theirs', status: 'completed' })],
  });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  const merged = target.toolCalls?.[0];
  assert.deepEqual(merged?.input, { path: '/mine' });
  assert.equal(merged?.result, 'mine');
  assert.equal(merged?.status, 'running'); // current non-failed status wins over previous non-failed
});

test('mergePreservingResolvedState propagates a failed status from previous when target is not failed', () => {
  const target = assistant('t', { toolCalls: [tc('t1', { status: 'completed' })] });
  const previous = assistant('p', { toolCalls: [tc('t1', { status: 'failed' })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].status, 'failed');
});

test('mergePreservingResolvedState keeps a failed target failed even if previous completed', () => {
  const target = assistant('t', { toolCalls: [tc('t1', { status: 'failed' })] });
  const previous = assistant('p', { toolCalls: [tc('t1', { status: 'completed' })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].status, 'failed');
});

test('mergePreservingResolvedState fills an empty target name from previous', () => {
  const target = assistant('t', { toolCalls: [tc('t1', { name: '' })] });
  const previous = assistant('p', { toolCalls: [tc('t1', { name: 'read' })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].name, 'read');
});

test('mergePreservingResolvedState fills startedAt/durationMs from previous when target lacks them', () => {
  const target = assistant('t', { toolCalls: [tc('t1')] });
  const previous = assistant('p', { toolCalls: [tc('t1', { startedAt: 100, durationMs: 42 })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].startedAt, 100);
  assert.equal(target.toolCalls?.[0].durationMs, 42);
});

test('mergePreservingResolvedState keeps target startedAt/durationMs when present', () => {
  const target = assistant('t', { toolCalls: [tc('t1', { startedAt: 5, durationMs: 9 })] });
  const previous = assistant('p', { toolCalls: [tc('t1', { startedAt: 100, durationMs: 42 })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].startedAt, 5);
  assert.equal(target.toolCalls?.[0].durationMs, 9);
});

test('mergePreservingResolvedState carries parallelGroupId from previous when target (backend replacement) lacks it', () => {
  // The message_end replacement is built by the backend without
  // parallelGroupId, so the host must carry it forward from the previous
  // (host-stamped) message — otherwise the parallel strip vanishes on
  // completion. This is the regression guard for that path.
  const target = assistant('t', {
    toolCalls: [tc('t1', { status: 'completed' }), tc('t2', { status: 'completed' })],
  });
  const previous = assistant('p', {
    toolCalls: [
      tc('t1', { status: 'completed', parallelGroupId: 'batch-1' }),
      tc('t2', { status: 'completed', parallelGroupId: 'batch-1' }),
    ],
  });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].parallelGroupId, 'batch-1');
  assert.equal(target.toolCalls?.[1].parallelGroupId, 'batch-1');
  // Parts mirror toolCalls.
  const partIds = target.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => (p.kind === 'toolCall' ? p.toolCall.parallelGroupId : undefined));
  assert.deepEqual(partIds, ['batch-1', 'batch-1']);
});

test('mergePreservingResolvedState keeps a target parallelGroupId over the previous one', () => {
  const target = assistant('t', { toolCalls: [tc('t1', { parallelGroupId: 'target-batch' })] });
  const previous = assistant('p', { toolCalls: [tc('t1', { parallelGroupId: 'prev-batch' })] });
  mergeAssistantToolCallsPreservingResolvedState(target, previous);
  assert.equal(target.toolCalls?.[0].parallelGroupId, 'target-batch');
});
