import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendLiveTurnAccumulator, LiveTurnCheckpointRegistry, type ToolProgressMeasurement } from '../../../src/backend/live-turn-accumulator';
import { normalizeToolProgress } from '../../../src/backend/tool-progress-normalizer';
import { LIVE_PIPELINE_LIMITS } from '../../../src/shared/live-pipeline-protocol';

function accumulator(observeProgressMeasurement?: (measurement: ToolProgressMeasurement) => void) {
  return new BackendLiveTurnAccumulator({
    protocolVersion: 7,
    sessionPath: '/session.jsonl',
    requestId: 'request',
    turnId: 'turn',
    attemptId: 'attempt',
    canonicalMessageId: 'message',
    modelId: 'provider/model',
    thinkingLevel: 'high',
    startedAt: 100,
  }, observeProgressMeasurement);
}

test('backend accumulator exposes lightweight identity and sequence metadata', () => {
  const value = accumulator();
  assert.equal(value.attemptId, 'attempt');
  assert.equal(value.currentSeq, 0);

  const started = value.observe({ kind: 'turn.started' }, 100);
  assert.equal(value.currentSeq, started.seq);
});

test('backend accumulator propagates operation identity on every semantic envelope and checkpoint', () => {
  const value = new BackendLiveTurnAccumulator({
    protocolVersion: 7,
    sessionPath: '/session.jsonl',
    requestId: 'request',
    operationId: 'operation',
    turnId: 'turn',
    attemptId: 'attempt',
    canonicalMessageId: 'message',
    startedAt: 100,
  });
  const started = value.observe({ kind: 'turn.started' }, 100);
  const text = value.observe({ kind: 'turn.text', delta: 'hello' }, 101);
  const terminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'entry', durableMessage: {
      id: 'message', role: 'assistant', status: 'completed', markdown: 'hello', createdAt: '2026-01-01T00:00:00.000Z',
    },
  }, 102);
  assert.equal(started.operationId, 'operation');
  assert.equal(text.operationId, 'operation');
  assert.equal(terminal.operationId, 'operation');
  assert.equal(value.checkpoint().turn.operationId, 'operation');
});

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
  assert.deepEqual({ kind: rejected?.kind, seq: rejected?.seq }, { kind: 'observation.rejected', seq: 3 });
  assert.equal(value.observe({ kind: 'turn.reasoning', delta: 'plan' }, 130).seq, 4);
  assert.equal(value.checkpoint().checkpointSeq, 4);
  assert.equal(value.checkpoint().turn.modelId, 'provider/model');
  assert.equal(value.checkpoint().turn.thinkingLevel, 'high');
});

test('backend accumulator carries the exact serving provider on turn.started and checkpoints', () => {
  const value = new BackendLiveTurnAccumulator({
    protocolVersion: 7,
    sessionPath: '/session.jsonl',
    requestId: 'request',
    turnId: 'turn',
    attemptId: 'attempt',
    canonicalMessageId: 'message',
    modelId: 'gpt-4o',
    provider: 'azure-openai',
    thinkingLevel: 'high',
    startedAt: 100,
  });
  const started = value.observe({ kind: 'turn.started' }, 100);
  assert.equal(started.kind, 'turn.started');
  assert.equal(started.kind === 'turn.started' ? started.modelId : undefined, 'gpt-4o');
  assert.equal(started.kind === 'turn.started' ? started.provider : undefined, 'azure-openai');
  assert.equal(started.kind === 'turn.started' ? started.thinkingLevel : undefined, 'high');
  // The checkpoint repair path is the recovery authority: the same serving
  // identity must survive it for host-side reconciliation.
  const checkpoint = value.checkpoint();
  assert.equal(checkpoint.turn.modelId, 'gpt-4o');
  assert.equal(checkpoint.turn.provider, 'azure-openai');
  assert.equal(checkpoint.turn.thinkingLevel, 'high');
});

