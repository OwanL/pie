/**
 * Platform-neutral seam between the shared {@link HostRuntime} composition and
 * its host environment. The VS Code composition in `extension-host.ts` supplies
 * the production adapters (see `host/vscode/host-runtime-platform.ts`); Node
 * adapters and tests supply plain objects. Nothing in this module may import
 * `vscode`, and nothing outside the VS Code composition may implement it with
 * VS Code types.
 *
 * The runtime platform extends the session service's narrower
 * {@link SessionHostPlatform}: the same storage keys, the same
 * `pie` → `piAssistant` setting fallback, and the same workspace/runtime
 * identity reads are shared by both compositions so behavior stays identical.
 */

import type { HostToWebviewMessage } from '../../shared/protocol';
import type { RuntimeGenerationIdentity } from '../analytics-handoff-discovery';
import type { BrowserServerSettings } from '../browser-server/types';
import type { FileDiffCoreLike, FileDiffViewerLike } from '../core/file-diff-service';
import type { SessionHostPlatform } from '../session-service/platform';

/** Narrow renderer surface the runtime composition needs. The VS Code adapter
 *  binds this to the sidebar's `SidebarViewProvider`; a Node adapter binds it
 *  to whatever renderer surface it owns. The router's `SidebarProviderLike`
 *  and the session service's `DetailHostInfo` are structural subsets of this
 *  interface, so the same adapter serves both. */
export interface HostRendererSurface {
  postState(): void;
  postSelectionState?(): void;
  postImperative(message: HostToWebviewMessage): void;
  /** Renderer-scoped imperative (browser server plan §4.4): lazy-detail
   *  responses answer the INITIATING renderer, not the sidebar. */
  postImperativeToRenderer(rendererId: string, message: HostToWebviewMessage): void;
  /** Renderer-scoped snapshot request: handshake messages answer THEIR OWN
   *  renderer (browser server plan §4.1). Optional; absent means the adapter
   *  has no renderer-scoped snapshot path. */
  requestState?(rendererId?: string): void;
  scheduleState(): void;
  reveal(): void;
  /** Stable shared extension-host incarnation for renderer hubs and detail
   *  routing. Must be available when the runtime is constructed. */
  getHostInstanceId(): string;
  getViewGeneration(): number;
  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean;
}

/** Host shell notification capabilities (VS Code window messages and window
 *  focus state in production; no-ops or console output in a Node adapter). */
export interface HostNotifications {
  /** Fire-and-forget warning; hosts without a notification surface may log. */
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
  showErrorMessage(message: string): void;
  /** Modal confirmation: resolves to the chosen button label, or `undefined`
   *  if the user dismissed the dialog. */
  showModalConfirm(message: string, confirmChoice: string): PromiseLike<string | undefined>;
  /** Whether the host window currently has focus (completion policy). */
  isWindowFocused(): boolean;
}

/** Host editor/file capabilities used by router actions and effects. */
export interface HostEditorCapabilities {
  /** Show the host file picker and return selected filesystem paths. */
  openFilePicker(options: { title: string; openLabel: string }): Promise<readonly string[] | undefined>;
  /** Open the effective settings surface, including any host-specific fallback. */
  openSettings(): Promise<void>;
  /** Open a filesystem path in the host editor. */
  openFileInEditor(filePath: string): Promise<void>;
}

/**
 * Platform-neutral seam for the shared host runtime. Extends the session
 * service's {@link SessionHostPlatform} with everything the composition,
 * analytics authority, browser server, and effect layer need. Workspace- and
 * window-dependent reads stay lazy so adapters always reflect current state.
 */
export interface HostRuntimePlatform extends SessionHostPlatform {
  /** Renderer surface this runtime publishes state and imperatives to. */
  readonly renderer: HostRendererSurface;
  /** Host shell notifications (window messages + focus state). */
  readonly notifications: HostNotifications;
  /** Host editor/file capabilities (pickers, settings, editor opens). */
  readonly editor: HostEditorCapabilities;
  /** Stable workspace analytics identity (workspace-aware in VS Code; a
   *  stable process/workspace key in a Node adapter). */
  getWorkspaceAnalyticsId(): string;
  /** Legacy workspace identity keys for run-analytics store discovery. */
  getLegacyWorkspaceAnalyticsIds(): string[];
  /** Loaded runtime generation identity (publisher/name/version) when the
   *  host can prove it; undefined otherwise. */
  getRuntimeIdentity(): RuntimeGenerationIdentity | undefined;
  /** Legacy usage data root (VS Code `globalStorageUri` in production). */
  readonly legacyUsageDataRootPath: string;
  /** Browser server settings, re-read on every server start. */
  getBrowserServerSettings(): BrowserServerSettings;
  /** Persist the host-level LAN exposure preference (never session-scoped). */
  setBrowserServerLanEnabled(enabled: boolean): Promise<void>;
  /** Persist the host-level automatic-start preference
   *  (`pie.browserServer.enabled`). Optional; absent means the composition
   *  cannot safely start/stop the listener (standalone: the browser server
   *  is the sole renderer surface). */
  setBrowserServerEnabled?(enabled: boolean): Promise<void>;
  /** True when the host owns a renderer surface independent of the browser
   *  server, so the listener can be stopped without orphaning every
   *  renderer. Optional; absent means false. The VS Code composition sets
   *  this; standalone compositions never do. */
  readonly supportsBrowserServerToggle?: boolean;
  /** First workspace folder path, or undefined when no workspace is open.
   *  The changed-file core's original VS Code wiring had no cwd fallback, so
   *  this narrower read is kept separate from {@link getWorkspaceCwd}. */
  getWorkspaceFolderPath(): string | undefined;
  /** Staged renderer selection for the browser server (fallbackDir +
   *  live-publication `notBefore` gate). */
  getRendererSelection(): { fallbackDir: string; notBefore: number };
  /** Human-readable owner suffix for the served page title (workspace name). */
  getWorkspaceName(): string | undefined;
  /** Current experiment assignment override, or null (config-backed). */
  getExperimentAssignment(): string | null;
  /** Reload the host window so the extension host is reconstructed (the
   *  controlled analytics restart channel). Hosts without this capability
   *  should throw or log — it is invoked only by the handoff controller. */
  reloadWindow(): void;
  /** Platform-neutral changed-file viewer factory. The runtime owns the
   *  {@link FileDiffCoreLike}; the adapter owns the host-specific viewer. */
  createFileDiffViewer(service: FileDiffCoreLike): FileDiffViewerLike;
}

/** Status states the runtime reports through {@link HostRuntimeHooks}. */
export type HostRuntimeStatus = 'Starting' | 'Idle' | 'Thinking' | 'Error';

/** Optional adapter hooks the runtime calls without ever awaiting. */
export interface HostRuntimeHooks {
  /** Status glances for host shell affordances (the VS Code status bar).
   *  `Starting` is reported synchronously by `restart()`; Idle/Thinking/Error
   *  are reported from the coalesced render microtask. */
  onStatusChange?(state: HostRuntimeStatus): void;
}