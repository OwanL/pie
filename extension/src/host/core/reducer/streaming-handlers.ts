import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { ChatMessage } from '../../../shared/protocol.js';
import { stripReqIds } from '../../../shared/error-mapping.js';
import {
  appendAssistantTextPart,
  appendContinuationSeparator,
  upsertAssistantToolCall,
  withAssistantParts,
  mergeAssistantToolCallsPreservingResolvedState,
  mergeContinuationToolCalls,
} from '../transcript-helpers.js';
import {
  withIncrementedWindowCounts,
} from '../transcript-window.js';
import type { ReducerResult } from './helpers.js';
import { resolveAlias, enforceLoadedWindowBudget } from './helpers.js';
import type { Event, BackendEvent } from '../events.js';
import type { Effect } from '../effects.js';

export function handleMessageStarted(state: ArchState, event: Extract<Event, { kind: 'MessageStarted' }>): ReducerResult {
  const { sessionPath, messageId, requestId, modelId, thinkingLevel, timestamp } = event;
  const currentTurn = state.pending.currentTurnBySession[sessionPath];

  // Determine if this is a continuation (alias) of an existing turn
  const isAlias = !!(requestId && currentTurn && currentTurn.requestId === requestId);
  const canonicalMessageId = isAlias ? currentTurn!.firstMessageId : messageId;

  // Commit point: a promoted (early-acked) send has started streaming. The
  // reducer drops its rollback snapshot (below in produce) AND emits a
  // ClearSendTimer effect so EffectRunner cancels the post-ack send-timer for
  // this corrId (Brief B). Both the pre-ack RequestTracker timeout and the
  // send-timer are short-circuited by this commit point, so neither can fire
  // for this send afterward. MessageStarted carries requestId and precedes any
  // Delta, so it is the precise commit point. (Aliases — continuations of an
  // existing turn — already had their promoted entry dropped at the first
  // MessageStarted, so the scan is skipped for them.)
  const effects: Effect[] = [];
  let promotedCorrId: string | undefined;
  if (!isAlias && requestId) {
    for (const [cid, op] of Object.entries(state.pending.promoted)) {
      if (op.requestId === requestId) {
        promotedCorrId = cid;
        effects.push({ kind: 'ClearSendTimer', corrId: cid });
        break;
      }
    }
  }

  const nextState = produce(state, (draft) => {
    // Update alias map or currentTurnBySession
    if (isAlias) {
      draft.pending.messageIdAlias[messageId] = { canonicalId: currentTurn!.firstMessageId, sessionPath: event.sessionPath };
    } else if (requestId) {
      draft.pending.currentTurnBySession[sessionPath] = { requestId, firstMessageId: messageId };
      // Clean up requestIdToLocalId mapping to avoid leaks. We do NOT reconcile
      // the optimistic message ID here because MessageStarted carries the
      // assistant message ID, not the user message ID. Reconciliation will be
      // handled when the backend echoes localId back in a future event.
      delete draft.pending.requestIdToLocalId[requestId];
      if (promotedCorrId) {
        delete draft.pending.promoted[promotedCorrId];
        // Brief F: commit point — the turn started streaming, so the prepass
        // window is over. Drop the live chip (→ idle). Aligned with the
        // promoted-op drop above so phase + startedAt clear together; a later
        // in-turn failure is surfaced by the error mapper, never a rollback.
        delete draft.pending.prepassBySession[sessionPath];
      }
    }

    // Ensure assistant message in transcript
    const list = draft.transcript.bySession[sessionPath] ??= [];

    if (isAlias) {
      // Alias path: continuation of an existing turn — append separator & update metadata
      const canonical = list.find((m: ChatMessage) => m.id === canonicalMessageId);
      if (canonical) {
        appendContinuationSeparator(canonical);
        if (modelId) canonical.modelId = modelId;
        if (thinkingLevel) canonical.thinkingLevel = thinkingLevel;
        canonical.status = 'streaming';
      }
    } else {
      // Non-alias: check if message already exists (update metadata only)
      const existing = list.find((m: ChatMessage) => m.id === messageId);
      if (existing) {
        if (modelId) existing.modelId = modelId;
        if (thinkingLevel) existing.thinkingLevel = thinkingLevel;
      } else {
        // New message: create it
        list.push({
          id: messageId,
          role: 'assistant',
          createdAt: new Date(timestamp).toISOString(),
          markdown: '',
          modelId,
          thinkingLevel,
          parts: [],
          status: 'streaming',
          toolCalls: [],
        });

        draft.transcript.windowBySession[sessionPath] = withIncrementedWindowCounts(
          draft.transcript.windowBySession[sessionPath],
        );
        enforceLoadedWindowBudget(draft, sessionPath);
        // Cache the streaming message's index for O(1) per-delta lookup, but
        // only when this event owns the turn (requestId present → currentTurn's
        // firstMessageId === this message). enforceLoadedWindowBudget keeps the
        // active-turn (last) message last, so its index is the (post-cull) array
        // length minus one. A MessageStarted without requestId must not mutate
        // the existing turn's cached index.
        if (requestId) {
          const turn = draft.pending.currentTurnBySession[sessionPath];
          if (turn) {
            turn.firstMessageIndex = (draft.transcript.bySession[sessionPath]?.length ?? 0) - 1;
          }
        }
      }
    }
  });

  return { state: nextState, effects };
}