test('backend accumulator retains ordered sibling drafts and promotes only the matching call', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({ kind: 'turn.reasoning', delta: 'plan' }, 101);
  value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId: 'tool-a', name: 'read' }, 102);
  value.observe({ kind: 'turn.text', delta: 'between' }, 103);
  value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId: 'tool-b', name: 'bash' }, 104);
  value.observe({
    kind: 'turn.toolDraft', action: 'delta', toolCallId: 'tool-a', name: 'read',
    argumentsJsonDelta: '{"path":',
  }, 105);
  const ready = value.observe({
    kind: 'turn.toolDraft', action: 'end', toolCallId: 'tool-a', name: 'read',
    argumentsJson: '{"path":"README.md"}',
  }, 106);
  assert.equal(ready?.kind === 'turn.toolDraft' ? ready.draft.phase : undefined, 'ready');
  assert.deepEqual(value.checkpoint().turn.parts, [
    { kind: 'reasoning', text: 'plan' },
    { kind: 'tool', toolCallId: 'tool-a' },
    { kind: 'text', text: 'between' },
    { kind: 'tool', toolCallId: 'tool-b' },
  ]);

  // Duplicate provider boundaries are idempotent and cannot reset finalized JSON.
  value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId: 'tool-a', name: 'read' }, 107);
  value.observe({
    kind: 'turn.toolDraft', action: 'end', toolCallId: 'tool-a', name: 'read',
    argumentsJson: '{"path":"README.md"}',
  }, 108);
  value.observe({
    kind: 'tool.started', executionId: 'exec-a', parentExecutionId: null, rootExecutionId: 'exec-a',
    toolCallId: 'tool-a', name: 'read', input: { path: 'README.md' }, startedAt: 109,
  }, 109);
  const checkpoint = value.checkpoint();
  assert.equal(checkpoint.turn.toolDraftsByCallId['tool-a'], undefined);
  assert.equal(checkpoint.turn.toolDraftsByCallId['tool-b']?.phase, 'drafting');
  assert.equal(checkpoint.turn.parts.filter((part) => part.kind === 'tool').length, 2);
  assert.ok(checkpoint.turn.aggregateToolDraftBytes > 0);
  const promotedSeq = checkpoint.checkpointSeq;
  assert.equal(value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId: 'tool-a', name: 'read' }, 110), undefined);
  assert.equal(value.observe({
    kind: 'turn.toolDraft', action: 'end', toolCallId: 'tool-a', name: 'read',
    argumentsJson: '{"path":"README.md"}',
  }, 111), undefined);
  assert.equal(value.checkpoint().checkpointSeq, promotedSeq);
  assert.equal(value.checkpoint().turn.toolDraftsByCallId['tool-a'], undefined);
});

test('prototype-like tool-call IDs remain ordinary Record keys', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const observed = value.observe({
    kind: 'turn.toolDraft', action: 'start', toolCallId: 'constructor', name: 'Object',
  }, 101);
  assert.equal(observed?.kind, 'turn.toolDraft');
  assert.equal(
    Object.values(value.checkpoint().turn.toolDraftsByCallId).find((draft) => draft.toolCallId === 'constructor')?.toolCallId,
    'constructor',
  );
});

