/**
 * Browser renderer transport (browser server plan §4.2/§4.3/§5.3/§4.1).
 *
 * Wraps ONE accepted browser WebSocket and registers it into the shared
 * `RendererHub` as a `RendererTransport`:
 *
 *   - on accept, the session's view is resolved and the transport sends the
 *     typed `rendererHello` (host instance, renderer id, renderer generation,
 *     live `viewGeneration`, protocol + asset version) — the browser replaces
 *     its in-memory identity from it before sending `ready`; the host treats
 *     the socket registration, not echoed JSON fields, as the trusted source;
 *   - inbound messages are fail-closed validated by
 *     `validateBrowserToHostMessage` BEFORE the renderer-session prelude:
 *     unknown fields/types, oversize, foreign base64, and malformed payloads
 *     are never routed; repeated violations (≥ 5 in a bounded window) close
 *     the socket with a typed reason; binary frames are rejected outright;
 *   - browser lifecycle messages (`rendererVisibilityChanged`,
 *     `rendererFocusChanged`) update the session's beliefs directly;
 *   - outbound posts pass the pre-send gates (§4.1): a complete candidate
 *     frame is measured and dropped/coalesced when `bufferedAmount > 8 MiB`
 *     or `bufferedAmount + frameBytes > 32 MiB` — latest-wins, never a
 *     backlog queue;
 *   - `recover()` closes the socket; the page reconnects and registers a
 *     fresh session (reconnect-by-new-registration, never stale generation).
 */

import { WebSocket } from 'ws';

import type { HostToWebviewMessage, RendererKind } from '../../shared/protocol';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';
import { BROWSER_INGRESS_LIMITS, validateBrowserToHostMessage } from '../../shared/browser-ingress';
import { appendPieLog } from '../util/pie-log';
import type { RendererRegistration, RendererTransport } from '../renderers/types';
import { BROWSER_SERVER_POLICY, evaluateSendGate, ViolationRateTracker } from './policy';
import type { DisposableLike } from '../renderers/types';

/** Typed close reasons used by the browser transport/server. */
export const BROWSER_CLOSE_REASONS = {
  handshakeTimeout: 'handshake-timeout',
  handshakeOrder: 'ready-required',
  malformedRate: 'too-many-malformed-messages',
  protocolViolation: 'protocol-violation',
  serverShutdown: 'server-shutdown',
  recovery: 'recovery',
  clientLimit: 'client-limit',
  originRejected: 'origin-rejected',
} as const;

export type BrowserCloseReason = (typeof BROWSER_CLOSE_REASONS)[keyof typeof BROWSER_CLOSE_REASONS] | (string & {});

export interface BrowserRendererTransportOptions {
  /** Webview asset version, stamped into `rendererHello`. */
  assetVersion: string;
  /** Bounded clock for the handshake timer (deterministic tests). */
  now?(): number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Fired once when the socket closes (server bookkeeping). */
  onClose?(info: { rendererId: string; code: number; reason: string }): void;
}

/**
 * One browser renderer transport. The server owns the socket; the hub owns
 * the session; this class bridges them with the fail-closed ingress
 * validation, hello handshake, pre-send gates, and recovery policy.
 */
export class BrowserRendererTransport implements RendererTransport {
  readonly kind: RendererKind = 'browser';
  private session: RendererRegistration | null = null;
  private messageHandler?: (message: unknown) => void;
  private visibilityHandler?: (visible: boolean) => void;
  private readonly violations = new ViolationRateTracker(
    BROWSER_SERVER_POLICY.maxMalformedMessages,
    BROWSER_SERVER_POLICY.malformedWindowMs,
    this.options.now ?? Date.now,
  );
  private handshakeTimer: unknown = undefined;
  private handshakeComplete = false;
  private disposed = false;
  /** The hello is the first frame on the socket; every other post is gated
   *  until it is sent so a view-resolve snapshot can never race ahead of the
   *  identity the browser replaces from it. */
  private helloSent = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Socket close code/reason captured at close time (idempotent close). */
  private closeReason: string = '';

