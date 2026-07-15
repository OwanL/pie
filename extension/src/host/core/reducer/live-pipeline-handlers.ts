import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { ChatMessage } from '../../../shared/protocol/messages.js';
import { LIVE_PIPELINE_LIMITS } from '../../../shared/live-pipeline-protocol.js';
import type { Event } from '../events.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { applyLiveTurnCheckpoint } from '../live-pipeline/checkpoint.js';
import { interruptLivePipelineForRestart } from '../live-pipeline/cleanup.js';
import { applyLiveSemanticEnvelope } from '../live-pipeline/transitions.js';
import { withIncrementedWindowCounts } from '../transcript-window.js';
import { pendingOwnerKey, pruneExpiredTerminalAttempts, terminalAttemptKey } from '../live-pipeline/model.js';

const TERMINAL_TOMBSTONE_GRACE_MS = 15_000;

export function handleTurnSemanticEvent(
  state: ArchState,
  event: Extract<Event, { kind: 'TurnSemanticEventReceived' }>,
): ReducerResult {
  const envelope = event.envelope;
  const ownerBefore = state.livePipeline.turnsBySession[envelope.sessionPath];
  const pendingBefore = state.livePipeline.pendingOwnerEvents[pendingOwnerKey(envelope.turnId, envelope.attemptId)] ?? [];
  const repairAlreadyRequested = ownerBefore?.turnId === envelope.turnId
    && ownerBefore.attemptId === envelope.attemptId
    && ownerBefore.reconciliation?.status === 'requested'
    || pendingBefore.length > 0;
  const transition = applyLiveSemanticEnvelope(
    state.livePipeline,
    envelope,
    envelope.occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
  );
  let nextState = transition.state === state.livePipeline
    ? state
    : { ...state, livePipeline: transition.state };
  const effects: Effect[] = [];

  if (envelope.kind === 'turn.started' && transition.classification === 'applied') {
    const commit = commitPromotedSend(nextState, envelope.sessionPath, envelope.requestId, envelope.canonicalMessageId);
    nextState = commit.state;
    effects.push(...commit.effects);
  }

  if (!repairAlreadyRequested && (transition.classification === 'gap'
    || transition.classification === 'owner_pending'
    || transition.classification === 'invalid')) {
    effects.push(checkpointEffect(envelope.sessionPath, envelope.turnId, envelope.attemptId, envelope.seq));
  }

  if (transition.classification === 'committed') {
    nextState = appendDurableTerminal(nextState, envelope.sessionPath, transition.terminal);
  }
  return { state: nextState, effects };
}

export function handleLiveLifecycleWatermark(
  state: ArchState,
  event: Extract<Event, { kind: 'LiveLifecycleWatermarkReceived' }>,
): ReducerResult {
  const { watermark } = event;
  const turn = state.livePipeline.turnsBySession[watermark.sessionPath];
  const tombstone = state.livePipeline.terminalAttempts[`${watermark.turnId}\u0000${watermark.attemptId}`];
  if (tombstone?.finalSeq === watermark.finalSeq) return { state, effects: [] };
  if (!turn || turn.turnId !== watermark.turnId || turn.attemptId !== watermark.attemptId || turn.seq <= watermark.finalSeq) {
    return {
      state,
      effects: [checkpointEffect(watermark.sessionPath, watermark.turnId, watermark.attemptId, watermark.finalSeq)],
    };
  }
  return { state, effects: [] };
}

