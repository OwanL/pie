// Script-side authenticated analytics handoff frame transport.
//
// The compiled `extension/out` sender (`sendBoundedAnalyticsFrame`) sends the
// request with `socket.end(frame)`, which coalesces the frame write and the
// write-side half-close into one operation. Against the VS Code extension
// host's named-pipe runtime the peer can observe the half-close before the
// buffered frame is delivered, and the host's end-without-frame guard then
// destroys the connection silently (observed live on 2026-09-16: the
// registered host answered nothing and the recovery bound a correct key to a
// census that still failed its authenticated probes; the same frame sent with
// a separate write and a deferred half-close was answered in ~1 ms). The
// script side therefore owns this transport: it writes the frame first and
// half-closes only after the write flushes, so `data` is always processed
// before `end` on every runtime. The owning sender in
// `extension/src/host/analytics-handoff-discovery.ts` keeps the combined form
// until its fix lands and is recorded in the execution record.
//
// Contract mirrors the compiled sender exactly: one newline-terminated JSON
// frame, bounded request/response sizes, bounded timeout, one response frame.

import { createConnection } from 'node:net';

/** Mirrors shared `ANALYTICS_HANDOFF_MAX_FRAME_BYTES` (64 KiB). Kept local so
 * this script-owned module never imports hashed build chunks. */
const MAX_FRAME_BYTES = 64 * 1024;

/** Live-host pipe stall (observed 2026-09-16): the first connection to a host
 * endpoint after an idle period can be accepted but never deliver its frame,
 * closing without a response ~60 ms in; a later connection succeeds. The
 * sender reports the stall honestly with a single attempt and never retries
 * by itself: a retry here would reuse the same signed nonce, and a frame that
 * WAS processed but lost its response would come back as a nonce replay. The
 * stall retry belongs one layer up, where a fresh request can be signed (see
 * `retryStalledAnalyticsDiscovery`). */
export function sendBoundedAnalyticsFrame(endpointName, request, timeoutMs = 5_000, socketFactory = createConnection) {
  if (typeof endpointName !== 'string' || endpointName.length === 0 || endpointName.length > 1_024) {
    return Promise.reject(new Error('handoff endpoint is invalid.'));
  }
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
    return Promise.reject(new Error('handoff request exceeds its frame bound.'));
  }
  return sendSingleBoundedFrame(endpointName, frame, timeout, socketFactory);
}

/** Stall retry for requests whose nonce MUST NOT change. Used for the
 * controlled-restart send: if the frame was never delivered, the retry lands
 * the original request; if the frame WAS processed but the acknowledgement
 * was lost, the host's nonce replay guard rejects the retry loudly, so a
 * restart is never silently commanded twice. */
const STALL_RETRY_ATTEMPTS = 3;
const STALL_RETRY_SPACING_MS = 100;

function isClosedWithoutResponseError(error) {
  return error instanceof Error
    && error.message === 'authenticated handoff endpoint closed without a response.';
}

export function sendBoundedAnalyticsFrameWithStallRetry(endpointName, request, timeoutMs = 5_000, socketFactory = createConnection) {
  return (async () => {
    let lastError;
    for (let attempt = 0; attempt < STALL_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await sendBoundedAnalyticsFrame(endpointName, request, timeoutMs, socketFactory);
      } catch (error) {
        if (!isClosedWithoutResponseError(error)) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, STALL_RETRY_SPACING_MS));
      }
    }
    throw lastError;
  })();
}

/** Retry a read-only discovery callable while its only failure reasons are
 * per-host authenticated-probe failures, which is the census shape a live-host
 * pipe stall produces. Each attempt re-reads the registry and signs fresh
 * requests, so no nonce is ever reused. Real authentication failures fail
 * every attempt identically and the last result is returned unchanged. */
export async function retryStalledAnalyticsDiscovery(discovery, attempts = 4, spacingMs = 100) {
  let result = await discovery();
  for (let attempt = 1; attempt < attempts && result?.complete !== true; attempt += 1) {
    const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
    if (reasons.length === 0 || !reasons.every((entry) => entry?.code === 'host-authentication-failed')) break;
    await new Promise((resolve) => setTimeout(resolve, spacingMs));
    result = await discovery();
  }
  return result;
}

function sendSingleBoundedFrame(endpointName, frame, timeoutMs, socketFactory) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const socket = socketFactory(endpointName);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
      socket.destroy();
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('authenticated handoff probe timed out.')));
    socket.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.once('close', () => {
      if (!settled) finish(new Error('authenticated handoff endpoint closed without a response.'));
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        finish(new Error('authenticated handoff response exceeds its frame bound.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      if (buffer.slice(newline + 1).length > 0) {
        finish(new Error('authenticated handoff response contains more than one frame.'));
        return;
      }
      try {
        finish(undefined, JSON.parse(line));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('connect', () => {
      try {
        // Half-close only after the frame write flushes. Combining the write
        // and the FIN in one `socket.end(frame)` call races the host's
        // end-without-frame guard on the extension host's pipe runtime.
        socket.write(frame, () => {
          if (!socket.destroyed) socket.end();
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}