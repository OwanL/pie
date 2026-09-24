/**
 * Application operation projection types (repository-organization plan §3.2).
 *
 * The reducer-owned operation lifecycle (kinds, phases, recovery actions) and
 * the renderer DTO that overlays the current non-terminal operation onto the
 * backend's inert {@link SessionCapabilityFacts} live here. The backend never
 * originates `primaryOperation`; only the pure host projection
 * (`host/core/projection.ts`) joins the two layers, and the backend consumes
 * only the facts contract.
 */

import type { SessionCapabilityFacts } from './session-capability-facts.js';

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

/** Compact projection of reducer-owned operation truth. The backend continues
 * to own billable activity; it does not originate this host-only projection. */
export type SessionPrimaryOperation = Record<string, string | number | boolean | null> & {
  operationId: string;
  kind: SessionPrimaryOperationKind;
  phase: SessionPrimaryOperationPhase;
  attempt: number;
  committed: boolean;
  recovery: SessionOperationRecoveryAction;
};

/** Renderer DTO: the backend's inert capability facts plus the pure host
 * projection of the current non-terminal reducer-owned operation. Wire shape
 * is unchanged; `primaryOperation` is present only after host projection. */
export interface SessionCapabilities extends SessionCapabilityFacts {
  /** Current non-terminal reducer-owned operation, when one controls the path. */
  primaryOperation?: SessionPrimaryOperation;
}