export function handleLiveTurnCheckpointResult(
  state: ArchState,
  event: Extract<Event, { kind: 'LiveTurnCheckpointResult' }>,
): ReducerResult {
  if (!event.ok || !event.checkpoint) {
    if (event.status === 'inactive' || event.status === 'backend_restarted') {
      return interruptOne(state, event.sessionPath, event.occurredAt);
    }
    return markCheckpointFailure(state, event.sessionPath, event.turnId, event.attemptId, event.occurredAt);
  }
  if (event.checkpoint.turnId !== event.turnId || event.checkpoint.attemptId !== event.attemptId) {
    return markCheckpointFailure(state, event.sessionPath, event.turnId, event.attemptId, event.occurredAt);
  }
  const applied = applyLiveTurnCheckpoint(state.livePipeline, event.checkpoint);
  if (applied.classification !== 'applied') {
    if (applied.classification === 'stale') return { state, effects: [] };
    return markCheckpointFailure(state, event.sessionPath, event.turnId, event.attemptId, event.occurredAt);
  }
  let next = { ...state, livePipeline: applied.state };
  if (event.checkpoint.terminal) {
    const turns = { ...next.livePipeline.turnsBySession };
    delete turns[event.sessionPath];
    const tools = { ...next.livePipeline.toolsByExecutionId };
    for (const executionId of event.checkpoint.turn.toolExecutionIds) delete tools[executionId];
    const pendingOwnerEvents = { ...next.livePipeline.pendingOwnerEvents };
    delete pendingOwnerEvents[pendingOwnerKey(event.turnId, event.attemptId)];
    const terminal = event.checkpoint.terminal;
    const terminalKind = terminal.status === 'interrupted'
      ? 'interrupted' as const
      : terminal.status === 'error' ? 'error' as const : 'completed' as const;
    const terminalAttempts = pruneExpiredTerminalAttempts({
      ...next.livePipeline.terminalAttempts,
      [terminalAttemptKey(event.turnId, event.attemptId)]: {
        sessionPath: event.sessionPath,
        turnId: event.turnId,
        attemptId: event.attemptId,
        finalSeq: event.checkpoint.checkpointSeq,
        terminalKind,
        expiresAt: event.occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
      },
    }, event.occurredAt, LIVE_PIPELINE_LIMITS.terminalTombstones);
    next = {
      ...next,
      livePipeline: {
        ...next.livePipeline,
        turnsBySession: turns,
        toolsByExecutionId: tools,
        pendingOwnerEvents,
        terminalAttempts,
      },
    };
    next = appendDurableTerminal(next, event.sessionPath, terminal);
  } else if (event.status === 'terminal_grace') {
    return interruptOne(next, event.sessionPath, event.occurredAt);
  } else {
    return replayPendingAfterCheckpoint(next, event.turnId, event.attemptId);
  }
  return { state: next, effects: [] };
}

function replayPendingAfterCheckpoint(
  initial: ArchState,
  turnId: string,
  attemptId: string,
): ReducerResult {
  const key = pendingOwnerKey(turnId, attemptId);
  const queued = [...(initial.livePipeline.pendingOwnerEvents[key] ?? [])]
    .sort((left, right) => left.seq - right.seq);
  if (queued.length === 0) return { state: initial, effects: [] };
  const pendingOwnerEvents = { ...initial.livePipeline.pendingOwnerEvents };
  delete pendingOwnerEvents[key];
  let state: ArchState = {
    ...initial,
    livePipeline: { ...initial.livePipeline, pendingOwnerEvents },
  };
  const effects: Effect[] = [];
  for (let index = 0; index < queued.length; index += 1) {
    const envelope = queued[index]!;
    const owner = state.livePipeline.turnsBySession[envelope.sessionPath];
    if (owner && envelope.seq <= owner.seq) continue;
    const followsOwner = owner && (envelope.kind === 'tool.progress'
      ? envelope.baseSeq === owner.seq
      : envelope.seq === owner.seq + 1);
    if (!followsOwner) {
      state = {
        ...state,
        livePipeline: {
          ...state.livePipeline,
          pendingOwnerEvents: {
            ...state.livePipeline.pendingOwnerEvents,
            [key]: queued.slice(index),
          },
        },
      };
      effects.push(checkpointEffect(envelope.sessionPath, turnId, attemptId, envelope.seq));
      break;
    }
    const transition = applyLiveSemanticEnvelope(
      state.livePipeline,
      envelope,
      envelope.occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
    );
    state = transition.state === state.livePipeline
      ? state
      : { ...state, livePipeline: transition.state };
    if (transition.classification === 'committed') {
      state = appendDurableTerminal(state, envelope.sessionPath, transition.terminal);
      break;
    }
    if (transition.classification !== 'applied' && transition.classification !== 'duplicate_or_late') {
      effects.push(checkpointEffect(envelope.sessionPath, turnId, attemptId, envelope.seq));
      break;
    }
  }
  return { state, effects };
}

function checkpointEffect(sessionPath: string, turnId: string, attemptId: string, seq: number): Effect {
  return {
    kind: 'RequestLiveTurnCheckpoint',
    corrId: `live-checkpoint:${turnId}:${attemptId}:${seq}`,
    sessionPath,
    turnId,
    attemptId,
  };
}

function commitPromotedSend(
  state: ArchState,
  sessionPath: string,
  requestId: string,
  canonicalMessageId: string,
): ReducerResult {
  const effects: Effect[] = [];
  let promotedCorrId: string | undefined;
  for (const [corrId, operation] of Object.entries(state.pending.promoted)) {
    if (operation.requestId === requestId) {
      promotedCorrId = corrId;
      effects.push({ kind: 'ClearSendTimer', corrId });
      break;
    }
  }
  const next = produce(state, (draft) => {
    draft.pending.currentTurnBySession[sessionPath] = { requestId, firstMessageId: canonicalMessageId };
    delete draft.pending.requestIdToLocalId[requestId];
    if (promotedCorrId) delete draft.pending.promoted[promotedCorrId];
    delete draft.pending.prepassBySession[sessionPath];
  });
  return { state: next, effects };
}

