import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, removeFromArray, removeMessage, restoreRemovedTail, upsertSessionSummary, evictSession, resolveAlias } from './helpers.js';
import type { ChatMessage, SessionSummary } from '../../../shared/protocol.js';
import { LIVE_PIPELINE_LIMITS } from '../../../shared/live-pipeline-protocol.js';
import { reorderOpenTabsPinnedFirst } from '../../../shared/tab-behavior.js';
import { resolveSessionOpenedTranscript } from '../session-opened-transcript.js';
import { materializeInterruptedLiveTurn } from '../live-pipeline/projection.js';
import { pruneExpiredTerminalAttempts, terminalAttemptKey } from '../live-pipeline/model.js';

const BACKEND_EXIT_TOMBSTONE_GRACE_MS = 15_000;

function mergeSessionSummaryPreservingLocalName(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) {
    return incoming;
  }

  const keepExistingName = !existing.isPlaceholder && incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    provider: incoming.provider ?? existing.provider,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
    // Review fields come from the session-review sidecar, which the backend
    // merges in. A backend list refresh that omits them (e.g. sidecar read
    // failed) must not wipe a previously-known review, so preserve the
    // existing value when the incoming summary doesn't carry one.
    done: incoming.done ?? existing.done,
    rating: incoming.rating ?? existing.rating,
    completion: incoming.completion ?? existing.completion,
    reviewReason: incoming.reviewReason ?? existing.reviewReason,
    evaluatedAt: incoming.evaluatedAt ?? existing.evaluatedAt,
  };
}

export function handleSessionClosed(state: ArchState, event: Extract<Event, { kind: 'SessionClosed' }>): ReducerResult {
  // Full eviction: the session is gone from the backend, so drop its summary,
  // running marker, and tab.
  return evictSession(state, event.sessionPath, { removeSummary: true, removeTabs: true });
}

export function handleSessionListChanged(state: ArchState, event: Extract<Event, { kind: 'SessionListChanged' }>): ReducerResult {
  const mergedByPath = new Map<string, SessionSummary>();

  for (const incoming of event.sessionSummaries) {
    const existing =
      mergedByPath.get(incoming.path)
      ?? state.sessions.sessions.find((session) => session.path === incoming.path);
    mergedByPath.set(incoming.path, mergeSessionSummaryPreservingLocalName(existing, incoming));
  }

  for (const existing of state.sessions.sessions) {
    if (!mergedByPath.has(existing.path) && state.sessions.openTabPaths.includes(existing.path)) {
      mergedByPath.set(existing.path, existing);
    }
  }

  if (state.sessions.activeSessionPath) {
    const activeSession = state.sessions.sessions.find(
      (session) => session.path === state.sessions.activeSessionPath,
    );
    if (activeSession && !mergedByPath.has(activeSession.path)) {
      mergedByPath.set(activeSession.path, activeSession);
    }
  }

  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: [...mergedByPath.values()],
      },
    },
    effects: [],
  };
}

