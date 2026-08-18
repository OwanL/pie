/**
 * Embedded loopback HTTP/WebSocket browser server (browser server plan §6,
 * §7).
 *
 * Serves the compiled webview UI over `http://127.0.0.1:<port>` and accepts
 * browser renderer WebSockets at `/ws`. `PieExtension` owns the lifecycle:
 * start after the host can build a valid initial `ViewState`, stop on
 * shutdown; start/stop are idempotent, a delayed `listen()` completing after
 * shutdown began is closed immediately, and the listener binds loopback only.
 *
 * Port policy (§6.2): prefer the configured port (default 1997); when it is
 * occupied and `requirePreferredPort` is false, bind an OS-assigned loopback
 * port and record the ACTUAL URL. Terminal bind failures surface exactly one
 * lifecycle event (`bind-failed`); successful fallback binds are
 * informational (`fallback`).
 *
 * HTTP surface (§6.1): `GET /` (manifest-derived HTML shell with a strict
 * same-origin CSP), `GET /assets/<hashed-file>` (manifest allowlist only),
 * optional `GET /favicon.svg`, and `GET /health` (local readiness only). No
 * generic APIs, backend RPC routes, filesystem routes, uploads, or command
 * endpoints. Security (§6.3): loopback-only bind, Host/Origin validation on
 * upgrades, bounded client count, fail-closed ingress per socket (in the
 * transport), and no state in `/health` or logs.
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';

import { WebSocketServer, type WebSocket } from 'ws';

import type { RendererRegistration } from '../renderers/types';
import { RendererHub } from '../renderers/renderer-hub';
import type { HostToWebviewMessage } from '../../shared/protocol';
import { BROWSER_SERVER_POLICY, isValidLoopbackHostHeader, isValidWebSocketOrigin, pageUrl } from './policy';
import { BrowserStaticAssets } from './static-assets';
import { BrowserRendererTransport, BROWSER_CLOSE_REASONS } from './browser-renderer-transport';
import { BrowserCommandGate } from './command-decision-ledger';
import { InlineConfirmationService } from './inline-confirmations';
import type {
  BrowserClock,
  BrowserServerLifecycleEvent,
  BrowserServerOptions,
  BrowserServerSettings,
  BrowserServerStartOutcome,
  BrowserServerState,
} from './types';

const WS_ROUTE = '/ws';
const HEALTH_ROUTE = '/health';
const FAVICON_ROUTE = '/favicon.svg';

const SYSTEM_CLOCK: BrowserClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class BrowserServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly staticAssets: BrowserStaticAssets;
  private readonly clock: BrowserClock;
  /** The browser renderer hub: every accepted socket registers here and the
   *  host schedules fan-out through it (owning this hub keeps browser
   *  delivery state fully isolated from the sidebar's hub). */
  private readonly hub: RendererHub;
  /** Exactly-once command decision gate (browser server plan §5.2). */
  private readonly gate: BrowserCommandGate;
  /** Source-aware inline confirmations (§2.2/§9), resolved by the initiating
   *  renderer's explicit `inlineConfirmResponse`; disconnect cancels. */
  private readonly confirmations: InlineConfirmationService;
  /** Per-renderer registrations (`Record<string, T>` host collections). */
  private readonly registrations: Record<string, RendererRegistration> = {};
  /** Per-renderer transports, for shutdown close + client-count accounting. */
  private readonly transports: Record<string, BrowserRendererTransport> = {};
  private state: BrowserServerState = {
    running: false,
    url: null,
    port: null,
    clientCount: 0,
    startedAt: null,
    preferred: false,
  };
  private startPromise: Promise<BrowserServerStartOutcome> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private disposed = false;

  constructor(private readonly options: BrowserServerOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.staticAssets = new BrowserStaticAssets(options.assetDir);
    this.hub = new RendererHub({
      clock: this.clock,
      getViewState: options.getViewState,
      getRunningSessionCount: options.getRunningSessionCount,
      onMessage: (msg, context) => void this.gate.route(msg, context),
    });
    this.confirmations = new InlineConfirmationService({
      postToRenderer: (rendererId, message) => this.hub.postImperative(message, rendererId),
      now: () => this.clock.now(),
      setTimeout: (callback, delayMs) => this.clock.setTimeout(callback, delayMs),
      clearTimeout: (handle) => this.clock.clearTimeout(handle),
    });
    this.gate = new BrowserCommandGate({
      routeMessage: options.routeMessage,
      postToRenderer: (rendererId, message) => this.hub.postImperative(message, rendererId),
      closeRenderer: (rendererId, reason) => {
        this.transports[rendererId]?.closeSocket(reason);
      },
      onInlineConfirmResponse: (rendererId, confirmId, confirmed) => {
        this.confirmations.handleResponse(rendererId, confirmId, confirmed);
      },
      now: () => this.clock.now(),
    });
  }

  /** Hub surface for host-side scheduling (PieExtension fans every render
   *  into both hubs). */
  scheduleState(): void {
    this.hub.scheduleState();
  }

  scheduleSelectionState(): void {
    this.hub.scheduleSelectionState();
  }

  requestState(rendererId: string): void {
    this.hub.requestState(rendererId);
  }

  /** Renderer-scoped imperative (browser server plan §4.4): lazy-detail
   *  responses and other targeted imperatives answer the INITIATING renderer. */
  postImperative(message: HostToWebviewMessage, rendererId: string): void {
    this.hub.postImperative(message, rendererId);
  }

  getHub(): RendererHub {
    return this.hub;
  }

  /** Source-aware inline confirmation (§9): deliver to the INITIATING
   *  renderer; resolve on explicit response; disconnect cancels. */
  requestInlineConfirm(rendererId: string, request: import('./inline-confirmations').InlineConfirmRequest): Promise<boolean> {
    return this.confirmations.request(rendererId, request);
  }

  getLedger(): import('./command-decision-ledger').BrowserCommandDecisionLedger {
    return this.gate.getLedger();
  }

  /** Idempotent start. Re-reads settings; binds the preferred port with
   *  fallback per §6.2. A delayed `listen()` completing after stop began is
   *  closed immediately. */
  start(): Promise<BrowserServerStartOutcome> {
    if (this.startPromise) return this.startPromise;
    if (this.disposed) return Promise.resolve({ kind: 'failed', reason: 'disposed' });
    this.stopRequested = false;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<BrowserServerStartOutcome> {
    const settings = this.readSettings();
    if (!settings.enabled) {
      this.emit({ kind: 'stopped', reason: 'disabled' });
      return { kind: 'disabled' };
    }
    try {
      await this.staticAssets.load();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emit({ kind: 'bind-failed', port: settings.port, requirePreferredPort: settings.requirePreferredPort, error: reason });
      return { kind: 'failed', reason };
    }

    const httpServer = http.createServer((req, res) => void this.handleHttpRequest(req, res));
    httpServer.on('checkContinue', (_req, res) => {
      res.writeHead(417);
      res.end();
    });
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: BROWSER_SERVER_POLICY.maxFrameBytes });
    httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    // Preferred-port bind, then fallback to an OS-assigned loopback port.
    let port: number;
    let preferred = true;
    try {
      await this.listen(httpServer, settings.port, '127.0.0.1');
      // 0 is the OS-assigned sentinel: the actual bound port must be read
      // back from the server, not taken from settings.
      port = settings.port === 0 ? this.actualPort(httpServer) : settings.port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const terminalFailure = async (reason: string): Promise<BrowserServerStartOutcome> => {
        this.emit({ kind: 'bind-failed', port: settings.port, requirePreferredPort: settings.requirePreferredPort, error: reason });
        await this.closeHttpServer(httpServer);
        return { kind: 'failed', reason };
      };
      if (code === 'EADDRINUSE' && !settings.requirePreferredPort) {
        preferred = false;
        try {
          await this.listen(httpServer, 0, '127.0.0.1');
          port = this.actualPort(httpServer);
        } catch (fallbackError) {
          return terminalFailure(fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
        }
      } else {
        return terminalFailure(error instanceof Error ? error.message : String(error));
      }
    }

    // A stop requested while the bind was in flight wins (§7.5).
    if (this.stopRequested) {
      await this.closeHttpServer(httpServer);
      this.httpServer = null;
      this.wss = null;
      this.emit({ kind: 'stopped', reason: 'shutdown' });
      return { kind: 'disabled' };
    }

    const url = pageUrl(port);
    this.state = {
      running: true,
      url,
      port,
      clientCount: 0,
      startedAt: this.clock.now(),
      preferred,
    };
    if (preferred) this.emit({ kind: 'started', url, preferred: true });
    else this.emit({ kind: 'fallback', url });
    return { kind: 'started', url, port, preferred };
  }

  /** Idempotent stop: stop accepting HTTP/upgrades, close tracked browser
   *  sockets, close/await the HTTP server. */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    this.stopRequested = true;
    this.stopPromise = (async () => {
      const wasRunning = this.state.running;
      this.state = { ...this.state, running: false, url: null, port: null, startedAt: null };
      for (const rendererId of Object.keys(this.transports)) {
        this.confirmations.cancelForRenderer(rendererId);
      }
      for (const transport of Object.values(this.transports)) transport.dispose();
      this.wss?.close();
      this.wss = null;
      const server = this.httpServer;
      this.httpServer = null;
      if (server) await this.closeHttpServer(server);
      // The hub survives a stop: `pie: Restart Browser Server` rebinds and
      // accepts fresh registrations. Only `dispose()` tears the hub down.
      if (wasRunning) this.emit({ kind: 'stopped', reason: 'shutdown' });
    })().finally(() => {
      this.stopPromise = null;
    });
    await this.stopPromise;
  }

  /** Read the CURRENT configured settings (fresh on every start). */
  readSettings(): BrowserServerSettings {
    const raw = this.options.getSettings();
    return {
      enabled: raw.enabled !== false,
      // 0 is the OS-assigned sentinel and must pass through untouched.
      port: raw.port === 0
        || (Number.isInteger(raw.port) && raw.port >= BROWSER_SERVER_POLICY.minPort && raw.port <= BROWSER_SERVER_POLICY.maxPort)
        ? raw.port
        : BROWSER_SERVER_POLICY.defaultPort,
      requirePreferredPort: raw.requirePreferredPort === true,
    };
  }

  getState(): BrowserServerState {
    return { ...this.state, clientCount: Object.keys(this.transports).length };
  }

  isRunning(): boolean {
    return this.state.running;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop().finally(() => {
      this.hub.dispose();
    });
  }

  // ─── HTTP surface (§6.1) ──────────────────────────────────────────────────

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
        res.end();
        return;
      }
      const hasBody = (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > 0)
        || req.headers['transfer-encoding'] !== undefined;
      if (hasBody) {
        res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
        res.end();
        return;
      }
      const pathname = safePathname(req.url);
      if (pathname === null) {
        res.writeHead(400, securityHeaders());
        res.end();
        return;
      }
      if (pathname === '/') {
        const rendered = this.staticAssets.renderHtml({
          wsRoute: WS_ROUTE,
          port: this.state.port ?? 0,
          titleSuffix: this.options.titleSuffix,
        });
        res.writeHead(200, securityHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': rendered.csp,
        }));
        res.end(method === 'HEAD' ? undefined : rendered.html);
        return;
      }
      if (pathname === HEALTH_ROUTE) {
        const body = JSON.stringify({ ok: true });
        res.writeHead(200, securityHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        }));
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }
      if (pathname === FAVICON_ROUTE && this.options.iconPath) {
        const body = await this.readFileSafe(this.options.iconPath);
        if (body === null) {
          res.writeHead(404, securityHeaders());
          res.end();
          return;
        }
        res.writeHead(200, securityHeaders({
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=3600',
        }));
        res.end(method === 'HEAD' ? undefined : body);
        return;
      }
      const asset = this.staticAssets.resolveRequest(pathname);
      if (asset === null) {
        res.writeHead(404, securityHeaders());
        res.end();
        return;
      }
      const body = await this.readFileSafe(asset.absolutePath);
      if (body === null) {
        res.writeHead(404, securityHeaders());
        res.end();
        return;
      }
      res.writeHead(200, securityHeaders({
        'Content-Type': asset.contentType,
        // Hashed assets are immutable: the file name contains the content hash.
        'Cache-Control': 'public, max-age=31536000, immutable',
      }));
      res.end(method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500, securityHeaders());
      res.end();
    }
  }

  // ─── Upgrade surface (§6.3) ───────────────────────────────────────────────

  private handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const wss = this.wss;
    if (!wss || !this.state.running) {
      socket.destroy();
      return;
    }
    const pathname = safePathname(req.url);
    if (pathname !== WS_ROUTE) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const port = this.state.port ?? 0;
    if (!isValidLoopbackHostHeader(req.headers.host, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isValidWebSocketOrigin(req.headers.origin, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (Object.keys(this.transports).length >= BROWSER_SERVER_POLICY.maxConcurrentRenderers) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(1013, BROWSER_CLOSE_REASONS.clientLimit);
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.onBrowserConnection(ws));
  }

  private onBrowserConnection(socket: WebSocket): void {
    const transport = new BrowserRendererTransport(socket, {
      assetVersion: this.staticAssets.getAssetVersion(),
      now: () => this.clock.now(),
      setTimeout: (callback, delayMs) => this.clock.setTimeout(callback, delayMs),
      clearTimeout: (handle) => this.clock.clearTimeout(handle),
      onClose: (info) => this.onTransportClose(info.rendererId, info.code, info.reason),
    });
    const registration = this.hub.registerRenderer(transport);
    this.registrations[registration.rendererId] = registration;
    this.transports[registration.rendererId] = transport;
    transport.start(registration);
    this.emit({ kind: 'client-connected', rendererId: registration.rendererId });
  }

  private onTransportClose(rendererId: string, code: number, reason: string): void {
    const registration = this.registrations[rendererId];
    if (registration) {
      registration.handleViewDisposed();
      registration.dispose();
      delete this.registrations[rendererId];
    }
    delete this.transports[rendererId];
    // Disconnect cancels every pending inline confirmation for this renderer.
    this.confirmations.cancelForRenderer(rendererId);
    this.emit({ kind: 'client-closed', rendererId, code, reason });
  }

  // ─── Plumbing ─────────────────────────────────────────────────────────────

  private emit(event: BrowserServerLifecycleEvent): void {
    this.options.onLifecycle?.(event);
  }

  private listen(server: http.Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  private actualPort(server: http.Server): number {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  private closeHttpServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async readFileSafe(absolutePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(absolutePath);
    } catch {
      return null;
    }
  }
}

/** Parse and sanitize a request URL pathname; null on malformed URLs. */
function safePathname(rawUrl: string | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return null;
  try {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    return url.pathname;
  } catch {
    return null;
  }
}

/** Common security headers for every response (§6.3). */
function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}
