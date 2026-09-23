/**
 * Compatibility discovery shim. Keep this entry point in extensions/warm-bash
 * so Pi auto-discovery and the stable `warm-bash` extension ID remain unchanged
 * while the owned implementation lives under tools/warm-bash.
 */
export { default } from '../../tools/warm-bash/index.js';
