import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLiveTurnCheckpoint } from '../../../../src/host/core/live-pipeline/checkpoint';
import { interruptLivePipelineForRestart } from '../../../../src/host/core/live-pipeline/cleanup';
import { createEmptyLivePipelineState, pruneExpiredTerminalAttempts } from '../../../../src/host/core/live-pipeline/model';
import { projectTranscriptView } from '../../../../src/host/core/live-pipeline/projection';
import { applyLiveSemanticEnvelope } from '../../../../src/host/core/live-pipeline/transitions';
import type { LiveTurnCheckpoint, TurnSemanticEnvelope } from '../../../../src/shared/live-pipeline-protocol';
import { diffJsonValues, type JsonSafeValue } from '../../../../src/shared/json-structural-patch';
import { transcriptRenderSignature } from '../../../../src/shared/transcript-render-signature';

const base = {
  protocolVersion: 5,
  sessionPath: '/session.jsonl',
  requestId: 'request-1',
  turnId: 'turn-1',
  attemptId: 'attempt-1',
  occurredAt: 1_000,
};

function start(seq = 1): TurnSemanticEnvelope {
  return { ...base, kind: 'turn.started', seq, canonicalMessageId: 'message-1', startedAt: 900 };
}

function apply(state: ReturnType<typeof createEmptyLivePipelineState>, event: TurnSemanticEnvelope) {
  return applyLiveSemanticEnvelope(state, event, 20_000);
}

test('live transition engine isolates attempts, detects gaps and never mutates prior state', () => {
  const empty = createEmptyLivePipelineState();
  const started = apply(empty, start());
  assert.equal(started.classification, 'applied');
  const startedState = started.state;
  assert.equal(empty.turnsBySession[base.sessionPath], undefined);

  const text = apply(startedState, { ...base, kind: 'turn.text', seq: 2, occurredAt: 1_100, delta: 'hel' });
  assert.equal(text.classification, 'applied');
  assert.deepEqual(startedState.turnsBySession[base.sessionPath]?.parts, []);

  const gap = apply(text.state, { ...base, kind: 'turn.text', seq: 4, occurredAt: 1_200, delta: 'lost' });
  assert.equal(gap.classification, 'gap');
  if (gap.classification === 'gap') {
    assert.equal(gap.expectedSeq, 3);
    assert.equal(gap.observedSeq, 4);
  }
  assert.equal(gap.state.turnsBySession[base.sessionPath]?.phase, 'reconciling_gap');

  const wrongAttempt = apply(gap.state, { ...base, attemptId: 'late-attempt', kind: 'turn.text', seq: 2, delta: 'late' });
  assert.equal(wrongAttempt.classification, 'owner_pending');
  assert.equal(wrongAttempt.state.turnsBySession[base.sessionPath]?.parts[0]?.kind, 'text');
});

test('checkpoint replacement is atomic and retains only newer pending envelopes', () => {
  const started = apply(createEmptyLivePipelineState(), start()).state;
  const withGap = apply(started, { ...base, kind: 'turn.text', seq: 3, delta: 'gap' }).state;
  const owner = withGap.turnsBySession[base.sessionPath]!;
  const checkpoint: LiveTurnCheckpoint = {
    protocolVersion: 5,
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    checkpointSeq: 3,
    phase: 'streaming',
    turn: {
      ...owner,
      seq: 3,
      checkpointSeq: 3,
      phase: 'streaming',
      parts: [{ kind: 'text', text: 'authoritative' }],
      textBytes: Buffer.byteLength('authoritative', 'utf8'),
    },
    tools: [],
    pendingExtensionUiRequestIds: [],
  };

  const repaired = applyLiveTurnCheckpoint(withGap, checkpoint);
  assert.equal(repaired.classification, 'applied');
  assert.equal(repaired.state.turnsBySession[base.sessionPath]?.reconciliation, undefined);
  assert.deepEqual(repaired.state.turnsBySession[base.sessionPath]?.parts, [{ kind: 'text', text: 'authoritative' }]);
  assert.equal(withGap.turnsBySession[base.sessionPath]?.phase, 'reconciling_gap');

  const stale = applyLiveTurnCheckpoint(repaired.state, { ...checkpoint, checkpointSeq: 2, turn: { ...checkpoint.turn, seq: 2, checkpointSeq: 2 } });
  assert.equal(stale.classification, 'stale');

  const terminalWithoutDurability = applyLiveTurnCheckpoint(repaired.state, {
    ...checkpoint,
    terminal: {
      id: 'terminal', role: 'assistant', createdAt: 'now', markdown: 'done', status: 'completed',
    },
  });
  assert.equal(terminalWithoutDurability.classification, 'malformed');
  const wrongVersion = applyLiveTurnCheckpoint(repaired.state, { ...checkpoint, protocolVersion: 6 });
  assert.equal(wrongVersion.classification, 'malformed');
  const structurallyMalformed = applyLiveTurnCheckpoint(repaired.state, {
    protocolVersion: 5, sessionPath: base.sessionPath,
  } as never);
  assert.equal(structurallyMalformed.classification, 'malformed');
  const invalidPhase = applyLiveTurnCheckpoint(repaired.state, {
    ...checkpoint, phase: 'bogus', turn: { ...checkpoint.turn, phase: 'bogus' },
  } as never);
  assert.equal(invalidPhase.classification, 'malformed');
});

