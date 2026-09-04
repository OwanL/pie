import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import {
  addToArray,
  commitPromotedSend,
  evictSession,
  mergeRejectedComposerInputs,
  mergeRejectedDraftText,
  removeFromArray,
  removeMessage,
  resolveAlias,
  restoreRemovedTail,
  upsertSessionSummary,
} from './helpers.js';
import type { ChatMessage, ComposerInput, SessionSummary } from '../../../shared/protocol.js';
import { LIVE_PIPELINE_LIMITS } from '../../../shared/live-pipeline-protocol.js';
import { NEW_SESSION_NAME } from '../../../shared/session-name.js';
import { reorderOpenTabsPinnedFirst, replacePathInPinnedTabGroups, reconcilePinnedGroups } from '../../../shared/tab-behavior.js';
import { resolveSessionOpenedTranscript } from '../session-opened-transcript.js';
import { materializeInterruptedLiveTurn } from '../live-pipeline/projection.js';
import { pendingOwnerKey, pruneExpiredTerminalAttempts, terminalAttemptKey } from '../live-pipeline/model.js';
import { applyLiveTurnCheckpoint } from '../live-pipeline/checkpoint.js';
import type { LiveTurnCheckpoint } from '../../../shared/live-pipeline-protocol.js';
import { sessionHasDeferredModelWrite, startNextDeferredSetModel } from './set-model-handlers.js';
import {
  activeInterruptOperation,
  hasRetiredInterruptEventFence,
  markSessionOperationAccepted,
  markSessionOperationAmbiguous,
  settleSessionOperationCancelled,
  settleSessionOperationFailed,
  settleSessionOperationSucceeded,
} from '../operation-registry.js';
import { handleEditResult, handlePreflightFailed } from './result-handlers.js';
import { interruptLivePipelineForSession } from './live-pipeline-handlers.js';

const BACKEND_EXIT_TOMBSTONE_GRACE_MS = 15_000;

/** Deterministic corrId suffix for a session's pending MCP recycle retry —
 *  pure function of the override set, unique per effective change. */
function mrssKey(overrides: Record<string, boolean> | undefined): string {
  return Object.entries(overrides ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, disabled]) => `${name}=${disabled ? 1 : 0}`)
    .join(',');
}

/** How long the transient "Compacted · freed N tokens" chip stays visible
 *  after a compaction finishes (host-owned TTL; the webview never times it). */
export const LAST_COMPACTION_CHIP_TTL_MS = 10_000;