  constructor(
    private readonly socket: WebSocket,
    private readonly options: BrowserRendererTransportOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    socket.on('message', (data, isBinary) => this.onSocketMessage(data, isBinary));
    socket.on('close', (code, reasonBuffer) => this.onSocketClose(code, reasonBuffer.toString()));
    socket.on('error', (error) => {
      appendPieLog('warn', 'browser-transport', 'browser socket error', {
        error: error instanceof Error ? error.name : String(error),
      });
    });
  }

  /** Accept-side setup (server calls after `hub.registerRenderer`): resolve
   *  the view FIRST (this bumps the view generation — the hello must carry
   *  the POST-resolution generation or the browser's `ready` would be dropped
   *  as stale), then send the hello as the first frame. Snapshot posts are
   *  gated until the hello is sent so nothing races ahead of it. */
  start(registration: RendererRegistration): void {
    this.session = registration;
    this.session.handleViewResolved(true);
    const hello: Extract<HostToWebviewMessage, { type: 'rendererHello' }> = {
      type: 'rendererHello',
      protocolVersion: WEBVIEW_PROTOCOL_VERSION,
      buildId: PIE_BUILD_ID,
      hostInstanceId: this.session.getHostInstanceId(),
      rendererId: this.session.rendererId,
      rendererGeneration: this.session.getRendererGeneration(),
      viewGeneration: this.session.getViewGeneration(),
      assetVersion: this.options.assetVersion,
    };
    // The hello is the one message that bypasses the pre-send gates: it is
    // tiny and must never be coalesced away (a fresh socket is empty).
    this.helloSent = true;
    this.socket.send(JSON.stringify(hello));
    this.armHandshakeTimeout();
  }

  // ─── RendererTransport surface ────────────────────────────────────────────

  post(message: HostToWebviewMessage): boolean | Promise<boolean> {
    if (this.disposed || !this.helloSent || this.socket.readyState !== WebSocket.OPEN) return false;
    let frame: string;
    try {
      frame = JSON.stringify(message);
    } catch {
      return false;
    }
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    const gate = evaluateSendGate(this.socket.bufferedAmount, frameBytes);
    if (!gate.ok) {
      // Pre-send gate: drop/coalesce. The delivery controller marks the
      // renderer dirty again, so a lagging browser receives the LATEST
      // snapshot only — never a backlog queue.
      return false;
    }
    this.socket.send(frame);
    return true;
  }

  onMessage(handler: (message: unknown) => void): DisposableLike {
    this.messageHandler = handler;
    return {
      dispose: () => {
        if (this.messageHandler === handler) this.messageHandler = undefined;
      },
    };
  }

  onVisibilityChanged(handler: (visible: boolean) => void): DisposableLike {
    this.visibilityHandler = handler;
    return {
      dispose: () => {
        if (this.visibilityHandler === handler) this.visibilityHandler = undefined;
      },
    };
  }

  isAttached(): boolean {
    return !this.disposed && this.socket.readyState === WebSocket.OPEN;
  }

  /** Browser reconnects by new registration; there is no in-transport reload
   *  state, so the readiness probe never treats this transport as reloading. */
  isReloading(): boolean {
    return false;
  }

  clearReloading(): void {
    // no-op: see isReloading().
  }

  /** Recovery = close the socket; the page reconnects and registers a fresh
   *  session with a fresh generation (never a stale DOM generation). */
  recover(reason: string): void | Promise<void> {
    this.closeSocket(reason.startsWith('recovery:') ? reason : BROWSER_CLOSE_REASONS.recovery);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHandshakeTimer();
    this.session?.handleViewDisposed();
    // The server owns the session lifecycle bookkeeping; closing the socket
    // triggers onSocketClose → server deregistration.
    try {
      this.socket.close(1000, BROWSER_CLOSE_REASONS.serverShutdown);
    } catch {
      // already closed
    }
  }

  getRendererId(): string {
    return this.session?.rendererId ?? '';
  }

