/**
 * Top-level reducer: `(state, event) → {state, effects}`.
 *
 * The reducer is **pure**: no I/O, no globals, no mutation of input.
 * Effects are queued descriptively; the `EffectRunner` executes them and
 * dispatches result events back.
 *
 * Transcript mutations use Immer's `produce` so that mutation-style helpers
 * (appendAssistantTextPart, upsertAssistantToolCall, etc.) can operate on
 * the draft directly. Simple field updates continue using spread-operator
 * patterns.
 *
 * **State-shape rule (binding):** keyed collections in `ArchState` MUST use
 * `Record<string, T>` — never `Map`/`Set`. RTK + Immer reject mutating those
 * built-ins without an explicit `enableMapSet()` opt-in; treat that opt-in as
 * a deliberate decision, not a default.
 */

import { handleDictationEvent, reconcileDictation } from './reducers/dictation-handlers.js';
import { handleProviderManagement } from './reducers/provider-management-handlers.js';
import { createInitialArchState } from './arch-state.js';
import type { ArchState } from './arch-state.js';
import type { Event } from './events.js';
import { reduceSessionSnooze, canSnoozeSession, snoozeEffects } from './session-snooze.js';

// Re-export for downstream consumers that import from './reducer'
export type { ArchState, PendingOp, CurrentTurn } from './arch-state.js';
export { createInitialArchState } from './arch-state.js';

/** Reducer result using the real Effect type from effects.ts. */
export type ReducerResult = import('./reducers/helpers.js').ReducerResult;

/** Pre-created initial state for convenience. */
const initialArchState: ArchState = createInitialArchState();
export { initialArchState };

// Handler modules
import { handleCommand } from './reducers/command-handlers.js';
import { handleEffectResult, handleModelSwitchConfirmResult, handlePreflightFailed, handlePreflightSuperseded, handleClearQueueResult, handleReplaceQueueResult, handleMcpServersUpdated, handleMcpSessionServersUpdated } from './reducers/result-handlers.js';
import { handleStreamingEvent, handleQueuedDelivered, handleAssistantMessageErrorStamped } from './reducers/streaming-handlers.js';
import {
  handleSessionClosed,
  handleSessionListChanged,
  handleSessionOpened,
  handleSessionPromptInventory,
  handleSessionNameDerived,
  handleAgentSettled,
  handleBusyChanged,
  handleBusyCompleted,
  handleCompactionStarted,
  handleCompactionEnded,
  handleLastCompactionCleared,
  handleContextUsageChanged,
  handleSessionMetadataChanged,
  handleRunningSessionsChanged,
  handleRetryStarted,
  handleRetryEnded,
  handleUnreadFinishedSessionsChanged,
  handleSessionSummaryUpserted,
  handleSessionSummariesReplaced,
  handleSessionScopeCleared,
  handlePendingPathReplaced,
  handleSendOperationDelayed,
  handleSendOperationStatus,
  handleMessageOperationDelayed,
  handleMessageOperationStatus,
  handleCreateOperationDelayed,
  handleCreateOperationSucceeded,
  handleCreateOperationFailed,
  handleTabOpened,
  handleOpenTabsChanged,
  handleSessionsInterrupted,
} from './reducers/session-handlers.js';
import {
  handleBackendReadyChanged,
  handleBackendReadyWatchdogFired,
  handlePruningSettingsChanged,
  handleSessionTitlesSettingsChanged,
  handleToolResultPruningSettingsChanged,
  handleWorkspaceCwdChanged,
  handleTranscriptPageLoaded,
  handleTranscriptTrimmed,
  handleAvailableExtensionsChanged,
} from './reducers/host-handlers.js';
import {
  handleAgentMessageReceived,
  handleAgentMessageRejected,
  handleOptimisticMessageInserted,
  handleOptimisticMessageRemoved,
} from './reducers/optimistic-handlers.js';
import {
  handleCustomMessage,
  handleExtensionUIRequest,
  handleError,
  handleIncidentReported,
  handleNoticeShown,
  handlePendingExtensionUIRequestsCleared,
} from './reducers/ui-handlers.js';
import {
  handleTruncateResult,
  handleCreateSessionResult,
  handleDuplicateSessionResult,
  handleOpenSessionResult,
  handleOpenSessionReconciliationDue,
  handleCloseSessionResult,
  handleSessionCloseResponseDelivered,
  handlePersistTabsResult,
  handleBackendRestartDrainCompleted,
  handleBackendRestartOldGenerationDied,
  handleBackendRestartResult,
} from './reducers/misc-handlers.js';
import { handleAvailableModelsChanged, handleAvailableModelsHydrationFailed, handleModelSettingsHydrated } from './reducers/set-model-handlers.js';
import { handleFileChangesUpdated } from './reducers/file-handlers.js';
import {
  handleTurnSemanticEvent,
  handleLiveLifecycleWatermark,
  handleLiveTurnCheckpointResult,
} from './reducers/live-pipeline-handlers.js';
import {
  handleActiveRunSummaryChanged,
  handleComposerInputsReplaced,
} from './reducers/composer-handlers.js';

