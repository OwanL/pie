import { resolveHostSessionStoragePaths } from './session-storage-paths';

/**
 * Shared derivation of the deferred-triggers sidecar directory.
 *
 * The host (extension host process) and the backend spawn config both use this
 * so they agree on the sidecar location without threading a new env var back to
 * the host. The directory is a sibling of the sessions dir (mirroring the
 * `session-reviews` sidecar), one level above `<sessions>`:
 *
 *   <root>/data/outcomes/sessions          ← sessions
 *   <root>/data/outcomes/session-reviews   ← reviews sidecar (existing)
 *   <root>/data/outcomes/deferred-triggers ← this feature's sidecar
 *
 * The backend child additionally receives `PIE_TRIGGERS_DIR` (set in
 * `host/backend/client.ts`) so the `defer_trigger` tool — which cannot import
 * host code — reads the same path via that env var. Both resolve identically
 * because they derive from the same `PI_CODING_AGENT_SESSION_DIR` /
 * `PI_CODING_AGENT_DIR` env vars.
 *
 * Returns `undefined` when neither env is set, in which case the feature
 * degrades gracefully (the tool errors; the host registry is a no-op).
 */
export const TRIGGERS_FILE = 'triggers.jsonl';
export const TRIGGERS_DIR_ENV = 'PIE_TRIGGERS_DIR';

export function getDeferredTriggersDir(): string | undefined {
  return resolveHostSessionStoragePaths(
    process.env.PI_CODING_AGENT_DIR,
    process.env.PI_CODING_AGENT_SESSION_DIR,
  ).triggersDir;
}
