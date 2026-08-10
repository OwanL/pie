import type {
  AppCommittedPayload,
  PaintObservedPayload,
  RenderFailurePayload,
  StateReceivedPayload,
  TranscriptCommitBlockedPayload,
  TranscriptCommittedPayload,
} from '../../shared/protocol';

/**
 * These defaults preserve the previous host timings. They are provisional and
 * must not be described as calibrated until real VS Code/Chromium traces exist.
 */
export const PROVISIONAL_STATE_POST_SETTLEMENT_TIMEOUT_MS = 2_500;
export const PROVISIONAL_TRANSCRIPT_COMMIT_TIMEOUT_MS = 2_500;
export const PROVISIONAL_STATE_RETRY_DELAY_MS = 1_500;
export const PROVISIONAL_STATE_RETRY_MAX_ATTEMPTS = 4;
export const PROVISIONAL_ACCEPTED_REVISION_LEDGER_CAPACITY = 64;

export interface StateDeliveryClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StateDeliverySnapshot<T> {
  payload: T;
  expectedTranscriptIdentity: string;
}

export interface StateDeliveryBuildContext {
  revision: number;
  desiredGeneration: number;
  viewGeneration: number;
}

export interface StateDeliveryPostContext extends StateDeliveryBuildContext {
  operationId: number;
  readinessProbe: boolean;
}

export type StateDeliveryRecoveryReason =
  | 'commit-timeout'
  | 'ledger-overflow'
  | 'retry-exhausted'
  | 'render-failure';
export type StateDeliveryProtocolDefectReason =
  | 'future-view-generation'
  | 'future-or-unaccepted-evidence'
  | 'future-or-unaccepted-commit'
  | 'commit-identity-mismatch';
export type StateDeliveryEvidenceStage =
  | 'state-received'
  | 'app-committed'
  | 'transcript-committed'
  | 'paint-observed'
  | 'render-failure';
export type StateDeliveryTelemetryKind =
  | 'post-started'
  | 'post-accepted'
  | 'post-false'
  | 'post-rejected'
  | 'post-timeout'
  | 'post-late-settlement'
  | 'retry-scheduled'
  | 'retry-paused-hidden'
  | 'retry-paused-ineligible'
  | 'retry-exhausted'
  | 'state-received'
  | 'app-committed'
  | 'transcript-committed'
  | 'paint-observed'
  | 'render-failure'
  | 'evidence-stale'
  | 'commit-deferred'
  | 'commit-blocked'
  | 'commit-advanced'
  | 'commit-stale'
  | 'commit-timeout'
  | 'ledger-overflow'
  | 'protocol-defect';

export interface StateDeliveryTelemetry {
  kind: StateDeliveryTelemetryKind;
  viewGeneration: number;
  operationId?: number;
  revision?: number;
  desiredGeneration?: number;
  /** A bounded classification only. Never place an Error message/body here. */
  detail?: string;
}

export interface StateDeliveryRecovery {
  reason: StateDeliveryRecoveryReason;
  viewGeneration: number;
  desiredGeneration: number;
  revision?: number;
  attempts?: number;
  renderFailure?: Pick<RenderFailurePayload, 'surface' | 'classification'>;
}

export interface StateDeliveryProtocolDefect {
  reason: StateDeliveryProtocolDefectReason;
  stage: StateDeliveryEvidenceStage;
  revision: number | null;
  currentViewGeneration: number;
  evidenceViewGeneration: number;
  expectedTranscriptIdentity?: string;
  actualTranscriptIdentity?: string;
}

export interface StateDeliveryControllerOptions<T> {
  clock: StateDeliveryClock;
  /** Builds only the latest snapshot that is about to be posted. */
  buildSnapshot(context: StateDeliveryBuildContext): StateDeliverySnapshot<T>;
  /** Normal delivery eligibility. A readiness probe uses the same serializer. */
  isEligible(): boolean;
  post(snapshot: StateDeliverySnapshot<T>, context: StateDeliveryPostContext): boolean | Promise<boolean>;
  onRecovery(recovery: StateDeliveryRecovery): void;
  onProtocolDefect(defect: StateDeliveryProtocolDefect): void;
  onTelemetry?(telemetry: StateDeliveryTelemetry): void;
  onAccepted?(context: StateDeliveryPostContext): void;
  onCommitAdvanced?(revision: number): void;
  onDeliveryBlocked?(): void;
  settlementTimeoutMs: number;
  commitTimeoutMs: number;
  retryDelayMs: number;
  maxRetryAttempts: number;
  acceptedLedgerCapacity: number;
}

