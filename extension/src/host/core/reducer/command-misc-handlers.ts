import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import { mergePruningSettings, mergeToolResultPruningSettings, mergeProxySettings, buildProxyProviderEntry, normalizeNestedAllowedBuckets, normalizeSubagentBuckets, type ChatPrefs } from '../../../shared/protocol.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, appendLocalUserMessage } from './helpers.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';

export function handleInterrupt(state: ArchState, cmd: Extract<Command, { kind: 'Interrupt' }>): ReducerResult {
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        interruptInFlightBySession: {
          ...state.sessions.interruptInFlightBySession,
          [cmd.sessionPath]: true,
        },
      },
    },
    effects: [{ kind: 'InterruptRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
  };
}

export function handleClearQueue(state: ArchState, cmd: Extract<Command, { kind: 'ClearQueue' }>): ReducerResult {
  // Steering (FollowUp): remove all optimistic 'queued' transcript messages
  // for this session and ask the backend to drop them from the SDK follow-up
  // queue (`message.clearQueue`) so they will not run later. Does NOT touch
  // `runningSessionPaths` and does NOT interrupt the current turn. Also drops
  // any `pending.ops`/`pending.promoted` entries flagged `queued` for this
  // session so a later `QueuedDelivered` cannot re-promote a cleared message.
  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[cmd.sessionPath];
    if (list) {
      draft.transcript.bySession[cmd.sessionPath] = list.filter(
        (m) => !(m.role === 'user' && m.status === 'queued'),
      );
    }
    for (const [corrId, op] of Object.entries(draft.pending.ops)) {
      if (op.queued && op.sessionPath === cmd.sessionPath) delete draft.pending.ops[corrId];
    }
    for (const [corrId, op] of Object.entries(draft.pending.promoted)) {
      if (op.queued && op.sessionPath === cmd.sessionPath) delete draft.pending.promoted[corrId];
    }
  });
  return {
    state: nextState,
    effects: [{ kind: 'ClearQueueRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath }],
  };
}

export function handleSend(state: ArchState, cmd: Extract<Command, { kind: 'Send' }>): ReducerResult {
  // If the target session is still a pending tab (backend `session.create`
  // in flight), queue the send into ArchState instead of emitting `SendRpc`.
  // The optimistic user message is still inserted immediately (the user sees
  // their message in the transcript), the draft is cleared, and the session
  // name is derived (via `SessionNameDerived` dispatched by `onSend` before
  // the Command). When `PendingPathReplaced` resolves the path, the reducer
  // emits a `DrainPendingSendQueue` effect; the runner re-dispatches each
  // entry as a `Send` Command with the resolved path, which goes through
  // the normal (non-pending) path below.
  if (isPendingTabPath(cmd.sessionPath)) {
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString(), 'completed', cmd.customType, cmd.customDetails);
      draft.pending.sendQueueBySession[cmd.sessionPath] = [
        ...(draft.pending.sendQueueBySession[cmd.sessionPath] ?? []),
        {
          corrId: cmd.corrId,
          text: cmd.text,
          inputs: cmd.inputs,
          composedText: cmd.composedText,
          localId: cmd.localId,
          userParts: cmd.userParts,
          // null — the name derivation already happened via SessionNameDerived;
          // by drain time the session has a real summary from session.opened.
          previousSummary: null,
          timestamp: cmd.timestamp,
          priorPruningMode: cmd.priorPruningMode,
        },
      ];
      delete draft.composer.draftTextBySession[cmd.sessionPath];
      // Retry clears a stale prepass 'failed' chip from a previous turn
      // (Brief F): the queued send has not been dispatched yet, so the
      // phase is idle until the queue drains and the send is promoted.
      delete draft.pending.prepassBySession[cmd.sessionPath];
    });
    return { state: nextState, effects: [] };
  }

  // If the backend is not yet ready, queue the send into ArchState instead
  // of emitting `SendRpc`. The optimistic user message is inserted
  // immediately, the draft is cleared, and a `StartBackendReadyWatchdog`
  // effect is emitted (the runner starts a 30s timer; if the backend
  // doesn't become ready in time, the watchdog fires and the reducer drops
  // the queued messages). When `BackendReadyChanged{ready:true}` fires, the
  // reducer emits a `DrainBackendReadyQueue` effect; the runner re-dispatches
  // each entry as a `Send` Command, which goes through the normal path below.
  if (!state.settings.backendReady) {
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString(), 'completed', cmd.customType, cmd.customDetails);
      draft.pending.backendReadyQueueBySession[cmd.sessionPath] = [
        ...(draft.pending.backendReadyQueueBySession[cmd.sessionPath] ?? []),
        {
          sessionPath: cmd.sessionPath,
          corrId: cmd.corrId,
          text: cmd.text,
          inputs: cmd.inputs,
          composedText: cmd.composedText,
          localId: cmd.localId,
          userParts: cmd.userParts,
          previousSummary: null,
          timestamp: cmd.timestamp,
          priorPruningMode: cmd.priorPruningMode,
        },
      ];
      delete draft.composer.draftTextBySession[cmd.sessionPath];
      // Retry clears a stale prepass 'failed' chip (Brief F): see the pending
      // tab path above for the same rationale.
      delete draft.pending.prepassBySession[cmd.sessionPath];
    });
    return {
      state: nextState,
      effects: [{ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 30_000 }],
    };
  }

  // Steering (FollowUp): a turn is already running for this session. Queue
  // the message as a follow-up (SDK `AgentSession.followUp()`) — it runs as a
  // fresh turn after the current one completes. Insert the optimistic user
  // message with status 'queued' (rendered dimmed + badged), record a
  // PendingOp flagged `queued` so the `!ok` rollback knows not to clear
  // `runningSessionPaths` (the session is still running the original turn,
  // not this queued send), and emit a `SendRpc`. The session is already in
  // `runningSessionPaths` so we do NOT re-add it. Draft + composer inputs are
  // cleared as for a normal send (captured onto the PendingOp for rollback).
  // No prepass chip is set — followUp has no pruning prepass.
  if (state.sessions.runningSessionPaths.includes(cmd.sessionPath)) {
    const inputsSnapshot = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(
        draft,
        cmd.sessionPath,
        cmd.localId,
        cmd.composedText,
        cmd.userParts,
        new Date(cmd.timestamp).toISOString(),
        'queued',
        cmd.customType,
        cmd.customDetails,
      );
      draft.pending.ops[cmd.corrId] = {
        kind: 'send',
        sessionPath: cmd.sessionPath,
        localId: cmd.localId,
        previousSummary: cmd.previousSummary,
        text: cmd.text,
        inputs: [...inputsSnapshot],
        startedAt: cmd.timestamp,
        queued: true,
      };
      delete draft.composer.draftTextBySession[cmd.sessionPath];
      delete draft.composer.pendingComposerInputsBySession[cmd.sessionPath];
    });
    return {
      state: nextState,
      effects: [
        {
          kind: 'SendRpc',
          corrId: cmd.corrId,
          sessionPath: cmd.sessionPath,
          text: cmd.text,
          inputs: cmd.inputs,
          localId: cmd.localId,
          composedText: cmd.composedText,
          userParts: cmd.userParts,
          priorPruningMode: cmd.priorPruningMode,
        },
      ],
    };
  }

  // Normal path: insert optimistic user message + mark session busy
  // immediately so the webview shows an activity indicator right away
  // (instead of waiting for the backend's agent_start event which fires
  // after the pruning prepass).
  const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
  // Snapshot the pending composer inputs onto the optimistic op so the
  // promoted rollback snapshot (after early-ack) carries them — a post-ack
  // PreflightFailed restores them to the composer host state, and Brief C
  // wires the webview `sendRejected.inputs` restore from the same payload.
  const inputsSnapshot = state.composer.pendingComposerInputsBySession[cmd.sessionPath] ?? [];
  const nextState = produce(state, (draft) => {
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString(), 'completed', cmd.customType, cmd.customDetails);
    draft.pending.ops[cmd.corrId] = {
      kind: 'send',
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: cmd.previousSummary,
      text: cmd.text,
      inputs: [...inputsSnapshot],
      // PURE: from the command timestamp, not a reducer wall-clock read.
      // Carried onto the promoted op so the projection can read it while the
      // prepass runs (Brief F prepassStartedAt).
      startedAt: cmd.timestamp,
    };
    draft.sessions.runningSessionPaths = nextRunningPaths;
    delete draft.composer.draftTextBySession[cmd.sessionPath];
    // Retry clears a stale prepass 'failed' chip from a previous turn
    // (Brief F); the phase returns to 'running' on the early-ack promote.
    delete draft.pending.prepassBySession[cmd.sessionPath];
    // Clear pending composer inputs at SEND time (not ack time): the inputs
    // have already been folded into the sent message by MessageRouter, so
    // keeping them as pending cards past send is pure visual debt (Heuristic
    // #8). The snapshot captured above rides on the PendingOp so a rollback
    // (pre-ack `SendResult{ok:false}` or post-ack `PreflightFailed`) can
    // restore them — see `handleSendResult` / `handlePreflightFailed`.
    delete draft.composer.pendingComposerInputsBySession[cmd.sessionPath];
  });

  return {
    state: nextState,
    effects: [
      {
        kind: 'SendRpc',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        text: cmd.text,
        inputs: cmd.inputs,
        localId: cmd.localId,
        composedText: cmd.composedText,
        userParts: cmd.userParts,
        priorPruningMode: cmd.priorPruningMode,
      },
    ],
  };
}

