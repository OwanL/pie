import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, appendLocalUserMessage, removeFromArray, removeMessage, restoreRemovedTail } from './helpers.js';
import type { Event, EffectResultEvent } from '../events.js';
import { applySetModelOptimistic, dropSetModelPending, revertSetModel } from './set-model-handlers.js';
import { mapSendOrEditError, mapPreflightError } from '../../../shared/error-mapping.js';

export function handleInterruptResult(state: ArchState, event: Extract<Event, { kind: 'InterruptResult' }>): ReducerResult {
  let nextState = state;
  const effects: Effect[] = [];

  if (!event.ok) {
    effects.push({
      kind: 'Log',
      corrId: event.corrId,
      level: 'error',
      message: `Interrupt failed for session ${event.sessionPath}`,
      data: { error: event.error },
    });
  }

  // Directly update running state and clear interrupt flag.
  nextState = produce(nextState, (draft) => {
    draft.sessions.interruptInFlightBySession[event.sessionPath] = false;
    if (event.ok) {
      draft.sessions.runningSessionPaths = draft.sessions.runningSessionPaths.filter(
        (p: string) => p !== event.sessionPath,
      );
      const list = draft.transcript.bySession[event.sessionPath];
      if (list) {
        draft.transcript.bySession[event.sessionPath] = list.filter(
          (m) => !(m.role === 'user' && m.status === 'queued'),
        );
      }
      for (const [corrId, op] of Object.entries(draft.pending.ops)) {
        if (op.queued && op.sessionPath === event.sessionPath) delete draft.pending.ops[corrId];
      }
      for (const [corrId, op] of Object.entries(draft.pending.promoted)) {
        if (op.queued && op.sessionPath === event.sessionPath) delete draft.pending.promoted[corrId];
      }
    }
  });

  return { state: nextState, effects };
}

export function handleReplaceQueueResult(state: ArchState, event: Extract<Event, { kind: 'ReplaceQueueResult' }>): ReducerResult {
  if (!event.ok) {
    const mapped = mapSendOrEditError(event.error, 'edit');
    return {
      state: produce(state, (draft) => {
        if (event.error?.includes('QUEUE_REPLACE_FAILED')) {
          const list = draft.transcript.bySession[event.sessionPath];
          if (list) {
            draft.transcript.bySession[event.sessionPath] = list.filter(
              (message) => !(message.role === 'user' && message.status === 'queued'),
            );
          }
          for (const [corrId, op] of Object.entries(draft.pending.ops)) {
            if (op.queued && op.sessionPath === event.sessionPath) delete draft.pending.ops[corrId];
          }
          for (const [corrId, op] of Object.entries(draft.pending.promoted)) {
            if (op.queued && op.sessionPath === event.sessionPath) delete draft.pending.promoted[corrId];
          }
          draft.transcript.editingMessageIdBySession[event.sessionPath] = null;
          draft.settings.notice = 'The queued messages could not be restored and were cleared. Re-send them if they are still needed.';
          draft.settings.noticeKind = 'operational-error';
          draft.settings.noticeRaw = event.error;
        } else if (mapped) {
          draft.settings.notice = mapped.message;
          draft.settings.noticeKind = mapped.kind;
          draft.settings.noticeRaw = event.error ?? null;
        }
      }),
      effects: [{
        kind: 'Log', corrId: event.corrId, level: 'error',
        message: `Queued message edit failed for session ${event.sessionPath}`,
        data: { error: event.error },
      }],
    };
  }

  return {
    state: produce(state, (draft) => {
      const message = draft.transcript.bySession[event.sessionPath]?.find((entry) => entry.id === event.messageId);
      if (message?.role === 'user') {
        // The backend response lane drains before queued-delivery events, but
        // accept an already-promoted row defensively so an edit racing delivery
        // cannot leave stale visible text.
        message.markdown = event.composedText;
        message.userParts = event.userParts;
      }
      const pending = Object.values(draft.pending.ops).find((op) => op.localId === event.messageId)
        ?? Object.values(draft.pending.promoted).find((op) => op.localId === event.messageId);
      if (pending?.queued) {
        pending.text = event.text;
        pending.inputs = event.inputs;
      }
      draft.transcript.editingMessageIdBySession[event.sessionPath] = null;
    }),
    effects: [],
  };
}

