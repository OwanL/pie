import type { ArchState, PendingOp, SetModelPending } from '../arch-state.js';
import type { ChatMessage, ComposerInput, SessionSummary, UserContentPart } from '../../../lib/protocol/index.js';
import { markdownFromUserParts } from '../../transcript-delivery/transcript-helpers.js';
import {
  buildFullTranscriptWindow,
  cullTranscriptWindowAroundActiveTurn,
  withIncrementedWindowCounts,
  withDecrementedWindowCounts,
} from '../../transcript-delivery/transcript-window.js';

export { withIncrementedWindowCounts };

import { TRANSCRIPT_WINDOW_BUDGETS } from '../../../lib/protocol/transcript-window.js';
import type { Effect } from '../effects/effects.js';
import { cleanPinnedTabGroups } from '../../../frontend/session-tabs/tab-behavior.js';
import { startNextDeferredSetModel } from './set-model-handlers.js';
import {
  clearRetiredInterruptEventFence,
  observeSessionOperationAcknowledgement,
  settleSessionOperationSucceeded,
} from '../operation-registry.js';

// Re-export from arch-state for downstream consumers
export type { ArchState, PendingOp, CurrentTurn } from '../arch-state.js';
export { createInitialArchState } from '../arch-state.js';
import { createInitialArchState } from '../arch-state.js';

/** Reducer result using the real Effect type from effects.ts. */
export interface ReducerResult {
  state: ArchState;
  effects: Effect[];
}

/** Pre-created initial state for convenience. */
const initialArchState: ArchState = createInitialArchState();
export { initialArchState };

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Resolve a possibly-aliased message ID to its canonical form. */
export function resolveAlias(state: ArchState, id: string): string {
  const alias = state.pending.messageIdAlias[id];
  return alias ? alias.canonicalId : id;
}

export interface PendingTurnOwner {
  corrId: string;
  source: 'ops' | 'promoted';
  operationId?: string;
}

/** Commit an optimistic send from any authoritative turn boundary.
 *
 * Direct semantic events and recovered checkpoints are equally authoritative:
 * both must drop rollback ownership and cancel the send watchdog. Keeping the
 * transition here prevents recovery paths from restoring a live turn while
 * leaving its optimistic send armed. */
export function commitPromotedSend(
  state: ArchState,
  sessionPath: string,
  requestId: string,
  canonicalMessageId: string,
  operationId?: string,
): ReducerResult {
  const turnOwner = findPendingTurnOwner(state, sessionPath, requestId, true, operationId);
  const ownerPending = turnOwner
    ? (state.pending.promoted[turnOwner.corrId] ?? state.pending.ops[turnOwner.corrId])
    : undefined;
  const currentTurnBySession = {
    ...state.pending.currentTurnBySession,
    [sessionPath]: { requestId, firstMessageId: canonicalMessageId },
  };
  const requestIdToLocalId = { ...state.pending.requestIdToLocalId };
  delete requestIdToLocalId[requestId];
  const promoted = { ...state.pending.promoted };
  const ops = { ...state.pending.ops };
  if (turnOwner?.source === 'promoted') delete promoted[turnOwner.corrId];
  else if (turnOwner) delete ops[turnOwner.corrId];
  const prepassBySession = { ...state.pending.prepassBySession };
  delete prepassBySession[sessionPath];
  const operations = { ...state.operations };
  const stableOperationId = operationId ?? turnOwner?.operationId;
  const operation = stableOperationId ? operations[stableOperationId] : undefined;
  if (operation?.kind === 'message.send' || operation?.kind === 'message.edit' || operation?.kind === 'message.continue') {
    const settled = settleSessionOperationSucceeded(operation, {
      pendingPath: operation.session.pendingPath,
      resolvedPath: sessionPath,
      backendGeneration: operation.backendGeneration,
    });
    if (settled) operations[stableOperationId!] = settled;
  }

  return {
    state: {
      ...state,
      operations,
      pending: {
        ...state.pending,
        currentTurnBySession,
        requestIdToLocalId,
        promoted,
        ops,
        prepassBySession,
      },
    },
    effects: turnOwner ? [{
      kind: 'ClearSendTimer', corrId: turnOwner.corrId,
      ...(ownerPending?.priorPruningMode
        ? { restorePruningMode: ownerPending.priorPruningMode }
        : {}),
    }] : [],
  };
}

/**
 * Resolve the optimistic send/edit owned by a turn boundary.
 *
 * The backend control lane can deliver `turn.started` / `message.started`
 * before the correlated RPC acknowledgement promotes `pending.ops`. Prefer an
 * exact promoted request-id match, then fall back to the oldest currently
 * executing non-queued operation for the session. Session mutation FIFO makes
 * that fallback unambiguous: a later operation cannot have entered preflight.
 */