test('backend accumulator rejects malformed and oversized draft observations and clears drafts at terminal', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const missingStart = value.observe({
    kind: 'turn.toolDraft', action: 'delta', toolCallId: 'missing', name: 'bash', argumentsJsonDelta: '{}',
  }, 101);
  assert.equal(missingStart?.kind, 'observation.rejected');
  value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId: 'large', name: 'bash' }, 102);
  const oversize = value.observe({
    kind: 'turn.toolDraft', action: 'delta', toolCallId: 'large', name: 'bash',
    argumentsJsonDelta: 'x'.repeat(64 * 1024 + 1),
  }, 103);
  assert.equal(oversize?.kind, 'observation.rejected');

  let aggregateRejected = false;
  for (let index = 0; index < 40 && !aggregateRejected; index += 1) {
    const toolCallId = `aggregate-${index}`;
    value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId, name: 'bash' }, 200 + index * 2);
    const observation = value.observe({
      kind: 'turn.toolDraft', action: 'delta', toolCallId, name: 'bash',
      argumentsJsonDelta: 'y'.repeat(64 * 1024),
    }, 201 + index * 2);
    aggregateRejected = observation?.kind === 'observation.rejected';
  }
  assert.equal(aggregateRejected, true, 'aggregate draft bytes remain bounded across sibling calls');
  value.observe({
    kind: 'turn.terminal', terminalKind: 'interrupted', durableEntryId: 'terminal-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(104).toISOString(), markdown: '',
      status: 'interrupted', durableEntryId: 'terminal-entry',
    },
  }, 104);
  assert.deepEqual(value.checkpoint().turn.toolDraftsByCallId, {});
  assert.equal(value.checkpoint().turn.aggregateToolDraftBytes, 0);
});

test('backend accumulator rejects tool starts and progress after aborting', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'bash', input: {}, startedAt: 101,
  }, 101);
  value.observe({ kind: 'turn.phase', phase: 'aborting' }, 102);
  const progress = value.observe({
    kind: 'tool.progress', executionId: 'execution', preview: { kind: 'generic', summary: 'late' },
  }, 103);
  const start = value.observe({
    kind: 'tool.started', executionId: 'late-execution', parentExecutionId: null, rootExecutionId: 'late-execution',
    toolCallId: 'late-tool', name: 'read', input: {}, startedAt: 104,
  }, 104);
  assert.equal(progress?.kind, 'observation.rejected');
  assert.equal(start.kind, 'observation.rejected');
  assert.equal(value.checkpoint().tools.length, 1);
});

test('normal subagent normalization feeds a JSON-safe accumulator snapshot', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 110,
  }, 110);
  const preview = normalizeToolProgress('subagent', {
    details: { mode: 'single', results: [{ agent: 'worker', task: 'work', exitCode: -1, messages: [] }] },
  });
  const progress = value.observe({ kind: 'tool.progress', executionId: 'execution', preview }, 120);
  assert.equal(progress?.kind, 'tool.progress');
  assert.equal(progress?.kind === 'tool.progress' ? progress.update.kind : undefined, 'snapshot');
});

test('backend accumulator preserves completed ask_user answers for the live transcript', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'ask-execution', parentExecutionId: null, rootExecutionId: 'ask-execution',
    toolCallId: 'ask-tool', name: 'ask_user',
    input: { question: 'Choose a scope', options: ['Focused fix', 'Broader cleanup'] }, startedAt: 110,
  }, 110);
  const result = {
    content: [{ type: 'text', text: 'Focused fix' }],
    details: { answer: 'Focused fix', source: 'option', cancelled: false },
    isError: false,
  };

  const terminal = value.observe({
    kind: 'tool.terminal', executionId: 'ask-execution', status: 'completed', result,
    durableEntryId: 'ask-entry',
  }, 120);

  assert.equal(terminal.kind, 'tool.terminal');
  assert.deepEqual(terminal.kind === 'tool.terminal' ? terminal.result : undefined, result);
  assert.deepEqual(value.checkpoint().tools[0]?.terminal?.result, result);
});

test('backend accumulator emits a measurement per diff observation, including duplicates', () => {
  const measurements: ToolProgressMeasurement[] = [];
  const value = accumulator((measurement) => measurements.push(measurement));
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 110,
  }, 110);
  const preview = {
    kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
    children: [{ id: 'worker', phase: 'running' as const, streamingText: 'progress', messages: [] }],
  };
  const changed = value.observe({ kind: 'tool.progress', executionId: 'execution', preview }, 120);
  assert.equal(changed?.kind, 'tool.progress');
  const duplicate = value.observe({ kind: 'tool.progress', executionId: 'execution', preview }, 121);
  assert.equal(duplicate, undefined, 'a structurally equal source preview is a duplicate observation');
  assert.deepEqual(measurements.map((measurement) => measurement.outcome), ['changed', 'duplicate']);
  assert.equal(measurements[0]?.revision, 1);
  assert.equal(measurements[1]?.revision, 1, 'the duplicate carries the candidate existing progress revision');
  assert.equal(value.currentSeq, changed?.seq, 'duplicate observations consume no semantic sequence');
});