test('checkpoint older than the applied semantic sequence is stale and cannot regress live state', () => {
  const started = apply(createEmptyLivePipelineState(), start()).state;
  const initialOwner = started.turnsBySession[base.sessionPath]!;
  const baseCheckpoint: LiveTurnCheckpoint = {
    protocolVersion: 5,
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    checkpointSeq: 2,
    phase: 'streaming',
    turn: {
      ...initialOwner,
      seq: 2,
      checkpointSeq: 2,
      phase: 'streaming',
      parts: [{ kind: 'text', text: 'two' }],
      textBytes: Buffer.byteLength('two', 'utf8'),
    },
    tools: [],
    pendingExtensionUiRequestIds: [],
  };
  const repaired = applyLiveTurnCheckpoint(started, baseCheckpoint);
  assert.equal(repaired.classification, 'applied');

  let advanced = repaired.state;
  advanced = apply(advanced, { ...base, kind: 'turn.text', seq: 3, delta: ' three' }).state;
  advanced = apply(advanced, { ...base, kind: 'turn.text', seq: 4, delta: ' four' }).state;
  advanced = apply(advanced, { ...base, kind: 'turn.text', seq: 5, delta: ' five' }).state;
  assert.equal(advanced.turnsBySession[base.sessionPath]?.checkpointSeq, 2);
  assert.equal(advanced.turnsBySession[base.sessionPath]?.seq, 5);

  const staleCheckpoint: LiveTurnCheckpoint = {
    ...baseCheckpoint,
    checkpointSeq: 4,
    turn: {
      ...baseCheckpoint.turn,
      seq: 4,
      checkpointSeq: 4,
      parts: [{ kind: 'text', text: 'stale through four' }],
      textBytes: Buffer.byteLength('stale through four', 'utf8'),
    },
  };
  const stale = applyLiveTurnCheckpoint(advanced, staleCheckpoint);
  assert.equal(stale.classification, 'stale');
  assert.equal(stale.state, advanced, 'a stale repair must preserve the current state identity');
  assert.equal(stale.state.turnsBySession[base.sessionPath]?.seq, 5);
  assert.deepEqual(stale.state.turnsBySession[base.sessionPath]?.parts, [{
    kind: 'text', text: 'two three four five',
  }]);
});

test('terminal repair checkpoints may use one-shot transport headroom for large durable messages', () => {
  const state = apply(createEmptyLivePipelineState(), start()).state;
  const owner = state.turnsBySession[base.sessionPath]!;
  const terminal = {
    id: 'terminal', role: 'assistant' as const, createdAt: 'now',
    markdown: 'x'.repeat(3 * 1024 * 1024), status: 'completed' as const, durableEntryId: 'terminal-entry',
  };
  const checkpoint: LiveTurnCheckpoint = {
    protocolVersion: 5,
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    checkpointSeq: 1,
    phase: owner.phase,
    turn: { ...owner, checkpointSeq: 1 },
    tools: [],
    pendingExtensionUiRequestIds: [],
    terminal,
  };

  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > 2 * 1024 * 1024);
  assert.equal(applyLiveTurnCheckpoint(state, checkpoint).classification, 'applied');
});

