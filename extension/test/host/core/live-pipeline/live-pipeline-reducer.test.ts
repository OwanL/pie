import assert from 'node:assert/strict';
import test from 'node:test';

import { selectViewState } from '../../../../src/host/core/projection';
import { createInitialArchState, reducer } from '../../../../src/host/core/reducer';
import type { TurnSemanticEnvelope } from '../../../../src/shared/live-pipeline-protocol';

const base = {
  protocolVersion: 5,
  sessionPath: '/session.jsonl',
  requestId: 'request',
  turnId: 'turn',
  attemptId: 'attempt',
  occurredAt: 100,
};

function dispatch(state: ReturnType<typeof createInitialArchState>, envelope: TurnSemanticEnvelope) {
  return reducer(state, { kind: 'TurnSemanticEventReceived', envelope });
}

test('sequenced live events project without mutating durable transcript and terminalize atomically', () => {
  let state = createInitialArchState();
  state.sessions.activeSessionPath = base.sessionPath;
  state.sessions.sessions = [{ path: base.sessionPath, name: 's', cwd: '/', modifiedAt: '', messageCount: 0 }];
  state.transcript.bySession[base.sessionPath] = [];

  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message',
    modelId: 'provider/model', thinkingLevel: 'high', startedAt: 90,
  }).state;
  state = dispatch(state, { ...base, kind: 'turn.text', seq: 2, delta: 'live' }).state;

  assert.deepEqual(state.transcript.bySession[base.sessionPath], [], 'durable projection is not the live authority');
  const liveView = selectViewState(state);
  assert.equal(liveView.transcript.at(-1)?.markdown, 'live');
  assert.equal(liveView.transcript.at(-1)?.modelId, 'provider/model');
  assert.equal(liveView.transcript.at(-1)?.thinkingLevel, 'high');
  assert.equal(liveView.liveTurnPhase, 'streaming');

  const terminalMessage = {
    id: 'durable-assistant', role: 'assistant' as const, createdAt: new Date(120).toISOString(),
    markdown: 'live done', status: 'completed' as const, durableEntryId: 'entry-assistant',
  };
  const committed = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 3, terminalKind: 'completed',
    durableMessage: terminalMessage, durableEntryId: 'entry-assistant',
  });

  assert.equal(committed.state.livePipeline.turnsBySession[base.sessionPath], undefined);
  assert.deepEqual(committed.state.transcript.bySession[base.sessionPath], [terminalMessage]);
  assert.equal(selectViewState(committed.state).liveTurnPhase, null);
});

test('sequence gaps request a checkpoint and a terminal checkpoint repairs missed terminal delivery', () => {
  let state = createInitialArchState();
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  const gap = dispatch(state, { ...base, kind: 'turn.text', seq: 3, delta: 'missed two' });
  assert.equal(gap.state.livePipeline.turnsBySession[base.sessionPath]?.phase, 'reconciling_gap');
  assert.equal(gap.effects[0]?.kind, 'RequestLiveTurnCheckpoint');

  const turn = gap.state.livePipeline.turnsBySession[base.sessionPath]!;
  const terminal = {
    id: 'durable', role: 'assistant' as const, createdAt: new Date(150).toISOString(), markdown: 'authoritative',
    status: 'completed' as const, durableEntryId: 'entry',
  };
  const repaired = reducer(gap.state, {
    kind: 'LiveTurnCheckpointResult',
    corrId: 'checkpoint',
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    ok: true,
    occurredAt: 160,
    status: 'terminal_grace',
    watermark: { ...base, finalSeq: 4, terminalKind: 'completed' },
    checkpoint: {
      protocolVersion: 5,
      sessionPath: base.sessionPath,
      turnId: base.turnId,
      attemptId: base.attemptId,
      checkpointSeq: 4,
      phase: 'streaming',
      turn: { ...turn, seq: 4, checkpointSeq: 4, phase: 'streaming', parts: [{ kind: 'text', text: 'authoritative' }] },
      tools: [],
      pendingExtensionUiRequestIds: [],
      terminal,
    },
  });
  assert.deepEqual(repaired.state.transcript.bySession[base.sessionPath], [terminal]);
  assert.equal(repaired.state.livePipeline.turnsBySession[base.sessionPath], undefined);
  const lateStart = dispatch(repaired.state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'revived', startedAt: 170,
  });
  assert.equal(lateStart.state.livePipeline.turnsBySession[base.sessionPath], undefined, 'terminal checkpoint tombstone blocks revival');
});

