import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Effect } from '../effects.js';
import type { ReducerResult } from './helpers.js';
import {
  addToArray,
  appendLocalUserMessage,
  mergeRejectedComposerInputs,
  mergeRejectedDraftText,
  removeFromArray,
  removeMessage,
  restoreRemovedTail,
} from './helpers.js';
import type { Event, EffectResultEvent } from '../events.js';
import {
  applySetModelOptimistic,
  dropSetModelPending,
  finishDeferredSetModelReplay,
  queueDeferredSetModel,
  revertSetModel,
  sessionHasDeferredModelWrite,
} from './set-model-handlers.js';
import { mapSendOrEditError, mapPreflightError, stripReqIds } from '../../../shared/error-mapping.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
import { handleFileRevertResult } from './file-handlers.js';
import { interruptLivePipelineForSession } from './live-pipeline-handlers.js';
import type { SessionOperation } from '../operation-types.js';
import {
  markSessionOperationAccepted,
  markSessionOperationAmbiguous,
  settleSessionOperationCancelled,
  settleSessionOperationFailed,
  settleSessionOperationSucceeded,
} from '../operation-registry.js';

const OPERATION_RECONCILIATION_MAX_ATTEMPTS = 4;
const OPERATION_RECONCILIATION_BASE_DELAY_MS = 1_000;

function beginOperationReconciliation(operation: SessionOperation, delayMs: number): {
  operation: SessionOperation;
  effect: Effect;
} {
  const reconciling: SessionOperation = {
    ...operation,
    reconciliation: { attempts: 0, maxAttempts: OPERATION_RECONCILIATION_MAX_ATTEMPTS },
  };
  return {
    operation: reconciling,
    effect: {
      kind: 'ScheduleOperationReconciliation',
      corrId: operation.causal.selectionToken,
      operationId: operation.operationId,
      operationKind: operation.kind as Extract<SessionOperation['kind'], `message.${string}`>,
      sessionPath: operation.session.resolvedPath ?? operation.session.pendingPath,
      backendGeneration: operation.backendGeneration,
      operationAttempt: operation.attempt,
      reconciliationAttempt: 1,
      delayMs,
    },
  };
}

function releaseOperationResourcesEffect(operation: SessionOperation): Effect {
  return {
    kind: 'ReleaseOperationResources', corrId: operation.causal.selectionToken,
    operationId: operation.operationId, operationAttempt: operation.attempt,
  };
}

export function handleContinueResult(state: ArchState, event: Extract<Event, { kind: 'ContinueResult' }>): ReducerResult {
  const operationId = event.operationId ?? Object.values(state.operations).find(
    (operation) => operation.kind === 'message.continue'
      && operation.causal.selectionToken === event.corrId,
  )?.operationId;
  const operation = operationId ? state.operations[operationId] : undefined;
  if (!operation || operation.kind !== 'message.continue' || operation.terminal
    || (operation.acceptance === 'accepted' && operation.reconciliation)
    || (event.backendGeneration !== undefined && operation.backendGeneration !== event.backendGeneration)) {
    return { state, effects: [] };
  }
  const cancelledBeforeStart = !event.ok && event.error?.includes('SESSION_OPERATION_CANCELLED');
  let updated = event.ok
    ? markSessionOperationAccepted(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: event.backendGeneration,
      })
    : cancelledBeforeStart
      ? settleSessionOperationCancelled(operation, {
          pendingPath: operation.session.pendingPath,
          attempt: event.operationAttempt,
          backendGeneration: event.backendGeneration,
          outcome: 'cancelled',
          reason: 'interrupted-before-commit',
          detail: event.error,
        })
      : settleSessionOperationFailed(operation, {
          pendingPath: operation.session.pendingPath,
          attempt: event.operationAttempt,
          backendGeneration: event.backendGeneration,
          reason: 'definitive-rejection',
          detail: event.error,
        });
  if (!updated) return { state, effects: [] };
  let reconciliationEffect: Effect | undefined;
  if (event.ok) {
    const reconciliation = beginOperationReconciliation(updated, OPERATION_RECONCILIATION_BASE_DELAY_MS);
    updated = reconciliation.operation;
    reconciliationEffect = reconciliation.effect;
  }
  return {
    state: produce(state, (draft) => {
      draft.operations[operationId!] = updated;
      if (!event.ok) {
        if (!event.error?.includes('REQUEST_IN_PROGRESS')) {
          draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
        }
        if (updated.terminal?.outcome !== 'cancelled') {
          draft.settings.notice = 'Could not continue the interrupted response.';
          draft.settings.noticeKind = 'operational-error';
          draft.settings.noticeRaw = event.error ?? 'message.continue failed';
          draft.settings.noticeSessionPath = event.sessionPath;
        }
      }
    }),
    effects: event.ok ? [reconciliationEffect!] : [
      {
        kind: 'Log',
        corrId: event.corrId,
        level: 'error',
        message: `Continuation failed for session ${event.sessionPath}`,
        data: { error: event.error },
      },
      releaseOperationResourcesEffect(operation),
    ],
  };
}

