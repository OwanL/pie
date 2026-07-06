import type { ArchState, PendingOp, SetModelPending } from '../arch-state.js';
import type { ChatMessage, SessionSummary, UserContentPart } from '../../../shared/protocol.js';
import { markdownFromUserParts } from '../transcript-helpers.js';
import {
  buildFullTranscriptWindow,
  cullTranscriptWindowAroundActiveTurn,
  withIncrementedWindowCounts,
  withDecrementedWindowCounts,
} from '../transcript-window.js';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../../shared/transcript-window.js';
import type { Effect } from '../effects.js';

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
 * `currentTurnBySession`, `sendQueueBySession`, `backendReadyQueueBySession`)
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
  const { [sp]: _e, ...remainingEditing } = state.transcript.editingMessageIdBySession;
  const { [sp]: _pf, ...remainingPagingInFlight } = state.transcript.pagingInFlightBySession;
  const { [sp]: _i, ...remainingInterrupts } = state.sessions.interruptInFlightBySession;
  const { [sp]: _rtry, ...remainingRetryStatus } = state.sessions.retryStatusBySession;
  const { [sp]: _a, ...remainingAnalytics } = state.sessions.analyticsFactorsBySession;
  const { [sp]: _ct, ...remainingTurns } = state.pending.currentTurnBySession;
  const { [sp]: _m, ...remainingModels } = state.settings.availableModelsBySession;
  const { [sp]: _cu, ...remainingContext } = state.settings.contextUsageBySession;
  const { [sp]: _o, ...remainingOutcome } = state.settings.showOutcomeDialogBySession;
  const { [sp]: _eui, ...remainingExtUI } = state.settings.pendingExtensionUIRequestsBySession;
  const { [sp]: _ci, ...remainingComposer } = state.composer.pendingComposerInputsBySession;
  const { [sp]: _rs, ...remainingRunSummaries } = state.composer.activeRunSummaryBySession;
  const { [sp]: _dt, ...remainingDraftText } = state.composer.draftTextBySession;
  const { [sp]: _fc, ...remainingFileChanges } = state.fileChanges.bySession;
  const { [sp]: _fce, ...remainingFileChangesExpanded } = state.fileChanges.expandedBySession;
  const { [sp]: _rfr, ...remainingReadFilePaths } = state.fileChanges.readFilePathsBySession;
  const { [sp]: _psq, ...remainingPendingSendQueue } = state.pending.sendQueueBySession;
  const { [sp]: _brq, ...remainingBackendReadyQueue } = state.pending.backendReadyQueueBySession;
  const { [sp]: _pp, ...remainingPrepass } = state.pending.prepassBySession;

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

  // ── Tab arrays (removeTabs: close the tab) ──
  const nextOpenTabPaths = removeTabs
    ? removeFromArray(state.sessions.openTabPaths, sp)
    : state.sessions.openTabPaths;
  const nextPinnedPaths = removeTabs
    ? removeFromArray(state.sessions.pinnedTabPaths, sp)
    : state.sessions.pinnedTabPaths;
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
  const effects: Effect[] =
    hadBackendReadyEntries && backendReadyQueueNowEmpty
      ? [{ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' }]
      : [];

  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: remainingTranscripts,
        systemPromptsBySession: remainingSystemPrompts,
        windowBySession: remainingWindows,
        editingMessageIdBySession: remainingEditing,
        pagingInFlightBySession: remainingPagingInFlight,
      },
      sessions: {
        ...state.sessions,
        sessions: nextSessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedPaths,
        runningSessionPaths: nextRunningPaths,
        unreadFinishedSessionPaths: nextUnreadPaths,
        activeSessionPath: nextActivePath,
        analyticsFactorsBySession: remainingAnalytics,
        interruptInFlightBySession: remainingInterrupts,
        retryStatusBySession: remainingRetryStatus,
      },
      settings: {
        ...state.settings,
        availableModelsBySession: remainingModels,
        contextUsageBySession: remainingContext,
        showOutcomeDialogBySession: remainingOutcome,
        pendingExtensionUIRequestsBySession: remainingExtUI,
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
      pending: {
        ...state.pending,
        ops: remainingOps,
        promoted: remainingPromoted,
        currentTurnBySession: remainingTurns,
        messageIdAlias: remainingMessageIdAlias,
        requestIdToLocalId: remainingRequestIdToLocalId,
        setModelByCorrId: remainingSetModel,
        sendQueueBySession: remainingPendingSendQueue,
        backendReadyQueueBySession: remainingBackendReadyQueue,
        prepassBySession: remainingPrepass,
      },
    },
    effects,
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
  const activeTurnMessageId = transcript[transcript.length - 1]?.id;
  const culled = cullTranscriptWindowAroundActiveTurn({
    transcript,
    transcriptWindow,
    activeTurnMessageId,
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
   *  follow-up until `QueuedDelivered` promotes it. */
  status: ChatMessage['status'] = 'completed',
  /** Host-side synthetic-send tag (e.g. `'deferred-trigger'` for the wake-up
   *  message). Set on the optimistic message so the webview can differentiate
   *  it from a typed user message. Not persisted by the backend; re-derived
   *  from the text prefix on reload by `mapUserMessage`. */
  customType?: string,
  customDetails?: unknown,
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