test('backend accumulator emits one full subagent preview then incremental patches and suppresses duplicates', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 110,
  }, 110);
  const initialPreview = {
    kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
    children: [{ id: 'worker', phase: 'running' as const, streamingText: 'x'.repeat(10_000), messages: [] }],
  };
  const initial = value.observe({ kind: 'tool.progress', executionId: 'execution', preview: initialPreview }, 120);
  assert.equal(initial?.kind, 'tool.progress');
  if (initial?.kind !== 'tool.progress') return;
  assert.equal(initial.update.kind, 'snapshot');
  assert.equal(initial.baseProgressRevision, 0);

  assert.equal(value.observe({ kind: 'tool.progress', executionId: 'execution', preview: initialPreview }, 121), undefined);
  assert.equal(value.checkpoint().checkpointSeq, initial.seq, 'duplicate SDK snapshots consume no sequence');

  const nextPreview = {
    ...initialPreview,
    children: [{ ...initialPreview.children[0]!, streamingText: `${initialPreview.children[0]!.streamingText} world`, messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'nested transcript' }] },
    ] }],
  };
  const patch = value.observe({ kind: 'tool.progress', executionId: 'execution', preview: nextPreview }, 130);
  assert.equal(patch?.kind, 'tool.progress');
  if (patch?.kind !== 'tool.progress') return;
  assert.equal(patch.update.kind, 'patch');
  assert.equal(patch.baseSeq, initial.seq);
  assert.equal(patch.baseProgressRevision, 1);
  assert.equal(patch.progressRevision, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(patch), 'utf8') < Buffer.byteLength(JSON.stringify(nextPreview), 'utf8'));
  assert.deepEqual(value.checkpoint().tools[0]?.preview, nextPreview, 'checkpoint retains the fully assembled preview');
});

test('backend accumulator checkpoints transient execution end and upgrades only to a matching durable terminal', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'read', input: {}, startedAt: 110,
  }, 110);
  value.observe({
    kind: 'tool.progress', executionId: 'execution', preview: { kind: 'generic', summary: 'preview' },
  }, 115);
  const checkpointBytesBeforeEnd = value.checkpoint().checkpointBytes;

  const ended = value.observe({
    kind: 'tool.executionEnded', executionId: 'execution', status: 'completed', durationMs: 25,
  }, 120);
  assert.equal(ended.kind, 'tool.executionEnded');
  assert.ok(
    value.checkpoint().checkpointBytes <= checkpointBytesBeforeEnd,
    'active checkpoint accounting reserves the execution-end boundary before accepting progress',
  );
  assert.deepEqual(value.checkpoint().tools[0]?.executionEnd, { status: 'completed', durationMs: 25 });
  assert.equal(value.checkpoint().tools[0]?.terminal, undefined, 'execution end is not durability evidence');
  assert.deepEqual(value.checkpoint().tools[0]?.preview, { kind: 'generic', summary: 'preview' });

  const lateProgress = value.observe({
    kind: 'tool.progress', executionId: 'execution', preview: { kind: 'generic', summary: 'late' },
  }, 121);
  assert.equal(lateProgress?.kind, 'observation.rejected');
  const mismatched = value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'failed', result: 'wrong',
    durationMs: 25, durableEntryId: 'wrong-entry',
  }, 122);
  assert.equal(mismatched.kind, 'observation.rejected');

  const terminal = value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'completed', result: 'done',
    durationMs: 25, durableEntryId: 'tool-entry',
  }, 123);
  assert.equal(terminal.kind, 'tool.terminal');
  assert.equal(value.checkpoint().tools[0]?.terminal?.durableEntryId, 'tool-entry');
  assert.deepEqual(value.checkpoint().tools[0]?.executionEnd, { status: 'completed', durationMs: 25 });
});