function mergeSessionSummaryPreservingLocalName(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) {
    return incoming;
  }

  const keepExistingName = incoming.isPlaceholder === true
    && (!existing.isPlaceholder
      || (existing.name !== NEW_SESSION_NAME && incoming.name === NEW_SESSION_NAME));
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? existing.isPlaceholder : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    provider: incoming.provider ?? existing.provider,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
    // Review fields come from the session-review sidecar, which the backend
    // merges in. A backend list refresh that omits them (e.g. sidecar read
    // failed) must not wipe a previously-known review, so preserve the
    // existing value when the incoming summary doesn't carry one.
    sessionId: incoming.sessionId ?? existing.sessionId,
    // `identityFallback` qualifies the identity arriving in the same summary.
    // Stable backend summaries intentionally omit the false value, so carrying
    // an older `true` across that refresh would incorrectly mark the new stable
    // sessionId as path-derived and make run analytics drop it.
    identityFallback: incoming.sessionId !== undefined
      ? incoming.identityFallback === true
      : existing.identityFallback,
    reviewed: incoming.reviewed ?? existing.reviewed,
    reviewId: incoming.reviewId ?? existing.reviewId,
    reviewedAt: incoming.reviewedAt ?? existing.reviewedAt,
    closureActions: incoming.closureActions ?? existing.closureActions,
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
        sessionCatalogProgress: event.sessionCatalogProgress ?? state.sessions.sessionCatalogProgress,
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
  const existingWindow = state.transcript.windowBySession[sessionPath];
  const transcriptUnavailable = payload.snapshotUnavailable !== undefined;
  const skipped = (payload.transcriptSkipped === true || transcriptUnavailable) && existingWindow !== undefined;
  const editingMessageId = state.transcript.editingMessageIdBySession[sessionPath];
  const preserveInlineEdit = payload.transcriptSkipped !== true
    && !transcriptUnavailable
    && existingWindow !== undefined
    && !!editingMessageId
    && localTranscript.some((message) => message.id === editingMessageId)
    && !payload.transcript.some((message) => message.id === editingMessageId);
  // Mirror the preserve decision made in attach.resolveAndDispatch: the
  // backend's `busy` flag is false during an EDIT's intermediate truncate
  // snapshot (emitted right after `session.truncateAfter` rewrites the file,
  // before `message.send` starts the new turn), but the host still holds a
  // pending optimistic edit message newer than that snapshot. Treat the host's
  // pending operation as an additional preserve trigger so the optimistic /
  // streaming state is not wiped (which previously cleared the transcript and
  // made the agent reply to nothing). A bare running marker is insufficient:
  // it may itself be the orphan an idle authoritative reopen must repair. See
  // STATE_CONTRACT "Snapshot Recovery" / "Optimistic Reconciliation".
  const hostOwnsOptimisticTurn = Object.values(state.pending.ops).some(
    (operation) => operation.sessionPath === sessionPath && !operation.queued,
  ) || Object.values(state.pending.promoted).some(
    (operation) => operation.sessionPath === sessionPath && !operation.queued,
  );
  const hostOwnsMessageExecution = Object.values(state.operations).some(
    (operation) => !operation.terminal
      && (operation.kind === 'message.continue' || operation.kind === 'message.compact')
      && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath,
  );
  const hostOwnsManualCompaction = Object.values(state.operations).some(
    (operation) => !operation.terminal
      && operation.kind === 'message.compact'
      && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath,
  );
  const deferredInlineEditResolution = preserveInlineEdit
    ? resolveSessionOpenedTranscript({
        busy: false,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript: [],
      })
    : null;
  const {
    transcript: resolvedTranscript,
    transcriptWindow: resolvedWindow,
    aliases: resolvedAliases,
  } = skipped || preserveInlineEdit
    // An inline editor owns an uncommitted per-keystroke buffer in the
    // webview. Keep its loaded window stable when an authoritative tail
    // refresh omits that historical row; replacing it would unmount the
    // editor and silently reset the user's draft.
    ? {
        transcript: localTranscript,
        transcriptWindow: existingWindow!,
        aliases: [] as Array<{ aliasId: string; canonicalId: string }>,
      }
    : resolveSessionOpenedTranscript({
        busy: payload.busy || hostOwnsOptimisticTurn,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript,
      });

  // Sessions: running state, backend ready, upsert summary. An active Stop
  // retains ownership until its settlement barrier; a successful Stop's
  // registry fence rejects stale busy snapshots from the retired turn.
  const interruptActive = activeInterruptOperation(state.operations, sessionPath) !== undefined;
  const interruptRetired = hasRetiredInterruptEventFence(state.operations, sessionPath);
  const nextRunningSessionPaths = interruptActive
    ? state.sessions.runningSessionPaths
    : payload.busy && !interruptRetired
      ? addToArray(state.sessions.runningSessionPaths, sessionPath)
      : hostOwnsOptimisticTurn || hostOwnsMessageExecution
        ? state.sessions.runningSessionPaths
        : removeFromArray(state.sessions.runningSessionPaths, sessionPath);
  const openedCapabilities = interruptActive || (payload.busy && interruptRetired)
    ? state.sessions.capabilitiesBySession[sessionPath] ?? {
        billableActivity: false,
        canInterrupt: false,
        canCompact: true,
        canContinue: false,
      }
    : payload.capabilities ?? {
        billableActivity: payload.busy,
        canInterrupt: payload.busy,
        canCompact: !payload.busy,
        canContinue: false,
      };
  // A session opened mid-compaction carries `isCompacting` (the backend's
  // `isStreaming`/`activeRequest` are both false while compaction runs, so
  // `busy` alone cannot restore the "Compacting…" indicator).
  const nextCompactingSessionPaths = interruptActive
    ? state.sessions.compactingSessionPaths
    : interruptRetired
      ? removeFromArray(state.sessions.compactingSessionPaths, sessionPath)
      : payload.isCompacting === true
        ? addToArray(state.sessions.compactingSessionPaths, sessionPath)
        : hostOwnsManualCompaction
          ? state.sessions.compactingSessionPaths
          : removeFromArray(state.sessions.compactingSessionPaths, sessionPath);

  // Preserve review fields across `session.opened`'s full-replace upsert.
  // `payload.session` comes from `buildCurrentSummary`, which merges the
  // review sidecar; a transient sidecar read failure must not wipe previously
  // known V2 review state.
  const existingForOpened = state.sessions.sessions.find((s) => s.path === payload.session.path);
  const openedSummary = mergeSessionSummaryPreservingLocalName(existingForOpened, payload.session);
  const staleModelOwnership = event.backendGeneration < state.settings.modelBackendGeneration
    || event.modelWriteFence < state.settings.modelWriteFence;
  const staleGlobalModelSettings = staleModelOwnership
    || event.modelHydrationRevision < state.settings.modelHydrationRevision;
  const staleSessionCatalog = staleModelOwnership
    || event.catalogHydrationRevision < (state.settings.modelHydrationRevisionBySession[sessionPath] ?? 0);

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
        provider: inFlightSetModel.modelSettings.defaultProvider,
        thinkingLevel: inFlightSetModel.modelSettings.defaultThinkingLevel,
      }
    : staleModelOwnership && existingForOpened
      ? {
          ...openedSummary,
          modelId: existingForOpened.modelId,
          provider: existingForOpened.provider,
          thinkingLevel: existingForOpened.thinkingLevel,
        }
      : openedSummary;

  // Any aliases discovered while merging must be stored so that later
  // backend events carrying the SDK-assigned message id resolve to the
  // streaming row the host kept.
  const nextMessageIdAlias = { ...state.pending.messageIdAlias };
  for (const { aliasId, canonicalId } of resolvedAliases) {
    nextMessageIdAlias[aliasId] = { canonicalId, sessionPath };
  }

  const nextDeferredWindowReplacements = {
    ...state.transcript.deferredWindowReplacementBySession,
  };
  if (deferredInlineEditResolution) {
    nextDeferredWindowReplacements[sessionPath] = {
      transcript: deferredInlineEditResolution.transcript,
      transcriptWindow: deferredInlineEditResolution.transcriptWindow,
    };
  } else if (!skipped) {
    delete nextDeferredWindowReplacements[sessionPath];
  }

  const coldPromptDisabledIds = payload.systemPromptDisabledEntries !== undefined
    ? new Set(payload.systemPromptDisabledEntries)
    : undefined;
  const reconciledSystemPrompts = payload.systemPrompts ?? (
    coldPromptDisabledIds
      ? (next.transcript.systemPromptsBySession[sessionPath] ?? []).map((entry) => ({
          ...entry,
          disabled: entry.toggleable !== false
            && entry.id !== undefined
            && coldPromptDisabledIds.has(entry.id),
        }))
      : undefined
  );

  next = {
    ...next,
    sessions: {
      ...next.sessions,
      runningSessionPaths: nextRunningSessionPaths,
      capabilitiesBySession: {
        ...next.sessions.capabilitiesBySession,
        [sessionPath]: openedCapabilities,
      },
      compactingSessionPaths: nextCompactingSessionPaths,
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
      ...(!staleModelOwnership && {
        modelBackendGeneration: Math.max(next.settings.modelBackendGeneration, event.backendGeneration),
      }),
      ...(!staleSessionCatalog && payload.availableModels !== undefined && {
        availableModelsBySession: {
          ...next.settings.availableModelsBySession,
          [sessionPath]: payload.availableModels,
        },
        availableModelsStatusBySession: {
          ...next.settings.availableModelsStatusBySession,
          [sessionPath]: 'authoritative' as const,
        },
      }),
      // Apply the global default from settings.json only while this event still
      // owns the model-write fence and no optimistic SetModel owns the path.
      ...(!staleGlobalModelSettings && !inFlightSetModel && payload.modelSettings && {
        modelSettings: payload.modelSettings,
      }),
      ...(payload.contextUsage !== undefined && {
        contextUsageBySession: {
          ...next.settings.contextUsageBySession,
          [sessionPath]: payload.contextUsage,
        },
      }),
      initialContextEstimateBySession: {
        ...next.settings.initialContextEstimateBySession,
        [sessionPath]: payload.runtimeReady === false
          && (payload.sessionUsage?.samples.length ?? 0) === 0
          ? payload.initialContextEstimate ?? null
          : null,
      },
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
      deferredWindowReplacementBySession: nextDeferredWindowReplacements,
      ...(payload.sessionUsage && {
        sessionUsageBySession: {
          ...next.transcript.sessionUsageBySession,
          [sessionPath]: payload.sessionUsage,
        },
      }),
      ...(reconciledSystemPrompts !== undefined && {
        systemPromptsBySession: {
          ...next.transcript.systemPromptsBySession,
          [sessionPath]: reconciledSystemPrompts,
        },
      }),
    },
    pending: {
      ...next.pending,
      messageIdAlias: nextMessageIdAlias,
    },
  };

  const effects: Effect[] = [];
  if (!interruptActive && !interruptRetired && payload.liveTurnCheckpoint) {
    next = applyAuthoritativeOpenedCheckpoint(next, sessionPath, payload.liveTurnCheckpoint);
    const recoveredTurn = next.livePipeline.turnsBySession[sessionPath];
    if (recoveredTurn?.turnId === payload.liveTurnCheckpoint.turnId
      && recoveredTurn.attemptId === payload.liveTurnCheckpoint.attemptId) {
      // A cold-open checkpoint may precede (and cause the later duplicate
      // classification of) turn.started. It is therefore a commit point in its
      // own right: clear the matching optimistic send and its watchdog now.
      const committedSend = commitPromotedSend(
        next,
        sessionPath,
        payload.liveTurnCheckpoint.turn.requestId,
        payload.liveTurnCheckpoint.turn.canonicalMessageId,
        payload.liveTurnCheckpoint.turn.operationId,
      );
      next = committedSend.state;
      effects.push(...committedSend.effects);
    }
  } else if (!interruptActive && !interruptRetired && payload.busy) {
    // The backend kept the durable assistant tail visible because it could not
    // provide an atomic checkpoint. Prefer the bounded recovery identity from
    // this authoritative open; unlike local live state it also works for a
    // cold host that never observed turn.started.
    const liveTurn = next.livePipeline.turnsBySession[sessionPath];
    const recoveryIdentity = payload.liveTurnRecoveryIdentity ?? liveTurn;
    if (recoveryIdentity) {
      effects.push({
        kind: 'RequestLiveTurnCheckpoint',
        corrId: `live-checkpoint:${recoveryIdentity.turnId}:${recoveryIdentity.attemptId}:session-opened`,
        sessionPath,
        turnId: recoveryIdentity.turnId,
        attemptId: recoveryIdentity.attemptId,
      });
    }
  } else if (!interruptActive && !hostOwnsOptimisticTurn) {
    // A full idle snapshot is authoritative for live ownership. If the host
    // has no optimistic send/edit in flight, any surviving active row belongs
    // to an earlier missed terminal boundary and would otherwise be projected
    // beside the durable assistant tail as a duplicate.
    next = clearAuthoritativeIdleLiveState(next, sessionPath);
  }

  return { state: next, effects };
}

