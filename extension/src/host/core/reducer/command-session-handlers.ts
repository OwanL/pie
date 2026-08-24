import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ModelInfo, SessionSummary } from '../../../shared/protocol.js';
import type { ReducerResult } from './helpers.js';
import { evictSession, removeFromArray, addToArray } from './helpers.js';
import { getNextVisibleTabPathOnClose, moveOpenTabPath, insertTabRespectingPinnedPrefix, cleanPinnedTabGroups, isPendingTabPath } from '../../../shared/tab-behavior.js';

/** Seed a pending picker from the last catalog known to the host. A duplicate
 * prefers its real predecessor; a new session prefers the active real tab and
 * then any configured/session catalog still in memory. The selected model's
 * provider-qualified metadata is merged back in when the chosen catalog is
 * stale or filtered, so reasoning controls do not flash to a non-reasoning
 * fallback while the durable target is unresolved. */
function provisionalCatalogForSession(
  state: ArchState,
  placeholderSummary: SessionSummary,
  predecessorPath?: string,
): ModelInfo[] {
  const catalogs = Object.entries(state.settings.availableModelsBySession)
    .filter(([path, models]) => !isPendingTabPath(path) && models.length > 0);
  const activePath = state.sessions.activeSessionPath;
  const preferredPaths = [predecessorPath, activePath].filter(
    (path): path is string => !!path && !isPendingTabPath(path),
  );
  const preferred = preferredPaths
    .map((path) => state.settings.availableModelsBySession[path])
    .find((models): models is ModelInfo[] => !!models && models.length > 0);
  const base = preferred ?? catalogs[0]?.[1] ?? [];
  const predecessor = preferredPaths
    .map((path) => state.sessions.sessions.find((session) => session.path === path))
    .find((session): session is NonNullable<typeof session> => !!session);
  const selectedModelId = placeholderSummary.modelId
    ?? predecessor?.modelId
    ?? state.settings.modelSettings?.defaultModel;
  const selectedProvider = placeholderSummary.provider
    ?? predecessor?.provider
    ?? state.settings.modelSettings?.defaultProvider;
  if (!selectedModelId) return [...base];

  const knownModels = catalogs.flatMap(([, models]) => models);
  const selectedKnown = selectedProvider
    ? knownModels.find((model) => model.id === selectedModelId && model.provider === selectedProvider)
    : knownModels.find((model) => model.id === selectedModelId);
  if (!selectedKnown || base.some((model) => model.id === selectedKnown.id && model.provider === selectedKnown.provider)) {
    return [...base];
  }
  return [...base, selectedKnown];
}

function seedProvisionalModelCatalog(
  state: ArchState,
  sessionPath: string,
  placeholderSummary: SessionSummary,
  predecessorPath?: string,
): ArchState['settings'] {
  const existingModels = state.settings.availableModelsBySession[sessionPath];
  const existingStatus = state.settings.availableModelsStatusBySession[sessionPath];
  if ((existingModels?.length ?? 0) > 0 || existingStatus === 'authoritative') {
    return state.settings;
  }
  return {
    ...state.settings,
    availableModelsBySession: {
      ...state.settings.availableModelsBySession,
      [sessionPath]: provisionalCatalogForSession(state, placeholderSummary, predecessorPath),
    },
    availableModelsStatusBySession: {
      ...state.settings.availableModelsStatusBySession,
      [sessionPath]: 'provisional',
    },
  };
}

export function handleOpenSession(state: ArchState, cmd: Extract<Command, { kind: 'OpenSession' }>): ReducerResult {
  const { sessionPath, placeholderSummary, selectionToken } = cmd;
  // Optimistic tab setup — was imperative dispatchArch calls in the service
  // (SessionSummaryUpserted placeholder + TabOpened + SelectSession +
  // saveOpenTabs). The reducer now owns these purely; the runner only does
  // the backend session.open RPC + the host-local selection machinery.
  // Mirrors CreateSession, but deliberately does NOT touch
  // runningSessionPaths or the active-run summary: opening an existing tab
  // must not stop an in-flight run or drop its summary (the opened session
  // may be running — a brand-new session cannot, which is why CreateSession
  // filters the pending path out of running + clears its run summary).
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const nextSessions = alreadySummarized || !placeholderSummary
    ? sessions
    : [placeholderSummary, ...sessions];
  const nextOpenTabPaths = insertTabRespectingPinnedPrefix(
    state.sessions.openTabPaths,
    state.sessions.pinnedTabPaths,
    sessionPath,
  );
  const catalogSummary = placeholderSummary
    ?? state.sessions.sessions.find((summary) => summary.path === sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
      intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
    },
    settings: catalogSummary
      ? seedProvisionalModelCatalog(state, sessionPath, catalogSummary, state.sessions.activeSessionPath ?? undefined)
      : state.settings,
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath, pinnedTabPaths: state.sessions.pinnedTabPaths, pinnedTabGroups: state.sessions.pinnedTabGroups },
      { kind: 'OpenSession', corrId: cmd.corrId, sessionPath, selectionToken },
    ],
  };
}