/**
 * Reducer: routes events to per-kind handlers.
 */
export function reducer(state: ArchState, event: Event): ReducerResult {
  return reconcileDictation(state, reduceOrdinary(state, event), event);
}

function reduceOrdinary(state: ArchState, event: Event): ReducerResult {
  if (event.kind === 'ProviderManagementSnapshotUpdated' || event.kind === 'ProviderManagementResult') return handleProviderManagement(state, event);
  if (event.kind === 'Command' && (event.cmd.kind === 'ProviderManagement' || event.cmd.kind === 'ProviderManagementConnect' || event.cmd.kind === 'ProviderManagementAuthResponse')) return handleProviderManagement(state, event.cmd);
  if (event.kind === 'SessionSnoozeReleaseResult') {
    const owner = state.sessions.snoozeReleases[event.reservationId];
    if (!owner || owner.sessionPath !== event.sessionPath) return { state, effects: [] };
    if (!event.ok) return handleNoticeShown(state, { kind: 'NoticeShown',
      notice: 'Could not restore session admission. Restart the backend to retry safely.', sessionPath: event.sessionPath });
    const snoozeReleases = { ...state.sessions.snoozeReleases };
    delete snoozeReleases[event.reservationId];
    const remaining = Object.values(snoozeReleases).find((release) => release.sessionPath === event.sessionPath);
    // A path can own multiple releases (superseded reservations). Hydration
    // waits for all matching acknowledgements, retaining its ingress token.
    if (remaining && owner.deferredOpens?.length) snoozeReleases[remaining.reservationId] = {
      ...remaining, deferredOpens: [...(remaining.deferredOpens ?? []), ...owner.deferredOpens],
    };
    const next = { ...state, sessions: { ...state.sessions, snoozeReleases } };
    const result = state.settings.noticeSessionPath === event.sessionPath
      && state.settings.notice === 'Could not restore session admission. Restart the backend to retry safely.'
      && !Object.values(snoozeReleases).some((release) => release.sessionPath === event.sessionPath)
      ? handleNoticeShown(next, { kind: 'NoticeShown', notice: null })
      : { state: next, effects: [] };
    return { ...result, effects: [...result.effects, ...(remaining ? [] : owner.deferredOpens ?? [])] };
  }
  const addressedCommand = event.kind === 'Command' ? event.cmd : null;
  if (addressedCommand && 'sessionPath' in addressedCommand
    && Object.values(state.sessions.snoozeReleases).some((release) => release.sessionPath === addressedCommand.sessionPath)
    && !['SelectSession', 'OpenSession', 'Interrupt'].includes(addressedCommand.kind)) return handleNoticeShown(state, {
      kind: 'NoticeShown', notice: 'Session admission is still being restored. Wait, or restart the backend if restoration failed.',
    });
  const releases: ReducerResult['effects'] = [];
  const pendingSnoozes = { ...state.sessions.pendingSnoozes };
  const command = event.kind === 'Command' ? event.cmd : null;
  for (const [path, pending] of Object.entries(pendingSnoozes)) {
    if (command && (('sessionPath' in command && command.sessionPath === path)
      || command.kind === 'SelectSession' || command.kind === 'OpenSession' || command.kind === 'RestartBackend')) {
      delete pendingSnoozes[path];
      releases.push({ kind: 'ReleaseSessionSnooze', corrId: pending.reservationId, sessionPath: path, reservationId: pending.reservationId });
    }
  }
  if (releases.length) state = { ...state, sessions: { ...state.sessions, pendingSnoozes } };
  let result = reduceSnoozeAware(state, event);
  if (event.kind === 'BackendReadyChanged') {
    if (event.ready && !state.settings.backendReady) {
      const p = result.state.providerManagement;
      const generation = event.backendGeneration ?? p.generation + 1;
      const operationId = `provider-startup:${generation}`;
      const refreshFence = p.refreshFence + 1;
      result = { state: { ...result.state, providerManagement: { ...p, generation, refreshFence, operationId, authOperationId: null,
        snapshot: { ...p.snapshot, revision: -1, auth: undefined }, status: p.draft ? 'idle' : 'loading' } }, effects: [...result.effects,
        { kind: 'ProviderManagementRpc', request: { type: 'read', operationId }, generation, fence: refreshFence, selectedId: p.selectedId }] };
    } else if (!event.ready) {
      const p = result.state.providerManagement;
      result = { ...result, state: { ...result.state, providerManagement: { ...p, refreshFence: p.refreshFence + 1, operationId: null, authOperationId: null, status: 'idle' } } };
    }
  }
  const pendingAfter = { ...result.state.sessions.pendingSnoozes };
  for (const [path, pending] of Object.entries(pendingAfter)) {
    if (!canSnoozeSession(result.state, path)) {
      delete pendingAfter[path];
      releases.push({ kind: 'ReleaseSessionSnooze', corrId: pending.reservationId, sessionPath: path, reservationId: pending.reservationId });
    }
  }
  const effects = [...releases, ...result.effects];
  const snoozeReleases = { ...result.state.sessions.snoozeReleases };
  if (event.kind === 'BackendReadyChanged' && event.ready) {
    for (const release of Object.values(snoozeReleases)) effects.push({ kind: 'ReleaseSessionSnooze', corrId: release.reservationId,
      sessionPath: release.sessionPath, reservationId: release.reservationId });
  }
  for (const effect of effects) if (effect.kind === 'ReleaseSessionSnooze') {
    snoozeReleases[effect.reservationId] = { ...snoozeReleases[effect.reservationId], sessionPath: effect.sessionPath, reservationId: effect.reservationId };
  }
  let deferred = false;
  const admittedEffects = effects.filter((effect) => {
    if (effect.kind !== 'OpenSession') return true;
    const owner = Object.values(snoozeReleases).find((release) => release.sessionPath === effect.sessionPath);
    if (!owner) return true;
    deferred = true;
    snoozeReleases[owner.reservationId] = { ...owner, deferredOpens: [...(owner.deferredOpens ?? []), effect] };
    return false;
  });
  if (!deferred && !effects.some((effect) => effect.kind === 'ReleaseSessionSnooze') && !releases.length) return result;
  return { state: { ...result.state, sessions: { ...result.state.sessions, pendingSnoozes: pendingAfter, snoozeReleases } }, effects: admittedEffects };
}