  /** Close with a typed policy reason (idempotent). */
  closeSocket(reason: BrowserCloseReason, code = 1008): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeReason = reason;
    this.clearHandshakeTimer();
    try {
      // RFC 6455: close reason ≤ 123 UTF-8 bytes; clamp rather than throw.
      let clamped = reason;
      if (Buffer.byteLength(clamped, 'utf8') > 123) {
        const bytes = Buffer.from(clamped, 'utf8');
        clamped = bytes.subarray(0, 123).toString('utf8');
      }
      this.socket.close(code, clamped);
    } catch {
      // already closing
    }
  }

  // ─── Inbound fail-closed ingress ──────────────────────────────────────────

  private onSocketMessage(data: unknown, isBinary: boolean): void {
    if (this.disposed) return;
    if (isBinary) {
      this.recordViolation('binary-frame');
      return;
    }
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
    const frameBytes = Buffer.byteLength(text, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.recordViolation('unparseable-json');
      return;
    }
    const validation = validateBrowserToHostMessage(parsed, frameBytes);
    if (!validation.ok) {
      // A detail expansion is an explicit UI request. If its closed-schema
      // validation fails, return a key-scoped terminal result before recording
      // the protocol violation. Otherwise the webview has no acknowledgement
      // to release its bounded request lane and can remain on "Loading…"
      // forever. Only reflect already-bounded routing fields to this same
      // socket; malformed or oversized identifiers still receive no reply.
      const rejectedDetail = detailRejectionForMalformedRequest(parsed);
      if (rejectedDetail) this.post(rejectedDetail);
      this.recordViolation(validation.reason);
      return;
    }
    const message = validation.value;
    if (!this.handshakeComplete) {
      if (message.type !== 'ready') {
        this.closeSocket(BROWSER_CLOSE_REASONS.handshakeOrder);
        return;
      }
      this.handshakeComplete = true;
      this.clearHandshakeTimer();
    }
    if (message.type === 'rendererVisibilityChanged') {
      this.visibilityHandler?.(message.visible);
      this.session?.setVisible(message.visible);
      return;
    }
    if (message.type === 'rendererFocusChanged') {
      this.session?.setFocused(message.focused);
      return;
    }
    this.messageHandler?.(message);
  }

  private onSocketClose(code: number, reason: string): void {
    this.clearHandshakeTimer();
    const effectiveReason = this.closeReason || reason || `code-${code}`;
    const rendererId = this.getRendererId();
    if (!this.disposed) {
      // Server-driven close (recovery, shutdown) already disposed; a peer
      // close runs the same teardown path.
      this.disposed = true;
      this.session?.handleViewDisposed();
    }
    this.options.onClose?.({ rendererId, code, reason: effectiveReason });
  }

  private recordViolation(reason: string): void {
    appendPieLog('warn', 'browser-renderer-transport', 'ingress violation', {
      reason,
      rendererId: this.getRendererId(),
    });
    if (this.violations.record()) {
      this.closeSocket(BROWSER_CLOSE_REASONS.malformedRate);
    }
  }

  private armHandshakeTimeout(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = this.setTimer(() => {
      if (!this.disposed) this.closeSocket(BROWSER_CLOSE_REASONS.handshakeTimeout);
    }, BROWSER_SERVER_POLICY.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      this.clearTimer(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }
}

function detailRejectionForMalformedRequest(value: unknown): Extract<HostToWebviewMessage, { type: 'detailResult' }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== 'requestDetail'
    || typeof message.clientCommandId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(message.clientCommandId)
    || typeof message.sessionPath !== 'string'
    || Buffer.byteLength(message.sessionPath, 'utf8') > BROWSER_INGRESS_LIMITS.maxPathUtf8Bytes
    || !message.ref
    || typeof message.ref !== 'object'
    || Array.isArray(message.ref)) return undefined;
  const key = (message.ref as Record<string, unknown>).key;
  if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > 512) return undefined;
  return {
    type: 'detailResult',
    result: {
      sessionPath: message.sessionPath,
      key,
      status: 'failure',
      message: 'Pie could not validate this detail request. Reload Pie and try again.',
    },
  };
}
