import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactDurableMessageDetails,
  compactDurableMessageForTransport,
  compactSubagentResultPreview,
  compactToolCallDetail,
  findDurableDetail,
  SUBAGENT_PREVIEW_MAX_BYTES,
} from '../../../src/shared/lazy-details';
import type { ChatMessage } from '../../../src/shared/protocol';

const sessionPath = '/session.jsonl';

function durableMessage(): ChatMessage {
  const reasoning = 'reasoning '.repeat(4_000);
  const result = {
    details: {
      results: [{
        agent: 'worker',
        task: 'Inspect the long session',
        exitCode: 0,
        model: 'preview-model',
        streamingText: 'preview tail',
        messages: [{ role: 'assistant', content: 'x'.repeat(32_000) }],
      }],
    },
  };
  return {
    id: 'assistant-1',
    durableEntryId: 'assistant-entry',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'done',
    status: 'completed',
    thinking: reasoning,
    parts: [
      { kind: 'reasoning', text: reasoning },
      {
        kind: 'toolCall',
        toolCall: {
          id: 'tool-1', name: 'subagent', input: { task: 'work' }, result,
          status: 'completed', durationMs: 250, durableEntryId: 'tool-entry',
        },
      },
    ],
    toolCalls: [{
      id: 'tool-1', name: 'subagent', input: { task: 'work' }, result,
      status: 'completed', durationMs: 250, durableEntryId: 'tool-entry',
    }],
  };
}

test('initial durable projection contains compact metadata but no large reasoning or recursive tool detail', () => {
  const full = durableMessage();
  const compact = compactDurableMessageDetails(full, sessionPath);
  const reasoning = compact.parts?.[0];
  const tool = compact.parts?.[1]?.kind === 'toolCall' ? compact.parts[1].toolCall : undefined;

  assert.equal(reasoning?.kind, 'reasoning');
  assert.ok(reasoning?.kind === 'reasoning' && reasoning.detailRef);
  assert.ok((reasoning?.kind === 'reasoning' ? reasoning.text.length : 0) < 200);
  const preview = tool?.result as { details?: { results?: Array<Record<string, unknown>> } } | undefined;
  assert.equal(preview?.details?.results?.[0]?.agent, 'worker');
  assert.equal(preview?.details?.results?.[0]?.model, 'preview-model');
  assert.equal(preview?.details?.results?.[0]?.streamingText, 'preview tail');
  assert.deepEqual(preview?.details?.results?.[0]?.messages, []);
  assert.equal(tool?.detailRef?.kind, 'tool-result');
  assert.equal(tool?.detailRef?.childCount, 1);
  assert.equal(tool?.detailRef?.sizeBytes && tool.detailRef.sizeBytes > 32_000, true);
  assert.equal(JSON.stringify(compact).includes('x'.repeat(1_000)), false);
  assert.equal(JSON.stringify(full).includes('x'.repeat(1_000)), true, 'durable source remains lossless');
});

test('live recursive previews expose bounded child metadata without traversing child bodies', () => {
  const result = { kind: 'subagent', children: [{ id: 'one' }, { id: 'two' }] };
  const compacted = compactToolCallDetail({
    id: 'tool', name: 'subagent', input: {}, result, status: 'running',
  }, {
    sessionPath: '/session.jsonl', messageId: 'message', source: 'live',
    sourceRevision: 2, sizeBytes: 100_000,
  });
  const preview = compacted.result as { kind?: string; children?: unknown[] } | undefined;
  assert.equal(preview?.kind, 'subagent');
  assert.equal(preview?.children?.length, 2);
  assert.equal(compacted.detailRef?.summary, '2 subagent children');
  assert.equal(compacted.detailRef?.childCount, 2);
});

test('subagent preview preserves every top-level card while bounding recursive history', () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    role: 'assistant',
    content: `history-${index}-${'x'.repeat(4_000)}`,
  }));
  const preview = compactSubagentResultPreview({
    details: {
      mode: 'parallel',
      results: Array.from({ length: 12 }, (_, index) => ({
        agent: `worker-${index}`,
        task: `Task ${index} ${'t'.repeat(4_000)}`,
        exitCode: index === 0 ? -1 : 0,
        model: 'model',
        streamingText: `${'s'.repeat(16_000)}-tail-${index}`,
        messages,
      })),
    },
  }) as { details?: { results?: Array<Record<string, unknown>> } };

  assert.equal(preview.details?.results?.length, 12);
  assert.equal(preview.details?.results?.[0]?.agent, 'worker-0');
  assert.equal(JSON.stringify(preview).includes('history-0-'), false);
  assert.equal(JSON.stringify(preview).includes('-tail-0'), true);
  assert.equal(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= SUBAGENT_PREVIEW_MAX_BYTES, true);
});

test('subagent preview preserves recursive billing while omitting recursive messages', () => {
  const preview = compactSubagentResultPreview({
    details: { mode: 'single', results: [{
      agent: 'outer', task: 'delegate', exitCode: 0, model: 'outer-model', provider: 'github-copilot',
      usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 1 },
      messages: [{ role: 'toolResult', toolName: 'subagent', details: { mode: 'single', results: [{
        agent: 'inner', task: 'work', exitCode: 0, model: 'inner-model', provider: 'ollama',
        usage: { input: 200, output: 20, cacheRead: 6, cacheWrite: 2 },
        messages: [{ role: 'assistant', content: 'nested-secret-body' }],
      }] } }],
    }] },
  }) as { billing?: Array<{ path: string; provider?: string; usage: { input: number } }>; details?: unknown };

  assert.deepEqual(preview.billing?.map((entry) => [entry.path, entry.provider, entry.usage.input]), [
    ['0', 'github-copilot', 100],
    ['0.0', 'ollama', 200],
  ]);
  assert.equal(JSON.stringify(preview).includes('nested-secret-body'), false);
});

