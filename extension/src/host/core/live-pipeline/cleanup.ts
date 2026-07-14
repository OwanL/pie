import { LIVE_PIPELINE_LIMITS, type LivePipelineState } from '../../../shared/live-pipeline-protocol.js';
import type { ChatMessage } from '../../../shared/protocol/messages.js';
import { createEmptyLivePipelineState, pruneExpiredTerminalAttempts, terminalAttemptKey } from './model.js';
import { materializeInterruptedLiveTurn } from './projection.js';

export interface InterruptedLivePipeline {
  state: LivePipelineState;
  interruptedBySession: Record<string, ChatMessage>;
}

/** Pure restart transform: no active work survives a dead backend process. */
export function interruptLivePipelineForRestart(
  current: LivePipelineState,
  occurredAt: number,
  tombstoneExpiresAt: number,
): InterruptedLivePipeline {
  const interruptedBySession: Record<string, ChatMessage> = {};
  const terminalAttempts = { ...current.terminalAttempts };
  for (const turn of Object.values(current.turnsBySession)) {
    const message = materializeInterruptedLiveTurn(current, turn.sessionPath);
    if (message) interruptedBySession[turn.sessionPath] = message;
    terminalAttempts[terminalAttemptKey(turn.turnId, turn.attemptId)] = {
      sessionPath: turn.sessionPath,
      turnId: turn.turnId,
      attemptId: turn.attemptId,
      finalSeq: turn.seq,
      terminalKind: 'interrupted',
      expiresAt: tombstoneExpiresAt,
    };
  }
  const empty = createEmptyLivePipelineState();
  return {
    state: {
      ...empty,
      terminalAttempts: pruneExpiredTerminalAttempts(
        terminalAttempts,
        occurredAt,
        LIVE_PIPELINE_LIMITS.terminalTombstones,
      ),
      revisionBySession: Object.fromEntries(
        Object.keys(current.turnsBySession).map((sessionPath) => [
          sessionPath,
          (current.revisionBySession[sessionPath] ?? 0) + 1,
        ]),
      ),
    },
    interruptedBySession,
  };
}