export function handleCreateSession(state: ArchState, cmd: Extract<Command, { kind: 'CreateSession' }>): ReducerResult {
  const { sessionPath, cwd, placeholderSummary, selectionToken, operationId } = cmd;
  const existingOperation = operationId ? state.pending.createOperations[operationId] : undefined;
  if (existingOperation?.status === 'delayed-awaiting-outcome'
    && existingOperation.pendingPath === sessionPath
    && existingOperation.selectionToken === selectionToken) {
    const nextState = {
      ...state,
      pending: {
        ...state.pending,
        createOperations: {
          ...state.pending.createOperations,
          [operationId!]: { ...existingOperation, status: 'pending' as const, attempt: existingOperation.attempt + 1 },
        },
      },
      sessions: existingOperation.hidden
        ? state.sessions
        : {
            ...state.sessions,
            sessions: state.sessions.sessions.map((summary) => summary.path === sessionPath
              ? { ...summary, creationState: 'pending' as const, createOperationId: operationId }
              : summary),
          },
    };
    return {
      state: nextState,
      effects: [{ kind: 'CreateSession', corrId: cmd.corrId, sessionPath, cwd, selectionToken, ...(operationId ? { operationId, operationAttempt: existingOperation.attempt + 1 } : {}) }],
    };
  }
  if (existingOperation?.status === 'succeeded') return { state, effects: [] };
  // Optimistic tab setup — was imperative dispatchArch calls in the
  // service (SessionSummaryUpserted + TabOpened + SelectSession +
  // RunningSessionsChanged + ActiveRunSummaryChanged(null) + saveOpenTabs).
  // The reducer now owns these transitions purely; the runner only does the
  // backend session.create RPC + the host-local selection machinery.
  //
  // Semantics mirror the event handlers: placeholder summary is unshifted
  // (handleSessionSummaryUpserted), the tab is appended if not already open
  // (handleTabOpened), the session is selected (SelectSession), it's ensured
  // not running, and its active-run summary is cleared. PersistTabs replaces
  // the old saveOpenTabs() call.
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const pendingSummary = operationId
    ? { ...placeholderSummary, creationState: 'pending' as const, createOperationId: operationId }
    : placeholderSummary;
  const nextSessions = alreadySummarized
    ? sessions
    : [pendingSummary, ...sessions];
  const nextOpenTabPaths = state.sessions.openTabPaths.includes(sessionPath)
    ? state.sessions.openTabPaths
    : [...state.sessions.openTabPaths, sessionPath];
  const nextRunningPaths = state.sessions.runningSessionPaths.filter((p) => p !== sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      runningSessionPaths: nextRunningPaths,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
      intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
    },
    settings: seedProvisionalModelCatalog(state, sessionPath, placeholderSummary),
    pending: {
      ...state.pending,
      createOperations: operationId
        ? {
            ...state.pending.createOperations,
            [operationId]: {
              operationId,
              kind: 'create' as const,
              pendingPath: sessionPath,
              selectionToken,
              status: 'pending' as const,
              attempt: 1,
              cwd,
            },
          }
        : state.pending.createOperations,
    },
    composer: {
      ...state.composer,
      activeRunSummaryBySession: {
        ...state.composer.activeRunSummaryBySession,
        [sessionPath]: null,
      },
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath, pinnedTabPaths: state.sessions.pinnedTabPaths, pinnedTabGroups: state.sessions.pinnedTabGroups },
      { kind: 'CreateSession', corrId: cmd.corrId, sessionPath, cwd, selectionToken, ...(operationId ? { operationId, operationAttempt: 1 } : {}) },
    ],
  };
}

