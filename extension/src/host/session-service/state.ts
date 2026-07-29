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
const DEFAULT_SELECTION_REQUEST_TIMEOUT_MS = 60_000;

interface InFlightReviewClosureAttempt extends ReviewAutoCloseAttempt {
  closeResultReceived: boolean;
  persistResultReceived: boolean;
  errors: string[];
}

export class SessionServiceState {
  private readonly busySeqMap = new Map<string, number>();
  private lifecycleQueue = Promise.resolve();
  private readonly sessionOperationQueues = new Map<string, Promise<void>>();
  private readonly selectionRequests = new Map<string, SelectionRequest>();
  private readonly selectionRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionDataEpochs = new Map<string, number>();
  private readonly preloadingSessionPaths = new Set<string>();
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

  resetRuntimeState(): void {
    this.busySeqMap.clear();
    this.lifecycleQueue = Promise.resolve();
    this.sessionOperationQueues.clear();
    for (const timer of this.selectionRequestTimers.values()) {
      clearTimeout(timer);
    }
    this.selectionRequestTimers.clear();
    this.selectionRequests.clear();
    this.sessionDataEpochs.clear();
    this.preloadingSessionPaths.clear();
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

  isCurrentSelectionToken(selectionToken?: string): boolean {
    return !!selectionToken && this.currentSelectionToken === selectionToken;
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

  handleSelectionFailure(selectionToken: string, notice: string): void {
    const request = this.selectionRequests.get(selectionToken);
    const ownsSelection = this.currentSelectionToken === selectionToken;
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
    const next = this.lifecycleQueue.catch(() => undefined).then(task);
    this.lifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionPath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const barrier = result.then(() => undefined, () => undefined);

    this.sessionOperationQueues.set(sessionPath, barrier);
    void barrier.finally(() => {
      if (this.sessionOperationQueues.get(sessionPath) === barrier) {
        this.sessionOperationQueues.delete(sessionPath);
      }
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
    this.busySeqMap.delete(sessionPath);
    this.sessionOperationQueues.delete(sessionPath);
    this.sessionDataEpochs.delete(sessionPath);
    this.preloadingSessionPaths.delete(sessionPath);
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

  preloadSession(sessionPath: string): void {
    if (!sessionPath || isPendingTabPath(sessionPath)) {
      return;
    }

    if (this.preloadingSessionPaths.has(sessionPath)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.getArchState().transcript.bySession, sessionPath)) {
      return;
    }

    this.preloadingSessionPaths.add(sessionPath);
    const requestEpoch = this.getSessionDataEpoch(sessionPath);
    void this.backend.request<SessionOpenedPayload>('session.preload', { sessionPath })
      .then((payload) => {
        if (this.getSessionDataEpoch(sessionPath) !== requestEpoch) {
          return;
        }
        if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
          return;
        }
        this.onPreloadedSessionOpened?.(payload);
      })
      .catch((error) => {
        auditLog('session-service', 'session.preload.failed', {
          sessionPath,
          message: toErrorMessage(error),
        });
      })
      .finally(() => {
        this.preloadingSessionPaths.delete(sessionPath);
      });
  }
}