export function handleSessionOpened(state: ArchState, event: Extract<Event, { kind: 'SessionOpened' }>): ReducerResult {
  const { sessionPath, payload } = event;
  let next: ArchState = state;

  const localTranscript = state.transcript.bySession[sessionPath] ?? [];
  // Skip-transcript path: the backend omitted the tail window (host requested
  // `transcript: 'skip'` because it already has the session loaded and idle).
  // Keep the existing transcript + window rather than replacing with the empty
  // incoming snapshot. Metadata (session summary, busy, analytics, models,
  // contextUsage, systemPrompts) is still applied below.
  const skipped = payload.transcriptSkipped === true
    && state.transcript.windowBySession[sessionPath] !== undefined;
  // Mirror the preserve decision made in attach.resolveAndDispatch: the
  // backend's `busy` flag is false during an EDIT's intermediate truncate
  // snapshot (emitted right after `session.truncateAfter` rewrites the file,
  // before `message.send` starts the new turn), but the host still holds a
  // pending optimistic edit message newer than that snapshot. Treat the host's
  // own running signal as an additional preserve trigger so the optimistic /
  // streaming state is not wiped (which previously cleared the transcript and
  // made the agent reply to nothing). See STATE_CONTRACT "Snapshot Recovery" /
  // "Optimistic Reconciliation". The authoritative agent_end snapshot lands
  // after BusyChanged(false), so hostRunning is false there and the final
  // transcript still replaces cleanly.
  const hostRunning = state.sessions.runningSessionPaths.includes(sessionPath);
  const {
    transcript: resolvedTranscript,
    transcriptWindow: resolvedWindow,
    aliases: resolvedAliases,
  } = skipped
    ? { transcript: localTranscript, transcriptWindow: state.transcript.windowBySession[sessionPath]!, aliases: [] as Array<{ aliasId: string; canonicalId: string }> }
    : resolveSessionOpenedTranscript({
        busy: payload.busy || hostRunning,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript,
      });

  // Sessions: running state, backend ready, upsert summary
  const nextRunningSessionPaths = payload.busy
    ? addToArray(state.sessions.runningSessionPaths, sessionPath)
    : state.sessions.runningSessionPaths;

  // Preserve review fields across `session.opened`'s full-replace upsert.
  // `payload.session` comes from `buildCurrentSummary`, which merges the
  // review sidecar; a transient sidecar read failure would omit `done`/`
  // `rating`/etc. and the upsert (a full replace, NOT `mergeSessionSummary*`)
  // would wipe previously-known review state. Fill from the existing summary
  // when the incoming summary lacks a field.
  const existingForOpened = state.sessions.sessions.find((s) => s.path === payload.session.path);
  const openedSummary: SessionSummary = existingForOpened
    ? {
        ...payload.session,
        done: payload.session.done ?? existingForOpened.done,
        rating: payload.session.rating ?? existingForOpened.rating,
        completion: payload.session.completion ?? existingForOpened.completion,
        reviewReason: payload.session.reviewReason ?? existingForOpened.reviewReason,
        evaluatedAt: payload.session.evaluatedAt ?? existingForOpened.evaluatedAt,
      }
    : payload.session;

  // Defensive model-picker hardening (STATE_CONTRACT § Optimistic
  // Reconciliation). An in-flight optimistic `SetModel` owns the model state
  // for this session: the reducer already flipped the global default + the
  // per-session badge, and `SetModelRpc` (settings.set) is en route. A
  // `session.opened` that lands before that write commits reads `settings.json`
  // and `buildCurrentSummary` from the PRE-switch state, so naively applying
  // its `modelSettings` / per-session badge would silently revert the user's
  // just-made choice. The lifecycle queue normally serializes `SetModelRpc`
  // before any `session.opened` for the same session, but guard against any
  // unforeseen event ordering so the picker stays trustworthy — preserve the
  // in-flight optimistic model for both the global default and the badge.
  // The `snapshot !== null` check scopes the guard to entries that have
  // actually been optimistically applied; the modal-pending stash
  // (`snapshot === null`) has not flipped any state, so a `session.opened`
  // during the modal window must still hydrate normally.
  const inFlightSetModel = Object.values(state.pending.setModelByCorrId)
    .find((p) => p.sessionPath === sessionPath && p.snapshot !== null);
  const guardedSummary: SessionSummary = inFlightSetModel
    ? {
        ...openedSummary,
        modelId: inFlightSetModel.modelSettings.defaultModel,
        thinkingLevel: inFlightSetModel.modelSettings.defaultThinkingLevel,
      }
    : openedSummary;

  // Any aliases discovered while merging must be stored so that later
  // backend events carrying the SDK-assigned message id resolve to the
  // streaming row the host kept.
  const nextMessageIdAlias = { ...state.pending.messageIdAlias };
  for (const { aliasId, canonicalId } of resolvedAliases) {
    nextMessageIdAlias[aliasId] = { canonicalId, sessionPath };
  }

  next = {
    ...next,
    sessions: {
      ...next.sessions,
      runningSessionPaths: nextRunningSessionPaths,
      sessions: upsertSessionSummary(next.sessions.sessions, guardedSummary),
      ...(payload.analyticsFactors && {
        analyticsFactorsBySession: {
          ...next.sessions.analyticsFactorsBySession,
          [sessionPath]: payload.analyticsFactors,
        },
      }),
    },
    settings: {
      ...next.settings,
      backendReady: true,
      ...(payload.availableModels && {
        availableModelsBySession: {
          ...next.settings.availableModelsBySession,
          [sessionPath]: payload.availableModels,
        },
      }),
      // Apply the global default from settings.json UNLESS an in-flight
      // optimistic SetModel owns it (see `inFlightSetModel` above) — a stale
      // pre-write reading must not revert the user's just-made choice.
      ...(!inFlightSetModel && payload.modelSettings && {
        modelSettings: payload.modelSettings,
      }),
      ...(payload.contextUsage !== undefined && {
        contextUsageBySession: {
          ...next.settings.contextUsageBySession,
          [sessionPath]: payload.contextUsage,
        },
      }),
    },
    transcript: {
      ...next.transcript,
      bySession: {
        ...next.transcript.bySession,
        [sessionPath]: resolvedTranscript,
      },
      windowBySession: {
        ...next.transcript.windowBySession,
        [sessionPath]: resolvedWindow,
      },
      ...(payload.systemPrompts && {
        systemPromptsBySession: {
          ...next.transcript.systemPromptsBySession,
          [sessionPath]: payload.systemPrompts,
        },
      }),
    },
    pending: {
      ...next.pending,
      messageIdAlias: nextMessageIdAlias,
    },
  };

  return { state: next, effects: [] };
}

