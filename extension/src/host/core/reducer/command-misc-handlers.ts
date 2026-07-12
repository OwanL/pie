import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import { mergePruningSettings, mergeToolResultPruningSettings, normalizeNestedAllowedBuckets, normalizeSubagentBuckets, type ChatPrefs } from '../../../shared/protocol.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, appendLocalUserMessage, truncateLocalTranscriptAfter } from './helpers.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
import { BACKEND_READY_TIMEOUT_MS } from '../../../shared/backend-ready-timeout.js';
import { QUEUED_DWELL_HARD_MS } from '../../../shared/queued-dwell.js';

export function handleInterrupt(state: ArchState, cmd: Extract<Command, { kind: 'Interrupt' }>): ReducerResult {
  // Stop takes effect INSTANTLY in the reducer while remaining truthful about
  // teardown. The partial reply is frozen immediately, but busy remains set
  // until the abort-completion barrier returns, so the user sees Stopping… and
  // cannot race a new send into the dying turn:
  //  - `interruptInFlightBySession` is set: the in-flight-abort gate in
  //    `handleMessageDelta` / `handleMessageThinking` drops late deltas as
  //    pure no-ops during the abort window.
  //  - `runningSessionPaths` deliberately stays set until InterruptResult: the
  //    composer remains in a truthful, disabled "Stopping…" state and a new
  //    send cannot race into the still-running backend turn as a follow-up.
  //  - Streaming assistant messages are marked `interrupted`: this gates
  //    appending via the `status !== 'interrupted'` check in the delta/thinking
  //    handlers (defense-in-depth alongside the flag gate) and renders the
  //    partial reply as cancelled.
  //  - An in-flight prepass chip is cleared (idle): a Stop cancels the prepass
  //    too, not only the streaming turn.
  // `InterruptResult{ok}` later clears the flag (idempotent with these writes);
  // a late `MessageFinished` is intentionally NOT gated and self-corrects the
  // optimistic `interrupted` to `completed` (race: the turn finished between
  // the click and the abort).
  const nextState = produce(state, (draft) => {
    draft.sessions.interruptInFlightBySession[cmd.sessionPath] = true;
    delete draft.pending.prepassBySession[cmd.sessionPath];
    const list = draft.transcript.bySession[cmd.sessionPath];
    if (list) {
      for (const message of list) {
        if (message.role === 'assistant' && message.status === 'streaming') {
          message.status = 'interrupted';
        }
      }
    }
  });
  return {
    state: nextState,
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
  // Handoff §F: also clears the dwell entries and cancels their watchdog timers
  // so a cleared queued message is never left immortal nor nagged post-clear.
  const clearedLocalIds = (state.pending.queuedDwellBySession[cmd.sessionPath] ?? []).map((e) => e.localId);
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
    delete draft.pending.queuedDwellBySession[cmd.sessionPath];
  });
  const effects = [
    { kind: 'ClearQueueRpc' as const, corrId: cmd.corrId, sessionPath: cmd.sessionPath },
    ...clearedLocalIds.map((localId) => ({ kind: 'CancelQueuedDwellWatchdog' as const, corrId: cmd.corrId, localId })),
  ];
  return { state: nextState, effects };
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
  // effect is emitted (the runner starts a timer; if the backend
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
      effects: [{ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: BACKEND_READY_TIMEOUT_MS }],
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
      // Handoff §F: track this queued message's dwell from the (pure) command
      // timestamp and arm a per-localId watchdog. The watchdog marks the entry
      // actionable on the hard threshold; it does NOT interrupt the in-flight
      // turn. Cleared on delivery/clear/interrupt/rollback/restart.
      draft.pending.queuedDwellBySession[cmd.sessionPath] = [
        ...(draft.pending.queuedDwellBySession[cmd.sessionPath] ?? []),
        { localId: cmd.localId, enqueuedAt: cmd.timestamp, watchdogFired: false, abandoned: false },
      ];
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
        // Handoff §F: arm the dwell watchdog for this queued message.
        { kind: 'StartQueuedDwellWatchdog', corrId: cmd.corrId, sessionPath: cmd.sessionPath, localId: cmd.localId, timeoutMs: QUEUED_DWELL_HARD_MS },
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
    // Optimistically truncate the edited message + everything after it (the
    // old user message, agent reply, and any continuation turns) so the UI
    // reflects the edit instantly. The removed tail is captured on the pending
    // op so the failure handlers (`EditResult{ok:false}`, `PreflightFailed`)
    // can restore it on rollback.
    const removedTail = truncateLocalTranscriptAfter(draft, cmd.sessionPath, cmd.messageId);
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
    draft.pending.ops[cmd.corrId] = {
      kind: 'edit',
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: null,
      // PURE: from the command timestamp, not a reducer wall-clock read. An
      // edit also runs the prepass (before_agent_start), so it gets a startedAt
      // and a 'running' chip on promote, mirroring send (Brief F).
      startedAt: cmd.timestamp,
      removedTail,
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
        composedText: cmd.composedText,
        inputs: cmd.inputs,
        userParts: cmd.userParts,
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

/** Handoff §F: the user clicked "Keep waiting" on a queued-message dwell
 *  warning. Reset the entry's `watchdogFired` flag and re-arm the host-side
 *  per-localId watchdog so the threshold is bounded through host state — the
 *  banner hides only because the state changed, not because the webview hid it
 *  locally. No-op if the entry is gone or already abandoned (terminal). */
export function handleRearmQueuedDwellWatchdog(
  state: ArchState,
  cmd: Extract<Command, { kind: 'RearmQueuedDwellWatchdog' }>,
): ReducerResult {
  const entry = state.pending.queuedDwellBySession[cmd.sessionPath]?.find((e) => e.localId === cmd.localId);
  if (!entry || entry.abandoned) {
    return { state, effects: [] };
  }
  const nextState = produce(state, (draft) => {
    const target = draft.pending.queuedDwellBySession[cmd.sessionPath]?.find((e) => e.localId === cmd.localId);
    if (target) target.watchdogFired = false;
  });
  return {
    state: nextState,
    effects: [
      {
        kind: 'StartQueuedDwellWatchdog',
        corrId: cmd.corrId,
        sessionPath: cmd.sessionPath,
        localId: cmd.localId,
        timeoutMs: QUEUED_DWELL_HARD_MS,
      },
    ],
  };
}
