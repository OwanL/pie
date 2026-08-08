import assert from 'node:assert/strict';
import test from 'node:test';

import { selectViewState } from '../../../../src/host/core/projection';
import { createInitialArchState, reducer } from '../../../../src/host/core/reducer';
import type { TurnSemanticEnvelope } from '../../../../src/shared/live-pipeline-protocol';
import type { SessionOpenedPayload } from '../../../../src/shared/protocol';
import { buildTranscriptRows } from '../../../../src/webview/panel/transcript/virtual-list-rows';

const base = {
  protocolVersion: 6,
  sessionPath: '/session.jsonl',
  requestId: 'request',
  turnId: 'turn',
  attemptId: 'attempt',
  occurredAt: 100,
  checkpointBytes: 30 * 1024 * 1024,
};

function dispatch(state: ReturnType<typeof createInitialArchState>, envelope: TurnSemanticEnvelope) {
  return reducer(state, { kind: 'TurnSemanticEventReceived', envelope });
}

function withPendingUiRequest(state: ReturnType<typeof createInitialArchState>) {
  return {
    ...state,
    settings: {
      ...state.settings,
      pendingExtensionUIRequestsBySession: {
        ...state.settings.pendingExtensionUIRequestsBySession,
        [base.sessionPath]: {
          'ui-request': {
            id: 'ui-request', sessionPath: base.sessionPath, extensionId: 'test',
            method: 'input' as const, title: 'Input',
          },
        },
      },
    },
  };
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
  assert.equal(liveView.transcript.at(-1)?.renderIdentity, 'message');
  assert.equal(liveView.liveTurnPhase, 'streaming');
  const liveRow = buildTranscriptRows({
    transcript: liveView.transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
  }).at(-1);
  assert.equal(liveRow?.key, 'message:message');

  const terminalMessage = {
    id: 'durable-assistant', role: 'assistant' as const, createdAt: new Date(120).toISOString(),
    markdown: 'live done', status: 'completed' as const, durableEntryId: 'entry-assistant',
  };
  state = withPendingUiRequest(state);
  const committed = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 3, terminalKind: 'completed',
    durableMessage: terminalMessage, durableEntryId: 'entry-assistant',
  });

  assert.equal(committed.state.livePipeline.turnsBySession[base.sessionPath], undefined);
  const committedMessage = committed.state.transcript.bySession[base.sessionPath]?.[0];
  assert.equal(committedMessage?.id, 'durable-assistant', 'durable transcript ownership keeps the SDK id');
  assert.equal(committedMessage?.durableEntryId, 'entry-assistant');
  assert.equal(committedMessage?.renderIdentity, 'message');
  const durableView = selectViewState(committed.state);
  const durableRow = buildTranscriptRows({
    transcript: durableView.transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
  }).at(-1);
  assert.equal(durableRow?.key, liveRow?.key, 'live and durable projections retain one virtual row key');
  assert.equal(
    committed.state.settings.pendingExtensionUIRequestsBySession[base.sessionPath],
    undefined,
    'a committed terminal cannot leave an actionable extension UI request behind',
  );
  assert.equal(selectViewState(committed.state).liveTurnPhase, null);
});

test('terminal commit preserves parallel metadata in ordered parts and the toolCalls mirror', () => {
  let state = createInitialArchState();
  state.transcript.bySession[base.sessionPath] = [];
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'read', input: { path: 'live' },
    startedAt: 95, parallelGroupId: 'batch',
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.terminal', seq: 3, executionId: 'execution', status: 'completed',
    result: 'live', durableEntryId: 'tool-entry',
  }).state;
  const durableCall = {
    id: 'tool', name: 'read', input: { path: 'durable' }, result: 'durable',
    status: 'completed' as const, durableEntryId: 'tool-entry',
  };
  state = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 4, terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(100).toISOString(), markdown: '',
      status: 'completed', durableEntryId: 'assistant-entry',
      parts: [{ kind: 'toolCall', toolCall: durableCall }], toolCalls: [durableCall],
    },
  }).state;
  const committed = state.transcript.bySession[base.sessionPath]?.[0];
  const part = committed?.parts?.[0];
  const partCall = part?.kind === 'toolCall' ? part.toolCall : undefined;
  assert.equal(partCall?.parallelGroupId, 'batch');
  assert.equal(committed?.toolCalls?.[0]?.parallelGroupId, 'batch');
  assert.deepEqual(committed?.toolCalls?.[0], partCall);
  assert.deepEqual(partCall?.input, { path: 'durable' });
  assert.equal(partCall?.result, 'durable');
});