export function handleSessionNameDerived(state: ArchState, event: Extract<Event, { kind: 'SessionNameDerived' }>): ReducerResult {
  const nextState = produce(state, (draft) => {
    const s = draft.sessions.sessions.find(x => x.path === event.sessionPath);
    if (s) {
      s.name = event.name;
      s.isPlaceholder = false;
    }
  });
  return { state: nextState, effects: [] };
}

export function handleBusyChanged(state: ArchState, event: Extract<Event, { kind: 'BusyChanged' }>): ReducerResult {
  if (event.running) {
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          runningSessionPaths: addToArray(state.sessions.runningSessionPaths, event.sessionPath),
          unreadFinishedSessionPaths: removeFromArray(
            state.sessions.unreadFinishedSessionPaths,
            event.sessionPath,
          ),
        },
      },
      effects: [],
    };
  }

  const wasRunning = state.sessions.runningSessionPaths.includes(event.sessionPath);
  const liveTurn = state.livePipeline.turnsBySession[event.sessionPath];
  const terminalRepairEffects: Effect[] = liveTurn ? [{
    kind: 'RequestLiveTurnCheckpoint',
    corrId: `live-checkpoint:${liveTurn.turnId}:${liveTurn.attemptId}:busy-false`,
    sessionPath: event.sessionPath,
    turnId: liveTurn.turnId,
    attemptId: liveTurn.attemptId,
  }] : [];

  if (!wasRunning) {
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
        },
      },
      effects: terminalRepairEffects,
    };
  }

  const isActive = state.sessions.activeSessionPath === event.sessionPath;

  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
        ...(isActive
          ? {}
          : {
              unreadFinishedSessionPaths: addToArray(
                state.sessions.unreadFinishedSessionPaths,
                event.sessionPath,
              ),
            }),
      },
    },
    effects: terminalRepairEffects,
  };
}

export function handleBusyCompleted(state: ArchState, _event: Extract<Event, { kind: 'BusyCompleted' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleContextUsageChanged(state: ArchState, event: Extract<Event, { kind: 'ContextUsageChanged' }>): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        contextUsageBySession: {
          ...state.settings.contextUsageBySession,
          [event.sessionPath]: event.contextUsage,
        },
      },
    },
    effects: [],
  };
}

