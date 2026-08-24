import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendLiveTurnAccumulator } from '../../../../src/backend/live-turn-accumulator';
import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import { projectTranscriptView } from '../../../../src/host/core/live-pipeline/projection';
import type { SessionOpenedPayload } from '../../../../src/shared/protocol';
import { LIVE_PIPELINE_PROTOCOL_VERSION } from '../../../../src/shared/live-pipeline-protocol';

const sessionPath = '/session.jsonl';

function liveCheckpoint(text: string) {
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath,
    requestId: 'request-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    canonicalMessageId: 'request-1:1',
    modelId: 'model-1',
    startedAt: 1_000,
  });
  accumulator.observe({ kind: 'turn.started' }, 1_000);
  accumulator.observe({ kind: 'turn.text', delta: text }, 1_001);
  return accumulator.checkpoint();
}

function payload(checkpoint = liveCheckpoint('Recovered work')): SessionOpenedPayload {
  return {
    session: {
      path: sessionPath,
      cwd: '/workspace',
      name: 'Running',
      modifiedAt: '2026-07-28T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [{
      id: 'user-1',
      role: 'user',
      createdAt: '2026-07-28T00:00:00.000Z',
      markdown: 'Do the work',
      status: 'completed',
    }],
    transcriptWindow: {
      totalCount: 2,
      loadedStart: 0,
      loadedEnd: 1,
      hasOlder: false,
      hasNewer: true,
      isPartial: true,
      hasUserMessages: true,
    },
    busy: true,
    liveTurnCheckpoint: checkpoint,
  };
}

test('busy session.opened atomically replaces a stale/tombstoned live turn from its checkpoint', () => {
  const stale = liveCheckpoint('starting model...');
  const key = `${stale.turnId}\u0000${stale.attemptId}`;
  const before: ArchState = {
    ...initialArchState,
    livePipeline: {
      ...initialArchState.livePipeline,
      turnsBySession: { [sessionPath]: stale.turn },
      terminalAttempts: {
        [key]: {
          sessionPath,
          turnId: stale.turnId,
          attemptId: stale.attemptId,
          finalSeq: stale.checkpointSeq,
          terminalKind: 'error',
          expiresAt: 99_999,
        },
      },
    },
  };

  const result = reducer(before, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    sessionPath,
    payload: payload(),
  });

  const turn = result.state.livePipeline.turnsBySession[sessionPath];
  assert.ok(turn);
  assert.equal(turn.parts.find((part) => part.kind === 'text')?.text, 'Recovered work');
  assert.equal(result.state.livePipeline.terminalAttempts[key], undefined);
  const view = projectTranscriptView(
    result.state.transcript.bySession[sessionPath] ?? [],
    result.state.livePipeline,
    sessionPath,
  );
  assert.equal(view.activeTurn?.markdown, 'Recovered work');
  assert.equal(result.effects.length, 0);
});

test('busy session.opened checkpoint commits the matching optimistic send and clears its watchdog', () => {
  const checkpoint = liveCheckpoint('Recovered work');
  const before: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      promoted: {
        'send-corr': {
          kind: 'send', sessionPath, localId: 'local:user', previousSummary: null,
          text: 'Do the work', inputs: [], requestId: 'request-1', startedAt: 900,
        },
      },
      requestIdToLocalId: {
        'request-1': { sessionPath, localId: 'local:user' },
      },
      prepassBySession: {
        [sessionPath]: { phase: 'succeeded', latencyMs: 25 },
      },
    },
  };

  const result = reducer(before, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0,
    modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath,
    payload: payload(checkpoint),
  });

  assert.deepEqual(result.effects, [{ kind: 'ClearSendTimer', corrId: 'send-corr' }]);
  assert.equal(result.state.pending.promoted['send-corr'], undefined);
  assert.equal(result.state.pending.prepassBySession[sessionPath], undefined);
  assert.equal(result.state.pending.requestIdToLocalId['request-1'], undefined);
  assert.deepEqual(result.state.pending.currentTurnBySession[sessionPath], {
    requestId: 'request-1', firstMessageId: 'request-1:1',
  });
});

