/**
 * Client transports (browser server plan §4.3).
 *
 * The webview talks to the host through one `ClientTransport`; the bootstrap
 * picks it from server-injected metadata (`pie-transport` meta), not from a
 * separate bundle:
 *
 *   - `VsCodeClientTransport` wraps `acquireVsCodeApi()` and the `window`
 *     message channel. Identity is host-stamped into the served HTML
 *     (`pie-asset-version` / `pie-view-generation`), so this transport
 *     stamps those values onto outbound messages exactly as the previous
 *     `panel.tsx` bootstrap did.
 *   - `BrowserClientTransport` wraps one same-origin WebSocket. A browser
 *     renderer's identity CANNOT be fixed in HTML: a reconnect creates a new
 *     registration without reloading the page. On every accepted socket the
 *     host first sends a typed `rendererHello` (hostInstanceId, rendererId,
 *     rendererGeneration, viewGeneration, assetVersion); this transport
 *     replaces its in-memory identity from that hello before sending `ready`,
 *     and all later commands/evidence use that CURRENT socket identity. The
 *     host treats the socket registration — not echoed JSON fields — as the
 *     trusted source.
 *
 * Application commands sent through the browser transport carry a
 * browser-minted `clientCommandId` (UUID, unique per renderer generation) and
 * are tracked in the bounded pending-command store; the transport never
 * replays a command automatically (reconciliation is read-only
 * `commandStatusRequest`s against the host decision ledger).
 */

import type { HostToWebviewMessage, WebviewToHostMessage } from '../../shared/protocol';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';
import { isBrowserApplicationCommand } from '../../shared/browser-ingress';
import { pendingCommandStore } from './pending-command-store';

export type ClientConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reload-required';

export interface ClientTransport {
  /** Post one outbound message. Returns false when the transport dropped it
   *  (disconnected / over the outbound bound). Callers own replay policy —
   *  there is none by default. */
  postMessage(message: WebviewToHostMessage): boolean;
  /** Subscribe to inbound host messages. Returns an unsubscribe function. */
  subscribe(handler: (message: HostToWebviewMessage) => void): () => void;
  getConnectionState(): ClientConnectionState;
  /** Subscribe to connection-state changes (banner rendering). */
  onConnectionStateChange(handler: (state: ClientConnectionState) => void): () => void;
  dispose(): void;
}

// ─── HTML-stamped metadata (VS Code renderer only) ─────────────────────────

export function getAssetVersion(): string | undefined {
  return document.querySelector('meta[name="pie-asset-version"]')?.getAttribute('content') ?? undefined;
}

