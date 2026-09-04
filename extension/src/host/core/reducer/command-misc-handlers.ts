import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';
import { mergePruningSettings, mergeSessionTitlesSettings, mergeToolResultPruningSettings, normalizeComposerInitialRows, normalizeNestedAllowedBuckets, normalizeSubagentBucketCanSpawn, normalizeSubagentBuckets, normalizeUiPathParentDepth, type ChatPrefs, type ComposerInput } from '../../../shared/protocol.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { addToArray, appendLocalUserMessage, truncateLocalTranscriptAfter } from './helpers.js';
import { BACKEND_READY_TIMEOUT_MS } from '../../../shared/backend-ready-timeout.js';
import { sessionHasDeferredModelWrite } from './set-model-handlers.js';
import {
  activeInterruptOperation,
  clearRetiredInterruptEventFence,
  retrySessionOperation,
  startSessionOperation,
} from '../operation-registry.js';

export function handleContinue(state: ArchState, cmd: Extract<Command, { kind: 'Continue' }>): ReducerResult {
  if (!cmd.operationId || !cmd.operationSource || cmd.backendGeneration === undefined) {
    return handleContinue(state, {
      ...cmd,
      operationId: cmd.operationId ?? cmd.corrId,
      operationAttempt: cmd.operationAttempt ?? 1,
      operationSource: cmd.operationSource ?? { kind: 'host' },
      backendGeneration: cmd.backendGeneration ?? 0,
    });
  }
  const attempt = cmd.operationAttempt ?? 1;
  const fingerprint = JSON.stringify({ kind: 'message.continue', sessionPath: cmd.sessionPath });
  const unresolved = Object.values(state.operations).find((candidate) =>
    candidate.operationId !== cmd.operationId && !candidate.terminal
    && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === cmd.sessionPath,
  );
  if (unresolved) {
    return {
      state,
      effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'warn', message: `Blocked message.continue while operation ${unresolved.operationId} is unresolved` }],
    };
  }
  const existing = state.operations[cmd.operationId];
  let operation = existing;
  if (existing) {
    if (existing.terminal) return { state, effects: [] };
    if (existing.kind !== 'message.continue'
      || existing.intentFingerprint !== fingerprint
      || existing.backendGeneration !== cmd.backendGeneration
      || (existing.session.resolvedPath ?? existing.session.pendingPath) !== cmd.sessionPath) {
      return {
        state,
        effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'error', message: `Rejected changed message.continue intent for operation ${cmd.operationId}` }],
      };
    }
    operation = retrySessionOperation(existing, {
      kind: 'message.continue', pendingPath: existing.session.pendingPath,
      selectionToken: existing.causal.selectionToken, backendGeneration: cmd.backendGeneration,
      attempt,
    }) ?? existing;
    if (operation === existing) return { state, effects: [] };
  } else {
    operation = startSessionOperation({
      operationId: cmd.operationId,
      kind: 'message.continue',
      source: cmd.operationSource,
      pendingPath: cmd.sessionPath,
      selectionToken: cmd.corrId,
      backendGeneration: cmd.backendGeneration,
      attempt,
      intentFingerprint: fingerprint,
    });
  }
  const nextState = produce(state, (draft) => {
    draft.operations = clearRetiredInterruptEventFence(
      { ...draft.operations, [cmd.operationId!]: operation! },
      cmd.sessionPath,
    );
    draft.sessions.runningSessionPaths = addToArray(draft.sessions.runningSessionPaths, cmd.sessionPath);
    delete draft.pending.prepassBySession[cmd.sessionPath];
  });
  return {
    state: nextState,
    effects: [{
      kind: 'ContinueRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath,
      operationId: cmd.operationId, operationAttempt: attempt, backendGeneration: cmd.backendGeneration,
    }],
  };
}