export interface StateDeliveryDebugState {
  desiredGeneration: number;
  lastAcceptedDesiredGeneration: number;
  dirty: boolean;
  viewGeneration: number;
  activeOperationId: number | null;
  acceptedRevisions: readonly number[];
  lastTranscriptCommittedRevision: number;
  retryAttempts: number;
  retryExhausted: boolean;
  visible: boolean;
  disposed: boolean;
}

type AcceptedRevision = {
  revision: number;
  expectedTranscriptIdentity: string;
  acceptedAt: number;
};

type DeferredCommit = {
  revision: number;
  identity: string;
  viewGeneration: number;
};

type PostOperation<T> = {
  id: number;
  viewGeneration: number;
  desiredGeneration: number;
  revision: number;
  readinessProbe: boolean;
  snapshot: StateDeliverySnapshot<T>;
  timeout: unknown;
  resolveProbe?: (accepted: boolean) => void;
  deferredCommit?: DeferredCommit;
  deferredBlock?: TranscriptCommitBlockedPayload;
};

/**
 * Sole owner of authoritative snapshot delivery and transcript-commit progress.
 * It permits exactly one unsettled post and one accepted-but-uncommitted
 * revision. Host changes that arrive while the renderer is committing are
 * coalesced into the next full snapshot. This commit gate is intentional
 * backpressure: `webview.postMessage()` settles when VS Code accepts a message,
 * not when Chromium has rendered it, so posting every streaming revision can
 * build an arbitrarily stale renderer queue whose transcript catches up only
 * after the agent stops producing updates.
 */
export class StateDeliveryController<T> {
  private desiredGeneration = 0;
  private lastAcceptedDesiredGeneration = 0;
  private viewGeneration = 1;
  private nextOperationId = 1;
  private nextRevision = 1;
  private activeOperation: PostOperation<T> | undefined;
  private accepted: AcceptedRevision[] = [];
  /** Highest posted revision retired by settlement/commit timeout recovery.
   * Late evidence for one of these revisions is stale, not a protocol defect. */
  private retiredAcceptedRevisionHighWater = 0;
  private lastTranscriptCommittedRevision = 0;
  private lastTranscriptCommittedIdentity: string | undefined;
  private commitTimer: unknown;
  private commitDeadlineAt: number | undefined;
  private pausedCommitRemainingMs: number | undefined;
  private retryTimer: unknown;
  private retryAttempts = 0;
  private retryExhausted = false;
  private deliverySuspended = false;
  /** Latest interaction-critical desired generation not yet accepted. */
  private priorityDesiredGeneration = 0;
  private overflowReported = false;
  private visible = true;
  private disposed = false;

  constructor(private readonly options: StateDeliveryControllerOptions<T>) {
    if (options.acceptedLedgerCapacity < 1) {
      throw new Error('acceptedLedgerCapacity must be at least 1');
    }
  }

  /** Marks newer host state desired. The state itself remains lazy. */
  markDirty(): number {
    return this.markDesired(false);
  }

  /**
   * Marks an interaction-critical state change (currently explicit session
   * selection). Unlike ordinary streaming updates, this may retire an older
   * accepted-but-uncommitted snapshot and post the latest state immediately.
   * VS Code preserves postMessage order, so the renderer still observes the
   * old snapshot before the replacement; late evidence for the retired
   * revision is intentionally classified as stale.
   */
  markPriorityDirty(): number {
    return this.markDesired(true);
  }

  /** Retries after readiness/reload/visibility eligibility changes. */
  notifyEligibilityChanged(): void {
    if (this.disposed) return;
    if (this.options.isEligible()) {
      this.clearRetryTimer();
    }
    this.flush();
  }

