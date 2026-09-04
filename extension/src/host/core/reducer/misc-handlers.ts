import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';
import {
  markSessionOperationAmbiguous,
  observeSessionOperationAcknowledgement,
  retrySessionOperation,
  settleSessionOperationFailed,
  settleSessionOperationSucceeded,
} from '../operation-registry.js';

export function handleTruncateResult(state: ArchState, event: Extract<Event, { kind: 'TruncateResult' }>): ReducerResult {
  if (event.ok) return { state, effects: [] };
  return {
    state: {
      ...state,
      settings: {
        ...state.settings,
        notice: 'Could not delete the transcript from this point. The session was not changed.',
        noticeKind: 'operational-error',
        noticeRaw: event.error ?? 'session.truncateAfter failed without an error message',
        noticeSessionPath: event.sessionPath,
      },
    },
    effects: [],
  };
}

export function handleCreateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'CreateSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleDuplicateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'DuplicateSessionResult' }>): ReducerResult {
  // No-op: recovery is host-driven via `handleSelectionFailure` (which
  // dispatches SessionScopeCleared + SelectSession-fallback + NoticeShown to
  // undo the optimistic setup), mirroring CreateSession/OpenSession. The result
  // event exists only to complete the Command→reducer→Effect→runner→Result
  // spine; the reducer has no pending snapshot to reconcile.
  return { state, effects: [] };
}

export const OPEN_SESSION_RECONCILIATION_MAX_ATTEMPTS = 3;
const OPEN_SESSION_RECONCILIATION_BASE_DELAY_MS = 1_000;

export function handleOpenSessionResult(state: ArchState, event: Extract<Event, { kind: 'OpenSessionResult' }>): ReducerResult {
  if (!event.operationId) return { state, effects: [] };
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'session.open' || operation.terminal
    || operation.session.pendingPath !== event.sessionPath
    || (event.backendGeneration !== undefined && operation.backendGeneration !== event.backendGeneration)) {
    return { state, effects: [] };
  }
  const observation = {
    pendingPath: operation.session.pendingPath,
    attempt: event.operationAttempt,
    backendGeneration: event.backendGeneration,
  };
  const updated = event.ambiguous
    ? markSessionOperationAmbiguous(operation, observation, 'reconcile')
    : event.ok
      ? settleSessionOperationSucceeded(operation, { ...observation, resolvedPath: event.sessionPath })
      : settleSessionOperationFailed(operation, {
          ...observation,
          reason: 'definitive-rejection',
          detail: event.error,
        });
  if (!updated) return { state, effects: [] };
  return {
    state: { ...state, operations: { ...state.operations, [event.operationId]: updated } },
    effects: event.ambiguous ? [{
      kind: 'ScheduleOpenSessionReconciliation',
      corrId: `open-reconcile-timer:${event.operationId}:${updated.attempt}`,
      operationId: event.operationId,
      sessionPath: event.sessionPath,
      operationAttempt: updated.attempt,
      backendGeneration: updated.backendGeneration,
      delayMs: OPEN_SESSION_RECONCILIATION_BASE_DELAY_MS * (2 ** (updated.attempt - 1)),
    }] : [],
  };
}

export function handleOpenSessionReconciliationDue(
  state: ArchState,
  event: Extract<Event, { kind: 'OpenSessionReconciliationDue' }>,
): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'session.open' || operation.terminal
    || operation.phase !== 'ambiguous'
    || operation.session.pendingPath !== event.sessionPath
    || operation.backendGeneration !== event.backendGeneration
    || operation.attempt !== event.operationAttempt) {
    return { state, effects: [] };
  }

  if (operation.attempt < OPEN_SESSION_RECONCILIATION_MAX_ATTEMPTS) {
    const retried = retrySessionOperation(operation, {
      kind: 'session.open',
      pendingPath: operation.session.pendingPath,
      selectionToken: operation.causal.selectionToken,
      backendGeneration: operation.backendGeneration,
      attempt: operation.attempt + 1,
    });
    if (!retried) return { state, effects: [] };
    return {
      state: {
        ...state,
        operations: { ...state.operations, [event.operationId]: retried },
      },
      effects: [{
        kind: 'OpenSession',
        corrId: `open-reconcile:${event.operationId}:${retried.attempt}`,
        sessionPath: retried.session.pendingPath,
        selectionToken: retried.causal.selectionToken,
        operationId: retried.operationId,
        operationAttempt: retried.attempt,
        backendGeneration: retried.backendGeneration,
      }],
    };
  }

  const detail = `Session open acknowledgement remained ambiguous after ${operation.attempt} attempts.`;
  const failed = settleSessionOperationFailed(operation, {
    pendingPath: operation.session.pendingPath,
    attempt: operation.attempt,
    backendGeneration: operation.backendGeneration,
    reason: 'execution-failed',
    detail,
    preserveCommit: true,
    recovery: 'retry',
  });
  if (!failed) return { state, effects: [] };
  return {
    state: {
      ...state,
      operations: { ...state.operations, [event.operationId]: failed },
    },
    effects: [{
      kind: 'RecoverOpenSession',
      corrId: `open-recover:${event.operationId}:${operation.attempt}`,
      selectionToken: operation.causal.selectionToken,
      operationAttempt: operation.attempt,
      notice: 'The session could not be confirmed after repeated read-only retries. Please open it again.',
    }],
  };
}

