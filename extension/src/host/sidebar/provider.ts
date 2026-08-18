import * as vscode from 'vscode';

import { bootLog } from '../util/audit';
import { resolveWebviewHtml, getWebviewRoots } from '../webview/assets';
import { injectViewGenerationMeta, SidebarHotReloader } from './hot-reloader';
import { RendererHub } from '../renderers/renderer-hub';
import type { RendererRegistration, RendererTransport } from '../renderers/types';
import type { StateDeliveryClock } from './state-delivery-controller';
import type { StateDeliveryRecoveryReason } from './state-delivery-controller';
import type { HostToWebviewMessage, ViewState, WebviewToHostMessage } from '../../shared/protocol';

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

  /** VS Code-specific prelude: asset-version reload only. The hot-reload
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
    return true;
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
