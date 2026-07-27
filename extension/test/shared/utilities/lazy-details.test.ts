import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactDurableMessageDetails,
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