test('active recovery checkpoints preserve a complete multi-megabyte recursive subagent preview', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1', parentExecutionId: null,
    rootExecutionId: 'execution-1', toolCallId: 'tool-1', name: 'subagent', input: {}, startedAt: 1_100,
  }).state;
  state = apply(state, {
    ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution-1',
    baseProgressRevision: 0, progressRevision: 1,
    update: { kind: 'snapshot', preview: {
      kind: 'subagent', mode: 'single', omittedChildren: 0,
      children: [{ id: 'worker', phase: 'running', streamingText: 'x'.repeat(3 * 1024 * 1024), messages: [] }],
    } },
  }).state;
  const turn = state.turnsBySession[base.sessionPath]!;
  const checkpoint: LiveTurnCheckpoint = {
    protocolVersion: 5, sessionPath: base.sessionPath, turnId: base.turnId, attemptId: base.attemptId,
    checkpointSeq: 3, phase: turn.phase, turn: { ...turn, checkpointSeq: 3 },
    tools: [state.toolsByExecutionId['execution-1']!], pendingExtensionUiRequestIds: [],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > 2 * 1024 * 1024);
  const repaired = applyLiveTurnCheckpoint(createEmptyLivePipelineState(), checkpoint);
  assert.equal(repaired.classification, 'applied');
  assert.equal(
    (repaired.state.toolsByExecutionId['execution-1']?.preview as { children?: Array<{ streamingText?: string }> })
      .children?.[0]?.streamingText?.length,
    3 * 1024 * 1024,
  );
});

test('checkpoint repair preserves richer settled-tool details already received by the host', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1',
    parentExecutionId: null, rootExecutionId: 'execution-1', toolCallId: 'tool-1',
    name: 'read', input: { path: '/full/path' }, startedAt: 1_100,
  }).state;
  state = apply(state, {
    ...base, kind: 'tool.terminal', seq: 3, executionId: 'execution-1', status: 'completed',
    result: { kind: 'text', tail: 'full visible result', omittedChars: 0 }, durableEntryId: 'entry-1',
  }).state;
  const owner = state.turnsBySession[base.sessionPath]!;
  const existingTool = state.toolsByExecutionId['execution-1']!;
  const repaired = applyLiveTurnCheckpoint(state, {
    protocolVersion: 5,
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    checkpointSeq: 3,
    phase: owner.phase,
    turn: { ...owner, checkpointSeq: 3 },
    tools: [{
      ...existingTool,
      immutableInput: { liveCompacted: true },
      terminal: {
        ...existingTool.terminal!,
        result: { kind: 'generic', summary: 'compacted', liveCompacted: true },
      },
    }],
    pendingExtensionUiRequestIds: [],
  });

  assert.equal(repaired.classification, 'applied');
  assert.deepEqual(repaired.state.toolsByExecutionId['execution-1']?.immutableInput, { path: '/full/path' });
  assert.deepEqual(repaired.state.toolsByExecutionId['execution-1']?.terminal?.result, {
    kind: 'text', tail: 'full visible result', omittedChars: 0,
  });
});

test('projection places queued follow-ups after the active turn at their delivery boundary', () => {
  const state = apply(createEmptyLivePipelineState(), start()).state;
  const view = projectTranscriptView([
    {
      id: 'user-1', role: 'user', createdAt: new Date(800).toISOString(),
      markdown: 'initial prompt', status: 'completed',
    },
    {
      id: 'follow-up-1', role: 'user', createdAt: new Date(1_000).toISOString(),
      markdown: 'first follow-up', status: 'queued',
    },
    {
      id: 'system-1', role: 'system', createdAt: new Date(1_050).toISOString(),
      markdown: 'durable event', status: 'completed',
    },
    {
      id: 'follow-up-2', role: 'user', createdAt: new Date(1_100).toISOString(),
      markdown: 'second follow-up', status: 'queued',
    },
  ], state, base.sessionPath);

  assert.deepEqual(view.messages.map((message) => message.id), [
    'user-1', 'system-1', 'message-1', 'follow-up-1', 'follow-up-2',
  ]);
  assert.equal(view.activeTurn?.id, 'message-1');
});