function appendDurableTerminal(state: ArchState, sessionPath: string, terminal: ChatMessage): ArchState {
  return produce(state, (draft) => {
    const list = draft.transcript.bySession[sessionPath] ??= [];
    const durableIndex = terminal.durableEntryId
      ? list.findIndex((message) => message.durableEntryId === terminal.durableEntryId)
      : -1;
    const streamingIndex = list.findIndex((message) =>
      message.role === 'assistant' && message.status === 'streaming',
    );
    const index = durableIndex >= 0 ? durableIndex : streamingIndex;
    if (index >= 0) list[index] = terminal;
    else {
      list.push(terminal);
      draft.transcript.windowBySession[sessionPath] = withIncrementedWindowCounts(
        draft.transcript.windowBySession[sessionPath],
      );
    }
    delete draft.pending.currentTurnBySession[sessionPath];
  });
}

function interruptOne(state: ArchState, sessionPath: string, occurredAt: number): ReducerResult {
  const turn = state.livePipeline.turnsBySession[sessionPath];
  if (!turn) return { state, effects: [] };
  const transformed = interruptLivePipelineForRestart(
    {
      ...state.livePipeline,
      turnsBySession: { [sessionPath]: turn },
      toolsByExecutionId: Object.fromEntries(
        Object.entries(state.livePipeline.toolsByExecutionId).filter(([, tool]) => tool.turnId === turn.turnId),
      ),
    },
    occurredAt,
    occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
  );
  let next = { ...state, livePipeline: {
    ...state.livePipeline,
    turnsBySession: Object.fromEntries(Object.entries(state.livePipeline.turnsBySession).filter(([path]) => path !== sessionPath)),
    toolsByExecutionId: Object.fromEntries(Object.entries(state.livePipeline.toolsByExecutionId).filter(([, tool]) => tool.turnId !== turn.turnId)),
    terminalAttempts: { ...state.livePipeline.terminalAttempts, ...transformed.state.terminalAttempts },
  } };
  const interrupted = transformed.interruptedBySession[sessionPath];
  if (interrupted) next = appendDurableTerminal(next, sessionPath, interrupted);
  return { state: next, effects: [] };
}

function markCheckpointFailure(
  state: ArchState,
  sessionPath: string,
  turnId: string,
  attemptId: string,
  occurredAt: number,
): ReducerResult {
  const candidate = state.livePipeline.turnsBySession[sessionPath];
  const turn = candidate?.turnId === turnId && candidate.attemptId === attemptId ? candidate : undefined;
  if (!turn) {
    const key = pendingOwnerKey(turnId, attemptId);
    const pending = state.livePipeline.pendingOwnerEvents[key] ?? [];
    if (pending.length === 0) return { state, effects: [] };
    const pendingOwnerEvents = { ...state.livePipeline.pendingOwnerEvents };
    delete pendingOwnerEvents[key];
    return {
      state: {
        ...state,
        livePipeline: {
          ...state.livePipeline,
          pendingOwnerEvents,
          terminalAttempts: pruneExpiredTerminalAttempts({
            ...state.livePipeline.terminalAttempts,
            [terminalAttemptKey(turnId, attemptId)]: {
              sessionPath,
              turnId,
              attemptId,
              finalSeq: Math.max(...pending.map((event) => event.seq)),
              terminalKind: 'interrupted',
              expiresAt: occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
            },
          }, occurredAt, LIVE_PIPELINE_LIMITS.terminalTombstones),
          revisionBySession: {
            ...state.livePipeline.revisionBySession,
            [sessionPath]: (state.livePipeline.revisionBySession[sessionPath] ?? 0) + 1,
          },
        },
      },
      effects: [],
    };
  }
  const attempts = (turn.reconciliation?.attempts ?? 0) + 1;
  if (attempts >= 3) return interruptOne(state, sessionPath, occurredAt);
  return {
    state: {
      ...state,
      livePipeline: {
        ...state.livePipeline,
        turnsBySession: {
          ...state.livePipeline.turnsBySession,
          [sessionPath]: {
            ...turn,
            phase: 'reconciling_gap',
            reconciliation: {
              expectedSeq: turn.seq + 1,
              observedSeq: turn.reconciliation?.observedSeq ?? turn.seq,
              attempts,
              status: 'failed',
            },
          },
        },
      },
    },
    effects: [checkpointEffect(sessionPath, turn.turnId, turn.attemptId, turn.seq)],
  };
}