export function handleInterrupt(state: ArchState, cmd: Extract<Command, { kind: 'Interrupt' }>): ReducerResult {
  if (!cmd.operationId || !cmd.operationSource || cmd.backendGeneration === undefined) {
    return handleInterrupt(state, {
      ...cmd,
      operationId: cmd.operationId ?? cmd.corrId,
      operationAttempt: cmd.operationAttempt ?? 1,
      operationSource: cmd.operationSource ?? { kind: 'host' },
      backendGeneration: cmd.backendGeneration ?? 0,
    });
  }
  const attempt = cmd.operationAttempt ?? 1;
  const fingerprint = JSON.stringify({ kind: 'message.interrupt', sessionPath: cmd.sessionPath });
  const competingStop = activeInterruptOperation(state.operations, cmd.sessionPath);
  const abortSendCorrIds = Object.entries(state.pending.ops)
    .filter(([, pending]) => pending.kind === 'send' && pending.sessionPath === cmd.sessionPath)
    .map(([corrId]) => corrId);
  const cancelQueuedOperationIds = Object.values(state.operations)
    .filter((candidate) => candidate.kind === 'message.edit' && !candidate.terminal
      && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === cmd.sessionPath)
    .map((candidate) => candidate.operationId);
  const usePriorityLane = Object.values(state.operations).some((candidate) =>
    !candidate.terminal
    && candidate.kind !== 'message.send'
    && candidate.kind !== 'message.interrupt'
    && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === cmd.sessionPath,
  );
  if (competingStop && competingStop.operationId !== cmd.operationId) return { state, effects: [] };

  const existing = state.operations[cmd.operationId];
  let operation = existing;
  if (existing) {
    if (existing.terminal) return { state, effects: [] };
    if (existing.kind !== 'message.interrupt' || existing.intentFingerprint !== fingerprint
      || existing.backendGeneration !== cmd.backendGeneration
      || (existing.session.resolvedPath ?? existing.session.pendingPath) !== cmd.sessionPath) {
      return {
        state,
        effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'error', message: `Rejected changed message.interrupt intent for operation ${cmd.operationId}` }],
      };
    }
    operation = retrySessionOperation(existing, {
      kind: 'message.interrupt', pendingPath: existing.session.pendingPath,
      selectionToken: existing.causal.selectionToken, backendGeneration: cmd.backendGeneration, attempt,
    }) ?? existing;
    if (operation === existing) return { state, effects: [] };
  } else {
    operation = startSessionOperation({
      operationId: cmd.operationId,
      kind: 'message.interrupt',
      source: cmd.operationSource,
      pendingPath: cmd.sessionPath,
      selectionToken: cmd.corrId,
      backendGeneration: cmd.backendGeneration,
      attempt,
      intentFingerprint: fingerprint,
    });
  }

  // Freeze the partial reply immediately, but retain running/stopping until the
  // backend's complete settlement barrier (or generation death) is authoritative.
  const nextState = produce(state, (draft) => {
    draft.operations[cmd.operationId!] = operation!;
    delete draft.pending.prepassBySession[cmd.sessionPath];
    const list = draft.transcript.bySession[cmd.sessionPath];
    if (list) {
      for (const message of list) {
        if (message.role === 'assistant' && message.status === 'streaming') message.status = 'interrupted';
      }
    }
  });
  return {
    state: nextState,
    effects: [{
      kind: 'InterruptRpc', corrId: cmd.corrId, operationId: cmd.operationId,
      operationAttempt: attempt, backendGeneration: cmd.backendGeneration, sessionPath: cmd.sessionPath,
      ...(abortSendCorrIds.length > 0 ? { abortSendCorrIds } : {}),
      ...(cancelQueuedOperationIds.length > 0 ? { cancelQueuedOperationIds } : {}),
      ...(usePriorityLane ? { usePriorityLane: true } : {}),
    }],
  };
}