test('projection preserves durable ordering when there is no active turn', () => {
  const durable = [
    {
      id: 'follow-up-1', role: 'user' as const, createdAt: new Date(1_000).toISOString(),
      markdown: 'queued follow-up', status: 'queued' as const,
    },
    {
      id: 'assistant-1', role: 'assistant' as const, createdAt: new Date(1_100).toISOString(),
      markdown: 'completed response', status: 'completed' as const,
    },
  ];

  const view = projectTranscriptView(durable, createEmptyLivePipelineState(), base.sessionPath);
  assert.deepEqual(view.messages.map((message) => message.id), ['follow-up-1', 'assistant-1']);
  assert.equal(view.activeTurn, null);
});

test('projected live tool progress advances commit identity without hashing preview payloads', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1',
    parentExecutionId: null, rootExecutionId: 'execution-1', toolCallId: 'tool-1',
    name: 'read', input: {}, startedAt: 1_100, parallelGroupId: 'batch-1',
  }).state;
  const before = projectTranscriptView([], state, base.sessionPath).activeTurn!;
  state = apply(state, {
    ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution-1',
    baseProgressRevision: 0, progressRevision: 1,
    update: { kind: 'snapshot', preview: { kind: 'generic', summary: 'new preview' } },
  }).state;
  const after = projectTranscriptView([], state, base.sessionPath).activeTurn!;
  assert.equal(before.toolStateRevision, 2);
  assert.equal(after.toolStateRevision, 3);
  assert.equal(after.toolCalls?.[0]?.executionId, 'execution-1');
  assert.equal(after.toolCalls?.[0]?.parallelGroupId, 'batch-1');
  assert.equal(after.toolCalls?.[0]?.seq, 3);
  const signature = (message: typeof after) => transcriptRenderSignature({
    activeSession: { path: base.sessionPath } as never,
    busy: true,
    prepassPhase: 'idle',
    retryStatus: null,
    transcript: [message],
  });
  assert.notEqual(signature(before), signature(after));
});

test('host patch assembly reconstructs the same recursive preview as a full snapshot', () => {
  let baseState = apply(createEmptyLivePipelineState(), start()).state;
  baseState = apply(baseState, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1',
    parentExecutionId: null, rootExecutionId: 'execution-1', toolCallId: 'tool-1',
    name: 'subagent', input: {}, startedAt: 1_100,
  }).state;
  const initial = {
    kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
    children: [{ id: 'worker', phase: 'running' as const, streamingText: 'hello', messages: [] }],
  };
  const next = {
    ...initial,
    children: [{ ...initial.children[0]!, streamingText: 'hello world', messages: [{
      role: 'assistant', content: [{ type: 'toolCall', name: 'subagent', result: {
        details: { results: [{ agent: 'scout', exitCode: -1, messages: [] }] },
      } }],
    }] }],
  };
  const withInitial = apply(baseState, {
    ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution-1',
    baseProgressRevision: 0, progressRevision: 1,
    update: { kind: 'snapshot', preview: initial },
  });
  assert.equal(withInitial.classification, 'applied');
  const reconstructed = apply(withInitial.state, {
    ...base, kind: 'tool.progress', seq: 4, baseSeq: 3, executionId: 'execution-1',
    baseProgressRevision: 1, progressRevision: 2,
    update: { kind: 'patch', operations: diffJsonValues(initial as JsonSafeValue, next as JsonSafeValue) },
  });
  assert.equal(reconstructed.classification, 'applied');

  const full = apply(baseState, {
    ...base, kind: 'tool.progress', seq: 4, baseSeq: 2, executionId: 'execution-1',
    baseProgressRevision: 0, progressRevision: 2,
    update: { kind: 'snapshot', preview: next },
  });
  assert.equal(full.classification, 'applied');
  assert.deepEqual(
    reconstructed.state.toolsByExecutionId['execution-1']?.preview,
    full.state.toolsByExecutionId['execution-1']?.preview,
  );
  assert.deepEqual(projectTranscriptView([], reconstructed.state, base.sessionPath).liveTools[0]?.result, next);
});