test('backend accumulator ignores duplicate durability-confirmed tool completion', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'read', input: {}, startedAt: 110,
  }, 110);
  const firstToolTerminal = value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'completed', result: 'done', durableEntryId: 'tool-entry',
  }, 120);
  const toolSeq = value.currentSeq;
  const duplicateToolTerminal = value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'completed', result: 'done', durableEntryId: 'tool-entry',
  }, 121);
  assert.equal(firstToolTerminal?.kind, 'tool.terminal');
  assert.equal(duplicateToolTerminal, undefined);
  assert.equal(value.currentSeq, toolSeq, 'duplicate tool completion does not consume a sequence');

  const firstTurnTerminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(), markdown: 'done',
      status: 'completed', durableEntryId: 'assistant-entry',
    },
  }, 130);
  const turnSeq = value.currentSeq;
  const duplicateTurnTerminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(), markdown: 'done',
      status: 'completed', durableEntryId: 'assistant-entry',
    },
  }, 131);
  assert.equal(firstTurnTerminal?.kind, 'turn.terminal');
  assert.equal(duplicateTurnTerminal, undefined);
  assert.equal(value.currentSeq, turnSeq, 'duplicate assistant completion does not consume a sequence');
  assert.equal(value.lifecycleWatermark()?.finalSeq, turnSeq);
});

test('backend accumulator rejects progress after a durability-confirmed tool terminal', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null, rootExecutionId: 'execution',
    toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 110,
  }, 110);
  value.observe({
    kind: 'tool.terminal', executionId: 'execution', status: 'completed', result: 'done', durableEntryId: 'entry',
  }, 120);
  const late = value.observe({
    kind: 'tool.progress', executionId: 'execution', preview: { kind: 'generic', summary: 'late' },
  }, 130);
  assert.equal(late?.kind, 'observation.rejected');
  assert.equal(value.checkpoint().tools[0]?.preview, undefined);
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

test('durable terminal envelope replaces large tool and reasoning bodies with retrieval metadata', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const largeResult = { details: { results: [{ agent: 'worker', messages: [{ content: 'x'.repeat(64 * 1024) }] }] } };
  const reasoning = 'plan '.repeat(8_000);
  const terminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(), markdown: 'done',
      thinking: reasoning, status: 'completed', durableEntryId: 'assistant-entry',
      parts: [
        { kind: 'reasoning', text: reasoning },
        { kind: 'toolCall', toolCall: {
          id: 'tool', name: 'subagent', input: {}, result: largeResult,
          status: 'completed', durableEntryId: 'tool-entry',
        } },
      ],
      toolCalls: [{
        id: 'tool', name: 'subagent', input: {}, result: largeResult,
        status: 'completed', durableEntryId: 'tool-entry',
      }],
    },
  }, 130);

  assert.equal(terminal.kind, 'turn.terminal');
  if (terminal.kind !== 'turn.terminal') return;
  const tool = terminal.durableMessage.parts?.[1]?.kind === 'toolCall'
    ? terminal.durableMessage.parts[1].toolCall
    : undefined;
  assert.equal(
    ((tool?.result as { details?: { results?: Array<{ agent?: string }> } } | undefined)
      ?.details?.results?.[0]?.agent),
    'worker',
  );
  assert.equal(tool?.detailRef?.childCount, 1);
  assert.ok(terminal.durableMessage.parts?.[0]?.kind === 'reasoning'
    && terminal.durableMessage.parts[0].detailRef);
  assert.equal(JSON.stringify(terminal).includes('x'.repeat(1_000)), false);
  assert.equal(JSON.stringify(value.checkpoint()).includes('x'.repeat(1_000)), false);
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
  const actualBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  assert.ok(actualBytes < 2 * 1024 * 1024);
  assert.ok(actualBytes <= checkpoint.checkpointBytes, 'many compact metadata records remain canonically accounted');
});

