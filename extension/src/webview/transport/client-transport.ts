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
import { isBrowserApplicationCommand } from '../../shared/browser-ingress';
import { pendingCommandStore } from './pending-command-store';

export type ClientConnectionState = 'connecting' | 'connected' | 'disconnected';

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
    if (this.disposed || this.socket !== null) return;
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
      // sent only after the hello replaces this transport's identity.
      this.reconnectAttempt = 0;
      this.setState('connected');
    };
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // malformed host frames are dropped (host sends valid JSON)
      }
      if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return;
      const typed = message as HostToWebviewMessage;
      if (typed.type === 'rendererHello') {
        const hello = typed as Extract<HostToWebviewMessage, { type: 'rendererHello' }>;
        this.identity = {
          hostInstanceId: hello.hostInstanceId,
          rendererId: hello.rendererId,
          rendererGeneration: hello.rendererGeneration,
          viewGeneration: hello.viewGeneration,
          assetVersion: hello.assetVersion,
        };
        this.options.onHandshake?.(this.identity);
        // The first handshake of every socket: announce readiness and ask for
        // a full snapshot (the page is stable across socket reconnects; the
        // session's view generation is the LIVE one from the hello).
        this.sendRaw({ type: 'ready', viewGeneration: this.identity.viewGeneration });
        this.sendRaw({ type: 'refreshState', viewGeneration: this.identity.viewGeneration });
        return;
      }
      for (const handler of this.handlers) handler(typed);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.identity = null;
      if (!this.disposed) {
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
    let stamped: WebviewToHostMessage;
    if (isBrowserApplicationCommand(message.type)) {
      // The ingress requires a browser-minted clientCommandId on every
      // application command; track it in the bounded pending store.
      const tracked = pendingCommandStore.track(message);
      if (!tracked) return false; // bounded store full: drop (defensive)
      stamped = { ...tracked.message, viewGeneration: this.identity?.viewGeneration ?? 0 };
    } else {
      stamped = { ...message, viewGeneration: this.identity?.viewGeneration ?? 0 };
    }
    if (this.identity === null) return false;
    return this.sendRaw(stamped);
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
    this.socket.send(frame);
    return true;
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