export function handleSessionMetadataChanged(state: ArchState, event: Extract<Event, { kind: 'SessionMetadataChanged' }>): ReducerResult {
  const nextSessions = state.sessions.sessions.map((s) => {
    if (s.path !== event.sessionPath) return s;
    return {
      ...s,
      ...(event.modelId !== undefined && { modelId: event.modelId }),
      ...(event.provider !== undefined && { provider: event.provider }),
      ...(event.thinkingLevel !== undefined && { thinkingLevel: event.thinkingLevel }),
    };
  });
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
      },
    },
    effects: [],
  };
}

export function handleRunningSessionsChanged(state: ArchState, event: Extract<Event, { kind: 'RunningSessionsChanged' }>): ReducerResult {
  const running = new Set(event.sessionPaths);
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: event.sessionPaths,
        reviewClosedRunningPaths: state.sessions.reviewClosedRunningPaths.filter((p) => running.has(p)),
      },
    },
    effects: [],
  };
}

/** Record live auto-retry status for a session so the webview can surface a
 *  "Retrying N of M…" chip with a Cancel button. The SDK emits
 *  `auto_retry_start` after a transient error, just before the backoff sleep;
 *  each attempt overwrites the previous (no intervening `auto_retry_end` between
 *  attempts N and N+1). Pure (spread only). */
export function handleRetryStarted(state: ArchState, event: Extract<Event, { kind: 'RetryStarted' }>): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        retryStatusBySession: {
          ...state.sessions.retryStatusBySession,
          [event.sessionPath]: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorMessage: event.errorMessage,
          },
        },
      },
    },
    effects: [],
  };
}

/** Clear auto-retry status for a session. Emitted on retry success (retried turn
 *  produced a non-error message), final failure (retries exhausted), or
 *  cancellation (`session.abort()` aborted the retry sleep → "Retry cancelled").
 *  No-op if the session has no recorded retry status (defensive against a
 *  stray/late event). Pure (spread + delete on a shallow copy). */
export function handleRetryEnded(state: ArchState, event: Extract<Event, { kind: 'RetryEnded' }>): ReducerResult {
  const prev = state.sessions.retryStatusBySession;
  if (!(event.sessionPath in prev)) {
    return { state, effects: [] };
  }
  const nextRetryStatus = { ...prev };
  delete nextRetryStatus[event.sessionPath];
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        retryStatusBySession: nextRetryStatus,
      },
    },
    effects: [],
  };
}

/**
 * Mark every still-streaming assistant message in each listed session as
 * `interrupted` and stamp `errorDetail` with the supplied reason. Dispatched by
 * the backend `onExit` handler when the PI backend dies while sessions are
 * running — no `message.aborted` event ever fires in that case (the backend is
 * gone), so without this handler those sessions' streaming messages would stay
 * `status: 'streaming'` forever and the user would never be alerted that the
 * interruption was not their doing. Idempotent over alias resolution so an
 * aliased streaming turn (continuation) is stamped on its canonical message.
 */