export function handleMessageDelta(state: ArchState, event: Extract<Event, { kind: 'MessageDelta' }>): ReducerResult {
  // Defense-in-depth: while a user-initiated Stop's abort is in flight
  // (`interruptInFlightBySession`), drop late deltas as a pure no-op. The
  // optimistic `interrupted` mark on streaming messages (handleInterrupt)
  // already gates appending via `status !== 'interrupted'`; this catches the
  // race where a stray `MessageStarted` created a fresh `streaming` message
  // after the optimistic mark so its content does not grow during the window.
  if (state.sessions.interruptInFlightBySession[event.sessionPath]) {
    return { state, effects: [] };
  }
  const messageId = resolveAlias(state, event.messageId);
  const cachedIndex = state.pending.currentTurnBySession[event.sessionPath]?.firstMessageIndex;
  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[event.sessionPath];
    if (!list) return;
    // O(1) guarded lookup: the cached streaming-turn index is stable during a
    // delta stream (cull only runs on MessageStarted/MessageFinished, not per
    // delta). Fall back to find if the index is absent or stale.
    const message =
      cachedIndex !== undefined && list[cachedIndex]?.id === messageId
        ? list[cachedIndex]
        : list.find((m: ChatMessage) => m.id === messageId);
    if (message && message.status !== 'completed' && message.status !== 'interrupted') {
      appendAssistantTextPart(message, 'text', event.delta);
      message.status = 'streaming';
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageThinking(state: ArchState, event: Extract<Event, { kind: 'MessageThinking' }>): ReducerResult {
  // Defense-in-depth: mirror handleMessageDelta's in-flight-abort gate so
  // late thinking deltas are dropped while a Stop's abort is settling.
  if (state.sessions.interruptInFlightBySession[event.sessionPath]) {
    return { state, effects: [] };
  }
  const messageId = resolveAlias(state, event.messageId);
  const cachedIndex = state.pending.currentTurnBySession[event.sessionPath]?.firstMessageIndex;
  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[event.sessionPath];
    if (!list) return;
    const message =
      cachedIndex !== undefined && list[cachedIndex]?.id === messageId
        ? list[cachedIndex]
        : list.find((m: ChatMessage) => m.id === messageId);
    if (message && message.status !== 'completed' && message.status !== 'interrupted') {
      appendAssistantTextPart(message, 'reasoning', event.thinking);
      message.status = 'streaming';
    }
  });

  return { state: nextState, effects: [] };
}