  /**
   * Readiness recovery is serialized through the same operation slot. It may
   * bypass only the stale ready belief; the caller still checks view/reload
   * eligibility before invoking this method.
   */
  probe(): Promise<boolean> {
    if (
      this.disposed
      || !this.visible
      || !this.dirty
      || this.deliverySuspended
      || this.activeOperation
      || this.accepted.length > 0
    ) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      if (!this.startPost(true, resolve)) resolve(false);
    });
  }

  /** Hidden views retain intent and pause both retry and commit clocks. */
  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible;
    if (!visible) {
      this.clearRetryTimer();
      this.pauseCommitDeadline();
      this.telemetry('retry-paused-hidden');
      return;
    }
    this.armCommitDeadline();
    this.flush();
  }

  /**
   * Replacements and reload starts invalidate all old async callbacks and force
   * a fresh snapshot. Global revisions remain monotonic.
   */
  invalidateView(): void {
    if (this.disposed) return;
    this.viewGeneration += 1;
    this.clearActiveOperation(false);
    this.clearCommitTimer();
    this.clearRetryTimer();
    this.accepted = [];
    this.retryAttempts = 0;
    this.retryExhausted = false;
    this.deliverySuspended = false;
    this.overflowReported = false;
    this.desiredGeneration += 1;
    this.flush();
  }

  /** Starts the one allowed normal post, if currently eligible. */
  flush(): void {
    if (
      this.disposed
      || !this.dirty
      || this.activeOperation
      || this.retryTimer !== undefined
      || !this.visible
      || this.deliverySuspended
    ) return;

    if (!this.options.isEligible()) {
      this.options.onDeliveryBlocked?.();
      return;
    }

    const priorityPending = this.priorityDesiredGeneration > this.lastAcceptedDesiredGeneration;
    if (this.accepted.length > 0) {
      if (!priorityPending) return;
      // Explicit selection must not sit behind a streaming transcript commit.
      // Retire the old acceptance before posting the ordered replacement so
      // its delayed receipt/commit/paint evidence remains telemetry-only.
      this.retiredAcceptedRevisionHighWater = Math.max(
        this.retiredAcceptedRevisionHighWater,
        ...this.accepted.map((entry) => entry.revision),
      );
      this.accepted = [];
      this.clearCommitTimer();
    }
    this.startPost(false);
  }

  stateReceived(payload: StateReceivedPayload): void {
    this.recordNonCommitEvidence('state-received', payload.viewGeneration, payload.revision);
  }

  appCommitted(payload: AppCommittedPayload): void {
    this.recordNonCommitEvidence('app-committed', payload.viewGeneration, payload.revision);
  }

  /**
   * Renderer evidence can show that an accepted snapshot is already stale
   * relative to newer coalesced host state (most often while text/tool leaves
   * are streaming). In that case retire only the stale acceptance and post the
   * latest desired snapshot. Without this path the commit gate waits for a
   * snapshot the renderer has explicitly said it cannot prove, then enters a
   * pointless reload loop while the stream keeps advancing.
   *
   * A block with no newer host state does not open the gate: the existing
   * commit deadline still bounds a genuine, stable render mismatch.
   */
  transcriptCommitBlocked(payload: TranscriptCommitBlockedPayload): void {
    const { revision, viewGeneration, reason } = payload;
    if (!this.validateEvidenceGeneration('transcript-committed', viewGeneration, revision)) return;
    if (revision <= this.lastTranscriptCommittedRevision || revision <= this.retiredAcceptedRevisionHighWater) {
      this.telemetry('evidence-stale', { revision, viewGeneration }, 'transcript-commit-blocked');
      return;
    }
    const entry = this.accepted.find((candidate) => candidate.revision === revision);
    if (!entry) {
      // A block may race postMessage settlement just like a successful commit.
      // It cannot safely retire the active post until VS Code accepts it.
      if (this.activeOperation?.revision === revision) {
        this.activeOperation.deferredBlock = payload;
        this.telemetry('commit-blocked', { revision, viewGeneration }, `${reason}:pre-settlement`);
        return;
      }
      this.protocolDefect('future-or-unaccepted-evidence', 'transcript-committed', revision, viewGeneration);
      return;
    }

    this.telemetry('commit-blocked', { revision, viewGeneration }, reason);
    if (!this.dirty) return;

    this.retiredAcceptedRevisionHighWater = Math.max(this.retiredAcceptedRevisionHighWater, revision);
    this.accepted = this.accepted.filter((candidate) => candidate.revision > revision);
    this.clearCommitTimer();
    this.armCommitDeadline();
    this.flush();
  }

  transcriptCommitted(payload: TranscriptCommittedPayload): void;
  transcriptCommitted(revision: number, identity: string, viewGeneration?: number): void;
  transcriptCommitted(
    payloadOrRevision: TranscriptCommittedPayload | number,
    identity?: string,
    viewGeneration?: number,
  ): void {
    const payload = typeof payloadOrRevision === 'number'
      ? { revision: payloadOrRevision, identity: identity ?? '', viewGeneration: viewGeneration ?? this.viewGeneration }
      : payloadOrRevision;
    this.recordTranscriptCommit(payload.revision, payload.identity, payload.viewGeneration);
  }

  paintObserved(payload: PaintObservedPayload): void {
    if (!this.validateEvidenceGeneration('paint-observed', payload.viewGeneration, payload.revision)) return;
    if (payload.revision < this.lastTranscriptCommittedRevision) {
      this.telemetry('evidence-stale', { revision: payload.revision, viewGeneration: payload.viewGeneration }, 'paint-observed');
      return;
    }
    if (payload.revision === this.lastTranscriptCommittedRevision) {
      if (this.lastTranscriptCommittedIdentity !== payload.identity) {
        this.protocolDefect(
          'commit-identity-mismatch',
          'paint-observed',
          payload.revision,
          payload.viewGeneration,
          payload.identity,
          this.lastTranscriptCommittedIdentity,
        );
        return;
      }
      this.telemetry('paint-observed', { revision: payload.revision, viewGeneration: payload.viewGeneration });
      return;
    }
    if (payload.revision <= this.retiredAcceptedRevisionHighWater) {
      this.telemetry('evidence-stale', { revision: payload.revision, viewGeneration: payload.viewGeneration }, 'paint-observed');
      return;
    }
    const entry = this.accepted.find((candidate) => candidate.revision === payload.revision);
    const activeEntry = this.activeOperation?.revision === payload.revision ? this.activeOperation : undefined;
    if (!entry && !activeEntry) {
      this.protocolDefect('future-or-unaccepted-evidence', 'paint-observed', payload.revision, payload.viewGeneration, payload.identity);
      return;
    }
    const expectedIdentity = entry?.expectedTranscriptIdentity ?? activeEntry?.snapshot.expectedTranscriptIdentity;
    if (expectedIdentity !== payload.identity) {
      this.protocolDefect(
        'commit-identity-mismatch',
        'paint-observed',
        payload.revision,
        payload.viewGeneration,
        payload.identity,
        expectedIdentity,
      );
      return;
    }
    this.telemetry('paint-observed', { revision: payload.revision, viewGeneration: payload.viewGeneration });
  }

  renderFailure(payload: RenderFailurePayload): void {
    if (!this.validateEvidenceGeneration('render-failure', payload.viewGeneration, payload.revision)) return;
    if (payload.revision !== null) {
      if (payload.revision < this.lastTranscriptCommittedRevision) {
        this.telemetry('evidence-stale', { revision: payload.revision, viewGeneration: payload.viewGeneration }, 'render-failure');
        return;
      }
      if (payload.revision > this.lastTranscriptCommittedRevision
        && payload.revision <= this.retiredAcceptedRevisionHighWater) {
        this.telemetry('evidence-stale', { revision: payload.revision, viewGeneration: payload.viewGeneration }, 'render-failure');
        return;
      }
      if (payload.revision > this.lastTranscriptCommittedRevision && !this.isKnownRevision(payload.revision)) {
        this.protocolDefect('future-or-unaccepted-evidence', 'render-failure', payload.revision, payload.viewGeneration);
        return;
      }
    }
    this.telemetry('render-failure', {
      revision: payload.revision ?? undefined,
      viewGeneration: payload.viewGeneration,
    }, `${payload.surface}:${payload.classification}`);
    this.options.onRecovery({
      reason: 'render-failure',
      viewGeneration: this.viewGeneration,
      desiredGeneration: this.desiredGeneration,
      revision: payload.revision ?? undefined,
      renderFailure: { surface: payload.surface, classification: payload.classification },
    });
  }

  getDebugState(): StateDeliveryDebugState {
    return {
      desiredGeneration: this.desiredGeneration,
      lastAcceptedDesiredGeneration: this.lastAcceptedDesiredGeneration,
      dirty: this.dirty,
      viewGeneration: this.viewGeneration,
      activeOperationId: this.activeOperation?.id ?? null,
      acceptedRevisions: this.accepted.map((entry) => entry.revision),
      lastTranscriptCommittedRevision: this.lastTranscriptCommittedRevision,
      retryAttempts: this.retryAttempts,
      retryExhausted: this.retryExhausted,
      visible: this.visible,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearActiveOperation(false);
    this.clearCommitTimer();
    this.clearRetryTimer();
    this.accepted = [];
  }

  private get dirty(): boolean {
    return this.desiredGeneration > this.lastAcceptedDesiredGeneration;
  }

  private markDesired(priority: boolean): number {
    if (this.disposed) return this.desiredGeneration;
    this.desiredGeneration += 1;
    if (priority) {
      this.priorityDesiredGeneration = this.desiredGeneration;
      // A user interaction should not inherit the delay from a failed older
      // streaming post; it gets a fresh immediate attempt.
      this.clearRetryTimer();
    }
    if (this.retryExhausted) {
      this.retryExhausted = false;
      this.retryAttempts = 0;
      this.deliverySuspended = false;
    }
    this.flush();
    return this.desiredGeneration;
  }

  private startPost(readinessProbe: boolean, resolveProbe?: (accepted: boolean) => void): boolean {
    if (
      this.disposed
      || !this.dirty
      || this.activeOperation
      || this.accepted.length > 0
      || !this.visible
      || this.deliverySuspended
    ) return false;

    const context: StateDeliveryBuildContext = {
      revision: this.nextRevision++,
      desiredGeneration: this.desiredGeneration,
      viewGeneration: this.viewGeneration,
    };

    let snapshot: StateDeliverySnapshot<T>;
    try {
      snapshot = this.options.buildSnapshot(context);
    } catch {
      this.telemetry('post-rejected', context, 'snapshot-build-failed');
      resolveProbe?.(false);
      this.scheduleRetry();
      return false;
    }

    const operation: PostOperation<T> = {
      id: this.nextOperationId++,
      ...context,
      readinessProbe,
      snapshot,
      timeout: undefined,
      resolveProbe,
    };
    this.activeOperation = operation;
    operation.timeout = this.options.clock.setTimeout(
      () => this.handlePostTimeout(operation),
      this.options.settlementTimeoutMs,
    );
    this.telemetry('post-started', operation, readinessProbe ? 'readiness-probe' : undefined);

    try {
      const result = this.options.post(snapshot, { ...context, operationId: operation.id, readinessProbe });
      void Promise.resolve(result).then(
        (accepted) => this.handlePostSettlement(operation, accepted),
        () => this.handlePostRejection(operation),
      );
    } catch {
      this.handlePostRejection(operation);
    }
    return true;
  }

  private handlePostSettlement(operation: PostOperation<T>, accepted: boolean): void {
    if (!this.isCurrentOperation(operation)) {
      this.telemetry('post-late-settlement', operation, accepted ? 'true' : 'false');
      operation.resolveProbe?.(false);
      return;
    }
    this.clearActiveOperation(accepted);

    if (!accepted) {
      this.telemetry('post-false', operation);
      this.scheduleRetry();
      return;
    }

    this.lastAcceptedDesiredGeneration = Math.max(this.lastAcceptedDesiredGeneration, operation.desiredGeneration);
    this.retryAttempts = 0;
    this.retryExhausted = false;
    this.accepted.push({
      revision: operation.revision,
      expectedTranscriptIdentity: operation.snapshot.expectedTranscriptIdentity,
      acceptedAt: this.options.clock.now(),
    });
    this.telemetry('post-accepted', operation);
    this.options.onAccepted?.({
      revision: operation.revision,
      desiredGeneration: operation.desiredGeneration,
      viewGeneration: operation.viewGeneration,
      operationId: operation.id,
      readinessProbe: operation.readinessProbe,
    });
    this.armCommitDeadline();

    if (operation.deferredCommit) {
      const deferredCommit = operation.deferredCommit;
      this.recordTranscriptCommit(deferredCommit.revision, deferredCommit.identity, deferredCommit.viewGeneration);
    } else if (operation.deferredBlock) {
      this.transcriptCommitBlocked(operation.deferredBlock);
    }

    if (this.accepted.length > this.options.acceptedLedgerCapacity && !this.overflowReported) {
      this.overflowReported = true;
      this.deliverySuspended = true;
      this.clearCommitTimer();
      this.telemetry('ledger-overflow', operation);
      this.options.onRecovery({
        reason: 'ledger-overflow',
        viewGeneration: this.viewGeneration,
        desiredGeneration: this.desiredGeneration,
        revision: operation.revision,
      });
      return;
    }

    this.flush();
  }

  private handlePostRejection(operation: PostOperation<T>): void {
    if (!this.isCurrentOperation(operation)) {
      this.telemetry('post-late-settlement', operation, 'rejected');
      operation.resolveProbe?.(false);
      return;
    }
    this.clearActiveOperation(false);
    this.telemetry('post-rejected', operation, 'post-rejected');
    this.scheduleRetry();
  }

  private handlePostTimeout(operation: PostOperation<T>): void {
    if (!this.isCurrentOperation(operation)) return;
    // Chromium may have received/rendered the post even though VS Code did not
    // settle postMessage within the host deadline. Retire its revision before
    // dropping the operation so delayed evidence is stale telemetry rather
    // than a false future/unaccepted protocol defect.
    this.retiredAcceptedRevisionHighWater = Math.max(
      this.retiredAcceptedRevisionHighWater,
      operation.revision,
    );
    this.clearActiveOperation(false);
    this.telemetry('post-timeout', operation);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.dirty || this.retryTimer !== undefined || this.retryExhausted || this.deliverySuspended) return;
    if (!this.visible) {
      this.telemetry('retry-paused-hidden');
      return;
    }
    if (!this.options.isEligible()) {
      this.telemetry('retry-paused-ineligible');
      this.options.onDeliveryBlocked?.();
      return;
    }
    if (this.retryAttempts >= this.options.maxRetryAttempts) {
      this.retryExhausted = true;
      this.deliverySuspended = true;
      this.clearCommitTimer();
      this.telemetry('retry-exhausted');
      this.options.onRecovery({
        reason: 'retry-exhausted',
        viewGeneration: this.viewGeneration,
        desiredGeneration: this.desiredGeneration,
        attempts: this.retryAttempts,
      });
      return;
    }

    const retryDelayMs = this.priorityDesiredGeneration > this.lastAcceptedDesiredGeneration
      ? 0
      : this.options.retryDelayMs;
    this.retryTimer = this.options.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.disposed || !this.visible) {
        this.telemetry('retry-paused-hidden');
        return;
      }
      if (this.activeOperation) return;
      if (!this.options.isEligible()) {
        this.telemetry('retry-paused-ineligible');
        this.options.onDeliveryBlocked?.();
        return;
      }
      this.retryAttempts += 1;
      this.flush();
    }, retryDelayMs);
    this.telemetry('retry-scheduled', undefined, String(this.retryAttempts + 1));
  }

  private recordNonCommitEvidence(
    stage: 'state-received' | 'app-committed',
    evidenceViewGeneration: number,
    revision: number,
  ): void {
    if (!this.validateEvidenceGeneration(stage, evidenceViewGeneration, revision)) return;
    if (
      revision <= this.lastTranscriptCommittedRevision
      || revision <= this.retiredAcceptedRevisionHighWater
    ) {
      this.telemetry('evidence-stale', { revision, viewGeneration: evidenceViewGeneration }, stage);
      return;
    }
    if (!this.isKnownRevision(revision)) {
      this.protocolDefect('future-or-unaccepted-evidence', stage, revision, evidenceViewGeneration);
      return;
    }
    this.telemetry(stage, { revision, viewGeneration: evidenceViewGeneration });
  }

  private recordTranscriptCommit(revision: number, identity: string, evidenceViewGeneration: number): void {
    if (!this.validateEvidenceGeneration('transcript-committed', evidenceViewGeneration, revision)) return;
    if (revision <= this.lastTranscriptCommittedRevision) {
      this.telemetry('commit-stale', { revision, viewGeneration: evidenceViewGeneration }, 'below-high-water');
      return;
    }
    if (revision <= this.retiredAcceptedRevisionHighWater) {
      this.telemetry('commit-stale', { revision, viewGeneration: evidenceViewGeneration }, 'retired-after-timeout');
      return;
    }

    const entry = this.accepted.find((candidate) => candidate.revision === revision);
    if (!entry) {
      if (this.activeOperation?.revision === revision) {
        if (this.activeOperation.snapshot.expectedTranscriptIdentity !== identity) {
          this.protocolDefect(
            'commit-identity-mismatch',
            'transcript-committed',
            revision,
            evidenceViewGeneration,
            identity,
            this.activeOperation.snapshot.expectedTranscriptIdentity,
          );
          return;
        }
        this.activeOperation.deferredCommit = { revision, identity, viewGeneration: evidenceViewGeneration };
        this.telemetry('commit-deferred', { revision, viewGeneration: evidenceViewGeneration });
        return;
      }
      this.protocolDefect(
        'future-or-unaccepted-commit',
        'transcript-committed',
        revision,
        evidenceViewGeneration,
        identity,
      );
      return;
    }
    if (entry.expectedTranscriptIdentity !== identity) {
      this.protocolDefect(
        'commit-identity-mismatch',
        'transcript-committed',
        revision,
        evidenceViewGeneration,
        identity,
        entry.expectedTranscriptIdentity,
      );
      return;
    }

    this.lastTranscriptCommittedRevision = revision;
    this.lastTranscriptCommittedIdentity = identity;
    this.accepted = this.accepted.filter((candidate) => candidate.revision > revision);
    this.overflowReported = false;
    this.deliverySuspended = false;
    this.clearCommitTimer();
    this.telemetry('transcript-committed', { revision, viewGeneration: evidenceViewGeneration });
    this.telemetry('commit-advanced', { revision, viewGeneration: evidenceViewGeneration });
    this.options.onCommitAdvanced?.(revision);
    this.armCommitDeadline();
    this.flush();
  }

  private validateEvidenceGeneration(
    stage: StateDeliveryEvidenceStage,
    evidenceViewGeneration: number,
    revision: number | null,
  ): boolean {
    if (evidenceViewGeneration < this.viewGeneration) {
      this.telemetry('evidence-stale', { revision: revision ?? undefined, viewGeneration: evidenceViewGeneration }, stage);
      return false;
    }
    if (evidenceViewGeneration > this.viewGeneration) {
      this.protocolDefect('future-view-generation', stage, revision, evidenceViewGeneration);
      return false;
    }
    return true;
  }

  private isKnownRevision(revision: number): boolean {
    return this.activeOperation?.revision === revision
      || this.accepted.some((entry) => entry.revision === revision);
  }

  private armCommitDeadline(): void {
    // New accepted posts never move this deadline. Only commit progress (or a
    // hidden pause/resume) clears and re-arms the sole lack-of-commit timer.
    if (this.disposed || !this.visible || this.accepted.length === 0 || this.commitTimer !== undefined) return;
    const viewGeneration = this.viewGeneration;
    const delayMs = this.pausedCommitRemainingMs ?? this.options.commitTimeoutMs;
    this.pausedCommitRemainingMs = undefined;
    this.commitDeadlineAt = this.options.clock.now() + delayMs;
    this.commitTimer = this.options.clock.setTimeout(() => {
      this.commitTimer = undefined;
      this.commitDeadlineAt = undefined;
      if (
        this.disposed
        || !this.visible
        || this.deliverySuspended
        || viewGeneration !== this.viewGeneration
        || this.accepted.length === 0
      ) return;
      const oldest = this.accepted[0];
      this.telemetry('commit-timeout', { revision: oldest.revision });
      // Retire the timed-out acceptance before invoking the synchronous
      // recovery callback. A callback that invalidates the view (e.g. a host
      // reload) would otherwise clear `accepted` first, so the high-water
      // computed here would miss the retired revision and later evidence for
      // it would be misclassified as a protocol defect instead of stale. The
      // commit gate would also block a new post forever while waiting for the
      // very evidence this timeout says did not arrive.
      this.retiredAcceptedRevisionHighWater = Math.max(
        this.retiredAcceptedRevisionHighWater,
        ...this.accepted.map((entry) => entry.revision),
      );
      this.accepted = [];
      this.options.onRecovery({
        reason: 'commit-timeout',
        viewGeneration: this.viewGeneration,
        desiredGeneration: this.desiredGeneration,
        revision: oldest.revision,
      });
      // A synchronous recovery callback may have invalidated the view (or
      // disposed the controller), which already resnapshots and reflushes.
      // Skip the resnapshot here to avoid a duplicate dirty cycle and post;
      // the invalidateView path re-arms its own commit deadline once its post
      // is accepted.
      if (viewGeneration !== this.viewGeneration || this.disposed) return;
      // Always resnapshot current host state, never an obsolete envelope.
      this.desiredGeneration += 1;
      this.flush();
      this.armCommitDeadline();
    }, delayMs);
  }

  private isCurrentOperation(operation: PostOperation<T>): boolean {
    return !this.disposed
      && this.activeOperation === operation
      && operation.viewGeneration === this.viewGeneration;
  }

  private clearActiveOperation(accepted: boolean): void {
    const operation = this.activeOperation;
    if (!operation) return;
    this.options.clock.clearTimeout(operation.timeout);
    this.activeOperation = undefined;
    operation.resolveProbe?.(accepted);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer !== undefined) {
      this.options.clock.clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    this.commitDeadlineAt = undefined;
    this.pausedCommitRemainingMs = undefined;
  }

  private pauseCommitDeadline(): void {
    if (this.commitTimer === undefined || this.commitDeadlineAt === undefined) return;
    this.pausedCommitRemainingMs = Math.max(0, this.commitDeadlineAt - this.options.clock.now());
    this.options.clock.clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    this.commitDeadlineAt = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    this.options.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private telemetry(
    kind: StateDeliveryTelemetryKind,
    context?: Partial<StateDeliveryBuildContext & { id: number }>,
    detail?: string,
  ): void {
    this.options.onTelemetry?.({
      kind,
      viewGeneration: context?.viewGeneration ?? this.viewGeneration,
      operationId: context?.id,
      revision: context?.revision,
      desiredGeneration: context?.desiredGeneration,
      detail,
    });
  }

  private protocolDefect(
    reason: StateDeliveryProtocolDefectReason,
    stage: StateDeliveryEvidenceStage,
    revision: number | null,
    evidenceViewGeneration: number,
    actualTranscriptIdentity?: string,
    expectedTranscriptIdentity?: string,
  ): void {
    this.telemetry('protocol-defect', { revision: revision ?? undefined, viewGeneration: evidenceViewGeneration }, `${stage}:${reason}`);
    this.options.onProtocolDefect({
      reason,
      stage,
      revision,
      currentViewGeneration: this.viewGeneration,
      evidenceViewGeneration,
      expectedTranscriptIdentity,
      actualTranscriptIdentity,
    });
  }
}