export function findPendingTurnOwner(
  state: ArchState,
  sessionPath: string,
  requestId: string,
  allowSessionFifoFallback = true,
  operationId?: string,
): PendingTurnOwner | undefined {
  for (const [corrId, operation] of Object.entries(state.pending.promoted)) {
    if ((operationId && operation.operationId === operationId) || operation.requestId === requestId) {
      return { corrId, source: 'promoted', operationId: operation.operationId };
    }
  }
  if (operationId) {
    for (const [corrId, operation] of Object.entries(state.pending.ops)) {
      if (operation.operationId === operationId) {
        return { corrId, source: 'ops', operationId };
      }
    }
  }
  // A terminal duplicate for an already-started turn must not consume a newer
  // operation that happens to be pending on the same session. Explicit typed
  // pre-start settlements also have complete request identity and never borrow
  // FIFO ownership from a later mutation.
  if (!allowSessionFifoFallback || state.pending.currentTurnBySession[sessionPath]?.requestId === requestId) return undefined;
  for (const [corrId, operation] of Object.entries(state.pending.ops)) {
    if (operation.sessionPath === sessionPath && !operation.queued) {
      return { corrId, source: 'ops', operationId: operation.operationId };
    }
  }
  return undefined;
}

/** Start best-effort title generation exactly once at any authoritative turn commit point. */
export function startSessionTitleGeneration(
  state: ArchState,
  sessionPath: string,
  corrId: string,
): { state: ArchState; effects: Effect[] } {
  const generation = state.sessions.titleGenerationBySession[sessionPath];
  if (generation?.status !== 'armed') return { state, effects: [] };
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        titleGenerationBySession: {
          ...state.sessions.titleGenerationBySession,
          [sessionPath]: { ...generation, status: 'pending', corrId },
        },
      },
    },
    effects: [{
      kind: 'GenerateSessionTitle',
      corrId,
      ...(state.settings.sessionTitlesSettings.enabled ? {} : { enabled: false }),
      sessionPath,
      prompt: generation.prompt,
      provider: state.settings.sessionTitlesSettings.provider,
      model: state.settings.sessionTitlesSettings.model,
      thinkingLevel: state.settings.sessionTitlesSettings.thinkingLevel,
      timeoutSec: state.settings.sessionTitlesSettings.timeoutSec,
    }],
  };
}

/** Upsert a ChatMessage in a session's transcript array. */
export function upsertTranscriptMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const copy = [...messages];
    copy[idx] = message;
    return copy;
  }
  return [...messages, message];
}

/** Upsert a session summary in the sessions array. */
export function upsertSessionSummary(
  list: readonly SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] {
  const idx = list.findIndex((s) => s.path === summary.path);
  if (idx >= 0) {
    const copy = [...list];
    copy[idx] = summary;
    return copy;
  }
  return [...list, summary];
}

/** Filter a string array, removing one element. */
export function removeFromArray(arr: readonly string[], value: string): string[] {
  return arr.filter((p) => p !== value);
}

/** Add to an array if not already present. */
export function addToArray(arr: readonly string[], value: string): string[] {
  return arr.includes(value) ? [...arr] : [...arr, value];
}

/**
 * Reconcile a rejected prompt with any newer draft the user typed while the
 * request was in flight. The rejected prompt comes first so the cursor remains
 * at the end of the newer draft after the composer is restored. Keeping both
 * is preferable to silently replacing either user-authored value.
 */
export function mergeRejectedDraftText(rejectedText: string, currentDraft: string | undefined): string {
  if (!rejectedText) return currentDraft ?? '';
  if (!currentDraft || currentDraft === rejectedText) return rejectedText;
  return `${rejectedText}\n\n${currentDraft}`;
}

/** Restore captured inputs without replacing attachments added since send. */
export function mergeRejectedComposerInputs(
  rejectedInputs: readonly ComposerInput[] | undefined,
  currentInputs: readonly ComposerInput[] | undefined,
): ComposerInput[] {
  const merged = [...(rejectedInputs ?? [])];
  const seen = new Set(merged.map((input) => input.id));
  for (const input of currentInputs ?? []) {
    if (!seen.has(input.id)) {
      seen.add(input.id);
      merged.push(input);
    }
  }
  return merged;
}

/** Options controlling how much of a session's state {@link evictSession} removes. */
export interface EvictSessionOptions {
  /** Drop the session entry from the `sessions.sessions` summary array and
   *  strip it from `runningSessionPaths` (full eviction: the session is gone
   *  from the backend, so it can no longer be running). */
  removeSummary: boolean;
  /** Drop the session from `openTabPaths` / `pinnedTabPaths` /
   *  `unreadFinishedSessionPaths` and null `activeSessionPath` if it was the
   *  active tab. */
  removeTabs: boolean;
}

/**
 * Remove per-session state for a given sessionPath.
 *
 * Collapses the two drifted eviction paths (full eviction via
 * `handleSessionClosed` and the conditional `handleSessionScopeCleared` /
 * `handleCloseSession` tab-close path) into a single helper.
 *
 * ALWAYS clears every per-session keyed map — including
 * `fileChanges.expandedBySession`, which the tab-close path previously leaked
 * (stale drawer-expanded state survived a close → reopen cycle). Also always
 * filters the corrId / requestId / messageId-keyed pending collections
 * (`ops`, `setModelByCorrId`, `requestIdToLocalId`, `messageIdAlias`,
 * `currentTurnBySession`, `sendQueueBySession`, `backendReadyQueueBySession`,
 * `deferredSetModelBySession`)
 * by `sessionPath !== sp` so a late *Result for the evicted session no-ops
 * instead of mutating — or reverting into — a closed session.
 *
 * `removeSummary` and `removeTabs` are independent so the three call sites can
 * express their distinct semantics:
 *  - `handleSessionClosed` → `{ removeSummary: true, removeTabs: true }`
 *    (full eviction).
 *  - `handleSessionScopeCleared` → both coupled to `event.removeSessionSummary`
 *    (a scope clear that drops the summary also drops the tab).
 *  - `handleCloseSession` → `{ removeSummary: false, removeTabs: true }`
 *    (close the tab but keep the summary for reopening, and deliberately
 *    preserve `runningSessionPaths` — the session may still be running in the
 *    backend even if its tab is closed).
 *
 * Emits `CancelBackendReadyWatchdog` when the eviction empties the
 * backend-ready queue (the evicted session had queued sends and no other
 * sessions have entries). The runner's watchdog cancel is a no-op when no
 * timer is running, so emitting this from the full-eviction path (which
 * previously emitted no effects) is superset-safe.
 */