export function handleInterruptResult(state: ArchState, event: Extract<Event, { kind: 'InterruptResult' }>): ReducerResult {
  const operationId = event.operationId ?? Object.values(state.operations).find(
    (operation) => operation.kind === 'message.interrupt' && operation.causal.selectionToken === event.corrId,
  )?.operationId;
  const operation = operationId ? state.operations[operationId] : undefined;
  if (!operation || operation.kind !== 'message.interrupt' || operation.terminal
    || (event.backendGeneration !== undefined && operation.backendGeneration !== event.backendGeneration)) {
    return { state, effects: [] };
  }
  const authoritativeSettlement = event.ok && event.settled !== false;
  let updated = authoritativeSettlement
    ? settleSessionOperationSucceeded(operation, {
        pendingPath: operation.session.pendingPath,
        resolvedPath: event.sessionPath,
        backendGeneration: event.backendGeneration,
      })
    : event.ok
      ? markSessionOperationAccepted(operation, {
          pendingPath: operation.session.pendingPath,
          backendGeneration: event.backendGeneration,
          committed: event.committed,
        })
      : settleSessionOperationFailed(operation, {
          pendingPath: operation.session.pendingPath,
          attempt: event.operationAttempt,
          backendGeneration: event.backendGeneration,
          reason: 'definitive-rejection',
          detail: event.error,
          committed: event.committed,
        });
  if (!updated) return { state, effects: [] };
  let reconciliationEffect: Effect | undefined;
  if (event.ok && !updated.terminal) {
    const reconciliation = beginOperationReconciliation(updated, OPERATION_RECONCILIATION_BASE_DELAY_MS);
    updated = reconciliation.operation;
    reconciliationEffect = reconciliation.effect;
  }

  const lifecycleState = updated.terminal?.outcome === 'settled'
    ? interruptLivePipelineForSession(state, event.sessionPath, event.occurredAt ?? 0).state
    : state;
  const nextState = produce(lifecycleState, (draft) => {
    draft.operations[operationId!] = updated;
    if (!updated.terminal) return;
    if (updated.terminal.outcome === 'settled') {
      draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
      const list = draft.transcript.bySession[event.sessionPath];
      if (list) {
        draft.transcript.bySession[event.sessionPath] = list.filter((message) => !(message.role === 'user' && message.status === 'queued'));
      }
      for (const candidate of Object.values(draft.operations)) {
        const candidatePath = candidate.session.resolvedPath ?? candidate.session.pendingPath;
        if (candidate.kind !== 'message.send' || candidate.terminal || candidatePath !== event.sessionPath) continue;
        const cancelled = settleSessionOperationCancelled(candidate, {
          pendingPath: candidate.session.pendingPath,
          backendGeneration: candidate.backendGeneration,
          outcome: 'cancelled', reason: 'interrupted-before-commit',
        });
        if (cancelled) draft.operations[candidate.operationId] = cancelled;
      }
      for (const collection of [draft.pending.ops, draft.pending.promoted]) {
        for (const [corrId, pending] of Object.entries(collection)) {
          if (pending.sessionPath !== event.sessionPath) continue;
          const owner = pending.operationId ? draft.operations[pending.operationId] : undefined;
          if (!pending.queued && !(owner?.kind === 'message.send' && owner.terminal)) continue;
          if (pending.requestId) delete draft.pending.requestIdToLocalId[pending.requestId];
          delete collection[corrId];
        }
      }
      draft.sessions.compactingSessionPaths = removeFromArray(draft.sessions.compactingSessionPaths, event.sessionPath);
    } else {
      draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, event.sessionPath);
    }
  });
  return {
    state: nextState,
    effects: updated.terminal
      ? [
          releaseOperationResourcesEffect(operation),
          ...(!event.ok ? [{
            kind: 'Log' as const, corrId: event.corrId, level: 'error' as const,
            message: `Interrupt failed for session ${event.sessionPath}`, data: { error: event.error },
          }] : []),
        ]
      : [reconciliationEffect!],
  };
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
          for (const operation of Object.values(draft.operations)) {
            if (operation.kind !== 'message.send' || operation.terminal
              || operation.delivery !== 'queued'
              || (operation.session.resolvedPath ?? operation.session.pendingPath) !== event.sessionPath) continue;
            const settled = settleSessionOperationCancelled(operation, {
              pendingPath: operation.session.pendingPath,
              backendGeneration: operation.backendGeneration,
              outcome: 'cancelled',
              reason: 'queue-cleared',
            });
            if (settled) draft.operations[operation.operationId] = settled;
          }
          draft.transcript.editingMessageIdBySession[event.sessionPath] = null;
          delete draft.transcript.deferredWindowReplacementBySession[event.sessionPath];
          draft.settings.notice = 'The queued messages could not be restored and were cleared. Re-send them if they are still needed.';
          draft.settings.noticeKind = 'operational-error';
          draft.settings.noticeRaw = event.error;
          draft.settings.noticeSessionPath = event.sessionPath;
        } else if (event.error?.includes('QUEUE_CHANGED')) {
          // queuedDelivered will authoritatively promote/move the row when its
          // event lane drains. Close the stale editor now and explain that the
          // original message already crossed the delivery boundary.
          draft.transcript.editingMessageIdBySession[event.sessionPath] = null;
          delete draft.transcript.deferredWindowReplacementBySession[event.sessionPath];
          draft.settings.notice = 'That queued message already started, so its edit was not applied.';
          draft.settings.noticeKind = 'edit-failed';
          draft.settings.noticeRaw = event.error;
          draft.settings.noticeSessionPath = event.sessionPath;
        } else if (mapped) {
          draft.settings.notice = mapped.message;
          draft.settings.noticeKind = mapped.kind;
          draft.settings.noticeRaw = event.error ?? null;
          draft.settings.noticeSessionPath = event.sessionPath;
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
      delete draft.transcript.deferredWindowReplacementBySession[event.sessionPath];
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
  return {
    state: produce(state, (draft) => {
      for (const operation of Object.values(draft.operations)) {
        if (operation.kind !== 'message.send' || operation.terminal
          || operation.delivery !== 'queued'
          || (operation.session.resolvedPath ?? operation.session.pendingPath) !== event.sessionPath) continue;
        const settled = settleSessionOperationCancelled(operation, {
          pendingPath: operation.session.pendingPath,
          backendGeneration: operation.backendGeneration,
          outcome: 'cancelled',
          reason: 'queue-cleared',
        });
        if (settled) draft.operations[operation.operationId] = settled;
      }
    }),
    effects: [],
  };
}