export function handleToolCall(state: ArchState, event: Extract<Event, { kind: 'ToolCall' }>): ReducerResult {
  const messageId = resolveAlias(state, event.messageId);
  const cachedIndex = state.pending.currentTurnBySession[event.sessionPath]?.firstMessageIndex;
  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[event.sessionPath];
    if (!list) return;
    const message =
      cachedIndex !== undefined && list[cachedIndex]?.id === messageId
        ? list[cachedIndex]
        : list.find((m: ChatMessage) => m.id === messageId);
    if (message) {
      upsertAssistantToolCall(message, event.toolCall);
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageFinished(state: ArchState, event: Extract<Event, { kind: 'MessageFinished' }>): ReducerResult {
  const messageId = resolveAlias(state, event.message.id);
  const isAlias = messageId !== event.message.id;
  const normalizedMessage = withAssistantParts(event.message);

  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[event.sessionPath] ??= [];

    if (isAlias) {
      // Alias merge: incoming message is a continuation — merge into canonical
      const canonical = list.find((m: ChatMessage) => m.id === messageId);
      if (canonical) {
        canonical.status = normalizedMessage.status;
        if (normalizedMessage.modelId) canonical.modelId = normalizedMessage.modelId;
        if (normalizedMessage.thinkingLevel) canonical.thinkingLevel = normalizedMessage.thinkingLevel;
        if (normalizedMessage.durationMs !== undefined) {
          canonical.durationMs = (canonical.durationMs ?? 0) + normalizedMessage.durationMs;
        }
        // Turn latency is a per-segment measurement (the gap before this
        // segment's reply), so overwrite with the latest measurable value
        // rather than accumulate — the indicator then reflects the most recent
        // reply gap. Only overwrite when defined so an unmeasurable segment
        // (e.g. one with no content delta) doesn't clobber a prior reading.
        if (normalizedMessage.turnLatencyMs !== undefined) canonical.turnLatencyMs = normalizedMessage.turnLatencyMs;
        if (normalizedMessage.overheadMs !== undefined) canonical.overheadMs = normalizedMessage.overheadMs;
        if (normalizedMessage.providerLatencyMs !== undefined) canonical.providerLatencyMs = normalizedMessage.providerLatencyMs;
        mergeContinuationToolCalls(canonical, normalizedMessage);
      }
    } else {
      const index = list.findIndex((m: ChatMessage) => m.id === normalizedMessage.id);
      if (index === -1) {
        list.push(normalizedMessage);
        draft.transcript.windowBySession[event.sessionPath] = withIncrementedWindowCounts(
          draft.transcript.windowBySession[event.sessionPath],
        );
        if (normalizedMessage.role === 'user') {
          draft.transcript.windowBySession[event.sessionPath].hasUserMessages = true;
        }
        enforceLoadedWindowBudget(draft, event.sessionPath);
      } else {
        const previousMessage = list[index];
        if (previousMessage) {
          mergeAssistantToolCallsPreservingResolvedState(normalizedMessage, previousMessage);
          // Preserve errorDetail set by onError if the replacement doesn't carry its own
          if (normalizedMessage.status === 'error' && !normalizedMessage.errorDetail && previousMessage.errorDetail) {
            normalizedMessage.errorDetail = previousMessage.errorDetail;
          }
        }
        list[index] = normalizedMessage;
      }
    }
  });

  return { state: nextState, effects: [] };
}

export function handleMessageAborted(state: ArchState, event: Extract<Event, { kind: 'MessageAborted' }>): ReducerResult {
  const { sessionPath, messageId } = event;
  if (!messageId) {
    return { state, effects: [] };
  }

  const canonicalId = resolveAlias(state, messageId);
  const nextState = produce(state, (draft) => {
    const message = draft.transcript.bySession[sessionPath]?.find(
      (m: ChatMessage) => m.id === canonicalId,
    );
    if (message) {
      message.status = 'interrupted';
      if (!event.userInitiated && event.reason && !message.errorDetail) {
        message.errorDetail = stripReqIds(event.reason);
      }
    }
  });

  return { state: nextState, effects: [] };
}