test('idle session.opened preserves reconciled render and batch identity while durable content stays authoritative', () => {
  let state = createInitialArchState();
  state.sessions.activeSessionPath = base.sessionPath;
  state.sessions.sessions = [{
    path: base.sessionPath, name: 'session', cwd: '/', modifiedAt: '2026-08-07T00:00:00.000Z', messageCount: 0,
  }];
  state.transcript.bySession[base.sessionPath] = [];
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'live-assistant', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'turn.toolDraft', seq: 2,
    draft: { toolCallId: 'tool', name: 'draft-name', argumentsJson: '{"draft":', phase: 'drafting' },
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.started', seq: 3, executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'live-name', input: { live: true },
    startedAt: 95, parallelGroupId: 'batch',
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.terminal', seq: 4, executionId: 'execution', status: 'completed',
    result: 'live-result', durationMs: 25, durableEntryId: 'tool-entry',
  }).state;
  const firstDurableCall = {
    id: 'tool', name: 'first-durable-name', input: { durable: 1 }, result: 'first-durable-result',
    status: 'completed' as const, durableEntryId: 'tool-entry',
  };
  state = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 5, terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'first-durable-assistant', role: 'assistant', createdAt: new Date(100).toISOString(),
      markdown: 'first durable content', status: 'completed', durableEntryId: 'assistant-entry',
      parts: [{ kind: 'toolCall', toolCall: firstDurableCall }], toolCalls: [firstDurableCall],
    },
  }).state;

  const beforeRefresh = selectViewState(state);
  const beforeRow = buildTranscriptRows({
    transcript: beforeRefresh.transcript, systemPromptCount: 0,
    hasOlder: false, hasNewer: false, busy: false,
  }).at(-1);
  assert.equal(beforeRow?.key, 'message:live-assistant');

  const refreshedCall = {
    id: 'tool', name: 'refreshed-durable-name', input: { durable: 2 }, result: 'refreshed-result',
    status: 'failed' as const, durableEntryId: 'tool-entry',
  };
  const opened: SessionOpenedPayload = {
    session: {
      path: base.sessionPath, cwd: '/', name: 'session', modifiedAt: '2026-08-07T00:00:00.000Z', messageCount: 1,
    },
    transcript: [{
      id: 'refreshed-durable-assistant', role: 'assistant', createdAt: new Date(110).toISOString(),
      markdown: 'authoritative refreshed content', status: 'error', durableEntryId: 'assistant-entry',
      errorDetail: 'authoritative error',
      parts: [{ kind: 'toolCall', toolCall: refreshedCall }], toolCalls: [refreshedCall],
    }],
    transcriptWindow: {
      totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false,
      isPartial: false, hasUserMessages: false,
    },
    busy: false,
  };
  state = reducer(state, { kind: 'SessionOpened', sessionPath: base.sessionPath, payload: opened }).state;

  const refreshed = state.transcript.bySession[base.sessionPath]?.[0];
  const refreshedPart = refreshed?.parts?.[0];
  const refreshedPartCall = refreshedPart?.kind === 'toolCall' ? refreshedPart.toolCall : undefined;
  assert.equal(refreshed?.id, 'refreshed-durable-assistant');
  assert.equal(refreshed?.markdown, 'authoritative refreshed content');
  assert.equal(refreshed?.status, 'error');
  assert.equal(refreshed?.renderIdentity, 'live-assistant');
  assert.equal(refreshedPartCall?.name, 'refreshed-durable-name');
  assert.deepEqual(refreshedPartCall?.input, { durable: 2 });
  assert.equal(refreshedPartCall?.result, 'refreshed-result');
  assert.equal(refreshedPartCall?.status, 'failed');
  assert.equal(refreshedPartCall?.parallelGroupId, 'batch');
  assert.equal(refreshedPartCall?.executionId, 'execution');
  assert.equal(refreshedPartCall?.startedAt, 95);
  assert.equal(refreshedPartCall?.durationMs, 25);
  assert.equal(refreshedPartCall?.seq, 4);
  assert.deepEqual(refreshed?.toolCalls?.[0], refreshedPartCall);
  const afterRow = buildTranscriptRows({
    transcript: selectViewState(state).transcript, systemPromptCount: 0,
    hasOlder: false, hasNewer: false, busy: false,
  }).at(-1);
  assert.equal(afterRow?.key, beforeRow?.key);
});