/** Read the host-stamped generation; malformed/missing markup never guesses. */
export function getViewGeneration(): number | undefined {
  const raw = document.querySelector('meta[name="pie-view-generation"]')?.getAttribute('content');
  const value = raw === null || raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function withHandshakeMetadata(
  msg: Extract<WebviewToHostMessage, { type: 'ready' | 'refreshState' | 'requestSnapshot' }>,
): WebviewToHostMessage {
  const viewGeneration = getViewGeneration();
  return {
    ...msg,
    assetVersion: getAssetVersion(),
    buildId: PIE_BUILD_ID,
    ...(viewGeneration === undefined ? {} : { viewGeneration }),
  };
}

export function withViewGeneration(msg: WebviewToHostMessage): WebviewToHostMessage {
  const viewGeneration = getViewGeneration();
  return viewGeneration === undefined ? msg : { ...msg, viewGeneration };
}

// ─── VS Code client transport ───────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

/**
 * VS Code renderer transport: `acquireVsCodeApi().postMessage` plus the
 * `window` message channel. Identity is HTML-stamped (asset version + view
 * generation); connection state is always `connected` while mounted (the
 * channel exists as long as the webview document lives).
 */
export class VsCodeClientTransport implements ClientTransport {
  private readonly api = acquireVsCodeApi();
  private readonly handlers = new Set<(message: HostToWebviewMessage) => void>();
  private readonly stateHandlers = new Set<(state: ClientConnectionState) => void>();
  private readonly onWindowMessage = (event: MessageEvent): void => {
    // Guard against malformed messages from non-host sources (browser
    // extensions, devtools, etc.). The host-sync dispatch further validates
    // the `type` field against known handlers.
    if (!event.data || typeof event.data.type !== 'string') return;
    for (const handler of this.handlers) handler(event.data as HostToWebviewMessage);
  };

  constructor() {
    window.addEventListener('message', this.onWindowMessage);
  }

  postMessage(message: WebviewToHostMessage): boolean {
    if (message.type === 'ready' || message.type === 'refreshState' || message.type === 'requestSnapshot') {
      this.api.postMessage(withHandshakeMetadata(message));
      return true;
    }
    this.api.postMessage(withViewGeneration(message));
    return true;
  }

  subscribe(handler: (message: HostToWebviewMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getConnectionState(): ClientConnectionState {
    return 'connected';
  }

  onConnectionStateChange(handler: (state: ClientConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    // Subscriptions expose a current value, not only future transitions. This
    // keeps consumers correct if their initial read and subscription are
    // separated by a render/effect boundary.
    handler(this.getConnectionState());
    return () => this.stateHandlers.delete(handler);
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage);
    this.handlers.clear();
    this.stateHandlers.clear();
  }
}

// ─── Browser client transport ───────────────────────────────────────────────

/** UTF-8 byte length (browser-safe; no Node Buffer in the webview). */
const textEncoder = new TextEncoder();
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/** Maximum outbound frame (mirrors the host's 32 MiB transport record limit;
 *  the fail-closed ingress re-measures the exact decoded bytes). */
const OUTBOUND_FRAME_MAX_BYTES = 32 * 1024 * 1024;
/** Reconnect backoff: 1s, 2s, 4s, … capped at 30s, ±20% jitter. */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Close reasons that indicate this compiled page cannot safely continue.
 *  Recovery, shutdown, capacity, and timeout closes remain reconnectable. */
const RELOAD_REQUIRED_CLOSE_REASONS = new Set([
  'invalid-renderer-hello',
  'ready-required',
  'renderer-asset-mismatch',
  'protocol-violation',
  'too-many-malformed-messages',
]);
/** Browser WebSocket.close() only permits 1000 or application codes
 *  (3000-4999); use a private application code for client-detected policy
 *  failures while preserving the typed reason used by both peers. */
const CLIENT_POLICY_CLOSE_CODE = 4008;

function isRendererHello(value: unknown): value is Extract<HostToWebviewMessage, { type: 'rendererHello' }> {
  if (!value || typeof value !== 'object') return false;
  const hello = value as Record<string, unknown>;
  const nonEmptyString = (field: unknown): field is string => typeof field === 'string' && field.length > 0;
  const generation = (field: unknown): field is number => Number.isSafeInteger(field) && Number(field) >= 0;
  return hello.type === 'rendererHello'
    && Number.isInteger(hello.protocolVersion)
    && nonEmptyString(hello.buildId)
    && nonEmptyString(hello.hostInstanceId)
    && nonEmptyString(hello.rendererId)
    && generation(hello.rendererGeneration)
    && generation(hello.viewGeneration)
    && nonEmptyString(hello.assetVersion);
}

export interface BrowserClientTransportOptions {
  /** WebSocket route stamped by the server (`pie-ws-route` meta). */
  wsRoute: string;
  /** Fired after each `rendererHello` with the CURRENT socket identity. */
  onHandshake?(identity: {
    hostInstanceId: string;
    rendererId: string;
    rendererGeneration: number;
    viewGeneration: number;
    assetVersion: string;
    buildId: string;
  }): void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** The browser transport's parsed hello identity (internal): replaced on
 *  every accepted socket from the host's typed `rendererHello`. */
interface RendererIdentity {
  hostInstanceId: string;
  rendererId: string;
  rendererGeneration: number;
  viewGeneration: number;
  assetVersion: string;
  buildId: string;
}

/**
 * Browser renderer transport: one same-origin WebSocket with bounded outbound
 * JSON, rendererHello identity replacement, reconnect-by-new-registration,
 * and NO automatic command replay. Browser lifecycle messages
 * (`rendererVisibilityChanged` / `rendererFocusChanged`) are sent on
 * visibility/focus transitions before timers are throttled where possible.
 */
export class BrowserClientTransport implements ClientTransport {
  private socket: WebSocket | null = null;
  private connectionState: ClientConnectionState = 'connecting';
  private identity: RendererIdentity | null = null;
  private reconnectTimer: unknown = undefined;
  private reconnectAttempt = 0;
  private compatibilityBlocked = false;
  private disposed = false;
  private readonly handlers = new Set<(message: HostToWebviewMessage) => void>();
  private readonly stateHandlers = new Set<(state: ClientConnectionState) => void>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: BrowserClientTransportOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => window.clearTimeout(handle as number));
  }

  /** Open the socket (called once at bootstrap; reconnects automatically). */
  connect(): void {
    if (this.disposed || this.compatibilityBlocked || this.socket !== null) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${this.options.wsRoute}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.setState('connecting');
    socket.onopen = () => {
      // The host sends `rendererHello` immediately after accept; `ready` is
      // sent only after the hello replaces this transport's identity. An open
      // WebSocket alone is not an application connection: keeping the UI in
      // `connecting` prevents commands from appearing accepted in the brief
      // open-before-hello race.
    };
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // malformed host frames are dropped (host sends valid JSON)
      }
      if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return;
      const type = (message as { type: string }).type;
      if (type === 'rendererHello') {
        if (this.identity !== null || !isRendererHello(message)) {
          this.latchReloadRequired();
          socket.close(CLIENT_POLICY_CLOSE_CODE, 'invalid-renderer-hello');
          return;
        }
        const hello = message;
        const pageAssetVersion = getAssetVersion();
        if (hello.protocolVersion !== WEBVIEW_PROTOCOL_VERSION) {
          this.latchReloadRequired();
          socket.close(CLIENT_POLICY_CLOSE_CODE, 'protocol-violation');
          return;
        }
        if (pageAssetVersion !== undefined && hello.assetVersion !== pageAssetVersion) {
          this.latchReloadRequired();
          socket.close(CLIENT_POLICY_CLOSE_CODE, 'renderer-asset-mismatch');
          return;
        }
        this.identity = {
          hostInstanceId: hello.hostInstanceId,
          rendererId: hello.rendererId,
          rendererGeneration: hello.rendererGeneration,
          viewGeneration: hello.viewGeneration,
          assetVersion: hello.assetVersion,
          buildId: hello.buildId,
        };
        // `ready` is the application-protocol barrier. It MUST be the first
        // client frame: connection observers and onHandshake reconciliation
        // are externally callable and may post immediately. Do not expose the
        // identity or reset backoff until the ready frame has been accepted by
        // the socket.
        const readySent = this.sendRaw({
          type: 'ready',
          buildId: PIE_BUILD_ID,
          viewGeneration: this.identity.viewGeneration,
        });
        if (!readySent) {
          this.identity = null;
          // A close can race the send. Closing an otherwise-open socket makes
          // the failed handshake retryable instead of leaving it stuck in the
          // connecting state; onclose owns the backoff.
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'ready-send-failed');
          return;
        }
        // A complete client handshake is hello validation plus a successfully
        // queued ready frame. Sockets that fail before this point retain their
        // prior exponential-backoff attempt.
        this.reconnectAttempt = 0;
        this.setState('connected');
        this.options.onHandshake?.(this.identity);
        // Ask for a full snapshot after the ready barrier (the page is stable
        // across reconnects; the session's view generation is from hello).
        this.sendRaw({ type: 'refreshState', buildId: PIE_BUILD_ID, viewGeneration: this.identity.viewGeneration });
        // Every renderer registration starts with fresh host-side visibility
        // and focus beliefs. Reassert the page's current lifecycle state on
        // every hello (including reconnect while already hidden), rather than
        // waiting for a transition that may never occur.
        this.sendLifecycle('rendererVisibilityChanged', !document.hidden);
        this.sendLifecycle('rendererFocusChanged', document.hasFocus());
        return;
      }
      // The hello is the only legal first host frame. State or imperatives
      // observed before identity cannot be attributed to this registration.
      if (this.identity === null) return;
      const typed = message as HostToWebviewMessage;
      for (const handler of this.handlers) handler(typed);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.identity = null;
      if (RELOAD_REQUIRED_CLOSE_REASONS.has(event.reason)) {
        this.latchReloadRequired();
        return;
      }
      if (!this.disposed && !this.compatibilityBlocked) {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      // onclose always follows; nothing to do here beyond cleanup.
    };
  }

  /** Close the socket permanently (bootstrap teardown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.clearTimer && this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close(1000, 'client-dispose');
    this.socket = null;
    this.handlers.clear();
    this.stateHandlers.clear();
  }

  postMessage(message: WebviewToHostMessage): boolean {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      return false; // never send while disconnected; never replay automatically
    }
    if (this.identity === null) return false;
    let stamped: WebviewToHostMessage;
    let trackedCommandId: string | undefined;
    if (isBrowserApplicationCommand(message.type)) {
      // The ingress requires a browser-minted clientCommandId on every
      // application command; track it in the bounded pending store.
      const tracked = pendingCommandStore.track(message);
      if (!tracked) return false; // bounded store full: drop (defensive)
      stamped = { ...tracked.message, viewGeneration: this.identity.viewGeneration };
      trackedCommandId = (stamped as { clientCommandId?: string }).clientCommandId;
    } else {
      stamped = { ...message, viewGeneration: this.identity.viewGeneration };
    }
    const sent = this.sendRaw(stamped);
    if (!sent && trackedCommandId !== undefined) {
      pendingCommandStore.discardUnsent(trackedCommandId);
    }
    return sent;
  }

  private sendRaw(message: WebviewToHostMessage): boolean {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    let frame: string;
    try {
      frame = JSON.stringify(message);
    } catch {
      return false;
    }
    if (utf8ByteLength(frame) > OUTBOUND_FRAME_MAX_BYTES) return false;
    try {
      this.socket.send(frame);
      return true;
    } catch {
      // A close can race the readyState check. Treat it exactly like any
      // transport drop; callers own local rollback and commands are never
      // replayed automatically.
      return false;
    }
  }

  subscribe(handler: (message: HostToWebviewMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getConnectionState(): ClientConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(handler: (state: ClientConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    // React reads the transport state during render and subscribes in an
    // effect. A fast rendererHello can land in between those two steps. Push
    // the current value at subscription time so that race cannot strand the
    // UI in "Connecting…" while the socket is already usable.
    handler(this.connectionState);
    return () => this.stateHandlers.delete(handler);
  }

  /** Send one lifecycle message best-effort (visibility/focus). */
  sendLifecycle(type: 'rendererVisibilityChanged' | 'rendererFocusChanged', value: boolean): void {
    if (this.identity === null) return;
    const viewGeneration = this.identity.viewGeneration;
    if (type === 'rendererVisibilityChanged') {
      this.sendRaw({ type, visible: value, viewGeneration });
    } else {
      this.sendRaw({ type, focused: value, viewGeneration });
    }
  }

  private setState(next: ClientConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  /** Terminal protocol/asset failures require a page reload. They must also
   *  cancel any already-armed retry so one bad page cannot reconnect-storm. */
  private latchReloadRequired(): void {
    this.compatibilityBlocked = true;
    this.identity = null;
    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setState('reload-required');
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    // ±20% jitter around the exponential backoff.
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      this.connect();
    }, jittered);
  }
}
