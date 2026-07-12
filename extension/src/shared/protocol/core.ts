/**
 * Wire-protocol version. Bump when changing event/payload shapes between the
 * extension host and the backend process. The host refuses to start the backend
 * unless the values match.
 */
export const PROTOCOL_VERSION = 10;

/**
 * Wire-protocol version for the host↔webview channel. Bump when changing the
 * shape of `HostToWebviewMessage` or `WebviewToHostMessage` in a way that an
 * older webview build cannot tolerate. The webview logs a warning when the
 * value posted by the host does not match its compiled-in expectation; it does
 * not refuse to load (the webview is shipped together with the host so the
 * mismatch generally indicates a stale hot-reload).
 */
export const WEBVIEW_PROTOCOL_VERSION = 3;

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