export function handleStreamingEvent(state: ArchState, event: Extract<BackendEvent, { kind: 'MessageStarted' } | { kind: 'MessageDelta' } | { kind: 'MessageThinking' } | { kind: 'ToolCall' } | { kind: 'MessageFinished' } | { kind: 'MessageAborted' }>): ReducerResult {
  switch (event.kind) {
    case 'MessageStarted':
      return handleMessageStarted(state, event);
    case 'MessageDelta':
      return handleMessageDelta(state, event);
    case 'MessageThinking':
      return handleMessageThinking(state, event);
    case 'ToolCall':
      return handleToolCall(state, event);
    case 'MessageFinished':
      return handleMessageFinished(state, event);
    case 'MessageAborted':
      return handleMessageAborted(state, event);
    default: {
      // Exhaustiveness: the switch is total over the streaming-event kinds
      // routed here from the top-level reducer.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `handleStreamingEvent: unhandled streaming kind (type system bypassed?): ${(event as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}

/** Steering: the agent loop injected a queued steering user message into the
 *  current turn. Promote the matching optimistic 'queued' user message to
 *  'completed' and drop its `pending.promoted`/`pending.ops` rollback snapshot
 *  (by localId) — the message has committed to a turn, so a later failure is an
 *  in-turn error, never a rollback. The subsequent assistant `MessageStarted`
 *  appends the reply under the in-progress request's id via the existing path.
 *
 *  Handoff §F — truthful delivery matching with legacy fallback:
 *  - When the backend correlated the delivery to a `localId` (it mirrors the
 *    SDK's FIFO steering drain in a per-session `queuedLocalIds` queue and
 *    shifts it on each user-role `message_start`), promote THAT exact message.
 *    If the id is no longer 'queued' (already cleared/delivered/interrupted),
 *    no-op — the id was authoritative, so we must NOT fall back to FIFO (that
 *    would wrongly promote a different queued message).
 *  - When `localId` is absent (legacy host that did not send one, or a
 *    clear/interrupt race emptied the backend's queue before the SDK drained),
 *    fall back to FIFO: promote the EARLIEST remaining 'queued' message (the
 *    SDK drains the steering queue one message at a time in enqueue order).
 *
 *  Either way, clear the dwell entry for the delivered message and cancel its
 *  watchdog (handoff §F: the queued message is no longer waiting). */
export function handleQueuedDelivered(state: ArchState, event: Extract<Event, { kind: 'QueuedDelivered' }>): ReducerResult {
  const list = state.transcript.bySession[event.sessionPath];
  if (!list) return { state, effects: [] };

  let idx: number;
  if (event.localId) {
    idx = list.findIndex((m) => m.id === event.localId && m.role === 'user' && m.status === 'queued');
    if (idx < 0) return { state, effects: [] };
  } else {
    idx = list.findIndex((m) => m.role === 'user' && m.status === 'queued');
    if (idx < 0) return { state, effects: [] };
  }
  const localId = list[idx].id;
  const nextState = produce(state, (draft) => {
    draft.transcript.bySession[event.sessionPath][idx].status = 'completed';
    for (const [corrId, op] of Object.entries(draft.pending.promoted)) {
      if (op.queued && op.localId === localId) delete draft.pending.promoted[corrId];
    }
    // Defensive: clear a still-pre-ack `ops` entry too (handles the
    // QueuedDelivered-before-SendResult race — the ack is then stale and a
    // later SendResult no-ops instead of rolling back a delivered message).
    for (const [corrId, op] of Object.entries(draft.pending.ops)) {
      if (op.queued && op.localId === localId) delete draft.pending.ops[corrId];
    }
    const dwell = draft.pending.queuedDwellBySession[event.sessionPath];
    if (dwell) {
      draft.pending.queuedDwellBySession[event.sessionPath] = dwell.filter((e) => e.localId !== localId);
    }
  });
  return {
    state: nextState,
    effects: [{ kind: 'CancelQueuedDwellWatchdog', corrId: 'queued:delivered', localId }],
  };
}

/** Handoff §F: the per-localId dwell watchdog fired — a queued message has
 *  waited past the hard threshold without being delivered. Mark the dwell
 *  entry actionable (`watchdogFired`) so the projection can surface Stop/Remove
 *  affordances (the existing Interrupt/ClearQueue commands). Does NOT interrupt
 *  the in-flight turn — healthy tools are not auto-stopped just because a
 *  follow-up was queued. Emits a `Log` (warn) so the stuck queue is observable.
 *  No-op if the entry is gone (delivered/cleared) or already terminal
 *  (`watchdogFired`/`abandoned`) — the timer fired late or the restart path
 *  already cancelled+marked it. */
export function handleQueuedDwellWatchdogFired(state: ArchState, event: Extract<Event, { kind: 'QueuedDwellWatchdogFired' }>): ReducerResult {
  const entry = state.pending.queuedDwellBySession[event.sessionPath]?.find((e) => e.localId === event.localId);
  if (!entry || entry.watchdogFired || entry.abandoned) {
    return { state, effects: [] };
  }
  const nextState = produce(state, (draft) => {
    const target = draft.pending.queuedDwellBySession[event.sessionPath]?.find((e) => e.localId === event.localId);
    if (target) target.watchdogFired = true;
  });
  return {
    state: nextState,
    effects: [
      {
        kind: 'Log',
        corrId: 'queued:watchdog',
        level: 'warn',
        message: `Queued message ${event.localId} in ${event.sessionPath} has waited past the dwell threshold — offering Stop/Remove.`,
      },
    ],
  };
}

export function handleAssistantMessageErrorStamped(
  state: ArchState,
  event: Extract<Event, { kind: 'AssistantMessageErrorStamped' }>,
): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const list = draft.transcript.bySession[event.sessionPath];
      if (!list) return;
      const reversed = [...list].reverse();
      const msg = reversed.find(
        (m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'error'),
      ) ?? reversed.find((m) => m.role === 'assistant');
      if (msg) {
        msg.status = 'error';
        msg.errorDetail = event.errorMessage;
      }
    }),
    effects: [],
  };
}
