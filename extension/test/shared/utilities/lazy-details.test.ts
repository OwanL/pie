import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactDurableMessageDetails,
  compactToolCallDetail,
  findDurableDetail,
} from '../../../src/shared/lazy-details';
import type { ChatMessage } from '../../../src/shared/protocol';

const sessionPath = '/session.jsonl';

function durableMessage(): ChatMessage {
  const reasoning = 'reasoning '.repeat(4_000);
  const result = {
    details: {
      results: [{ agent: 'worker', exitCode: 0, messages: [{ role: 'assistant', content: 'x'.repeat(32_000) }] }],
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
  assert.equal(tool?.result, undefined);
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
  assert.equal(compacted.result, undefined);
  assert.equal(compacted.detailRef?.summary, '2 subagent children');
  assert.equal(compacted.detailRef?.childCount, 2);
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
