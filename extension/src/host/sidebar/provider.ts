import * as vscode from 'vscode';

import { bootLog } from '../util/audit';
import { resolveWebviewHtml, getWebviewRoots } from '../webview/assets';
import { injectViewGenerationMeta, SidebarHotReloader } from './hot-reloader';
import { RendererHub } from '../renderers/renderer-hub';
import type { RendererRegistration, RendererTransport } from '../renderers/types';
import type { StateDeliveryClock } from './state-delivery-controller';
import type { StateDeliveryRecoveryReason } from './state-delivery-controller';
import type { HostToWebviewMessage, ViewState, WebviewToHostMessage } from '../../shared/protocol';
import { PIE_BUILD_ID } from '../../shared/protocol';

type ResolvedWebviewHtml = Awaited<ReturnType<typeof resolveWebviewHtml>>;

const SYSTEM_CLOCK: StateDeliveryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SidebarViewProviderOptions {
  clock?: StateDeliveryClock;
  resolveAssets?(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<ResolvedWebviewHtml>;
  getRoots?(context: vscode.ExtensionContext): readonly vscode.Uri[];
  settlementTimeoutMs?: number;
  commitTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetryAttempts?: number;
  acceptedLedgerCapacity?: number;
  /** Renderer-scoped snapshot routing for renderers NOT owned by this hub
   *  (browser sockets registered in the browser server's hub). Wired by
   *  `PieExtension`; absent, foreign ids are a no-op. */
  onForeignRequestState?(rendererId: string): void;
  /** Renderer-scoped imperative routing for foreign renderers (browser
   *  server plan §4.4: lazy-detail responses answer the initiating renderer). */
  onForeignPostImperative?(rendererId: string, message: HostToWebviewMessage): void;
  /** Release resources owned by a renderer document before invalidation. */
  onRendererInvalidated?(rendererId: string, rendererGeneration: number): void;
  /** Test/embedding seam for the reload-required compatibility boundary. */
  onBuildMismatch?(details: { actualBuildId: string | null; expectedBuildId: string }): void | Promise<void>;
}

/**
 * VS Code sidebar adapter around the renderer hub. All delivery, readiness,
 * recovery, and imperative ownership lives in the hub's per-renderer session;
 * this class owns only VS Code-specific concerns: the `WebviewView` lifecycle,
 * asset resolution, hot reload, reveal, and the message prelude (asset-version
 * reload and hot-reload gating).
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private visibilityDisposable?: vscode.Disposable;
  private viewDisposeDisposable?: vscode.Disposable;
  private messageDisposable?: vscode.Disposable;
  private readonly hotReloader: SidebarHotReloader;
  private readonly hub: RendererHub;
  private readonly session: RendererRegistration;
  private readonly providerOptions: SidebarViewProviderOptions;
  private messageHandler?: (message: WebviewToHostMessage) => void;
  private visibilityHandler?: (visible: boolean) => void;
  private buildMismatchDetected = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    getViewState: () => ViewState,
    onMessage: (msg: WebviewToHostMessage) => void,
    getRunningSessionCount: () => number = () => 0,
    options: SidebarViewProviderOptions = {},
  ) {
    this.providerOptions = options;
    const clock = options.clock ?? SYSTEM_CLOCK;
    this.hub = new RendererHub({
      clock,
      getViewState,
      onMessage,
      onRendererInvalidated: options.onRendererInvalidated,
      getRunningSessionCount,
      settlementTimeoutMs: options.settlementTimeoutMs,
      commitTimeoutMs: options.commitTimeoutMs,
      retryDelayMs: options.retryDelayMs,
      maxRetryAttempts: options.maxRetryAttempts,
      acceptedLedgerCapacity: options.acceptedLedgerCapacity,
    });

    // The transport closures reference the hot reloader, which is constructed
    // after registration; the closures only run after construction completes.
    let hotReloader!: SidebarHotReloader;
    const transport: RendererTransport = {
      kind: 'vscode',
      post: (message) => this.postToView(message),
      onMessage: (handler) => {
        this.messageHandler = handler as (message: WebviewToHostMessage) => void;
        return {
          dispose: () => {
            if (this.messageHandler === handler) this.messageHandler = undefined;
          },
        };
      },
      onVisibilityChanged: (handler) => {
        this.visibilityHandler = handler;
        return {
          dispose: () => {
            if (this.visibilityHandler === handler) this.visibilityHandler = undefined;
          },
        };
      },
      isAttached: () => !!this.view,
      isReloading: () => hotReloader.isReloading(),
      clearReloading: () => hotReloader.clearReloading(),
      recover: (reason) => hotReloader.reloadForRecovery(reason as StateDeliveryRecoveryReason),
      dispose: () => {},
    };
    this.session = this.hub.registerRenderer(transport);
    this.hotReloader = hotReloader = new SidebarHotReloader({
      getContext: () => this.context,
      getView: () => this.view,
      onReloadStart: (reason) => this.session.handleReloadStart(reason),
      getViewGeneration: () => this.session.getViewGeneration(),
      resolveAssets: options.resolveAssets,
    });
  }

  dispose(): void {
    this.visibilityDisposable?.dispose();
    this.viewDisposeDisposable?.dispose();
    this.messageDisposable?.dispose();
    this.view = undefined;
    this.hotReloader.dispose();
    this.hub.dispose();
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.hotReloader.resetReloadFlags();
    this.session.handleViewResolved(webviewView.visible);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [...this.getRoots()],
    };

    const resolver = this.getResolveAssets();
    const resolvedAssets = await resolver(this.context, webviewView.webview);
    if (this.view !== webviewView) return;
    this.hotReloader.setCurrentAssetVersion(resolvedAssets.assetVersion);

    bootLog('sidebar-provider', 'view.resolved', {
      hostInstanceId: this.session.getHostInstanceId(),
      visible: webviewView.visible,
      viewGeneration: this.session.getViewGeneration(),
    });

    this.installMessageHandler(webviewView);
    this.installViewLifecycleHandlers(webviewView);
    this.hotReloader.ensureAssetWatcher();
    webviewView.webview.html = injectViewGenerationMeta(
      resolvedAssets.html,
      this.session.getViewGeneration(),
    );
    this.session.armReadinessProbeIfStuck();
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    void vscode.commands.executeCommand('workbench.view.extension.pie');
  }

  getDebugState(): {
    hasView: boolean;
    visible: boolean;
    webviewReady: boolean;
    globalDirty: boolean;
    globalRevision: number;
    lastStateAppliedRevision: number;
    pendingStateAppliedRevision: number | null;
    viewGeneration: number;
    hostInstanceId: string;
  } {
    const session = this.session.getDebugState();
    return {
      hasView: !!this.view,
      visible: this.view?.visible ?? false,
      webviewReady: session.webviewReady,
      globalDirty: session.globalDirty,
      globalRevision: session.globalRevision,
      lastStateAppliedRevision: session.lastStateAppliedRevision,
      pendingStateAppliedRevision: session.pendingStateAppliedRevision,
      viewGeneration: session.viewGeneration,
      hostInstanceId: session.hostInstanceId,
    };
  }

  /** Request one immediate authoritative full snapshot. */
  postState(): void {
    this.hub.requestState(this.session.rendererId);
  }

  /**
   * Renderer-scoped immediate snapshot (browser server plan §4.1): handshake
   * messages answer THEIR OWN renderer. The sidebar's own renderer is served
   * by this hub; a foreign renderer id (a browser socket registered in the
   * browser server's hub) is routed through the foreign handler wired by
   * `PieExtension`.
   */
  requestState(rendererId?: string): void {
    if (rendererId === undefined || rendererId === this.session.rendererId) {
      this.hub.requestState(this.session.rendererId);
      return;
    }
    this.providerOptions.onForeignRequestState?.(rendererId);
  }

  /** Renderer-scoped imperative (browser server plan §4.4): lazy-detail
   *  responses and other targeted imperatives answer THEIR OWN renderer.
   *  Foreign renderer ids route through the browser server's hub. */
  postImperativeToRenderer(rendererId: string, message: HostToWebviewMessage): void {
    if (rendererId === this.session.rendererId) {
      this.hub.postImperative(message, rendererId);
      return;
    }
    this.providerOptions.onForeignPostImperative?.(rendererId, message);
  }

  /**
   * Request an interaction-critical snapshot for an explicit tab selection.
   * It may supersede an older accepted streaming snapshot rather than making
   * the click wait for that transcript's commit deadline.
   */
  postSelectionState(): void {
    this.hub.scheduleSelectionState();
  }

  /** Debounced fan-out of one logical render to every renderer session. */
  scheduleState(): void {
    this.hub.scheduleState();
  }

  /** Imperatives remain separate from authoritative full snapshots. */
  postImperative(msg: HostToWebviewMessage): void {
    this.hub.postImperative(msg);
  }

  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean {
    return this.hub.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration);
  }

  /** Stable host identity for Phase 5 detail routing. */
  getHostInstanceId(): string {
    return this.session.getHostInstanceId();
  }

  /** Current renderer generation used to fence Phase 5 subscription owners. */
  getViewGeneration(): number {
    return this.session.getViewGeneration();
  }

  /** The renderer hub (browser renderers register here in Milestone 2). */
  getRendererHub(): RendererHub {
    return this.hub;
  }

  /** Delivery controller access (readiness-probe path used by tests). */
  get delivery(): ReturnType<RendererRegistration['getDeliveryController']> {
    return this.session.getDeliveryController();
  }

  private getResolveAssets(): NonNullable<SidebarViewProviderOptions['resolveAssets']> {
    return this.providerOptions.resolveAssets ?? resolveWebviewHtml;
  }

  private getRoots(): readonly vscode.Uri[] {
    return this.providerOptions.getRoots?.(this.context) ?? getWebviewRoots(this.context);
  }

  private installMessageHandler(webviewView: vscode.WebviewView): void {
    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      if (this.view !== webviewView) return;
      if (!this.preludeMessage(msg)) return;
      this.messageHandler?.(msg);
    });
  }

  /** VS Code-specific prelude: asset self-heal, then build compatibility. The hot-reload
   *  gate for unstamped messages lives in the renderer session, after the
   *  render-evidence branch and generation check (matching the original
   *  provider order, so evidence is never dropped during a reload). */
  private preludeMessage(msg: WebviewToHostMessage): boolean {
    const incomingAssetVersion = this.hotReloader.getIncomingAssetVersion(msg);
    if (this.hotReloader.shouldReloadForAssetMismatch(msg, incomingAssetVersion)) {
      bootLog('sidebar-provider', 'assetVersion.mismatch', {
        actualAssetVersion: incomingAssetVersion,
        expectedAssetVersion: this.hotReloader.getCurrentAssetVersion(),
        type: msg.type,
      });
      void this.hotReloader.reloadForAssetMismatch();
      return false;
    }
    if (this.buildMismatchDetected) return false;
    if (
      (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot')
      && msg.buildId !== PIE_BUILD_ID
    ) {
      this.buildMismatchDetected = true;
      const incompatibleView = this.view;
      // Compatibility skew is terminal for this extension-host incarnation,
      // not an ordinary hot-reload episode. Detach the transport and dispose
      // renderer ownership so later global dirty events cannot re-arm the
      // normal readiness/hot-reload recovery loop.
      this.view = undefined;
      this.messageDisposable?.dispose();
      this.session.handleViewDisposed();
      if (incompatibleView) incompatibleView.webview.html = this.reloadRequiredHtml();
      bootLog('sidebar-provider', 'buildId.mismatch', {
        actualBuildId: msg.buildId ?? null,
        expectedBuildId: PIE_BUILD_ID,
        type: msg.type,
      });
      void this.notifyBuildMismatch(msg.buildId ?? null);
      return false;
    }
    return true;
  }

  private async notifyBuildMismatch(actualBuildId: string | null): Promise<void> {
    if (this.providerOptions.onBuildMismatch) {
      await this.providerOptions.onBuildMismatch({ actualBuildId, expectedBuildId: PIE_BUILD_ID });
      return;
    }
    const action = await vscode.window.showWarningMessage(
      'Pie was rebuilt while this extension host was running. Reload the VS Code window to continue safely.',
      'Reload Window',
    );
    if (action === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  private reloadRequiredHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="padding:16px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family)">
  <h2 style="font-size:14px">Reload required</h2>
  <p>Pie was rebuilt while this extension host was running. Use the <strong>Reload Window</strong> notification action to continue safely.</p>
</body>
</html>`;
  }

  private installViewLifecycleHandlers(webviewView: vscode.WebviewView): void {
    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView) return;
      this.visibilityHandler?.(webviewView.visible);
    });

    this.viewDisposeDisposable?.dispose();
    this.viewDisposeDisposable = webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.session.handleViewDisposed();
    });
  }

  private postToView(message: HostToWebviewMessage): boolean | Promise<boolean> {
    const view = this.view;
    if (!view) return false;
    return Promise.resolve(view.webview.postMessage(message));
  }
}