export function handleEdit(state: ArchState, cmd: Extract<Command, { kind: 'Edit' }>): ReducerResult {
  // Insert optimistic edit message + mark session busy immediately so the
  // webview shows an activity indicator right away.
  const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
  const nextState = produce(state, (draft) => {
    draft.transcript.editingMessageIdBySession[cmd.sessionPath] = null;
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.text, undefined, new Date(cmd.timestamp).toISOString());
    draft.pending.ops[cmd.corrId] = {
      kind: 'edit',
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: null,
      // PURE: from the command timestamp, not a reducer wall-clock read. An
      // edit also runs the prepass (before_agent_start), so it gets a startedAt
      // and a 'running' chip on promote, mirroring send (Brief F).
      startedAt: cmd.timestamp,
    };
    draft.sessions.runningSessionPaths = nextRunningPaths;
    // Retry clears a stale prepass 'failed' chip from a previous turn.
    delete draft.pending.prepassBySession[cmd.sessionPath];
  });

  return {
    state: nextState,
    effects: [
      {
        kind: 'EditRpc',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        messageId: cmd.messageId,
        text: cmd.text,
        localId: cmd.localId,
        composedText: cmd.text,
      },
    ],
  };
}

export function handleTruncateAfter(state: ArchState, cmd: Extract<Command, { kind: 'TruncateAfter' }>): ReducerResult {
  return {
    state,
    effects: [{
      kind: 'TruncateRpc',
      corrId: cmd.corrId,
      sessionPath: cmd.sessionPath,
      messageId: cmd.messageId,
    }],
  };
}