export function handleCloseSessionResult(state: ArchState, event: Extract<Event, { kind: 'CloseSessionResult' }>): ReducerResult {
  return observeCloseAcknowledgement(state, event.operationId, event.backendGeneration, 'cleanup', event.ok, event.error);
}

export function handlePersistTabsResult(state: ArchState, event: Extract<Event, { kind: 'PersistTabsResult' }>): ReducerResult {
  return observeCloseAcknowledgement(
    state,
    event.operationId,
    event.backendGeneration,
    event.acknowledgementKey ?? 'persist-tabs',
    event.ok,
    event.error,
  );
}

function observeCloseAcknowledgement(
  state: ArchState,
  operationId: string | undefined,
  backendGeneration: number | undefined,
  acknowledgement: 'persist-tabs' | 'cleanup' | 'privacy-marker-removal',
  ok: boolean,
  error?: string,
): ReducerResult {
  if (!operationId) return { state, effects: [] };
  const operation = state.operations[operationId];
  if (!operation || operation.kind !== 'session.close'
    || operation.backendGeneration !== backendGeneration) return { state, effects: [] };
  const updated = observeSessionOperationAcknowledgement(operation, acknowledgement, ok, error);
  if (!updated) return { state, effects: [] };
  return { state: { ...state, operations: { ...state.operations, [operationId]: updated } }, effects: [] };
}

export function handleBackendRestartDrainCompleted(
  state: ArchState,
  event: Extract<Event, { kind: 'BackendRestartDrainCompleted' }>,
): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'backend.restart' || operation.terminal
    || operation.backendGeneration !== event.backendGeneration
    || operation.phase !== 'draining') return { state, effects: [] };
  return {
    state: {
      ...state,
      operations: {
        ...state.operations,
        [event.operationId]: {
          ...operation,
          phase: 'awaiting-old-generation-death',
          acceptance: 'accepted',
        },
      },
    },
    effects: [],
  };
}

export function handleBackendRestartOldGenerationDied(
  state: ArchState,
  event: Extract<Event, { kind: 'BackendRestartOldGenerationDied' }>,
): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'backend.restart' || operation.terminal
    || operation.backendGeneration !== event.backendGeneration
    || operation.phase !== 'awaiting-old-generation-death') return { state, effects: [] };
  const operations = { ...state.operations };
  for (const [operationId, candidate] of Object.entries(operations)) {
    if (candidate.kind !== 'session.open' || candidate.terminal
      || candidate.backendGeneration !== event.backendGeneration) continue;
    const ended = settleSessionOperationFailed(candidate, {
      pendingPath: candidate.session.pendingPath,
      backendGeneration: event.backendGeneration,
      reason: 'backend-generation-ended',
      preserveCommit: candidate.commit === 'unknown',
    });
    if (ended) operations[operationId] = ended;
  }
  operations[event.operationId] = {
    ...operation,
    phase: 'awaiting-commit',
    commit: 'committed',
    recovery: 'reconcile',
  };
  return {
    state: { ...state, operations },
    effects: [],
  };
}

export function handleBackendRestartResult(
  state: ArchState,
  event: Extract<Event, { kind: 'BackendRestartResult' }>,
): ReducerResult {
  const operation = state.operations[event.operationId];
  if (!operation || operation.kind !== 'backend.restart' || operation.terminal
    || operation.backendGeneration !== event.backendGeneration) return { state, effects: [] };
  const updated = event.ok
    ? settleSessionOperationSucceeded(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: event.backendGeneration,
      })
    : settleSessionOperationFailed(operation, {
        pendingPath: operation.session.pendingPath,
        backendGeneration: event.backendGeneration,
        reason: 'execution-failed',
        detail: event.error,
        preserveCommit: operation.commit === 'committed',
        recovery: 'restart-backend',
      });
  if (!updated) return { state, effects: [] };
  const recorded = event.replacementBackendGeneration !== undefined
    ? { ...updated, replacementBackendGeneration: event.replacementBackendGeneration }
    : updated;
  return { state: { ...state, operations: { ...state.operations, [event.operationId]: recorded } }, effects: [] };
}