/** Clear session-scoped live ownership after an authoritative idle reopen.
 * Composer drafts and optimistic operations are deliberately untouched: this
 * path only runs when the host does not own an in-flight send/edit. */
function clearAuthoritativeIdleLiveState(state: ArchState, sessionPath: string): ArchState {
  const liveTurn = state.livePipeline.turnsBySession[sessionPath];
  const staleTurnIds = new Set<string>();
  if (liveTurn) staleTurnIds.add(liveTurn.turnId);
  for (const events of Object.values(state.livePipeline.pendingOwnerEvents)) {
    for (const pendingEvent of events) {
      if (pendingEvent.sessionPath === sessionPath) staleTurnIds.add(pendingEvent.turnId);
    }
  }
  for (const attempt of Object.values(state.livePipeline.terminalAttempts)) {
    if (attempt.sessionPath === sessionPath) staleTurnIds.add(attempt.turnId);
  }

  const turnsBySession = { ...state.livePipeline.turnsBySession };
  delete turnsBySession[sessionPath];
  const toolsByExecutionId = Object.fromEntries(
    Object.entries(state.livePipeline.toolsByExecutionId)
      .filter(([, tool]) => !staleTurnIds.has(tool.turnId)),
  );
  const pendingOwnerEvents = Object.fromEntries(
    Object.entries(state.livePipeline.pendingOwnerEvents)
      .filter(([, events]) => !events.some((pendingEvent) => pendingEvent.sessionPath === sessionPath)),
  );
  const terminalAttempts = Object.fromEntries(
    Object.entries(state.livePipeline.terminalAttempts)
      .filter(([, attempt]) => attempt.sessionPath !== sessionPath),
  );
  const liveChanged = liveTurn !== undefined
    || Object.keys(toolsByExecutionId).length !== Object.keys(state.livePipeline.toolsByExecutionId).length
    || Object.keys(pendingOwnerEvents).length !== Object.keys(state.livePipeline.pendingOwnerEvents).length
    || Object.keys(terminalAttempts).length !== Object.keys(state.livePipeline.terminalAttempts).length;
  const hadCurrentTurn = state.pending.currentTurnBySession[sessionPath] !== undefined;
  const hadExtensionUi = state.settings.pendingExtensionUIRequestsBySession[sessionPath] !== undefined;
  if (!liveChanged && !hadCurrentTurn && !hadExtensionUi) return state;

  const currentTurnBySession = { ...state.pending.currentTurnBySession };
  delete currentTurnBySession[sessionPath];
  const pendingExtensionUIRequestsBySession = { ...state.settings.pendingExtensionUIRequestsBySession };
  delete pendingExtensionUIRequestsBySession[sessionPath];

  return {
    ...state,
    livePipeline: {
      ...state.livePipeline,
      turnsBySession,
      toolsByExecutionId,
      pendingOwnerEvents,
      terminalAttempts,
      revisionBySession: liveChanged
        ? {
            ...state.livePipeline.revisionBySession,
            [sessionPath]: (state.livePipeline.revisionBySession[sessionPath] ?? 0) + 1,
          }
        : state.livePipeline.revisionBySession,
    },
    pending: {
      ...state.pending,
      currentTurnBySession,
    },
    settings: {
      ...state.settings,
      pendingExtensionUIRequestsBySession,
    },
  };
}

/** `session.opened` and its checkpoint are one authoritative backend snapshot.
 * Replace stale/tombstoned host state for that session before applying it; a
 * prior retry attempt must not make the still-active request look terminal. */
function applyAuthoritativeOpenedCheckpoint(
  state: ArchState,
  sessionPath: string,
  checkpoint: LiveTurnCheckpoint,
): ArchState {
  const existing = state.livePipeline.turnsBySession[sessionPath];
  const turnsBySession = { ...state.livePipeline.turnsBySession };
  delete turnsBySession[sessionPath];
  const toolsByExecutionId = { ...state.livePipeline.toolsByExecutionId };
  if (existing) {
    for (const executionId of existing.toolExecutionIds) delete toolsByExecutionId[executionId];
  }
  const pendingOwnerEvents = { ...state.livePipeline.pendingOwnerEvents };
  if (existing) delete pendingOwnerEvents[pendingOwnerKey(existing.turnId, existing.attemptId)];
  delete pendingOwnerEvents[pendingOwnerKey(checkpoint.turnId, checkpoint.attemptId)];
  const terminalAttempts = { ...state.livePipeline.terminalAttempts };
  delete terminalAttempts[terminalAttemptKey(checkpoint.turnId, checkpoint.attemptId)];
  const cleared = {
    ...state.livePipeline,
    turnsBySession,
    toolsByExecutionId,
    pendingOwnerEvents,
    terminalAttempts,
  };
  const applied = applyLiveTurnCheckpoint(cleared, checkpoint);
  return applied.classification === 'applied'
    ? { ...state, livePipeline: applied.state }
    : state;
}

export function handleSessionNameDerived(state: ArchState, event: Extract<Event, { kind: 'SessionNameDerived' }>): ReducerResult {
  const nextState = produce(state, (draft) => {
    const s = draft.sessions.sessions.find(x => x.path === event.sessionPath);
    if (s) {
      s.name = event.name;
      s.isPlaceholder = event.isPlaceholder;
    }
    if (draft.settings.sessionTitlesSettings.enabled
      && !draft.sessions.titleGenerationBySession[event.sessionPath]) {
      draft.sessions.titleGenerationBySession[event.sessionPath] = {
        status: 'armed',
        prompt: event.sourcePrompt,
      };
    }
  });
  return { state: nextState, effects: [] };
}

export function handleAgentSettled(state: ArchState, event: Extract<Event, { kind: 'AgentSettled' }>): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        capabilitiesBySession: {
          ...state.sessions.capabilitiesBySession,
          [event.sessionPath]: event.capabilities,
        },
      },
    },
    effects: [],
  };
}