test('full durable details are resolved only through their compact retrieval identity', () => {
  const full = durableMessage();
  const compact = compactDurableMessageDetails(full, sessionPath);
  const reasoningRef = compact.parts?.[0]?.kind === 'reasoning' ? compact.parts[0].detailRef : undefined;
  const toolRef = compact.parts?.[1]?.kind === 'toolCall' ? compact.parts[1].toolCall.detailRef : undefined;
  assert.ok(reasoningRef && toolRef);

  const reasoning = findDurableDetail([full], reasoningRef!);
  const tool = findDurableDetail([full], toolRef!);
  assert.equal(reasoning.status, 'loaded');
  assert.equal(tool.status, 'loaded');
  assert.equal(typeof (reasoning.status === 'loaded' ? reasoning.value : null), 'string');
  assert.equal((tool.status === 'loaded' ? tool.value as { details?: { results?: unknown[] } } : null)?.details?.results?.length, 1);
});

test('transport projection fits its byte budget by dropping mirrors and tightening result retention', () => {
  const subagentResult = {
    details: {
      results: [{
        agent: 'worker',
        task: 'Inspect the long session',
        exitCode: 0,
        messages: [{ role: 'assistant', content: 'x'.repeat(200_000) }],
      }],
    },
  };
  const message: ChatMessage = {
    id: 'assistant-big',
    durableEntryId: 'assistant-big-entry',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'final summary',
    status: 'completed',
    parts: [
      { kind: 'text', text: 'summary text' },
      // Subagent results are always replaced by compact previews + detailRef.
      { kind: 'toolCall', toolCall: { id: 'sub-1', name: 'subagent', input: {}, result: subagentResult, status: 'completed', durableEntryId: 'sub-1-entry' } },
      // 40 medium results: each below the shared 16 KiB threshold individually,
      // but together they blow any reasonable live-event transport budget.
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: 'toolCall' as const,
        toolCall: {
          id: `tool-${index}`, name: 'read', input: { path: `/f/${index}` },
          result: 'r'.repeat(6_000), status: 'completed' as const, durableEntryId: `tool-${index}-entry`,
        },
      })),
    ],
    toolCalls: [
      { id: 'sub-1', name: 'subagent', input: {}, result: subagentResult, status: 'completed', durableEntryId: 'sub-1-entry' },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `tool-${index}`, name: 'read', input: { path: `/f/${index}` },
        result: 'r'.repeat(6_000), status: 'completed' as const, durableEntryId: `tool-${index}-entry`,
      })),
    ],
  };

  const budget = 64 * 1024;
  const projected = compactDurableMessageForTransport(message, sessionPath, budget);
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
  assert.ok(bytes <= budget, `projection ${bytes} must fit budget ${budget}`);

  // Identity, status, and tool structure survive.
  assert.equal(projected.id, 'assistant-big');
  assert.equal(projected.durableEntryId, 'assistant-big-entry');
  assert.equal(projected.status, 'completed');
  assert.equal(projected.parts?.filter((part) => part.kind === 'toolCall').length, 41);
  // Every tool call keeps a retrieval identity; bodies become refs.
  for (const part of projected.parts ?? []) {
    if (part.kind !== 'toolCall') continue;
    assert.ok(part.toolCall.detailRef, `tool ${part.toolCall.id} keeps a detailRef`);
    assert.equal(JSON.stringify(part.toolCall).includes('r'.repeat(1_000)), false);
    assert.equal(JSON.stringify(part.toolCall).includes('x'.repeat(1_000)), false);
  }
  // Legacy mirror entries keep their identity but drop results: `parts` is
  // authoritative, and the host restores the mirror after receipt.
  assert.equal(projected.toolCalls?.length, 41);
  assert.ok(projected.toolCalls?.every((tool) => tool.result === undefined));
  assert.equal(projected.markdown, '');
  assert.equal(projected.thinking, undefined);
});

test('transport projection is byte-identical to the durable projection when already under budget', () => {
  const full = durableMessage();
  const durable = compactDurableMessageDetails(full, sessionPath);
  const projected = compactDurableMessageForTransport(full, sessionPath, 1024 * 1024);
  assert.deepEqual(projected, durable);
  assert.equal(projected.markdown, durable.markdown);
});

test('transport projection pathological fallback keeps identity and a bounded text tail', () => {
  const message: ChatMessage = {
    id: 'assistant-pathological',
    durableEntryId: 'assistant-pathological-entry',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'tail-'.repeat(100_000),
    status: 'completed',
    parts: [{ kind: 'text', text: 'tail-'.repeat(100_000) }],
  };
  const budget = 8 * 1024;
  const projected = compactDurableMessageForTransport(message, sessionPath, budget);
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
  assert.ok(bytes <= budget, `projection ${bytes} must fit budget ${budget}`);
  assert.equal(projected.id, 'assistant-pathological');
  assert.equal(projected.durableEntryId, 'assistant-pathological-entry');
  assert.equal(projected.parts?.[0]?.kind, 'text');
  assert.ok(projected.parts?.[0]?.kind === 'text' && projected.parts[0].text.endsWith('tail-'), 'keeps the tail');
  assert.equal(JSON.stringify(projected).includes('tail-'.repeat(10_000)), false, 'large body is bounded');
});
