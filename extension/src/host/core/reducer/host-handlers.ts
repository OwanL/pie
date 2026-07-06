import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type {
  BackendReadyChangedEvent,
  BackendReadyWatchdogFiredEvent,
  PruningSettingsChangedEvent,
  ToolResultPruningSettingsChangedEvent,
  ProxySettingsChangedEvent,
  WorkspaceCwdChangedEvent,
  TranscriptPageLoadedEvent,
  TranscriptTrimmedEvent,
  AvailableExtensionsChangedEvent,
  AssistantMessageErrorStampedEvent,
} from '../events.js';
import type { ReducerResult } from './helpers.js';
import type { Effect } from '../effects.js';
import { removeMessage } from './helpers.js';
import type { PruningMode } from '../../../shared/protocol.js';

export function handleBackendReadyChanged(
  state: ArchState,
  event: BackendReadyChangedEvent,
): ReducerResult {
  if (!event.ready) {
    return {
      state: { ...state, settings: { ...state.settings, backendReady: false } },
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
  const nextState = {
    ...state,
    settings: { ...state.settings, backendReady: true },
    pending: {
      ...state.pending,
      backendReadyQueueBySession: {},
    },
  };

  const effects: Effect[] = [];
  if (hasEntries) {
    effects.push({ kind: 'DrainBackendReadyQueue', corrId: 'drain:backendReady', entries: allEntries });
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

  const timeoutSec = 30;
  const nextState = produce(state, (draft) => {
    for (const entry of allEntries) {
      removeMessage(draft, entry.sessionPath, entry.localId);
    }
    draft.pending.backendReadyQueueBySession = {};
    draft.settings.notice = `Backend did not become ready within ${timeoutSec}s. ${allEntries.length} queued message${allEntries.length === 1 ? '' : 's'} dropped — please retry.`;
    draft.settings.noticeKind = null;
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

export function handleProxySettingsChanged(
  state: ArchState,
  event: ProxySettingsChangedEvent,
): ReducerResult {
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        proxySettings: event.proxySettings,
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

export function handleAssistantMessageErrorStamped(
  state: ArchState,
  event: AssistantMessageErrorStampedEvent,
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