test('terminal append does not reconcile metadata across conflicting durable entries sharing an id', () => {
  let state = createInitialArchState();
  state.transcript.bySession[base.sessionPath] = [{
    id: 'shared-id', role: 'assistant', createdAt: new Date(80).toISOString(), markdown: 'old',
    status: 'completed', durableEntryId: 'old-entry', renderIdentity: 'old-render',
  }];
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'new-live-render', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 2, terminalKind: 'completed', durableEntryId: 'new-entry',
    durableMessage: {
      id: 'shared-id', role: 'assistant', createdAt: new Date(100).toISOString(), markdown: 'new',
      status: 'completed', durableEntryId: 'new-entry',
    },
  }).state;

  const transcript = state.transcript.bySession[base.sessionPath];
  assert.equal(transcript?.length, 2);
  assert.equal(transcript?.[0]?.renderIdentity, 'old-render');
  assert.equal(transcript?.[1]?.durableEntryId, 'new-entry');
  assert.equal(transcript?.[1]?.renderIdentity, 'new-live-render');
});

test('a delayed checkpoint cannot revive an attempt after its terminal tombstone', () => {
  let state = createInitialArchState();
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  const active = state.livePipeline.turnsBySession[base.sessionPath]!;
  const delayedCheckpoint = {
    protocolVersion: 6 as const,
    sessionPath: base.sessionPath,
    turnId: base.turnId,
    attemptId: base.attemptId,
    checkpointSeq: 1,
    phase: active.phase,
    checkpointBytes: active.checkpointBytes,
    turn: { ...active, checkpointSeq: 1 },
    tools: [],
    pendingExtensionUiRequestIds: [],
  };
  const terminal = {
    id: 'durable', role: 'assistant' as const, createdAt: new Date(110).toISOString(),
    markdown: 'done', status: 'completed' as const, durableEntryId: 'entry',
  };
  state = dispatch(state, {
    ...base, kind: 'turn.terminal', seq: 2, terminalKind: 'completed',
    durableMessage: terminal, durableEntryId: 'entry',
  }).state;
  const transcript = state.transcript.bySession[base.sessionPath];
  assert.equal(state.livePipeline.turnsBySession[base.sessionPath], undefined);
  assert.ok(state.livePipeline.terminalAttempts['turn\u0000attempt']);

  const late = reducer(state, {
    kind: 'LiveTurnCheckpointResult', corrId: 'late-checkpoint', sessionPath: base.sessionPath,
    turnId: base.turnId, attemptId: base.attemptId, ok: true, occurredAt: 120,
    status: 'active', watermark: null, checkpoint: delayedCheckpoint,
  });

  assert.equal(late.state, state, 'a tombstoned checkpoint is ignored without changing state');
  assert.equal(late.state.livePipeline.turnsBySession[base.sessionPath], undefined);
  assert.equal(late.state.transcript.bySession[base.sessionPath], transcript);
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
  const stateWithPrompt = withPendingUiRequest(gap.state);
  const repaired = reducer(stateWithPrompt, {
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
      protocolVersion: 6,
      sessionPath: base.sessionPath,
      turnId: base.turnId,
      attemptId: base.attemptId,
      checkpointSeq: 4,
      phase: 'streaming',
      checkpointBytes: turn.checkpointBytes,
      turn: {
        ...turn, seq: 4, checkpointSeq: 4, phase: 'streaming',
        parts: [{ kind: 'text', text: 'authoritative' }], textBytes: Buffer.byteLength('authoritative', 'utf8'),
      },
      tools: [],
      pendingExtensionUiRequestIds: [],
      terminal,
    },
  });
  assert.deepEqual(repaired.state.transcript.bySession[base.sessionPath], [{ ...terminal, renderIdentity: 'message' }]);
  assert.equal(repaired.state.livePipeline.turnsBySession[base.sessionPath], undefined);
  assert.equal(repaired.state.settings.pendingExtensionUIRequestsBySession[base.sessionPath], undefined);
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

test('exhausted checkpoint repair clears the owned attempt and its pending gap state', () => {
  let state = createInitialArchState();
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'execution', parentExecutionId: null,
    rootExecutionId: 'execution', toolCallId: 'tool', name: 'bash', input: { command: 'echo hi' }, startedAt: 95,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'turn.extensionUi', seq: 3, uiRequestId: 'ui-request', action: 'opened',
  }).state;
  state = dispatch(state, {
    ...base, kind: 'turn.text', seq: 5, occurredAt: 120, delta: 'after missing seq 4',
  }).state;

  const pendingKey = 'turn\u0000attempt';
  assert.equal(state.livePipeline.pendingOwnerEvents[pendingKey]?.length, 1);
  assert.equal(state.livePipeline.turnsBySession[base.sessionPath]?.pendingExtensionUiRequestIds[0], 'ui-request');
  assert.ok(state.livePipeline.toolsByExecutionId.execution);
  assert.ok(state.pending.currentTurnBySession[base.sessionPath]);
  state = withPendingUiRequest(state);
  const revisionBeforeFailures = state.livePipeline.revisionBySession[base.sessionPath] ?? 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state = reducer(state, {
      kind: 'LiveTurnCheckpointResult', corrId: `repair-${attempt}`, sessionPath: base.sessionPath,
      turnId: base.turnId, attemptId: base.attemptId, ok: false, occurredAt: 130 + attempt,
      status: 'active', error: 'unavailable',
    }).state;
  }

  assert.equal(state.livePipeline.turnsBySession[base.sessionPath], undefined);
  assert.equal(state.livePipeline.toolsByExecutionId.execution, undefined);
  assert.equal(state.livePipeline.pendingOwnerEvents[pendingKey], undefined);
  assert.equal(state.pending.currentTurnBySession[base.sessionPath], undefined);
  assert.equal(state.settings.pendingExtensionUIRequestsBySession[base.sessionPath], undefined);
  assert.equal(
    state.livePipeline.revisionBySession[base.sessionPath],
    revisionBeforeFailures + 1,
    'terminal cleanup advances the live revision exactly once',
  );
  assert.equal(state.livePipeline.terminalAttempts[pendingKey]?.terminalKind, 'interrupted');
  assert.equal(state.transcript.bySession[base.sessionPath]?.at(-1)?.status, 'interrupted');
});