test('frequent patches against 3, 15, and 30 MiB recursive previews use backend byte metadata without serialization', () => {
  for (const sizeMiB of [3, 15, 30]) {
    let state = apply(createEmptyLivePipelineState(), start()).state;
    state = apply(state, {
      ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1', parentExecutionId: null,
      rootExecutionId: 'execution-1', toolCallId: 'tool-1', name: 'subagent', input: {}, startedAt: 1_100,
    }).state;
    const preview = {
      kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
      children: [{ id: 'worker', phase: 'running' as const, streamingText: 'x'.repeat(sizeMiB * 1024 * 1024 - 1_024), messages: [] }],
    };
    let previewBytes = Buffer.byteLength(JSON.stringify(preview), 'utf8');
    let stringifyCalls = 0;
    const originalStringify = JSON.stringify;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
      stringifyCalls += 1;
      return originalStringify(value, replacer as never, space as never);
    }) as typeof JSON.stringify;
    try {
      state = apply(state, {
        ...base, kind: 'tool.progress', seq: 3, baseSeq: 2, executionId: 'execution-1',
        baseProgressRevision: 0, progressRevision: 1, previewBytes, aggregatePreviewBytes: previewBytes,
        update: { kind: 'snapshot', preview },
      }).state;
      for (let revision = 2; revision <= 24; revision += 1) {
        previewBytes += 1;
        state = apply(state, {
          ...base, kind: 'tool.progress', seq: revision + 2, baseSeq: revision + 1,
          executionId: 'execution-1', baseProgressRevision: revision - 1, progressRevision: revision,
          previewBytes, aggregatePreviewBytes: previewBytes,
          update: { kind: 'patch', operations: [{ op: 'appendString', path: ['children', 0, 'streamingText'], value: 'y' }] },
        }).state;
      }
    } finally {
      JSON.stringify = originalStringify;
    }
    assert.equal(stringifyCalls, 0, `${sizeMiB} MiB progress processing must not stringify the accumulated preview`);
    assert.equal(state.toolsByExecutionId['execution-1']?.previewBytes, previewBytes);
    assert.equal(state.turnsBySession[base.sessionPath]?.aggregatePreviewBytes, previewBytes);
    const projected = projectTranscriptView([], state, base.sessionPath).liveTools[0];
    const compactPreview = projected?.result as {
      kind?: string;
      children?: Array<{ streamingText?: string; messages?: unknown[] }>;
    } | undefined;
    assert.equal(compactPreview?.kind, 'subagent');
    assert.equal(compactPreview?.children?.length, 1);
    assert.equal(compactPreview?.children?.[0]?.streamingText?.endsWith('y'.repeat(23)), true);
    assert.deepEqual(compactPreview?.children?.[0]?.messages, []);
    assert.ok(Buffer.byteLength(JSON.stringify(compactPreview), 'utf8') <= 64 * 1024,
      'ordinary snapshots retain only a bounded top-level subagent preview');
    assert.equal(projected?.detailRef?.sizeBytes, previewBytes);
    assert.equal(projected?.detailRef?.source, 'live');
  }
});

