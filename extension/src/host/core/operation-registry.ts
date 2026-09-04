import type {
  SessionOperation,
  SessionOperationKind,
  SessionOperationRecovery,
  SessionOperationSource,
  SessionOperationTerminalReason,
} from './operation-types.js';

function operationSessionPath(operation: SessionOperation): string {
  return operation.session.resolvedPath ?? operation.session.pendingPath;
}

/** Return the reducer-owned Stop operation which still owns this session. */
export function activeInterruptOperation(
  operations: Readonly<Record<string, SessionOperation>>,
  sessionPath: string,
): SessionOperation | undefined {
  return Object.values(operations).find((operation) =>
    operation.kind === 'message.interrupt'
      && !operation.terminal
      && operationSessionPath(operation) === sessionPath,
  );
}

/** True after a successful Stop barrier until genuine new execution starts. */
export function hasRetiredInterruptEventFence(
  operations: Readonly<Record<string, SessionOperation>>,
  sessionPath: string,
): boolean {
  return Object.values(operations).some((operation) =>
    operation.kind === 'message.interrupt'
      && operation.retiredEventFence === true
      && operationSessionPath(operation) === sessionPath,
  );
}

/** Purely retire stale-event fences when a new execution command takes over. */
export function clearRetiredInterruptEventFence(
  operations: Readonly<Record<string, SessionOperation>>,
  sessionPath: string,
): Record<string, SessionOperation> {
  let next: Record<string, SessionOperation> | undefined;
  for (const [operationId, operation] of Object.entries(operations)) {
    if (operation.kind !== 'message.interrupt'
      || operation.retiredEventFence !== true
      || operationSessionPath(operation) !== sessionPath) continue;
    next ??= { ...operations };
    const { retiredEventFence: _retiredEventFence, ...cleared } = operation;
    next[operationId] = cleared;
  }
  return next ?? operations as Record<string, SessionOperation>;
}

export interface StartSessionOperation {
  operationId: string;
  kind: SessionOperationKind;
  source: SessionOperationSource;
  pendingPath: string;
  sourcePath?: string;
  selectionToken: string;
  parentOperationId?: string | null;
  backendGeneration: number;
  workerGeneration?: number;
  sessionId?: string;
  branchId?: string;
  attempt?: number;
  cwd?: string;
  localId?: string;
  intentFingerprint?: string;
}

/** Create a first-attempt lifecycle record. */
export function startSessionOperation(input: StartSessionOperation): SessionOperation {
  return {
    operationId: input.operationId,
    kind: input.kind,
    source: input.source,
    session: {
      pendingPath: input.pendingPath,
      ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    },
    causal: {
      parentOperationId: input.parentOperationId ?? null,
      selectionToken: input.selectionToken,
    },
    backendGeneration: input.backendGeneration,
    ...(input.workerGeneration !== undefined ? { workerGeneration: input.workerGeneration } : {}),
    attempt: input.attempt ?? 1,
    phase: 'awaiting-acceptance',
    acceptance: 'pending',
    commit: 'pending',
    recovery: null,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.localId !== undefined ? { localId: input.localId } : {}),
    ...(input.intentFingerprint !== undefined ? { intentFingerprint: input.intentFingerprint } : {}),
    ...(input.kind === 'message.send' ? { delivery: 'pending' as const } : {}),
    ...(input.kind === 'message.send' || input.kind === 'message.edit'
      ? { executionPhase: 'prepass' as const }
      : {}),
  };
}

/** Host lifecycle identity is immutable for one operationId, including the
 * selection correlation. The backend fingerprint separately excludes
 * selection metadata so a completed mutation can be safely re-published. */
export function matchesSessionOperationIntent(
  operation: SessionOperation,
  input: Pick<StartSessionOperation, 'kind' | 'pendingPath' | 'sourcePath' | 'selectionToken' | 'backendGeneration' | 'cwd' | 'localId'>,
): boolean {
  return operation.kind === input.kind
    && operation.session.pendingPath === input.pendingPath
    && operation.session.sourcePath === input.sourcePath
    && operation.causal.selectionToken === input.selectionToken
    && operation.backendGeneration === input.backendGeneration
    && operation.cwd === input.cwd
    && operation.localId === input.localId;
}