export function evictSession(
  state: ArchState,
  sessionPath: string,
  opts: EvictSessionOptions,
): ReducerResult {
  const sp = sessionPath;
  const { removeSummary, removeTabs } = opts;

  // ── Per-session keyed maps (always cleared, including expandedBySession) ──
  const { [sp]: _t, ...remainingTranscripts } = state.transcript.bySession;
  const { [sp]: _sp, ...remainingSystemPrompts } = state.transcript.systemPromptsBySession;
  const { [sp]: _w, ...remainingWindows } = state.transcript.windowBySession;
  const { [sp]: _usage, ...remainingSessionUsage } = state.transcript.sessionUsageBySession ?? {};
  const { [sp]: _e, ...remainingEditing } = state.transcript.editingMessageIdBySession;
  const { [sp]: _ed, ...remainingEditingDrafts } = state.transcript.editingDraftBySession;
  const { [sp]: _deferred, ...remainingDeferredWindowReplacements } = state.transcript.deferredWindowReplacementBySession;
  const { [sp]: _pf, ...remainingPagingInFlight } = state.transcript.pagingInFlightBySession;
  const { [sp]: _title, ...remainingTitleGeneration } = state.sessions.titleGenerationBySession;
  const { [sp]: _rtry, ...remainingRetryStatus } = state.sessions.retryStatusBySession;
  const { [sp]: _a, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
  const { [sp]: _privacy, ...remainingPrivacyModes } = state.sessions.privacyModeBySession;
  const { [sp]: _ct, ...remainingTurns } = state.pending.currentTurnBySession;
  const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
  const { [sp]: _ms, ...remainingModelStatuses } = state.settings.availableModelsStatusBySession;
  const { [sp]: _mr, ...remainingModelRevisions } = state.settings.modelHydrationRevisionBySession;
  const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
  const { [sp]: _ice, ...remainingInitialContextEstimates } = state.settings.initialContextEstimateBySession;
  const { [sp]: _mcpOverrides, ...remainingMcpSessionOverrides } = state.settings.mcpSessionOverridesBySession;
  const { [sp]: _mcpPendingApply, ...remainingMcpPendingApply } = state.settings.mcpPendingApplyBySession;
  const { [sp]: _eui, ...remainingExtUI } = state.settings.pendingExtensionUIRequestsBySession;
  const remainingAutonomousModeBySession = { ...(state.settings.prefs.autonomousModeBySession ?? {}) };
  const remainingSubagentProviderTogglesBySession = { ...state.settings.prefs.subagentProviderTogglesBySession };
  const hadSessionExecutionPrefs = removeSummary && (
    Object.prototype.hasOwnProperty.call(remainingAutonomousModeBySession, sp)
    || Object.prototype.hasOwnProperty.call(remainingSubagentProviderTogglesBySession, sp)
  );
  if (removeSummary) {
    delete remainingAutonomousModeBySession[sp];
    delete remainingSubagentProviderTogglesBySession[sp];
  }
  const { [sp]: _ci, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
  const { [sp]: _rs, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
  const { [sp]: _dt, ...remainingDraftText } = state.composer.draftTextBySession;
  const { [sp]: _fc, ...remainingFileChanges } = state.fileChanges.bySession;
  const { [sp]: _fce, ...remainingFileChangesExpanded } = state.fileChanges.expandedBySession;
  const { [sp]: _rfr, ...remainingReadFilePaths } = state.fileChanges.readFilePathsBySession;
  const { [sp]: _psq, ...remainingPendingSendQueue } = state.pending.sendQueueBySession;
  const { [sp]: _brq, ...remainingBackendReadyQueue } = state.pending.backendReadyQueueBySession;
  const { [sp]: _dsm, ...remainingDeferredSetModel } = state.pending.deferredSetModelBySession;
  const { [sp]: _pp, ...remainingPrepass } = state.pending.prepassBySession;
  const { [sp]: _liveTurn, ...remainingLiveTurns } = state.livePipeline.turnsBySession;
  const { [sp]: _liveRevision, ...remainingLiveRevisions } = state.livePipeline.revisionBySession;
  const remainingLiveTools = Object.fromEntries(Object.entries(state.livePipeline.toolsByExecutionId)
    .filter(([, tool]) => tool.turnId !== _liveTurn?.turnId));
  const remainingPendingOwnerEvents = Object.fromEntries(Object.entries(state.livePipeline.pendingOwnerEvents)
    .filter(([, events]) => !events.some((event) => event.sessionPath === sp)));
  const remainingTerminalAttempts = Object.fromEntries(Object.entries(state.livePipeline.terminalAttempts)
    .filter(([, attempt]) => attempt.sessionPath !== sp));

  // ── corrId / requestId / messageId-keyed pending collections (filtered) ──
  // Drop in-flight send/edit ops for the evicted session. Without this, a
  // pending.ops entry is orphaned if the SendResult/EditResult never arrives
  // (backend crash, dropped event).
  const remainingOps: Record<string, PendingOp> = {};
  for (const [corrId, op] of Object.entries(state.pending.ops)) {
    if (op.sessionPath !== sp) remainingOps[corrId] = op;
  }

  // Drop promoted (early-acked) sends for the evicted session so a late
  // PreflightFailed no-ops instead of reverting into a closed session, and
  // the rollback snapshot does not leak past close.
  const remainingPromoted: Record<string, PendingOp> = {};
  for (const [corrId, op] of Object.entries(state.pending.promoted)) {
    if (op.sessionPath !== sp) remainingPromoted[corrId] = op;
  }

  // Drop in-flight setModel lifecycles for the evicted session (both the
  // modal-confirm phase and the RPC phase). A late ModelSwitchConfirmResult /
  // SetModelResult for these corrIds then no-ops instead of applying to — or
  // reverting into — a closed session.
  const remainingSetModel: Record<string, SetModelPending> = {};
  for (const [corrId, entry] of Object.entries(state.pending.setModelByCorrId)) {
    if (entry.sessionPath !== sp) remainingSetModel[corrId] = entry;
  }

  const remainingExtensionUiResponses = Object.fromEntries(
    Object.entries(state.pending.extensionUiResponseByCorrId).filter(([, entry]) => entry.sessionPath !== sp),
  );

  const remainingRequestIdToLocalId: Record<string, { sessionPath: string; localId: string }> = {};
  for (const [requestId, mapping] of Object.entries(state.pending.requestIdToLocalId)) {
    if (mapping.sessionPath !== sp) remainingRequestIdToLocalId[requestId] = mapping;
  }

  const remainingMessageIdAlias: Record<string, { canonicalId: string; sessionPath: string }> = {};
  for (const [messageId, alias] of Object.entries(state.pending.messageIdAlias)) {
    if (alias.sessionPath !== sp) remainingMessageIdAlias[messageId] = alias;
  }

  // ── Summary + running paths (removeSummary: full eviction) ──
  const nextSessions = removeSummary
    ? state.sessions.sessions.filter((s) => s.path !== sp)
    : state.sessions.sessions;
  const nextRunningPaths = removeSummary
    ? removeFromArray(state.sessions.runningSessionPaths, sp)
    : state.sessions.runningSessionPaths;
  const nextCapabilitiesBySession = removeSummary
    ? Object.fromEntries(Object.entries(state.sessions.capabilitiesBySession).filter(([path]) => path !== sp))
    : state.sessions.capabilitiesBySession;
  const nextSettlementGenerations = removeSummary
    ? Object.fromEntries(Object.entries(state.sessions.settlementGenerationBySession).filter(([path]) => path !== sp))
    : state.sessions.settlementGenerationBySession;
  const nextCompactingPaths = removeSummary
    ? removeFromArray(state.sessions.compactingSessionPaths, sp)
    : state.sessions.compactingSessionPaths;
  const nextIntentionallyHiddenRunningPaths = removeSummary
    ? removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sp)
    : state.sessions.intentionallyHiddenRunningPaths;
  const { [sp]: _lastCompaction, ...remainingLastCompaction } = state.sessions.lastCompactionBySession;

  // ── Tab arrays (removeTabs: close the tab) ──
  const nextOpenTabPaths = removeTabs
    ? removeFromArray(state.sessions.openTabPaths, sp)
    : state.sessions.openTabPaths;
  const nextPinnedPaths = removeTabs
    ? removeFromArray(state.sessions.pinnedTabPaths, sp)
    : state.sessions.pinnedTabPaths;
  const nextPinnedGroups = removeTabs
    ? cleanPinnedTabGroups(state.sessions.pinnedTabGroups, nextPinnedPaths)
    : state.sessions.pinnedTabGroups;
  const nextUnreadPaths = removeTabs
    ? removeFromArray(state.sessions.unreadFinishedSessionPaths, sp)
    : state.sessions.unreadFinishedSessionPaths;
  const nextActivePath = removeTabs && state.sessions.activeSessionPath === sp
    ? null
    : state.sessions.activeSessionPath;

  // ── Backend-ready watchdog effect ──
  // If the evicted session had backend-ready-queued sends and no other
  // sessions have entries, cancel the watchdog timer (the queue is now
  // empty). The runner's cancel is a no-op when no timer is running, so this
  // is safe to emit from any eviction path.
  const hadBackendReadyEntries = !!state.pending.backendReadyQueueBySession[sp]?.length;
  const backendReadyQueueNowEmpty = Object.keys(remainingBackendReadyQueue).length === 0;
  const evictsDeferredReplay = state.pending.deferredSetModelInFlightSessionPath === sp;
  const effects: Effect[] =
    hadBackendReadyEntries && backendReadyQueueNowEmpty
      ? [{ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' }]
      : [];

  const evictedState: ArchState = {
      ...state,
      operations: clearRetiredInterruptEventFence(state.operations, sp),
      transcript: {
        ...state.transcript,
        bySession: remainingTranscripts,
        systemPromptsBySession: remainingSystemPrompts,
        windowBySession: remainingWindows,
        sessionUsageBySession: remainingSessionUsage,
        editingMessageIdBySession: remainingEditing,
        editingDraftBySession: remainingEditingDrafts,
        deferredWindowReplacementBySession: remainingDeferredWindowReplacements,
        pagingInFlightBySession: remainingPagingInFlight,
      },
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedPaths,
        pinnedTabGroups: nextPinnedGroups,
        runningSessionPaths: nextRunningPaths,
        capabilitiesBySession: nextCapabilitiesBySession,
        settlementGenerationBySession: nextSettlementGenerations,
        compactingSessionPaths: nextCompactingPaths,
        lastCompactionBySession: remainingLastCompaction,
        intentionallyHiddenRunningPaths: nextIntentionallyHiddenRunningPaths,
        unreadFinishedSessionPaths: nextUnreadPaths,
        activeSessionPath: nextActivePath,
        analyticsFactorsBySession: remainingAnalytics,
        privacyModeBySession: remainingPrivacyModes,
        titleGenerationBySession: remainingTitleGeneration,
        retryStatusBySession: remainingRetryStatus,
      },
      settings: {
        ...state.settings,
        availableModelsBySession: remainingModels,
        availableModelsStatusBySession: remainingModelStatuses,
        modelHydrationRevisionBySession: remainingModelRevisions,
        contextUsageBySession: remainingContext,
        initialContextEstimateBySession: remainingInitialContextEstimates,
        mcpSessionOverridesBySession: remainingMcpSessionOverrides,
        mcpPendingApplyBySession: remainingMcpPendingApply,
        pendingExtensionUIRequestsBySession: remainingExtUI,
        ...(removeSummary ? {
          prefs: {
            ...state.settings.prefs,
            autonomousModeBySession: remainingAutonomousModeBySession,
            subagentProviderTogglesBySession: remainingSubagentProviderTogglesBySession,
          },
        } : {}),
      },
      composer: {
        ...state.composer,
        pendingComposerInputsBySession: remainingComposer,
        activeRunSummaryBySession: remainingRunSummaries,
        draftTextBySession: remainingDraftText,
      },
      fileChanges: {
        ...state.fileChanges,
        bySession: remainingFileChanges,
        expandedBySession: remainingFileChangesExpanded,
        readFilePathsBySession: remainingReadFilePaths,
      },
      livePipeline: {
        ...state.livePipeline,
        turnsBySession: remainingLiveTurns,
        toolsByExecutionId: remainingLiveTools,
        pendingOwnerEvents: remainingPendingOwnerEvents,
        terminalAttempts: remainingTerminalAttempts,
        revisionBySession: remainingLiveRevisions,
      },
      pending: {
        ...state.pending,
        ops: remainingOps,
        promoted: remainingPromoted,
        currentTurnBySession: remainingTurns,
        messageIdAlias: remainingMessageIdAlias,
        requestIdToLocalId: remainingRequestIdToLocalId,
        setModelByCorrId: remainingSetModel,
        deferredSetModelBySession: remainingDeferredSetModel,
        deferredSetModelInFlightCorrId: evictsDeferredReplay
          ? null
          : state.pending.deferredSetModelInFlightCorrId,
        deferredSetModelInFlightSessionPath: evictsDeferredReplay
          ? null
          : state.pending.deferredSetModelInFlightSessionPath,
        extensionUiResponseByCorrId: remainingExtensionUiResponses,
        sendQueueBySession: remainingPendingSendQueue,
        backendReadyQueueBySession: remainingBackendReadyQueue,
        prepassBySession: remainingPrepass,
      },
    };
  if (hadSessionExecutionPrefs) {
    effects.push({
      kind: 'SetPrefsRpc',
      corrId: `prefs:session-removed:${sp}`,
      prefs: {
        ...(Object.prototype.hasOwnProperty.call(state.settings.prefs.autonomousModeBySession ?? {}, sp)
          ? { autonomousModeBySession: { [sp]: undefined } as unknown as Record<string, boolean> }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(state.settings.prefs.subagentProviderTogglesBySession, sp)
          ? { subagentProviderTogglesBySession: { [sp]: undefined } as unknown as Record<string, Record<string, boolean>> }
          : {}),
      },
    });
  }
  const modelDrain = startNextDeferredSetModel(evictedState);
  return {
    state: modelDrain.state,
    effects: [...effects, ...modelDrain.effects],
  };
}

// ─── Immer-based transcript mutation helpers ─────────────────────────────────

/** Ensure a session window exists, creating a default if missing. */
export function ensureSessionWindow(draft: ArchState, sessionPath: string) {
  if (!draft.transcript.windowBySession[sessionPath]) {
    draft.transcript.windowBySession[sessionPath] = buildFullTranscriptWindow(
      draft.transcript.bySession[sessionPath] ?? [],
    );
  }
  return draft.transcript.windowBySession[sessionPath];
}

/** Enforce the loaded-window budget by culling old messages if needed. */
export function enforceLoadedWindowBudget(draft: ArchState, sessionPath: string) {
  const transcript = draft.transcript.bySession[sessionPath];
  if (!transcript || transcript.length === 0) return;

  const transcriptWindow = ensureSessionWindow(draft, sessionPath);
  // The virtualizer can pin an editor only while its row remains in the host's
  // loaded window. Prefer that row over the tail while a local draft is active;
  // the window may temporarily exceed its soft budget rather than destroying
  // uncommitted user input.
  const pinnedMessageId = draft.transcript.editingMessageIdBySession[sessionPath]
    ?? transcript[transcript.length - 1]?.id;
  const culled = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    activeTurnMessageId: pinnedMessageId,
    maxLoadedCount: TRANSCRIPT_WINDOW_BUDGETS.maxLoadedCount,
  });

  draft.transcript.bySession[sessionPath] = culled.transcript;
  draft.transcript.windowBySession[sessionPath] = culled.transcriptWindow;
}

/** Append an optimistic local user message to the transcript (Immer draft). */
export function appendLocalUserMessage(
  draft: ArchState,
  sessionPath: string,
  id: string,
  text: string,
  userParts: UserContentPart[] | undefined,
  createdAt: string,
  /** Optimistic message status. Defaults to 'completed' (a normal send). The
   *  steering busy branch passes 'queued' so the message renders as a pending
   *  steering injection until `QueuedDelivered` promotes it. */
  status: ChatMessage['status'] = 'completed',
  /** Host-side synthetic-send tag. Set on the optimistic message so the
   *  webview can differentiate it from a typed user message. Not persisted by
   *  the backend. */
  customType?: string,
  customDetails?: unknown,
  sender?: ChatMessage['sender'],
) {
  const list = draft.transcript.bySession[sessionPath] ?? [];
  const existingIndex = list.findIndex((m: ChatMessage) => m.id === id);
  if (existingIndex !== -1) {
    list[existingIndex] = {
      id,
      role: 'user',
      createdAt,
      markdown: markdownFromUserParts(userParts, text),
      userParts,
      status,
      ...(sender !== undefined ? { sender } : {}),
      ...(customType !== undefined ? { customType } : {}),
      ...(customDetails !== undefined ? { customDetails } : {}),
    };
  } else {
    list.push({
      id,
      role: 'user',
      createdAt,
      markdown: markdownFromUserParts(userParts, text),
      userParts,
      status,
      ...(sender !== undefined ? { sender } : {}),
      ...(customType !== undefined ? { customType } : {}),
      ...(customDetails !== undefined ? { customDetails } : {}),
    });
  }
  draft.transcript.bySession[sessionPath] = list;

  const nextWindow = withIncrementedWindowCounts(draft.transcript.windowBySession[sessionPath]);
  nextWindow.hasUserMessages = true;
  draft.transcript.windowBySession[sessionPath] = nextWindow;
  enforceLoadedWindowBudget(draft, sessionPath);
}

/** Remove a message from the transcript by ID (Immer draft). */
export function removeMessage(draft: ArchState, sessionPath: string, messageId: string) {
  const list = draft.transcript.bySession[sessionPath];
  if (!list) return;

  const removedMessage = list.find((m: ChatMessage) => m.id === messageId);
  draft.transcript.bySession[sessionPath] = list.filter((m: ChatMessage) => m.id !== messageId);

  const nextWindow = withDecrementedWindowCounts(draft.transcript.windowBySession[sessionPath]);
  if (nextWindow) {
    const isFullyLoaded =
      !nextWindow.hasOlder
      && !nextWindow.hasNewer
      && nextWindow.loadedStart === 0
      && nextWindow.loadedEnd === nextWindow.totalCount;

    if (
      removedMessage?.role === 'user'
      && isFullyLoaded
      && !draft.transcript.bySession[sessionPath].some((m: ChatMessage) => m.role === 'user')
    ) {
      nextWindow.hasUserMessages = false;
    }

    draft.transcript.windowBySession[sessionPath] = nextWindow;
  }
}

/**
 * Optimistically truncate the local transcript at `messageId`, removing the
 * message and everything after it. Decrements the transcript window counts once
 * per removed message and mirrors `removeMessage`'s `hasUserMessages` cleanup.
 *
 * Returns the removed tail so callers can restore it on rollback. This is the
 * local half of the Copilot-style edit behavior: the old user message, agent
 * reply, and any continuation turns vanish instantly when the user confirms an
 * edit, without waiting for the backend truncate snapshot.
 */
export function truncateLocalTranscriptAfter(
  draft: ArchState,
  sessionPath: string,
  messageId: string,
): ChatMessage[] {
  const list = draft.transcript.bySession[sessionPath];
  if (!list) return [];

  const index = list.findIndex((m: ChatMessage) => m.id === messageId);
  if (index === -1) return [];

  const removedTail = list.slice(index);
  const keptPrefix = list.slice(0, index);
  draft.transcript.bySession[sessionPath] = keptPrefix;

  let nextWindow = draft.transcript.windowBySession[sessionPath];
  for (const _ of removedTail) {
    const decremented = withDecrementedWindowCounts(nextWindow);
    if (!decremented) break;
    nextWindow = decremented;
  }

  if (nextWindow) {
    const removedUser = removedTail.some((m: ChatMessage) => m.role === 'user');
    const isFullyLoaded =
      !nextWindow.hasOlder
      && !nextWindow.hasNewer
      && nextWindow.loadedStart === 0
      && nextWindow.loadedEnd === nextWindow.totalCount;

    if (
      removedUser
      && isFullyLoaded
      && !keptPrefix.some((m: ChatMessage) => m.role === 'user')
    ) {
      nextWindow.hasUserMessages = false;
    }

    draft.transcript.windowBySession[sessionPath] = nextWindow;
  }

  return removedTail;
}

/**
 * Restore a transcript tail removed by {@link truncateLocalTranscriptAfter}
 * back onto the transcript, appending the messages in order and re-incrementing
 * the window counts once per message. Mirrors `truncateLocalTranscriptAfter`
 * in reverse: each restored message re-increments the window counts, and
 * `hasUserMessages` is set true if any restored message is a user message.
 *
 * Used by the edit-rollback handlers (`handleEditResult` `!ok` branch and the
 * `handlePreflightFailed` edit branch) to undo an optimistic edit truncate when
 * the edit fails pre- or post-ack.
 */
export function restoreRemovedTail(
  draft: ArchState,
  sessionPath: string,
  removedTail: ChatMessage[],
) {
  if (removedTail.length === 0) return;

  const list = draft.transcript.bySession[sessionPath] ?? [];
  // Rollback can race an authoritative `session.opened` snapshot that already
  // reinstated some of these rows. Re-appending them would duplicate transcript
  // entries and desynchronize `transcriptLength` from the window's `totalCount`
  // (observed as permanently hidden/stale rows in the renderer).
  const present = new Set(list.map((m: ChatMessage) => m.id));
  const restored = removedTail.filter((message) => !present.has(message.id));
  if (restored.length === 0) return;

  for (const message of restored) {
    list.push(message);
  }
  draft.transcript.bySession[sessionPath] = list;

  let nextWindow = draft.transcript.windowBySession[sessionPath];
  for (const _ of restored) {
    nextWindow = withIncrementedWindowCounts(nextWindow);
  }
  if (nextWindow) {
    if (restored.some((m: ChatMessage) => m.role === 'user')) {
      nextWindow.hasUserMessages = true;
    }
    draft.transcript.windowBySession[sessionPath] = nextWindow;
  }
}

// ─── Typed agent close bridge acknowledgement barrier ──────────────────────────

/** Observe one close-operation acknowledgement and produce the side effects a
 *  settling close operation requires: release deferred stop/create cleanup,
 *  report the terminal bridge outcome, restore failed tabs without changing
 *  focus, and commit private summary eviction only after deletion succeeds. */
export function observeCloseOperationAcknowledgement(
  state: ArchState,
  operationId: string | undefined,
  backendGeneration: number | undefined,
  acknowledgement: string,
  ok: boolean,
  error?: string,
  deletionCommitted = false,
): ReducerResult {
  if (!operationId) return { state, effects: [] };
  const operation = state.operations[operationId];
  if (!operation || operation.kind !== 'session.close'
    || operation.backendGeneration !== backendGeneration) return { state, effects: [] };
  let updated = observeSessionOperationAcknowledgement(operation, acknowledgement, ok, error);
  if (!updated) return { state, effects: [] };
  if (acknowledgement === 'cleanup' && deletionCommitted) {
    updated = { ...updated, closeDeletionCommitted: true };
  }
  // Either failed prerequisite makes deferred cleanup unreachable. Still wait
  // for the other acknowledgement so stop completion is not guessed.
  if ((acknowledgement === 'stop'
    || (acknowledgement === 'persist-tabs' && updated.closeMode === 'stop-cleanup'))
    && !ok && !updated.terminal && !updated.closeCleanupDispatched) {
    updated = observeSessionOperationAcknowledgement(updated, 'cleanup', false, error) ?? updated;
  }
  if (updated.closePrivacyMode === true && updated.acknowledgements?.cleanup === 'failed'
    && updated.acknowledgements['privacy-marker-removal'] === 'pending') {
    updated = observeSessionOperationAcknowledgement(
      updated, 'privacy-marker-removal', false, 'Privacy marker retained because close cleanup did not complete.',
    ) ?? updated;
  }
  const operations: ArchState['operations'] = { ...state.operations };
  const effects: Effect[] = [];

  const callerResponseReleased = updated.closeSelfHandoffRequired !== true
    || updated.acknowledgements?.['caller-response'] === 'succeeded';
  const stopReleased = updated.closeMode === 'stop-cleanup'
    && updated.acknowledgements?.stop === 'succeeded'
    && updated.acknowledgements?.['persist-tabs'] === 'succeeded'
    && callerResponseReleased;
  const createReleased = updated.closeWaitForCreate === true
    && !!updated.session.resolvedPath
    && callerResponseReleased;
  const idleAgentCloseReleased = updated.closeMode !== 'stop-cleanup'
    && updated.closeRequestKey !== undefined
    && callerResponseReleased
    && updated.closeWaitForCreate !== true;
  const releaseDeferredStop = acknowledgement === 'caller-response'
    && ok
    && updated.closeMode === 'stop-cleanup'
    && updated.closeSelfHandoffRequired === true
    && updated.closeStopDispatched !== true
    && updated.closeStopOperationId !== undefined;
  if (releaseDeferredStop) {
    const stopOperation = state.operations[updated.closeStopOperationId!];
    if (stopOperation && !stopOperation.terminal) {
      effects.push({
        kind: 'InterruptRpc',
        corrId: updated.causal.selectionToken,
        operationId: stopOperation.operationId,
        operationAttempt: stopOperation.attempt,
        backendGeneration: stopOperation.backendGeneration,
        sessionPath: updated.session.resolvedPath ?? updated.session.pendingPath,
        ...(updated.closeStopAbortSendCorrIds?.length
          ? { abortSendCorrIds: updated.closeStopAbortSendCorrIds } : {}),
        ...(updated.closeStopCancelQueuedOperationIds?.length
          ? { cancelQueuedOperationIds: updated.closeStopCancelQueuedOperationIds } : {}),
        ...(updated.closeStopUsePriorityLane ? { usePriorityLane: true } : {}),
      });
      updated = { ...updated, closeStopDispatched: true };
    }
  }
  if (!updated.terminal && !updated.closeCleanupDispatched && (stopReleased || createReleased || idleAgentCloseReleased)) {
    const lifecycleOperation: typeof updated = { ...updated, closeCleanupDispatched: true };
    operations[operationId] = lifecycleOperation;
    effects.push({
      kind: 'CloseSession',
      corrId: updated.causal.selectionToken,
      sessionPath: lifecycleOperation.session.resolvedPath ?? lifecycleOperation.session.pendingPath,
      nextPath: lifecycleOperation.closeNextPath ?? null,
      privacyMode: lifecycleOperation.closePrivacyMode === true,
      selectionChanged: lifecycleOperation.closeSelectionChanged === true,
      operationId,
      backendGeneration: lifecycleOperation.backendGeneration,
    });
  } else {
    operations[operationId] = updated;
  }

  // Private cleanup irreversibly deletes the transcript. Drop the retained
  // summary only after that cleanup acknowledgement, not at close ingress.
  let resultState: ArchState = { ...state, operations };
  if (acknowledgement === 'privacy-marker-removal' && ok) {
    const privatePath = updated.session.resolvedPath ?? updated.session.pendingPath;
    const { [privatePath]: _removedPrivacyMarker, ...privacyModeBySession } = resultState.sessions.privacyModeBySession;
    resultState = {
      ...resultState,
      sessions: { ...resultState.sessions, privacyModeBySession },
    };
  }
  if (acknowledgement === 'cleanup' && ok && updated.closePrivacyMode) {
    const closedPath = updated.session.resolvedPath ?? updated.session.pendingPath;
    const evicted = evictSession(resultState, closedPath, { removeSummary: true, removeTabs: false });
    resultState = evicted.state;
    effects.push(...evicted.effects);
  }
  if (updated.terminal) {
    const lifecycleAcknowledgements = Object.entries(updated.acknowledgements ?? {})
      .filter(([name]) => name !== 'caller-response')
      .map(([, acknowledgement]) => acknowledgement);
    const succeededCount = lifecycleAcknowledgements.filter((ack) => ack === 'succeeded').length;
    const phase: 'completed' | 'failed' | 'unknown' = updated.terminal.outcome === 'settled'
      ? 'completed'
      : succeededCount === 0
        ? 'failed'
        : 'unknown';
    const deletionCommitted = updated.closePrivacyMode === true
      && (updated.closeDeletionCommitted === true || updated.acknowledgements?.cleanup === 'succeeded');
    const restoredPath = updated.session.resolvedPath ?? updated.session.pendingPath;
    const canRestore = phase !== 'completed'
      && updated.acknowledgements?.cleanup !== 'succeeded'
      && !deletionCommitted
      && resultState.sessions.sessions.some((summary) => summary.path === restoredPath)
      && !resultState.sessions.openTabPaths.includes(restoredPath);
    if (canRestore) {
      const nextOpenTabPaths = [...resultState.sessions.openTabPaths, restoredPath];
      const parentOperation = updated.causal.parentOperationId
        ? resultState.operations[updated.causal.parentOperationId]
        : undefined;
      if (parentOperation && (parentOperation.kind === 'session.create' || parentOperation.kind === 'session.duplicate')) {
        const { closeOperationId: _closeOperationId, ...parent } = parentOperation;
        operations[parentOperation.operationId] = { ...parent, hidden: false };
        resultState = { ...resultState, operations };
      }
      effects.push({
        kind: 'PersistTabs',
        corrId: updated.causal.selectionToken,
        openTabPaths: nextOpenTabPaths,
        activeSessionPath: resultState.sessions.activeSessionPath,
        pinnedTabPaths: resultState.sessions.pinnedTabPaths,
        pinnedTabGroups: resultState.sessions.pinnedTabGroups,
        ...(updated.closePrivacyMode ? {
          privateSessionPaths: [...new Set([
            restoredPath,
            ...Object.entries(resultState.sessions.privacyModeBySession)
              .filter(([, enabled]) => enabled)
              .map(([privatePath]) => privatePath),
          ])],
        } : {}),
      });
      resultState = {
        ...resultState,
        sessions: {
          ...resultState.sessions,
          openTabPaths: nextOpenTabPaths,
          intentionallyHiddenRunningPaths: removeFromArray(
            resultState.sessions.intentionallyHiddenRunningPaths,
            restoredPath,
          ),
          ...(updated.closePrivacyMode ? {
            privacyModeBySession: { ...resultState.sessions.privacyModeBySession, [restoredPath]: true },
          } : {}),
        },
      };
    }
    if (updated.closeRequestKey) {
      effects.push({
        kind: 'SessionCloseBridgeAck',
        corrId: updated.causal.selectionToken,
        sessionPath: restoredPath,
        requestKey: updated.closeRequestKey,
        phase,
        ...(phase === 'completed' ? {} : (error ?? updated.terminal.detail
          ? { error: error ?? updated.terminal.detail }
          : {})),
      });
    }
  }
  return { state: resultState, effects };
}