test('checkpoint repair replays a coalesced v6 progress range from the checkpoint base', () => {
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
    baseProgressRevision: 2, progressRevision: 4, previewBytes: 4, aggregatePreviewBytes: 4,
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
      protocolVersion: 6, sessionPath: base.sessionPath, turnId: base.turnId,
      attemptId: base.attemptId, checkpointSeq: 4, phase: 'running_tool',
      checkpointBytes: owner.checkpointBytes,
      turn: {
        ...owner, seq: 4, checkpointSeq: 4, phase: 'running_tool', reconciliation: undefined,
        aggregatePreviewBytes: Buffer.byteLength(JSON.stringify({
          kind: 'subagent', mode: 'single', omittedChildren: 0, children: [
            { id: 'worker', phase: 'running', streamingText: 'ab' },
          ],
        }), 'utf8'),
      },
      tools: [{
        ...tool, seq: 4, progressRevision: 2,
        preview: { kind: 'subagent', mode: 'single', omittedChildren: 0, children: [
          { id: 'worker', phase: 'running', streamingText: 'ab' },
        ] },
        previewBytes: Buffer.byteLength(JSON.stringify({
          kind: 'subagent', mode: 'single', omittedChildren: 0, children: [
            { id: 'worker', phase: 'running', streamingText: 'ab' },
          ],
        }), 'utf8'),
      }],
      pendingExtensionUiRequestIds: [],
    },
  });
  assert.deepEqual(repaired.effects, []);
  assert.equal(repaired.state.livePipeline.turnsBySession[base.sessionPath]?.seq, 6);
  const preview = repaired.state.livePipeline.toolsByExecutionId.execution?.preview;
  assert.equal(preview?.kind === 'subagent' ? preview.children[0]?.streamingText : undefined, 'abcd');
});