export function handleBusyChanged(state: ArchState, event: Extract<Event, { kind: 'BusyChanged' }>): ReducerResult {
  if (activeInterruptOperation(state.operations, event.sessionPath)) return { state, effects: [] };
  // A successful interrupt is a completion barrier. Provider/SDK lifecycle
  // events already queued before that acknowledgement may still arrive, but
  // they describe the retired turn and must not resurrect activity or its
  // capabilities. A real next Send/Edit/Compact command clears this fence.
  if (event.running && hasRetiredInterruptEventFence(state.operations, event.sessionPath)) {
    return { state, effects: [] };
  }
  const capabilities = event.capabilities ?? {
    billableActivity: event.running,
    canInterrupt: event.running,
    canCompact: !event.running,
    canContinue: false,
  };
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      capabilitiesBySession: {
        ...state.sessions.capabilitiesBySession,
        [event.sessionPath]: capabilities,
      },
    },
  };
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
  // A session-scoped MCP toggle that could not recycle its worker while the
  // session was busy retried here — the first idle transition after the
  // refused recycle is the moment the backend may safely retire and re-promote.
  const pendingMcpRecycle = state.settings.mcpPendingApplyBySession[event.sessionPath]
    && state.settings.mcpSessionOverridesBySession[event.sessionPath] !== undefined;

  const mcpRecycleEffects: Effect[] = !pendingMcpRecycle ? [] : [{
    kind: 'McpSetSessionServerRpc',
    corrId: `mcp-session-recycle:${event.sessionPath}:${mrssKey(state.settings.mcpSessionOverridesBySession[event.sessionPath])}`,
    sessionPath: event.sessionPath,
    overrides: { ...state.settings.mcpSessionOverridesBySession[event.sessionPath] },
    recycle: true,
  }];

  if (!wasRunning) {
    return {
      state: {
        ...state,
        sessions: {
          ...state.sessions,
          runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
          intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, event.sessionPath),
        },
      },
      effects: [...terminalRepairEffects, ...mcpRecycleEffects],
    };
  }

  const isActive = state.sessions.activeSessionPath === event.sessionPath;

  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: removeFromArray(state.sessions.runningSessionPaths, event.sessionPath),
        intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, event.sessionPath),
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
    effects: [...terminalRepairEffects, ...mcpRecycleEffects],
  };
}

/** Surface a live "Compacting…" indicator when a history-compaction LLM call
 *  starts. The backend re-arms busy at the same time, so the session is also in
 *  `runningSessionPaths`; this separate marker lets the UI label the activity. */
export function handleCompactionStarted(state: ArchState, event: Extract<Event, { kind: 'CompactionStarted' }>): ReducerResult {
  const operation = event.operationId ? state.operations[event.operationId] : undefined;
  if (event.operationId && (!operation || operation.kind !== 'message.compact' || operation.terminal
    || (operation.session.resolvedPath ?? operation.session.pendingPath) !== event.sessionPath)) {
    return { state, effects: [] };
  }
  const accepted = operation ? markSessionOperationAccepted(operation, {
    pendingPath: operation.session.pendingPath,
  }) : null;
  return {
    state: produce(state, (draft) => {
      draft.sessions.compactingSessionPaths = addToArray(draft.sessions.compactingSessionPaths, event.sessionPath);
      if (accepted && event.operationId) draft.operations[event.operationId] = accepted;
    }),
    effects: [],
  };
}

/** Clear the "Compacting…" indicator when a history-compaction LLM call
 *  finishes. Only a succeeded outcome records the transient "Compacted" chip;
 *  failed and aborted calls remove any older success chip so the UI cannot make
 *  the just-finished operation look successful. The success chip expires after
 *  `LAST_COMPACTION_CHIP_TTL_MS` via the `ClearLastCompaction` effect. */
export function handleCompactionEnded(state: ArchState, event: Extract<Event, { kind: 'CompactionEnded' }>): ReducerResult {
  const operation = event.operationId ? state.operations[event.operationId] : undefined;
  if (event.operationId && (!operation || operation.kind !== 'message.compact'
    || operation.terminalEvidenceApplied === true
    || (operation.session.resolvedPath ?? operation.session.pendingPath) !== event.sessionPath)) {
    return { state, effects: [] };
  }
  let settled = operation;
  if (operation && !operation.terminal) {
    settled = event.outcome === 'succeeded'
      ? settleSessionOperationSucceeded(operation, {
          pendingPath: operation.session.pendingPath,
          resolvedPath: event.sessionPath,
          backendGeneration: operation.backendGeneration,
        }) ?? operation
      : event.outcome === 'aborted'
        ? settleSessionOperationCancelled(operation, {
            pendingPath: operation.session.pendingPath,
            backendGeneration: operation.backendGeneration,
            outcome: 'cancelled',
            reason: 'interrupted-before-commit',
          }) ?? operation
        : settleSessionOperationFailed(operation, {
            pendingPath: operation.session.pendingPath,
            backendGeneration: operation.backendGeneration,
            reason: 'execution-failed',
          }) ?? operation;
  } else if (operation?.terminal) {
    const expectedOutcome = event.outcome === 'succeeded' ? 'settled'
      : event.outcome === 'aborted' ? 'cancelled' : 'failed';
    if (operation.terminal.outcome !== expectedOutcome) return { state, effects: [] };
  }

  const { [event.sessionPath]: _lastCompaction, ...withoutLastCompaction } = state.sessions.lastCompactionBySession;
  const nextState = produce(state, (draft) => {
    draft.sessions.compactingSessionPaths = removeFromArray(draft.sessions.compactingSessionPaths, event.sessionPath);
    if (event.reason === 'manual') {
      draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
    }
    if (event.operationId && settled) {
      draft.operations[event.operationId] = { ...settled, terminalEvidenceApplied: true };
    }
    if (event.outcome !== 'succeeded') {
      draft.sessions.lastCompactionBySession = withoutLastCompaction;
      return;
    }
    draft.sessions.lastCompactionBySession[event.sessionPath] = {
      at: event.occurredAt,
      ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
      ...(event.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: event.estimatedTokensAfter } : {}),
    };
  });
  return {
    state: nextState,
    effects: event.outcome === 'succeeded' ? [{
      kind: 'ClearLastCompaction',
      corrId: `clear-last-compaction:${event.sessionPath}:${event.occurredAt}`,
      sessionPath: event.sessionPath,
      ttlMs: LAST_COMPACTION_CHIP_TTL_MS,
    }] : [],
  };
}

/** Expire a session's transient "Compacted" chip (fired by the
 *  `ClearLastCompaction` effect timer). */
