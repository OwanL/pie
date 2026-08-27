import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type {
  BackendReadyChangedEvent,
  BackendReadyWatchdogFiredEvent,
  PruningSettingsChangedEvent,
  ToolResultPruningSettingsChangedEvent,
  WorkspaceCwdChangedEvent,
  TranscriptPageLoadedEvent,
  TranscriptTrimmedEvent,
  AvailableExtensionsChangedEvent,
} from '../events.js';
import { BACKEND_READY_TIMEOUT_MS } from '../../../shared/backend-ready-timeout.js';
import type { ReducerResult } from './helpers.js';
import type { Effect } from '../effects.js';
import { removeMessage } from './helpers.js';
import type { PruningMode } from '../../../shared/protocol.js';
import {
  queueDeferredSetModel,
  revertSetModel,
  sessionHasDeferredModelWrite,
  startNextDeferredSetModel,
} from './set-model-handlers.js';

export function handleBackendReadyChanged(
  state: ArchState,
  event: BackendReadyChangedEvent,
): ReducerResult {
  if (!event.ready) {
    let nextState = state;
    for (const [corrId, pending] of Object.entries(state.pending.setModelByCorrId)) {
      if (!pending.snapshot) continue;
      const clearImages = (pending.snapshot.previousPendingInputs ?? [])
        .some((input) => input.kind === 'imageBlob')
        && !(nextState.composer.pendingComposerInputsBySession[pending.sessionPath] ?? [])
          .some((input) => input.kind === 'imageBlob');
      const priorNotice = {
        notice: nextState.settings.notice,
        noticeKind: nextState.settings.noticeKind,
        noticeRaw: nextState.settings.noticeRaw,
        noticeSessionPath: nextState.settings.noticeSessionPath,
      };
      nextState = revertSetModel(nextState, corrId, 'backend unavailable');
      nextState = produce(nextState, (draft) => {
        Object.assign(draft.settings, priorNotice);
      });

      // A newer coalesced choice for this same session makes retrying the
      // interrupted intermediate write unnecessary. Otherwise place the retry
      // before every later deferred click so the global default preserves user
      // order across sessions.
      if (!nextState.pending.deferredSetModelBySession[pending.sessionPath]) {
        const oldestSequence = Math.min(
          ...Object.values(nextState.pending.deferredSetModelBySession).map((entry) => entry.sequence),
          nextState.pending.deferredSetModelSequence + 1,
        );
        nextState = queueDeferredSetModel(
          nextState,
          corrId,
          pending.sessionPath,
          pending.modelSettings,
          clearImages,
        );
        nextState = produce(nextState, (draft) => {
          const retry = draft.pending.deferredSetModelBySession[pending.sessionPath];
          if (retry) retry.sequence = oldestSequence - 1;
        });
      }
      if (nextState.pending.deferredSetModelInFlightCorrId === corrId) {
        nextState = produce(nextState, (draft) => {
          draft.pending.deferredSetModelInFlightCorrId = null;
          draft.pending.deferredSetModelInFlightSessionPath = null;
        });
      }
    }
    return {
      state: produce(nextState, (draft) => {
        draft.settings.backendReady = false;
        // Catalog progress is generation-scoped. A replacement backend will
        // publish its own incomplete/complete status; do not carry a stale
        // indexing indicator across the restart boundary.
        draft.sessions.sessionCatalogProgress = { complete: true, processed: 0, total: 0 };
      }),
      effects: [],
    };
  }

  // Backend became ready — drain the backend-ready queue. Collect all entries
  // across all sessions, clear the queue, and emit a DrainBackendReadyQueue
  // effect + CancelBackendReadyWatchdog. The runner re-dispatches each entry
  // as a Send Command (which goes through the normal path now that backendReady
  // is true) and clears the watchdog timer.
  const allEntries = Object.values(state.pending.backendReadyQueueBySession).flat();
  const hasEntries = allEntries.length > 0;
  const readyState = produce(state, (draft) => {
    draft.settings.backendReady = true;
    // A backend restart is the point where per-server MCP toggles apply
    // (the adapter re-reads config on the next session start), so the
    // pending-apply hint is no longer needed. Ignore duplicate ready events
    // from the same backend generation so they cannot clear a newer toggle.
    draft.settings.mcpPendingApply = state.settings.backendReady
      ? state.settings.mcpPendingApply
      : false;
  });
  const modelDrain = startNextDeferredSetModel(readyState);
  const releasedEntries = allEntries.filter(
    (entry) => !sessionHasDeferredModelWrite(modelDrain.state, entry.sessionPath),
  );
  const heldEntries = allEntries.filter(
    (entry) => sessionHasDeferredModelWrite(modelDrain.state, entry.sessionPath),
  );
  const nextState = produce(modelDrain.state, (draft) => {
    draft.pending.backendReadyQueueBySession = {};
    for (const entry of heldEntries) {
      (draft.pending.backendReadyQueueBySession[entry.sessionPath] ??= []).push(entry);
    }
  });

  const effects: Effect[] = [...modelDrain.effects];
  if (releasedEntries.length > 0) {
    effects.push({ kind: 'DrainBackendReadyQueue', corrId: 'drain:backendReady', entries: releasedEntries });
  }
  if (hasEntries) {
    // Backend readiness, not model replay, owns this watchdog. Deferred model
    // completion releases held sends explicitly below.
    effects.push({ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' });
  }

  return { state: nextState, effects };
}

/**
 * The 30s backend-ready watchdog fired — the backend did not become ready in
 * time. Drop all queued sends, remove their optimistic messages from the
 * transcript, and set a user-visible notice. The runner has already cleared
 * its timer reference (the setTimeout callback nulled it before dispatching).
 */
export function handleBackendReadyWatchdogFired(
  state: ArchState,
  _event: BackendReadyWatchdogFiredEvent,
): ReducerResult {
  const allEntries = Object.values(state.pending.backendReadyQueueBySession).flat();
  if (allEntries.length === 0) {
    return { state, effects: [] };
  }

  const timeoutSec = BACKEND_READY_TIMEOUT_MS / 1000;
  const nextState = produce(state, (draft) => {
    for (const entry of allEntries) {
      removeMessage(draft, entry.sessionPath, entry.localId);
    }
    draft.pending.backendReadyQueueBySession = {};
    draft.settings.notice = `Backend did not become ready within ${timeoutSec}s. ${allEntries.length} queued message${allEntries.length === 1 ? '' : 's'} dropped — please retry.`;
    draft.settings.noticeKind = null;
    draft.settings.noticeRaw = null;
    draft.settings.noticeSessionPath = null;
  });

  // Brief H: restore pruning for any dropped "retry without pruning" sends. The
  //  retry disabled pruning (mode:'off') before dispatching; if the backend
  //  never became ready the send was dropped without ever reaching the in-flight
  //  restore path (clearInFlightSend / onSendTimerFire), so pruning would be
  //  left permanently off — the exact bug the restore fixes. Emit a
  //  SetPruningSettings effect per unique captured prior mode (multiple queued
  //  retries share the user's original mode). The service applies it + mirrors
  //  the change back via PruningSettingsChanged.
  const restoreModes = new Set<PruningMode>();
  for (const entry of allEntries) {
    if (entry.priorPruningMode) restoreModes.add(entry.priorPruningMode);
  }
  const effects: Effect[] = [];
  for (const mode of restoreModes) {
    effects.push({ kind: 'SetPruningSettings', corrId: 'restore:pruning:watchdog', settings: { mode } });
  }

  return { state: nextState, effects };
}

export function handlePruningSettingsChanged(
  state: ArchState,
  event: PruningSettingsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pruningSettings: event.pruningSettings,
      },
    },
    effects: [],
  };
}