export function handleSessionsInterrupted(state: ArchState, event: Extract<Event, { kind: 'SessionsInterrupted' }>): ReducerResult {
  const { sessionPaths, reason } = event;
  const occurredAt = event.occurredAt ?? 0;
  if (sessionPaths.length === 0) {
    return { state, effects: [] };
  }

  const affectedPaths = new Set(sessionPaths);
  const liveInterruptedBySession: Record<string, ChatMessage> = Object.fromEntries(sessionPaths.flatMap((sessionPath) => {
    const message = materializeInterruptedLiveTurn(state.livePipeline, sessionPath);
    return message ? [[sessionPath, { ...message, errorDetail: message.errorDetail ?? reason }]] : [];
  }));
  const rollbackOps = [
    ...Object.entries(state.pending.ops),
    ...Object.entries(state.pending.promoted),
  ].filter(([, op]) => affectedPaths.has(op.sessionPath));
  const rollbackEffects: Effect[] = rollbackOps.flatMap(([corrId, op]) => op.kind === 'send' ? [{
    kind: 'PostImperative' as const,
    corrId,
    imperativeMessage: {
      type: 'sendRejected' as const,
      sessionPath: op.sessionPath,
      text: op.text ?? '',
      localId: op.localId,
      inputs: op.inputs ?? [],
    },
  }] : []);
  const nextState = produce(state, (draft) => {
    for (const sessionPath of sessionPaths) {
      // A backend death mid-retry leaves a stale retry status; the retry is
      // dead (no `auto_retry_end` will fire), so clear it alongside the
      // streaming-message interruption.
      delete draft.sessions.retryStatusBySession[sessionPath];
      delete draft.sessions.interruptInFlightBySession[sessionPath];
      delete draft.settings.pendingExtensionUIRequestsBySession[sessionPath];
      delete draft.transcript.pagingInFlightBySession[sessionPath];
      delete draft.pending.currentTurnBySession[sessionPath];
      delete draft.pending.sendQueueBySession[sessionPath];
      delete draft.pending.backendReadyQueueBySession[sessionPath];
      delete draft.pending.prepassBySession[sessionPath];

      const liveTurn = draft.livePipeline.turnsBySession[sessionPath];
      if (liveTurn) {
        for (const executionId of liveTurn.toolExecutionIds) {
          delete draft.livePipeline.toolsByExecutionId[executionId];
        }
        delete draft.livePipeline.turnsBySession[sessionPath];
        draft.livePipeline.terminalAttempts[terminalAttemptKey(liveTurn.turnId, liveTurn.attemptId)] = {
          sessionPath,
          turnId: liveTurn.turnId,
          attemptId: liveTurn.attemptId,
          finalSeq: liveTurn.seq,
          terminalKind: 'interrupted',
          expiresAt: occurredAt + BACKEND_EXIT_TOMBSTONE_GRACE_MS,
        };
        draft.livePipeline.revisionBySession[sessionPath] =
          (draft.livePipeline.revisionBySession[sessionPath] ?? 0) + 1;
      }
      for (const [key, pendingEvents] of Object.entries(draft.livePipeline.pendingOwnerEvents)) {
        const pending = pendingEvents.find((candidate) => candidate.sessionPath === sessionPath);
        if (!pending) continue;
        draft.livePipeline.terminalAttempts[key] = {
          sessionPath,
          turnId: pending.turnId,
          attemptId: pending.attemptId,
          finalSeq: Math.max(...pendingEvents.map((candidate) => candidate.seq)),
          terminalKind: 'interrupted',
          expiresAt: occurredAt + BACKEND_EXIT_TOMBSTONE_GRACE_MS,
        };
        delete draft.livePipeline.pendingOwnerEvents[key];
      }
      draft.livePipeline.terminalAttempts = pruneExpiredTerminalAttempts(
        draft.livePipeline.terminalAttempts,
        occurredAt,
        LIVE_PIPELINE_LIMITS.terminalTombstones,
      );

      // Reconcile optimistic mutations before dropping their snapshots. This
      // mirrors SendResult/EditResult failure and makes late RPC rejection a
      // no-op because the corresponding pending entry is then absent.
      for (const [, op] of rollbackOps) {
        if (op.sessionPath !== sessionPath) continue;
        removeMessage(draft, sessionPath, op.localId);
        if (op.kind === 'edit' && op.removedTail?.length) {
          restoreRemovedTail(draft, sessionPath, op.removedTail);
        }
        if (op.kind === 'send') {
          draft.composer.draftTextBySession[sessionPath] = op.text ?? '';
          if (op.inputs?.length) draft.composer.pendingComposerInputsBySession[sessionPath] = [...op.inputs];
        }
        if (op.previousSummary) {
          const index = draft.sessions.sessions.findIndex((summary) => summary.path === op.previousSummary!.path);
          if (index >= 0) draft.sessions.sessions[index] = op.previousSummary;
          else draft.sessions.sessions.push(op.previousSummary);
        }
      }
      for (const [corrId, op] of Object.entries(draft.pending.ops)) {
        if (op.sessionPath === sessionPath) delete draft.pending.ops[corrId];
      }
      for (const [corrId, op] of Object.entries(draft.pending.promoted)) {
        if (op.sessionPath === sessionPath) delete draft.pending.promoted[corrId];
      }
      for (const [corrId, pending] of Object.entries(draft.pending.setModelByCorrId)) {
        if (pending.sessionPath === sessionPath) delete draft.pending.setModelByCorrId[corrId];
      }
      for (const [requestId, pending] of Object.entries(draft.pending.requestIdToLocalId)) {
        if (pending.sessionPath === sessionPath) delete draft.pending.requestIdToLocalId[requestId];
      }
      for (const [corrId, pending] of Object.entries(draft.pending.extensionUiResponseByCorrId)) {
        if (pending.sessionPath === sessionPath) delete draft.pending.extensionUiResponseByCorrId[corrId];
      }

      const interruptedLive = liveInterruptedBySession[sessionPath];
      const list = draft.transcript.bySession[sessionPath] ?? (interruptedLive
        ? (draft.transcript.bySession[sessionPath] = [])
        : undefined);
      if (!list) continue;
      if (interruptedLive) {
        const existingIndex = list.findIndex((message) => message.id === interruptedLive.id);
        if (existingIndex >= 0) list[existingIndex] = interruptedLive;
        else list.push(interruptedLive);
      }
      // The SDK steering queue is in-memory. After backend death delivery is
      // unknowable, so queued messages become explicitly interrupted rather
      // than remaining immortal optimistic rows.
      for (const message of list) {
        if (message.role === 'user' && message.status === 'queued') {
          message.status = 'interrupted';
          message.errorDetail = reason;
        }
        for (const tool of message.toolCalls ?? []) {
          if (tool.status === 'running') {
            tool.status = 'failed';
            tool.result = { error: reason };
          }
        }
      }
      // Walk newest-first because the streaming message is almost always the
      // last assistant message; resolving via alias on the underlying state
      // (read-only) covers continuation turns whose `id` is an alias of the
      // canonical streaming entry. The target is always looked up on the
      // draft so its mutations persist through `produce`.
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const message = list[i];
        if (message.role !== 'assistant' || message.status !== 'streaming') continue;
        const canonicalId = resolveAlias(state, message.id);
        const target = canonicalId === message.id
          ? message
          : list.find((m) => m.id === canonicalId);
        if (!target) continue;
        target.status = 'interrupted';
        if (!target.errorDetail) {
          target.errorDetail = reason;
        }
      }
    }
  });

  return { state: nextState, effects: rollbackEffects };
}