export function handleLastCompactionCleared(state: ArchState, event: Extract<Event, { kind: 'LastCompactionCleared' }>): ReducerResult {
  if (!(event.sessionPath in state.sessions.lastCompactionBySession)) {
    return { state, effects: [] };
  }
  const { [event.sessionPath]: _expired, ...remaining } = state.sessions.lastCompactionBySession;
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        lastCompactionBySession: remaining,
      },
    },
    effects: [],
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
        initialContextEstimateBySession: {
          ...state.settings.initialContextEstimateBySession,
          [event.sessionPath]: null,
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
  const sessionPaths = event.sessionPaths.filter(
    (path) => !hasRetiredInterruptEventFence(state.operations, path),
  );
  for (const path of state.sessions.runningSessionPaths) {
    if (activeInterruptOperation(state.operations, path) && !sessionPaths.includes(path)) {
      sessionPaths.push(path);
    }
  }
  const running = new Set(sessionPaths);
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        runningSessionPaths: sessionPaths,
        // Compaction re-arms busy, so compacting paths are always a subset of
        // running paths; a backend exit (empty list) must clear them too.
        compactingSessionPaths: state.sessions.compactingSessionPaths.filter((p) => running.has(p)),
        intentionallyHiddenRunningPaths: state.sessions.intentionallyHiddenRunningPaths.filter((p) => running.has(p)),
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
  const restoredComposerBySession = new Map<string, { text: string; inputs: ComposerInput[] }>();
  for (const sessionPath of sessionPaths) {
    const sends = rollbackOps
      .map(([, op]) => op)
      .filter((op) => op.kind === 'send' && op.sessionPath === sessionPath)
      .sort((left, right) => left.startedAt - right.startedAt);
    if (sends.length === 0) continue;
    let text = state.composer.draftTextBySession[sessionPath] ?? '';
    let inputs = [...(state.composer.pendingComposerInputsBySession[sessionPath] ?? [])];
    // Prepend newest-to-oldest so the final composer preserves send order,
    // followed by any draft/attachments created while those sends were live.
    for (const send of [...sends].reverse()) {
      text = mergeRejectedDraftText(send.text ?? '', text);
      inputs = mergeRejectedComposerInputs(send.inputs, inputs);
    }
    restoredComposerBySession.set(sessionPath, { text, inputs });
  }
  const rollbackEffects: Effect[] = [];
  for (const [corrId, op] of rollbackOps) {
    if (op.kind !== 'send') continue;
    rollbackEffects.push({
      kind: 'PostImperative',
      corrId,
      imperativeMessage: {
        type: 'sendRejected',
        sessionPath: op.sessionPath,
        text: restoredComposerBySession.get(op.sessionPath)?.text ?? op.text ?? '',
        localId: op.localId,
        inputs: restoredComposerBySession.get(op.sessionPath)?.inputs ?? op.inputs ?? [],
      },
    });
    rollbackEffects.push({ kind: 'ClearSendTimer', corrId });
  }
  const nextState = produce(state, (draft) => {
    for (const sessionPath of sessionPaths) {
      for (const operation of Object.values(draft.operations)) {
        if (!operation.kind.startsWith('message.') || operation.terminal
          || (operation.session.resolvedPath ?? operation.session.pendingPath) !== sessionPath) continue;
        // Backend death without a status response cannot prove whether the
        // atomic rename ran. Preserve every in-flight edit conservatively;
        // settleSessionOperationFailed upgrades still-pending commit evidence
        // to unknown, while an explicit committed:false status uses the
        // MessageOperationStatus path and remains rollback authority.
        const preserveEditCommit = operation.kind === 'message.edit';
        const settled = settleSessionOperationFailed(operation, {
          pendingPath: operation.session.pendingPath,
          backendGeneration: operation.backendGeneration,
          reason: 'backend-generation-ended',
          detail: reason,
          preserveCommit: preserveEditCommit,
        });
        if (settled) draft.operations[operation.operationId] = settled;
      }
      draft.sessions.compactingSessionPaths = removeFromArray(
        draft.sessions.compactingSessionPaths,
        sessionPath,
      );
      // A backend death mid-retry leaves a stale retry status; the retry is
      // dead (no `auto_retry_end` will fire), so clear it alongside the
      // streaming-message interruption.
      delete draft.sessions.retryStatusBySession[sessionPath];
      delete draft.settings.pendingExtensionUIRequestsBySession[sessionPath];
      delete draft.transcript.pagingInFlightBySession[sessionPath];
      delete draft.pending.currentTurnBySession[sessionPath];
      delete draft.pending.sendQueueBySession[sessionPath];
      delete draft.pending.backendReadyQueueBySession[sessionPath];
      // Deferred model choices are host-owned recovery intent, not dead
      // backend work. BackendReadyChanged(false) requeues any accepted write;
      // untouched choices must survive until the replacement backend is ready.
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
        const registered = op.operationId ? draft.operations[op.operationId] : undefined;
        const editMayHaveCommitted = op.kind === 'edit'
          && (registered?.commit === 'committed' || registered?.commit === 'unknown');
        if (!editMayHaveCommitted) {
          removeMessage(draft, sessionPath, op.localId);
        }
        if (!editMayHaveCommitted && op.kind === 'edit' && op.removedTail?.length) {
          restoreRemovedTail(draft, sessionPath, op.removedTail);
        }
        if (!editMayHaveCommitted && op.kind === 'edit' && op.editDraft) {
          draft.transcript.editingMessageIdBySession[sessionPath] = op.editDraft.messageId;
          draft.transcript.editingDraftBySession[sessionPath] = {
            ...op.editDraft,
            inputs: [...op.editDraft.inputs],
          };
        }
        if (op.previousSummary) {
          const index = draft.sessions.sessions.findIndex((summary) => summary.path === op.previousSummary!.path);
          if (index >= 0) draft.sessions.sessions[index] = op.previousSummary;
          else draft.sessions.sessions.push(op.previousSummary);
        }
      }
      const restoredComposer = restoredComposerBySession.get(sessionPath);
      if (restoredComposer) {
        draft.composer.draftTextBySession[sessionPath] = restoredComposer.text;
        if (restoredComposer.inputs.length > 0) {
          draft.composer.pendingComposerInputsBySession[sessionPath] = restoredComposer.inputs;
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
    nextSessions[idx] = mergeSessionSummaryPreservingLocalName(existing, event.summary);
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
      if (event.sessionCatalogProgress) {
        draft.sessions.sessionCatalogProgress = event.sessionCatalogProgress;
      }
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

export function handleSendOperationDelayed(state: ArchState, event: Extract<Event, { kind: 'SendOperationDelayed' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'message.send') return { state, effects: [] };
  const delayed = markSessionOperationAmbiguous(operation, {
    pendingPath: operation.session.pendingPath,
    backendGeneration: event.backendGeneration,
  }, 'reconcile');
  if (!delayed) return { state, effects: [] };
  return {
    state: produce(state, (draft) => {
      draft.operations[event.operationId] = delayed;
      draft.settings.notice = 'Send acknowledgement delayed. Pie is reconciling this message; do not send it again.';
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = event.sessionPath;
    }),
    effects: [],
  };
}

export function handleSendOperationStatus(state: ArchState, event: Extract<Event, { kind: 'SendOperationStatus' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'message.send' || operation.terminal
    || operation.backendGeneration !== event.backendGeneration) return { state, effects: [] };
  let updated = operation;
  if (event.state === 'accepted') {
    updated = markSessionOperationAccepted(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
    }) ?? operation;
  } else if (event.state === 'committed') {
    updated = settleSessionOperationSucceeded(operation, {
      pendingPath: operation.session.pendingPath,
      resolvedPath: event.sessionPath,
      backendGeneration: event.backendGeneration,
    }) ?? operation;
  } else if (event.state === 'cancelled' || event.state === 'superseded') {
    updated = settleSessionOperationCancelled(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
      outcome: event.state,
      reason: event.state === 'superseded' ? 'superseded-before-commit' : 'queue-cleared',
      detail: event.error,
    }) ?? operation;
  } else if (event.state === 'failed' || event.state === 'aborted' || event.state === 'generation-ended') {
    updated = settleSessionOperationFailed(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
      reason: event.state === 'generation-ended' ? 'backend-generation-ended' : 'definitive-rejection',
      detail: event.error,
    }) ?? operation;
  } else if (event.state === 'reconciliation-exhausted') {
    const ambiguous = markSessionOperationAmbiguous(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
    }, 'reconcile');
    updated = ambiguous ? { ...ambiguous, recovery: 'restart-backend' } : operation;
  }
  if (updated === operation) return { state, effects: [] };
  const owningCorrIds = [
    ...Object.entries(state.pending.ops),
    ...Object.entries(state.pending.promoted),
  ].filter(([, pending]) => pending.operationId === event.operationId)
    .map(([corrId]) => corrId);
  const registryState = produce(state, (draft) => {
    draft.operations[event.operationId] = updated;
    if (event.state === 'cancelled' || event.state === 'superseded') {
      for (const corrId of owningCorrIds) {
        delete draft.pending.ops[corrId];
        delete draft.pending.promoted[corrId];
      }
      if (event.requestId) delete draft.pending.requestIdToLocalId[event.requestId];
      delete draft.pending.prepassBySession[event.sessionPath];
      if (operation.delivery === 'queued' && operation.localId) {
        const list = draft.transcript.bySession[event.sessionPath];
        const index = list?.findIndex((message) => message.id === operation.localId
          && message.role === 'user' && message.status === 'queued') ?? -1;
        if (list && index >= 0) list.splice(index, 1);
      }
    }
    if (event.state === 'committed') {
      for (const corrId of owningCorrIds) {
        delete draft.pending.ops[corrId];
        delete draft.pending.promoted[corrId];
      }
      if (event.requestId) delete draft.pending.requestIdToLocalId[event.requestId];
      delete draft.pending.prepassBySession[event.sessionPath];
      if (operation.delivery === 'queued' && operation.localId) {
        const list = draft.transcript.bySession[event.sessionPath];
        const index = list?.findIndex((message) => message.id === operation.localId
          && message.role === 'user' && message.status === 'queued') ?? -1;
        if (list && index >= 0) {
          const [delivered] = list.splice(index, 1);
          delivered.status = 'completed';
          list.push(delivered);
        }
      }
    }
    if (event.state === 'reconciliation-exhausted') {
      draft.settings.notice = 'Pie could not confirm whether this send committed. Sending again is blocked; restart the backend to reconcile safely.';
      draft.settings.noticeKind = 'backend-exit';
      draft.settings.noticeRaw = event.error ?? null;
      draft.settings.noticeSessionPath = event.sessionPath;
    } else if (updated.terminal?.outcome === 'settled'
      && draft.settings.noticeSessionPath === event.sessionPath
      && draft.settings.notice?.startsWith('Send acknowledgement delayed.')) {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = null;
    }
  });
  if (event.state === 'failed' || event.state === 'aborted' || event.state === 'generation-ended') {
    const pendingEntry = Object.entries(registryState.pending.promoted)
      .find(([, pending]) => pending.operationId === event.operationId)
      ?? Object.entries(registryState.pending.ops)
        .find(([, pending]) => pending.operationId === event.operationId);
    if (pendingEntry) {
      const rollback = handlePreflightFailed(registryState, {
        kind: 'PreflightFailed',
        corrId: pendingEntry[0],
        operationId: event.operationId,
        sessionPath: event.sessionPath,
        requestId: event.requestId ?? '',
        error: event.error ?? (event.state === 'generation-ended'
          ? 'The backend generation ended before the send committed.'
          : 'The backend rejected the send before it started.'),
      });
      return {
        state: rollback.state,
        effects: [...rollback.effects, { kind: 'ClearSendTimer', corrId: pendingEntry[0] }],
      };
    }
  }
  return {
    state: registryState,
    effects: updated.terminal?.outcome === 'settled'
      ? (owningCorrIds.length > 0 ? owningCorrIds : [operation.causal.selectionToken])
        .map((corrId) => ({ kind: 'ClearSendTimer' as const, corrId }))
      : [],
  };
}

export function handleMessageOperationDelayed(state: ArchState, event: Extract<Event, { kind: 'MessageOperationDelayed' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== event.operationKind) return { state, effects: [] };
  const delayed = markSessionOperationAmbiguous(operation, {
    pendingPath: operation.session.pendingPath,
    backendGeneration: event.backendGeneration,
  }, 'reconcile');
  if (!delayed) return { state, effects: [] };
  const label = event.operationKind === 'message.continue' ? 'Continue'
    : event.operationKind === 'message.compact' ? 'History compaction'
      : event.operationKind === 'message.edit' ? 'Edit' : 'Interrupt';
  return {
    state: produce(state, (draft) => {
      draft.operations[event.operationId] = delayed;
      draft.settings.notice = `${label} acknowledgement delayed. Pie is reconciling this operation; do not retry it.`;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = event.sessionPath;
    }),
    effects: [],
  };
}

export function handleMessageOperationStatus(state: ArchState, event: Extract<Event, { kind: 'MessageOperationStatus' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== event.operationKind || operation.terminal
    || operation.backendGeneration !== event.backendGeneration) return { state, effects: [] };
  const editCommitMayHaveOccurred = operation.kind === 'message.edit'
    && (event.committed === true || (event.committed === undefined
      && (event.state === 'generation-ended'
        || operation.commit === 'committed'
        || operation.commit === 'unknown')));
  let updated = operation;
  if (event.state === 'accepted') {
    updated = markSessionOperationAccepted(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
      committed: event.committed,
    }) ?? operation;
  } else if (event.state === 'committed') {
    updated = settleSessionOperationSucceeded(operation, {
      pendingPath: operation.session.pendingPath,
      resolvedPath: event.sessionPath,
      backendGeneration: event.backendGeneration,
    }) ?? operation;
  } else if (event.state === 'cancelled' || event.state === 'superseded' || event.state === 'aborted') {
    updated = editCommitMayHaveOccurred
      ? settleSessionOperationFailed(operation, {
          pendingPath: operation.session.pendingPath,
          backendGeneration: event.backendGeneration,
          reason: 'execution-failed',
          detail: event.error,
          committed: event.committed,
          preserveCommit: true,
        }) ?? operation
      : settleSessionOperationCancelled(operation, {
          pendingPath: operation.session.pendingPath,
          backendGeneration: event.backendGeneration,
          outcome: event.state === 'superseded' ? 'superseded' : 'cancelled',
          reason: event.state === 'superseded' ? 'superseded-before-commit' : 'interrupted-before-commit',
          detail: event.error,
        }) ?? operation;
  } else if (event.state === 'failed' || event.state === 'generation-ended') {
    updated = settleSessionOperationFailed(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
      reason: event.state === 'generation-ended' ? 'backend-generation-ended'
        : editCommitMayHaveOccurred ? 'execution-failed' : 'definitive-rejection',
      detail: event.error,
      committed: event.committed,
      preserveCommit: editCommitMayHaveOccurred,
    }) ?? operation;
  } else if (event.state === 'reconciliation-exhausted') {
    const ambiguous = markSessionOperationAmbiguous(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
    }, 'reconcile');
    if (ambiguous && operation.kind === 'message.interrupt') {
      updated = settleSessionOperationFailed(ambiguous, {
        pendingPath: ambiguous.session.pendingPath,
        backendGeneration: event.backendGeneration,
        reason: 'execution-failed',
        detail: event.error ?? 'Interrupt settlement could not be confirmed.',
        recovery: 'restart-backend',
        preserveCommit: true,
      }) ?? operation;
    } else {
      updated = ambiguous ? { ...ambiguous, recovery: 'restart-backend' } : operation;
    }
  }
  if (updated === operation) return { state, effects: [] };

  const lifecycleState = event.operationKind === 'message.interrupt'
    && updated.terminal?.outcome === 'settled'
    ? interruptLivePipelineForSession(state, event.sessionPath, event.occurredAt ?? 0).state
    : state;
  let next = produce(lifecycleState, (draft) => {
    draft.operations[event.operationId] = updated;
    if (updated.terminal) {
      if (event.operationKind === 'message.interrupt') {
        draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
        if (updated.terminal.outcome === 'settled') {
          const list = draft.transcript.bySession[event.sessionPath];
          if (list) {
            draft.transcript.bySession[event.sessionPath] = list.filter((message) => !(message.role === 'user' && message.status === 'queued'));
          }
          for (const candidate of Object.values(draft.operations)) {
            if (candidate.kind !== 'message.send' || candidate.terminal
              || (candidate.session.resolvedPath ?? candidate.session.pendingPath) !== event.sessionPath) continue;
            const cancelled = settleSessionOperationCancelled(candidate, {
              pendingPath: candidate.session.pendingPath, backendGeneration: candidate.backendGeneration,
              outcome: 'cancelled', reason: 'interrupted-before-commit',
            });
            if (cancelled) draft.operations[candidate.operationId] = cancelled;
          }
          for (const collection of [draft.pending.ops, draft.pending.promoted]) {
            for (const [corrId, pending] of Object.entries(collection)) {
              if (pending.sessionPath !== event.sessionPath) continue;
              const owner = pending.operationId ? draft.operations[pending.operationId] : undefined;
              if (!pending.queued && !(owner?.kind === 'message.send' && owner.terminal)) continue;
              if (pending.requestId) delete draft.pending.requestIdToLocalId[pending.requestId];
              delete collection[corrId];
            }
          }
        }
      } else if (event.operationKind === 'message.compact') {
        draft.sessions.compactingSessionPaths = removeFromArray(draft.sessions.compactingSessionPaths, event.sessionPath);
        draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
      } else if (event.operationKind === 'message.continue' || event.operationKind === 'message.edit') {
        if (!event.error?.includes('REQUEST_IN_PROGRESS')) {
          draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
        }
      }
    }
    if (event.operationKind === 'message.edit' && updated.terminal) {
      for (const [corrId, pending] of [...Object.entries(draft.pending.ops), ...Object.entries(draft.pending.promoted)]) {
        if (pending.operationId !== event.operationId) continue;
        delete draft.pending.ops[corrId];
        delete draft.pending.promoted[corrId];
      }
      delete draft.pending.prepassBySession[event.sessionPath];
    }
    if (event.state === 'reconciliation-exhausted') {
      draft.settings.notice = `Pie could not confirm whether this ${event.operationKind.replace('message.', '')} operation settled. Restart the backend to reconcile safely.`;
      draft.settings.noticeKind = 'backend-exit';
      draft.settings.noticeRaw = event.error ?? null;
      draft.settings.noticeSessionPath = event.sessionPath;
    } else if (updated.terminal?.outcome === 'failed') {
      draft.settings.notice = event.operationKind === 'message.edit' && editCommitMayHaveOccurred
        ? 'The edit was saved, but its replacement response could not start.'
        : event.state === 'generation-ended'
          ? `The backend ended before Pie could finish this ${event.operationKind.replace('message.', '')} operation.`
          : `Could not complete the ${event.operationKind.replace('message.', '')} operation.`;
      draft.settings.noticeKind = event.state === 'generation-ended' ? 'backend-exit' : 'operational-error';
      draft.settings.noticeRaw = event.error ?? null;
      draft.settings.noticeSessionPath = event.sessionPath;
    } else if ((updated.terminal || updated.acceptance === 'accepted')
      && draft.settings.noticeSessionPath === event.sessionPath
      && draft.settings.notice?.includes('acknowledgement delayed.')) {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = null;
    }
  });

  // Only a status that proves the destructive edit commit did not occur may
  // restore the old tail/editor. Post-commit failure and unknown generation
  // death intentionally retain the optimistic replacement.
  if (event.operationKind === 'message.edit' && updated.terminal
    && !editCommitMayHaveOccurred
    && (event.state === 'failed' || event.state === 'generation-ended'
      || event.state === 'cancelled' || event.state === 'superseded' || event.state === 'aborted')) {
    const pending = Object.entries(state.pending.promoted).find(([, value]) => value.operationId === event.operationId)
      ?? Object.entries(state.pending.ops).find(([, value]) => value.operationId === event.operationId);
    if (pending) {
      const rolledBack = handleEditResult(state, {
        kind: 'EditResult', corrId: pending[0], operationId: event.operationId,
        backendGeneration: event.backendGeneration, sessionPath: event.sessionPath,
        ok: false, committed: false, error: event.error,
      }).state;
      next = produce(rolledBack, (draft) => {
        // Preserve the authoritative status reason/recovery; EditResult owns
        // only the rollback mechanics for this path.
        draft.operations[event.operationId] = updated;
        if (event.state === 'generation-ended') {
          draft.settings.notice = 'The backend ended before Pie could finish this edit operation.';
          draft.settings.noticeKind = 'backend-exit';
          draft.settings.noticeRaw = event.error ?? null;
          draft.settings.noticeSessionPath = event.sessionPath;
        }
      });
    }
  }
  return { state: next, effects: [] };
}

