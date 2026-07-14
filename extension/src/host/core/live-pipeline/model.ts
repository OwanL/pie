import type {
  LivePipelineState,
  LiveTurnRecord,
  TerminalAttemptTombstone,
} from '../../../shared/live-pipeline-protocol.js';

export function createEmptyLivePipelineState(): LivePipelineState {
  return {
    turnsBySession: {},
    toolsByExecutionId: {},
    pendingOwnerEvents: {},
    terminalAttempts: {},
    revisionBySession: {},
  };
}

export function terminalAttemptKey(turnId: string, attemptId: string): string {
  return `${turnId}\u0000${attemptId}`;
}

export function pendingOwnerKey(turnId: string, attemptId: string): string {
  return terminalAttemptKey(turnId, attemptId);
}

export function incrementLiveRevision(state: LivePipelineState, sessionPath: string): LivePipelineState {
  return {
    ...state,
    revisionBySession: {
      ...state.revisionBySession,
      [sessionPath]: (state.revisionBySession[sessionPath] ?? 0) + 1,
    },
  };
}

export function toolsForTurn(state: LivePipelineState, turn: Pick<LiveTurnRecord, 'turnId' | 'attemptId'>) {
  return Object.values(state.toolsByExecutionId).filter(
    (tool) => tool.turnId === turn.turnId && tool.attemptId === turn.attemptId,
  );
}

export function pruneExpiredTerminalAttempts(
  attempts: Record<string, TerminalAttemptTombstone>,
  now: number,
  maxEntries: number,
): Record<string, TerminalAttemptTombstone> {
  const retained = Object.entries(attempts)
    .map(([key, value], insertionIndex) => ({ key, value, insertionIndex }))
    .filter(({ value }) => value.expiresAt > now)
    .sort((left, right) =>
      right.value.expiresAt - left.value.expiresAt
      || right.insertionIndex - left.insertionIndex)
    .slice(0, maxEntries)
    .map(({ key, value }) => [key, value] as const);
  return Object.fromEntries(retained);
}