function reduceSnoozeAware(state: ArchState, event: Event): ReducerResult {
  let restoredEffects: ReducerResult['effects'] = [];
  if (event.kind === 'BusyChanged' && event.running && state.sessions.snoozedBySession[event.sessionPath]) {
    const restored = reduceSessionSnooze(state, { kind: 'SessionSnoozeRestoreRequested', sessionPath: event.sessionPath });
    state = restored.state;
    restoredEffects = restored.effects;
  }
  if (event.kind === 'Command' && event.cmd.kind === 'OpenSession' && state.sessions.snoozedBySession[event.cmd.sessionPath]) {
    const restored = reduceSessionSnooze(state, { kind: 'SessionSnoozeRestoreRequested', sessionPath: event.cmd.sessionPath });
    state = restored.state;
    restoredEffects = restored.effects;
  }
  if (event.kind === 'Command' && event.cmd.kind === 'CloseSession') {
    const entry = state.sessions.snoozedBySession[event.cmd.sessionPath];
    if (entry) {
      const snoozedBySession = { ...state.sessions.snoozedBySession };
      delete snoozedBySession[entry.path];
      state = { ...state, sessions: { ...state.sessions, snoozedBySession } };
      restoredEffects = snoozeEffects(state);
      if (entry.reservationId) restoredEffects.push({ kind: 'ReleaseSessionSnooze', corrId: entry.reservationId,
        sessionPath: entry.path, reservationId: entry.reservationId });
    }
  }
  const addressed = event.kind === 'Command' ? event.cmd : event;
  if ('sessionPath' in addressed && typeof addressed.sessionPath === 'string' && state.sessions.snoozedBySession[addressed.sessionPath]
    && event.kind !== 'SessionSnoozeRestoreRequested' && event.kind !== 'SessionSnoozeRequested'
    && event.kind !== 'SessionSnoozeReservationResult') return { state, effects: [] };
  const result = reduceWithNotices(state, event);
  const snoozes = result.state.sessions.snoozedBySession;
  const sessions = result.state.sessions;
  const filteredOpen = sessions.openTabPaths.filter((p) => !snoozes[p]);
  const filteredPinned = sessions.pinnedTabPaths.filter((p) => !snoozes[p]);
  const activeHidden = sessions.activeSessionPath !== null && !!snoozes[sessions.activeSessionPath];
  const next = filteredOpen.length === sessions.openTabPaths.length && filteredPinned.length === sessions.pinnedTabPaths.length && !activeHidden ? result.state : {
    ...result.state, sessions: { ...sessions, openTabPaths: filteredOpen, pinnedTabPaths: filteredPinned,
      pinnedTabGroups: sessions.pinnedTabGroups.map((g) => g.filter((p) => !snoozes[p])).filter((g) => g.length >= 2),
      activeSessionPath: activeHidden ? null : sessions.activeSessionPath },
  };
  return { state: next, effects: [...restoredEffects, ...result.effects].map((effect) => effect.kind === 'PersistTabs'
    ? { ...effect, openTabPaths: effect.openTabPaths.filter((p) => !snoozes[p]),
      activeSessionPath: effect.activeSessionPath && snoozes[effect.activeSessionPath] ? null : effect.activeSessionPath,
      pinnedTabPaths: effect.pinnedTabPaths.filter((p) => !snoozes[p]),
      pinnedTabGroups: effect.pinnedTabGroups.map((g) => g.filter((p) => !snoozes[p])).filter((g) => g.length >= 2),
      snoozedBySession: snoozes } : effect) };
}

