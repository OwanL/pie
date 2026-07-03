import * as vscode from 'vscode';

import { auditLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { pieWarn } from '../util/pie-logger';
import {
  DEFAULT_WEBVIEW_VIEW_NAME,
  getWebviewAssetDir,
  isHotReloadAssetFileName,
} from '../webview/hot-reload';
import { getWebviewAssetVersion, renderWebviewHtml } from '../webview/assets';
import type { SidebarSyncState } from './sync';
import type { WebviewToHostMessage } from '../../shared/protocol';

/** Debounce window for coalescing multiple asset writes into one webview reload. */
const HOT_RELOAD_DEBOUNCE_MS = 120;

/**
 * Dependencies injected by {@link SidebarViewProvider}. The provider remains
 * the orchestrator owning the shared webview state; the hot-reloader reads and
 * mutates it through these callbacks.
 */
export interface SidebarHotReloaderDeps {
  getContext(): vscode.ExtensionContext;
  getView(): vscode.WebviewView | undefined;
  getWebviewReady(): boolean;
  setWebviewReady(value: boolean): void;
  getSyncState(): SidebarSyncState;
  setSyncState(state: SidebarSyncState): void;
  /** Invoked after a reload resets webview readiness (wired to watchdog.clear). */
  onReloadWebviewReadyReset(): void;
}

/**
 * Owns webview asset watching, hot reload on asset changes, asset-version
 * mismatch reloads, and the shared `reloadWebviewAssets` core. Extracted
 * verbatim from {@link SidebarViewProvider}.
 */
export class SidebarHotReloader {
  private hotReloadTimer?: ReturnType<typeof setTimeout>;
  private assetWatcher?: vscode.FileSystemWatcher;
  private currentAssetVersion: string | null = null;
  private reloadingForAssetMismatch = false;
  private reloadingForStateAppliedTimeout = false;
  /**
   * Unified reload-in-progress flag spanning every reload path (asset watcher,
   * asset-version mismatch, watchdog timeout) from reload start until the new
   * renderer's `ready` handshake — the window in which the webview's renderer
   * is being replaced. The readiness probe consults this to avoid posting to /
   * adopting readiness from a renderer that is about to be torn down or is
   * still loading. Cleared by the provider on bridge-ready.
   */
  private reloading = false;

  constructor(private readonly deps: SidebarHotReloaderDeps) {}

  ensureAssetWatcher(): void {
    if (this.assetWatcher) {
      return;
    }

    const assetDir = getWebviewAssetDir(this.deps.getContext().extensionPath, DEFAULT_WEBVIEW_VIEW_NAME);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(assetDir), '**/*'),
    );
    const onAssetEvent = (uri: vscode.Uri) => {
      if (!isHotReloadAssetFileName(uri.fsPath, DEFAULT_WEBVIEW_VIEW_NAME)) {
        return;
      }
      this.scheduleHotReload(uri.fsPath);
    };

    watcher.onDidChange(onAssetEvent);
    watcher.onDidCreate(onAssetEvent);
    watcher.onDidDelete(onAssetEvent);

    this.assetWatcher = watcher;
  }

  scheduleHotReload(changedPath: string): void {
    if (this.hotReloadTimer !== undefined) {
      clearTimeout(this.hotReloadTimer);
    }

    auditLog('sidebar-provider', 'hotReload.schedule', {
      changedPath,
      visible: this.deps.getView()?.visible ?? false,
    });

    this.hotReloadTimer = setTimeout(() => {
      this.hotReloadTimer = undefined;
      void this.reloadWebviewAssets(changedPath);
    }, HOT_RELOAD_DEBOUNCE_MS);
  }

  private async reloadWebviewAssets(changedPath: string): Promise<void> {
    const view = this.deps.getView();
    if (!view) {
      return;
    }

    this.reloading = true;
    let applied = false;
    try {
      const nextAssetVersion = await getWebviewAssetVersion(this.deps.getContext());
      const nextHtml = await renderWebviewHtml(this.deps.getContext(), view.webview, nextAssetVersion);
      if (this.deps.getView() !== view) {
        return;
      }

      this.currentAssetVersion = nextAssetVersion;
      this.deps.setWebviewReady(false);
      this.deps.setSyncState({ ...this.deps.getSyncState(), globalDirty: true });
      this.deps.onReloadWebviewReadyReset();
      view.webview.html = nextHtml;
      applied = true;
      this.reloadingForAssetMismatch = false;
      this.reloadingForStateAppliedTimeout = false;

      auditLog('sidebar-provider', 'hotReload.apply', {
        changedPath,
        revision: this.deps.getSyncState().globalRevision,
        visible: view.visible,
      });
    } catch (error) {
      this.reloadingForAssetMismatch = false;
      this.reloadingForStateAppliedTimeout = false;
      pieWarn('sidebar-provider', 'failed to hot reload webview assets', { changedPath, error: toErrorMessage(error) });
    } finally {
      // A non-applied reload (view swapped mid-await, or a throw) leaves no new
      // renderer to send a `ready` handshake, so `clearReloading` (called by the
      // provider on bridge-ready) would never fire — reset here to avoid a
      // permanent `reloading=true` that freezes readiness probes / snapshot
      // posts. A successful apply stays set until bridge-ready (see field doc).
      if (!applied) {
        this.reloading = false;
      }
    }
  }

  getIncomingAssetVersion(msg: WebviewToHostMessage): string | null {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      return msg.assetVersion ?? null;
    }

    return null;
  }

  shouldReloadForAssetMismatch(
    msg: WebviewToHostMessage,
    assetVersion: string | null,
  ): boolean {
    if (!this.currentAssetVersion) {
      return false;
    }

    if (msg.type !== 'ready' && msg.type !== 'refreshState' && msg.type !== 'requestSnapshot') {
      return false;
    }

    return assetVersion !== this.currentAssetVersion;
  }

  async reloadForAssetMismatch(): Promise<void> {
    if (this.reloadingForAssetMismatch || this.reloadingForStateAppliedTimeout) {
      return;
    }

    this.reloadingForAssetMismatch = true;
    this.deps.setWebviewReady(false);
    this.deps.setSyncState({ ...this.deps.getSyncState(), globalDirty: true });
    await this.reloadWebviewAssets('assetVersionMismatch');
  }

  async reloadForStateAppliedTimeout(revision: number): Promise<void> {
    if (this.reloadingForAssetMismatch || this.reloadingForStateAppliedTimeout) {
      return;
    }

    this.reloadingForStateAppliedTimeout = true;
    this.deps.setWebviewReady(false);
    this.deps.setSyncState({ ...this.deps.getSyncState(), globalDirty: true });
    await this.reloadWebviewAssets(`stateAppliedTimeout:${revision}`);
  }

  setCurrentAssetVersion(version: string | null): void {
    this.currentAssetVersion = version;
  }

  /** Whether a webview reload is in progress (reload start → next bridge-ready). */
  isReloading(): boolean {
    return this.reloading;
  }

  /** Clear the reload-in-progress flag (called by the provider on bridge-ready). */
  clearReloading(): void {
    this.reloading = false;
  }

  getCurrentAssetVersion(): string | null {
    return this.currentAssetVersion;
  }

  resetReloadFlags(): void {
    this.reloadingForAssetMismatch = false;
    this.reloadingForStateAppliedTimeout = false;
    this.reloading = false;
  }

  dispose(): void {
    if (this.hotReloadTimer !== undefined) {
      clearTimeout(this.hotReloadTimer);
      this.hotReloadTimer = undefined;
    }
    this.assetWatcher?.dispose();
    this.currentAssetVersion = null;
    this.reloadingForAssetMismatch = false;
    this.reloadingForStateAppliedTimeout = false;
    this.reloading = false;
  }
}