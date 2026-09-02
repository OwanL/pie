import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { ChatMessage } from '../../../shared/protocol/messages.js';
import type { ThinkingLevel } from '../../../shared/protocol/models.js';
import {
  LIVE_PIPELINE_LIMITS,
  type LivePipelineState,
  type TurnSemanticEnvelope,
} from '../../../shared/live-pipeline-protocol.js';
import type { Event } from '../events.js';
import type { Effect } from '../effects.js';
import { commitPromotedSend, startSessionTitleGeneration, type ReducerResult } from './helpers.js';
import { applyLiveTurnCheckpoint } from '../live-pipeline/checkpoint.js';
import { interruptLivePipelineForRestart } from '../live-pipeline/cleanup.js';
import { applyLiveSemanticEnvelope } from '../live-pipeline/transitions.js';
import {
  reconcileDurableMessageRenderMetadata,
  reconcileDurableTerminalToolMetadata,
} from '../live-pipeline/terminal-reconciliation.js';
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

  // `retry.started` is emitted before the SDK's backoff. Its matching success
  // event arrives only after the retried assistant message completes, so using
  // retry.ended alone leaves a misleading "Retrying…" chip over healthy live
  // output. The first accepted provider-authored semantic progress proves the
  // retry has resumed; clear only the UI marker while backend retry timing
  // continues to its real terminal boundary.
  if (transition.classification === 'applied' && isProviderResponseProgress(envelope.kind)) {
    nextState = clearRetryStatus(nextState, envelope.sessionPath);
  }

  if (envelope.kind === 'turn.started' && transition.classification === 'applied') {
    nextState = reconcileServingModelSummary(
      nextState,
      envelope.sessionPath,
      envelope.modelId,
      envelope.provider,
      envelope.thinkingLevel,
    );
    const commit = commitPromotedSend(nextState, envelope.sessionPath, envelope.requestId, envelope.canonicalMessageId);
    nextState = commit.state;
    effects.push(...commit.effects);
    const titleStart = startSessionTitleGeneration(nextState, envelope.sessionPath, envelope.requestId);
    nextState = titleStart.state;
    effects.push(...titleStart.effects);
  }

  if (!repairAlreadyRequested && (transition.classification === 'gap'
    || transition.classification === 'owner_pending'
    || transition.classification === 'invalid')) {
    effects.push(checkpointEffect(envelope.sessionPath, envelope.turnId, envelope.attemptId, envelope.seq));
  }

  if (transition.classification === 'committed') {
    nextState = appendDurableTerminal(nextState, envelope.sessionPath, transition.terminal);
    nextState = clearPendingExtensionUiRequests(nextState, envelope.sessionPath);
  }
  return { state: nextState, effects };
}

function isProviderResponseProgress(kind: TurnSemanticEnvelope['kind']): boolean {
  return kind === 'turn.text' || kind === 'turn.reasoning' || kind === 'turn.toolDraft' || kind === 'tool.started';
}

function clearRetryStatus(state: ArchState, sessionPath: string): ArchState {
  if (!(sessionPath in state.sessions.retryStatusBySession)) return state;
  const retryStatusBySession = { ...state.sessions.retryStatusBySession };
  delete retryStatusBySession[sessionPath];
  return { ...state, sessions: { ...state.sessions, retryStatusBySession } };
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
  let next = reconcileServingModelSummary(
    { ...state, livePipeline: applied.state },
    event.checkpoint.sessionPath,
    event.checkpoint.turn.modelId,
    event.checkpoint.turn.provider,
    event.checkpoint.turn.thinkingLevel,
  );
  // A checkpoint can be the first authoritative proof that a turn crossed its
  // commit point. This happens when turn.started was missed, arrived behind a
  // cold session.opened checkpoint, or was classified for repair. Reconcile
  // the optimistic send exactly as the direct turn.started path does so its
  // rollback snapshot and watchdog cannot survive a healthy running turn.
  const committedSend = commitPromotedSend(
    next,
    event.checkpoint.sessionPath,
    event.checkpoint.turn.requestId,
    event.checkpoint.turn.canonicalMessageId,
  );
  next = committedSend.state;
  const titleStart = startSessionTitleGeneration(
    next,
    event.checkpoint.sessionPath,
    event.checkpoint.turn.requestId,
  );
  next = titleStart.state;
  const commitEffects = [...committedSend.effects, ...titleStart.effects];
  if (event.checkpoint.terminal) {
    const turns = { ...next.livePipeline.turnsBySession };
    delete turns[event.sessionPath];
    const tools = { ...next.livePipeline.toolsByExecutionId };
    for (const executionId of event.checkpoint.turn.toolExecutionIds) delete tools[executionId];
    const pendingOwnerEvents = { ...next.livePipeline.pendingOwnerEvents };
    delete pendingOwnerEvents[pendingOwnerKey(event.turnId, event.attemptId)];
    const terminal = reconcileDurableTerminalToolMetadata(
      event.checkpoint.terminal,
      event.checkpoint.turn,
      event.checkpoint.tools,
    );
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
    next = clearPendingExtensionUiRequests(next, event.sessionPath);
  } else if (event.status === 'terminal_grace') {
    const interrupted = interruptOne(next, event.sessionPath, event.occurredAt);
    return { state: interrupted.state, effects: [...commitEffects, ...interrupted.effects] };
  } else {
    const replayed = replayPendingAfterCheckpoint(next, event.turnId, event.attemptId);
    return { state: replayed.state, effects: [...commitEffects, ...replayed.effects] };
  }
  return { state: next, effects: commitEffects };
}