/** Observe one required host acknowledgement. Completion is reducer-owned and
 * independent of effect completion order. No acknowledgement can immutable-
 * terminalize the operation until the complete barrier is known: a failure may
 * arrive before a later success crosses an irreversible commit boundary. */
export function observeSessionOperationAcknowledgement(
  operation: SessionOperation,
  acknowledgement: string,
  ok: boolean,
  detail?: string,
): SessionOperation | null {
  if (operation.terminal || !operation.acknowledgements
    || operation.acknowledgements[acknowledgement] === undefined
    || operation.acknowledgements[acknowledgement] !== 'pending') return null;
  const acknowledgements = {
    ...operation.acknowledgements,
    [acknowledgement]: ok ? 'succeeded' as const : 'failed' as const,
  };
  const acknowledgementErrors = !ok && detail !== undefined
    ? { ...operation.acknowledgementErrors, [acknowledgement]: detail }
    : operation.acknowledgementErrors;
  const acknowledgementStates = Object.values(acknowledgements);
  const allObserved = acknowledgementStates.every((state) => state !== 'pending');
  const anySucceeded = acknowledgementStates.some((state) => state === 'succeeded');
  if (!allObserved) {
    return {
      ...operation,
      acknowledgements,
      ...(acknowledgementErrors ? { acknowledgementErrors } : {}),
      phase: 'awaiting-commit',
      acceptance: anySucceeded ? 'accepted' : operation.acceptance,
      commit: anySucceeded ? 'committed' : operation.commit,
      recovery: anySucceeded ? 'reconcile' : operation.recovery,
    };
  }
  const failure = acknowledgementStates.some((state) => state === 'failed');
  if (failure) {
    const recovery = anySucceeded ? 'reconcile' as const : 'none' as const;
    return {
      ...operation,
      acknowledgements,
      ...(acknowledgementErrors ? { acknowledgementErrors } : {}),
      phase: 'settled',
      commit: anySucceeded ? 'committed' : 'not-committed',
      recovery: null,
      terminal: {
        outcome: 'failed',
        reason: 'execution-failed',
        recovery,
        ...(Object.values(acknowledgementErrors ?? {})[0] !== undefined
          ? { detail: Object.values(acknowledgementErrors ?? {})[0] }
          : {}),
      },
    };
  }
  return settleSessionOperationSucceeded({ ...operation, acknowledgements }, {
    pendingPath: operation.session.pendingPath,
    resolvedPath: operation.session.resolvedPath ?? operation.session.pendingPath,
    backendGeneration: operation.backendGeneration,
  });
}

/** Retry an ambiguous waiter without changing operation or mutation identity. */
export function retrySessionOperation(
  operation: SessionOperation,
  input: Pick<StartSessionOperation, 'kind' | 'pendingPath' | 'sourcePath' | 'selectionToken' | 'backendGeneration' | 'cwd' | 'localId'> & { attempt?: number },
): SessionOperation | null {
  if (operation.terminal || operation.phase !== 'ambiguous') return null;
  if (!matchesSessionOperationIntent(operation, input)) return null;
  const nextAttempt = input.attempt ?? operation.attempt + 1;
  if (nextAttempt !== operation.attempt + 1) return null;
  const { reconciliation: _reconciliation, ...base } = operation;
  return {
    ...base,
    attempt: nextAttempt,
    phase: 'awaiting-acceptance',
    acceptance: 'pending',
    // A retry cannot erase uncertainty about a prior request crossing commit.
    commit: operation.commit === 'pending' ? 'pending' : 'unknown',
    recovery: null,
  };
}

export interface SessionOperationObservation {
  pendingPath: string;
  attempt?: number;
  backendGeneration?: number;
}

function matchesObservation(
  operation: SessionOperation,
  observation: SessionOperationObservation,
  requireAttempt: boolean,
): boolean {
  return operation.session.pendingPath === observation.pendingPath
    && (observation.backendGeneration === undefined
      || operation.backendGeneration === observation.backendGeneration)
    && (!requireAttempt || observation.attempt === undefined || operation.attempt === observation.attempt);
}