test('checkpoint pressure compacts oldest durability-confirmed details before rejecting new live work', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'settled', parentExecutionId: null, rootExecutionId: 'settled',
    toolCallId: 'settled-tool', name: 'ask_user', input: {}, startedAt: 101,
  }, 101);
  value.observe({
    kind: 'tool.terminal', executionId: 'settled', status: 'completed',
    result: { answer: 'a'.repeat(4 * 1024 * 1024) }, durableEntryId: 'settled-entry',
  }, 102);
  value.observe({
    kind: 'tool.started', executionId: 'running', parentExecutionId: null, rootExecutionId: 'running',
    toolCallId: 'running-tool', name: 'subagent', input: {}, startedAt: 103,
  }, 103);
  const accepted = value.observe({
    kind: 'tool.progress', executionId: 'running', preview: {
      kind: 'subagent', mode: 'single', omittedChildren: 0,
      children: [{ id: 'worker', phase: 'running', streamingText: 'x'.repeat(27 * 1024 * 1024), messages: [] }],
    },
  }, 104);
  assert.equal(accepted?.kind, 'tool.progress');
  const checkpoint = value.checkpoint();
  assert.equal((checkpoint.tools[0]?.terminal?.result as { liveCompacted?: boolean }).liveCompacted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') <= checkpoint.checkpointBytes);
});

test('terminal checkpoint pressure compacts settled details before accepting terminalization', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'settled', parentExecutionId: null, rootExecutionId: 'settled',
    toolCallId: 'settled-tool', name: 'ask_user', input: {}, startedAt: 101,
  }, 101);
  assert.equal(value.observe({
    kind: 'tool.terminal', executionId: 'settled', status: 'completed',
    result: { answer: 'a'.repeat(27 * 1024 * 1024) }, durableEntryId: 'settled-entry',
  }, 102).kind, 'tool.terminal');

  const terminal = value.observe({
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(103).toISOString(),
      markdown: 'x'.repeat(4 * 1024 * 1024), status: 'completed', durableEntryId: 'assistant-entry',
    },
  }, 103);
  assert.equal(terminal.kind, 'turn.terminal');
  const checkpoint = value.checkpoint();
  assert.equal((checkpoint.tools[0]?.terminal?.result as { liveCompacted?: boolean }).liveCompacted, true);
  const actualBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  assert.ok(actualBytes <= checkpoint.checkpointBytes);
  assert.ok(checkpoint.checkpointBytes <= LIVE_PIPELINE_LIMITS.terminalCheckpointBytes);
  assert.equal(value.lifecycleWatermark()?.finalSeq, terminal.seq);
});

