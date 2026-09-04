/**
 * Wire-protocol version. Bump when changing event/payload shapes between the
 * extension host and the backend process. The host refuses to start the backend
 * unless the values match.
 */
export const PROTOCOL_VERSION = 15;

/** Stable RPC error returned when a lossless required session snapshot row cannot fit. */
export const SESSION_SNAPSHOT_TOO_LARGE_CODE = 'SESSION_SNAPSHOT_TOO_LARGE' as const;

/**
 * Wire-protocol version for the host↔webview channel. Bump when changing the
 * shape of `HostToWebviewMessage` or `WebviewToHostMessage` in a way that an
 * older webview build cannot tolerate. Both sides fail closed on a protocol
 * mismatch. `PIE_BUILD_ID` separately identifies the compiled source snapshot
 * for diagnostics and build-output verification; it does not block a
 * same-protocol renderer after an in-place rebuild.
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
 */
export const WEBVIEW_PROTOCOL_VERSION = 10;

export function assertProtocolVersion(peerLabel: string, protocolVersion: unknown): void {
  if (!Number.isInteger(protocolVersion)) {
    throw new Error(
      `PI protocol check failed: ${peerLabel} did not report a valid integer protocolVersion (expected ${PROTOCOL_VERSION}).`,
    );
  }

  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `PI protocol mismatch: host expects version ${PROTOCOL_VERSION} but ${peerLabel} reported ${protocolVersion}. Rebuild or update both sides together.`,
    );
  }
}

export interface RequestEnvelope<TParams = unknown> {
  id: string;
  method: string;
  params?: TParams;
}

export type ResponseEnvelope<TResult = unknown> =
  | {
      id: string;
      ok: true;
      result?: TResult;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        data?: unknown;
      };
    };

export interface EventEnvelope<TPayload = unknown> {
  event: string;
  payload?: TPayload;
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return !!value && typeof value === 'object' && 'event' in value;
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  return !!value && typeof value === 'object' && 'id' in value && 'ok' in value;
}