export function handleUnreadFinishedSessionsChanged(state: ArchState, event: Extract<Event, { kind: 'UnreadFinishedSessionsChanged' }>): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        unreadFinishedSessionPaths: event.sessionPaths,
      },
    },
    effects: [],
  };
}

export function handleSessionSummaryUpserted(state: ArchState, event: Extract<Event, { kind: 'SessionSummaryUpserted' }>): ReducerResult {
  const nextSessions = [...state.sessions.sessions];
  const idx = nextSessions.findIndex((s) => s.path === event.summary.path);
  if (idx === -1) {
    nextSessions.unshift(event.summary);
  } else {
    const existing = nextSessions[idx];
    const keepExistingName = !existing.isPlaceholder && event.summary.isPlaceholder === true;
    nextSessions[idx] = {
      ...event.summary,
      name: keepExistingName ? existing.name : event.summary.name,
      isPlaceholder: keepExistingName ? false : event.summary.isPlaceholder,
      modelId: event.summary.modelId ?? existing.modelId,
      provider: event.summary.provider ?? existing.provider,
      thinkingLevel: event.summary.thinkingLevel ?? existing.thinkingLevel,
      done: event.summary.done ?? existing.done,
      rating: event.summary.rating ?? existing.rating,
      completion: event.summary.completion ?? existing.completion,
      reviewReason: event.summary.reviewReason ?? existing.reviewReason,
      evaluatedAt: event.summary.evaluatedAt ?? existing.evaluatedAt,
    };
  }
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
      },
    },
    effects: [],
  };
}