test('canonical checkpoint capacity includes escaping, drafts, previews, tool metadata, and envelope bytes', () => {
  const value = accumulator();
  const started = value.observe({ kind: 'turn.started' }, 100);
  assert.ok(started.checkpointBytes > 0);

  // Raw UTF-8 counters alone understate these strings because each newline is
  // escaped in the checkpoint JSON.
  assert.equal(value.observe({ kind: 'turn.text', delta: '\n'.repeat(192 * 1024) }, 101).kind, 'turn.text');
  assert.equal(value.observe({ kind: 'turn.reasoning', delta: '\\"'.repeat(128 * 1024) }, 102).kind, 'turn.reasoning');
  for (let index = 0; index < 8; index += 1) {
    const toolCallId = `draft-${index}`;
    value.observe({ kind: 'turn.toolDraft', action: 'start', toolCallId, name: 'bash' }, 110 + index * 2);
    assert.equal(value.observe({
      kind: 'turn.toolDraft', action: 'delta', toolCallId, name: 'bash',
      argumentsJsonDelta: '\n'.repeat(24 * 1024),
    }, 111 + index * 2)?.kind, 'turn.toolDraft');
  }
  value.observe({
    kind: 'tool.started', executionId: 'aggregate-execution', parentExecutionId: null,
    rootExecutionId: 'aggregate-execution', toolCallId: 'aggregate-tool', name: 'subagent',
    input: { task: 'recursive' }, startedAt: 140,
  }, 140);
  const acceptedPreview = {
    kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
    children: [{ id: 'worker', phase: 'running' as const, streamingText: 'x'.repeat(27 * 1024 * 1024), messages: [] }],
  };
  const accepted = value.observe({
    kind: 'tool.progress', executionId: 'aggregate-execution', preview: acceptedPreview,
  }, 141);
  assert.equal(accepted?.kind, 'tool.progress');
  const checkpoint = value.checkpoint();
  const actualBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  assert.equal(checkpoint.checkpointBytes, checkpoint.turn.checkpointBytes);
  assert.ok(actualBytes <= checkpoint.checkpointBytes, `${actualBytes} <= ${checkpoint.checkpointBytes}`);
  assert.ok(checkpoint.checkpointBytes <= LIVE_PIPELINE_LIMITS.checkpointBytes);

  const rejected = value.observe({
    kind: 'tool.progress', executionId: 'aggregate-execution', preview: {
      ...acceptedPreview,
      children: [{ ...acceptedPreview.children[0]!, streamingText: 'x'.repeat(29 * 1024 * 1024) }],
    },
  }, 142);
  assert.equal(rejected?.kind, 'observation.rejected');
  assert.equal(rejected?.kind === 'observation.rejected' ? rejected.reason : undefined, 'payload_oversize');
  assert.equal(
    (value.checkpoint().tools[0]?.preview as { children?: Array<{ streamingText?: string }> }).children?.[0]?.streamingText?.length,
    27 * 1024 * 1024,
    'unrepresentable progress is rejected before replacing canonical state',
  );
});

test('checkpoint accounting reserves sequence-width growth across rejected observations', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);

  for (const boundary of [10, 100]) {
    while (value.currentSeq < boundary - 1) {
      value.reject('malformed_observation', 100 + value.currentSeq);
    }

    const before = value.checkpoint();
    const beforeActual = Buffer.byteLength(JSON.stringify(before), 'utf8');
    assert.ok(
      before.checkpointBytes - beforeActual >= 3,
      `sequence ${boundary - 1} checkpoint must reserve the ${boundary} digit-width transition`,
    );

    const rejected = value.reject('payload_oversize', 100 + boundary);
    assert.equal(rejected.seq, boundary);
    const after = value.checkpoint();
    const afterActual = Buffer.byteLength(JSON.stringify(after), 'utf8');
    assert.ok(afterActual <= after.checkpointBytes, `${afterActual} <= ${after.checkpointBytes}`);
    assert.ok(after.checkpointBytes <= LIVE_PIPELINE_LIMITS.checkpointBytes);
  }
});

test('backend accumulator rejects a second tool.started reusing a durability-confirmed tool-call id', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'exec-a', parentExecutionId: null, rootExecutionId: 'exec-a',
    toolCallId: 'tool-a', name: 'read', input: { path: 'x' }, startedAt: 101,
  }, 101);
  value.observe({
    kind: 'tool.terminal', executionId: 'exec-a', status: 'completed', result: 'ok', durableEntryId: 'entry-a',
  }, 102);
  const duplicate = value.observe({
    kind: 'tool.started', executionId: 'exec-b', parentExecutionId: null, rootExecutionId: 'exec-b',
    toolCallId: 'tool-a', name: 'read', input: { path: 'y' }, startedAt: 103,
  }, 103);
  assert.equal(duplicate.kind, 'observation.rejected');
  assert.equal(value.checkpoint().tools.length, 1);
  assert.equal(value.checkpoint().tools[0]?.terminal?.durableEntryId, 'entry-a');
});