export function handleCreateOperationDelayed(state: ArchState, event: Extract<Event, { kind: 'CreateOperationDelayed' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.causal.selectionToken !== event.selectionToken) {
    return { state, effects: [] };
  }
  const delayed = markSessionOperationAmbiguous(operation, {
    pendingPath: event.pendingPath,
    attempt: event.attempt,
    backendGeneration: event.backendGeneration,
  });
  if (!delayed) return { state, effects: [] };
  const next = produce(state, (draft) => {
    draft.operations[event.operationId] = delayed;
    const summary = draft.sessions.sessions.find((item) => item.path === event.pendingPath);
    if (summary) summary.creationState = 'delayed';
    if (event.ownsSelection && event.notice) {
      draft.settings.notice = event.notice;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = event.pendingPath;
    }
  });
  return { state: next, effects: [] };
}

export function handleCreateOperationSucceeded(state: ArchState, event: Extract<Event, { kind: 'CreateOperationSucceeded' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation) return { state, effects: [] };
  const settled = settleSessionOperationSucceeded(operation, {
    pendingPath: event.pendingPath,
    resolvedPath: event.sessionPath,
    attempt: event.attempt,
    backendGeneration: event.backendGeneration,
  });
  if (!settled) return { state, effects: [] };
  return {
    state: {
      ...state,
      operations: { ...state.operations, [event.operationId]: settled },
    },
    effects: [],
  };
}