export function handleSelectSession(state: ArchState, cmd: Extract<Command, { kind: 'SelectSession' }>): ReducerResult {
  const sessionPath = cmd.sessionPath || null;
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        activeSessionPath: sessionPath,
        unreadFinishedSessionPaths: removeFromArray(
          state.sessions.unreadFinishedSessionPaths,
          cmd.sessionPath,
        ),
      },
    },
    effects: [],
  };
}

export function handleCloseSession(state: ArchState, cmd: Extract<Command, { kind: 'CloseSession' }>): ReducerResult {
  const { sessionPath } = cmd;
  const pendingCreate = Object.values(state.pending.createOperations)
    .find((operation) => operation.pendingPath === sessionPath
      && (operation.status === 'pending' || operation.status === 'delayed-awaiting-outcome'));
  if (pendingCreate) {
    // Hiding a delayed create is not definitive cancellation. Keep the ledger,
    // queued sends, and selection request alive so a late matching opened event
    // can resolve the hidden operation without reopening or focusing it.
    const nextOpenTabPaths = state.sessions.openTabPaths.filter((path) => path !== sessionPath);
    const nextPinnedTabPaths = state.sessions.pinnedTabPaths.filter((path) => path !== sessionPath);
    const nextPinnedTabGroups = cleanPinnedTabGroups(state.sessions.pinnedTabGroups, nextPinnedTabPaths);
    const wasActive = state.sessions.activeSessionPath === sessionPath;
    const nextPath = wasActive
      ? getNextVisibleTabPathOnClose({
          closingPath: sessionPath,
          openTabPaths: state.sessions.openTabPaths,
          sessions: state.sessions.sessions,
          workspaceCwd: state.sessions.workspaceCwd,
          activeSessionPath: state.sessions.activeSessionPath,
        })
      : state.sessions.activeSessionPath;
    const nextState = {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedTabPaths,
        pinnedTabGroups: nextPinnedTabGroups,
        activeSessionPath: wasActive ? (nextPath ?? null) : state.sessions.activeSessionPath,
      },
      pending: {
        ...state.pending,
        createOperations: {
          ...state.pending.createOperations,
          [pendingCreate.operationId]: { ...pendingCreate, hidden: true },
        },
      },
    };
    return {
      state: nextState,
      effects: [{
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: nextOpenTabPaths,
        activeSessionPath: nextState.sessions.activeSessionPath,
        pinnedTabPaths: nextPinnedTabPaths,
        pinnedTabGroups: nextPinnedTabGroups,
      }],
    };
  }
  // A repeated or delayed user close for a tab that is already hidden is a
  // no-op. Explicit outbox retries are different: after a crash or failed
  // terminal append the durable action may still be pending while the tab is
  // already hidden. Re-run idempotent persistence and (for idle sessions)
  // host cleanup so success is backed by fresh authoritative effect results.
  if (!state.sessions.openTabPaths.includes(sessionPath)) {
    if (!cmd.ensureClosed) return { state, effects: [] };
    const persistEffect = {
      kind: 'PersistTabs' as const,
      corrId: cmd.corrId,
      openTabPaths: state.sessions.openTabPaths,
      activeSessionPath: state.sessions.activeSessionPath,
      pinnedTabPaths: state.sessions.pinnedTabPaths,
      pinnedTabGroups: state.sessions.pinnedTabGroups,
    };
    if (state.sessions.runningSessionPaths.includes(sessionPath)) {
      // A review-closure retry may land here after a crash left the tab already
      // hidden. Re-mark it so the ready handshake still won't resurrect it.
      if (!cmd.reviewClosure) return { state, effects: [persistEffect] };
      return {
        state: {
          ...state,
          sessions: {
            ...state.sessions,
            intentionallyHiddenRunningPaths: addToArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
          },
        },
        effects: [persistEffect],
      };
    }
    return {
      state,
      effects: [
        persistEffect,
        { kind: 'CloseSession', corrId: cmd.corrId, sessionPath, nextPath: null },
      ],
    };
  }
  // The reducer owns the tab-close + per-session map clearing +
  // select-next-tab; the runner owns the host-side cleanup
  // (clearSelectionRequestsForPath, onSessionClosed, clearSessionScope,
  // evict) + the recursive openSession(nextPath) when nextPath is not yet
  // summarized. Mirrors the create/open/duplicate pattern but with a key
  // difference: there is NO backend RPC for close — the Effect is a
  // host-side cleanup descriptor, not a backend-RPC descriptor.
  //
  // DIFFERENCE from the pre-migration code: the old CloseSession handler
  // called `removeSessionFromState` (full eviction: removed the summary,
  // runningPaths, nulled activeSessionPath) BEFORE the runner's fat
  // `service.closeSession()` could read the original activeSessionPath,
  // so the next-tab selection was silently skipped (latent double-
  // execution bug). The new handler computes nextPath FIRST (from the
  // pre-close state), does the close + select-next, and passes nextPath
  // to the runner via the Effect.
  //
  // Unlike create/duplicate (which target a NEW pending path → clear
  // runningSessionPaths + activeRunSummaryBySession for the pending path),
  // closeSession REMOVES a tab → mirror SessionScopeCleared{removeSession-
  // Summary:false} (clear per-session maps but keep the summary for
  // reopening, do NOT touch runningSessionPaths — the session may still be
  // running in the backend even if its tab is closed). `evictSession` with
  // `removeSummary:false` preserves both the summary and the running marker;
  // `removeTabs:true` strips the tab arrays + nulls activeSessionPath (which
  // the post-eviction override below re-points at the next tab).
  const nextPath = getNextVisibleTabPathOnClose({
    closingPath: sessionPath,
    openTabPaths: state.sessions.openTabPaths,
    sessions: state.sessions.sessions,
    workspaceCwd: state.sessions.workspaceCwd,
    activeSessionPath: state.sessions.activeSessionPath,
  });
  const wasActive = state.sessions.activeSessionPath === sessionPath;
  const nextActivePath = wasActive ? (nextPath ?? null) : state.sessions.activeSessionPath;
  const privacyMode = state.sessions.privacyModeBySession[sessionPath] === true;

  if (state.sessions.runningSessionPaths.includes(sessionPath) && !privacyMode) {
    // Closing a running tab means hide, not teardown. Preserve transcript,
    // live-pipeline, pending ownership, composer inputs, file changes, and run
    // analytics while the backend continues. A later webview ready handshake
    // restores only running tabs whose absence was accidental; users can also
    // reopen an intentionally hidden session from the session list.
    const nextOpenTabPaths = state.sessions.openTabPaths.filter((path) => path !== sessionPath);
    const nextPinnedTabPaths = state.sessions.pinnedTabPaths.filter((path) => path !== sessionPath);
    const nextPinnedTabGroups = cleanPinnedTabGroups(state.sessions.pinnedTabGroups, nextPinnedTabPaths);
    const nextIntentionallyHiddenRunningPaths = addToArray(
      state.sessions.intentionallyHiddenRunningPaths,
      sessionPath,
    );
    const nextState = {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedTabPaths,
        pinnedTabGroups: nextPinnedTabGroups,
        activeSessionPath: nextActivePath,
        intentionallyHiddenRunningPaths: nextIntentionallyHiddenRunningPaths,
      },
    };
    return {
      state: nextState,
      effects: [
        {
          kind: 'PersistTabs',
          corrId: cmd.corrId,
          openTabPaths: nextOpenTabPaths,
          activeSessionPath: nextActivePath,
          pinnedTabPaths: nextPinnedTabPaths,
          pinnedTabGroups: nextPinnedTabGroups,
        },
        ...(wasActive && nextActivePath && !isPendingTabPath(nextActivePath)
          ? [{
              kind: 'NotifySessionViewed' as const,
              corrId: cmd.corrId,
              sessionPath: nextActivePath,
              previousSessionPath: sessionPath,
            }]
          : []),
      ],
    };
  }

  // Private sessions are forgotten even when their turn is still running. The
  // backend forget operation retires/aborts that runtime before deleting its
  // transcript, so closing the tab cannot leave a private session recoverable.
  // Idle close performs the existing teardown. Clear per-session keyed maps +
  // drop the tab arrays while retaining the durable session summary.
  const evicted = evictSession(state, sessionPath, { removeSummary: privacyMode, removeTabs: true });
  const nextState = {
    ...evicted.state,
    sessions: {
      ...evicted.state.sessions,
      activeSessionPath: nextActivePath,
    },
  };
  return {
    state: nextState,
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: nextState.sessions.openTabPaths,
        activeSessionPath: nextActivePath,
        pinnedTabPaths: nextState.sessions.pinnedTabPaths,
        pinnedTabGroups: nextState.sessions.pinnedTabGroups,
        // Keep the marker durable until the backend forget succeeds. The
        // service reopens the tab on failure so the user can retry deletion.
        privateSessionPaths: privacyMode
          ? [...new Set([
              sessionPath,
              ...Object.entries(nextState.sessions.privacyModeBySession)
                .filter(([, enabled]) => enabled)
                .map(([privatePath]) => privatePath),
            ])]
          : undefined,
      },
      { kind: 'CloseSession', corrId: cmd.corrId, sessionPath, nextPath, privacyMode, selectionChanged: wasActive },
      ...(wasActive && nextActivePath && !isPendingTabPath(nextActivePath)
        ? [{
            kind: 'NotifySessionViewed' as const,
            corrId: cmd.corrId,
            sessionPath: nextActivePath,
            previousSessionPath: sessionPath,
          }]
        : []),
    ],
  };
}

