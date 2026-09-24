/**
 * Compatibility discovery shim. Keep this entry point in
 * extensions/session-changes so Pi auto-discovery and the stable
 * `session-changes` extension ID remain unchanged while the owned
 * implementation lives under harness/tools/session-changes.
 */
export { default } from '../../harness/tools/session-changes/index.js';