test('multiple sibling previews enforce the aggregate limit incrementally and release bytes on terminal settlement', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  const bytesByExecution: Record<string, number> = {};
  let seq = 1;
  for (const executionId of ['execution-1', 'execution-2']) {
    seq += 1;
    state = apply(state, {
      ...base, kind: 'tool.started', seq, executionId, parentExecutionId: null,
      rootExecutionId: executionId, toolCallId: `tool-${executionId}`, name: 'subagent', input: {}, startedAt: 1_100,
    }).state;
    const preview = {
      kind: 'subagent' as const, mode: 'single' as const, omittedChildren: 0,
      children: [{ id: executionId, phase: 'running' as const, streamingText: 'x'.repeat(14 * 1024 * 1024), messages: [] }],
    };
    const previewBytes = Buffer.byteLength(JSON.stringify(preview), 'utf8');
    bytesByExecution[executionId] = previewBytes;
    seq += 1;
    state = apply(state, {
      ...base, kind: 'tool.progress', seq, baseSeq: seq - 1, executionId,
      baseProgressRevision: 0, progressRevision: 1, previewBytes,
      aggregatePreviewBytes: Object.values(bytesByExecution).reduce((total, bytes) => total + bytes, 0),
      update: { kind: 'snapshot', preview },
    }).state;
  }
  const aggregate = Object.values(bytesByExecution).reduce((total, bytes) => total + bytes, 0);
  assert.equal(state.turnsBySession[base.sessionPath]?.aggregatePreviewBytes, aggregate);

  const overflow = apply(state, {
    ...base, kind: 'tool.progress', seq: seq + 1, baseSeq: seq, executionId: 'execution-1',
    baseProgressRevision: 1, progressRevision: 2,
    previewBytes: bytesByExecution['execution-1']! + 3 * 1024 * 1024,
    aggregatePreviewBytes: aggregate + 3 * 1024 * 1024,
    update: { kind: 'patch', operations: [{ op: 'appendString', path: ['children', 0, 'streamingText'], value: 'z' }] },
  });
  assert.equal(overflow.classification, 'invalid');

  state = apply(state, {
    ...base, kind: 'tool.terminal', seq: seq + 1, executionId: 'execution-2', status: 'completed',
    result: { kind: 'generic', summary: 'done' }, durableEntryId: 'entry-2',
  }).state;
  assert.equal(state.turnsBySession[base.sessionPath]?.aggregatePreviewBytes, bytesByExecution['execution-1']);
  assert.equal(state.toolsByExecutionId['execution-2']?.previewBytes, 0);
});

test('host rejects a missing patch range so reducer recovery can request a checkpoint', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution-1', parentExecutionId: null,
    rootExecutionId: 'execution-1', toolCallId: 'tool-1', name: 'subagent', input: {}, startedAt: 1_100,
  }).state;
  const gap = apply(state, {
    ...base, kind: 'tool.progress', seq: 5, baseSeq: 4, executionId: 'execution-1',
    baseProgressRevision: 2, progressRevision: 3,
    update: { kind: 'patch', operations: [] },
  });
  assert.equal(gap.classification, 'gap');
  assert.equal(gap.state.turnsBySession[base.sessionPath]?.phase, 'reconciling_gap');

  const malformedRange = apply(state, {
    ...base, kind: 'tool.progress', seq: 100, baseSeq: 2, executionId: 'execution-1',
    baseProgressRevision: 0, progressRevision: 1,
    update: { kind: 'snapshot', preview: { kind: 'generic', summary: 'invalid jump' } },
  });
  assert.equal(malformedRange.classification, 'gap');
  assert.equal(malformedRange.state.turnsBySession[base.sessionPath]?.seq, 2);
});

test('tool and turn terminals require durable evidence and terminal tombstones block revival', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, {
    ...base,
    kind: 'tool.started',
    seq: 2,
    executionId: 'execution-1',
    parentExecutionId: null,
    rootExecutionId: 'execution-1',
    toolCallId: 'tool-1',
    name: 'read',
    input: { path: 'safe' },
    startedAt: 1_100,
  }).state;
  const invalid = apply(state, {
    ...base,
    kind: 'tool.terminal',
    seq: 3,
    executionId: 'execution-1',
    status: 'completed',
    result: 'ok',
    durableEntryId: '',
  });
  assert.equal(invalid.classification, 'invalid');

  state = apply(state, {
    ...base,
    kind: 'tool.terminal',
    seq: 3,
    executionId: 'execution-1',
    status: 'completed',
    result: 'ok',
    durationMs: 10,
    durableEntryId: 'tool-result-entry',
  }).state;
  const view = projectTranscriptView([], state, base.sessionPath);
  assert.equal(view.liveTools[0]?.durableEntryId, 'tool-result-entry');

  const terminal = apply(state, {
    ...base,
    kind: 'turn.terminal',
    seq: 4,
    terminalKind: 'completed',
    durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message-1', role: 'assistant', createdAt: new Date(1_200).toISOString(),
      markdown: 'done', status: 'completed', durableEntryId: 'assistant-entry',
    },
  });
  assert.equal(terminal.classification, 'committed');
  assert.equal(terminal.state.turnsBySession[base.sessionPath], undefined);
  assert.equal(terminal.state.toolsByExecutionId['execution-1'], undefined);

  const late = apply(terminal.state, { ...base, kind: 'turn.text', seq: 5, delta: 'revive' });
  assert.equal(late.classification, 'duplicate_or_late');
});