export function handleClearQueueResult(state: ArchState, event: Extract<Event, { kind: 'ClearQueueResult' }>): ReducerResult {
  // The transcript 'queued' messages + pending snapshots were already removed
  // optimistically in `handleClearQueue`. On success there is nothing more to
  // do. On failure we only log: the backend follow-up queue may still contain
  // the messages, but the UI no longer shows them, and a later
  // `QueuedDelivered` for a removed message no-ops (findIndex finds nothing).
  if (!event.ok) {
    return {
      state,
      effects: [
        {
          kind: 'Log',
          corrId: event.corrId,
          level: 'error',
          message: `ClearQueue failed for session ${event.sessionPath}`,
          data: { error: event.error },
        },
      ],
    };
  }
  return { state, effects: [] };
}

export function handleSendResult(state: ArchState, event: Extract<Event, { kind: 'SendResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    // Early-ack success: the prompt was queued. The rollback snapshot MOVES
    // to `pending.promoted` (it is NOT deleted) so a post-ack setup failure
    // (`PreflightFailed`) can still roll back via `promoted[corrId]`. The
    // snapshot is dropped at the commit point (first `MessageStarted` for the
    // requestId) — see STATE_CONTRACT § Optimistic Reconciliation "Two failure
    // windows for send".
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      draft.pending.promoted[event.corrId] = {
        ...pending,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.queued ? { queued: true } : {}),
      };
      if (event.queued) {
        // Steering (FollowUp) ack: the message is queued, not running yet —
        // no pruning prepass runs for a followUp, and there is no requestId
        // to bind. Force the optimistic message to 'queued' (handleSend's
        // busy branch already inserted it as 'queued', but this also covers
        // the boundary race where handleSend saw the session as idle yet the
        // backend saw it as busy and queued the message).
        const list = draft.transcript.bySession[pending.sessionPath];
        if (list) {
          const idx = list.findIndex((m) => m.id === pending.localId);
          if (idx >= 0 && list[idx].role === 'user') {
            list[idx].status = 'queued';
          }
        }
      } else {
        // Normal ack: the pruning prepass now runs. Surface a live, cancelable
        // status chip. `startedAt` is read from the promoted op by the
        // projection (pure, from the Send command timestamp).
        // preflight-succeeded may beat this RPC acknowledgement when every
        // hook returns synchronously (notably disabled/empty pruning). Preserve
        // that early phase boundary instead of regressing it to "running".
        if (draft.pending.prepassBySession[pending.sessionPath]?.phase !== 'succeeded') {
          draft.pending.prepassBySession[pending.sessionPath] = { phase: 'running', latencyMs: null };
        }
        if (event.requestId) {
          draft.pending.requestIdToLocalId[event.requestId] = {
            sessionPath: pending.sessionPath,
            localId: pending.localId,
          };
        }
        // Boundary race: handleSend's busy branch inserted this as 'queued'
        // but the backend started a normal turn (the prior turn had just
        // finished). Promote the optimistic message to 'completed' so the
        // prepass chip + streaming reconcile against a normal send.
        const list = draft.transcript.bySession[pending.sessionPath];
        if (list) {
          const idx = list.findIndex((m) => m.id === pending.localId);
          if (idx >= 0 && list[idx].role === 'user' && list[idx].status === 'queued') {
            list[idx].status = 'completed';
          }
        }
      }
    });
    return { state: nextState, effects: [] };
  }

  // Failure: rollback optimistic message, notify user, restore session name
  // Also clear the busy state we set optimistically in the Send command handler.
  const effects: Effect[] = [
    {
      kind: 'PostImperative',
      corrId: event.corrId,
      imperativeMessage: {
        type: 'sendRejected',
        sessionPath: pending.sessionPath,
        text: pending.text ?? '',
        localId: pending.localId,
        inputs: pending.inputs ?? [],
      },
    },
  ];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    // Remove optimistic message from transcript
    removeMessage(draft, pending.sessionPath, pending.localId);
    // Clear busy state set optimistically at send time. A queued (follow-up)
    // send never added the session to `runningSessionPaths` (the session was
    // already running its original turn), so it must not clear it here — the
    // original turn is still in flight.
    if (!pending.queued) {
      draft.sessions.runningSessionPaths = removeFromArray(
        draft.sessions.runningSessionPaths,
        pending.sessionPath,
      );
    }
    // Brief H: map the raw RPC error (which may carry a `req-NN` id) to a
    // plain-language notice + a failure kind that the webview renders recovery
    // buttons for. A user-initiated cancel (Brief E abort) returns null →
    // SUPPRESS the notice (the user initiated it; the rollback above still
    // removes the optimistic message + restores inputs). Leaving the prior
    // notice untouched on cancel avoids clobbering an unrelated banner.
    const mapped = mapSendOrEditError(event.error, 'send');
    if (mapped) {
      draft.settings.notice = mapped.message;
      draft.settings.noticeKind = mapped.kind;
      // Retain the full host-side error (including req-NN ids) behind the short
      // summary. Projection redacts credentials before the webview boundary.
      draft.settings.noticeRaw = event.error ?? null;
    }
    // Restore composer inputs from the send-time snapshot so a retry can
    // re-send them (no data loss). Inputs were cleared at send time (handleSend);
    // the pre-ack failure must hand them back. Mirrors the post-ack
    // `handlePreflightFailed` restore from `pending.promoted[corrId].inputs`.
    if (pending.inputs && pending.inputs.length > 0) {
      draft.composer.pendingComposerInputsBySession[pending.sessionPath] = [...pending.inputs];
    }
    // Brief F: the send was rejected before the prepass ran — clear any
    // prepass chip (idle).
    delete draft.pending.prepassBySession[pending.sessionPath];
    // Restore session summary if we had one
    if (pending.previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === pending.previousSummary!.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = pending.previousSummary;
      } else {
        draft.sessions.sessions.push(pending.previousSummary);
      }
    }
  });

  return { state: nextState, effects };
}

