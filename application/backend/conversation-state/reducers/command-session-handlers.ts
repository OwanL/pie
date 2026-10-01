import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ModelInfo, SessionSummary } from '../../../lib/protocol/index.js';
import type { ReducerResult } from './helpers.js';
import { evictSession, removeFromArray } from './helpers.js';
import { getNextVisibleTabPathOnClose, moveOpenTabPath, insertTabRespectingPinnedPrefix, cleanPinnedTabGroups } from '../../../frontend/session-tabs/tab-behavior.js';
import { isPendingTabPath } from '../../../../lib/session-path.js';
import {
  activeInterruptOperation,
  retrySessionOperation,
  settleSessionOperationCancelled,
  startSessionOperation,
} from '../operation-registry.js';
import type { SessionOperation } from '../operation-types.js';

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

function operationIdentityForSession(state: ArchState, sessionPath: string, backendGeneration: number) {
  const summary = state.sessions.sessions.find((candidate) => candidate.path === sessionPath);
  const branchId = state.transcript.sessionUsageBySession?.[sessionPath]?.branchId;
  const settlement = state.sessions.settlementGenerationBySession[sessionPath];
  return {
    ...(summary?.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(settlement?.backendGeneration === backendGeneration
      ? { workerGeneration: settlement.workerGeneration } : {}),
  };
}

function startCloseOperation(
  state: ArchState,
  cmd: Extract<Command, { kind: 'CloseSession' }>,
  mode: NonNullable<SessionOperation['closeMode']>,
  causalParentOperationId?: string,
  privacyMode = mode === 'private-cleanup',
  waitForCreate = false,
): SessionOperation | undefined {
  if (!cmd.operationId) return undefined;
  const backendGeneration = cmd.backendGeneration ?? 0;
  const operation = startSessionOperation({
    operationId: cmd.operationId,
    kind: 'session.close',
    source: cmd.operationSource ?? { kind: 'host' },
    pendingPath: cmd.sessionPath,
    selectionToken: cmd.corrId,
    parentOperationId: cmd.causalParentOperationId ?? causalParentOperationId,
    backendGeneration,
    attempt: cmd.operationAttempt ?? 1,
    ...operationIdentityForSession(state, cmd.sessionPath, backendGeneration),
  });
  return {
    ...operation,
    phase: 'awaiting-commit',
    acceptance: 'accepted',
    closeMode: mode,
    ...(cmd.closeRequestKey ? { closeRequestKey: cmd.closeRequestKey } : {}),
    ...(cmd.closeRequestKey && cmd.selfHandoffRequired === true
      ? { closeSelfHandoffRequired: true } : {}),
    ...(privacyMode ? { closePrivacyMode: true } : {}),
    ...(waitForCreate ? { closeWaitForCreate: true } : {}),
    acknowledgements: {
      ...(mode === 'stop-cleanup'
        ? { 'persist-tabs': 'pending' as const, cleanup: 'pending' as const, stop: 'pending' as const }
        : { 'persist-tabs': 'pending' as const, cleanup: 'pending' as const }),
      ...(privacyMode ? { 'privacy-marker-removal': 'pending' as const } : {}),
      ...(cmd.closeRequestKey && cmd.selfHandoffRequired === true
        ? { 'caller-response': 'pending' as const } : {}),
    },
  };
}

export function handleOpenSession(state: ArchState, cmd: Extract<Command, { kind: 'OpenSession' }>): ReducerResult {
  const { sessionPath, placeholderSummary, selectionToken } = cmd;
  const backendGeneration = cmd.backendGeneration ?? 0;
  if (cmd.operationId && state.operations[cmd.operationId]) return { state, effects: [] };
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
    operations: cmd.operationId
      ? {
          ...state.operations,
          [cmd.operationId]: startSessionOperation({
            operationId: cmd.operationId,
            kind: 'session.open',
            source: cmd.operationSource ?? { kind: 'host' },
            pendingPath: sessionPath,
            selectionToken,
            parentOperationId: cmd.causalParentOperationId,
            backendGeneration,
            attempt: cmd.operationAttempt ?? 1,
            ...operationIdentityForSession(state, sessionPath, backendGeneration),
          }),
        }
      : state.operations,
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
      {
        kind: 'OpenSession', corrId: cmd.corrId, sessionPath, selectionToken,
        ...(cmd.operationId ? {
          operationId: cmd.operationId,
          operationAttempt: cmd.operationAttempt ?? 1,
          backendGeneration,
        } : {}),
      },
    ],
  };
}

