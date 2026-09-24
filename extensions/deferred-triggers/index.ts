/**
 * Compatibility discovery shim. Keep this entry point in
 * extensions/deferred-triggers so Pi auto-discovery and the stable
 * `deferred-triggers` extension ID remain unchanged while the owned
 * implementation lives under harness/tools/deferred-triggers.
 */
export { default } from '../../harness/tools/deferred-triggers/index.js';
