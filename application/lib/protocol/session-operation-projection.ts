/** Host-owned operation lifecycle projection layered onto backend facts. */
import type { SessionCapabilityFacts } from '../../../harness/agent-processes/lib/rpc/session-capability-facts.js';

export type SessionPrimaryOperationKind =
  | 'session.create'
  | 'session.duplicate'
  | 'session.open'
  | 'session.close'
  | 'backend.restart'
  | 'message.send'
  | 'message.edit'
  | 'message.interrupt'
  | 'message.continue'
  | 'message.compact';

export type SessionPrimaryOperationPhase =
  | 'awaiting-acceptance'
  | 'draining'
  | 'awaiting-old-generation-death'
  | 'awaiting-commit'
  | 'ambiguous';

export type SessionOperationRecoveryAction = 'retry' | 'restart-backend' | 'reconcile' | null;

export type SessionPrimaryOperation = Record<string, string | number | boolean | null> & {
  operationId: string;
  kind: SessionPrimaryOperationKind;
  phase: SessionPrimaryOperationPhase;
  attempt: number;
  committed: boolean;
  recovery: SessionOperationRecoveryAction;
};

export interface SessionCapabilities extends SessionCapabilityFacts {
  primaryOperation?: SessionPrimaryOperation;
}