export function handleCreateSession(state: ArchState, cmd: Extract<Command, { kind: 'CreateSession' }>): ReducerResult {
  const { sessionPath, cwd, placeholderSummary, selectionToken, operationId } = cmd;
  const existingOperation = operationId ? state.operations[operationId] : undefined;
  const backendGeneration = cmd.backendGeneration ?? existingOperation?.backendGeneration ?? 0;
  if (existingOperation && operationId) {
    const retriedOperation = retrySessionOperation(existingOperation, {
      kind: 'session.create',
      pendingPath: sessionPath,
      selectionToken,
      backendGeneration,
      cwd,
      attempt: cmd.operationAttempt,
    });
    if (!retriedOperation) return { state, effects: [] };
    const nextState = {
      ...state,
      operations: { ...state.operations, [operationId]: retriedOperation },
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
      effects: [{
        kind: 'CreateSession',
        corrId: cmd.corrId,
        sessionPath,
        cwd,
        selectionToken,
        operationId,
        operationAttempt: retriedOperation.attempt,
        backendGeneration,
      }],
    };
  }
  if (operationId && cmd.operationAttempt !== undefined && cmd.operationAttempt !== 1) {
    return { state, effects: [] };
  }
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
    operations: operationId
      ? {
          ...state.operations,
          [operationId]: startSessionOperation({
            operationId,
            kind: 'session.create',
            source: cmd.operationSource ?? { kind: 'host' },
            pendingPath: sessionPath,
            selectionToken,
            parentOperationId: cmd.causalParentOperationId,
            backendGeneration,
            attempt: cmd.operationAttempt ?? 1,
            cwd,
          }),
        }
      : state.operations,
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
      { kind: 'CreateSession', corrId: cmd.corrId, sessionPath, cwd, selectionToken, ...(operationId ? { operationId, operationAttempt: cmd.operationAttempt ?? 1, backendGeneration } : {}) },
    ],
  };
}

