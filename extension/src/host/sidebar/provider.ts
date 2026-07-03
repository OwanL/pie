import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { assertInvariant, auditLog, bootLog, isBootLogEnabled } from '../util/audit';
import { recordSnapshotPost } from '../util/stream-telemetry';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';
import {
  buildStateEnvelope,
  canPostSnapshotToWebview,
  createSidebarSyncState,
  flushDirtySnapshot,
  reconcilePostedMessageDelivery,
  type SidebarSyncState,
} from './sync';
import { getWebviewAssetVersion, renderWebviewHtml, getWebviewRoots } from '../webview/assets';
import { SidebarHotReloader } from './hot-reloader';
import { StateAppliedWatchdog } from './state-applied-watchdog';
import { WebviewReadinessProbe } from './readiness-probe';
import type {
  HostToWebviewMessage,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { validateWebviewToHostMessage } from '../../shared/protocol-validation';

/** Debounce window for batching rapid store changes into a single snapshot post. */
const SCHEDULE_DEBOUNCE_MS = 50;
/**
 * Debounce window while sessions are actively streaming.
 *
 * ── Brief D seam (UX-reliability remediation §6) ───────────────────────────
 * Brief D may lower this toward 50–80 now that Brief G memoizes
 * `selectViewState`: unchanged-delta posts (token-rate ticks, no-op events,
 * background-session streaming) are O(1) amortized, so posting more often no
 * longer pays the O(transcript) projection cost. Lower it ONLY from Brief D,
 * alongside that brief's webview revision/length-identity guard work which
 * owns this constant — Brief G deliberately leaves the number unchanged.
 *
 * Brief D update: lowered to 60 (see the UX-reliability remediation §6). The webview
 * revision guard (use-host-sync.ts) makes the higher post frequency safe
 * against out-of-order/duplicate envelopes.
 */
const STREAMING_SCHEDULE_DEBOUNCE_MS = 60;

/**
 * Implements the VS Code WebviewView for the pie sidebar.
 *
 * Responsibilities:
 * - Resolves the webview HTML once and handles incoming messages.
 * - Posts full-state snapshots (`state`) on demand or on a debounced schedule.
 * - Posts imperative messages (e.g. `sendRejected`) outside the state flow.
 *
 * Each outgoing envelope carries a monotonically increasing `revision` and a
 * stable `hostInstanceId` so the webview can detect missed snapshots and
 * host-side counter resets.
 *
 * The provider is the orchestrator: it owns the shared webview state (`view`,
 * `webviewReady`, `syncState`, `context`, `getRunningSessionCount`,
 * `hostInstanceId`) and delegates two concerns to sibling helpers:
 * - {@link SidebarHotReloader} — asset watching + hot reload + asset-version
 *   mismatch reload.
 * - {@link StateAppliedWatchdog} — state-applied ack tracking, timeout, and
 *   resnapshot/reload throttling.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly hostInstanceId: string;
  private syncState: SidebarSyncState;
  private visibilityDisposable?: vscode.Disposable;
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private messageDisposable?: vscode.Disposable;
  private webviewReady = false;
  /** State-bearing imperatives (sendRejected) queued while the view was not
   *  ready, re-delivered on ready (Brief D §4). See `postImperative` /
   *  `flushPendingImperatives`. */
  private pendingImperatives: HostToWebviewMessage[] = [];
  private readonly hotReloader: SidebarHotReloader;
  private readonly watchdog: StateAppliedWatchdog;
  private readonly readinessProbe: WebviewReadinessProbe;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getViewState: () => ViewState,
    private readonly onMessage: (msg: WebviewToHostMessage) => void,
    private readonly getRunningSessionCount: () => number = () => 0,
  ) {
    this.hostInstanceId = crypto.randomUUID();
    this.syncState = createSidebarSyncState(this.hostInstanceId);
    this.hotReloader = new SidebarHotReloader({
      getContext: () => this.context,
      getView: () => this.view,
      getWebviewReady: () => this.webviewReady,
      setWebviewReady: (value) => {
        this.webviewReady = value;
      },
      getSyncState: () => this.syncState,
      setSyncState: (state) => {
        this.syncState = state;
      },
      onReloadWebviewReadyReset: () => {
        this.watchdog.clear();
        this.readinessProbe.clear();
      },
    });
    this.watchdog = new StateAppliedWatchdog({
      getWebviewReady: () => this.webviewReady,
      getViewVisible: () => !!this.view?.visible,
      getRunningSessionCount: () => this.getRunningSessionCount(),
      getHostInstanceId: () => this.hostInstanceId,
      onResnapshot: () => {
        this.syncState = { ...this.syncState, globalDirty: true };
        this.flushDirtyState();
      },
      onForceReload: (revision) => this.hotReloader.reloadForStateAppliedTimeout(revision),
    });
    this.readinessProbe = new WebviewReadinessProbe({
      getViewExists: () => !!this.view,
      getWebviewReady: () => this.webviewReady,
      getGlobalDirty: () => this.syncState.globalDirty,
      isReloading: () => this.hotReloader.isReloading(),
      onProbe: () => this.probePost(),
      onForceClearReloading: () => this.hotReloader.clearReloading(),
    });
  }

  dispose(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.webviewReady = false;
    this.pendingImperatives = [];
    this.visibilityDisposable?.dispose();
    this.messageDisposable?.dispose();
    this.hotReloader.dispose();
    this.watchdog.dispose();
    this.readinessProbe.dispose();
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.webviewReady = false;
    this.hotReloader.resetReloadFlags();
    this.watchdog.clear();
    this.readinessProbe.clear();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getWebviewRoots(this.context),
    };

    this.hotReloader.setCurrentAssetVersion(await getWebviewAssetVersion(this.context));

    bootLog('sidebar-provider', 'view.resolved', {
      hostInstanceId: this.hostInstanceId,
      visible: webviewView.visible,
      webviewReady: this.webviewReady,
    });

    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      const incomingAssetVersion = this.hotReloader.getIncomingAssetVersion(msg);
      if (this.hotReloader.shouldReloadForAssetMismatch(msg, incomingAssetVersion)) {
        bootLog('sidebar-provider', 'assetVersion.mismatch', {
          actualAssetVersion: incomingAssetVersion ?? null,
          expectedAssetVersion: this.hotReloader.getCurrentAssetVersion(),
          hostInstanceId: this.hostInstanceId,
          type: msg.type,
          visible: this.view?.visible ?? false,
        });
        void this.hotReloader.reloadForAssetMismatch();
        return;
      }

      if (msg.type === 'stateApplied') {
        const payload = msg.payload as any;
        if (payload.renderError) {
          bootLog('sidebar-provider', 'webview.renderError', { error: payload.renderError });
        }
        this.watchdog.recordStateApplied(msg.payload.revision);
      }

      if (!this.webviewReady) {
        this.webviewReady = true;
        this.watchdog.resetResnapshotFlag();
        this.readinessProbe.clear();
        this.hotReloader.clearReloading();
        bootLog('sidebar-provider', 'message.bridgeReady', {
          hostInstanceId: this.hostInstanceId,
          type: msg.type,
          visible: this.view?.visible ?? false,
        });
        // Deliver imperatives buffered during the (re)load BEFORE the inbound
        // message routes to postState() — imperatives first, then the
        // confirming snapshot. Covers the "sendRejected fired while the webview
        // was reloading" case (draft/overlay restore would otherwise be lost).
        this.flushPendingImperatives();
      }

      // Audit-only validation: log invalid envelopes but still pass through so
      // unrecognised future additions don't break older host builds. Promote
      // to rejection once the audit log is clean.
      const validation = validateWebviewToHostMessage(msg);
      if (!validation.ok) {
        auditLog('sidebar-provider', 'message.invalid', {
          reason: validation.reason,
          type: (msg as { type?: unknown })?.type ?? null,
        });
      }
      if (msg.type === 'ready') {
        bootLog('sidebar-provider', 'message.ready', {
          hostInstanceId: this.hostInstanceId,
          visible: this.view?.visible ?? false,
        });
      } else if (msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
        bootLog('sidebar-provider', `message.${msg.type}`, {
          hostInstanceId: this.hostInstanceId,
          visible: this.view?.visible ?? false,
          webviewReady: this.webviewReady,
        });
      }
      this.onMessage(msg);
    });

    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.flushDirtyState();
      }
    });

    this.hotReloader.ensureAssetWatcher();
    webviewView.webview.html = await renderWebviewHtml(
      this.context,
      webviewView.webview,
      this.hotReloader.getCurrentAssetVersion() ?? undefined,
    );

    // Cold-start restore can accumulate a fully loaded dirty snapshot before
    // the view is resolved. Flush it as soon as the HTML is assigned so the
    // fresh webview does not depend on an inbound handshake to escape the
    // initial loading shell.
    this.flushDirtyState();
  }

  /** Show the sidebar panel, preserving editor focus. */
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
    hostInstanceId: string;
  } {
    return {
      hasView: !!this.view,
      visible: this.view?.visible ?? false,
      webviewReady: this.webviewReady,
      globalDirty: this.syncState.globalDirty,
      globalRevision: this.syncState.globalRevision,
      lastStateAppliedRevision: this.watchdog.getLastStateAppliedRevision(),
      pendingStateAppliedRevision: this.watchdog.getPendingStateAppliedRevision(),
      hostInstanceId: this.hostInstanceId,
    };
  }

  /**
   * Post a full state snapshot immediately. The snapshot is authoritative:
   * the webview rebuilds its state from the snapshot.
   */
  postState(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }

    const previousRevision = this.syncState.globalRevision;
    const viewState = this.getViewState();
    const result = buildStateEnvelope(
      this.syncState,
      viewState,
      this.canPostSnapshotToView(),
    );
    this.syncState = result.nextSyncState;

    // Note: `postState` runs on every debounced snapshot post (the high-
    // frequency happy path), so it intentionally has no `auditLog` entry —
    // that channel is reserved for notable snapshot transitions (markDirty /
    // flushDirty). Detailed per-post tracing is available via the opt-in
    // `bootLog` (PI_BOOT_LOG=1) below.
    bootLog('sidebar-provider', 'snapshot.postState', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      globalDirty: this.syncState.globalDirty,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      transcriptLoaded: viewState.transcriptLoaded,
      visible: this.view?.visible ?? false,
    });

    assertInvariant(
      'sidebar-provider',
      !result.message || this.syncState.globalRevision > previousRevision,
      'State snapshots must advance revision monotonically.',
      { previousRevision, nextRevision: this.syncState.globalRevision },
    );

    if (result.message && this.view) {
      this.postToWebview(result.message);
    }
  }

  /**
   * Schedule a debounced state snapshot. Multiple rapid calls within the
   * debounce window are collapsed into a single post.
   */
  scheduleState(): void {
    if (!this.canPostSnapshotToView()) {
      this.syncState = { ...this.syncState, globalDirty: true };
      auditLog('sidebar-provider', 'snapshot.markDirty', {
        reason: 'scheduleState',
        ready: this.webviewReady,
        revision: this.syncState.globalRevision,
        visible: this.view?.visible ?? false,
      });
      if (isBootLogEnabled()) {
        const viewState = this.getViewState();
        bootLog('sidebar-provider', 'snapshot.markDirty', {
          activeSessionPath: viewState.activeSession?.path ?? null,
          backendReady: viewState.backendReady,
          globalDirty: this.syncState.globalDirty,
          notice: viewState.notice,
          openTabCount: viewState.openTabPaths.length,
          ready: this.webviewReady,
          revision: this.syncState.globalRevision,
          visible: this.view?.visible ?? false,
        });
      }
      this.armReadinessProbeIfStuck();
      return;
    }

    if (this.scheduleTimer !== undefined) {
      return;
    }

    const debounceMs = this.getRunningSessionCount() > 0
      ? STREAMING_SCHEDULE_DEBOUNCE_MS
      : SCHEDULE_DEBOUNCE_MS;

    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      this.postState();
    }, debounceMs);
  }

  /** Drop sync bookkeeping for a session that was closed or invalidated. */
  /** Drop sync bookkeeping for a session that was closed or invalidated (no-op). */
  clearSessionSync(_sessionPath: string): void {
    // no-op: sync state no longer tracks per-session revisions
  }

  /**
   * Post an imperative message that does not carry a revision. The webview
   * handles these independently from the state flow.
   */
  postImperative(msg: HostToWebviewMessage): void {
    if (!this.view || !this.webviewReady) {
      // State-bearing imperatives (sendRejected) carry effects the next full
      // snapshot cannot reproduce on its own: the webview's optimistic-overlay
      // removal and the draft-text restore (`sendRejected.text`). The reducer's
      // rollback restores `pendingComposerInputsBySession` (so the snapshot
      // carries inputs) but does NOT restore `draftTextBySession` (cleared at
      // send time) — that restore rides solely on this imperative. If the view
      // is not ready (webview reloading), buffer the imperative for re-delivery
      // on ready (flushPendingImperatives) AND mark globalDirty so a
      // confirming snapshot also flushes. Fire-and-forget imperatives
      // (playCompletionSound) are dropped.
      if (msg.type === 'sendRejected') {
        this.pendingImperatives.push(msg);
        this.syncState = { ...this.syncState, globalDirty: true };
      }
      return;
    }
    this.postToWebview(msg);
  }

  /** Re-deliver state-bearing imperatives queued while the view was not ready.
   *  Idempotent: a no-op when the queue is empty or the view is still not
   *  ready. Called on bridge-ready and at the start of `flushDirtyState` so
   *  imperatives land before the confirming snapshot. */
  private flushPendingImperatives(): void {
    if (this.pendingImperatives.length === 0) {
      return;
    }
    if (!this.view || !this.webviewReady) {
      return;
    }
    const queued = this.pendingImperatives;
    this.pendingImperatives = [];
    for (const imperative of queued) {
      this.postToWebview(imperative);
    }
  }

  private canPostSnapshotToView(): boolean {
    return canPostSnapshotToWebview(!!this.view, this.webviewReady);
  }

  private flushDirtyState(): void {
    // Deliver any state-bearing imperatives buffered while the view was not
    // ready BEFORE the confirming snapshot, so the webview's optimistic overlay
    // is removed and the draft/inputs restore is staged before the
    // authoritative snapshot confirms them. (No-op when the queue is empty or
    // the view is still not ready — e.g. the cold-start flush in
    // resolveWebviewView runs before the bridge is ready.)
    this.flushPendingImperatives();

    const viewState = this.getViewState();
    const result = flushDirtySnapshot(this.syncState, viewState, this.canPostSnapshotToView());
    this.syncState = result.nextSyncState;

    auditLog('sidebar-provider', 'snapshot.flushDirty', {
      globalDirty: this.syncState.globalDirty,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      visible: this.view?.visible ?? false,
    });

    bootLog('sidebar-provider', 'snapshot.flushDirty', {
      activeSessionPath: viewState.activeSession?.path ?? null,
      backendReady: viewState.backendReady,
      globalDirty: this.syncState.globalDirty,
      notice: viewState.notice,
      openTabCount: viewState.openTabPaths.length,
      posted: !!result.message,
      ready: this.webviewReady,
      revision: this.syncState.globalRevision,
      transcriptLoaded: viewState.transcriptLoaded,
      visible: this.view?.visible ?? false,
    });

    if (result.message && this.view) {
      this.postToWebview(result.message);
    } else {
      this.armReadinessProbeIfStuck();
    }
  }

  private postToWebview(message: HostToWebviewMessage): void {
    const view = this.view;
    if (!view) {
      return;
    }

    void Promise.resolve(view.webview.postMessage(message))
      .then((delivered) => {
        this.syncState = reconcilePostedMessageDelivery(this.syncState, message, delivered);
        if (delivered && message.type === 'state') {
          recordSnapshotPost();
          this.watchdog.armStateAppliedWatchdog(message.revision);
        }
        if (!delivered) {
          bootLog('sidebar-provider', 'message.deliveryFailed', {
            hostInstanceId: this.hostInstanceId,
            messageType: message.type,
            revision: message.type === 'state' ? message.revision : null,
            visible: this.view?.visible ?? false,
            webviewReady: this.webviewReady,
          });
        }
      })
      .catch((error: unknown) => {
        this.syncState = reconcilePostedMessageDelivery(this.syncState, message, false);
        appendPieLog('warn', 'sidebar-provider', `failed to post ${message.type} message to webview`, {
          error: toErrorMessage(error),
        });
      });
  }

  /**
   * Arm the readiness probe when posting is blocked purely by a stale
   * `webviewReady=false` belief (view exists, dirty, believed not ready).
   * No-op otherwise. See {@link WebviewReadinessProbe}.
   */
  private armReadinessProbeIfStuck(): void {
    if (this.view && !this.webviewReady && this.syncState.globalDirty) {
      this.readinessProbe.arm();
    }
  }

  /**
   * Push the pending snapshot to the webview despite a stale `webviewReady=false`
   * belief (the readiness probe's `onProbe` callback). Adopts `postMessage`'s
   * `delivered=true` as the readiness signal — the webview was ready after all
   * — restoring the normal post loop without waiting for a user refocus.
   */
  private async probePost(): Promise<boolean> {
    const view = this.view;
    if (!view) {
      return false;
    }
    // Force canPost=true: the probe exists to test the stale belief, so it
    // must mint + post an envelope the `canPost` gate would otherwise suppress.
    const result = buildStateEnvelope(this.syncState, this.getViewState(), true);
    this.syncState = result.nextSyncState;
    const message = result.message;
    if (!message || message.type !== 'state') {
      return false;
    }

    try {
      const delivered = await view.webview.postMessage(message);
      // A reload may have started during the await — the posted message may be
      // bound for a renderer being replaced. Do not adopt readiness or arm the
      // watchdog; treat as undelivered so the probe retries after the reload
      // settles, and let the reload's `ready` handshake own readiness.
      if (this.hotReloader.isReloading()) {
        this.syncState = reconcilePostedMessageDelivery(this.syncState, message, false);
        bootLog('sidebar-provider', 'readinessProbe.skippedReload', {
          hostInstanceId: this.hostInstanceId,
          revision: message.revision,
        });
        return false;
      }
      this.syncState = reconcilePostedMessageDelivery(this.syncState, message, delivered);
      if (delivered) {
        if (!this.webviewReady) {
          this.webviewReady = true;
          this.watchdog.resetResnapshotFlag();
          this.flushPendingImperatives();
          bootLog('sidebar-provider', 'readinessProbe.adopted', {
            hostInstanceId: this.hostInstanceId,
            revision: message.revision,
            visible: this.view?.visible ?? false,
          });
        }
        recordSnapshotPost();
        this.watchdog.armStateAppliedWatchdog(message.revision);
      } else {
        bootLog('sidebar-provider', 'readinessProbe.notDelivered', {
          hostInstanceId: this.hostInstanceId,
          revision: message.revision,
          visible: this.view?.visible ?? false,
        });
      }
      return delivered;
    } catch (error: unknown) {
      this.syncState = reconcilePostedMessageDelivery(this.syncState, message, false);
      appendPieLog('warn', 'sidebar-provider', 'readiness probe post failed', {
        error: toErrorMessage(error),
      });
      return false;
    }
  }
}