test('host transitions reject a second tool.started reusing a durability-confirmed tool-call id', () => {
  let state = createInitialArchState();
  state.transcript.bySession[base.sessionPath] = [];
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.started', seq: 2, executionId: 'exec-a', parentExecutionId: null,
    rootExecutionId: 'exec-a', toolCallId: 'tool-a', name: 'read', input: { path: 'x' }, startedAt: 95,
  }).state;
  state = dispatch(state, {
    ...base, kind: 'tool.terminal', seq: 3, executionId: 'exec-a', status: 'completed',
    result: 'ok', durableEntryId: 'tool-entry',
  }).state;
  const duplicate = dispatch(state, {
    ...base, kind: 'tool.started', seq: 4, executionId: 'exec-b', parentExecutionId: null,
    rootExecutionId: 'exec-b', toolCallId: 'tool-a', name: 'read', input: { path: 'y' }, startedAt: 96,
  });
  assert.equal(duplicate.state.livePipeline.toolsByExecutionId['exec-b'], undefined);
  assert.equal(duplicate.state.livePipeline.toolsByExecutionId['exec-a']?.terminal?.durableEntryId, 'tool-entry');
  assert.ok(duplicate.effects.some((effect) => effect.kind === 'RequestLiveTurnCheckpoint'));
});

test('host transitions count toolDraftBytes against the complete serialized draft payload', () => {
  let state = createInitialArchState();
  state.transcript.bySession[base.sessionPath] = [];
  state = dispatch(state, {
    ...base, kind: 'turn.started', seq: 1, canonicalMessageId: 'message', startedAt: 90,
  }).state;

  const oversizedId = 'id-'.repeat(30_000);
  const rejectedId = dispatch(state, {
    ...base, kind: 'turn.toolDraft', seq: 2,
    draft: { toolCallId: oversizedId, name: 'read', argumentsJson: '{}', phase: 'drafting' },
  });
  assert.ok(rejectedId.effects.some((effect) => effect.kind === 'RequestLiveTurnCheckpoint'));
  assert.equal(rejectedId.state.livePipeline.turnsBySession[base.sessionPath]?.seq, 1);

  const oversizedName = 'n'.repeat(70 * 1024);
  const rejectedName = dispatch(rejectedId.state, {
    ...base, kind: 'turn.toolDraft', seq: 2,
    draft: { toolCallId: 'ok-id', name: oversizedName, argumentsJson: '{}', phase: 'drafting' },
  });
  assert.ok(rejectedName.effects.some((effect) => effect.kind === 'RequestLiveTurnCheckpoint'));

  const accepted = dispatch(rejectedName.state, {
    ...base, kind: 'turn.toolDraft', seq: 2,
    draft: { toolCallId: 'normal', name: 'read', argumentsJson: '{}', phase: 'drafting' },
  });
  assert.equal(accepted.state.livePipeline.turnsBySession[base.sessionPath]?.toolDraftsByCallId.normal?.name, 'read');
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
      protocolVersion: 6, sessionPath: base.sessionPath, turnId: base.turnId,
      attemptId: base.attemptId, checkpointSeq: 2, phase: 'streaming',
      checkpointBytes: turn.checkpointBytes,
      turn: {
        ...turn, seq: 2, checkpointSeq: 2, phase: 'streaming',
        parts: [{ kind: 'text', text: 'before' }], textBytes: Buffer.byteLength('before', 'utf8'),
      },
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