export function handleCreateOperationFailed(state: ArchState, event: Extract<Event, { kind: 'CreateOperationFailed' }>): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation) return { state, effects: [] };
  const settled = settleSessionOperationFailed(operation, {
    pendingPath: event.pendingPath,
    attempt: event.attempt,
    backendGeneration: event.backendGeneration,
    reason: event.reason ?? 'definitive-rejection',
    detail: event.error,
  });
  if (!settled) return { state, effects: [] };
  return {
    state: {
      ...state,
      operations: { ...state.operations, [event.operationId]: settled },
    },
    effects: [],
  };
}

export function handlePendingPathReplaced(state: ArchState, event: Extract<Event, { kind: 'PendingPathReplaced' }>): ReducerResult {
  const { oldPendingPath, newSessionPath } = event;
  // Read queued sends BEFORE the produce draft (the draft clears their
  // host-only pseudo-path key; replay happens after the path is durable).
  const queuedSends = state.pending.sendQueueBySession[oldPendingPath] ?? [];
  const deferredSetModel = state.pending.deferredSetModelBySession[oldPendingPath];

  const nextState = produce(state, (draft) => {
    for (const operation of Object.values(draft.operations)) {
      if (operation.kind === 'message.send' && !operation.terminal
        && operation.session.pendingPath === oldPendingPath) {
        operation.session.resolvedPath = newSessionPath;
        const queued = draft.pending.sendQueueBySession[oldPendingPath]
          ?.find((entry) => entry.operationId === operation.operationId);
        if (queued) {
          operation.intentFingerprint = JSON.stringify({
            sessionPath: newSessionPath,
            text: queued.text,
            inputs: queued.inputs,
            localId: queued.localId,
          });
        }
      }
    }
    // Normally SessionOpened has already inserted the durable summary. When a
    // post-commit publication failure leaves only the RPC acknowledgement,
    // promote the pending placeholder itself so the resolved tab is not
    // summary-less. Lifecycle-only fields never leak onto the durable summary.
    const hasDurableSummary = draft.sessions.sessions.some((summary) => summary.path === newSessionPath);
    draft.sessions.sessions = draft.sessions.sessions.flatMap((summary) => {
      if (summary.path !== oldPendingPath) return [summary];
      if (hasDurableSummary) return [];
      const { creationState: _creationState, createOperationId: _createOperationId, ...rest } = summary;
      return [{ ...rest, path: newSessionPath }];
    });

    // Retarget the deferred choice without replaying it yet. The ordered drain
    // below restores its baseline and starts it only when no earlier global
    // model-settings write is still waiting.
    if (deferredSetModel) {
      delete draft.pending.deferredSetModelBySession[oldPendingPath];
      draft.pending.deferredSetModelBySession[newSessionPath] = {
        ...deferredSetModel,
        sessionPath: newSessionPath,
      };
    }
    // A model-switch confirmation can remain open while create/duplicate
    // resolves. Retarget its host-owned intent; never let Confirm address the
    // retired pseudo-path.
    for (const pending of Object.values(draft.pending.setModelByCorrId)) {
      if (pending.sessionPath === oldPendingPath) pending.sessionPath = newSessionPath;
    }

    // Replace in openTabPaths
    draft.sessions.openTabPaths = draft.sessions.openTabPaths.map(
      (p: string) => (p === oldPendingPath ? newSessionPath : p),
    );
    if (draft.sessions.activeSessionPath === oldPendingPath) {
      draft.sessions.activeSessionPath = newSessionPath;
    }

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

    // Replace in pinnedTabGroups (dedupe). A pinned pending tab can be a group
    // member, so the group entry must follow the resolved path too — otherwise
    // the member silently leaves its group on resolve.
    draft.sessions.pinnedTabGroups = replacePathInPinnedTabGroups(
      draft.sessions.pinnedTabGroups,
      oldPendingPath,
      newSessionPath,
    );

    // Transfer the provisional model catalog before the attach path clears the
    // old pending scope. The following successful session.opened may replace
    // it authoritatively; until then the picker keeps the known catalog and
    // reasoning levels under the durable path.
    if (Object.prototype.hasOwnProperty.call(draft.settings.availableModelsBySession, oldPendingPath)) {
      draft.settings.availableModelsBySession[newSessionPath] =
        draft.settings.availableModelsBySession[oldPendingPath] ?? [];
      draft.settings.availableModelsStatusBySession[newSessionPath] =
        draft.settings.availableModelsStatusBySession[oldPendingPath] ?? 'provisional';
      delete draft.settings.availableModelsBySession[oldPendingPath];
      delete draft.settings.availableModelsStatusBySession[oldPendingPath];
    }
    if (Object.prototype.hasOwnProperty.call(draft.settings.modelHydrationRevisionBySession, oldPendingPath)) {
      draft.settings.modelHydrationRevisionBySession[newSessionPath] =
        draft.settings.modelHydrationRevisionBySession[oldPendingPath] ?? 0;
      delete draft.settings.modelHydrationRevisionBySession[oldPendingPath];
    }

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

    // Move host-only privacy mode when a new session placeholder resolves to
    // its backend-assigned path.
    if (draft.sessions.privacyModeBySession[oldPendingPath] === true) {
      draft.sessions.privacyModeBySession[newSessionPath] = true;
      delete draft.sessions.privacyModeBySession[oldPendingPath];
    }

    if (Object.prototype.hasOwnProperty.call(draft.sessions.titleGenerationBySession, oldPendingPath)) {
      draft.sessions.titleGenerationBySession[newSessionPath] =
        draft.sessions.titleGenerationBySession[oldPendingPath];
      delete draft.sessions.titleGenerationBySession[oldPendingPath];
    }

    // A hidden create with queued work is about to become a hidden running
    // session. Persist that intent under the durable path before the async
    // drain starts so a renderer reload cannot reopen/focus it in the gap.
    const hiddenOperation = Object.values(draft.operations).find(
      (operation) => operation.session.pendingPath === oldPendingPath
        && operation.terminal?.outcome === 'settled'
        && operation.hidden,
    );
    if (hiddenOperation && queuedSends.length > 0
      && !draft.sessions.intentionallyHiddenRunningPaths.includes(newSessionPath)) {
      draft.sessions.intentionallyHiddenRunningPaths.push(newSessionPath);
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
  const modelDrain = startNextDeferredSetModel(nextState);
  const holdSendsForModel = queuedSends.length > 0
    && modelDrain.state.settings.backendReady
    && sessionHasDeferredModelWrite(modelDrain.state, newSessionPath);
  const finalState = holdSendsForModel
    ? produce(modelDrain.state, (draft) => {
        const queue = draft.pending.backendReadyQueueBySession[newSessionPath] ??= [];
        for (const entry of queuedSends) queue.push({ ...entry, sessionPath: newSessionPath });
      })
    : modelDrain.state;
  const effects: Effect[] = [...modelDrain.effects];
  if (queuedSends.length > 0 && !holdSendsForModel) {
    effects.push({
      kind: 'DrainPendingSendQueue',
      corrId: `drain:${oldPendingPath}`,
      resolvedSessionPath: newSessionPath,
      entries: queuedSends,
    });
  }

  return { state: finalState, effects };
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
        intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, event.sessionPath),
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
  const incomingGroups = event.pinnedTabGroups ?? state.sessions.pinnedTabGroups;
  const { openTabPaths: pinnedFirstOpen, pinnedTabPaths: filteredPinned } = reorderOpenTabsPinnedFirst(
    event.openTabPaths,
    incomingPinned,
  );
  // Reconcile groups against the restored pinned tabs: drop members no longer
  // pinned, dissolve groups below 2, and reorder the pinned prefix so each
  // group's members are contiguous (restoring the contiguity invariant).
  const { pinnedTabPaths: reconciledPinned, pinnedTabGroups } = reconcilePinnedGroups(
    filteredPinned,
    incomingGroups,
  );
  const pinnedSet = new Set(reconciledPinned);
  const unpinned = pinnedFirstOpen.filter((p) => !pinnedSet.has(p));
  const openTabPaths = [...reconciledPinned, ...unpinned];
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths,
        pinnedTabPaths: reconciledPinned,
        pinnedTabGroups,
        unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) =>
          openTabPaths.includes(p),
        ),
        intentionallyHiddenRunningPaths: state.sessions.intentionallyHiddenRunningPaths.filter((p) => !openTabPaths.includes(p)),
      },
    },
    effects: [],
  };
}