/**
 * Pre-commit setup failure. Normally `message.send` has already acknowledged
 * and the rollback snapshot lives in `pending.promoted`. A synchronous
 * preflight (common when pruning is disabled/empty) can publish failure before
 * that acknowledgement crosses stdio, so this handler also accepts the oldest
 * non-queued `pending.ops` entry for the session. Session RPC execution is FIFO,
 * therefore later ops cannot have entered preflight yet.
 *
 * `corrId` resolution: the backend bridge dispatches WITHOUT `corrId`, so the
 * reducer first scans promoted entries by `requestId`, then falls back to the
 * currently executing pending op for the session. Brief B's send-timer
 * dispatches WITH `corrId`. See STATE_CONTRACT § Optimistic Reconciliation.
 */
export function handlePreflightFailed(state: ArchState, event: Extract<Event, { kind: 'PreflightFailed' }>): ReducerResult {
  let corrId = event.corrId;
  let snapshot = corrId ? state.pending.promoted[corrId] ?? state.pending.ops[corrId] : undefined;
  let source: 'promoted' | 'ops' | undefined = snapshot
    ? (state.pending.promoted[corrId!] ? 'promoted' : 'ops')
    : undefined;
  if (!snapshot) {
    for (const [cid, op] of Object.entries(state.pending.promoted)) {
      if (op.requestId === event.requestId) {
        corrId = cid;
        snapshot = op;
        source = 'promoted';
        break;
      }
    }
  }
  if (!snapshot) {
    const pendingEntry = Object.entries(state.pending.ops).find(([, op]) =>
      op.sessionPath === event.sessionPath && !op.queued,
    );
    if (pendingEntry) {
      [corrId, snapshot] = pendingEntry;
      source = 'ops';
    }
  }
  // Stale/unknown: the send already committed, or no operation for this
  // session is still in preflight. A later failure is an in-turn error.
  if (!corrId || !snapshot || !source) return { state, effects: [] };

  const { [corrId]: _removedPromoted, ...restPromoted } = state.pending.promoted;
  const { [corrId]: _removedOp, ...restOps } = state.pending.ops;

  // Backend-originated failures have no corrId and must clear the runner's
  // timer even when they beat the RPC ack. A timer-originated failure already
  // carries corrId and is deliberately left in the runner so a genuinely late
  // commit can emit PreflightSuperseded.
  const effects: Effect[] = event.corrId ? [] : [{ kind: 'ClearSendTimer', corrId }];
  if (snapshot.kind === 'send') {
    effects.push({
      kind: 'PostImperative',
      corrId,
      imperativeMessage: {
        type: 'sendRejected',
        sessionPath: snapshot.sessionPath,
        text: snapshot.text ?? '',
        localId: snapshot.localId,
        inputs: snapshot.inputs ?? [],
      },
    });
  }

  const nextState = produce(state, (draft) => {
    if (source === 'promoted') draft.pending.promoted = restPromoted;
    else draft.pending.ops = restOps;
    // Remove optimistic user message from transcript
    removeMessage(draft, snapshot.sessionPath, snapshot.localId);
    // Edit rollback (post-ack setup failure): restore the messages truncated
    // by the optimistic Edit command. Send ops have no removedTail.
    if (snapshot.kind === 'edit' && snapshot.removedTail && snapshot.removedTail.length > 0) {
      restoreRemovedTail(draft, snapshot.sessionPath, snapshot.removedTail);
    }
    // Clear the host-side optimistic running state set at Send time
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      snapshot.sessionPath,
    );
    // The send will never stream — drop its requestId→localId mapping
    if (event.requestId) {
      delete draft.pending.requestIdToLocalId[event.requestId];
    }
    // Restore composer inputs from the promoted snapshot so a retry can re-send
    // them (no data loss). Brief C wires the webview-side restore.
    if (snapshot.inputs && snapshot.inputs.length > 0) {
      draft.composer.pendingComposerInputsBySession[snapshot.sessionPath] = [...snapshot.inputs];
    }
    // Brief F: the prepass failed post-ack. Surface a 'failed' status chip
    // (Brief H refines the message copy); the notice below carries the
    // plain-language error. The promoted op is dropped above so startedAt is
    // null (no elapsed timer for a failed chip).
    draft.pending.prepassBySession[snapshot.sessionPath] = { phase: 'failed', latencyMs: null };
    // Brief H: map the pre-commit setup failure to a plain-language notice.
    // The send-timer's phase-specific strings distinguish pruning from model
    // start; a generic backend rejection is not attributed to pruning because
    // SDK preflight also owns auth/model checks, compaction, and other hooks.
    const preflightMapped = mapPreflightError(event.error, snapshot.kind);
    draft.settings.notice = preflightMapped.message;
    draft.settings.noticeKind = preflightMapped.kind;
    draft.settings.noticeRaw = event.error ?? null;
    // Restore session summary if the optimistic send had renamed it
    if (snapshot.previousSummary) {
      const idx = draft.sessions.sessions.findIndex((s) => s.path === snapshot.previousSummary!.path);
      if (idx >= 0) {
        draft.sessions.sessions[idx] = snapshot.previousSummary;
      } else {
        draft.sessions.sessions.push(snapshot.previousSummary);
      }
    }
  });

  return { state: nextState, effects };
}

