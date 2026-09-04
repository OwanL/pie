/**
 * One deterministic identity compiled into both halves of the host/webview
 * boundary. Production builds replace `__PIE_BUILD_ID__` in Vite; source-run
 * tests share the explicit fallback below.
 *
 * This is deliberately separate from the wire-protocol version. The protocol
 * version owns runtime compatibility; the build id identifies the source
 * snapshot for diagnostics and verifies that one-shot builds emitted
 * coordinated host and renderer bundles. Runtime build skew is allowed so a
 * renderer-only publication does not force host/backend activation.
 */
declare const __PIE_BUILD_ID__: string | undefined;

export const PIE_BUILD_ID = typeof __PIE_BUILD_ID__ === 'string' && __PIE_BUILD_ID__.length > 0
  ? __PIE_BUILD_ID__
  : 'source-test-build';