export function handleSendResult(state: ArchState, event: Extract<Event, { kind: 'SendResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId];
  if (!pending) return { state, effects: [] };
  const operationId = event.operationId ?? pending.operationId;
  const operation = operationId ? state.operations[operationId] : undefined;
  if (operation?.kind === 'message.send'
    && event.operationAttempt !== undefined
    && event.operationAttempt !== operation.attempt) return { state, effects: [] };
  if (event.operationAttempt !== undefined && pending.operationAttempt !== undefined
    && event.operationAttempt !== pending.operationAttempt) return { state, effects: [] };

  const { [event.corrId]: _removed, ...restOps } = state.pending.ops;

  if (event.ok) {
    // Early-ack success is acceptance, not commit. The rollback snapshot moves
    // to `pending.promoted` so a definitive pre-commit failure can restore it.
    // (`PreflightFailed`) can still roll back via `promoted[corrId]`. The
    // snapshot is dropped at the commit point (first `MessageStarted` for the
    // requestId) — see STATE_CONTRACT § Optimistic Reconciliation "Two failure
    // windows for send".
    const nextState = produce(state, (draft) => {
      draft.pending.ops = restOps;
      const operationId = event.operationId ?? pending.operationId;
      const operation = operationId ? draft.operations[operationId] : undefined;
      if (operation?.kind === 'message.send') {
        // A ledger-derived acknowledgement is paired with a
        // SendOperationStatus event, which exclusively owns lifecycle and
        // bounded reconciliation. This result only promotes rollback/request
        // ownership; it must not regress an exhausted or still-reconciling op.
        const accepted = event.reconciled
          ? operation
          : markSessionOperationAccepted(operation, {
              pendingPath: operation.session.pendingPath,
              backendGeneration: event.backendGeneration,
            });
        if (accepted) {
          accepted.delivery = event.queued ? 'queued' : 'direct';
          if (!event.reconciled) delete accepted.reconciliation;
          if (event.queued) delete accepted.executionPhase;
          draft.operations[operationId!] = accepted;
        }
      }
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
    const effects: Effect[] = event.queued ? [{
      kind: 'ClearSendTimer', corrId: event.corrId,
      ...(pending.priorPruningMode ? { restorePruningMode: pending.priorPruningMode } : {}),
    }] : [];
    return { state: nextState, effects };
  }

  // Failure: rollback optimistic message, notify user, restore session name
  // Also clear the busy state we set optimistically in the Send command handler.
  const restoredDraftText = mergeRejectedDraftText(
    pending.text ?? '',
    state.composer.draftTextBySession[pending.sessionPath],
  );
  const restoredInputs = mergeRejectedComposerInputs(
    pending.inputs,
    state.composer.pendingComposerInputsBySession[pending.sessionPath],
  );
  const effects: Effect[] = [
    {
      kind: 'ClearSendTimer', corrId: event.corrId,
      ...(pending.priorPruningMode ? { restorePruningMode: pending.priorPruningMode } : {}),
    },
    ...(pending.operationId && state.operations[pending.operationId]
      ? [releaseOperationResourcesEffect(state.operations[pending.operationId]!)]
      : []),
    {
      kind: 'PostImperative',
      corrId: event.corrId,
      imperativeMessage: {
        type: 'sendRejected',
        sessionPath: pending.sessionPath,
        text: restoredDraftText,
        localId: pending.localId,
        inputs: restoredInputs,
      },
    },
  ];

  const nextState = produce(state, (draft) => {
    draft.pending.ops = restOps;
    const operationId = event.operationId ?? pending.operationId;
    const operation = operationId ? draft.operations[operationId] : undefined;
    if (operation?.kind === 'message.send') {
      const settled = settleSessionOperationFailed(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: event.backendGeneration,
        reason: 'definitive-rejection',
        detail: event.error,
      });
      if (settled) draft.operations[operationId!] = settled;
    }
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
    const hiddenFirstRun = Object.values(draft.operations).find(
      (operation) => operation.terminal?.outcome === 'settled'
        && operation.hidden
        && operation.session.resolvedPath === pending.sessionPath,
    );
    const hasRemainingSend = Object.values(restOps).some(
      (operation) => operation.sessionPath === pending.sessionPath,
    );
    if (hiddenFirstRun && !hasRemainingSend
      && !draft.sessions.runningSessionPaths.includes(pending.sessionPath)) {
      draft.sessions.intentionallyHiddenRunningPaths = removeFromArray(
        draft.sessions.intentionallyHiddenRunningPaths,
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
      draft.settings.noticeSessionPath = pending.sessionPath;
    }
    // Restore composer inputs from the send-time snapshot so a retry can
    // re-send them (no data loss). Inputs were cleared at send time (handleSend);
    // the pre-ack failure must hand them back. Mirrors the post-ack
    // `handlePreflightFailed` restore from `pending.promoted[corrId].inputs`.
    draft.composer.draftTextBySession[pending.sessionPath] = restoredDraftText;
    if (restoredInputs.length > 0) {
      draft.composer.pendingComposerInputsBySession[pending.sessionPath] = restoredInputs;
    }
    // Brief F: the send was rejected before the prepass ran — clear any
    // prepass chip (idle).
    delete draft.pending.prepassBySession[pending.sessionPath];
    // Restore session summary if we had one.
    if (pending.previousSummary) {
      delete draft.sessions.titleGenerationBySession[pending.sessionPath];
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
  if (snapshot && event.operationId && snapshot.operationId !== event.operationId) {
    corrId = undefined;
    snapshot = undefined;
    source = undefined;
  }
  if (!snapshot && event.operationId) {
    const promotedEntry = Object.entries(state.pending.promoted).find(([, op]) =>
      op.operationId === event.operationId && op.sessionPath === event.sessionPath,
    );
    const pendingEntry = promotedEntry ?? Object.entries(state.pending.ops).find(([, op]) =>
      op.operationId === event.operationId && op.sessionPath === event.sessionPath && !op.queued,
    );
    if (pendingEntry) {
      [corrId, snapshot] = pendingEntry;
      source = promotedEntry ? 'promoted' : 'ops';
    }
  }
  if (!snapshot && !event.operationId) {
    for (const [cid, op] of Object.entries(state.pending.promoted)) {
      if (op.requestId === event.requestId) {
        corrId = cid;
        snapshot = op;
        source = 'promoted';
        break;
      }
    }
  }
  if (!snapshot && !event.operationId) {
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
  const correlatedOperation = snapshot.operationId ? state.operations[snapshot.operationId] : undefined;
  if (correlatedOperation?.kind === 'message.send'
    && event.operationAttempt !== undefined
    && event.operationAttempt !== correlatedOperation.attempt) return { state, effects: [] };

  // A replacement preflight event carrying this edit's stable operation ID can
  // only originate from the freshly promoted worker, after the atomic truncate.
  // It may outrun the coordinator acknowledgement on the event lane, so treat
  // that identity as destructive-commit evidence rather than restoring stale
  // history. Existing unknown/committed registry evidence covers legacy events
  // that did not carry operationId.
  if (snapshot.kind === 'edit' && snapshot.operationId) {
    const operation = state.operations[snapshot.operationId];
    const replacementStartProvesCommit = event.operationId === snapshot.operationId;
    if (operation?.kind === 'message.edit'
      && (replacementStartProvesCommit
        || operation.commit === 'committed'
        || operation.commit === 'unknown')) {
      const failed = handleEditResult(state, {
        kind: 'EditResult', corrId, operationId: snapshot.operationId,
        backendGeneration: operation.backendGeneration, sessionPath: snapshot.sessionPath,
        ok: false,
        ...(replacementStartProvesCommit || operation.commit === 'committed'
          ? { committed: true }
          : {}),
        error: event.error,
      });
      return {
        state: failed.state,
        effects: [...failed.effects, {
          kind: 'ClearSendTimer', corrId,
          ...(snapshot.priorPruningMode ? { restorePruningMode: snapshot.priorPruningMode } : {}),
        }],
      };
    }
  }

  const { [corrId]: _removedPromoted, ...restPromoted } = state.pending.promoted;
  const { [corrId]: _removedOp, ...restOps } = state.pending.ops;

  // Backend-originated failures have no corrId and must clear the runner's
  // timer even when they beat the RPC ack. A timer-originated failure already
  // carries corrId and is deliberately left in the runner so a genuinely late
  // commit can emit PreflightSuperseded.
  const restoredDraftText = snapshot.kind === 'send'
    ? mergeRejectedDraftText(
      snapshot.text ?? '',
      state.composer.draftTextBySession[snapshot.sessionPath],
    )
    : '';
  const restoredInputs = snapshot.kind === 'send'
    ? mergeRejectedComposerInputs(
      snapshot.inputs,
      state.composer.pendingComposerInputsBySession[snapshot.sessionPath],
    )
    : [];
  const effects: Effect[] = event.corrId ? [] : [{
    kind: 'ClearSendTimer', corrId,
    ...(snapshot.priorPruningMode ? { restorePruningMode: snapshot.priorPruningMode } : {}),
  }];
  if (snapshot.kind === 'send') {
    effects.push({
      kind: 'PostImperative',
      corrId,
      imperativeMessage: {
        type: 'sendRejected',
        sessionPath: snapshot.sessionPath,
        text: restoredDraftText,
        localId: snapshot.localId,
        inputs: restoredInputs,
      },
    });
  }

  const nextState = produce(state, (draft) => {
    if (source === 'promoted') draft.pending.promoted = restPromoted;
    else draft.pending.ops = restOps;
    const operationId = event.operationId ?? snapshot.operationId;
    const operation = operationId ? draft.operations[operationId] : undefined;
    if (operation?.kind === 'message.send') {
      const settled = settleSessionOperationFailed(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: operation.backendGeneration,
        reason: 'definitive-rejection',
        detail: event.error,
      });
      if (settled) draft.operations[operationId!] = settled;
    }
    // Remove optimistic user message from transcript
    removeMessage(draft, snapshot.sessionPath, snapshot.localId);
    // Edit rollback (post-ack setup failure): restore the messages truncated
    // by the optimistic Edit command. Send ops have no removedTail.
    if (snapshot.kind === 'edit' && snapshot.removedTail && snapshot.removedTail.length > 0) {
      restoreRemovedTail(draft, snapshot.sessionPath, snapshot.removedTail);
    }
    if (snapshot.kind === 'edit' && snapshot.editDraft) {
      draft.transcript.editingMessageIdBySession[snapshot.sessionPath] = snapshot.editDraft.messageId;
      draft.transcript.editingDraftBySession[snapshot.sessionPath] = {
        ...snapshot.editDraft,
        inputs: [...snapshot.editDraft.inputs],
      };
    }
    // Clear the host-side optimistic running state set at Send time
    draft.sessions.runningSessionPaths = removeFromArray(
      draft.sessions.runningSessionPaths,
      snapshot.sessionPath,
    );
    const hiddenFirstRun = Object.values(draft.operations).find(
      (operation) => operation.terminal?.outcome === 'settled'
        && operation.hidden
        && operation.session.resolvedPath === snapshot.sessionPath,
    );
    const hasRemainingSend = Object.values(restOps).some((operation) => operation.sessionPath === snapshot.sessionPath)
      || Object.values(restPromoted).some((operation) => operation.sessionPath === snapshot.sessionPath);
    if (hiddenFirstRun && !hasRemainingSend) {
      draft.sessions.intentionallyHiddenRunningPaths = removeFromArray(
        draft.sessions.intentionallyHiddenRunningPaths,
        snapshot.sessionPath,
      );
    }
    // The send will never stream — drop its requestId→localId mapping
    if (event.requestId) {
      delete draft.pending.requestIdToLocalId[event.requestId];
    }
    // Restore composer inputs from the promoted snapshot so a retry can re-send
    // them (no data loss). Brief C wires the webview-side restore.
    if (snapshot.kind === 'send') {
      draft.composer.draftTextBySession[snapshot.sessionPath] = restoredDraftText;
    }
    if (restoredInputs.length > 0) {
      draft.composer.pendingComposerInputsBySession[snapshot.sessionPath] = restoredInputs;
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
    draft.settings.noticeSessionPath = snapshot.sessionPath;
    // Restore session summary if the optimistic send had renamed it
    if (snapshot.previousSummary) {
      delete draft.sessions.titleGenerationBySession[snapshot.sessionPath];
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

    if (
      draft.settings.noticeSessionPath === sessionPath
      && (draft.settings.noticeKind === 'prepass-timeout' || draft.settings.noticeKind === 'model-start-timeout')
    ) {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = null;
    }
  });

  return { state: nextState, effects: [] };
}

export function handleEditResult(state: ArchState, event: Extract<Event, { kind: 'EditResult' }>): ReducerResult {
  const pending = state.pending.ops[event.corrId] ?? state.pending.promoted[event.corrId];
  const operationId = event.operationId ?? pending?.operationId;
  const operation = operationId ? state.operations[operationId] : undefined;
  if (!pending || (operation && (operation.kind !== 'message.edit' || operation.terminal
    || (event.ok && operation.acceptance === 'accepted'
      && (operation.reconciliation !== undefined || operation.commit === 'committed'))
    || (event.backendGeneration !== undefined && operation.backendGeneration !== event.backendGeneration)))) {
    return { state, effects: [] };
  }

  if (event.ok) {
    let accepted = operation ? markSessionOperationAccepted(operation, {
      pendingPath: operation.session.pendingPath,
      backendGeneration: event.backendGeneration,
      committed: event.committed,
    }) : undefined;
    if (operation && !accepted) return { state, effects: [] };
    let resourceEffect: Effect | undefined;
    if (accepted && operation) {
      if (event.committed === true) {
        resourceEffect = releaseOperationResourcesEffect(operation);
      } else {
        const reconciliation = beginOperationReconciliation(accepted, OPERATION_RECONCILIATION_BASE_DELAY_MS);
        accepted = reconciliation.operation;
        resourceEffect = reconciliation.effect;
      }
    }
    return {
      state: produce(state, (draft) => {
        if (accepted && operationId) draft.operations[operationId] = accepted;
        delete draft.pending.ops[event.corrId];
        draft.pending.promoted[event.corrId] = {
          ...pending,
          ...(event.requestId ? { requestId: event.requestId } : {}),
        };
        if (draft.pending.prepassBySession[pending.sessionPath]?.phase !== 'succeeded') {
          draft.pending.prepassBySession[pending.sessionPath] = { phase: 'running', latencyMs: null };
        }
      }),
      effects: resourceEffect ? [resourceEffect] : [],
    };
  }

  const destructiveCommit = event.committed === true
    || (event.committed === undefined
      && (operation?.commit === 'committed' || operation?.commit === 'unknown'));
  const failed = operation ? settleSessionOperationFailed(operation, {
    pendingPath: operation.session.pendingPath,
    attempt: event.operationAttempt,
    backendGeneration: event.backendGeneration,
    reason: destructiveCommit ? 'execution-failed' : 'definitive-rejection',
    detail: event.error,
    committed: event.committed,
    preserveCommit: destructiveCommit,
  }) : undefined;
  if (operation && !failed) return { state, effects: [] };

  return {
    state: produce(state, (draft) => {
      if (failed && operationId) draft.operations[operationId] = failed;
      delete draft.pending.ops[event.corrId];
      delete draft.pending.promoted[event.corrId];
      if (!destructiveCommit) {
        removeMessage(draft, pending.sessionPath, pending.localId);
        if (pending.removedTail?.length) restoreRemovedTail(draft, pending.sessionPath, pending.removedTail);
        if (pending.editDraft) {
          draft.transcript.editingMessageIdBySession[pending.sessionPath] = pending.editDraft.messageId;
          draft.transcript.editingDraftBySession[pending.sessionPath] = {
            ...pending.editDraft, inputs: [...pending.editDraft.inputs],
          };
        }
      }
      draft.sessions.runningSessionPaths = removeFromArray(draft.sessions.runningSessionPaths, pending.sessionPath);
      delete draft.pending.prepassBySession[pending.sessionPath];
      const mapped = mapSendOrEditError(event.error, 'edit');
      if (mapped) {
        draft.settings.notice = destructiveCommit
          ? 'The edit was saved, but its replacement response could not start.'
          : mapped.message;
        draft.settings.noticeKind = mapped.kind;
        draft.settings.noticeRaw = event.error ?? null;
        draft.settings.noticeSessionPath = pending.sessionPath;
      }
    }),
    effects: operation ? [releaseOperationResourcesEffect(operation)] : [],
  };
}

function releaseModelBlockedSends(
  result: ReducerResult,
  sessionPath: string | null,
  corrId: string,
): ReducerResult {
  if (!sessionPath || sessionHasDeferredModelWrite(result.state, sessionPath)) return result;
  const heldSends = result.state.pending.backendReadyQueueBySession[sessionPath] ?? [];
  if (heldSends.length === 0) return result;
  const releasedState = produce(result.state, (draft) => {
    delete draft.pending.backendReadyQueueBySession[sessionPath];
  });
  return {
    state: releasedState,
    effects: [
      ...result.effects,
      {
        kind: 'DrainBackendReadyQueue',
        corrId: `drain:model-ready:${corrId}`,
        entries: heldSends,
      },
    ],
  };
}

export function handleSetModelResult(state: ArchState, event: Extract<Event, { kind: 'SetModelResult' }>): ReducerResult {
  const pending = state.pending.setModelByCorrId[event.corrId];
  let reconciled = !pending
    ? state
    : event.ok
      ? dropSetModelPending(state, event.corrId)
      : revertSetModel(state, event.corrId, event.error);

  // A user may make a newer choice for the same session while this deferred
  // write is in flight. If the older write fails, its optimistic badge has
  // just rolled back, so the queued choice must use that restored truth as its
  // own baseline rather than the failed optimistic value.
  if (pending && !event.ok && reconciled.pending.deferredSetModelBySession[pending.sessionPath]) {
    reconciled = produce(reconciled, (draft) => {
      const queued = draft.pending.deferredSetModelBySession[pending.sessionPath];
      if (!queued) return;
      const summary = draft.sessions.sessions.find((item) => item.path === pending.sessionPath);
      queued.previousModelId = summary?.modelId;
      queued.previousProvider = summary?.provider;
      queued.previousThinkingLevel = summary?.thinkingLevel;
    });
  }

  // Deferred writes run one at a time across sessions because settings.set
  // also owns the global default. A stale result remains a no-op unless it is
  // the completion signal for that ordered replay slot.
  const completedSessionPath = pending?.sessionPath
    ?? (state.pending.deferredSetModelInFlightCorrId === event.corrId
      ? state.pending.deferredSetModelInFlightSessionPath
      : null);
  const finished = finishDeferredSetModelReplay(reconciled, event.corrId);
  return releaseModelBlockedSends(finished, completedSessionPath, event.corrId);
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
    // User declined (or dismissed). A normal modal only drops its intent. A
    // modal discovered during deferred replay also owns the ordered replay
    // slot, so cancellation must release that slot and any model-blocked sends.
    const dropped = dropSetModelPending(state, event.corrId);
    if (state.pending.deferredSetModelInFlightCorrId !== event.corrId) {
      return { state: dropped, effects: [] };
    }
    const finished = finishDeferredSetModelReplay(dropped, event.corrId);
    return releaseModelBlockedSends(finished, pending.sessionPath, event.corrId);
  }
  // The target may still be a host-only placeholder, or the backend may have
  // become unavailable while the confirmation was open. Keep the confirmed
  // choice visible and replay it later without asking a second time.
  const anotherModelWriteIsInFlight = Object.entries(state.pending.setModelByCorrId)
    .some(([corrId, entry]) => corrId !== event.corrId && entry.snapshot !== null);
  if (isPendingTabPath(pending.sessionPath)
    || !state.settings.backendReady
    || anotherModelWriteIsInFlight
    || (state.pending.deferredSetModelInFlightCorrId !== null
      && state.pending.deferredSetModelInFlightCorrId !== event.corrId)) {
    let queued = queueDeferredSetModel(
      state,
      event.corrId,
      pending.sessionPath,
      pending.modelSettings,
      true,
    );
    // If backend/path availability changed while a deferred replay modal was
    // open, this intent has returned to the ordered queue. Release its old
    // replay slot so readiness/path resolution can start it again.
    if (state.pending.deferredSetModelInFlightCorrId === event.corrId) {
      queued = produce(queued, (draft) => {
        draft.pending.deferredSetModelInFlightCorrId = null;
        draft.pending.deferredSetModelInFlightSessionPath = null;
      });
    }
    return { state: queued, effects: [] };
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
        // This field is projected to renderers and can be copied from the
        // notice details. Internal request correlation ids stay in host logs.
        noticeRaw: stripReqIds(event.error ?? 'runtimePrefs.set failed'),
        noticeSessionPath: null,
      },
    },
    effects: [],
  };
}

/** Backend answered `mcp.list` / `mcp.setServerEnabled`. The response is
 *  authoritative: on success replace the server list and record whether a
 *  toggle still awaits a session reload / backend restart to apply. A plain
 *  list read (or a no-op toggle) does not reload the adapter, so the
 *  pending-apply flag is preserved unless the response carries a new value.
 *  A failed fetch/toggle keeps the cached list and flag and surfaces the
 *  error state so the UI offers a Refresh instead of pretending there are
 *  no servers. */
export function handleMcpServersUpdated(state: ArchState, event: Extract<Event, { kind: 'McpServersUpdated' }>): ReducerResult {
  if (event.ok === false) {
    return {
      state: {
        ...state,
        settings: { ...state.settings, mcpServersStatus: 'error' },
      },
      effects: [],
    };
  }
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        mcpServers: event.servers ?? state.settings.mcpServers,
        // Session hydration is a second, session-queued read. It must not mask
        // a failed or still-loading global discovery request.
        mcpServersStatus: event.servers !== undefined ? 'ok' : state.settings.mcpServersStatus,
        mcpPendingApply: event.pendingApply ?? state.settings.mcpPendingApply,
        // Opportunistic hydration from a session-scoped list read (only when
        // the initiating RPC included a sessionPath).
        ...(event.sessionPath !== undefined && event.sessionOverrides !== undefined
          ? {
              mcpSessionOverridesBySession: {
                ...state.settings.mcpSessionOverridesBySession,
                [event.sessionPath]: event.sessionOverrides,
              },
            }
          : {}),
      },
    },
    effects: [],
  };
}

/** Session-scoped toggle answered. On success replace the session's
 *  authoritative override set; `recycled: false` means the adapter has not
 *  seen the artifact yet (busy/cold), so the session keeps its pending hint
 *  until the next idle recycle or session reload. A failure leaves both maps
 *  untouched (the command's optimistic state keeps the UI responsive — the
 *  backend write failing is surfaced by the same pending hint). */
export function handleMcpSessionServersUpdated(state: ArchState, event: Extract<Event, { kind: 'McpSessionServersUpdated' }>): ReducerResult {
  if (event.ok === false) {
    return {
      state: {
        ...state,
        settings: {
          ...state.settings,
          mcpPendingApplyBySession: {
            ...state.settings.mcpPendingApplyBySession,
            [event.sessionPath]: true,
          },
        },
      },
      effects: [],
    };
  }
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        mcpSessionOverridesBySession: {
          ...state.settings.mcpSessionOverridesBySession,
          [event.sessionPath]: event.overrides ?? {},
        },
        mcpPendingApplyBySession: {
          ...state.settings.mcpPendingApplyBySession,
          [event.sessionPath]: event.recycled === true ? false : true,
        },
      },
    },
    effects: [],
  };
}

