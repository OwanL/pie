/**
 * Canonical inert backend session-capability facts, published by worker/RPC
 * session events. The application may overlay host-owned operation state but
 * the backend never originates that projection.
 */
export interface SessionCapabilityFacts {
  /** True while backend-exposed billable work can still run automatically. */
  billableActivity: boolean;
  canContinue: boolean;
  canInterrupt: boolean;
  canCompact: boolean;
}