test('backend accumulator counts toolDraftBytes against the complete serialized draft payload', () => {
  const value = accumulator();
  value.observe({ kind: 'turn.started' }, 100);
  const oversizedId = 'id-'.repeat(30_000);
  const rejectedId = value.observe({
    kind: 'turn.toolDraft', action: 'start', toolCallId: oversizedId, name: 'read',
  }, 101);
  assert.equal(rejectedId?.kind, 'observation.rejected');

  const oversizedName = 'n'.repeat(70 * 1024);
  const rejectedName = value.observe({
    kind: 'turn.toolDraft', action: 'start', toolCallId: 'ok-id', name: oversizedName,
  }, 102);
  assert.equal(rejectedName?.kind, 'observation.rejected');

  const accepted = value.observe({
    kind: 'turn.toolDraft', action: 'start', toolCallId: 'normal', name: 'read',
  }, 103);
  assert.equal(accepted?.kind, 'turn.toolDraft');
  assert.equal(value.checkpoint().turn.toolDraftsByCallId.normal?.name, 'read');
});

test('compact trace reuses exact preview/envelope counters without a second recursive stringify', () => {
  let measurement: {
    sourcePayloadBytes?: number; producedPayloadBytes?: number;
    availabilityReason?: string;
    counters?: { childCount: number; messageCount: number; maxRecursiveDepth: number };
  } | undefined;
  const value = new BackendLiveTurnAccumulator({
    protocolVersion: 7, sessionPath: '/session.jsonl', requestId: 'request', turnId: 'turn',
    attemptId: 'attempt', canonicalMessageId: 'message', startedAt: 100,
  }, (candidate) => { measurement = candidate; });
  value.observe({ kind: 'turn.started' }, 100);
  value.observe({
    kind: 'tool.started', executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 110,
  }, 110);
  const counters = { childCount: 2, messageCount: 3, maxRecursiveDepth: 2 };
  const preview = normalizeToolProgress('subagent', {
    details: { mode: 'single', results: [{
      agent: 'outer', messages: [{ role: 'toolResult', toolName: 'subagent', details: {
        mode: 'single', results: [{ agent: 'inner', messages: [{ role: 'assistant', content: 'done' }] }],
      } }],
    }] },
  });
  const originalStringify = JSON.stringify;
  let recursivePreviewStringifies = 0;
  JSON.stringify = ((candidate: unknown, ...args: unknown[]) => {
    if (candidate === preview) recursivePreviewStringifies += 1;
    return (originalStringify as (...values: unknown[]) => string)(candidate, ...args);
  }) as typeof JSON.stringify;
  let envelope;
  try {
    envelope = value.observe({ kind: 'tool.progress', executionId: 'execution', preview, recursiveCounters: counters }, 120);
    assert.ok(envelope);
    assert.equal(recursivePreviewStringifies, 1, 'aggregate accounting is the only complete-preview stringify');
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.equal(measurement?.sourcePayloadBytes, undefined, 'normalized ToolPreview bytes are not source bytes');
  assert.equal(measurement?.availabilityReason, 'source_preview_not_serialized_at_producer_boundary');
  assert.equal(measurement?.producedPayloadBytes, Buffer.byteLength(originalStringify(envelope), 'utf8'));
  assert.deepEqual(measurement?.counters, counters);
});

test('terminal checkpoint registry is memory-only and bounded by grace', () => {
  const registry = new LiveTurnCheckpointRegistry();
  const value = accumulator();
  registry.setActive('/session.jsonl', value);
  registry.retainTerminal('/session.jsonl', 200);
  assert.equal(registry.get('/session.jsonl', 199), value);
  assert.equal(registry.get('/session.jsonl', 200), undefined);
});