export function handleSessionSummariesReplaced(state: ArchState, event: Extract<Event, { kind: 'SessionSummariesReplaced' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const mergedByPath = new Map<string, SessionSummary>();
      for (const item of event.summaries) {
        const existing = mergedByPath.get(item.path) ?? draft.sessions.sessions.find((s) => s.path === item.path);
        mergedByPath.set(item.path, mergeSessionSummaryPreservingLocalName(existing, item));
      }
      for (const s of draft.sessions.sessions) {
        if (!mergedByPath.has(s.path) && draft.sessions.openTabPaths.includes(s.path)) {
          mergedByPath.set(s.path, s);
        }
      }
      const activeSession = draft.sessions.activeSessionPath
        ? draft.sessions.sessions.find((session) => session.path === draft.sessions.activeSessionPath)
        : undefined;
      draft.sessions.sessions = [...mergedByPath.values()];
      if (activeSession && !mergedByPath.has(activeSession.path) && draft.sessions.openTabPaths.includes(activeSession.path)) {
        draft.sessions.sessions.push(activeSession);
      }
    }),
    effects: [],
  };
}

export function handleSessionScopeCleared(state: ArchState, event: Extract<Event, { kind: 'SessionScopeCleared' }>): ReducerResult {
  // Delegate to the unified eviction helper. The summary drop and the tab
  // drop are coupled today (a scope clear that removes the summary also
  // removes the tab), so both flags mirror `event.removeSessionSummary`.
  // Delegating also fixes the latent `fileChanges.expandedBySession` leak:
  // the helper always clears that map, where the inline path #2 previously
  // omitted it.
  return evictSession(state, event.sessionPath, {
    removeSummary: event.removeSessionSummary,
    removeTabs: event.removeSessionSummary,
  });
}

export function handlePendingPathReplaced(state: ArchState, event: Extract<Event, { kind: 'PendingPathReplaced' }>): ReducerResult {
  const { oldPendingPath, newSessionPath } = event;
  // Read the queued sends BEFORE the produce draft (we need them for the
  // effect; the draft will clear the key).
  const queuedSends = state.pending.sendQueueBySession[oldPendingPath] ?? [];

  const nextState = produce(state, (draft) => {
    // Replace in openTabPaths
    draft.sessions.openTabPaths = draft.sessions.openTabPaths.map(
      (p: string) => (p === oldPendingPath ? newSessionPath : p),
    );

    // Replace in unreadFinishedSessionPaths (dedupe)
    draft.sessions.unreadFinishedSessionPaths = [
      ...new Set(draft.sessions.unreadFinishedSessionPaths.map(
        (p: string) => (p === oldPendingPath ? newSessionPath : p),
      )),
    ];

    // Replace in pinnedTabPaths (dedupe). A pending tab can be pinned (it is
    // open), so when the pending path resolves to the real session path the
    // pinned entry must follow it — otherwise the pinned prefix invariant
    // breaks and the tab silently unpins on resolve.
    draft.sessions.pinnedTabPaths = [
      ...new Set(draft.sessions.pinnedTabPaths.map(
        (p: string) => (p === oldPendingPath ? newSessionPath : p),
      )),
    ];

    // Move composer inputs
    const oldInputs = draft.composer.pendingComposerInputsBySession[oldPendingPath];
    if (oldInputs) {
      const existingInputs = draft.composer.pendingComposerInputsBySession[newSessionPath] ?? [];
      draft.composer.pendingComposerInputsBySession[newSessionPath] = [...existingInputs, ...oldInputs];
      delete draft.composer.pendingComposerInputsBySession[oldPendingPath];
    }

    // Move activeRunSummary
    if (Object.prototype.hasOwnProperty.call(draft.composer.activeRunSummaryBySession, oldPendingPath)) {
      draft.composer.activeRunSummaryBySession[newSessionPath] =
        draft.composer.activeRunSummaryBySession[oldPendingPath] ?? null;
      delete draft.composer.activeRunSummaryBySession[oldPendingPath];
    }

    // Move composer draft text. Mirrors the inputs / runSummary migration
    // above: the user's in-progress draft (posted under the pending path while
    // the backend was still creating the session) must follow the session to
    // its real path. Without this, the projected `draftText` for the resolved
    // session falls back to '' and the webview re-seeds the composer empty —
    // clobbering whatever the user typed during the loading window.
    if (Object.prototype.hasOwnProperty.call(draft.composer.draftTextBySession, oldPendingPath)) {
      draft.composer.draftTextBySession[newSessionPath] =
        draft.composer.draftTextBySession[oldPendingPath] ?? '';
      delete draft.composer.draftTextBySession[oldPendingPath];
    }

    // Move analyticsFactors
    if (Object.prototype.hasOwnProperty.call(draft.sessions.analyticsFactorsBySession, oldPendingPath)) {
      draft.sessions.analyticsFactorsBySession[newSessionPath] =
        draft.sessions.analyticsFactorsBySession[oldPendingPath] ?? null;
      delete draft.sessions.analyticsFactorsBySession[oldPendingPath];
    }

    // Clear the pending send queue for the old path — the entries are emitted
    // as a DrainPendingSendQueue effect below; the runner re-dispatches them as
    // Send Commands with the resolved path.
    delete draft.pending.sendQueueBySession[oldPendingPath];
  });

  // Emit a DrainPendingSendQueue effect iff there are queued sends. The runner
  // executes this asynchronously (via void (async () => ...)()), so the
  // re-dispatched Send Commands land AFTER the synchronous SessionScopeCleared
  // + SessionOpened + SelectSession events that follow PendingPathReplaced in
  // the handlePendingPathReplacement flow — preserving the clear-then-reinsert
  // ordering of the old drainPendingSendQueue callback.
  const effects = queuedSends.length > 0
    ? [{ kind: 'DrainPendingSendQueue' as const, corrId: `drain:${oldPendingPath}`, resolvedSessionPath: newSessionPath, entries: queuedSends }]
    : [];

  return { state: nextState, effects };
}