export function handleSetOutcomeDialog(state: ArchState, cmd: Extract<Command, { kind: 'SetOutcomeDialog' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.showOutcomeDialogBySession[cmd.sessionPath] = cmd.visible;
    }),
    effects: [],
  };
}

export function handleDismissNotice(state: ArchState, _cmd: Extract<Command, { kind: 'DismissNotice' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
    }),
    effects: [],
  };
}

export function handleRespondExtensionUI(state: ArchState, cmd: Extract<Command, { kind: 'RespondExtensionUI' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
      if (sessionMap) {
        delete sessionMap[cmd.requestId];
        if (Object.keys(sessionMap).length === 0) {
          delete draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
        }
      }
    }),
    effects: [
      { kind: 'ExtensionUiResponseRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath, response: cmd.response },
    ],
  };
}

export function handleSetPrefs(state: ArchState, cmd: Extract<Command, { kind: 'SetPrefs' }>): ReducerResult {
  const current = state.settings.prefs;
  const deepMerged: ChatPrefs = {
    ...current,
    ...cmd.prefs,
    ...(cmd.prefs.extensionToggles && {
      extensionToggles: { ...current.extensionToggles, ...cmd.prefs.extensionToggles },
    }),
    ...(cmd.prefs.providerToggles && {
      providerToggles: { ...current.providerToggles, ...cmd.prefs.providerToggles },
    }),
    // Normalize subagentBuckets so ArchState always holds a complete
    // {small,medium,frontier} object even if a caller dispatches a partial
    // patch (validateChatPrefsPatch permits missing bucket keys). Without
    // this, a partial patch would leave e.g. `subagentBuckets.small`
    // undefined and crash the webview BucketModelsEditor.
    ...(cmd.prefs.subagentBuckets !== undefined && {
      subagentBuckets: normalizeSubagentBuckets(cmd.prefs.subagentBuckets),
    }),
    // Normalize subagentNestedAllowedBuckets so ArchState always holds a
    // complete {small,medium,frontier} object (missing keys default to true)
    // even if a caller dispatches a partial patch.
    ...(cmd.prefs.subagentNestedAllowedBuckets !== undefined && {
      subagentNestedAllowedBuckets: normalizeNestedAllowedBuckets(cmd.prefs.subagentNestedAllowedBuckets),
    }),
  };
  // Phase 2 cutover: the unread-finished-sessions clear moved here from
  // service.setPrefs (the SetPrefsRpc effect handler). When the merged
  // prefs suppress completion notifications, clear unread finished sessions
  // in the same reducer transition. This is a pure state mutation — no
  // event is dispatched (the previous round-trip through an
  // UnreadFinishedSessionsChanged event is gone).
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        ...(deepMerged.suppressCompletionNotifications
          ? { unreadFinishedSessionPaths: [] }
          : {}),
      },
      settings: {
        ...state.settings,
        prefs: deepMerged,
      },
    },
    effects: [{ kind: 'SetPrefsRpc', corrId: cmd.corrId, prefs: cmd.prefs }],
  };
}

