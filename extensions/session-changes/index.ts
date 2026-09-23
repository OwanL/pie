/**
 * Compatibility discovery shim. Keep this entry point in
 * extensions/session-changes so Pi auto-discovery and the stable
 * `session-changes` extension ID remain unchanged while the owned
 * implementation lives under tools/session-changes.
 */
export { default } from '../../tools/session-changes/index.js';