function reconcileServingModelSummary(
  state: ArchState,
  sessionPath: string,
  modelId: string | undefined,
  provider: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): ArchState {
  if (!modelId) return state;
  let changed = false;
  const sessions = state.sessions.sessions.map((session) => {
    if (session.path !== sessionPath
      || (session.modelId === modelId
        && (provider === undefined || session.provider === provider)
        && (thinkingLevel === undefined || session.thinkingLevel === thinkingLevel))) return session;
    changed = true;
    return {
      ...session,
      modelId,
      ...(provider !== undefined ? { provider } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    };
  });
  return changed
    ? { ...state, sessions: { ...state.sessions, sessions } }
    : state;
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
      state = clearPendingExtensionUiRequests(state, envelope.sessionPath);
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

function appendDurableTerminal(state: ArchState, sessionPath: string, terminal: ChatMessage): ArchState {
  return produce(state, (draft) => {
    const list = draft.transcript.bySession[sessionPath] ??= [];
    const durableEntryIndex = terminal.durableEntryId
      ? list.findIndex((message) => message.role === 'assistant'
        && message.durableEntryId === terminal.durableEntryId)
      : -1;
    const durableIdIndex = durableEntryIndex < 0
      ? list.findIndex((message) => message.role === 'assistant'
        && message.id === terminal.id
        && (terminal.durableEntryId === undefined || message.durableEntryId === undefined))
      : -1;
    const streamingIndex = list.findIndex((message) =>
      message.role === 'assistant' && message.status === 'streaming',
    );
    const index = durableEntryIndex >= 0
      ? durableEntryIndex
      : durableIdIndex >= 0 ? durableIdIndex : streamingIndex;
    if (index >= 0) {
      const previous = list[index];
      list[index] = previous?.role === 'assistant' && previous.status !== 'streaming'
        ? reconcileDurableMessageRenderMetadata(terminal, previous)
        : terminal;
    }
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
        Object.entries(state.livePipeline.toolsByExecutionId).filter(([, tool]) =>
          tool.turnId === turn.turnId && tool.attemptId === turn.attemptId,
        ),
      ),
    },
    occurredAt,
    occurredAt + TERMINAL_TOMBSTONE_GRACE_MS,
  );
  const cleared = clearLiveAttempt(state.livePipeline, sessionPath, turn.turnId, turn.attemptId);
  let next = { ...state, livePipeline: {
    ...cleared,
    terminalAttempts: { ...cleared.terminalAttempts, ...transformed.state.terminalAttempts },
    revisionBySession: {
      ...cleared.revisionBySession,
      [sessionPath]: transformed.state.revisionBySession[sessionPath]
        ?? (cleared.revisionBySession[sessionPath] ?? 0) + 1,
    },
  } };
  const interrupted = transformed.interruptedBySession[sessionPath];
  if (interrupted) next = appendDurableTerminal(next, sessionPath, interrupted);
  next = clearPendingExtensionUiRequests(next, sessionPath);
  return { state: next, effects: [] };
}

/** A dead attempt cannot retain an actionable extension-UI prompt. */
function clearPendingExtensionUiRequests(state: ArchState, sessionPath: string): ArchState {
  if (!state.settings.pendingExtensionUIRequestsBySession[sessionPath]) return state;
  const pendingExtensionUIRequestsBySession = {
    ...state.settings.pendingExtensionUIRequestsBySession,
  };
  delete pendingExtensionUIRequestsBySession[sessionPath];
  return {
    ...state,
    settings: { ...state.settings, pendingExtensionUIRequestsBySession },
  };
}

/** Remove every live-pipeline structure owned by one terminalized attempt. */
function clearLiveAttempt(
  livePipeline: LivePipelineState,
  sessionPath: string,
  turnId: string,
  attemptId: string,
): LivePipelineState {
  const turnsBySession = { ...livePipeline.turnsBySession };
  const owner = turnsBySession[sessionPath];
  if (owner?.turnId === turnId && owner.attemptId === attemptId) delete turnsBySession[sessionPath];

  const toolsByExecutionId = Object.fromEntries(
    Object.entries(livePipeline.toolsByExecutionId).filter(([, tool]) =>
      tool.turnId !== turnId || tool.attemptId !== attemptId,
    ),
  );
  const pendingOwnerEvents = { ...livePipeline.pendingOwnerEvents };
  delete pendingOwnerEvents[pendingOwnerKey(turnId, attemptId)];

  return { ...livePipeline, turnsBySession, toolsByExecutionId, pendingOwnerEvents };
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
