/**
 * Wire-protocol version for the host↔webview channel. Bump when changing the
 * shape of `HostToWebviewMessage` or `WebviewToHostMessage` in a way that an
 * older webview build cannot tolerate. Both sides fail closed on a protocol
 * mismatch. `PIE_BUILD_ID` separately identifies the compiled source snapshot
 * for diagnostics and build-output verification; it does not block a
 * same-protocol renderer-only publication.
 *
 * v5 (browser server): multi-renderer identity (`rendererHello`,
 * `rendererVisibilityChanged`, `rendererFocusChanged`), command
 * acknowledgement (`clientCommandId`, `commandAck`, `commandStatus`,
 * `commandStatusRequest`), and targeted `rendererNotice` feedback.
 *
 * v6 (browser server M2): `rendererHello` carries the live `viewGeneration`
 * (the browser has no HTML-stamped generation; it must learn the fence from
 * the hello), `HostDetailRoute` gains the trusted `rendererId`/
 * `rendererGeneration` (the complete ownership key is
 * `{hostInstanceId, viewGeneration, rendererId, rendererGeneration,
 * detailKey}`), and the source-aware inline confirmation seam
 * (`inlineConfirm`/`inlineConfirmResponse`) lands for browser-initiated
 * model switches and destructive reverts.
 *
 * v7: Phase-5 detail streams add attempt ownership (`detailAttempt`) and
 * exact Unicode sizing (`totalCodePoints`) for paged reasoning/subagent data.
 *
 * v8: every state/hello and readiness handshake carries `buildId`. Protocol
 * skew remains a reload-required boundary; build skew is accepted at runtime.
 *
 * v9: ViewState carries host-owned cumulative per-session agent working time
 * with optional durable run-telemetry attribution for its rich tooltip.
 *
 * v10: ViewState carries backend-authored per-session activity and continuation
 * capabilities; the renderer no longer classifies continuation from transcript.
 *
 * v11: ViewState carries host-global browser-server network state (actual
 * listener, configured preference, pending/error status, and LAN URLs), and
 * renderers can request a persisted live LAN exposure change.
 *
 * v12: `openFile` may carry the original markdown reference and the originating
 * session cwd so the host can perform a project-scoped basename fallback.
 *
 * v13: transcript image previews use a renderer-targeted bounded request/result
 * pair; image data remains ephemeral and outside ViewState snapshots.
 */
export const WEBVIEW_PROTOCOL_VERSION = 13;
