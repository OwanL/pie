import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLiveTurnCheckpoint } from '../../../../src/host/core/live-pipeline/checkpoint';
import { interruptLivePipelineForRestart } from '../../../../src/host/core/live-pipeline/cleanup';
import { createEmptyLivePipelineState, pruneExpiredTerminalAttempts } from '../../../../src/host/core/live-pipeline/model';
import { projectTranscriptView } from '../../../../src/host/core/live-pipeline/projection';
import { applyLiveSemanticEnvelope } from '../../../../src/host/core/live-pipeline/transitions';
import type { LiveTurnCheckpoint, TurnSemanticEnvelope } from '../../../../src/shared/live-pipeline-protocol';
import { transcriptRenderSignature } from '../../../../src/shared/transcript-render-signature';

const base = {
  protocolVersion: 4,
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
    protocolVersion: 4,
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
  const wrongVersion = applyLiveTurnCheckpoint(repaired.state, { ...checkpoint, protocolVersion: 5 });
  assert.equal(wrongVersion.classification, 'malformed');
  const structurallyMalformed = applyLiveTurnCheckpoint(repaired.state, {
    protocolVersion: 4, sessionPath: base.sessionPath,
  } as never);
  assert.equal(structurallyMalformed.classification, 'malformed');
  const invalidPhase = applyLiveTurnCheckpoint(repaired.state, {
    ...checkpoint, phase: 'bogus', turn: { ...checkpoint.turn, phase: 'bogus' },
  } as never);
  assert.equal(invalidPhase.classification, 'malformed');
});

test('terminal repair checkpoints may use one-shot transport headroom beyond the active checkpoint budget', () => {
  const state = apply(createEmptyLivePipelineState(), start()).state;
  const owner = state.turnsBySession[base.sessionPath]!;
  const terminal = {
    id: 'terminal', role: 'assistant' as const, createdAt: 'now',
    markdown: 'x'.repeat(3 * 1024 * 1024), status: 'completed' as const, durableEntryId: 'terminal-entry',
  };
  const checkpoint: LiveTurnCheckpoint = {
    protocolVersion: 4,
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
    protocolVersion: 4,
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
    ...base, kind: 'tool.progress', seq: 3, executionId: 'execution-1',
    preview: { kind: 'generic', summary: 'new preview' },
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
