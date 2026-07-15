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
    modelId: 'provider/model',
    thinkingLevel: 'high',
    startedAt: 100,
  });
}

test('backend accumulator reserves every candidate sequence including rejections', () => {
  const value = accumulator();
  const started = value.observe({ kind: 'turn.started' }, 100);
  assert.equal(started.seq, 1);
  assert.equal(started.kind === 'turn.started' ? started.modelId : undefined, 'provider/model');
  assert.equal(started.kind === 'turn.started' ? started.thinkingLevel : undefined, 'high');
  assert.equal(value.observe({ kind: 'turn.text', delta: 'hello' }, 110).seq, 2);
  const rejected = value.observe({
    kind: 'tool.progress', executionId: 'missing', preview: { kind: 'generic', summary: 'safe' },
  }, 120);
  assert.deepEqual({ kind: rejected.kind, seq: rejected.seq }, { kind: 'observation.rejected', seq: 3 });
  assert.equal(value.observe({ kind: 'turn.reasoning', delta: 'plan' }, 130).seq, 4);
  assert.equal(value.checkpoint().checkpointSeq, 4);
  assert.equal(value.checkpoint().turn.modelId, 'provider/model');
  assert.equal(value.checkpoint().turn.thinkingLevel, 'high');
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

test('large durability-confirmed terminal messages do not abort an otherwise completed turn', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const terminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(),
      markdown: 'x'.repeat(3 * 1024 * 1024), status: 'completed', durableEntryId: 'assistant-entry',
    },
  }, 130);

  assert.equal(terminal.kind, 'turn.terminal');
  const checkpointBytes = Buffer.byteLength(JSON.stringify(value.checkpoint()), 'utf8');
  assert.ok(checkpointBytes > 2 * 1024 * 1024);
  assert.ok(checkpointBytes < 24 * 1024 * 1024);
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

test('large and cyclic tool inputs are bounded without imposing a total tool-count limit', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const cyclic: Record<string, unknown> = { task: 'x'.repeat(100 * 1024), marker: 1n };
  cyclic.self = cyclic;

  for (let index = 0; index < 256; index += 1) {
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
  assert.equal(checkpoint.tools.length, 256);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') < 2 * 1024 * 1024);
});

test('settled tool history is semantically compacted while recent tool UX details remain available', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);

  for (let index = 0; index < 1_000; index += 1) {
    const executionId = `execution-${index}`;
    assert.equal(value.observe({
      kind: 'tool.started', executionId, parentExecutionId: null, rootExecutionId: executionId,
      toolCallId: `tool-${index}`, name: 'read', input: { path: `/large/${'x'.repeat(2_000)}/${index}` }, startedAt: 110 + index,
    }, 110 + index).kind, 'tool.started');
    assert.equal(value.observe({
      kind: 'tool.terminal', executionId, status: 'completed', result: 'y'.repeat(8_000),
      durableEntryId: `entry-${index}`,
    }, 2_000 + index).kind, 'tool.terminal');
  }

  const checkpoint = value.checkpoint();
  assert.equal(checkpoint.tools.length, 1_000);
  assert.equal((checkpoint.tools[0]?.immutableInput as { liveCompacted?: boolean }).liveCompacted, true);
  assert.equal((checkpoint.tools[0]?.terminal?.result as { liveCompacted?: boolean }).liveCompacted, true);
  assert.equal((checkpoint.tools.at(-1)?.terminal?.result as { kind?: string }).kind, 'text');
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