test('aggregate live content and extension UI ownership remain bounded', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  const halfLimit = 'x'.repeat(256 * 1024);
  state = apply(state, { ...base, kind: 'turn.text', seq: 2, delta: halfLimit }).state;
  state = apply(state, { ...base, kind: 'turn.reasoning', seq: 3, delta: halfLimit }).state;
  state = apply(state, { ...base, kind: 'turn.text', seq: 4, delta: halfLimit }).state;
  const overflow = apply(state, { ...base, kind: 'turn.text', seq: 5, delta: 'x' });
  assert.equal(overflow.classification, 'invalid');
  assert.equal(state.turnsBySession[base.sessionPath]?.seq, 4);

  for (let index = 0; index < 32; index += 1) {
    state = apply(state, {
      ...base, kind: 'turn.extensionUi', seq: 5 + index,
      uiRequestId: `question-${index}`, action: 'opened',
    }).state;
  }
  const uiOverflow = apply(state, {
    ...base, kind: 'turn.extensionUi', seq: 37, uiRequestId: 'question-overflow', action: 'opened',
  });
  assert.equal(uiOverflow.classification, 'invalid');
});

test('terminal tombstone capacity retains the newest insertion when expiries tie', () => {
  const attempts = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [
    `old-${index}`,
    {
      sessionPath: '/s', turnId: `old-${index}`, attemptId: 'attempt', finalSeq: 1,
      terminalKind: 'interrupted' as const, expiresAt: 1_000,
    },
  ]));
  attempts.fresh = {
    sessionPath: '/s', turnId: 'fresh', attemptId: 'attempt', finalSeq: 1,
    terminalKind: 'interrupted', expiresAt: 1_000,
  };
  const retained = pruneExpiredTerminalAttempts(attempts, 100, 128);
  assert.ok(retained.fresh);
  assert.equal(Object.keys(retained).length, 128);
});

test('restart interrupts active text and keeps only durability-confirmed terminal tools', () => {
  let state = apply(createEmptyLivePipelineState(), start()).state;
  state = apply(state, { ...base, kind: 'turn.text', seq: 2, delta: 'partial' }).state;
  state = apply(state, {
    ...base,
    kind: 'tool.started', seq: 3, executionId: 'done-exec', parentExecutionId: null,
    rootExecutionId: 'done-exec', toolCallId: 'done-tool', name: 'write', input: {}, startedAt: 1_200,
  }).state;
  state = apply(state, {
    ...base,
    kind: 'tool.terminal', seq: 4, executionId: 'done-exec', status: 'completed',
    result: 'saved', durableEntryId: 'done-entry',
  }).state;
  state = apply(state, {
    ...base,
    kind: 'tool.started', seq: 5, executionId: 'running-exec', parentExecutionId: null,
    rootExecutionId: 'running-exec', toolCallId: 'running-tool', name: 'bash', input: {}, startedAt: 1_300,
  }).state;

  const restarted = interruptLivePipelineForRestart(state, 2_000, 20_000);
  const interrupted = restarted.interruptedBySession[base.sessionPath];
  assert.equal(interrupted?.status, 'interrupted');
  assert.equal(interrupted?.markdown, 'partial');
  assert.deepEqual(interrupted?.toolCalls?.map((tool) => [tool.id, tool.durableEntryId]), [['done-tool', 'done-entry']]);
  assert.deepEqual(restarted.state.turnsBySession, {});
  assert.deepEqual(restarted.state.toolsByExecutionId, {});
});
