import type {
  LiveToolRecord,
  LiveTurnRecord,
  TurnSemanticEnvelope,
} from '../../../harness/agent-processes/lib/rpc/live-pipeline.js';

export interface TerminalAttemptTombstone {
  sessionPath: string;
  turnId: string;
  attemptId: string;
  finalSeq: number;
  terminalKind: 'completed' | 'interrupted' | 'error';
  expiresAt: number;
}

/** Mutable host-side live-pipeline projection owned by application state. */
export interface LivePipelineState {
  turnsBySession: Record<string, LiveTurnRecord>;
  toolsByExecutionId: Record<string, LiveToolRecord>;
  pendingOwnerEvents: Record<string, TurnSemanticEnvelope[]>;
  terminalAttempts: Record<string, TerminalAttemptTombstone>;
  revisionBySession: Record<string, number>;
}