export function handleStartNewTask(state: ArchState, cmd: Extract<Command, { kind: 'StartNewTask' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'StartNewTask',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleContinueTask(state: ArchState, cmd: Extract<Command, { kind: 'ContinueTask' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'ContinueTask',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
      },
    ],
  };
}

export function handleRecordOutcome(state: ArchState, cmd: Extract<Command, { kind: 'RecordOutcome' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'RecordOutcome',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        outcome: cmd.outcome,
      },
    ],
  };
}

export function handleSetPruningSettings(state: ArchState, cmd: Extract<Command, { kind: 'SetPruningSettings' }>): ReducerResult {
  // Option B: apply optimistically for instant UI. The service keeps its
  // catch+mirror+notice (graceful degradation when PI_CODING_AGENT_DIR is
  // absent), so SetPruningSettingsResult is always {ok:true} and no
  // snapshot/revert is needed. mergePruningSettings matches the disk-write
  // merge so optimistic state == persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        pruningSettings: mergePruningSettings(state.settings.pruningSettings, cmd.settings),
      },
    },
    effects: [
      {
        kind: 'SetPruningSettings',
        corrId: cmd.corrId,
        settings: cmd.settings,
      },
    ],
  };
}

export function handleSetToolResultPruningSettings(state: ArchState, cmd: Extract<Command, { kind: 'SetToolResultPruningSettings' }>): ReducerResult {
  // Option B: apply optimistically for instant UI. The service keeps its
  // catch+mirror+notice (graceful degradation when PI_CODING_AGENT_DIR is
  // absent), so SetToolResultPruningSettingsResult is always {ok:true} and no
  // snapshot/revert is needed. mergeToolResultPruningSettings matches the
  // disk-write merge so optimistic state == persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        toolResultPruningSettings: mergeToolResultPruningSettings(state.settings.toolResultPruningSettings, cmd.settings),
      },
    },
    effects: [
      {
        kind: 'SetToolResultPruningSettings',
        corrId: cmd.corrId,
        settings: cmd.settings,
      },
    ],
  };
}

export function handleSetProxySettings(state: ArchState, cmd: Extract<Command, { kind: 'SetProxySettings' }>): ReducerResult {
  // Optimistic apply for instant UI, mirroring handleSetPruningSettings. The
  // service persists + regenerates litellm_config.yaml + restarts the proxy;
  // on a config/restart failure it dispatches a NoticeShown rather than
  // reverting (the new settings are already on disk). mergeProxySettings
  // matches the disk-write merge in writeProxySettings so optimistic state ==
  // persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        proxySettings: mergeProxySettings(state.settings.proxySettings, cmd.settings),
      },
    },
    effects: [
      {
        kind: 'SetProxySettings',
        corrId: cmd.corrId,
        settings: cmd.settings,
      },
    ],
  };
}

export function handleAddProxyProvider(state: ArchState, cmd: Extract<Command, { kind: 'AddProxyProvider' }>): ReducerResult {
  // The message-router validates input + dedupes before dispatching, so by the
  // time we get here the entry is buildable + the name is free. Guard anyway:
  // if somehow unbuildable, no-op (the router already showed a notice).
  const entry = buildProxyProviderEntry(cmd.input);
  if (!entry) {
    return { state, effects: [] };
  }
  const name = cmd.input.name.trim().toLowerCase();
  // Optimistic apply: merge a fresh pending `proxy.providers.<name>` entry
  // (empty modelListOrder, <name>-shared model-info id). The service then
  // persists the key to proxy/.env + writes settings.json + runs sync-models +
  // restarts the proxy; on failure it reloads proxy settings from disk
  // (ProxySettingsChanged) to revert this optimistic entry. buildProxyProviderEntry
  // is shared with the service so optimistic state == persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        proxySettings: mergeProxySettings(state.settings.proxySettings, {
          providers: { [name]: entry },
        }),
      },
    },
    effects: [
      {
        kind: 'AddProxyProvider',
        corrId: cmd.corrId,
        input: cmd.input,
      },
    ],
  };
}
