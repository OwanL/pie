import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendLiveTurnAccumulator, LiveTurnCheckpointRegistry } from '../../../src/backend/live-turn-accumulator';

function accumulator() {
  return new BackendLiveTurnAccumulator({
    protocolVersion: 4,
    sessionPath: '/session.jsonl',
    requestId: 'request',
    turnId: 'turn',
    attemptId: 'attempt',
    canonicalMessageId: 'message',
    startedAt: 100,
  });
}

test('backend accumulator reserves every candidate sequence including rejections', () => {
  const value = accumulator();
  assert.equal(value.observe({ kind: 'turn.started' }, 100).seq, 1);
  assert.equal(value.observe({ kind: 'turn.text', delta: 'hello' }, 110).seq, 2);
  const rejected = value.observe({
    kind: 'tool.progress', executionId: 'missing', preview: { kind: 'generic', summary: 'safe' },
  }, 120);
  assert.deepEqual({ kind: rejected.kind, seq: rejected.seq }, { kind: 'observation.rejected', seq: 3 });
  assert.equal(value.observe({ kind: 'turn.reasoning', delta: 'plan' }, 130).seq, 4);
  assert.equal(value.checkpoint().checkpointSeq, 4);
});

test('backend terminal checkpoint and independently delivered watermark share final sequence', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'read', input: {}, startedAt: 110,
  }, 110);
  value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'completed', result: 'ok', durableEntryId: 'tool-entry',
  }, 120);
  const terminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(), markdown: 'done',
      status: 'completed', durableEntryId: 'assistant-entry',
    },
  }, 130);

  const checkpoint = value.checkpoint();
  const watermark = value.lifecycleWatermark();
  assert.equal(checkpoint.terminal?.durableEntryId, 'assistant-entry');
  assert.equal(checkpoint.tools[0]?.terminal?.durableEntryId, 'tool-entry');
  assert.equal(watermark?.finalSeq, terminal.seq);
  assert.equal(checkpoint.checkpointSeq, terminal.seq);
});

test('backend accumulator rejects aggregate alternating content above checkpoint-safe bounds', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const quarter = 'x'.repeat(256 * 1024);
  assert.equal(value.observe({ kind: 'turn.text', delta: quarter }, 110).kind, 'turn.text');
  assert.equal(value.observe({ kind: 'turn.reasoning', delta: quarter }, 120).kind, 'turn.reasoning');
  assert.equal(value.observe({ kind: 'turn.text', delta: quarter }, 130).kind, 'turn.text');
  const rejected = value.observe({ kind: 'turn.text', delta: 'x' }, 140);
  assert.deepEqual({ kind: rejected.kind, reason: rejected.kind === 'observation.rejected' ? rejected.reason : undefined }, {
    kind: 'observation.rejected', reason: 'payload_oversize',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(value.checkpoint()), 'utf8') < 2 * 1024 * 1024);
});

test('large durable tool results are compacted for live state instead of aborting a long tool turn', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  for (let index = 0; index < 40; index += 1) {
    const executionId = `execution-${index}`;
    const started = value.observe({
      kind: 'tool.started', executionId, parentExecutionId: null, rootExecutionId: executionId,
      toolCallId: `tool-${index}`, name: 'read', input: {}, startedAt: 110 + index,
    }, 110 + index);
    assert.equal(started.kind, 'tool.started');
    const terminal = value.observe({
      kind: 'tool.terminal', executionId, status: 'completed',
      result: 'x'.repeat(100 * 1024), durableEntryId: `entry-${index}`,
    }, 200 + index);
    assert.equal(terminal.kind, 'tool.terminal');
  }
  const checkpoint = value.checkpoint();
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') < 2 * 1024 * 1024);
  assert.equal(checkpoint.tools.length, 40);
  assert.ok(checkpoint.tools.every((tool) => tool.terminal?.durableEntryId));
});

test('large and cyclic tool inputs are bounded instead of creating checkpoint storms', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const cyclic: Record<string, unknown> = { task: 'x'.repeat(100 * 1024), marker: 1n };
  cyclic.self = cyclic;

  for (let index = 0; index < 64; index += 1) {
    const executionId = `large-input-${index}`;
    const started = value.observe({
      kind: 'tool.started', executionId, parentExecutionId: null, rootExecutionId: executionId,
      toolCallId: `large-tool-${index}`, name: 'subagent', input: cyclic, startedAt: 110 + index,
    }, 110 + index);
    assert.equal(started.kind, 'tool.started', `tool ${index} should remain representable`);
    if (started.kind === 'tool.started') {
      assert.ok(Buffer.byteLength(JSON.stringify(started.input), 'utf8') <= 3 * 1024);
    }
  }

  const checkpoint = value.checkpoint();
  assert.equal(checkpoint.tools.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') < 2 * 1024 * 1024);
});

test('terminal checkpoint registry is memory-only and bounded by grace', () => {
  const registry = new LiveTurnCheckpointRegistry();
  const value = accumulator();
  registry.setActive('/session.jsonl', value);
  registry.retainTerminal('/session.jsonl', 200);
  assert.equal(registry.get('/session.jsonl', 199), value);
  assert.equal(registry.get('/session.jsonl', 200), undefined);
});
