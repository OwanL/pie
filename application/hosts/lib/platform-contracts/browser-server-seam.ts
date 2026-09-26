/**
 * Host-neutral browser-server seam (repository-organization plan §3.2;
 * browser server plan §6/§7).
 *
 * The shared `HostRuntime` composition consumes the browser service only
 * through the {@link BrowserServerService} lifecycle port and the
 * {@link HostRuntimeBrowserServerOptions} factory options declared here; the
 * shared composition must not depend on the concrete class or the concrete
 * construction options, even through type-only imports. The concrete
 * `BrowserServer` in `host/browser-server/` implements the service, and the
 * concrete hosts (VS Code, standalone) construct it inside their platform
 * adapters with their own asset paths.
 *
 * The canonical settings/lifecycle shapes are shared once from this module
 * (`host/browser-server/types.ts` re-exports them for its own domain); they
 * are never mirrored into consumers.
 */

import type {
  HostToWebviewMessage,
  RendererCommandContext,
  ViewState,
  WebviewToHostMessage,
} from '../../../lib/protocol/index.js';

/** Local configuration (browser server plan §6.2). Read from VS Code
 *  configuration (`pie.browserServer.*`) by the extension wiring and from the
 *  standalone launcher/storage by the standalone platform; the server itself
 *  only consumes these values through its options' `getSettings()`. */
export interface BrowserServerSettings {
  /** Start automatically when Pie activates. */
  enabled: boolean;
  /** Preferred port (default 1997; valid range 1..65535). */
  port: number;
  /** Bind IPv4 all-interfaces and advertise private LAN URLs only when opted in. */
  allowLan: boolean;
  /** When true, fail instead of falling back if the preferred port is
   *  occupied. */
  requirePreferredPort: boolean;
}

/** Result of one `start()` attempt (browser server plan §6.2 lifecycle). */
export type BrowserServerStartOutcome =
  | { kind: 'started'; url: string; port: number; preferred: boolean }
  | { kind: 'disabled' }
  | { kind: 'failed'; reason: string };

/** Observable server state for commands (Open/Copy/Restart). */
export interface BrowserServerState {
  running: boolean;
  /** The ACTUAL loopback URL of this instance, or null while stopped. */
  url: string | null;
  /** Bound IPv4 address (`127.0.0.1` by default, `0.0.0.0` when LAN is enabled). */
  bindAddress: string | null;
  /** Whether this running instance has trusted-LAN access enabled. */
  lanEnabled: boolean;
  /** Usable RFC1918/link-local LAN URLs; empty unless LAN is enabled. */
  lanUrls: string[];
  port: number | null;
  clientCount: number;
  startedAt: number | null;
  /** True when the last bind used the preferred port (informational). */
  preferred: boolean;
}

/** Lifecycle outcomes, deduplicated per §6.2: only a terminal bind/start
 *  failure produces a user notice; successful fallback binds are
 *  informational logs only. */
export type BrowserServerLifecycleEvent =
  | { kind: 'started'; url: string; preferred: boolean; lanEnabled: boolean; lanUrls: string[] }
  | { kind: 'fallback'; url: string; lanEnabled: boolean; lanUrls: string[] }
  | { kind: 'bind-failed'; port: number; requirePreferredPort: boolean; error: string }
  | { kind: 'restarted'; url: string }
  | { kind: 'stopped'; reason: 'shutdown' | 'restart' | 'disabled' }
  | { kind: 'client-connected'; rendererId: string }
  | { kind: 'client-closed'; rendererId: string; code: number; reason: string };

/** Source-aware inline confirmation request (browser server plan §2.2/§9):
 *  model-switch confirm and destructive `revertFile` confirmations are
 *  delivered to the INITIATING renderer; the host proceeds only on that
 *  renderer's explicit response. */
export interface InlineConfirmRequest {
  kind: 'model-switch' | 'destructive-revert';
  sessionPath?: string;
  message: string;
  confirmChoice: string;
}

/** Factory options the shared runtime composition supplies to the concrete
 *  host adapter's `HostRuntimePlatform.createBrowserServer` (browser server
 *  plan §7). The concrete hosts extend these with their asset/icon/title
 *  locations in `host/browser-server/types.ts`. */
export interface HostRuntimeBrowserServerOptions {
  /** Shared extension-host incarnation used by every renderer hub. */
  hostInstanceId?: string;
  /** Read current local settings (the server re-reads on every start). */
  getSettings(): BrowserServerSettings;
  /** Shared projected `ViewState`; the server's renderer hub projects it at
   *  most once per logical render. */
  getViewState(): ViewState;
  /** Running-session count for the hub's streaming schedule debounce. */
  getRunningSessionCount(): number;
  /** Browser command routing: the exactly-once gate calls this with the
   *  renderer context; the composition wires the `MessageRouter` here. */
  routeMessage(msg: WebviewToHostMessage, context: RendererCommandContext): Promise<void>;
  /** Release resources owned by a disconnected/reloaded browser document. */
  onRendererInvalidated?(rendererId: string, rendererGeneration: number): void;
  /** Lifecycle outcome sink (logs + the single terminal-failure notice). */
  onLifecycle?(event: BrowserServerLifecycleEvent): void;
}

/** Host-neutral lifecycle/service port of the loopback browser server
 *  (browser server plan §6/§7). The runtime composition starts it after the
 *  host can build a valid initial `ViewState`, fans state changes out through
 *  it, and stops/disposes it in the host shutdown order; start/stop are
 *  idempotent. */
export interface BrowserServerService {
  /** Idempotent start; re-reads settings and binds per §6.2. */
  start(): Promise<BrowserServerStartOutcome>;
  /** Idempotent stop; closes sockets and the HTTP listener. */
  stop(): Promise<void>;
  /** Observable server state for host commands and projection. */
  getState(): BrowserServerState;
  /** Fan-out scheduling on host state changes. */
  scheduleState(): void;
  /** Renderer-scoped snapshot request (handshake answers its own renderer,
   *  browser server plan §4.1). */
  requestState(rendererId: string): void;
  /** Renderer-scoped imperative: targeted responses answer the INITIATING
   *  renderer (browser server plan §4.4). */
  postImperative(message: HostToWebviewMessage, rendererId: string): void;
  /** Generation fence for renderer-owned view state. */
  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean;
  /** Source-aware inline confirmation (§9): deliver to the INITIATING
   *  renderer; resolve on explicit response; disconnect cancels. */
  requestInlineConfirm(rendererId: string, request: InlineConfirmRequest): Promise<boolean>;
  /** Release resources; idempotent shutdown (§7). */
  dispose(): void;
}