function reduceWithNotices(state: ArchState, event: Event): ReducerResult {
  if (event.kind === 'PersistTabsResult' && event.corrId === 'session-snooze' && !event.ok) return handleNoticeShown(state, {
    kind: 'NoticeShown', notice: 'Could not save session snooze state. It may not survive a host restart.',
  });
  const result = reduceEvent(state, event);
  const next = result.state;
  const owner = next.settings.noticeSessionPath;
  // Edit acknowledgements and semantic boundaries can arrive after bounded
  // status polling exhausted. Retire only the unchanged warning for a
  // reconciling edit on its owning session, never a newer/unrelated notice.
  const editDelayNotice = 'Edit acknowledgement delayed. Pie is reconciling this operation; do not retry it.';
  const editExhaustedNotice = 'Pie could not confirm whether this edit operation settled. Restart the backend to reconcile safely.';
  const editNoticeResolved = next.operations !== state.operations && owner
    && next.settings.notice === state.settings.notice
    && next.settings.noticeSessionPath === state.settings.noticeSessionPath
    && (next.settings.notice === editDelayNotice || next.settings.notice === editExhaustedNotice)
    && Object.values(next.operations).some((operation) => {
      const previous = state.operations[operation.operationId];
      return operation.kind === 'message.edit' && previous && previous !== operation && !previous.terminal
        && previous.reconciliation !== undefined
        && (operation.session.pendingPath === owner || operation.session.resolvedPath === owner)
        && (operation.terminal || (operation.acceptance === 'accepted'
          && (next.settings.notice === editDelayNotice || operation.commit === 'committed')));
    })
    && !Object.values(next.operations).some((operation) => operation.kind === 'message.edit'
      && !operation.terminal
      && (operation.phase === 'ambiguous'
        || (next.settings.notice === editExhaustedNotice && operation.commit !== 'committed'))
      && (operation.session.pendingPath === owner || operation.session.resolvedPath === owner));
  // Send status polling is only one of several commit boundaries. Semantic
  // start, recovered checkpoints, queue delivery, and generation death also
  // settle the registry; none may leave a reconciliation warning behind.
  if (editNoticeResolved || (next.operations !== state.operations && owner
    && (next.settings.notice?.startsWith('Send acknowledgement delayed.')
      || next.settings.notice?.startsWith('Pie could not confirm whether this send committed.'))
    && !Object.values(next.operations).some((operation) => operation.kind === 'message.send'
      && !operation.terminal
      && (operation.session.pendingPath === owner || operation.session.resolvedPath === owner)))) {
    return {
      ...result,
      state: {
        ...next,
        settings: {
          ...next.settings, notice: null, noticeKind: null, noticeRaw: null, noticeSessionPath: null,
        },
      },
    };
  }
  return result;
}