export function handleDuplicateSession(state: ArchState, cmd: Extract<Command, { kind: 'DuplicateSession' }>): ReducerResult {
  const { sessionPath, sourceSessionPath, placeholderSummary, selectionToken, operationId } = cmd;
  const existingOperation = operationId ? state.pending.createOperations[operationId] : undefined;
  if (existingOperation?.status === 'delayed-awaiting-outcome'
    && existingOperation.pendingPath === sessionPath
    && existingOperation.selectionToken === selectionToken) {
    const nextState = {
      ...state,
      pending: {
        ...state.pending,
        createOperations: {
          ...state.pending.createOperations,
          [operationId!]: { ...existingOperation, status: 'pending' as const, attempt: existingOperation.attempt + 1 },
        },
      },
      sessions: existingOperation.hidden
        ? state.sessions
        : {
            ...state.sessions,
            sessions: state.sessions.sessions.map((summary) => summary.path === sessionPath
              ? { ...summary, creationState: 'pending' as const, createOperationId: operationId }
              : summary),
          },
    };
    return {
      state: nextState,
      effects: [{ kind: 'DuplicateSession', corrId: cmd.corrId, sessionPath, sourceSessionPath, selectionToken, ...(operationId ? { operationId, operationAttempt: existingOperation.attempt + 1 } : {}) }],
    };
  }
  if (existingOperation?.status === 'succeeded') return { state, effects: [] };
  // Optimistic tab setup — was imperative dispatchArch calls in the
  // service (SessionSummaryUpserted + TabOpened(insertAfter=source) +
  // SelectSession + RunningSessionsChanged + ActiveRunSummaryChanged(null)
  // + saveOpenTabs). The reducer now owns these transitions purely; the
  // runner only does the backend session.duplicate RPC + the host-local
  // selection machinery.
  //
  // Mirrors CreateSession (a brand-new pending session cannot be running,
  // so clear the running marker + active-run summary for the pending path —
  // NOT OpenSession, which deliberately omits those because the opened
  // session may be running). DIFFERENCE from CreateSession: the copy tab is
  // inserted ADJACENT to the source (insertAfter semantics, matching
  // handleTabOpened) rather than appended at the end, so the duplicate
  // appears next to its source in the tab bar.
  const sessions = state.sessions.sessions;
  const alreadySummarized = sessions.some((s) => s.path === sessionPath);
  const pendingSummary = operationId
    ? { ...placeholderSummary, creationState: 'pending' as const, createOperationId: operationId }
    : placeholderSummary;
  const nextSessions = alreadySummarized
    ? sessions
    : [pendingSummary, ...sessions];
  // Open the tab adjacent to the source (insertAfter), mirroring
  // handleTabOpened: if the source is open, splice right after it; else
  // append at end.
  const nextOpenTabPaths = state.sessions.openTabPaths.includes(sessionPath)
    ? state.sessions.openTabPaths
    : (() => {
      const pinnedCount = state.sessions.pinnedTabPaths.length;
      const afterIndex = state.sessions.openTabPaths.indexOf(sourceSessionPath);
      // The copy is unpinned, so it must never land inside the pinned prefix.
      // When the source is pinned, place the copy at the start of the unpinned
      // region (right after the pinned group) instead of right after the source.
      const insertAt = afterIndex === -1
        ? state.sessions.openTabPaths.length
        : Math.max(afterIndex + 1, pinnedCount);
      return [
        ...state.sessions.openTabPaths.slice(0, insertAt),
        sessionPath,
        ...state.sessions.openTabPaths.slice(insertAt),
      ];
    })();
  const nextRunningPaths = state.sessions.runningSessionPaths.filter((p) => p !== sessionPath);
  const nextState = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: nextSessions,
      openTabPaths: nextOpenTabPaths,
      activeSessionPath: sessionPath,
      runningSessionPaths: nextRunningPaths,
      unreadFinishedSessionPaths: state.sessions.unreadFinishedSessionPaths.filter((p) => p !== sessionPath),
      intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
    },
    settings: seedProvisionalModelCatalog(state, sessionPath, placeholderSummary, sourceSessionPath),
    pending: {
      ...state.pending,
      createOperations: operationId
        ? {
            ...state.pending.createOperations,
            [operationId]: {
              operationId,
              kind: 'duplicate' as const,
              pendingPath: sessionPath,
              selectionToken,
              status: 'pending' as const,
              attempt: 1,
              sourceSessionPath,
            },
          }
        : state.pending.createOperations,
    },
    composer: {
      ...state.composer,
      activeRunSummaryBySession: {
        ...state.composer.activeRunSummaryBySession,
        [sessionPath]: null,
      },
    },
  };
  return {
    state: nextState,
    effects: [
      { kind: 'PersistTabs', corrId: cmd.corrId, openTabPaths: nextOpenTabPaths, activeSessionPath: sessionPath, pinnedTabPaths: state.sessions.pinnedTabPaths, pinnedTabGroups: state.sessions.pinnedTabGroups },
      { kind: 'DuplicateSession', corrId: cmd.corrId, sessionPath, sourceSessionPath, selectionToken, ...(operationId ? { operationId, operationAttempt: 1 } : {}) },
    ],
  };
}

