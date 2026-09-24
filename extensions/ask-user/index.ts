/**
 * Compatibility discovery shim. Keep this entry point in extensions/ask-user
 * so Pi auto-discovery, the stable `ask-user` extension ID, and its host toggle
 * remain unchanged while the owned implementation lives under harness/tools/ask-user.
 */
export { default } from '../../harness/tools/ask-user/index.js';