/**
 * Late commit after a send-timer fire (false-positive `PreflightFailed`). The
 * turn started streaming after the rollback, so undo the rollback: re-insert the
 * optimistic user message, restore the session to `runningSessionPaths`, and
 * clear the `prepass-timeout` notice. This is idempotent — a duplicate event
 * finds the message already present and no-ops.
 */
export function handlePreflightSuperseded(state: ArchState, event: Extract<Event, { kind: 'PreflightSuperseded' }>): ReducerResult {
  const { sessionPath, localId, composedText, userParts, timestamp } = event;

  const nextState = produce(state, (draft) => {
    const list = draft.transcript.bySession[sessionPath];
    const alreadyPresent = list?.some((m) => m.id === localId) ?? false;
    if (!alreadyPresent) {
      appendLocalUserMessage(
        draft,
        sessionPath,
        localId,
        composedText ?? '',
        userParts,
        new Date(timestamp).toISOString(),
      );
    }

    draft.sessions.runningSessionPaths = addToArray(draft.sessions.runningSessionPaths, sessionPath);

    if (draft.settings.noticeKind === 'prepass-timeout' || draft.settings.noticeKind === 'model-start-timeout') {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
    }
  });

  return { state: nextState, effects: [] };
}

export function handleEditResult(state: ArchState, event: Extract<Event, { kind: 'EditResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    // Early-ack success (mirrors handleSendResult): the prompt was queued.
    // The rollback snapshot MOVES to `pending.promoted` (not deleted) so a
    // post-ack setup failure (`PreflightFailed`) can still roll back the
    // edit. Dropped at the commit point (first `MessageStarted` for the
    // requestId). See STATE_CONTRACT § Optimistic Reconciliation "Two failure
    // windows for send" — edit follows the same phase-scoped shape.
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      draft.pending.promoted[event.corrId] = {
        ...pending,
        ...(event.requestId ? { requestId: event.requestId } : {}),
      };
      // Brief F: an edit also runs the prepass (before_agent_start), so
      // surface a live chip on promote, mirroring send.
      // Same early-boundary race as SendResult: a synchronous no-op preflight
      // can publish success while this edit is still awaiting its RPC ack.
      if (draft.pending.prepassBySession[pending.sessionPath]?.phase !== 'succeeded') {
        draft.pending.prepassBySession[pending.sessionPath] = { phase: 'running', latencyMs: null };
      }
    });
    return { state: nextState, effects: [] };
  }

  // Failure: rollback the optimistic edit message + notify user
  // Also clear the busy state we set optimistically in the Edit command handler.
  const effects: Effect[] = [];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    removeMessage(draft, pending.sessionPath, pending.localId);
    // Edit rollback: restore the messages truncated by the optimistic Edit
    // command so the pre-edit conversation reappears on a pre-ack failure.
    if (pending.removedTail && pending.removedTail.length > 0) {
      restoreRemovedTail(draft, pending.sessionPath, pending.removedTail);
    }
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      pending.sessionPath,
    );
    // Brief H: map the raw RPC error to a plain-language notice + kind. Edits
    // map to `edit-failed` (prose action — re-editing is a separate affordance
    // Brief E owns; no retry button). A cancel returns null → suppress.
    const editMapped = mapSendOrEditError(event.error, 'edit');
    if (editMapped) {
      draft.settings.notice = editMapped.message;
      draft.settings.noticeKind = editMapped.kind;
      draft.settings.noticeRaw = event.error ?? null;
    }
    // Brief F: edit rejected pre-ack — clear any prepass chip (idle).
    delete draft.pending.prepassBySession[pending.sessionPath];
  });

  return { state: nextState, effects };
}

