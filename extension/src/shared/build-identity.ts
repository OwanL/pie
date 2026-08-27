/**
 * One deterministic identity compiled into both halves of the host/webview
 * boundary. Production builds replace `__PIE_BUILD_ID__` in Vite; source-run
 * tests share the explicit fallback below.
 *
 * This is deliberately separate from the wire-protocol version. The protocol
 * version describes compatibility, while the build id proves that a running
 * extension host and a freshly loaded renderer came from the same source
 * snapshot. That distinction prevents a stale host from accepting commands
 * from newly written webview assets after an in-place extension rebuild.
 */
declare const __PIE_BUILD_ID__: string | undefined;

export const PIE_BUILD_ID = typeof __PIE_BUILD_ID__ === 'string' && __PIE_BUILD_ID__.length > 0
  ? __PIE_BUILD_ID__
  : 'source-test-build';