export function markSessionOperationAmbiguous(
  operation: SessionOperation,
  observation: SessionOperationObservation,
  recovery: Extract<SessionOperationRecovery, 'retry' | 'reconcile'> = 'retry',
): SessionOperation | null {
  if (operation.terminal || !matchesObservation(operation, observation, true)) return null;
  return {
    ...operation,
    phase: 'ambiguous',
    acceptance: 'ambiguous',
    commit: 'unknown',
    recovery,
  };
}

/** Transport acceptance is non-terminal. The mutation remains rollback-owning
 * until a correlated semantic/durable commit boundary is observed. */
export function markSessionOperationAccepted(
  operation: SessionOperation,
  observation: SessionOperationObservation & { committed?: boolean },
): SessionOperation | null {
  if (operation.terminal || !matchesObservation(operation, observation, false)) return null;
  const commit = observation.committed === true || operation.commit === 'committed'
    ? 'committed'
    : operation.commit === 'unknown' ? 'unknown' : 'pending';
  return {
    ...operation,
    phase: 'awaiting-commit',
    acceptance: 'accepted',
    commit,
    recovery: commit === 'pending' ? null : 'reconcile',
  };
}

/** A durable success from any attempt in the owning backend generation is
 * authoritative. This intentionally permits event-before-ack and a late event
 * from attempt N to settle retry attempt N+1 of the same idempotent operation. */
export function settleSessionOperationSucceeded(
  operation: SessionOperation,
  observation: SessionOperationObservation & { resolvedPath?: string },
): SessionOperation | null {
  if (operation.terminal || !matchesObservation(operation, observation, false)) return null;
  return {
    ...operation,
    session: {
      ...operation.session,
      resolvedPath: observation.resolvedPath ?? operation.session.resolvedPath ?? operation.session.pendingPath,
    },
    phase: 'settled',
    acceptance: 'accepted',
    commit: 'committed',
    recovery: null,
    ...(operation.kind === 'message.interrupt' ? { retiredEventFence: true } : {}),
    terminal: {
      outcome: 'settled',
      reason: 'durable-commit-observed',
      recovery: 'none',
    },
  };
}

export function settleSessionOperationCancelled(
  operation: SessionOperation,
  observation: SessionOperationObservation & {
    outcome: 'cancelled' | 'superseded';
    reason: Extract<SessionOperationTerminalReason,
      'queue-cleared' | 'interrupted-before-commit' | 'superseded-before-commit'>;
    detail?: string;
  },
): SessionOperation | null {
  if (operation.terminal || !matchesObservation(operation, observation, false)) return null;
  return {
    ...operation,
    phase: 'settled',
    commit: 'not-committed',
    recovery: null,
    terminal: {
      outcome: observation.outcome,
      reason: observation.reason,
      recovery: 'none',
      ...(observation.detail !== undefined ? { detail: observation.detail } : {}),
    },
  };
}

export function settleSessionOperationFailed(
  operation: SessionOperation,
  observation: SessionOperationObservation & {
    reason: Extract<SessionOperationTerminalReason, 'definitive-rejection' | 'backend-generation-ended' | 'execution-failed'>;
    detail?: string;
    recovery?: Extract<SessionOperationRecovery, 'retry' | 'restart-backend' | 'reconcile' | 'none'>;
    /** Preserve destructive-commit evidence for compound operations. */
    committed?: boolean;
    /** Generation death can terminalize an unknown commit without inventing rollback safety. */
    preserveCommit?: boolean;
  },
): SessionOperation | null {
  if (operation.terminal || !matchesObservation(operation, observation, true)) return null;
  return {
    ...operation,
    phase: 'settled',
    acceptance: observation.reason === 'definitive-rejection' ? 'rejected' : operation.acceptance,
    commit: observation.committed === true
      ? 'committed'
      : observation.preserveCommit
        ? (operation.commit === 'pending' ? 'unknown' : operation.commit)
        : 'not-committed',
    recovery: null,
    terminal: {
      outcome: 'failed',
      reason: observation.reason,
      recovery: observation.recovery ?? (observation.reason === 'backend-generation-ended' ? 'restart-backend' : 'none'),
      ...(observation.detail !== undefined ? { detail: observation.detail } : {}),
    },
  };
}
