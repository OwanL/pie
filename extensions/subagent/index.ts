/**
 * Compatibility discovery shim. Keep this entry point in extensions/subagent
 * so Pi auto-discovery, the stable `subagent` extension ID, and its host
 * toggles/flags remain unchanged while the owned implementation lives under
 * harness/tools/subagent.
 */
export { default } from '../../harness/tools/subagent/index.js';