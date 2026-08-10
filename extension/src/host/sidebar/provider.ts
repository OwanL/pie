import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { auditLog, bootLog, isBootLogEnabled } from '../util/audit';
import { recordSnapshotPost } from '../util/stream-telemetry';
import { appendPieError, appendPieLog } from '../util/pie-log';
import {
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
} from '../util/live-pipeline-trace-runtime';
import { resolveWebviewHtml, getWebviewRoots } from '../webview/assets';
import { injectViewGenerationMeta, SidebarHotReloader } from './hot-reloader';
import { StateAppliedWatchdog } from './state-applied-watchdog';
import { WebviewReadinessProbe, READINESS_PROBE_MAX_ATTEMPTS } from './readiness-probe';
import {
  PROVISIONAL_ACCEPTED_REVISION_LEDGER_CAPACITY,
  PROVISIONAL_STATE_POST_SETTLEMENT_TIMEOUT_MS,
  PROVISIONAL_STATE_RETRY_DELAY_MS,
  PROVISIONAL_STATE_RETRY_MAX_ATTEMPTS,
  PROVISIONAL_TRANSCRIPT_COMMIT_TIMEOUT_MS,
  StateDeliveryController,
  type StateDeliveryClock,
  type StateDeliveryRecovery,
  type StateDeliveryTelemetry,
} from './state-delivery-controller';
import { buildStateEnvelope, createSidebarSyncState, type SidebarSyncState } from './sync';
import type { HostToWebviewMessage, ViewState, WebviewToHostMessage } from '../../shared/protocol';
import type {
  LivePipelineTraceKind,
  LivePipelineTraceProcess,
  LivePipelineTraceReasonCode,
  LivePipelineTraceStage,
} from '../../shared/live-pipeline-trace';
import { validateWebviewToHostMessage } from '../../shared/protocol-validation';

const SCHEDULE_DEBOUNCE_MS = 50;
// Full snapshots cross the Chromium structured-clone boundary and commit a
// transcript tree. Posting them at 60 ms starved pointer/click handling on
// tool-heavy turns. 150 ms is the established UI cadence (~7 fps): live text
// remains fluid through the webview's buffered reveal while controls retain
// main-thread time.
const STREAMING_SCHEDULE_DEBOUNCE_MS = 150;

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

