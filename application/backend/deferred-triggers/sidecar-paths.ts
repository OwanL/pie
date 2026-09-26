import { TRIGGERS_DIR_ENV, TRIGGERS_FILE } from '../../../harness/tools/deferred-triggers/sidecar-contract.js';
import { resolveHostSessionStoragePaths } from '../../../lib/data-root/session-storage-paths.js';

/** Shared derivation of the host-managed deferred-triggers sidecar directory. */
export function getDeferredTriggersDir(): string | undefined {
  return resolveHostSessionStoragePaths(
    process.env.PI_CODING_AGENT_DIR,
    process.env.PI_CODING_AGENT_SESSION_DIR,
  ).triggersDir;
}

export { TRIGGERS_DIR_ENV, TRIGGERS_FILE };