export function handleMoveSessionTab(state: ArchState, cmd: Extract<Command, { kind: 'MoveSessionTab' }>): ReducerResult {
  // Phase 2 send/edit-style cutover: the reducer owns the reorder. The
  // pure shared helper computes the new openTabPaths, state is updated, and
  // a PersistTabs effect is emitted so the runner writes globalState. The
  // legacy MoveSessionTab Effect / service.moveSessionTab / ReorderTabs
  // round-trip is gone.
  //
  // Pinned-zone safety net: clamp the drop index to the source tab's zone so
  // a pinned tab can never cross into the unpinned region (and vice versa).
  // The webview already constrains drops to the same zone; this guards against
  // stale indices arriving after a tab closed/inserted mid-drag. Indices are
  // relative to the array AFTER the source is removed (the final position),
  // matching the drop-gap rendering + moveOpenTabPath semantics.
  const { openTabPaths, pinnedTabPaths } = state.sessions;
  const resolvedFromIndex = cmd.sessionPath !== undefined ? openTabPaths.indexOf(cmd.sessionPath) : -1;
  const fromIndex = cmd.sessionPath !== undefined && resolvedFromIndex !== -1 ? resolvedFromIndex : cmd.fromIndex;
  const sourceIsPinned = cmd.sessionPath !== undefined
    ? pinnedTabPaths.includes(cmd.sessionPath)
    : fromIndex >= 0 && fromIndex < pinnedTabPaths.length;
  const pinnedCount = pinnedTabPaths.length;
  const pinnedFilteredCount = sourceIsPinned ? Math.max(pinnedCount - 1, 0) : pinnedCount;
  const filteredLen = Math.max(openTabPaths.length - 1, 0);
  let toIndex = cmd.toIndex;
  if (sourceIsPinned) {
    toIndex = Math.min(Math.max(toIndex, 0), pinnedFilteredCount);
  } else {
    toIndex = Math.min(Math.max(toIndex, pinnedFilteredCount), filteredLen);
  }
  const newOrder = moveOpenTabPath(openTabPaths, {
    sessionPath: cmd.sessionPath,
    fromIndex,
    toIndex,
  });
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: newOrder,
      },
    },
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: newOrder,
        activeSessionPath: state.sessions.activeSessionPath,
        pinnedTabPaths,
        pinnedTabGroups: state.sessions.pinnedTabGroups,
      },
    ],
  };
}