export function handleSetModelResult(state: ArchState, event: Extract<Event, { kind: 'SetModelResult' }>): ReducerResult {
  const pending = state.pending.setModelByCorrId[event.corrId];
  if (!pending) {
    // Stale result for an unknown/aborted setModel — nothing to reconcile.
    return { state, effects: [] };
  }
  if (event.ok) {
    // Success: the backend persisted the switch; drop the rollback snapshot.
    return { state: dropSetModelPending(state, event.corrId), effects: [] };
  }
  // Failure: revert the optimistic apply field-for-field + surface a notice.
  return { state: revertSetModel(state, event.corrId, event.error), effects: [] };
}

export function handleModelSwitchConfirmResult(
  state: ArchState,
  event: Extract<Event, { kind: 'ModelSwitchConfirmResult' }>,
): ReducerResult {
  const pending = state.pending.setModelByCorrId[event.corrId];
  if (!pending) {
    // Stale confirm for an unknown/aborted request — nothing to do.
    return { state, effects: [] };
  }
  if (!event.confirmed) {
    // User declined (or dismissed): drop the stashed intent, leave all state
    // untouched. No notice — the user explicitly cancelled.
    return { state: dropSetModelPending(state, event.corrId), effects: [] };
  }
  // Confirmed: apply optimistically, clearing the pending images that prompted
  // the modal (the modal only appears when the new model lacks image support),
  // then emit the backend write.
  return {
    state: applySetModelOptimistic(state, event.corrId, pending.sessionPath, pending.modelSettings, true),
    effects: [{ kind: 'SetModelRpc', corrId: event.corrId, sessionPath: pending.sessionPath, modelSettings: pending.modelSettings }],
  };
}

export function handleSetPrefsResult(state: ArchState, event: Extract<Event, { kind: 'SetPrefsResult' }>): ReducerResult {
  if (event.ok) return { state, effects: [] };
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        notice: `The setting could not be fully applied. Retry it, or restart the backend if the problem continues.`,
        noticeKind: 'operational-error',
        noticeRaw: event.error ?? 'runtimePrefs.set failed',
      },
    },
    effects: [],
  };
}

