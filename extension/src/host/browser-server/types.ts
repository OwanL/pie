/**
 * Browser server types (browser server plan §6).
 *
 * The shared HTTP/WebSocket server that serves the compiled webview UI to an
 * ordinary browser. It binds loopback by default and can expose private IPv4
 * LAN interfaces only when explicitly opted in. Browser sockets register
 * into the shared `RendererHub` through `BrowserRendererTransport`.
 */

import type { RendererHub } from '../renderers/renderer-hub';
import type { StateDeliveryClock } from '../sidebar/state-delivery-controller';
import type { RendererCommandContext, ViewState, WebviewToHostMessage } from '../../shared/protocol';
import type { InlineConfirmRequest } from './inline-confirmations';

/** Local configuration (browser server plan §6.2). Read from VS Code
 *  configuration (`pie.browserServer.*`) by the extension wiring; the server
 *  itself only consumes these values through `getSettings()`. */
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

export interface BrowserServerOptions {
  clock?: StateDeliveryClock;
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
   *  renderer context; `PieExtension` wires the `MessageRouter` here. */
  routeMessage(msg: WebviewToHostMessage, context: RendererCommandContext): Promise<void>;
  /** Release resources owned by a disconnected/reloaded browser document. */
  onRendererInvalidated?(rendererId: string, rendererGeneration: number): void;
  /** Compiled webview asset directory (`out/webview/panel`). */
  assetDir: string;
  rendererSelection?: { fallbackDir?: string; notBefore?: number };
  /** Optional pie icon path served at `/favicon.svg` (extension media). */
  iconPath?: string;
  /** Human-readable owner suffix for the served page title (workspace name). */
  titleSuffix?: string;
  /** Optional network-interface seam, useful for deterministic tests. */
  getLanIPv4Addresses?(): string[];
  /** Lifecycle outcome sink (logs + the single terminal-failure notice). */
  onLifecycle?(event: BrowserServerLifecycleEvent): void;
}

/** Browser server hub surface exposed to the extension host (schedule fan-out
 *  on host state changes; per-renderer state requests). */
export interface BrowserServerHubSurface {
  scheduleState(): void;
  scheduleSelectionState(): void;
  requestState(target: import('../renderers/types').RendererTarget): void;
  getHub(): RendererHub;
}

/** Bridge for the source-aware inline-confirmation seam (§9): `PieExtension`
 *  calls `requestInlineConfirm` from the effect runner; the server delivers
 *  the imperative to the INITIATING renderer and resolves on its explicit
 *  response (false on decline, timeout, or disconnect). */
export interface BrowserServerConfirmSurface {
  requestInlineConfirm(rendererId: string, request: InlineConfirmRequest): Promise<boolean>;
}

/** Clock abstraction for deterministic lifecycle tests. */
export interface BrowserClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type { StateDeliveryClock };