export function handleEffectResult(state: ArchState, event: Exclude<EffectResultEvent, { kind: 'TruncateResult' } | { kind: 'ClearQueueResult' } | { kind: 'ReplaceQueueResult' } | { kind: 'OpenSessionResult' } | { kind: 'CreateSessionResult' } | { kind: 'DuplicateSessionResult' } | { kind: 'CloseSessionResult' } | { kind: 'PersistTabsResult' } | { kind: 'BackendRestartResult' } | { kind: 'ModelSwitchConfirmResult' } | { kind: 'LiveTurnCheckpointResult' }>): ReducerResult {
  switch (event.kind) {
    case 'ContinueResult':
      return handleContinueResult(state, event);
    case 'InterruptResult':
      return handleInterruptResult(state, event);
    case 'CompactResult': {
      const operationId = event.operationId ?? Object.values(state.operations).find(
        (operation) => operation.kind === 'message.compact'
          && operation.causal.selectionToken === event.corrId,
      )?.operationId;
      const operation = operationId ? state.operations[operationId] : undefined;
      if (!operation || operation.kind !== 'message.compact' || operation.terminal
        || (event.backendGeneration !== undefined && operation.backendGeneration !== event.backendGeneration)) {
        return { state, effects: [] };
      }
      const cancelledBeforeStart = !event.ok && (
        event.error?.includes('SESSION_OPERATION_CANCELLED')
        || event.error?.includes('MESSAGE_COMPACT_ABORTED')
      );
      const definitivelyRejectedBeforeStart = !event.ok && [
        'REQUEST_IN_PROGRESS',
        'SESSION_NOT_FOUND',
        'SESSION_TRANSITION_TIMEOUT',
        'OPERATION_INTENT_MISMATCH',
      ].some((code) => event.error?.includes(code));
      let updated = event.ok
        ? settleSessionOperationSucceeded(operation, {
            pendingPath: operation.session.pendingPath,
            resolvedPath: event.sessionPath,
            backendGeneration: event.backendGeneration,
          })
        : cancelledBeforeStart
          ? settleSessionOperationCancelled(operation, {
              pendingPath: operation.session.pendingPath,
              attempt: event.operationAttempt,
              backendGeneration: event.backendGeneration,
              outcome: 'cancelled',
              reason: 'interrupted-before-commit',
              detail: event.error,
            })
          : definitivelyRejectedBeforeStart
            ? settleSessionOperationFailed(operation, {
                pendingPath: operation.session.pendingPath,
                attempt: event.operationAttempt,
                backendGeneration: event.backendGeneration,
                reason: 'definitive-rejection',
                detail: event.error,
              })
            : markSessionOperationAmbiguous(operation, {
                pendingPath: operation.session.pendingPath,
                attempt: event.operationAttempt,
                backendGeneration: event.backendGeneration,
              }, 'reconcile');
      if (!updated) return { state, effects: [] };
      let resourceEffect: Effect;
      if (updated.terminal) {
        resourceEffect = releaseOperationResourcesEffect(operation);
      } else {
        const reconciliation = beginOperationReconciliation(updated, 0);
        updated = reconciliation.operation;
        resourceEffect = reconciliation.effect;
      }
      return {
        state: produce(state, (draft) => {
          draft.operations[operationId!] = updated;
          if (!event.ok && updated.terminal) {
            draft.sessions.compactingSessionPaths = removeFromArray(
              draft.sessions.compactingSessionPaths,
              event.sessionPath,
            );
            if (!event.error?.includes('REQUEST_IN_PROGRESS')) {
              draft.sessions.runningSessionPaths = removeFromArray(
                draft.sessions.runningSessionPaths,
                event.sessionPath,
              );
            }
            if (updated.terminal.outcome !== 'cancelled') {
              draft.settings.notice = 'Could not compact this conversation.';
              draft.settings.noticeKind = 'operational-error';
              draft.settings.noticeRaw = event.error ?? 'message.compact failed';
              draft.settings.noticeSessionPath = event.sessionPath;
            }
          } else if (!event.ok) {
            draft.settings.notice = 'History compaction acknowledgement was delayed. Pie is reconciling this operation; do not retry it.';
            draft.settings.noticeKind = null;
            draft.settings.noticeRaw = null;
            draft.settings.noticeSessionPath = event.sessionPath;
          }
        }),
        effects: [resourceEffect],
      };
    }
    case 'SendResult':
      return handleSendResult(state, event);
    case 'EditResult':
      return handleEditResult(state, event);
    case 'FileDiffResult':
      return { state, effects: [] };
    case 'FileRevertResult':
      return handleFileRevertResult(state, event);
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
    case 'SessionTitleResult': {
      const generation = state.sessions.titleGenerationBySession[event.sessionPath];
      if (!generation || generation.status !== 'pending' || generation.corrId !== event.corrId) {
        return { state, effects: [] };
      }
      const next = produce(state, (draft) => {
        if (event.ok && event.generated && event.name) {
          const summary = draft.sessions.sessions.find((session) => session.path === event.sessionPath);
          if (summary?.isPlaceholder === true) {
            summary.name = event.name;
            summary.isPlaceholder = false;
          }
          delete draft.sessions.titleGenerationBySession[event.sessionPath];
        } else {
          draft.sessions.titleGenerationBySession[event.sessionPath] = {
            status: 'failed',
            prompt: generation.prompt,
          };
        }
      });
      const failed = !event.ok || !event.generated;
      return {
        state: next,
        effects: failed ? [{
          kind: 'Log',
          corrId: event.corrId,
          level: 'warn',
          message: 'Session title generation fell back to the prompt snippet',
          data: { reason: event.reason, error: event.error },
        }] : [],
      };
    }
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
    case 'SetToolResultPruningSettingsResult':
    case 'SetSessionTitlesSettingsResult': {
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
