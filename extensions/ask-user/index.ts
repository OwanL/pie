/**
 * Compatibility discovery shim. Keep this entry point in extensions/ask-user
 * so Pi auto-discovery, the stable `ask-user` extension ID, and its host toggle
 * remain unchanged while the owned implementation lives under tools/ask-user.
 */
export { default } from '../../tools/ask-user/index.js';