function reduceEvent(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'DictationAvailabilityChanged':
    case 'DictationObserved':
    case 'DictationRendererInvalidated':
      return handleDictationEvent(state, event);
    case 'SessionSnoozeReleaseResult':
    case 'SessionSnoozeRequested':
    case 'SessionSnoozeReservationResult':
    case 'SessionSnoozeRestoreRequested':
    case 'SessionSnoozeTimerFired':
    case 'SessionSnoozesRestored':
      return reduceSessionSnooze(state, event);
    case 'Command': {
      const cmd = event.cmd;
      if (cmd.kind === 'ProviderManagement' || cmd.kind === 'ProviderManagementConnect' || cmd.kind === 'ProviderManagementAuthResponse') return handleProviderManagement(state, cmd);
      if ((cmd.kind === 'Send' || cmd.kind === 'Edit' || cmd.kind === 'Continue' || cmd.kind === 'Compact')
        && state.transcript.pendingPromptInventoryBySession?.[cmd.sessionPath]) {
        const pending = { ...state.transcript.pendingPromptInventoryBySession };
        delete pending[cmd.sessionPath];
        state = { ...state, transcript: { ...state.transcript, pendingPromptInventoryBySession: pending } };
      }
      return handleCommand(state, cmd);
    }

    // ─── Effect result events ─────────────────────────────────────────

    case 'ContinueResult':
    case 'InterruptResult':
    case 'CompactResult':
    case 'SendResult':
    case 'EditResult':
    case 'FileDiffResult':
    case 'FileRevertResult':
    case 'SetModelResult':
    case 'SetPrefsResult':
    case 'SessionControlSettingsResult':
    case 'LoadOlderTranscriptResult':
    case 'LoadNewerTranscriptResult':
    case 'JumpToLatestTranscriptResult':
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
    case 'SetToolResultPruningSettingsResult':
    case 'SetSessionTitlesSettingsResult':
    case 'SessionTitleResult':
    case 'ExtensionUiResponseResult': {
      return handleEffectResult(state, event);
    }

    case 'ClearQueueResult': {
      return handleClearQueueResult(state, event);
    }

    case 'ReplaceQueueResult': {
      return handleReplaceQueueResult(state, event);
    }

    case 'LiveTurnCheckpointResult': {
      return handleLiveTurnCheckpointResult(state, event);
    }

    // ─── Backend streaming events ─────────────────────────────────────────

    case 'TurnSemanticEventReceived': {
      return handleTurnSemanticEvent(state, event);
    }

    case 'LiveLifecycleWatermarkReceived': {
      return handleLiveLifecycleWatermark(state, event);
    }

    case 'MessageStarted':
    case 'MessageAborted':
    case 'MessageDelta':
    case 'MessageThinking':
    case 'ToolCall':
    case 'MessageFinished': {
      return handleStreamingEvent(state, event);
    }

    case 'QueuedDelivered': {
      return handleQueuedDelivered(state, event);
    }

    case 'AgentMessageReceived': {
      return handleAgentMessageReceived(state, event);
    }

    case 'AgentMessageRejected': {
      return handleAgentMessageRejected(state, event);
    }

    // ─── Session lifecycle events ─────────────────────────────────────────

    case 'SessionClosed': {
      return handleSessionClosed(state, event);
    }

    case 'SessionNameDerived': {
      return handleSessionNameDerived(state, event);
    }

    case 'SessionPromptInventory':
      return handleSessionPromptInventory(state, event);
    case 'SessionOpened': {
      // Kept inline for now (matches handleSessionOpened in session-handlers)
      return handleSessionOpened(state, event);
    }

    case 'AgentSettled': {
      return handleAgentSettled(state, event);
    }

    case 'BusyChanged': {
      return handleBusyChanged(state, event);
    }

    case 'BusyCompleted': {
      return handleBusyCompleted(state, event);
    }

    case 'CompactionStarted': {
      return handleCompactionStarted(state, event);
    }

    case 'CompactionEnded': {
      return handleCompactionEnded(state, event);
    }

    case 'LastCompactionCleared': {
      return handleLastCompactionCleared(state, event);
    }

    case 'ContextUsageChanged': {
      return handleContextUsageChanged(state, event);
    }

    case 'SessionListChanged': {
      return handleSessionListChanged(state, event);
    }

    // ─── Host events ───────────────────────────────────────────────────────

    case 'BackendReadyChanged': {
      return handleBackendReadyChanged(state, event);
    }
    case 'BackendReadyWatchdogFired': {
      return handleBackendReadyWatchdogFired(state, event);
    }

    case 'PruningSettingsChanged': {
      return handlePruningSettingsChanged(state, event);
    }

    case 'SessionTitlesSettingsChanged': {
      return handleSessionTitlesSettingsChanged(state, event);
    }

    case 'ToolResultPruningSettingsChanged': {
      return handleToolResultPruningSettingsChanged(state, event);
    }

    case 'WorkspaceCwdChanged': {
      return handleWorkspaceCwdChanged(state, event);
    }

    case 'TranscriptPageLoaded': {
      return handleTranscriptPageLoaded(state, event);
    }

    case 'FileChangesUpdated': {
      return handleFileChangesUpdated(state, event);
    }

    case 'ActiveRunSummaryChanged': {
      return handleActiveRunSummaryChanged(state, event);
    }

    case 'SessionMetadataChanged': {
      return handleSessionMetadataChanged(state, event);
    }

    case 'AvailableModelsChanged': {
      return handleAvailableModelsChanged(state, event);
    }

    case 'AvailableModelsHydrationFailed': {
      return handleAvailableModelsHydrationFailed(state, event);
    }

    case 'ModelSettingsHydrated': {
      return handleModelSettingsHydrated(state, event);
    }

    case 'PendingExtensionUIRequestsCleared': {
      return handlePendingExtensionUIRequestsCleared(state, event);
    }

    case 'AvailableExtensionsChanged': {
      return handleAvailableExtensionsChanged(state, event);
    }

    case 'AssistantMessageErrorStamped': {
      return handleAssistantMessageErrorStamped(state, event);
    }

    case 'ComposerInputsReplaced': {
      return handleComposerInputsReplaced(state, event);
    }

    case 'PendingPathReplaced': {
      return handlePendingPathReplaced(state, event);
    }

    case 'SendOperationDelayed': {
      return handleSendOperationDelayed(state, event);
    }
    case 'SendOperationStatus': {
      return handleSendOperationStatus(state, event);
    }
    case 'MessageOperationDelayed': {
      return handleMessageOperationDelayed(state, event);
    }
    case 'MessageOperationStatus': {
      return handleMessageOperationStatus(state, event);
    }
    case 'CreateOperationDelayed': {
      return handleCreateOperationDelayed(state, event);
    }
    case 'CreateOperationSucceeded': {
      return handleCreateOperationSucceeded(state, event);
    }
    case 'CreateOperationFailed': {
      return handleCreateOperationFailed(state, event);
    }

    case 'TranscriptTrimmed': {
      return handleTranscriptTrimmed(state, event);
    }

    case 'RunningSessionsChanged': {
      return handleRunningSessionsChanged(state, event);
    }

    case 'RetryStarted': {
      return handleRetryStarted(state, event);
    }

    case 'RetryEnded': {
      return handleRetryEnded(state, event);
    }

    case 'SessionsInterrupted': {
      return handleSessionsInterrupted(state, event);
    }

    case 'UnreadFinishedSessionsChanged': {
      return handleUnreadFinishedSessionsChanged(state, event);
    }

    case 'SessionSummaryUpserted': {
      return handleSessionSummaryUpserted(state, event);
    }

    case 'SessionSummariesReplaced': {
      return handleSessionSummariesReplaced(state, event);
    }

    case 'SessionScopeCleared': {
      return handleSessionScopeCleared(state, event);
    }

    case 'TabOpened': {
      return handleTabOpened(state, event);
    }

    case 'OpenTabsChanged': {
      return handleOpenTabsChanged(state, event);
    }

    case 'PreflightFailed': {
      return handlePreflightFailed(state, event);
    }

    case 'PreflightSuperseded': {
      return handlePreflightSuperseded(state, event);
    }

    // ─── UI events ─────────────────────────────────────────────────────────

    case 'CustomMessage': {
      return handleCustomMessage(state, event);
    }

    case 'ExtensionUIRequest': {
      return handleExtensionUIRequest(state, event);
    }

    case 'IncidentReported': {
      return handleIncidentReported(state, event);
    }

    case 'Error': {
      return handleError(state, event);
    }

    case 'NoticeShown': {
      return handleNoticeShown(state, event);
    }

    case 'McpServersUpdated': {
      return handleMcpServersUpdated(state, event);
    }

    case 'McpSessionServersUpdated': {
      return handleMcpSessionServersUpdated(state, event);
    }

    // ─── Optimistic UI events ──────────────────────────────────────────────

    case 'OptimisticMessageInserted': {
      return handleOptimisticMessageInserted(state, event);
    }

    case 'OptimisticMessageRemoved': {
      return handleOptimisticMessageRemoved(state, event);
    }

    // ─── Result stubs ──────────────────────────────────────────────────────

    case 'TruncateResult': {
      return handleTruncateResult(state, event);
    }

    case 'CreateSessionResult': {
      return handleCreateSessionResult(state, event);
    }

    case 'DuplicateSessionResult': {
      return handleDuplicateSessionResult(state, event);
    }

    case 'CloseSessionResult': {
      return handleCloseSessionResult(state, event);
    }

    case 'SessionCloseResponseDelivered': {
      return handleSessionCloseResponseDelivered(state, event);
    }

    case 'OpenSessionResult': {
      return handleOpenSessionResult(state, event);
    }

    case 'OpenSessionReconciliationDue': {
      return handleOpenSessionReconciliationDue(state, event);
    }

    case 'PersistTabsResult': {
      return handlePersistTabsResult(state, event);
    }

    case 'BackendRestartDrainCompleted': {
      return handleBackendRestartDrainCompleted(state, event);
    }

    case 'BackendRestartOldGenerationDied': {
      return handleBackendRestartOldGenerationDied(state, event);
    }

    case 'ProviderManagementSnapshotUpdated':
    case 'ProviderManagementResult':
      return handleProviderManagement(state, event);

    case 'BackendRestartResult': {
      return handleBackendRestartResult(state, event);
    }

    case 'ModelSwitchConfirmResult': {
      return handleModelSwitchConfirmResult(state, event);
    }

    default: {
      // Exhaustiveness: the switch is total over `Event`. If this branch is
      // reached, an Event kind is unhandled above — the `never` assignment
      // turns that into a compile-time error so adding a new Event variant
      // without a handler fails the build. At runtime we fail loud
      // (error-level log) rather than silently dropping the event, but we do
      // not throw so one malformed event cannot take down a streaming session.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `reducer: unhandled event kind (type system bypassed?): ${(event as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}