export function handleRestartBackend(state: ArchState, cmd: Extract<Command, { kind: 'RestartBackend' }>): ReducerResult {
  const activeRestart = Object.values(state.operations).find((operation) =>
    operation.kind === 'backend.restart' && !operation.terminal,
  );
  if (activeRestart || state.operations[cmd.operationId]) return { state, effects: [] };
  const operation = {
    ...startSessionOperation({
      operationId: cmd.operationId,
      kind: 'backend.restart',
      source: cmd.operationSource,
      pendingPath: '',
      selectionToken: '',
      parentOperationId: cmd.causalParentOperationId,
      backendGeneration: cmd.backendGeneration,
    }),
    phase: 'draining' as const,
    acceptance: 'accepted' as const,
  };
  return {
    state: {
      ...state,
      operations: { ...state.operations, [operation.operationId]: operation },
      settings: { ...state.settings, backendReady: false },
    },
    effects: [{
      kind: 'RestartBackend',
      corrId: cmd.corrId,
      operationId: operation.operationId,
      backendGeneration: operation.backendGeneration,
    }],
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
  // Production callers already supply operation identity. The deterministic
  // fallback keeps older host command producers on the same safe close path.
  const closeCommand = cmd.operationId
    ? cmd
    : { ...cmd, operationId: `session.close:${cmd.corrId}`, operationAttempt: cmd.operationAttempt ?? 1 };
  const { sessionPath } = closeCommand;
  const closeOperationId = closeCommand.operationId!;
  const privacyMode = closeCommand.privacyMode === true
    || state.sessions.privacyModeBySession[sessionPath] === true;
  const selfHandoffRequired = closeCommand.closeRequestKey !== undefined
    && closeCommand.selfHandoffRequired === true;
  if (state.operations[closeOperationId]) return { state, effects: [] };
  const pendingCreate = Object.values(state.operations)
    .find((operation) => (operation.kind === 'session.create' || operation.kind === 'session.duplicate')
      && operation.session.pendingPath === sessionPath && !operation.terminal);
  if (pendingCreate) {
    // A pending create has no durable runtime to stop yet. Cancel queued work
    // and remove its UI state now, retain the create tombstone, then clean up a
    // late durable creation before the close operation can settle.
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
    const closeOperation = startCloseOperation(
      state,
      closeCommand,
      privacyMode ? 'private-cleanup' : 'idle-cleanup',
      pendingCreate.operationId,
      privacyMode,
      true,
    );
    const pendingCloseOperation = closeOperation ? {
      ...closeOperation,
      closeNextPath: nextPath,
      closeSelectionChanged: wasActive,
    } : undefined;
    // Ingress-fixed bridge acceptance precedes the deferred lifecycle. Only a
    // self-close adds the response-delivery barrier; a foreign close continues
    // as soon as this pending create resolves.
    const acceptedAckEffect = closeCommand.closeRequestKey ? [{
      kind: 'SessionCloseBridgeAck' as const,
      corrId: closeCommand.corrId,
      sessionPath,
      requestKey: closeCommand.closeRequestKey,
      phase: 'accepted' as const,
    }] : [];
    const evicted = evictSession(state, sessionPath, { removeSummary: false, removeTabs: true });
    const operations = { ...evicted.state.operations };
    for (const operation of Object.values(state.operations)) {
      if (operation.kind !== 'message.send' || operation.terminal
        || (operation.session.resolvedPath ?? operation.session.pendingPath) !== sessionPath) continue;
      const cancelled = settleSessionOperationCancelled(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: operation.backendGeneration,
        outcome: 'cancelled',
        reason: 'queue-cleared',
      });
      if (cancelled) operations[operation.operationId] = cancelled;
    }
    operations[pendingCreate.operationId] = {
      ...pendingCreate,
      hidden: true,
      ...(pendingCloseOperation ? { closeOperationId: pendingCloseOperation.operationId } : {}),
    };
    if (pendingCloseOperation) operations[pendingCloseOperation.operationId] = pendingCloseOperation;
    const nextState = {
      ...evicted.state,
      sessions: {
        ...evicted.state.sessions,
        ...(privacyMode ? {
          privacyModeBySession: { ...evicted.state.sessions.privacyModeBySession, [sessionPath]: true },
        } : {}),
        activeSessionPath: wasActive ? (nextPath ?? null) : state.sessions.activeSessionPath,
      },
      operations,
    };
    return {
      state: nextState,
      effects: [
        ...acceptedAckEffect,
        ...evicted.effects,
        {
          kind: 'PersistTabs',
          corrId: closeCommand.corrId,
          operationId: pendingCloseOperation?.operationId,
          backendGeneration: pendingCloseOperation?.backendGeneration,
          openTabPaths: nextOpenTabPaths,
          activeSessionPath: nextState.sessions.activeSessionPath,
          pinnedTabPaths: nextPinnedTabPaths,
          pinnedTabGroups: nextPinnedTabGroups,
          ...(privacyMode ? {
            privateSessionPaths: [...new Set([
              sessionPath,
              ...Object.entries(nextState.sessions.privacyModeBySession)
                .filter(([, enabled]) => enabled)
                .map(([privatePath]) => privatePath),
            ])],
          } : {}),
        },
      ],
    };
  }
  const hiddenLiveTarget = state.sessions.intentionallyHiddenRunningPaths.includes(sessionPath)
    && state.sessions.runningSessionPaths.includes(sessionPath)
    && !Object.values(state.operations).some((operation) =>
      operation.kind === 'session.close' && !operation.terminal
      && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath);
  if (!state.sessions.openTabPaths.includes(sessionPath) && !hiddenLiveTarget) {
    if (cmd.closeRequestKey) {
      // A retained summary is only historical membership, not cleanup evidence.
      // A no-tab close is complete only when the reducer retained a fully
      // successful prior close barrier for this exact target, and the target
      // has not acquired newer live/pending state since then.
      const targetHasLiveState = state.sessions.runningSessionPaths.includes(sessionPath)
        || state.sessions.intentionallyHiddenRunningPaths.includes(sessionPath)
        || Object.values(state.operations).some((operation) =>
          !operation.terminal
          && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath,
        );
      const confirmedPriorClose = Object.values(state.operations).some((operation) =>
        operation.kind === 'session.close'
        && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath
        && operation.phase === 'settled'
        && operation.commit === 'committed'
        && operation.terminal?.outcome === 'settled'
        && operation.terminal.reason === 'durable-commit-observed'
        && operation.acknowledgements !== undefined
        && operation.acknowledgements.cleanup === 'succeeded'
        && Object.values(operation.acknowledgements).every((acknowledgement) => acknowledgement === 'succeeded'),
      );
      // The accepted acknowledgement still precedes the terminal report so a
      // self-close observes `close requested`, never `already closed`.
      return {
        state,
        effects: [
          {
            kind: 'SessionCloseBridgeAck',
            corrId: cmd.corrId,
            sessionPath,
            requestKey: cmd.closeRequestKey,
            phase: 'accepted',
          },
          {
            kind: 'SessionCloseBridgeAck',
            corrId: cmd.corrId,
            sessionPath,
            requestKey: cmd.closeRequestKey,
            phase: confirmedPriorClose && !targetHasLiveState ? 'completed' : 'unknown',
          },
        ],
      };
    }
    return { state, effects: [] };
  }
  // Compute the successor before the tab disappears, but keep all session data
  // intact until host cleanup succeeds. A failed close can then restore the tab
  // without refocusing it or requiring a lossy rehydration.
  const nextPath = getNextVisibleTabPathOnClose({
    closingPath: sessionPath,
    openTabPaths: state.sessions.openTabPaths,
    sessions: state.sessions.sessions,
    workspaceCwd: state.sessions.workspaceCwd,
    activeSessionPath: state.sessions.activeSessionPath,
  });
  const wasActive = state.sessions.activeSessionPath === sessionPath;
  const nextActivePath = wasActive ? (nextPath ?? null) : state.sessions.activeSessionPath;
  const nextOpenTabPaths = state.sessions.openTabPaths.filter((path) => path !== sessionPath);
  const nextPinnedTabPaths = state.sessions.pinnedTabPaths.filter((path) => path !== sessionPath);
  const nextPinnedTabGroups = cleanPinnedTabGroups(state.sessions.pinnedTabGroups, nextPinnedTabPaths);

  if (state.sessions.runningSessionPaths.includes(sessionPath)) {
    // UI, tool, and private closes share one stop/cleanup barrier. The only
    // difference for private targets is that successful cleanup forgets the
    // durable session instead of retaining it for reopening.
    const closeOperation = startCloseOperation(state, closeCommand, 'stop-cleanup', undefined, privacyMode);
    const competingStop = activeInterruptOperation(state.operations, sessionPath);
    const abortSendCorrIds = Object.entries(state.pending.ops)
      .filter(([, pending]) => pending.kind === 'send' && pending.sessionPath === sessionPath)
      .map(([corrId]) => corrId);
    const cancelQueuedOperationIds = Object.values(state.operations)
      .filter((candidate) => candidate.kind === 'message.edit' && !candidate.terminal
        && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === sessionPath)
      .map((candidate) => candidate.operationId);
    const usePriorityLane = Object.values(state.operations).some((candidate) =>
      !candidate.terminal
      && candidate.kind !== 'message.send'
      && candidate.kind !== 'message.interrupt'
      && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === sessionPath,
    );
    const stopOperation = competingStop ?? (closeOperation
      ? startSessionOperation({
          operationId: `${closeOperation.operationId}:stop`,
          kind: 'message.interrupt',
          source: closeCommand.operationSource ?? { kind: 'host' },
          pendingPath: sessionPath,
          selectionToken: closeCommand.corrId,
          backendGeneration: closeOperation.backendGeneration,
          attempt: 1,
          intentFingerprint: JSON.stringify({ kind: 'message.interrupt', sessionPath }),
        })
      : undefined);
    const operations = {
      ...state.operations,
      ...(closeOperation ? {
        [closeOperation.operationId]: {
          ...closeOperation,
          closeStopOperationId: stopOperation?.operationId,
          closeStopDispatched: !selfHandoffRequired || !!competingStop,
          ...(abortSendCorrIds.length > 0 ? { closeStopAbortSendCorrIds: abortSendCorrIds } : {}),
          ...(cancelQueuedOperationIds.length > 0 ? { closeStopCancelQueuedOperationIds: cancelQueuedOperationIds } : {}),
          ...(usePriorityLane ? { closeStopUsePriorityLane: true } : {}),
          closeNextPath: nextPath,
          closeSelectionChanged: wasActive,
        },
      } : {}),
      ...(stopOperation ? { [stopOperation.operationId]: stopOperation } : {}),
    };
    const nextState = {
      ...state,
      operations,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedTabPaths,
        pinnedTabGroups: nextPinnedTabGroups,
        unreadFinishedSessionPaths: removeFromArray(state.sessions.unreadFinishedSessionPaths, sessionPath),
        intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
        activeSessionPath: nextActivePath,
      },
    };
    return {
      state: nextState,
      effects: [
        {
          kind: 'PersistTabs',
          corrId: closeCommand.corrId,
          ...(closeOperation ? { operationId: closeOperation.operationId, backendGeneration: closeOperation.backendGeneration } : {}),
          openTabPaths: nextOpenTabPaths,
          activeSessionPath: nextActivePath,
          pinnedTabPaths: nextPinnedTabPaths,
          pinnedTabGroups: nextPinnedTabGroups,
          ...(privacyMode ? {
            privateSessionPaths: [...new Set([
              sessionPath,
              ...Object.entries(nextState.sessions.privacyModeBySession)
                .filter(([, enabled]) => enabled)
                .map(([privatePath]) => privatePath),
            ])],
          } : {}),
        },
        ...(closeCommand.closeRequestKey ? [{
          kind: 'SessionCloseBridgeAck' as const,
          corrId: closeCommand.corrId,
          sessionPath,
          requestKey: closeCommand.closeRequestKey,
          phase: 'accepted' as const,
        }] : []),
        ...(stopOperation && !competingStop && !selfHandoffRequired
          ? [{
              kind: 'InterruptRpc' as const,
              corrId: closeCommand.corrId,
              operationId: stopOperation.operationId,
              operationAttempt: 1,
              backendGeneration: stopOperation.backendGeneration,
              sessionPath,
              ...(abortSendCorrIds.length > 0 ? { abortSendCorrIds } : {}),
              ...(cancelQueuedOperationIds.length > 0 ? { cancelQueuedOperationIds } : {}),
              ...(usePriorityLane ? { usePriorityLane: true } : {}),
            }]
          : []),
        ...(wasActive && nextActivePath && !isPendingTabPath(nextActivePath)
          ? [{
              kind: 'NotifySessionViewed' as const,
              corrId: closeCommand.corrId,
              sessionPath: nextActivePath,
              previousSessionPath: sessionPath,
            }]
          : []),
      ],
    };
  }

  const closeOperation = startCloseOperation(
    state,
    closeCommand,
    privacyMode ? 'private-cleanup' : 'idle-cleanup',
    undefined,
    privacyMode,
  );
  const nextCloseOperation = closeOperation ? {
    ...closeOperation,
    closeNextPath: nextPath,
    closeSelectionChanged: wasActive,
    closeCleanupDispatched: !selfHandoffRequired,
  } : undefined;
  const nextState = {
    ...state,
    operations: nextCloseOperation
      ? { ...state.operations, [nextCloseOperation.operationId]: nextCloseOperation }
      : state.operations,
    sessions: {
      ...state.sessions,
      openTabPaths: nextOpenTabPaths,
      pinnedTabPaths: nextPinnedTabPaths,
      pinnedTabGroups: nextPinnedTabGroups,
      unreadFinishedSessionPaths: removeFromArray(state.sessions.unreadFinishedSessionPaths, sessionPath),
      intentionallyHiddenRunningPaths: removeFromArray(state.sessions.intentionallyHiddenRunningPaths, sessionPath),
      activeSessionPath: nextActivePath,
    },
  };
  // Self-close cleanup stays deferred until coordinator response delivery;
  // foreign agent closes and ordinary UI closes proceed without that handoff.
  const agentCloseAcceptedEffects = closeCommand.closeRequestKey ? [{
    kind: 'SessionCloseBridgeAck' as const,
    corrId: closeCommand.corrId,
    sessionPath,
    requestKey: closeCommand.closeRequestKey,
    phase: 'accepted' as const,
  }] : [];
  return {
    state: nextState,
    effects: [
      ...agentCloseAcceptedEffects,
      {
        kind: 'PersistTabs',
        corrId: closeCommand.corrId,
        ...(nextCloseOperation ? { operationId: nextCloseOperation.operationId, backendGeneration: nextCloseOperation.backendGeneration } : {}),
        openTabPaths: nextState.sessions.openTabPaths,
        activeSessionPath: nextActivePath,
        pinnedTabPaths: nextState.sessions.pinnedTabPaths,
        pinnedTabGroups: nextState.sessions.pinnedTabGroups,
        // Keep the marker durable until the backend forget succeeds.
        privateSessionPaths: privacyMode
          ? [...new Set([
              sessionPath,
              ...Object.entries(nextState.sessions.privacyModeBySession)
                .filter(([, enabled]) => enabled)
                .map(([privatePath]) => privatePath),
            ])]
          : undefined,
      },
      ...(!selfHandoffRequired ? [{
        kind: 'CloseSession' as const, corrId: closeCommand.corrId, sessionPath, nextPath, privacyMode, selectionChanged: wasActive,
        ...(nextCloseOperation ? { operationId: nextCloseOperation.operationId, backendGeneration: nextCloseOperation.backendGeneration } : {}),
      }] : []),
      ...(wasActive && nextActivePath && !isPendingTabPath(nextActivePath)
        ? [{
            kind: 'NotifySessionViewed' as const,
            corrId: closeCommand.corrId,
            sessionPath: nextActivePath,
            previousSessionPath: sessionPath,
          }]
        : []),
    ],
  };
}