test('failed checkpoint for an ownerless event terminalizes the attempt and clears its queue', () => {
  const queued = dispatch(createInitialArchState(), {
    ...base, kind: 'turn.text', seq: 2, occurredAt: 120, delta: 'orphaned',
  });
  assert.equal(queued.state.livePipeline.pendingOwnerEvents['turn\u0000attempt']?.length, 1);
  const failed = reducer(queued.state, {
    kind: 'LiveTurnCheckpointResult', corrId: 'missing-owner', sessionPath: base.sessionPath,
    turnId: base.turnId, attemptId: base.attemptId, ok: false, occurredAt: 130,
    status: 'active', error: 'unavailable',
  });
  assert.equal(failed.state.livePipeline.pendingOwnerEvents['turn\u0000attempt'], undefined);
  assert.equal(failed.state.livePipeline.terminalAttempts['turn\u0000attempt']?.terminalKind, 'interrupted');
  const lateStart = dispatch(failed.state, {
    ...base, kind: 'turn.started', seq: 1, occurredAt: 140,
    canonicalMessageId: 'late', startedAt: 100,
  });
  assert.equal(lateStart.state.livePipeline.turnsBySession[base.sessionPath], undefined);
});

test('checkpoint repair replays a coalesced v5 progress range from the checkpoint base', () => {
  let state = createInitialArchState();
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'subagent', input: {}, startedAt: 95,
  }).state;
  const queued = dispatch(state, {
    ...base, kind: 'tool.progress', seq: 6, baseSeq: 4, executionId: 'execution',
    baseProgressRevision: 2, progressRevision: 4,
    update: { kind: 'patch', operations: [{
      op: 'appendString', path: ['children', 0, 'streamingText'], value: 'cd',
    }] },
  });
  assert.equal(queued.state.livePipeline.pendingOwnerEvents['turn\u0000attempt']?.length, 1);
  const owner = queued.state.livePipeline.turnsBySession[base.sessionPath]!;
  const tool = queued.state.livePipeline.toolsByExecutionId.execution!;
  const repaired = reducer(queued.state, {
    kind: 'LiveTurnCheckpointResult', corrId: 'checkpoint-range', sessionPath: base.sessionPath,
    turnId: base.turnId, attemptId: base.attemptId, ok: true, occurredAt: 140,
    status: 'active', watermark: null,
    checkpoint: {
      protocolVersion: 5, sessionPath: base.sessionPath, turnId: base.turnId,
      attemptId: base.attemptId, checkpointSeq: 4, phase: 'running_tool',
      turn: { ...owner, seq: 4, checkpointSeq: 4, phase: 'running_tool', reconciliation: undefined },
      tools: [{
        ...tool, seq: 4, progressRevision: 2,
        preview: { kind: 'subagent', mode: 'single', omittedChildren: 0, children: [
          { id: 'worker', phase: 'running', streamingText: 'ab' },
        ] },
      }],
      pendingExtensionUiRequestIds: [],
    },
  });
  assert.deepEqual(repaired.effects, []);
  assert.equal(repaired.state.livePipeline.turnsBySession[base.sessionPath]?.seq, 6);
  const preview = repaired.state.livePipeline.toolsByExecutionId.execution?.preview;
  assert.equal(preview?.kind === 'subagent' ? preview.children[0]?.streamingText : undefined, 'abcd');
});

test('checkpoint repair replays a newer envelope that arrived after checkpoint creation', () => {
  let state = createInitialArchState();
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  const gap = dispatch(state, { ...base, kind: 'turn.text', seq: 3, occurredAt: 130, delta: ' after' });
  assert.equal(gap.state.livePipeline.pendingOwnerEvents['turn\u0000attempt']?.length, 1);
  const turn = gap.state.livePipeline.turnsBySession[base.sessionPath]!;
  const repaired = reducer(gap.state, {
    kind: 'LiveTurnCheckpointResult', corrId: 'checkpoint-2', sessionPath: base.sessionPath,
    turnId: base.turnId, attemptId: base.attemptId, ok: true, occurredAt: 140,
    status: 'active', watermark: null,
    checkpoint: {
      protocolVersion: 5, sessionPath: base.sessionPath, turnId: base.turnId,
      attemptId: base.attemptId, checkpointSeq: 2, phase: 'streaming',
      turn: { ...turn, seq: 2, checkpointSeq: 2, phase: 'streaming', parts: [{ kind: 'text', text: 'before' }] },
      tools: [], pendingExtensionUiRequestIds: [],
    },
  });
  assert.deepEqual(repaired.state.livePipeline.turnsBySession[base.sessionPath]?.parts, [
    { kind: 'text', text: 'before after' },
  ]);
  assert.equal(repaired.state.livePipeline.turnsBySession[base.sessionPath]?.seq, 3);
  assert.equal(repaired.state.livePipeline.pendingOwnerEvents['turn\u0000attempt'], undefined);
  assert.deepEqual(repaired.effects, []);
});
