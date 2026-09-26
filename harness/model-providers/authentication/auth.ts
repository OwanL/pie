/**
 * Re-exports from auth-storage.ts.
 *
 * The DI-aware versions in auth-storage.ts accept optional env/platform
 * parameters (defaulting to process.env / process.platform), so callers
 * that use the zero-arg forms keep identical behaviour.
 */
export {
  isInsideGitWorkTree,
  getDefaultAuthDir,
  ensureDir,
  migrateAuthFile,
} from './auth-storage.js';