export function handleToolResultPruningSettingsChanged(
  state: ArchState,
  event: ToolResultPruningSettingsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        toolResultPruningSettings: event.toolResultPruningSettings,
      },
    },
    effects: [],
  };
}

export function handleWorkspaceCwdChanged(
  state: ArchState,
  event: WorkspaceCwdChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        workspaceCwd: event.workspaceCwd,
      },
    },
    effects: [],
  };
}

export function handleTranscriptPageLoaded(
  state: ArchState,
  event: TranscriptPageLoadedEvent,
): ReducerResult {
  const editingMessageId = state.transcript.editingMessageIdBySession[event.sessionPath];
  const localTranscript = state.transcript.bySession[event.sessionPath] ?? [];
  if (
    editingMessageId
    && localTranscript.some((message) => message.id === editingMessageId)
    && !event.transcript.some((message) => message.id === editingMessageId)
  ) {
    // The inline editor's live keystroke buffer is intentionally webview-local.
    // Replacing the loaded window without its row would unmount the editor and
    // destroy that buffer. Defer the latest authoritative replacement until
    // Cancel; Save discards it because the edit operation establishes a newer
    // authority of its own.
    return {
      state: {
        ...state,
        transcript: {
          ...state.transcript,
          deferredWindowReplacementBySession: {
            ...state.transcript.deferredWindowReplacementBySession,
            [event.sessionPath]: {
              transcript: event.transcript,
              transcriptWindow: event.transcriptWindow,
            },
          },
        },
      },
      effects: [],
    };
  }

  const nextDeferredWindowReplacements = {
    ...state.transcript.deferredWindowReplacementBySession,
  };
  delete nextDeferredWindowReplacements[event.sessionPath];

  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: {
          ...state.transcript.bySession,
          [event.sessionPath]: event.transcript,
        },
        windowBySession: {
          ...state.transcript.windowBySession,
          [event.sessionPath]: event.transcriptWindow,
        },
        deferredWindowReplacementBySession: nextDeferredWindowReplacements,
      },
    },
    effects: [],
  };
}

export function handleAvailableExtensionsChanged(
  state: ArchState,
  event: AvailableExtensionsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        availableExtensions: event.extensions,
      },
    },
    effects: [],
  };
}

export function handleTranscriptTrimmed(
  state: ArchState,
  event: TranscriptTrimmedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      transcript: {
        ...state.transcript,
        bySession: {
          ...state.transcript.bySession,
          [event.sessionPath]: event.transcript,
        },
        windowBySession: {
          ...state.transcript.windowBySession,
          [event.sessionPath]: event.transcriptWindow,
        },
      },
    },
    effects: [],
  };
}
