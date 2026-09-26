/**
 * Browser server types (browser server plan §6).
 *
 * The shared HTTP/WebSocket server that serves the compiled webview UI to an
 * ordinary browser. It binds loopback by default and can expose private IPv4
 * LAN interfaces only when explicitly opted in. Browser sockets register
 * into the shared `RendererHub` through `BrowserRendererTransport`.
 */

import type { RendererHub } from '../lib/renderer-delivery/renderer-hub';
import type { StateDeliveryClock } from '../lib/renderer-delivery/state-delivery-controller';
import type {
  HostRuntimeBrowserServerOptions,
  InlineConfirmRequest,
} from '../lib/platform-contracts/browser-server-seam.js';

/** Canonical browser-server settings/lifecycle shapes are defined once in the
 *  host-neutral seam (`application/hosts/lib/platform-contracts/browser-server-seam.ts`) and re-exported
 *  here for the browser-server domain and its consumers; they are never
 *  mirrored. */
export type {
  BrowserServerLifecycleEvent,
  BrowserServerService,
  BrowserServerSettings,
  BrowserServerStartOutcome,
  BrowserServerState,
  HostRuntimeBrowserServerOptions,
  InlineConfirmRequest,
} from '../lib/platform-contracts/browser-server-seam.js';

/** Concrete construction options: the host-neutral factory options from the
 *  runtime seam extended with the concrete hosts' asset/icon/title locations
 *  (browser server plan §6). Only the VS Code/standalone platform adapters
 *  construct this shape. */
export interface BrowserServerOptions extends HostRuntimeBrowserServerOptions {
  clock?: StateDeliveryClock;
  /** Compiled webview asset directory (`out/webview/panel`). */
  assetDir: string;
  rendererSelection?: { fallbackDir?: string; notBefore?: number };
  /** Optional pie icon path served at `/favicon.svg` (extension media). */
  iconPath?: string;
  /** Human-readable owner suffix for the served page title (workspace name). */
  titleSuffix?: string;
  /** Optional network-interface seam, useful for deterministic tests. */
  getLanIPv4Addresses?(): string[];
}

/** Browser server hub surface exposed to the extension host (schedule fan-out
 *  on host state changes; per-renderer state requests). */
export interface BrowserServerHubSurface {
  scheduleState(): void;
  scheduleSelectionState(): void;
  requestState(target: import('../lib/renderer-delivery/types').RendererTarget): void;
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
