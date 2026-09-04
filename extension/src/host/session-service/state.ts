import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { assertInvariant, auditLog, bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import {
  PENDING_SESSION_PREFIX,
  isPendingTabPath,
} from '../../shared/tab-behavior';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../shared/transcript-window';
import { resolveHostSessionStoragePaths } from '../../shared/session-storage-paths';
import {
  INITIAL_REVIEW_AUTO_CLOSE_STATE,
  computeReviewAutoCloseClosures,
  closureActionExhaustedRetries,
  type ReviewAutoCloseAttempt,
  type ReviewAutoCloseResult,
  type ReviewAutoCloseState,
} from '../../shared/review-auto-close';
import {
  type ClosureAction,
  type SessionOpenedPayload,
} from '../../shared/protocol';
import { appendClosureActionRecords } from '../../backend/session-review-store';
import type { ScheduleRender, SelectionRequest } from './types';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

export const OPEN_TABS_STORAGE_KEY = 'openTabPaths';
export const ACTIVE_SESSION_STORAGE_KEY = 'activeSessionPath';
export const PINNED_TABS_STORAGE_KEY = 'pinnedTabPaths';
export const PINNED_TAB_GROUPS_STORAGE_KEY = 'pinnedTabGroups';
/** Paths of sessions whose ephemeral mode must survive a host restart. This
 * stores only the privacy marker, never transcript/session contents. */
export const PRIVATE_SESSION_PATHS_STORAGE_KEY = 'privateSessionPaths';
const DEFAULT_SELECTION_REQUEST_TIMEOUT_MS = 60_000;

interface InFlightReviewClosureAttempt extends ReviewAutoCloseAttempt {
  closeResultReceived: boolean;
  persistResultReceived: boolean;
  errors: string[];
}

interface PreloadRecord {
  readonly id: number;
  readonly generation: number;
  readonly sessionPath: string;
  readonly requestEpoch: number;
  readonly abortController: AbortController;
  cancelled: boolean;
  transportSettled: boolean;
  hostWaiterSettled: boolean;
}

class LifecycleTaskStaleGenerationError extends Error {
  constructor() {
    super('Lifecycle task did not start because the backend runtime was reset.');
    this.name = 'LifecycleTaskStaleGenerationError';
  }
}

export class SessionServiceState {
  private readonly busySeqMap = new Map<string, number>();
  private lifecycleQueue = Promise.resolve();
  /** Number of foreground lifecycle tasks queued or in flight in the current
   * backend generation. Background preload work stays paused until all of them
   * settle, not merely until the first request starts. */
  private foregroundLifecycleTasks = 0;
  private lifecycleGeneration = 0;
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly selectionRequests = new Map<string, SelectionRequest>();
  private readonly selectionRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionDataEpochs = new Map<string, number>();
  /** Background session.preload work is deliberately separate from the
   * foreground lifecycle queue. It is FIFO and single-flight so restored
   * sessions cannot stampede the backend during startup. */
  private readonly preloadQueue: PreloadRecord[] = [];
  private readonly preloadRecordsByPath = new Map<string, PreloadRecord>();
  private activePreloadRecord: PreloadRecord | undefined;
  private preloadGeneration = 0;
  /** Monotonic backend generation used to fence model hydration results. */
  private backendGeneration = 0;
  /** Defensive once-only ownership for asynchronous operational incidents. */
  private readonly operationalIncidentKeys = new Set<string>();
  private preloadRecordCounter = 0;
  private preloadPumpScheduled = false;
  /** Durable browse snapshots known in the current backend generation. */
  private readonly knownSnapshotSessionPaths = new Set<string>();
  /** Execution runtimes confirmed in the current backend generation. */
  private readonly knownRuntimeSessionPaths = new Set<string>();
  private readonly suppressNextCompletionNotification = new Set<string>();
  private readonly requestSessionPathById = new Map<string, string>();
  private readonly transcriptTouchedAtBySession = new Map<string, number>();
  private pendingSessionCounter = 0;
  private selectionRequestCounter = 0;
  private currentSelectionToken: string | null = null;
  /** Claims explicit closure-action IDs while their normal tab-close lifecycle
   *  and terminal outbox append are being drained. */
  private reviewAutoClose: ReviewAutoCloseState = INITIAL_REVIEW_AUTO_CLOSE_STATE;
  private readonly reviewClosureAttemptsByCorrId = new Map<string, InFlightReviewClosureAttempt>();
  private onPreloadedSessionOpened?: (payload: SessionOpenedPayload) => void;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    getArchState: () => ArchState,
    dispatchArch: (event: Event) => void,
    private readonly selectionRequestTimeoutMs = DEFAULT_SELECTION_REQUEST_TIMEOUT_MS,
  ) {
    this.getArchState = getArchState;
    this.dispatchArch = dispatchArch;
  }

  setPreloadedSessionOpenedHandler(handler: (payload: SessionOpenedPayload) => void): void {
    this.onPreloadedSessionOpened = handler;
  }

  markSessionSnapshotKnown(sessionPath: string): void {
    this.knownSnapshotSessionPaths.add(sessionPath);
  }

  markSessionRuntimeKnown(sessionPath: string): void {
    this.knownRuntimeSessionPaths.add(sessionPath);
  }

  isSessionSnapshotKnown(sessionPath: string): boolean {
    return this.knownSnapshotSessionPaths.has(sessionPath);
  }

  isSessionRuntimeKnown(sessionPath: string): boolean {
    return this.knownRuntimeSessionPaths.has(sessionPath);
  }

  getBackendGeneration(): number {
    return this.backendGeneration;
  }

  /** Reconcile the host fence to the generation acknowledged by the backend
   * spawn. This repairs failed setup attempts that advanced host lifecycle
   * state without actually starting a child process. */
  adoptBackendGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error('Backend generation must be a positive safe integer.');
    }
    this.backendGeneration = generation;
  }

  claimOperationalIncident(
    incidentId: string | undefined,
    requestId: string | undefined,
    backendGeneration = this.backendGeneration,
    dedupeKey?: string,
  ): boolean {
    const requestKey = requestId ? `request:${requestId}` : undefined;
    const canonicalIdentity = dedupeKey ?? incidentId ?? requestKey;
    const sharesRequestCondition = requestKey !== undefined
      && (canonicalIdentity === requestKey || (!dedupeKey && !incidentId));
    const identities = [
      canonicalIdentity,
      incidentId,
      ...(sharesRequestCondition ? [requestKey] : []),
    ].filter((identity): identity is string => !!identity)
      .map((identity) => `${backendGeneration}:${identity}`);
    if (identities.length === 0) return true;
    // Claim every alias atomically. A provider incident and the correlated
    // RPC/legacy error can have different incident IDs but share request:X.
    if (identities.some((key) => this.operationalIncidentKeys.has(key))) return false;
    for (const key of identities) this.operationalIncidentKeys.add(key);
    return true;
  }

  resetRuntimeState(options: { advanceBackendGeneration?: boolean } = {}): void {
    this.busySeqMap.clear();
    if (options.advanceBackendGeneration !== false) this.backendGeneration += 1;
    this.operationalIncidentKeys.clear();
    this.preloadGeneration += 1;
    for (const record of this.preloadRecordsByPath.values()) {
      record.cancelled = true;
      record.abortController.abort();
    }
    this.preloadQueue.length = 0;
    this.preloadRecordsByPath.clear();
    this.activePreloadRecord = undefined;
    this.preloadPumpScheduled = false;
    this.lifecycleQueue = Promise.resolve();
    this.foregroundLifecycleTasks = 0;
    this.lifecycleGeneration += 1;
    this.sessionOperationQueues.clear();
    for (const timer of this.selectionRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.selectionRequestTimers.clear();
    this.selectionRequests.clear();
    this.sessionDataEpochs.clear();
    this.knownSnapshotSessionPaths.clear();
    this.knownRuntimeSessionPaths.clear();
    this.suppressNextCompletionNotification.clear();
    this.requestSessionPathById.clear();
    this.transcriptTouchedAtBySession.clear();
    this.currentSelectionToken = null;
    this.reviewAutoClose = INITIAL_REVIEW_AUTO_CLOSE_STATE;
    this.reviewClosureAttemptsByCorrId.clear();
  }

  /** Claim pending/retrying explicit closure actions for this list refresh. */
  consumeReviewAutoCloseClosures(
    incoming: ReadonlyArray<{ path: string; closureActions?: readonly ClosureAction[] }>,
    openTabPaths: readonly string[],
    runningPaths: readonly string[],
  ): ReviewAutoCloseResult {
    const result = computeReviewAutoCloseClosures(this.reviewAutoClose, {
      incoming,
      openTabPaths,
      runningPaths,
    });
    this.reviewAutoClose = result.next;
    return result;
  }

  /** Register before dispatching the correlated CloseSession command so even
   *  immediately completing effects cannot outrun the outbox claim. */
  beginReviewClosureAttempt(corrId: string, attempt: ReviewAutoCloseAttempt): void {
    this.reviewClosureAttemptsByCorrId.set(corrId, {
      ...attempt,
      actions: [...attempt.actions],
      closeResultReceived: !attempt.requiresCloseCompletion,
      persistResultReceived: false,
      errors: [],
    });
  }

  /** Observe authoritative CQRS effect results. Idle/already-hidden targets
   *  require both cleanup and tab persistence; running targets are deliberate
   *  tab hides and require persistence only. */
  handleReviewClosureEffectResult(
    event: Extract<Event, { kind: 'CloseSessionResult' | 'PersistTabsResult' }>,
  ): void {
    const attempt = this.reviewClosureAttemptsByCorrId.get(event.corrId);
    if (!attempt) return;

    if (event.kind === 'CloseSessionResult') {
      if (!attempt.requiresCloseCompletion || attempt.closeResultReceived) return;
      attempt.closeResultReceived = true;
    } else {
      if (attempt.persistResultReceived) return;
      attempt.persistResultReceived = true;
    }
    if (!event.ok) attempt.errors.push(event.error ?? `${event.kind} failed`);

    if (!attempt.persistResultReceived || !attempt.closeResultReceived) return;
    this.reviewClosureAttemptsByCorrId.delete(event.corrId);

    if (this.getArchState().sessions.openTabPaths.includes(attempt.sessionPath)) {
      attempt.errors.push('The target tab remained open after the closure effects completed.');
    }
    this.persistReviewClosureAttempt(attempt);
  }

  private persistReviewClosureAttempt(attempt: InFlightReviewClosureAttempt): void {
    const reviewsDir = this.getReviewsDir();
    const failed = attempt.errors.length > 0;
    const timestamp = new Date().toISOString();
    const records: ClosureAction[] = attempt.actions.map((action) => {
      const nextAttempts = action.attempts + 1;
      if (failed && closureActionExhaustedRetries(nextAttempts)) {
        return { ...action, status: 'failed', attempts: nextAttempts, lastError: attempt.errors.join('; '), settledAt: timestamp };
      }
      if (failed) {
        return { ...action, status: 'retrying', attempts: nextAttempts, lastError: attempt.errors.join('; '), settledAt: undefined };
      }
      return { ...action, status: 'succeeded', attempts: nextAttempts, lastError: undefined, settledAt: timestamp };
    });

    try {
      if (!reviewsDir) throw new Error('review sidecar directory is unavailable');
      appendClosureActionRecords(reviewsDir, records);
      if (failed) {
        // Release claims only for actions that remain retryable; terminal
        // `failed` actions stay claimed so they are not re-attempted in this
        // runtime, and their durable status prevents reclaim after a crash.
        const retryable = records.filter((record) => record.status === 'retrying');
        if (retryable.length > 0) this.releaseReviewClosureActionClaims(retryable);
      }
    } catch (error) {
      this.releaseReviewClosureActionClaims(attempt.actions);
      auditLog('session-service', 'reviewClosure.settle.failed', {
        actionIds: attempt.actions.map((action) => action.actionId),
        message: toErrorMessage(error),
      });
    }
  }

  private getReviewsDir(): string | undefined {
    const explicitDir = process.env.PIE_REVIEWS_DIR?.trim();
    return explicitDir || resolveHostSessionStoragePaths(
      process.env.PI_CODING_AGENT_DIR,
      process.env.PI_CODING_AGENT_SESSION_DIR,
    ).reviewsDir;
  }

  private releaseReviewClosureActionClaims(actions: readonly ClosureAction[]): void {
    const claimedActionIds = new Set(this.reviewAutoClose.claimedActionIds);
    for (const action of actions) claimedActionIds.delete(action.actionId);
    this.reviewAutoClose = { claimedActionIds };
  }

  createPendingSessionPath(): string {
    this.pendingSessionCounter += 1;
    return `${PENDING_SESSION_PREFIX}${Date.now()}-${this.pendingSessionCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  beginSelectionRequest(
    requestedPath: string,
    pendingPath?: string,
    wasOpenTab = false,
    insertedPlaceholder = false,
    requestEpoch?: number,
    operationId?: string,
  ): string {
    this.selectionRequestCounter += 1;
    const token = `selection:${this.selectionRequestCounter}`;
    const archState = this.getArchState();
    this.selectionRequests.set(token, {
      insertedPlaceholder,
      token,
      requestedPath,
      pendingPath,
      previousActivePath: archState.sessions.activeSessionPath,
      wasOpenTab,
      requestEpoch,
      backendGeneration: this.backendGeneration,
      modelWriteFence: archState.settings.modelWriteFence,
      modelHydrationRevision: archState.settings.modelHydrationRevision,
      catalogHydrationRevision: archState.settings.modelHydrationRevisionBySession[requestedPath] ?? 0,
      operationId,
      operationAttempt: operationId ? 1 : undefined,
    });
    this.currentSelectionToken = token;
    this.armSelectionRequestTimeout(token);
    return token;
  }

  getSelectionRequest(selectionToken?: string): SelectionRequest | null {
    if (!selectionToken) {
      return null;
    }
    return this.selectionRequests.get(selectionToken) ?? null;
  }

  /** Capture model ownership when a queued lifecycle RPC actually starts.
   * Retry attempts retain independent fences so a late attempt-N event cannot
   * borrow attempt N+1's freshness. */
  captureSelectionRequestStart(selectionToken: string, operationAttempt?: number): void {
    const request = this.selectionRequests.get(selectionToken);
    if (!request) return;
    const archState = this.getArchState();
    const fences = {
      backendGeneration: this.backendGeneration,
      modelWriteFence: archState.settings.modelWriteFence,
      modelHydrationRevision: archState.settings.modelHydrationRevision,
      catalogHydrationRevision: archState.settings.modelHydrationRevisionBySession[request.requestedPath] ?? 0,
    };
    Object.assign(request, fences);
    if (operationAttempt !== undefined) {
      request.modelFencesByOperationAttempt = {
        ...request.modelFencesByOperationAttempt,
        [operationAttempt]: fences,
      };
    }
  }

  isCurrentSelectionToken(selectionToken?: string): boolean {
    return !!selectionToken && this.currentSelectionToken === selectionToken;
  }

  /**
   * Relinquish focus ownership from any in-flight create/open without deleting
   * its request record. The stale operation still owns cleanup and cache
   * refresh, but its eventual session.opened payload cannot steal selection.
   */
  supersedeSelectionOwnership(): void {
    this.currentSelectionToken = null;
  }

  finishSelectionRequest(selectionToken?: string): void {
    if (!selectionToken) {
      return;
    }

    this.clearSelectionRequestTimeout(selectionToken);
    this.selectionRequests.delete(selectionToken);
    if (this.currentSelectionToken === selectionToken) {
      this.currentSelectionToken = null;
    }
  }

  clearSelectionRequestsForPath(sessionPath: string): void {
    const tokensToClear: string[] = [];
    for (const [token, request] of this.selectionRequests) {
      // Either side of the request can match the closing session — both must
      // result in deleting the entry so it can't outlive the session and
      // re-fire later (B4 cross-session bleed).
      if (request.pendingPath === sessionPath || request.requestedPath === sessionPath) {
        tokensToClear.push(token);
      }
    }

    for (const token of tokensToClear) {
      this.finishSelectionRequest(token);
    }
  }

  private armSelectionRequestTimeout(selectionToken: string): void {
    if (this.selectionRequestTimeoutMs <= 0) {
      return;
    }

    this.clearSelectionRequestTimeout(selectionToken);
    const timer = setTimeout(() => {
      if (!this.selectionRequests.has(selectionToken)) {
        return;
      }

      const request = this.selectionRequests.get(selectionToken);
      if (request?.operationId) {
        const operation = this.getArchState().operations[request.operationId];
        if (request.pendingPath) {
          this.handleCreateOperationDelayed(
            selectionToken,
            request.operationId,
            `Timed out waiting to create session. The session is still being created; retry or wait for completion.`,
          );
          return;
        }
        if (operation?.kind === 'session.open') {
          this.dispatchArch({
            kind: 'OpenSessionResult',
            corrId: `open-timeout:${request.operationId}`,
            sessionPath: request.requestedPath,
            operationId: request.operationId,
            operationAttempt: request.operationAttempt,
            backendGeneration: request.backendGeneration,
            ok: false,
            ambiguous: true,
            error: 'session.open acknowledgement timed out',
          });
          return;
        }
      }
      const action = request?.pendingPath ? 'create session' : 'open session';
      this.handleSelectionFailure(
        selectionToken,
        `Timed out waiting to ${action}. Please try again.`,
      );
    }, this.selectionRequestTimeoutMs);

    this.selectionRequestTimers.set(selectionToken, timer);
  }

  private clearSelectionRequestTimeout(selectionToken: string): void {
    const timer = this.selectionRequestTimers.get(selectionToken);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.selectionRequestTimers.delete(selectionToken);
  }

  handleCreateOperationAcknowledged(selectionToken: string, operationId: string, sessionPath: string): string | undefined {
    const operation = this.getArchState().operations[operationId];
    if (!operation
      || operation.causal.selectionToken !== selectionToken
      || operation.terminal) return undefined;
    const request = this.selectionRequests.get(selectionToken);
    const attempt = request?.operationAttempt ?? operation.attempt;
    const backendGeneration = request?.modelFencesByOperationAttempt?.[attempt]?.backendGeneration
      ?? request?.backendGeneration
      ?? this.backendGeneration;
    this.dispatchArch({
      kind: 'CreateOperationSucceeded',
      operationId,
      pendingPath: operation.session.pendingPath,
      sessionPath,
      attempt,
      backendGeneration,
    });
    this.dispatchArch({
      kind: 'PendingPathReplaced',
      oldPendingPath: operation.session.pendingPath,
      newSessionPath: sessionPath,
    });
    // Keep the request-start hydration fences until a trailing session.opened
    // snapshot arrives. The backend writer prioritizes correlated responses,
    // so dropping the request here would make the normal subsequent event look
    // unsolicited and incorrectly discard its authoritative model metadata.
    this.clearSelectionRequestTimeout(selectionToken);
    this.clearSessionScope(operation.session.pendingPath, true);
    this.scheduleRender();
    return operation.session.pendingPath;
  }

  handleCreateOperationDelayed(selectionToken: string, operationId: string, notice: string, expectedAttempt?: number): void {
    const request = this.selectionRequests.get(selectionToken);
    if (!request || request.operationId !== operationId || !request.pendingPath) return;
    const operation = this.getArchState().operations[operationId];
    if (!operation || operation.terminal) return;
    if (expectedAttempt !== undefined && operation.attempt !== expectedAttempt) return;
    const ownsSelection = this.currentSelectionToken === selectionToken;
    this.clearSelectionRequestTimeout(selectionToken);
    this.dispatchArch({
      kind: 'CreateOperationDelayed',
      operationId,
      pendingPath: request.pendingPath,
      selectionToken,
      attempt: operation.attempt,
      backendGeneration: request.modelFencesByOperationAttempt?.[operation.attempt]?.backendGeneration
        ?? request.backendGeneration,
      notice,
      ownsSelection,
    });
    this.scheduleRender();
  }

  /** Re-arm the local waiter for a delayed create without minting a new
   * operation identity, pending path, or selection token. */
  retryCreateOperation(operationId: string): boolean {
    const operation = this.getArchState().operations[operationId];
    if (!operation || operation.phase !== 'ambiguous' || operation.terminal) return false;
    const request = this.selectionRequests.get(operation.causal.selectionToken);
    if (!request) return false;
    request.operationAttempt = operation.attempt + 1;
    this.armSelectionRequestTimeout(operation.causal.selectionToken);
    return true;
  }

  /** Resolve every non-terminal message mutation owned by a dead backend
   * generation. Send retains its exact optimistic rollback path; compound edit
   * preserves unknown commit authority, and the rowless operations terminalize
   * through their shared status path. */
  failPendingSendOperations(notice: string): void {
    const operations = Object.values(this.getArchState().operations).filter(
      (operation) => operation.kind.startsWith('message.')
        && !operation.terminal
        && operation.backendGeneration === this.backendGeneration,
    );
    for (const operation of operations) {
      const sessionPath = operation.session.resolvedPath ?? operation.session.pendingPath;
      if (operation.kind === 'message.edit' || operation.kind === 'message.interrupt'
        || operation.kind === 'message.continue' || operation.kind === 'message.compact') {
        this.dispatchArch({
          kind: 'MessageOperationStatus', operationId: operation.operationId,
          operationKind: operation.kind, sessionPath,
          backendGeneration: operation.backendGeneration,
          state: 'generation-ended', error: notice,
        });
        continue;
      }
      if (operation.kind !== 'message.send') continue;
      const pending = this.getArchState().pending.ops[operation.causal.selectionToken]
        ?? this.getArchState().pending.promoted[operation.causal.selectionToken];
      this.dispatchArch({
        kind: 'SendOperationStatus', operationId: operation.operationId,
        sessionPath, backendGeneration: operation.backendGeneration,
        state: 'generation-ended', error: notice,
      });
      if (pending) {
        this.dispatchArch({
          kind: 'PreflightFailed', corrId: operation.causal.selectionToken,
          operationId: operation.operationId,
          sessionPath: pending.sessionPath, requestId: pending.requestId ?? '', error: notice,
        });
      }
    }
  }

  /** Generation death is the one non-RPC path allowed to definitively clean up
   * delayed creates. Each operation is routed through the same idempotent
   * failure path so unrelated sessions cannot be torn down. */
  failPendingCreateOperations(notice: string): void {
    const tokens = [...this.selectionRequests.values()]
      .filter((request) => request.operationId && request.pendingPath)
      .map((request) => request.token);
    for (const token of tokens) {
      this.handleSelectionFailure(token, notice, undefined, 'backend-generation-ended');
    }
  }

  handleSelectionFailure(
    selectionToken: string,
    notice: string,
    expectedAttempt?: number,
    reason: 'definitive-rejection' | 'backend-generation-ended' = 'definitive-rejection',
  ): void {
    const request = this.selectionRequests.get(selectionToken);
    const operation = request?.operationId
      ? this.getArchState().operations[request.operationId]
      : undefined;
    // A matching session.opened may have won the race with a late RPC error.
    // Its durable success is authoritative; never roll the resolved session
    // back because a local waiter settled afterward.
    if (operation?.terminal?.outcome === 'settled') {
      this.finishSelectionRequest(selectionToken);
      return;
    }
    if (operation && expectedAttempt !== undefined && operation.attempt !== expectedAttempt) {
      return;
    }
    const ownsSelection = this.currentSelectionToken === selectionToken;
    if (operation && !operation.terminal) {
      const attempt = request?.operationAttempt ?? operation.attempt;
      this.dispatchArch({
        kind: 'CreateOperationFailed',
        operationId: operation.operationId,
        pendingPath: operation.session.pendingPath,
        error: notice,
        attempt,
        backendGeneration: request?.modelFencesByOperationAttempt?.[attempt]?.backendGeneration
          ?? request?.backendGeneration,
        reason,
      });
    }
    bootLog('session-state', 'selection.failed', {
      notice,
      ownsSelection,
      pendingPath: request?.pendingPath ?? null,
      previousActivePath: request?.previousActivePath ?? null,
      requestedPath: request?.requestedPath ?? null,
      selectionToken,
      wasOpenTab: request?.wasOpenTab ?? null,
    });
    this.finishSelectionRequest(selectionToken);

    if (request) {
      if (request.pendingPath) {
        this.clearSessionScope(request.pendingPath, true);
      } else if (!request.wasOpenTab) {
        this.dispatchArch({
          kind: 'Command',
          cmd: { kind: 'CloseTab', corrId: `close:${Date.now()}`, sessionPath: request.requestedPath },
        });
        this.clearSessionScope(request.requestedPath, request.insertedPlaceholder);
      }

      if (ownsSelection) {
        const archState = this.getArchState();
        const fallbackPath = request.previousActivePath && archState.sessions.openTabPaths.includes(request.previousActivePath)
          ? request.previousActivePath
          : archState.sessions.openTabPaths[0] ?? null;
        bootLog('session-service', 'selection.fallback', {
          notice,
          previousActivePath: request.previousActivePath ?? null,
          fallbackPath,
          openTabPaths: archState.sessions.openTabPaths,
          currentActivePath: archState.sessions.activeSessionPath,
        });
        if (fallbackPath) {
          this.dispatchArch({
            kind: 'Command',
            cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: fallbackPath },
          });
        } else {
          this.dispatchArch({
            kind: 'Command',
            cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: '' },
          });
        }
      }
      const archState = this.getArchState();
      this.dispatchArch({
        kind: 'Command',
        cmd: {
          kind: 'PersistTabs',
          corrId: `persist:${Date.now()}`,
          openTabPaths: archState.sessions.openTabPaths,
          activeSessionPath: archState.sessions.activeSessionPath,
          pinnedTabPaths: archState.sessions.pinnedTabPaths,
          pinnedTabGroups: archState.sessions.pinnedTabGroups,
        },
      });
    }

    // A superseded request still owns its operation cleanup, but it no longer
    // owns user-visible selection state. Surfacing its timeout/rejection would
    // overwrite the current tab with a stale global notice (for example, when
    // rapid tab switches queue multiple slow session.open calls).
    if (ownsSelection) {
      this.dispatchArch({ kind: 'NoticeShown', notice });
    }
    this.assertSelectionInvariant('handleSelectionFailure');
    this.scheduleRender();
  }

  enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    this.foregroundLifecycleTasks += 1;
    const lifecycleGeneration = this.lifecycleGeneration;
    // Foreground work fences an already-admitted preload immediately. Aborting
    // only rejects the host waiter; the active slot remains occupied until the
    // backend transport response arrives.
    this.fenceActivePreload();
    const next = this.lifecycleQueue.catch(() => undefined).then(() => {
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw new LifecycleTaskStaleGenerationError();
      }
      return task();
    });
    this.lifecycleQueue = next.then(() => undefined, () => undefined);
    const settleForegroundLifecycle = (): void => {
      if (lifecycleGeneration !== this.lifecycleGeneration) return;
      this.foregroundLifecycleTasks -= 1;
      this.schedulePreloadPump();
    };
    void next.then(settleForegroundLifecycle, settleForegroundLifecycle);
    return next;
  }

  enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
    // Send/edit reducers mark the session running before their effect reaches
    // this queue, so fence active background application at generation start
    // rather than waiting for the first backend busy event.
    if (this.getArchState().sessions.runningSessionPaths.length > 0) {
      this.fenceActivePreload();
    }
    const operationGeneration = this.lifecycleGeneration;
    const previous = this.sessionOperationQueues.get(sessionPath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      // Clearing the queue map on restart does not cancel promise
      // continuations that were already chained. Fence them explicitly so an
      // old-generation model/send/edit mutation cannot run against the fresh
      // backend alongside a replacement-generation queue.
      if (operationGeneration !== this.lifecycleGeneration) {
        throw new LifecycleTaskStaleGenerationError();
      }
      return task();
    });
    const barrier = result.then(() => undefined, () => undefined);

    this.sessionOperationQueues.set(sessionPath, barrier);
    void barrier.finally(() => {
      if (this.sessionOperationQueues.get(sessionPath) === barrier) {
        this.sessionOperationQueues.delete(sessionPath);
      }
      // RPC failures can clear the authoritative running marker without a
      // separate busy=false event. Re-check here after the reducer's result
      // dispatch so queued preloads cannot remain stranded behind a failed
      // send/edit/interrupt operation.
      this.schedulePreloadPump();
    });

    return result;
  }

  getSessionDataEpoch(sessionPath: string): number {
    return this.sessionDataEpochs.get(sessionPath) ?? 0;
  }

  bumpSessionDataEpoch(sessionPath: string): number {
    const next = this.getSessionDataEpoch(sessionPath) + 1;
    this.sessionDataEpochs.set(sessionPath, next);
    return next;
  }

  bindRequestSessionPath(requestId: string, sessionPath: string): void {
    this.requestSessionPathById.set(requestId, sessionPath);
  }

  unbindRequestSessionPath(requestId: string): void {
    this.requestSessionPathById.delete(requestId);
  }

  resolveRequestSessionPath(requestId: string | undefined): string | undefined {
    return requestId ? this.requestSessionPathById.get(requestId) : undefined;
  }

  acceptBusySeq(sessionPath: string, seq: number | undefined): boolean {
    if (typeof seq !== 'number') {
      return true;
    }

    const last = this.busySeqMap.get(sessionPath) ?? 0;
    if (seq <= last) {
      return false;
    }
    this.busySeqMap.set(sessionPath, seq);
    return true;
  }

  suppressNextCompletionNotificationFor(sessionPath: string): void {
    this.suppressNextCompletionNotification.add(sessionPath);
  }

  clearCompletionSuppression(sessionPath: string): void {
    this.suppressNextCompletionNotification.delete(sessionPath);
  }

  consumeCompletionSuppression(sessionPath: string): boolean {
    return this.suppressNextCompletionNotification.delete(sessionPath);
  }

  touchSessionTranscript(sessionPath: string): void {
    this.transcriptTouchedAtBySession.set(sessionPath, Date.now());
  }

  evictInactiveTranscriptWindows(): void {
    const archState = this.getArchState();
    const activeSessionPath = archState.sessions.activeSessionPath;
    const runningPaths = new Set(archState.sessions.runningSessionPaths);
    const now = Date.now();

    const inactivePaths = archState.sessions.openTabPaths
      .filter((sessionPath) => (
        !!sessionPath
        && sessionPath !== activeSessionPath
        && !isPendingTabPath(sessionPath)
        && !runningPaths.has(sessionPath)
      ))
      .sort((left, right) => (
        (this.transcriptTouchedAtBySession.get(right) ?? 0)
        - (this.transcriptTouchedAtBySession.get(left) ?? 0)
      ));

    const warmKeepCount = 1;

    inactivePaths.forEach((sessionPath, index) => {
      const transcript = this.getArchState().transcript.bySession[sessionPath] ?? [];
      if (transcript.length === 0) {
        return;
      }

      const touchedAt = this.transcriptTouchedAtBySession.get(sessionPath) ?? 0;
      const staleByTtl = now - touchedAt >= TRANSCRIPT_WINDOW_BUDGETS.inactiveTtlMs;
      const shouldTrimTail = transcript.length > TRANSCRIPT_WINDOW_BUDGETS.inactiveTailCount;
      if (!shouldTrimTail) {
        return;
      }
      if (!staleByTtl && index < warmKeepCount) {
        return;
      }

      const transcriptWindow = this.getArchState().transcript.windowBySession[sessionPath];
      if (!transcriptWindow) {
        return;
      }

      this.dispatchArch({
        kind: 'TranscriptTrimmed',
        sessionPath,
        transcript: transcript.slice(-TRANSCRIPT_WINDOW_BUDGETS.inactiveTailCount),
        transcriptWindow: {
          ...transcriptWindow,
          loadedStart: transcriptWindow.totalCount - TRANSCRIPT_WINDOW_BUDGETS.inactiveTailCount,
          hasOlder: true,
          hasNewer: false,
          isPartial: true,
        },
      });
    });
  }

  clearSessionScope(sessionPath: string, removeSessionSummary = false): void {
    this.cancelPreload(sessionPath);
    this.busySeqMap.delete(sessionPath);
    this.sessionOperationQueues.delete(sessionPath);
    this.sessionDataEpochs.delete(sessionPath);
    this.knownSnapshotSessionPaths.delete(sessionPath);
    this.knownRuntimeSessionPaths.delete(sessionPath);
    this.suppressNextCompletionNotification.delete(sessionPath);
    this.transcriptTouchedAtBySession.delete(sessionPath);
    for (const [requestId, mappedSessionPath] of this.requestSessionPathById) {
      if (mappedSessionPath === sessionPath) {
        this.requestSessionPathById.delete(requestId);
      }
    }
    this.dispatchArch({
      kind: 'SessionScopeCleared',
      sessionPath,
      removeSessionSummary,
    });
  }

  assertSelectionInvariant(source: string): void {
    const archState = this.getArchState();
    const activeSessionPath = archState.sessions.activeSessionPath;
    assertInvariant(
      'session-service',
      !activeSessionPath || archState.sessions.openTabPaths.includes(activeSessionPath),
      'Active session path must always reference an open tab.',
      {
        activeSessionPath,
        openTabPaths: archState.sessions.openTabPaths,
        source,
      },
    );
  }

  isActiveSession(sessionPath: string): boolean {
    return this.getArchState().sessions.activeSessionPath === sessionPath;
  }

  preloadSessions(sessionPaths: readonly string[]): void {
    for (const sessionPath of sessionPaths) {
      this.preloadSession(sessionPath);
    }
  }

  /** Remove a background preload from the queue, or abort it when it is
   * already in flight. Foreground selection calls this before it creates its
   * selection request, so a stale preload cannot apply a payload to the newly
   * selected session. */
  cancelPreload(sessionPath: string): void {
    const record = this.preloadRecordsByPath.get(sessionPath);
    if (!record) return;

    record.cancelled = true;
    record.abortController.abort();
    // BackendClient cancellation is local: retain an in-flight record as the
    // single background transport slot until its correlated response (or
    // backend shutdown) settles. Queued records can be discarded immediately.
    if (this.activePreloadRecord !== record) {
      this.preloadRecordsByPath.delete(sessionPath);
    }
    this.schedulePreloadPump();
  }

  /** Called after the authoritative host running/busy state changes. */
  resumePreloads(): void {
    if (this.getArchState().sessions.runningSessionPaths.length > 0) {
      this.fenceActivePreload();
    }
    this.schedulePreloadPump();
  }

  preloadSession(sessionPath: string): void {
    if (!sessionPath || isPendingTabPath(sessionPath)) {
      return;
    }

    if (this.preloadRecordsByPath.has(sessionPath)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.getArchState().transcript.bySession, sessionPath)) {
      return;
    }

    const record: PreloadRecord = {
      id: ++this.preloadRecordCounter,
      generation: this.preloadGeneration,
      sessionPath,
      requestEpoch: this.getSessionDataEpoch(sessionPath),
      abortController: new AbortController(),
      cancelled: false,
      transportSettled: false,
      hostWaiterSettled: false,
    };
    this.preloadRecordsByPath.set(sessionPath, record);
    this.preloadQueue.push(record);
    // Defer the first pump. In startup, openSession dispatches its lifecycle
    // effect before publishBackendReady enqueues background preloads; this
    // makes the foreground session.open dispatch the first backend operation.
    this.schedulePreloadPump();
  }

  private schedulePreloadPump(): void {
    if (this.preloadPumpScheduled) return;
    this.preloadPumpScheduled = true;
    void Promise.resolve().then(() => {
      this.preloadPumpScheduled = false;
      this.pumpPreloads();
    });
  }

  private pumpPreloads(): void {
    if (this.foregroundLifecycleTasks > 0
      || this.activePreloadRecord
      || this.getArchState().sessions.runningSessionPaths.length > 0) {
      return;
    }

    while (this.preloadQueue.length > 0) {
      const record = this.preloadQueue.shift();
      if (!record || !this.isCurrentPreloadRecord(record)) continue;
      this.activePreloadRecord = record;
      void this.runPreload(record);
      return;
    }
  }

  private isCurrentPreloadRecord(record: PreloadRecord): boolean {
    return !record.cancelled
      && record.generation === this.preloadGeneration
      && this.preloadRecordsByPath.get(record.sessionPath) === record;
  }

  private fenceActivePreload(): void {
    const record = this.activePreloadRecord;
    if (!record || record.cancelled) return;
    record.cancelled = true;
    // Abort fences payload application immediately, but BackendClient retains
    // transport settlement bookkeeping because JSON-RPC has no request-cancel
    // frame. `handlePreloadTransportSettled` alone releases the active slot.
    record.abortController.abort();
  }

  private handlePreloadTransportSettled(record: PreloadRecord): void {
    if (record.transportSettled) return;
    record.transportSettled = true;
    // Keep the record active through the host promise continuation as well as
    // the physical response. This closes the response-to-application microtask
    // window in which newly-started generation must still be able to fence it.
    this.releasePreloadRecordIfSettled(record);
  }

  private releasePreloadRecordIfSettled(record: PreloadRecord): void {
    if (!record.transportSettled || !record.hostWaiterSettled) return;
    if (this.activePreloadRecord === record) {
      this.activePreloadRecord = undefined;
    }
    if (this.preloadRecordsByPath.get(record.sessionPath) === record) {
      this.preloadRecordsByPath.delete(record.sessionPath);
    }
    this.schedulePreloadPump();
  }

  private async runPreload(record: PreloadRecord): Promise<void> {
    try {
      const payload = await this.backend.request<SessionOpenedPayload>(
        'session.preload',
        { sessionPath: record.sessionPath },
        {
          signal: record.abortController.signal,
          onTransportSettled: () => this.handlePreloadTransportSettled(record),
        },
      );
      if (!this.isCurrentPreloadRecord(record)) return;
      if (this.getSessionDataEpoch(record.sessionPath) !== record.requestEpoch) return;
      if (!this.getArchState().sessions.openTabPaths.includes(record.sessionPath)) return;
      this.onPreloadedSessionOpened?.(payload);
    } catch (error) {
      // Cancellation and stale generations are expected during selection,
      // close, generation, and restart. The transport-settlement callback,
      // rather than this local waiter, releases the single-flight slot.
      if (this.isCurrentPreloadRecord(record)) {
        auditLog('session-service', 'session.preload.failed', {
          sessionPath: record.sessionPath,
          message: toErrorMessage(error),
        });
      }
    } finally {
      record.hostWaiterSettled = true;
      this.releasePreloadRecordIfSettled(record);
    }
  }
}