export function handleDuplicateSession(state: ArchState, cmd: Extract<Command, { kind: 'DuplicateSession' }>): ReducerResult {
  const { sessionPath, sourceSessionPath, placeholderSummary, selectionToken, operationId } = cmd;
  const existingOperation = operationId ? state.operations[operationId] : undefined;
  const backendGeneration = cmd.backendGeneration ?? existingOperation?.backendGeneration ?? 0;
  if (existingOperation && operationId) {
    const retriedOperation = retrySessionOperation(existingOperation, {
      kind: 'session.duplicate',
      pendingPath: sessionPath,
      sourcePath: sourceSessionPath,
      selectionToken,
      backendGeneration,
      attempt: cmd.operationAttempt,
    });
    if (!retriedOperation) return { state, effects: [] };
    const nextState = {
      ...state,
      operations: { ...state.operations, [operationId]: retriedOperation },
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
      effects: [{
        kind: 'DuplicateSession',
        corrId: cmd.corrId,
        sessionPath,
        sourceSessionPath,
        selectionToken,
        operationId,
        operationAttempt: retriedOperation.attempt,
        backendGeneration,
      }],
    };
  }
  if (operationId && cmd.operationAttempt !== undefined && cmd.operationAttempt !== 1) {
    return { state, effects: [] };
  }
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
    operations: operationId
      ? {
          ...state.operations,
          [operationId]: startSessionOperation({
            operationId,
            kind: 'session.duplicate',
            source: cmd.operationSource ?? { kind: 'host' },
            pendingPath: sessionPath,
            sourcePath: sourceSessionPath,
            selectionToken,
            parentOperationId: cmd.causalParentOperationId,
            backendGeneration,
            attempt: cmd.operationAttempt ?? 1,
            // For duplicate operations these fields identify the source
            // snapshot. The destination identity arrives only at commit.
            ...operationIdentityForSession(state, sourceSessionPath, backendGeneration),
          }),
        }
      : state.operations,
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
      { kind: 'DuplicateSession', corrId: cmd.corrId, sessionPath, sourceSessionPath, selectionToken, ...(operationId ? { operationId, operationAttempt: cmd.operationAttempt ?? 1, backendGeneration } : {}) },
    ],
  };
}

export function handleMoveSessionTab(state: ArchState, cmd: Extract<Command, { kind: 'MoveSessionTab' }>): ReducerResult {
  // The reducer owns the reorder. The
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