export function handleEffectResult(state: ArchState, event: Exclude<EffectResultEvent, { kind: 'TruncateResult' } | { kind: 'ClearQueueResult' } | { kind: 'ReplaceQueueResult' } | { kind: 'OpenSessionResult' } | { kind: 'CreateSessionResult' } | { kind: 'DuplicateSessionResult' } | { kind: 'CloseSessionResult' } | { kind: 'PersistTabsResult' } | { kind: 'ModelSwitchConfirmResult' } | { kind: 'LiveTurnCheckpointResult' }>): ReducerResult {
  switch (event.kind) {
    case 'InterruptResult':
      return handleInterruptResult(state, event);
    case 'CompactResult':
      return event.ok ? { state, effects: [] } : {
        state: {
          ...state,
          settings: {
            ...state.settings,
            notice: 'Could not compact this conversation.',
            noticeKind: 'operational-error',
            noticeRaw: event.error ?? 'message.compact failed',
          },
        },
        effects: [],
      };
    case 'SendResult':
      return handleSendResult(state, event);
    case 'EditResult':
      return handleEditResult(state, event);
    case 'FileDiffResult':
      return { state, effects: [] };
    case 'FileRevertResult':
      return { state, effects: [] };
    case 'SetModelResult':
      return handleSetModelResult(state, event);
    case 'SetPrefsResult':
      return handleSetPrefsResult(state, event);
    case 'LoadOlderTranscriptResult':
    case 'LoadNewerTranscriptResult':
    case 'JumpToLatestTranscriptResult': {
      // Clear the in-flight paging flag when this result is for the current
      // request (corrId matches). A stale result from a superseded request
      // (the tab was closed + reopened, or SessionScopeCleared reset the flag
      // and a new request took over) must NOT clear the current request's
      // flag — its own completion still needs to clear it. Log failures
      // regardless of whether the corrId is current.
      const effects: Effect[] = [];
      if (!event.ok) {
        effects.push({
          kind: 'Log',
          corrId: event.corrId,
          level: 'error',
          message: `${event.kind} failed`,
          data: { error: event.error },
        });
      }
      if (state.transcript.pagingInFlightBySession[event.sessionPath] === event.corrId) {
        const nextPagingInFlight = { ...state.transcript.pagingInFlightBySession };
        delete nextPagingInFlight[event.sessionPath];
        return {
          state: {
            ...state,
            transcript: {
              ...state.transcript,
              pagingInFlightBySession: nextPagingInFlight,
            },
          },
          effects,
        };
      }
      return { state, effects };
    }
    case 'ExtensionUiResponseResult': {
      const pending = state.pending.extensionUiResponseByCorrId[event.corrId];
      if (!pending) return { state, effects: [] };
      const next = produce(state, (draft) => {
        delete draft.pending.extensionUiResponseByCorrId[event.corrId];
        if (event.ok) return;
        const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[pending.sessionPath] ?? {};
        sessionMap[pending.request.id] = pending.request;
        draft.settings.pendingExtensionUIRequestsBySession[pending.sessionPath] = sessionMap;
        const turn = draft.livePipeline.turnsBySession[pending.sessionPath];
        if (turn && !turn.pendingExtensionUiRequestIds.includes(pending.request.id)) {
          turn.pendingExtensionUiRequestIds.push(pending.request.id);
          turn.phase = pending.priorPhase ?? 'waiting_input';
          draft.livePipeline.revisionBySession[pending.sessionPath] =
            (draft.livePipeline.revisionBySession[pending.sessionPath] ?? 0) + 1;
        }
      });
      return {
        state: next,
        effects: event.ok ? [] : [{
          kind: 'Log', corrId: event.corrId, level: 'error',
          message: 'ExtensionUiResponseResult failed; restored pending prompt',
          data: { hasError: typeof event.error === 'string' && event.error.length > 0 },
        }],
      };
    }
    case 'RecordOutcomeResult':
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
    case 'SetToolResultPruningSettingsResult': {
      if (!event.ok) {
        return {
          state,
          effects: [
            {
              kind: 'Log',
              corrId: event.corrId,
              level: 'error',
              message: `${event.kind} failed`,
              data: { error: event.error },
            },
          ],
        };
      }
      return { state, effects: [] };
    }
    default: {
      // Exhaustiveness: the switch is total over the result kinds routed here.
      // TruncateResult/OpenSessionResult/CreateSessionResult/PersistTabsResult
      // are handled by dedicated handlers in misc-handlers.ts, so they are
      // excluded from this function's param type — and from this switch.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `handleEffectResult: unhandled result kind (type system bypassed?): ${(event as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}
