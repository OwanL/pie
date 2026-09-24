/**
 * Canonical inert backend session-capability facts (repository-organization
 * plan §3.2/§3.4; STATE_CONTRACT "Authoritative Session Activity and
 * Capabilities").
 *
 * This module is the protocol seam between the two capability layers:
 *
 * - The **backend** owns and publishes exactly these four JSON-safe facts,
 *   classified from the complete live/durable session context. Backend
 *   producers (`backend/session-activity.ts` and its callers) consume this
 *   contract and must never import host-owned operation projections.
 * - The **application** (host reducer/projection) owns the non-terminal
 *   operation lifecycle and overlays it as an optional field onto these facts
 *   in `SessionCapabilities` (`session-operation-projection.ts`); the backend
 *   never originates host operation phase.
 *
 * Keep this module inert: no imports, no runtime code, browser-safe. These
 * facts are the authoritative wire shape for `session.opened`, `busy.changed`,
 * and `agent.settled` capability payloads.
 */

export interface SessionCapabilityFacts {
  /** True while provider, retry, compaction, queued continuation, bash/tool, or
   * another backend-exposed billable window can still run automatically. */
  billableActivity: boolean;
  canContinue: boolean;
  canInterrupt: boolean;
  canCompact: boolean;
}