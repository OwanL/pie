import * as vscode from 'vscode';

import { auditLog } from '../util/audit';
import { pieWarn } from '../util/pie-logger';
import {
  DEFAULT_WEBVIEW_VIEW_NAME,
  getWebviewAssetDir,
  isHotReloadAssetFileName,
} from '../webview/hot-reload';
import { resolveWebviewHtml } from '../webview/assets';
import type { StateDeliveryRecoveryReason } from './state-delivery-controller';
import type { WebviewToHostMessage } from '../../shared/protocol';

const HOT_RELOAD_DEBOUNCE_MS = 120;

type ResolvedWebviewHtml = Awaited<ReturnType<typeof resolveWebviewHtml>>;

/** Stamp a short, host-owned generation into every renderer document. */
export function injectViewGenerationMeta(html: string, viewGeneration: number): string {
  const generation = Number.isSafeInteger(viewGeneration)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, viewGeneration))
    : 0;
  const meta = `<meta name="pie-view-generation" content="${generation}" />`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head || head.index === undefined) return `${meta}${html}`;
  const insertionPoint = head.index + head[0].length;
  return `${html.slice(0, insertionPoint)}\n  ${meta}${html.slice(insertionPoint)}`;
}

export interface SidebarHotReloaderDeps {
  getContext(): vscode.ExtensionContext;
  getView(): vscode.WebviewView | undefined;
  /** Synchronously invalidates delivery generation and readiness. */
  onReloadStart(reason: string): void;
  /** Current host-owned generation stamped into replacement HTML. */
  getViewGeneration(): number;
  resolveAssets?(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<ResolvedWebviewHtml>;
}

/** Asset/reload mechanics only; snapshot delivery remains controller-owned. */
export class SidebarHotReloader {
  private hotReloadTimer?: ReturnType<typeof setTimeout>;
  private assetWatcher?: vscode.FileSystemWatcher;
  private currentAssetVersion: string | null = null;
  private reloadingForAssetMismatch = false;
  private reloadingForRecovery = false;
  private reloading = false;

  constructor(private readonly deps: SidebarHotReloaderDeps) {}

  ensureAssetWatcher(): void {
    if (this.assetWatcher) return;

    const assetDir = getWebviewAssetDir(this.deps.getContext().extensionPath, DEFAULT_WEBVIEW_VIEW_NAME);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(assetDir), '**/*'),
    );
    const onAssetEvent = (uri: vscode.Uri) => {
      if (isHotReloadAssetFileName(uri.fsPath, DEFAULT_WEBVIEW_VIEW_NAME)) {
        this.scheduleHotReload(uri.fsPath);
      }
    };
    watcher.onDidChange(onAssetEvent);
    watcher.onDidCreate(onAssetEvent);
    watcher.onDidDelete(onAssetEvent);
    this.assetWatcher = watcher;
  }

  scheduleHotReload(_changedPath: string): void {
    if (this.hotReloadTimer !== undefined) clearTimeout(this.hotReloadTimer);
    auditLog('sidebar-provider', 'hotReload.schedule', {
      reason: 'asset-change',
      visible: this.deps.getView()?.visible ?? false,
    });
    this.hotReloadTimer = setTimeout(() => {
      this.hotReloadTimer = undefined;
      void this.reloadWebviewAssets('asset-change');
    }, HOT_RELOAD_DEBOUNCE_MS);
  }

  getIncomingAssetVersion(msg: WebviewToHostMessage): string | null {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      return msg.assetVersion ?? null;
    }
    return null;
  }

  shouldReloadForAssetMismatch(msg: WebviewToHostMessage, assetVersion: string | null): boolean {
    if (!this.currentAssetVersion) return false;
    if (msg.type !== 'ready' && msg.type !== 'refreshState' && msg.type !== 'requestSnapshot') return false;
    return assetVersion !== this.currentAssetVersion;
  }

  async reloadForAssetMismatch(): Promise<void> {
    if (this.reloading || this.reloadingForAssetMismatch || this.reloadingForRecovery) return;
    this.reloadingForAssetMismatch = true;
    await this.reloadWebviewAssets('asset-version-mismatch');
  }

  async reloadForRecovery(reason: StateDeliveryRecoveryReason, _revision?: number): Promise<void> {
    if (this.reloading || this.reloadingForAssetMismatch || this.reloadingForRecovery) return;
    this.reloadingForRecovery = true;
    await this.reloadWebviewAssets(`recovery:${reason}`);
  }

  setCurrentAssetVersion(version: string | null): void {
    this.currentAssetVersion = version;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  clearReloading(): void {
    this.reloading = false;
  }

  getCurrentAssetVersion(): string | null {
    return this.currentAssetVersion;
  }

  resetReloadFlags(): void {
    this.reloadingForAssetMismatch = false;
    this.reloadingForRecovery = false;
    this.reloading = false;
  }

  dispose(): void {
    if (this.hotReloadTimer !== undefined) {
      clearTimeout(this.hotReloadTimer);
      this.hotReloadTimer = undefined;
    }
    this.assetWatcher?.dispose();
    this.currentAssetVersion = null;
    this.resetReloadFlags();
  }

  private async reloadWebviewAssets(reason: string): Promise<void> {
    const view = this.deps.getView();
    if (!view) {
      this.resetPathFlags();
      return;
    }

    this.reloading = true;
    this.deps.onReloadStart(reason);
    let applied = false;
    try {
      const resolver = this.deps.resolveAssets ?? resolveWebviewHtml;
      const resolvedAssets = await resolver(this.deps.getContext(), view.webview);
      if (this.deps.getView() !== view) return;

      this.currentAssetVersion = resolvedAssets.assetVersion;
      view.webview.html = injectViewGenerationMeta(resolvedAssets.html, this.deps.getViewGeneration());
      applied = true;
      auditLog('sidebar-provider', 'hotReload.apply', { reason, visible: view.visible });
    } catch (error: unknown) {
      pieWarn('sidebar-provider', 'failed to hot reload webview assets', {
        reason,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.resetPathFlags();
      // Successful replacement remains reloading until its bridge handshake.
      if (!applied) this.reloading = false;
    }
  }

  private resetPathFlags(): void {
    this.reloadingForAssetMismatch = false;
    this.reloadingForRecovery = false;
  }
}