export function handleCompact(state: ArchState, cmd: Extract<Command, { kind: 'Compact' }>): ReducerResult {
  if (!cmd.operationId || !cmd.operationSource || cmd.backendGeneration === undefined) {
    return handleCompact(state, {
      ...cmd,
      operationId: cmd.operationId ?? cmd.corrId,
      operationAttempt: cmd.operationAttempt ?? 1,
      operationSource: cmd.operationSource ?? { kind: 'host' },
      backendGeneration: cmd.backendGeneration ?? 0,
    });
  }
  const attempt = cmd.operationAttempt ?? 1;
  const fingerprint = JSON.stringify({ kind: 'message.compact', sessionPath: cmd.sessionPath, reason: 'manual' });
  const unresolved = Object.values(state.operations).find((candidate) =>
    candidate.operationId !== cmd.operationId && !candidate.terminal
    && (candidate.session.resolvedPath ?? candidate.session.pendingPath) === cmd.sessionPath,
  );
  if (unresolved) {
    return {
      state,
      effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'warn', message: `Blocked message.compact while operation ${unresolved.operationId} is unresolved` }],
    };
  }
  const existing = state.operations[cmd.operationId];
  let operation = existing;
  if (existing) {
    if (existing.terminal) return { state, effects: [] };
    if (existing.kind !== 'message.compact'
      || existing.intentFingerprint !== fingerprint
      || existing.backendGeneration !== cmd.backendGeneration
      || (existing.session.resolvedPath ?? existing.session.pendingPath) !== cmd.sessionPath) {
      return {
        state,
        effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'error', message: `Rejected changed message.compact intent for operation ${cmd.operationId}` }],
      };
    }
    operation = retrySessionOperation(existing, {
      kind: 'message.compact', pendingPath: existing.session.pendingPath,
      selectionToken: existing.causal.selectionToken, backendGeneration: cmd.backendGeneration,
      attempt,
    }) ?? existing;
    if (operation === existing) return { state, effects: [] };
  } else {
    operation = startSessionOperation({
      operationId: cmd.operationId,
      kind: 'message.compact',
      source: cmd.operationSource,
      pendingPath: cmd.sessionPath,
      selectionToken: cmd.corrId,
      backendGeneration: cmd.backendGeneration,
      attempt,
      intentFingerprint: fingerprint,
    });
  }
  const nextState = produce(state, (draft) => {
    draft.operations = clearRetiredInterruptEventFence(
      { ...draft.operations, [cmd.operationId!]: operation! },
      cmd.sessionPath,
    );
    draft.sessions.runningSessionPaths = addToArray(draft.sessions.runningSessionPaths, cmd.sessionPath);
    draft.sessions.compactingSessionPaths = addToArray(draft.sessions.compactingSessionPaths, cmd.sessionPath);
  });
  return {
    state: nextState,
    effects: [{
      kind: 'CompactRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath,
      operationId: cmd.operationId, operationAttempt: attempt, backendGeneration: cmd.backendGeneration,
    }],
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

function sendIntentFingerprint(cmd: Extract<Command, { kind: 'Send' }>): string {
  return JSON.stringify({
    sessionPath: cmd.sessionPath,
    text: cmd.text,
    inputs: cmd.inputs,
    localId: cmd.localId,
  });
}

export function handleSend(state: ArchState, cmd: Extract<Command, { kind: 'Send' }>): ReducerResult {
  // Additive compatibility for internal callers compiled before operation IDs.
  // Production ingress always supplies all four fields.
  if (!cmd.operationId || !cmd.operationSource || cmd.backendGeneration === undefined) {
    return handleSend(state, {
      ...cmd,
      operationId: cmd.operationId ?? cmd.corrId,
      operationAttempt: cmd.operationAttempt ?? 1,
      operationSource: cmd.operationSource ?? { kind: 'host' },
      backendGeneration: cmd.backendGeneration ?? 0,
    });
  }
  const attempt = cmd.operationAttempt ?? 1;
  const intentFingerprint = sendIntentFingerprint(cmd);
  const unresolvedSend = Object.values(state.operations).find((operation) =>
    operation.operationId !== cmd.operationId
    && !operation.terminal
    && ((operation.kind === 'message.send'
      && (operation.phase === 'ambiguous' || operation.commit === 'unknown'))
      || operation.kind === 'message.edit'
      || operation.kind === 'message.interrupt')
    && (operation.session.resolvedPath ?? operation.session.pendingPath) === cmd.sessionPath,
  );
  if (unresolvedSend) {
    return {
      state,
      effects: [{
        kind: 'Log', corrId: cmd.corrId, level: 'warn',
        message: `Blocked message.send while operation ${unresolvedSend.operationId} remains ambiguous`,
      }],
    };
  }
  const existingOperation = state.operations[cmd.operationId];
  if (existingOperation?.terminal) return { state, effects: [] };
  if (existingOperation) {
    const effectivePath = existingOperation.session.resolvedPath ?? existingOperation.session.pendingPath;
    if (existingOperation.kind !== 'message.send'
      || existingOperation.localId !== cmd.localId
      || existingOperation.intentFingerprint !== intentFingerprint
      || effectivePath !== cmd.sessionPath
      || existingOperation.backendGeneration !== cmd.backendGeneration) {
      return {
        state,
        effects: [{
          kind: 'Log', corrId: cmd.corrId, level: 'error',
          message: `Rejected changed message.send intent for operation ${cmd.operationId}`,
        }],
      };
    }
    if (existingOperation.phase === 'ambiguous') {
      const retried = retrySessionOperation(existingOperation, {
        kind: 'message.send',
        pendingPath: existingOperation.session.pendingPath,
        selectionToken: existingOperation.causal.selectionToken,
        backendGeneration: cmd.backendGeneration,
        localId: cmd.localId,
        attempt,
      });
      if (!retried) return { state, effects: [] };
      const owningEntry = Object.entries(state.pending.ops).find(([, pending]) => pending.operationId === cmd.operationId)
        ?? Object.entries(state.pending.promoted).find(([, pending]) => pending.operationId === cmd.operationId);
      const owningCorrId = owningEntry?.[0] ?? existingOperation.causal.selectionToken;
      return {
        state: produce(state, (draft) => {
          draft.operations[cmd.operationId!] = retried;
          const pending = draft.pending.ops[owningCorrId] ?? draft.pending.promoted[owningCorrId];
          if (pending) pending.operationAttempt = retried.attempt;
        }),
        effects: [
          {
            kind: 'ReleaseOperationResources', corrId: owningCorrId,
            operationId: cmd.operationId, operationAttempt: existingOperation.attempt,
          },
          {
            kind: 'SendRpc', corrId: owningCorrId, operationId: cmd.operationId,
            operationAttempt: retried.attempt, backendGeneration: retried.backendGeneration,
            sessionPath: cmd.sessionPath, text: cmd.text, inputs: cmd.inputs,
            localId: cmd.localId, composedText: cmd.composedText, userParts: cmd.userParts,
            priorPruningMode: cmd.priorPruningMode,
          },
        ],
      };
    }
  } else {
    state = {
      ...state,
      operations: {
        ...state.operations,
        [cmd.operationId]: startSessionOperation({
          operationId: cmd.operationId,
          kind: 'message.send',
          source: cmd.operationSource,
          pendingPath: cmd.sessionPath,
          selectionToken: cmd.corrId,
          backendGeneration: cmd.backendGeneration,
          attempt,
          localId: cmd.localId,
          intentFingerprint,
        }),
      },
    };
  }

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
          operationId: cmd.operationId,
          operationAttempt: attempt,
          operationSource: cmd.operationSource,
          backendGeneration: cmd.backendGeneration,
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

  // Queue while the backend is unavailable or while this session still has a
  // deferred model choice to persist. In the latter case no watchdog is needed:
  // SetModelResult releases these sends, guaranteeing the prompt cannot overtake
  // the user's picker choice and run on the old model.
  const blockedByDeferredModel = sessionHasDeferredModelWrite(state, cmd.sessionPath);
  if (!state.settings.backendReady || blockedByDeferredModel) {
    const nextState = produce(state, (draft) => {
      appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString(), 'completed', cmd.customType, cmd.customDetails);
      draft.pending.backendReadyQueueBySession[cmd.sessionPath] = [
        ...(draft.pending.backendReadyQueueBySession[cmd.sessionPath] ?? []),
        {
          sessionPath: cmd.sessionPath,
          corrId: cmd.corrId,
          operationId: cmd.operationId,
          operationAttempt: attempt,
          operationSource: cmd.operationSource,
          backendGeneration: cmd.backendGeneration,
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
      effects: state.settings.backendReady
        ? []
        : [{ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: BACKEND_READY_TIMEOUT_MS }],
    };
  }

  // Reaching this point means Send will execute now rather than merely wait in
  // a host queue. It therefore takes ownership from a successfully retired Stop.
  state = {
    ...state,
    operations: clearRetiredInterruptEventFence(state.operations, cmd.sessionPath),
  };

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
      draft.operations[cmd.operationId!]!.delivery = 'queued';
      draft.pending.ops[cmd.corrId] = {
        kind: 'send',
        operationId: cmd.operationId,
        operationAttempt: attempt,
        sessionPath: cmd.sessionPath,
        localId: cmd.localId,
        previousSummary: cmd.previousSummary,
        text: cmd.text,
        inputs: [...inputsSnapshot],
        startedAt: cmd.timestamp,
        queued: true,
        ...(cmd.priorPruningMode ? { priorPruningMode: cmd.priorPruningMode } : {}),
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
          operationId: cmd.operationId,
          operationAttempt: attempt,
          backendGeneration: cmd.backendGeneration,
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
    draft.operations[cmd.operationId!]!.delivery = 'direct';
    draft.pending.ops[cmd.corrId] = {
      kind: 'send',
      operationId: cmd.operationId,
      operationAttempt: attempt,
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: cmd.previousSummary,
      text: cmd.text,
      inputs: [...inputsSnapshot],
      ...(cmd.priorPruningMode ? { priorPruningMode: cmd.priorPruningMode } : {}),
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
        operationId: cmd.operationId,
        operationAttempt: attempt,
        backendGeneration: cmd.backendGeneration,
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

export function handleEditQueued(state: ArchState, cmd: Extract<Command, { kind: 'EditQueued' }>): ReducerResult {
  const queuedMessages = (state.transcript.bySession[cmd.sessionPath] ?? []).filter(
    (message) => message.role === 'user' && message.status === 'queued',
  );
  if (!queuedMessages.some((message) => message.id === cmd.messageId)) {
    return { state, effects: [] };
  }

  const pendingFor = (localId: string) => Object.values(state.pending.ops).find(
    (op) => op.queued && op.sessionPath === cmd.sessionPath && op.localId === localId,
  ) ?? Object.values(state.pending.promoted).find(
    (op) => op.queued && op.sessionPath === cmd.sessionPath && op.localId === localId,
  );

  const fallbackMessages = queuedMessages.map((message) => {
    const pending = pendingFor(message.id);
    return pending?.text !== undefined
      ? { localId: message.id, text: pending.text, inputs: pending.inputs ?? [] }
      : null;
  });
  if (fallbackMessages.some((message) => message === null)) {
    return {
      state,
      effects: [{
        kind: 'Log', corrId: cmd.corrId, level: 'error',
        message: `Cannot edit queued message ${cmd.messageId}: queue metadata is incomplete`,
      }],
    };
  }

  const original = fallbackMessages as Array<{ localId: string; text: string; inputs: ComposerInput[] }>;
  const messages = original.map((message) => message.localId === cmd.messageId
    ? { localId: message.localId, text: cmd.text, inputs: cmd.inputs }
    : message);

  return {
    state,
    effects: [{
      kind: 'ReplaceQueueRpc',
      corrId: cmd.corrId,
      sessionPath: cmd.sessionPath,
      messageId: cmd.messageId,
      text: cmd.text,
      inputs: cmd.inputs,
      composedText: cmd.composedText,
      userParts: cmd.userParts,
      messages,
      fallbackMessages: original,
    }],
  };
}

export function handleEdit(state: ArchState, cmd: Extract<Command, { kind: 'Edit' }>): ReducerResult {
  if (!cmd.operationId || !cmd.operationSource || cmd.backendGeneration === undefined) {
    return handleEdit(state, {
      ...cmd,
      operationId: cmd.operationId ?? cmd.corrId,
      operationAttempt: cmd.operationAttempt ?? 1,
      operationSource: cmd.operationSource ?? { kind: 'host' },
      backendGeneration: cmd.backendGeneration ?? 0,
    });
  }
  const attempt = cmd.operationAttempt ?? 1;
  const fingerprint = JSON.stringify({
    kind: 'message.edit', sessionPath: cmd.sessionPath, entryId: cmd.messageId,
    text: cmd.text, inputs: cmd.inputs, localId: cmd.localId,
  });
  const unresolved = Object.values(state.operations).find((operation) =>
    operation.operationId !== cmd.operationId && !operation.terminal
    && (operation.kind === 'message.edit' || operation.kind === 'message.interrupt'
      || operation.phase === 'ambiguous' || operation.commit === 'unknown')
    && (operation.session.resolvedPath ?? operation.session.pendingPath) === cmd.sessionPath,
  );
  if (unresolved) {
    return {
      state,
      effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'warn', message: `Blocked message.edit while operation ${unresolved.operationId} is unresolved` }],
    };
  }
  const existing = state.operations[cmd.operationId];
  let operation = existing;
  if (existing) {
    if (existing.terminal) return { state, effects: [] };
    if (existing.kind !== 'message.edit' || existing.intentFingerprint !== fingerprint
      || existing.backendGeneration !== cmd.backendGeneration
      || existing.localId !== cmd.localId
      || (existing.session.resolvedPath ?? existing.session.pendingPath) !== cmd.sessionPath) {
      return {
        state,
        effects: [{ kind: 'Log', corrId: cmd.corrId, level: 'error', message: `Rejected changed message.edit intent for operation ${cmd.operationId}` }],
      };
    }
    operation = retrySessionOperation(existing, {
      kind: 'message.edit', pendingPath: existing.session.pendingPath,
      selectionToken: existing.causal.selectionToken, backendGeneration: cmd.backendGeneration,
      localId: cmd.localId, attempt,
    }) ?? existing;
    if (operation === existing) return { state, effects: [] };
    // A transport retry reuses the original optimistic owner and rollback
    // snapshot. Re-applying truncation here would erase the pre-edit tail.
    return {
      state: produce(state, (draft) => {
        draft.operations = clearRetiredInterruptEventFence(
          { ...draft.operations, [cmd.operationId!]: operation! },
          cmd.sessionPath,
        );
        draft.sessions.runningSessionPaths = addToArray(draft.sessions.runningSessionPaths, cmd.sessionPath);
      }),
      effects: [{
        kind: 'EditRpc', corrId: cmd.corrId, operationId: cmd.operationId!,
        operationAttempt: operation.attempt, backendGeneration: operation.backendGeneration,
        sessionPath: cmd.sessionPath, messageId: cmd.messageId, text: cmd.text,
        localId: cmd.localId, composedText: cmd.composedText, inputs: cmd.inputs, userParts: cmd.userParts,
      }],
    };
  } else {
    operation = startSessionOperation({
      operationId: cmd.operationId,
      kind: 'message.edit',
      source: cmd.operationSource,
      pendingPath: cmd.sessionPath,
      selectionToken: cmd.corrId,
      backendGeneration: cmd.backendGeneration,
      attempt,
      localId: cmd.localId,
      intentFingerprint: fingerprint,
    });
  }

  const nextRunningPaths = addToArray(state.sessions.runningSessionPaths, cmd.sessionPath);
  const nextState = produce(state, (draft) => {
    draft.operations = clearRetiredInterruptEventFence(
      { ...draft.operations, [cmd.operationId!]: operation! },
      cmd.sessionPath,
    );
    draft.transcript.editingMessageIdBySession[cmd.sessionPath] = null;
    delete draft.transcript.editingDraftBySession[cmd.sessionPath];
    delete draft.transcript.deferredWindowReplacementBySession[cmd.sessionPath];
    const removedTail = truncateLocalTranscriptAfter(draft, cmd.sessionPath, cmd.messageId);
    appendLocalUserMessage(draft, cmd.sessionPath, cmd.localId, cmd.composedText, cmd.userParts, new Date(cmd.timestamp).toISOString());
    draft.pending.ops[cmd.corrId] = {
      kind: 'edit',
      operationId: cmd.operationId,
      sessionPath: cmd.sessionPath,
      localId: cmd.localId,
      previousSummary: null,
      startedAt: cmd.timestamp,
      removedTail,
      editDraft: { messageId: cmd.messageId, text: cmd.text, inputs: [...cmd.inputs] },
    };
    draft.sessions.runningSessionPaths = nextRunningPaths;
    delete draft.pending.prepassBySession[cmd.sessionPath];
  });

  return {
    state: nextState,
    effects: [{
      kind: 'EditRpc', corrId: cmd.corrId, operationId: cmd.operationId,
      operationAttempt: attempt, backendGeneration: cmd.backendGeneration,
      sessionPath: cmd.sessionPath, messageId: cmd.messageId, text: cmd.text,
      localId: cmd.localId, composedText: cmd.composedText, inputs: cmd.inputs, userParts: cmd.userParts,
    }],
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

export function handleDismissNotice(state: ArchState, _cmd: Extract<Command, { kind: 'DismissNotice' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      draft.settings.notice = null;
      draft.settings.noticeKind = null;
      draft.settings.noticeRaw = null;
      draft.settings.noticeSessionPath = null;
      draft.settings.latestIncident = null;
    }),
    effects: [],
  };
}

export function handleRespondExtensionUI(state: ArchState, cmd: Extract<Command, { kind: 'RespondExtensionUI' }>): ReducerResult {
  return {
    state: produce(state, (draft) => {
      const sessionMap = draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
      const request = sessionMap?.[cmd.requestId];
      const priorPhase = draft.livePipeline.turnsBySession[cmd.sessionPath]?.phase;
      if (request) {
        draft.pending.extensionUiResponseByCorrId[cmd.corrId] = {
          sessionPath: cmd.sessionPath,
          request,
          priorPhase,
        };
      }
      if (sessionMap) {
        delete sessionMap[cmd.requestId];
        if (Object.keys(sessionMap).length === 0) {
          delete draft.settings.pendingExtensionUIRequestsBySession[cmd.sessionPath];
        }
      }
      const turn = draft.livePipeline.turnsBySession[cmd.sessionPath];
      if (turn) {
        turn.pendingExtensionUiRequestIds = turn.pendingExtensionUiRequestIds.filter((id) => id !== cmd.requestId);
        if (turn.phase === 'waiting_input' && turn.pendingExtensionUiRequestIds.length === 0) {
          turn.phase = 'running_tool';
        }
        draft.livePipeline.revisionBySession[cmd.sessionPath] =
          (draft.livePipeline.revisionBySession[cmd.sessionPath] ?? 0) + 1;
      }
    }),
    effects: [
      { kind: 'ExtensionUiResponseRpc', corrId: cmd.corrId, sessionPath: cmd.sessionPath, response: cmd.response },
    ],
  };
}

export function handleSetPrivacyMode(state: ArchState, cmd: Extract<Command, { kind: 'SetPrivacyMode' }>): ReducerResult {
  // Pending create/duplicate sentinels are not durable sessions. Ignore a
  // privacy intent for them rather than racing session.create and later losing
  // the mode during pending-path replacement.
  if (!cmd.sessionPath || isPendingTabPath(cmd.sessionPath)) return { state, effects: [] };
  const nextState = produce(state, (draft) => {
    if (cmd.enabled) draft.sessions.privacyModeBySession[cmd.sessionPath] = true;
    else delete draft.sessions.privacyModeBySession[cmd.sessionPath];
  });
  const effects = [
    { kind: 'SetPrivacyMode' as const, corrId: cmd.corrId, sessionPath: cmd.sessionPath, enabled: cmd.enabled },
    ...(cmd.persist === false ? [] : [{
      kind: 'PersistTabs' as const,
      corrId: cmd.corrId,
      openTabPaths: nextState.sessions.openTabPaths,
      activeSessionPath: nextState.sessions.activeSessionPath,
      pinnedTabPaths: nextState.sessions.pinnedTabPaths,
      pinnedTabGroups: nextState.sessions.pinnedTabGroups,
      privateSessionPaths: Object.entries(nextState.sessions.privacyModeBySession)
        .filter(([, enabled]) => enabled)
        .map(([sessionPath]) => sessionPath),
    }]),
  ];
  return { state: nextState, effects };
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
    ...(cmd.prefs.subagentProviderDefaults && {
      subagentProviderDefaults: {
        ...current.subagentProviderDefaults,
        ...cmd.prefs.subagentProviderDefaults,
      },
    }),
    ...(cmd.prefs.subagentProviderTogglesBySession && {
      subagentProviderTogglesBySession: {
        ...current.subagentProviderTogglesBySession,
        ...cmd.prefs.subagentProviderTogglesBySession,
      },
    }),
    // Normalize subagentBuckets so ArchState always holds a complete
    // {small,medium,frontier} object even if a caller dispatches a partial
    // patch (validateChatPrefsPatch permits missing bucket keys). Without
    // this, a partial patch would leave e.g. `subagentBuckets.small`
    // undefined and crash the webview BucketModelsEditor.
    ...(cmd.prefs.subagentBuckets !== undefined && {
      subagentBuckets: normalizeSubagentBuckets(cmd.prefs.subagentBuckets),
    }),
    ...(cmd.prefs.composerInitialRows !== undefined && {
      composerInitialRows: normalizeComposerInitialRows(cmd.prefs.composerInitialRows),
    }),
    ...(cmd.prefs.uiPathParentDepth !== undefined && {
      uiPathParentDepth: normalizeUiPathParentDepth(cmd.prefs.uiPathParentDepth),
    }),
    // Normalize subagentNestedAllowedBuckets so ArchState always holds a
    // complete {small,medium,frontier} object (missing keys default to true)
    // even if a caller dispatches a partial patch.
    ...(cmd.prefs.subagentNestedAllowedBuckets !== undefined && {
      subagentNestedAllowedBuckets: normalizeNestedAllowedBuckets(cmd.prefs.subagentNestedAllowedBuckets),
    }),
    // The per-bucket delegation policy is also a complete fail-open map so
    // partial preference patches cannot accidentally turn unspecified tiers
    // into leaves.
    ...(cmd.prefs.subagentBucketCanSpawn !== undefined && {
      subagentBucketCanSpawn: normalizeSubagentBucketCanSpawn(cmd.prefs.subagentBucketCanSpawn),
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

export function handleMcpListRequested(state: ArchState, cmd: Extract<Command, { kind: 'McpListRequested' }>): ReducerResult {
  return {
    state: {
      ...state,
      settings: { ...state.settings, mcpServersStatus: 'loading' },
    },
    effects: [{
      kind: 'McpListRpc',
      corrId: cmd.corrId,
      // Hydrate the active session's persisted per-server override set after
      // publishing the independently fetched global rows.
      ...(state.sessions.activeSessionPath !== null ? { sessionPath: state.sessions.activeSessionPath } : {}),
    }],
  };
}

export function handleMcpSetServerEnabled(state: ArchState, cmd: Extract<Command, { kind: 'McpSetServerEnabled' }>): ReducerResult {
  return {
    state: {
      ...state,
      settings: { ...state.settings, mcpServersStatus: 'loading' },
    },
    effects: [{ kind: 'McpSetServerRpc', corrId: cmd.corrId, name: cmd.name, enabled: cmd.enabled }],
  };
}

/** Session-scoped server toggle: merge the desired flag into the session's
 *  host-owned override set, then ask the backend to write the artifact and
 *  (when the session is idle) recycle its worker so the adapter applies the
 *  set at the next session start. A busy session keeps state-only here and
 *  gains the pending hint; the same effect retries on the next idle
 *  transition. */
export function handleMcpSetServerEnabledForSession(state: ArchState, cmd: Extract<Command, { kind: 'McpSetServerEnabledForSession' }>): ReducerResult {
  const previous = state.settings.mcpSessionOverridesBySession[cmd.sessionPath] ?? {};
  const overrides: Record<string, boolean> = { ...previous, [cmd.name]: !cmd.enabled };
  const recycle = !state.sessions.runningSessionPaths.includes(cmd.sessionPath);
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        // Authoritative once the backend answers, but a sync of the same map
        // keeps the UI immediately responsive.
        mcpSessionOverridesBySession: {
          ...state.settings.mcpSessionOverridesBySession,
          [cmd.sessionPath]: overrides,
        },
        mcpPendingApplyBySession: {
          ...state.settings.mcpPendingApplyBySession,
          [cmd.sessionPath]: false,
        },
      },
    },
    effects: [{
      kind: 'McpSetSessionServerRpc',
      corrId: cmd.corrId,
      sessionPath: cmd.sessionPath,
      overrides,
      recycle,
    }],
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

export function handleSetSessionTitlesSettings(state: ArchState, cmd: Extract<Command, { kind: 'SetSessionTitlesSettings' }>): ReducerResult {
  // Option B: apply optimistically for instant UI. The service keeps its
  // catch+mirror+notice (graceful degradation when PI_CODING_AGENT_DIR is
  // absent), so SetSessionTitlesSettingsResult is always {ok:true} and no
  // snapshot/revert is needed. mergeSessionTitlesSettings matches the
  // disk-write merge so optimistic state == persisted state.
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        sessionTitlesSettings: mergeSessionTitlesSettings(state.settings.sessionTitlesSettings, cmd.settings),
      },
    },
    effects: [
      {
        kind: 'SetSessionTitlesSettings',
        corrId: cmd.corrId,
        settings: cmd.settings,
      },
    ],
  };
}