/** VS Code sidebar orchestration around the explicit state-delivery owner. */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly hostInstanceId: string;
  private syncState: SidebarSyncState;
  private visibilityDisposable?: vscode.Disposable;
  private viewDisposeDisposable?: vscode.Disposable;
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private messageDisposable?: vscode.Disposable;
  private webviewReady = false;
  private lastTranscriptCommitBlockedReason?: string;
  private pendingImperatives: Array<Exclude<HostToWebviewMessage, { type: 'state' }>> = [];
  private readonly providerOptions: SidebarViewProviderOptions;
  private readonly hotReloader: SidebarHotReloader;
  private readonly watchdog: StateAppliedWatchdog;
  private readonly readinessProbe: WebviewReadinessProbe;
  private readonly delivery: StateDeliveryController<Extract<HostToWebviewMessage, { type: 'state' }>>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getViewState: () => ViewState,
    private readonly onMessage: (msg: WebviewToHostMessage) => void,
    private readonly getRunningSessionCount: () => number = () => 0,
    options: SidebarViewProviderOptions = {},
  ) {
    this.hostInstanceId = crypto.randomUUID();
    this.syncState = createSidebarSyncState(this.hostInstanceId);
    this.providerOptions = options;
    const clock = options.clock ?? SYSTEM_CLOCK;

    this.hotReloader = new SidebarHotReloader({
      getContext: () => this.context,
      getView: () => this.view,
      onReloadStart: (reason) => this.handleReloadStart(reason),
      getViewGeneration: () => this.delivery.getDebugState().viewGeneration,
      resolveAssets: options.resolveAssets,
    });
    this.watchdog = new StateAppliedWatchdog({
      getHostInstanceId: () => this.hostInstanceId,
      getRunningSessionCount: () => this.getRunningSessionCount(),
      onForceReload: (recovery) => this.hotReloader.reloadForRecovery(recovery.reason, recovery.revision),
      now: () => clock.now(),
    });
    this.readinessProbe = new WebviewReadinessProbe({
      getViewExists: () => !!this.view,
      getViewVisible: () => !!this.view?.visible,
      getWebviewReady: () => this.webviewReady,
      getGlobalDirty: () => this.delivery.getDebugState().dirty,
      isReloading: () => this.hotReloader.isReloading(),
      onProbe: () => this.delivery.probe(),
      onForceClearReloading: () => this.hotReloader.clearReloading(),
      onExhausted: () => this.handleReadinessExhausted(),
    });
    this.delivery = new StateDeliveryController({
      clock,
      buildSnapshot: (buildContext) => {
        const startedAt = isLivePipelineTraceEnabled() ? performance.now() : 0;
        const result = buildStateEnvelope(this.syncState, this.getViewState(), buildContext);
        this.syncState = result.nextSyncState;
        if (isLivePipelineTraceEnabled()) {
          recordLivePipelineTrace({
            process: 'host',
            stage: 'host.snapshot.built',
            kind: 'success',
            identifiers: { hostInstance: this.hostInstanceId },
            revision: buildContext.revision,
            viewGeneration: buildContext.viewGeneration,
            durationMs: Math.max(0, performance.now() - startedAt),
            snapshotBytes: result.message.snapshotBytes,
            transcriptCount: result.message.state.transcript.length,
          });
        }
        return { payload: result.message, expectedTranscriptIdentity: result.expectedTranscriptIdentity };
      },
      isEligible: () => this.canPostSnapshotToView(),
      post: (snapshot, postContext) => {
        const view = this.view;
        if (!view || postContext.viewGeneration !== this.delivery.getDebugState().viewGeneration) return false;
        return Promise.resolve(view.webview.postMessage(snapshot.payload));
      },
      onAccepted: (postContext) => {
        recordSnapshotPost();
        if (postContext.readinessProbe && postContext.viewGeneration === this.delivery.getDebugState().viewGeneration) {
          this.webviewReady = true;
          this.hotReloader.clearReloading();
          this.readinessProbe.clear();
          this.watchdog.resetRecoveryEpisode();
          const flushedImperatives = this.flushPendingImperatives();
          // A confirming full snapshot follows any imperatives that were queued
          // while readiness was stale.
          if (flushedImperatives) this.delivery.markDirty();
          bootLog('sidebar-provider', 'readinessProbe.adopted', {
            revision: postContext.revision,
            viewGeneration: postContext.viewGeneration,
          });
        }
      },
      onCommitAdvanced: () => this.watchdog.recordCommitAdvanced(),
      onDeliveryBlocked: () => this.armReadinessProbeIfStuck(),
      onRecovery: (recovery) => this.handleDeliveryRecovery(recovery),
      onProtocolDefect: (defect) => {
        appendPieLog('warn', 'sidebar-provider', 'webview render evidence protocol defect', {
          currentViewGeneration: defect.currentViewGeneration,
          evidenceViewGeneration: defect.evidenceViewGeneration,
          reason: defect.reason,
          revision: defect.revision,
          stage: defect.stage,
        });
      },
      onTelemetry: (event) => {
        bootLog('sidebar-provider', `delivery.${event.kind}`, {
          desiredGeneration: event.desiredGeneration ?? null,
          detail: event.detail ?? null,
          operationId: event.operationId ?? null,
          revision: event.revision ?? null,
          viewGeneration: event.viewGeneration,
        });
        this.recordDeliveryTrace(event);
      },
      settlementTimeoutMs: options.settlementTimeoutMs ?? PROVISIONAL_STATE_POST_SETTLEMENT_TIMEOUT_MS,
      commitTimeoutMs: options.commitTimeoutMs ?? PROVISIONAL_TRANSCRIPT_COMMIT_TIMEOUT_MS,
      retryDelayMs: options.retryDelayMs ?? PROVISIONAL_STATE_RETRY_DELAY_MS,
      maxRetryAttempts: options.maxRetryAttempts ?? PROVISIONAL_STATE_RETRY_MAX_ATTEMPTS,
      acceptedLedgerCapacity: options.acceptedLedgerCapacity ?? PROVISIONAL_ACCEPTED_REVISION_LEDGER_CAPACITY,
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
    this.viewDisposeDisposable?.dispose();
    this.messageDisposable?.dispose();
    this.view = undefined;
    this.hotReloader.dispose();
    this.watchdog.dispose();
    this.readinessProbe.dispose();
    this.delivery.dispose();
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.webviewReady = false;
    this.hotReloader.resetReloadFlags();
    this.readinessProbe.clear();
    this.watchdog.resetRecoveryEpisode();
    this.delivery.invalidateView();
    this.delivery.setVisible(webviewView.visible);
    this.readinessProbe.setVisible(webviewView.visible);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [...this.getRoots()],
    };

    const resolver = this.getResolveAssets();
    const resolvedAssets = await resolver(this.context, webviewView.webview);
    if (this.view !== webviewView) return;
    this.hotReloader.setCurrentAssetVersion(resolvedAssets.assetVersion);

    bootLog('sidebar-provider', 'view.resolved', {
      hostInstanceId: this.hostInstanceId,
      visible: webviewView.visible,
      viewGeneration: this.delivery.getDebugState().viewGeneration,
    });

    this.installMessageHandler(webviewView);
    this.installViewLifecycleHandlers(webviewView);
    this.hotReloader.ensureAssetWatcher();
    webviewView.webview.html = injectViewGenerationMeta(
      resolvedAssets.html,
      this.delivery.getDebugState().viewGeneration,
    );
    this.armReadinessProbeIfStuck();
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
    const delivery = this.delivery.getDebugState();
    return {
      hasView: !!this.view,
      visible: this.view?.visible ?? false,
      webviewReady: this.webviewReady,
      globalDirty: delivery.dirty,
      globalRevision: this.syncState.globalRevision,
      lastStateAppliedRevision: delivery.lastTranscriptCommittedRevision,
      pendingStateAppliedRevision: delivery.acceptedRevisions[0] ?? null,
      viewGeneration: delivery.viewGeneration,
      hostInstanceId: this.hostInstanceId,
    };
  }

  /** Request one immediate authoritative full snapshot. */
  postState(): void {
    this.postImmediateState(false);
  }

  /**
   * Request an interaction-critical snapshot for an explicit tab selection.
   * It may supersede an older accepted streaming snapshot rather than making
   * the click wait for that transcript's commit deadline.
   */
  postSelectionState(): void {
    this.postImmediateState(true);
  }

  private postImmediateState(priority: boolean): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    if (priority) this.delivery.markPriorityDirty();
    else this.delivery.markDirty();
    this.armReadinessProbeIfStuck();
  }

  /** Debounce only while eligible; blocked/hidden state records dirty now. */
  scheduleState(): void {
    if (!this.canPostSnapshotToView() || !this.view?.visible) {
      this.delivery.markDirty();
      this.armReadinessProbeIfStuck();
      if (isBootLogEnabled()) {
        bootLog('sidebar-provider', 'snapshot.markDirty', {
          ready: this.webviewReady,
          revision: this.syncState.globalRevision,
          visible: this.view?.visible ?? false,
        });
      }
      return;
    }
    if (this.scheduleTimer !== undefined) return;
    const debounceMs = this.getRunningSessionCount() > 0
      ? STREAMING_SCHEDULE_DEBOUNCE_MS
      : SCHEDULE_DEBOUNCE_MS;
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      this.delivery.markDirty();
    }, debounceMs);
  }

  /** Imperatives remain separate from authoritative full snapshots. */
  postImperative(msg: HostToWebviewMessage): void {
    if (msg.type === 'state') {
      throw new Error('State envelopes must be posted by StateDeliveryController.');
    }
    if (!this.view || !this.webviewReady || this.hotReloader.isReloading()) {
      if (msg.type === 'sendRejected' || msg.type === 'detailResult') {
        this.pendingImperatives.push(msg);
        this.delivery.markDirty();
        this.armReadinessProbeIfStuck();
      }
      return;
    }
    this.postImperativeToWebview(msg);
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
      try {
        const validation = validateWebviewToHostMessage(msg);
        if (!validation.ok) {
          auditLog('sidebar-provider', 'message.invalid', {
            reason: validation.reason,
            type: (msg as { type?: unknown })?.type ?? null,
          });
          if (isRenderEvidenceType((msg as { type?: unknown })?.type)) return;
        }

        const incomingAssetVersion = this.hotReloader.getIncomingAssetVersion(msg);
        if (this.hotReloader.shouldReloadForAssetMismatch(msg, incomingAssetVersion)) {
          bootLog('sidebar-provider', 'assetVersion.mismatch', {
            actualAssetVersion: incomingAssetVersion,
            expectedAssetVersion: this.hotReloader.getCurrentAssetVersion(),
            type: msg.type,
          });
          void this.hotReloader.reloadForAssetMismatch();
          return;
        }

        if (isRenderEvidenceMessage(msg)) {
          const currentGeneration = this.delivery.getDebugState().viewGeneration;
          if (msg.payload.viewGeneration === currentGeneration) {
            this.markBridgeReady(msg.type, msg.payload.viewGeneration);
          }
          switch (msg.type) {
            case 'stateReceived': this.delivery.stateReceived(msg.payload); break;
            case 'appCommitted': this.delivery.appCommitted(msg.payload); break;
            case 'transcriptCommitted':
              this.lastTranscriptCommitBlockedReason = undefined;
              this.delivery.transcriptCommitted(msg.payload);
              break;
            case 'transcriptCommitBlocked':
              this.delivery.transcriptCommitBlocked(msg.payload);
              if (this.lastTranscriptCommitBlockedReason !== msg.payload.reason) {
                this.lastTranscriptCommitBlockedReason = msg.payload.reason;
                appendPieLog('warn', 'sidebar-provider', 'transcript commit blocked', {
                  reason: msg.payload.reason,
                  revision: msg.payload.revision,
                  viewGeneration: msg.payload.viewGeneration,
                });
              }
              if (isLivePipelineTraceEnabled()) recordLivePipelineTrace({
                process: 'webview', stage: 'webview.transcript.committed', kind: 'failure',
                identifiers: { hostInstance: this.hostInstanceId },
                revision: msg.payload.revision,
                viewGeneration: msg.payload.viewGeneration,
                reasonCode: msg.payload.reason === 'window_mismatch'
                  ? 'commit_window_mismatch'
                  : msg.payload.reason === 'structure_mismatch'
                    ? 'commit_structure_mismatch'
                    : msg.payload.reason === 'leaf_missing'
                      ? 'commit_leaf_missing' : 'commit_leaf_mismatch',
              });
              break;
            case 'paintObserved': this.delivery.paintObserved(msg.payload); break;
            case 'renderFailure': this.delivery.renderFailure(msg.payload); break;
          }
          return;
        }

        const readinessGeneration = getReadinessViewGeneration(msg);
        const messageGeneration = msg.viewGeneration;
        const currentGeneration = this.delivery.getDebugState().viewGeneration;
        if (messageGeneration !== undefined && messageGeneration !== currentGeneration) {
          auditLog('sidebar-provider', 'message.staleGenerationIgnored', {
            type: msg.type,
            messageGeneration,
            viewGeneration: currentGeneration,
          });
          return;
        }
        if (this.hotReloader.isReloading() && messageGeneration === undefined) {
          // The renderer being replaced may still emit commands while its HTML
          // is swapping. Generation-stamped commands from the replacement are
          // safe to route; unstamped legacy/stale commands are ignored.
          return;
        }
        const becameReady = readinessGeneration === undefined
          ? false
          : this.markBridgeReady(msg.type, readinessGeneration);
        this.onMessage(msg);
        if (becameReady && this.webviewReady) this.delivery.notifyEligibilityChanged();
      } catch (error: unknown) {
        appendPieError('webview', 'onDidReceiveMessage prelude failed', sanitizeError(error));
      }
    });
  }

  private installViewLifecycleHandlers(webviewView: vscode.WebviewView): void {
    this.visibilityDisposable?.dispose();
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView) return;
      const retainedDirty = this.delivery.getDebugState().dirty;
      this.delivery.setVisible(webviewView.visible);
      this.readinessProbe.setVisible(webviewView.visible);
      if (webviewView.visible) {
        // Resume retained hidden intent, or force one fresh authoritative
        // snapshot when no hidden change was recorded. Never mint both.
        if (!retainedDirty) this.delivery.markDirty();
        this.delivery.notifyEligibilityChanged();
        this.armReadinessProbeIfStuck();
      }
    });

    this.viewDisposeDisposable?.dispose();
    this.viewDisposeDisposable = webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.webviewReady = false;
      this.readinessProbe.clear();
      this.delivery.invalidateView();
    });
  }

  private markBridgeReady(type: string, viewGeneration?: number): boolean {
    if (this.webviewReady) return false;
    const currentViewGeneration = this.delivery.getDebugState().viewGeneration;
    if (viewGeneration !== currentViewGeneration) {
      bootLog('sidebar-provider', 'message.bridgeReadyIgnored', {
        generation: viewGeneration === undefined ? 'missing' : 'stale',
        type,
        viewGeneration: currentViewGeneration,
      });
      return false;
    }
    this.webviewReady = true;
    this.hotReloader.clearReloading();
    if (isLivePipelineTraceEnabled()) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.readiness.transition',
        kind: 'transition',
        identifiers: { hostInstance: this.hostInstanceId },
        viewGeneration: currentViewGeneration,
        readiness: 'ready',
      });
    }
    this.readinessProbe.clear();
    this.watchdog.resetRecoveryEpisode();
    this.flushPendingImperatives();
    bootLog('sidebar-provider', 'message.bridgeReady', {
      type,
      viewGeneration: currentViewGeneration,
    });
    return true;
  }

  private flushPendingImperatives(): boolean {
    if (this.pendingImperatives.length === 0 || !this.view || !this.webviewReady) return false;
    const queued = this.pendingImperatives;
    this.pendingImperatives = [];
    for (const imperative of queued) this.postImperativeToWebview(imperative);
    return true;
  }

  private postImperativeToWebview(message: Exclude<HostToWebviewMessage, { type: 'state' }>): void {
    const view = this.view;
    if (!view) return;
    void Promise.resolve(view.webview.postMessage(message)).then((delivered) => {
      if (!delivered && (message.type === 'sendRejected' || message.type === 'detailResult') && this.view === view) {
        this.requeueRecoverableImperative(message, view);
      }
    }, (error: unknown) => {
      appendPieLog('warn', 'sidebar-provider', 'imperative post rejected', {
        errorType: error instanceof Error ? error.name : typeof error,
        messageType: message.type,
      });
      if ((message.type === 'sendRejected' || message.type === 'detailResult') && this.view === view) {
        this.requeueRecoverableImperative(message, view);
      }
    });
  }

  private requeueRecoverableImperative(
    message: Extract<HostToWebviewMessage, { type: 'sendRejected' | 'detailResult' }>,
    view: vscode.WebviewView,
  ): void {
    if (this.view !== view) return;
    this.pendingImperatives.push(message);
    // A false/rejected post means the bridge did not accept a recoverable
    // imperative even though our last handshake said it was ready. Re-enter
    // the serialized readiness-probe path so draft restoration or a fetched
    // detail receives a bounded retry instead of waiting forever.
    this.webviewReady = false;
    this.delivery.markDirty();
    this.armReadinessProbeIfStuck();
  }

  private canPostSnapshotToView(): boolean {
    return !!this.view && this.webviewReady && !this.hotReloader.isReloading();
  }

  private armReadinessProbeIfStuck(): void {
    if (
      this.view
      && this.view.visible
      && !this.webviewReady
      && this.delivery.getDebugState().dirty
    ) {
      this.readinessProbe.arm();
    }
  }

  private handleReloadStart(reason: string): void {
    this.webviewReady = false;
    if (isLivePipelineTraceEnabled()) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.readiness.transition',
        kind: 'transition',
        identifiers: { hostInstance: this.hostInstanceId },
        viewGeneration: this.delivery.getDebugState().viewGeneration,
        readiness: 'reloading',
        reasonCode: reason.startsWith('recovery:') ? 'commit_timeout' : 'readiness_lost',
      });
    }
    this.watchdog.resetRecoveryEpisode();
    // A started reload is a new bounded readiness episode. Hot-reloader keeps
    // `reloading=true` until ready/force-clear, so clearing here cannot mask a
    // repeated reload skip loop.
    this.readinessProbe.clear();
    this.delivery.invalidateView();
    this.armReadinessProbeIfStuck();
    bootLog('sidebar-provider', 'reload.started', {
      reason,
      viewGeneration: this.delivery.getDebugState().viewGeneration,
    });
  }

  private handleDeliveryRecovery(recovery: StateDeliveryRecovery): void {
    if (isLivePipelineTraceEnabled()) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.recovery.action',
        kind: 'recovery',
        identifiers: { hostInstance: this.hostInstanceId },
        revision: recovery.revision,
        viewGeneration: recovery.viewGeneration,
        reasonCode: recoveryReasonCode(recovery),
      });
    }
    this.watchdog.handleRecovery(recovery);
    if (
      this.watchdog.getLastDecision() === 'throttled'
      && (recovery.reason === 'ledger-overflow'
        || recovery.reason === 'retry-exhausted'
        || recovery.reason === 'commit-timeout')
    ) {
      // Storm throttling still needs bounded in-process recovery; rotating the
      // generation clears the suspended ledger/retry episode without reusing
      // any old settlement.
      this.delivery.invalidateView();
    }
  }

  private recordDeliveryTrace(event: StateDeliveryTelemetry): void {
    if (!isLivePipelineTraceEnabled()) return;
    const mapped = deliveryTraceMapping(event.kind);
    if (!mapped) return;
    recordLivePipelineTrace({
      process: mapped.process,
      stage: mapped.stage,
      kind: mapped.kind,
      identifiers: { hostInstance: this.hostInstanceId },
      revision: event.revision,
      viewGeneration: event.viewGeneration,
      operationId: event.operationId,
      postResult: mapped.postResult,
      reasonCode: mapped.reasonCode,
    });
  }

  private handleReadinessExhausted(): void {
    const debug = this.delivery.getDebugState();
    const recovery: StateDeliveryRecovery = {
      reason: 'retry-exhausted',
      attempts: READINESS_PROBE_MAX_ATTEMPTS,
      desiredGeneration: debug.desiredGeneration,
      viewGeneration: debug.viewGeneration,
    };
    // Exhaustion is terminal for this bounded probe episode. Reset its counter
    // before a successful reload starts a fresh episode; when reload storm
    // protection declines the request, remain explicitly exhausted until a
    // later host change or visibility transition begins another episode.
    this.readinessProbe.clear();
    this.watchdog.handleRecovery(recovery);
  }
}