test('authoritative idle session.opened removes an orphaned live row beside its durable terminal', () => {
  const stale = liveCheckpoint('Duplicated stale response');
  const staleKey = `${stale.turnId}\u0000${stale.attemptId}`;
  const before: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      runningSessionPaths: [sessionPath],
    },
    livePipeline: {
      ...initialArchState.livePipeline,
      turnsBySession: { [sessionPath]: stale.turn },
      terminalAttempts: {
        [staleKey]: {
          sessionPath,
          turnId: stale.turnId,
          attemptId: stale.attemptId,
          finalSeq: stale.checkpointSeq,
          terminalKind: 'completed',
          expiresAt: 99_999,
        },
      },
    },
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: {
        [sessionPath]: { requestId: stale.turn.requestId, firstMessageId: stale.turn.canonicalMessageId },
      },
    },
  };
  const opened = payload();
  opened.busy = false;
  delete opened.liveTurnCheckpoint;
  opened.transcript = [
    opened.transcript[0]!,
    {
      id: 'assistant-durable',
      role: 'assistant',
      createdAt: '2026-07-28T00:01:00.000Z',
      markdown: 'Duplicated stale response',
      status: 'completed',
    },
  ];
  opened.transcriptWindow = {
    totalCount: 2,
    loadedStart: 0,
    loadedEnd: 2,
    hasOlder: false,
    hasNewer: false,
    isPartial: false,
    hasUserMessages: true,
  };

  const result = reducer(before, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0,
    modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath, payload: opened,
  });

  assert.equal(result.state.livePipeline.turnsBySession[sessionPath], undefined);
  assert.equal(result.state.livePipeline.terminalAttempts[staleKey], undefined);
  assert.equal(result.state.pending.currentTurnBySession[sessionPath], undefined);
  assert.equal(result.state.sessions.runningSessionPaths.includes(sessionPath), false);
  const view = projectTranscriptView(
    result.state.transcript.bySession[sessionPath] ?? [],
    result.state.livePipeline,
    sessionPath,
  );
  assert.deepEqual(view.messages.map((message) => message.markdown), [
    'Do the work',
    'Duplicated stale response',
  ]);
});

test('busy open without a checkpoint uses bounded recovery identity when the host has no prior live turn', () => {
  const opened = payload();
  delete opened.liveTurnCheckpoint;
  opened.liveTurnRecoveryIdentity = { turnId: 'turn-1', attemptId: 'attempt-1' };

  const result = reducer(initialArchState, { kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath, payload: opened });

  assert.deepEqual(result.effects, [{
    kind: 'RequestLiveTurnCheckpoint',
    corrId: 'live-checkpoint:turn-1:attempt-1:session-opened',
    sessionPath,
    turnId: 'turn-1',
    attemptId: 'attempt-1',
  }]);
});

test('snapshotUnavailable preserves an already-loaded transcript instead of treating the empty transport window as authoritative', () => {
  const existing = payload().transcript[0]!;
  const before: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { [sessionPath]: [existing] },
      windowBySession: {
        [sessionPath]: {
          totalCount: 1,
          loadedStart: 0,
          loadedEnd: 1,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: true,
        },
      },
    },
  };
  const opened = payload();
  opened.busy = false;
  delete opened.liveTurnCheckpoint;
  opened.transcript = [];
  opened.snapshotUnavailable = {
    code: 'SESSION_SNAPSHOT_TOO_LARGE',
    message: 'Lossless snapshot unavailable.',
  };

  const result = reducer(before, { kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath, payload: opened });

  assert.deepEqual(result.state.transcript.bySession[sessionPath], [existing]);
  assert.deepEqual(result.state.transcript.windowBySession[sessionPath], before.transcript.windowBySession[sessionPath]);
});

test('busy open without a checkpoint keeps the durable assistant tail visible and requests repair', () => {
  const checkpoint = liveCheckpoint('stale live');
  const before: ArchState = {
    ...initialArchState,
    livePipeline: {
      ...initialArchState.livePipeline,
      turnsBySession: { [sessionPath]: checkpoint.turn },
    },
  };
  const opened = payload();
  delete opened.liveTurnCheckpoint;
  opened.transcript = [
    opened.transcript[0]!,
    {
      id: 'assistant-durable',
      role: 'assistant',
      createdAt: '2026-07-28T00:01:00.000Z',
      markdown: 'Forty-five tools of durable work',
      status: 'error',
      errorDetail: 'Provider timed out.',
    },
  ];
  opened.transcriptWindow = {
    ...opened.transcriptWindow,
    loadedEnd: 2,
    hasNewer: false,
    isPartial: false,
  };

  const result = reducer(before, { kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0, sessionPath, payload: opened });
  assert.equal(
    result.state.transcript.bySession[sessionPath]?.at(-1)?.markdown,
    'Forty-five tools of durable work',
  );
  assert.equal(result.effects[0]?.kind, 'RequestLiveTurnCheckpoint');
});
