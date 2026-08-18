/**
 * Per-renderer delivery owner (browser server plan §4.1).
 *
 * One `RendererSession` owns everything a single renderer surface needs to
 * stay synchronized with the shared host state: its own `SidebarSyncState`,
 * `StateDeliveryController`, readiness probe, commit watchdog, pending
 * imperatives, readiness/visibility beliefs, and renderer identity
 * (`rendererId`, `rendererGeneration`). Evidence from one renderer can never
 * settle another: each session's accepted ledger is private, and inbound
 * evidence is routed by the transport registration first.
 *
 * The session is transport-neutral: the VS Code sidebar adapter and the
 * future browser WebSocket adapter both register a `RendererTransport` and
 * delegate the generic message prelude (validation, render evidence,
 * handshake, generation fences, command routing) to this class.
 */

import { auditLog, bootLog, isBootLogEnabled } from '../util/audit';
import { recordSnapshotPost } from '../util/stream-telemetry';
import { appendPieError, appendPieLog } from '../util/pie-log';
import {
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
} from '../util/live-pipeline-trace-runtime';
import { StateAppliedWatchdog } from '../sidebar/state-applied-watchdog';
import { WebviewReadinessProbe, READINESS_PROBE_MAX_ATTEMPTS } from '../sidebar/readiness-probe';
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
} from '../sidebar/state-delivery-controller';
import { buildStateEnvelope, createSidebarSyncState, type SidebarSyncState } from '../sidebar/sync';
import type {
  HostToWebviewMessage,
  RendererCommandContext,
  RendererKind,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import type {
  LivePipelineTraceKind,
  LivePipelineTraceProcess,
  LivePipelineTraceReasonCode,
  LivePipelineTraceStage,
} from '../../shared/live-pipeline-trace';
import { validateWebviewToHostMessage } from '../../shared/protocol-validation';
import type {
  DisposableLike,
  RendererRegistration,
  RendererSessionDebugState,
  RendererTransport,
} from './types';

/** Imperative message types that survive a not-ready/reloading renderer: they
 *  are queued and flushed on readiness, and requeued when delivery fails.
 *  Phase 5 detail streams are included because the host keeps the subscription
 *  owner alive regardless of renderer readiness; dropping the stream would
 *  orphan the expanded card (a stale-route message is still rejected later by
 *  the webview's view-generation check). */
const RECOVERABLE_IMPERATIVE_TYPES: ReadonlySet<string> = new Set([
  'sendRejected',
  'detailResult',
  'detail.start',
  'detail.page',
  'detail.delta',
  'detail.rebase',
  'detail.terminal',
  'detail.error',
]);

type RecoverableImperative = Extract<HostToWebviewMessage, { type: 'sendRejected' | 'detailResult' | 'detail.start' | 'detail.page' | 'detail.delta' | 'detail.rebase' | 'detail.terminal' | 'detail.error' }>;

function isRecoverableImperative(message: HostToWebviewMessage): message is RecoverableImperative {
  return RECOVERABLE_IMPERATIVE_TYPES.has(message.type);
}

export interface RendererSessionOptions {
  /** Host-assigned renderer session id; never trusted from a payload. */
  rendererId: string;
  kind: RendererKind;
  /** Shared extension-host incarnation (same value for every renderer). */
  hostInstanceId: string;
  clock: StateDeliveryClock;
  /** Shared projected `ViewState` (one projection per logical render). */
  getViewState(): ViewState;
  /** Command routing: validated non-evidence messages reach the host here. */
  onMessage(msg: WebviewToHostMessage, context: RendererCommandContext): void;
  getRunningSessionCount(): number;
  transport: RendererTransport;
  settlementTimeoutMs?: number;
  commitTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetryAttempts?: number;
  acceptedLedgerCapacity?: number;
}

/** Sole per-renderer delivery owner. */
export class RendererSession implements RendererRegistration, DisposableLike {
  readonly rendererId: string;
  readonly kind: RendererKind;
  private readonly hostInstanceId: string;
  private syncState: SidebarSyncState;
  private webviewReady = false;
  private visible = true;
  private rendererGeneration = 1;
  private lastTranscriptCommitBlockedReason?: string;
  private pendingImperatives: Array<Exclude<HostToWebviewMessage, { type: 'state' }>> = [];
  private readonly watchdog: StateAppliedWatchdog;
  private readonly readinessProbe: WebviewReadinessProbe;
  private readonly delivery: StateDeliveryController<Extract<HostToWebviewMessage, { type: 'state' }>>;
  private readonly messageDisposable: DisposableLike;
  private readonly visibilityDisposable: DisposableLike;
  private unregisterHandler?: () => void;
  private disposed = false;

  constructor(private readonly options: RendererSessionOptions) {
    this.rendererId = options.rendererId;
    this.kind = options.kind;
    this.hostInstanceId = options.hostInstanceId;
    this.syncState = createSidebarSyncState(this.hostInstanceId);
    const clock = options.clock;

    this.watchdog = new StateAppliedWatchdog({
      getHostInstanceId: () => this.hostInstanceId,
      getRunningSessionCount: () => options.getRunningSessionCount(),
      onForceReload: (recovery) => this.handleForceReload(recovery),
      now: () => clock.now(),
    });
    this.readinessProbe = new WebviewReadinessProbe({
      getViewExists: () => options.transport.isAttached(),
      getViewVisible: () => this.visible,
      getWebviewReady: () => this.webviewReady,
      getGlobalDirty: () => this.delivery.getDebugState().dirty,
      isReloading: () => options.transport.isReloading(),
      onProbe: () => this.delivery.probe(),
      onForceClearReloading: () => options.transport.clearReloading(),
      onExhausted: () => this.handleReadinessExhausted(),
    });
    this.delivery = new StateDeliveryController({
      clock,
      buildSnapshot: (buildContext) => {
        const startedAt = isLivePipelineTraceEnabled() ? performance.now() : 0;
        const result = buildStateEnvelope(this.syncState, options.getViewState(), {
          ...buildContext,
          rendererId: this.rendererId,
          rendererGeneration: this.rendererGeneration,
        });
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
        // A post racing a reload/replacement must never reach the new view.
        if (postContext.viewGeneration !== this.delivery.getDebugState().viewGeneration) return false;
        return options.transport.post(snapshot.payload);
      },
      onAccepted: (postContext) => {
        recordSnapshotPost();
        if (postContext.readinessProbe && postContext.viewGeneration === this.delivery.getDebugState().viewGeneration) {
          this.webviewReady = true;
          this.options.transport.clearReloading();
          this.readinessProbe.clear();
          this.watchdog.resetRecoveryEpisode();
          const flushedImperatives = this.flushPendingImperatives();
          // A confirming full snapshot follows any imperatives that were queued
          // while readiness was stale.
          if (flushedImperatives) this.delivery.markDirty();
          bootLog('renderer-session', 'readinessProbe.adopted', {
            revision: postContext.revision,
            viewGeneration: postContext.viewGeneration,
          });
        }
      },
      onCommitAdvanced: () => this.watchdog.recordCommitAdvanced(),
      onDeliveryBlocked: () => this.armReadinessProbeIfStuck(),
      onRecovery: (recovery) => this.handleDeliveryRecovery(recovery),
      onProtocolDefect: (defect) => {
        appendPieLog('warn', 'renderer-session', 'renderer render evidence protocol defect', {
          currentViewGeneration: defect.currentViewGeneration,
          evidenceViewGeneration: defect.evidenceViewGeneration,
          reason: defect.reason,
          revision: defect.revision,
          stage: defect.stage,
        });
      },
      onTelemetry: (event) => {
        bootLog('renderer-session', `delivery.${event.kind}`, {
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

    this.messageDisposable = options.transport.onMessage((message) => {
      this.handleMessage(message as WebviewToHostMessage);
    });
    this.visibilityDisposable = options.transport.onVisibilityChanged((visible) => {
      this.setVisible(visible);
    });
  }

  /** Registry removal hook (set by the hub; the adapter owns the transport). */
  setUnregisterHandler(handler: () => void): void {
    this.unregisterHandler = handler;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.webviewReady = false;
    this.pendingImperatives = [];
    this.messageDisposable.dispose();
    this.visibilityDisposable.dispose();
    this.watchdog.dispose();
    this.readinessProbe.dispose();
    this.delivery.dispose();
    this.unregisterHandler?.();
  }

  getHostInstanceId(): string {
    return this.hostInstanceId;
  }

  getViewGeneration(): number {
    return this.delivery.getDebugState().viewGeneration;
  }

  getRendererGeneration(): number {
    return this.rendererGeneration;
  }

  getDebugState(): RendererSessionDebugState {
    const delivery = this.delivery.getDebugState();
    return {
      visible: this.visible,
      webviewReady: this.webviewReady,
      globalDirty: delivery.dirty,
      globalRevision: this.syncState.globalRevision,
      lastStateAppliedRevision: delivery.lastTranscriptCommittedRevision,
      pendingStateAppliedRevision: delivery.acceptedRevisions[0] ?? null,
      viewGeneration: delivery.viewGeneration,
      rendererGeneration: this.rendererGeneration,
      hostInstanceId: this.hostInstanceId,
    };
  }

  /** One immediate authoritative full snapshot. */
  requestState(): void {
    this.postImmediateState(false);
  }

  /** Interaction-critical snapshot for an explicit tab selection. */
  postSelectionState(): void {
    this.postImmediateState(true);
  }

  /** Debounce only while eligible; blocked/hidden state records dirty now. */
  markDirty(): void {
    if (!this.canPostSnapshotToView() || !this.visible) {
      this.delivery.markDirty();
      this.armReadinessProbeIfStuck();
      if (isBootLogEnabled()) {
        bootLog('renderer-session', 'snapshot.markDirty', {
          ready: this.webviewReady,
          revision: this.syncState.globalRevision,
          visible: this.visible,
        });
      }
      return;
    }
    this.delivery.markDirty();
  }

  /** Interaction-critical dirty (explicit selection fast path). */
  markPriorityDirty(): void {
    this.delivery.markPriorityDirty();
    this.armReadinessProbeIfStuck();
  }

  /** Imperatives remain separate from authoritative full snapshots. */
  postImperative(msg: HostToWebviewMessage): void {
    if (msg.type === 'state') {
      throw new Error('State envelopes must be posted by StateDeliveryController.');
    }
    if (!this.options.transport.isAttached() || !this.webviewReady || this.options.transport.isReloading()) {
      if (isRecoverableImperative(msg)) {
        this.pendingImperatives.push(msg);
        this.delivery.markDirty();
        this.armReadinessProbeIfStuck();
      }
      return;
    }
    this.postImperativeToTransport(msg);
  }

  /** Generic inbound message prelude: validation, evidence, handshake,
   *  generation fences, and command routing. Transport-specific preludes
   *  (asset-version reload, hot-reload gating) run in the adapter first. */
  handleMessage(msg: WebviewToHostMessage): void {
    try {
      const validation = validateWebviewToHostMessage(msg);
      if (!validation.ok) {
        auditLog('renderer-session', 'message.invalid', {
          reason: validation.reason,
          type: (msg as { type?: unknown })?.type ?? null,
        });
        if (isRenderEvidenceType((msg as { type?: unknown })?.type)) return;
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
              appendPieLog('warn', 'renderer-session', 'transcript commit blocked', {
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
        auditLog('renderer-session', 'message.staleGenerationIgnored', {
          type: msg.type,
          messageGeneration,
          viewGeneration: currentGeneration,
        });
        return;
      }
      if (this.options.transport.isReloading() && messageGeneration === undefined) {
        // The renderer being replaced may still emit commands while its HTML
        // is swapping. Generation-stamped commands from the replacement are
        // safe to route; unstamped legacy/stale commands are ignored. Render
        // evidence is handled above and never reaches this gate.
        return;
      }
      const becameReady = readinessGeneration === undefined
        ? false
        : this.markBridgeReady(msg.type, readinessGeneration);
      this.options.onMessage(msg, this.getCommandContext());
      if (becameReady && this.webviewReady) this.delivery.notifyEligibilityChanged();
    } catch (error: unknown) {
      appendPieError('renderer-session', 'message prelude failed', sanitizeError(error));
    }
  }

  /** View resolution/replacement: fresh generation, no retained-dirty logic. */
  handleViewResolved(visible: boolean): void {
    this.webviewReady = false;
    this.rendererGeneration += 1;
    this.readinessProbe.clear();
    this.watchdog.resetRecoveryEpisode();
    this.delivery.invalidateView();
    this.delivery.setVisible(visible);
    this.readinessProbe.setVisible(visible);
    this.visible = visible;
  }

  /** View disposed / socket closed. */
  handleViewDisposed(): void {
    this.webviewReady = false;
    this.rendererGeneration += 1;
    this.readinessProbe.clear();
    this.delivery.invalidateView();
  }

  /** Reload/reconnect started by the transport. */
  handleReloadStart(reason: string): void {
    this.webviewReady = false;
    this.rendererGeneration += 1;
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
    // A started reload is a new bounded readiness episode. The transport keeps
    // `reloading=true` until ready/force-clear, so clearing here cannot mask a
    // repeated reload skip loop.
    this.readinessProbe.clear();
    this.delivery.invalidateView();
    this.armReadinessProbeIfStuck();
    bootLog('renderer-session', 'reload.started', {
      reason,
      viewGeneration: this.delivery.getDebugState().viewGeneration,
    });
  }

  /** Visibility transition with retained-dirty resume logic. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    const retainedDirty = this.delivery.getDebugState().dirty;
    this.visible = visible;
    this.delivery.setVisible(visible);
    this.readinessProbe.setVisible(visible);
    if (visible) {
      // Resume retained hidden intent, or force one fresh authoritative
      // snapshot when no hidden change was recorded. Never mint both.
      if (!retainedDirty) this.delivery.markDirty();
      this.delivery.notifyEligibilityChanged();
      this.armReadinessProbeIfStuck();
    }
  }

  armReadinessProbeIfStuck(): void {
    if (
      this.options.transport.isAttached()
      && this.visible
      && !this.webviewReady
      && this.delivery.getDebugState().dirty
    ) {
      this.readinessProbe.arm();
    }
  }

  canPostSnapshotToView(): boolean {
    return this.options.transport.isAttached() && this.webviewReady && !this.options.transport.isReloading();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Delivery controller access for adapters/tests (readiness probe path). */
  getDeliveryController(): StateDeliveryController<Extract<HostToWebviewMessage, { type: 'state' }>> {
    return this.delivery;
  }

  private getCommandContext(): RendererCommandContext {
    return {
      rendererId: this.rendererId,
      kind: this.kind,
      rendererGeneration: this.rendererGeneration,
    };
  }

  private postImmediateState(priority: boolean): void {
    if (priority) this.delivery.markPriorityDirty();
    else this.delivery.markDirty();
    this.armReadinessProbeIfStuck();
  }

  private markBridgeReady(type: string, viewGeneration?: number): boolean {
    if (this.webviewReady) return false;
    const currentViewGeneration = this.delivery.getDebugState().viewGeneration;
    if (viewGeneration !== currentViewGeneration) {
      bootLog('renderer-session', 'message.bridgeReadyIgnored', {
        generation: viewGeneration === undefined ? 'missing' : 'stale',
        type,
        viewGeneration: currentViewGeneration,
      });
      return false;
    }
    this.webviewReady = true;
    this.options.transport.clearReloading();
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
    bootLog('renderer-session', 'message.bridgeReady', {
      type,
      viewGeneration: currentViewGeneration,
    });
    return true;
  }

  private flushPendingImperatives(): boolean {
    if (this.pendingImperatives.length === 0 || !this.options.transport.isAttached() || !this.webviewReady) return false;
    const queued = this.pendingImperatives;
    this.pendingImperatives = [];
    for (const imperative of queued) this.postImperativeToTransport(imperative);
    return true;
  }

  private postImperativeToTransport(message: Exclude<HostToWebviewMessage, { type: 'state' }>): void {
    // A post racing a reload/replacement must never requeue into the new
    // renderer generation: capture the fence at post time and requeue only
    // when the renderer generation is still current (the original provider
    // fenced on the WebviewView object identity; rendererGeneration is the
    // transport-neutral equivalent — it advances exactly on view
    // resolve/dispose/reload, NOT on in-process throttled-recovery rotation,
    // matching the original view-identity semantics).
    const postGeneration = this.rendererGeneration;
    void Promise.resolve(this.options.transport.post(message)).then((delivered) => {
      if (!delivered && isRecoverableImperative(message) && !this.disposed
        && this.rendererGeneration === postGeneration) {
        this.requeueRecoverableImperative(message);
      }
    }, (error: unknown) => {
      appendPieLog('warn', 'renderer-session', 'imperative post rejected', {
        errorType: error instanceof Error ? error.name : typeof error,
        messageType: message.type,
      });
      if (isRecoverableImperative(message) && !this.disposed
        && this.rendererGeneration === postGeneration) {
        this.requeueRecoverableImperative(message);
      }
    });
  }

  private requeueRecoverableImperative(message: RecoverableImperative): void {
    this.pendingImperatives.push(message);
    // A false/rejected post means the transport did not accept a recoverable
    // imperative even though our last handshake said it was ready. Re-enter
    // the serialized readiness-probe path so draft restoration or a fetched
    // detail receives a bounded retry instead of waiting forever.
    this.webviewReady = false;
    this.delivery.markDirty();
    this.armReadinessProbeIfStuck();
  }

  private handleForceReload(recovery: StateDeliveryRecovery): Promise<void> {
    return Promise.resolve(this.options.transport.recover(recovery.reason));
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