export function handleTabOpened(state: ArchState, event: Extract<Event, { kind: 'TabOpened' }>): ReducerResult {
  if (state.sessions.openTabPaths.includes(event.sessionPath)) {
    return { state, effects: [] };
  }
  const nextOpenTabPaths = event.insertAfter
    ? (() => {
        const afterIndex = state.sessions.openTabPaths.indexOf(event.insertAfter);
        if (afterIndex === -1) {
          return [...state.sessions.openTabPaths, event.sessionPath];
        }
        // A newly opened tab is unpinned, so it must never land inside the
        // pinned prefix. If `insertAfter` points at a pinned tab, place the
        // new tab at the start of the unpinned region instead (mirrors
        // handleDuplicateSession's clamp) to preserve the pinned-prefix invariant.
        const insertAt = Math.max(afterIndex + 1, state.sessions.pinnedTabPaths.length);
        return [
          ...state.sessions.openTabPaths.slice(0, insertAt),
          event.sessionPath,
          ...state.sessions.openTabPaths.slice(insertAt),
        ];
      })()
    : [...state.sessions.openTabPaths, event.sessionPath];
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
        reviewClosedRunningPaths: removeFromArray(state.sessions.reviewClosedRunningPaths, event.sessionPath),
      },
    },
    effects: [],
  };
}

export function handleOpenTabsChanged(state: ArchState, event: Extract<Event, { kind: 'OpenTabsChanged' }>): ReducerResult {
  // Restore path: reorder openTabPaths so pinned tabs form the leading prefix
  // (browser semantics) and drop any pinned path no longer open. When
  // `pinnedTabPaths` is omitted, the existing pinned set is re-normalized
  // against the new openTabPaths (pruning dangling entries). Idempotent when
  // openTabPaths is already pinned-first with an empty pinned set.
  const incomingPinned = event.pinnedTabPaths ?? state.sessions.pinnedTabPaths;
  const { openTabPaths, pinnedTabPaths } = reorderOpenTabsPinnedFirst(event.openTabPaths, incomingPinned);
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths,
        pinnedTabPaths,
        unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) =>
          openTabPaths.includes(p),
        ),
        reviewClosedRunningPaths: state.sessions.reviewClosedRunningPaths.filter((p) => !openTabPaths.includes(p)),
      },
    },
    effects: [],
  };
}