function getReadinessViewGeneration(msg: WebviewToHostMessage): number | undefined {
  return msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot'
    ? msg.viewGeneration
    : undefined;
}

function isRenderEvidenceType(type: unknown): boolean {
  return type === 'stateReceived'
    || type === 'appCommitted'
    || type === 'transcriptCommitted'
    || type === 'transcriptCommitBlocked'
    || type === 'paintObserved'
    || type === 'renderFailure';
}

function isRenderEvidenceMessage(msg: WebviewToHostMessage): msg is Extract<
  WebviewToHostMessage,
  { type: 'stateReceived' | 'appCommitted' | 'transcriptCommitted' | 'transcriptCommitBlocked' | 'paintObserved' | 'renderFailure' }
> {
  return isRenderEvidenceType(msg.type);
}

type DeliveryTraceMapping = {
  process: LivePipelineTraceProcess;
  stage: LivePipelineTraceStage;
  kind: LivePipelineTraceKind;
  postResult?: 'true' | 'false' | 'rejected' | 'timeout' | 'late';
  reasonCode?: LivePipelineTraceReasonCode;
};

function deliveryTraceMapping(kind: StateDeliveryTelemetry['kind']): DeliveryTraceMapping | null {
  switch (kind) {
    case 'post-started': return { process: 'host', stage: 'host.post.started', kind: 'start' };
    case 'post-accepted': return { process: 'host', stage: 'host.post.settled', kind: 'success', postResult: 'true' };
    case 'post-false': return { process: 'host', stage: 'host.post.settled', kind: 'false', postResult: 'false', reasonCode: 'post_false' };
    case 'post-rejected': return { process: 'host', stage: 'host.post.settled', kind: 'rejected', postResult: 'rejected', reasonCode: 'post_rejected' };
    case 'post-timeout': return { process: 'host', stage: 'host.post.timeout', kind: 'timeout', postResult: 'timeout', reasonCode: 'post_timeout' };
    case 'post-late-settlement': return { process: 'host', stage: 'host.post.late', kind: 'late', postResult: 'late', reasonCode: 'late_settlement' };
    case 'state-received': return { process: 'webview', stage: 'webview.state.received', kind: 'success' };
    case 'app-committed': return { process: 'webview', stage: 'webview.app.committed', kind: 'success' };
    case 'transcript-committed':
    case 'commit-advanced': return { process: 'webview', stage: 'webview.transcript.committed', kind: 'success' };
    case 'paint-observed': return { process: 'webview', stage: 'webview.paint.observed', kind: 'success' };
    case 'commit-timeout': return { process: 'host', stage: 'host.recovery.action', kind: 'timeout', reasonCode: 'commit_timeout' };
    case 'ledger-overflow': return { process: 'host', stage: 'host.recovery.action', kind: 'failure', reasonCode: 'ledger_overflow' };
    case 'retry-exhausted': return { process: 'host', stage: 'host.recovery.action', kind: 'failure', reasonCode: 'readiness_exhausted' };
    case 'protocol-defect': return { process: 'host', stage: 'host.recovery.action', kind: 'failure', reasonCode: 'commit_identity_mismatch' };
    default: return null;
  }
}

function recoveryReasonCode(recovery: StateDeliveryRecovery): LivePipelineTraceReasonCode {
  switch (recovery.reason) {
    case 'commit-timeout': return 'commit_timeout';
    case 'ledger-overflow': return 'ledger_overflow';
    case 'retry-exhausted': return 'readiness_exhausted';
    case 'render-failure':
      switch (recovery.renderFailure?.classification) {
        case 'component_error': return 'render_component_error';
        case 'uncaught_error': return 'render_uncaught_error';
        case 'unhandled_rejection': return 'render_unhandled_rejection';
        default: return 'unknown_unattributable';
      }
  }
}

/** Avoid forwarding arbitrary error bodies into logs/telemetry. */
function sanitizeError(error: unknown): Error {
  return new Error(error instanceof Error ? error.name : typeof error);
}
