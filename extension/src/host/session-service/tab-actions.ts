import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import { type RunObserver } from '../stats-service';
import { auditLog, bootLog } from '../util/audit';
import {
  isPendingTabPath,
} from '../../shared/tab-behavior';
import { toErrorMessage } from '../../shared/error-message';
import type { RendererCommandContext, SessionSummary } from '../../shared/protocol';
import { operationSourceFromRenderer } from '../core/operation-types.js';
import type { ScheduleRender } from './types';
import { SessionServiceState } from './state';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

interface SessionTabActionsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  runObserver: RunObserver;
  state: SessionServiceState;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  /** Runtime-free backend notification for host-local visual transitions. */
  notifySessionViewed?: (
    sessionPath: string,
    previousSessionPath: string | null,
  ) => Promise<unknown>;
}

export class SessionTabActions {
  private readonly context: vscode.ExtensionContext;
  private readonly scheduleRender: ScheduleRender;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;
  private readonly notifySessionViewed?: SessionTabActionsOptions['notifySessionViewed'];
  private visualTransitionEpoch = 0;

  constructor(options: SessionTabActionsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.runObserver = options.runObserver;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.dispatchArch = options.dispatchArch;
    this.notifySessionViewed = options.notifySessionViewed;
  }

  private notifyViewedTransition(
    sessionPath: string,
    previousSessionPath: string | null,
    transitionEpoch: number,
  ): void {
    if (!this.notifySessionViewed) return;
    const resolvedPreviousSessionPath = previousSessionPath && !isPendingTabPath(previousSessionPath)
      ? previousSessionPath
      : null;
    let request: Promise<unknown>;
    try {
      // BackendClient writes the JSONL request before returning this promise,
      // preserving click→execute order without awaiting backend work or
      // delaying the local visual selection.
      request = this.notifySessionViewed(sessionPath, resolvedPreviousSessionPath);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.catch((error) => {
      auditLog('session-service', 'session.viewed.failed', {
        sessionPath,
        previousSessionPath: resolvedPreviousSessionPath,
        message: toErrorMessage(error),
      });
      // Selection remains host-authoritative. Surface only a still-current
      // failure; a stale rejection from an older click must not replace the
      // notice belonging to a newer tab.
      if (this.visualTransitionEpoch === transitionEpoch
        && this.getArchState().sessions.activeSessionPath === sessionPath) {
        this.dispatchArch({
          kind: 'NoticeShown',
          notice: `Conversation selected, but backend view tracking failed: ${toErrorMessage(error)}`,
        });
        this.scheduleRender();
      }
    });
  }

  createNewSession(source?: RendererCommandContext): string {
    // Host-side entry: generate the impure bits the reducer can't (pending
    // path counter + Date.now/Math.random, placeholder modifiedAt, and the
    // selection token), then dispatch the CreateSession Command. The reducer
    // owns the optimistic tab setup (placeholder summary, tab open, select,
    // running state, active-run summary) and emits PersistTabs + CreateSession;
    // the runner owns the backend session.create RPC + failure recovery.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the create) so failure
    // recovery can restore it. The reducer synchronously sets activeSessionPath
    // = pending during the dispatch, so calling beginSelectionRequest after
    // would snapshot the pending path instead. Returns the pending path
    // synchronously so the composer fallback caller can address the new
    // session immediately.
    const pendingPath = this.state.createPendingSessionPath();
    const operationId = crypto.randomUUID();
    this.visualTransitionEpoch += 1;
    const cwd = this.getArchState().sessions.workspaceCwd ?? '';
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath, false, false, undefined, operationId);

    const configuredModel = this.getArchState().settings.modelSettings;
    const placeholderSummary: SessionSummary = {
      path: pendingPath,
      name: 'New Session',
      cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      modelId: configuredModel?.defaultModel,
      provider: configuredModel?.defaultProvider,
      thinkingLevel: configuredModel?.defaultThinkingLevel,
      isPlaceholder: true,
    };

    auditLog('session-service', 'session.create.requested', {
      cwd,
      pendingPath,
      selectionToken,
      operationId,
    });

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'CreateSession',
        corrId: crypto.randomUUID(),
        sessionPath: pendingPath,
        cwd,
        placeholderSummary,
        selectionToken,
        operationId,
        operationSource: operationSourceFromRenderer(source),
        backendGeneration: this.state.getBackendGeneration(),
      },
    });
    this.scheduleRender();

    return pendingPath;
  }

  openSession(sessionPath: string, source?: RendererCommandContext, causalParentOperationId?: string): void {
    const transitionEpoch = this.getArchState().sessions.activeSessionPath !== sessionPath
      ? ++this.visualTransitionEpoch
      : this.visualTransitionEpoch;
    // Pending paths are host-only sentinels. A tab click may race the
    // create/duplicate response; select the existing optimistic tab, but never
    // pass its sentinel to session.open. The SDK would otherwise normalize it
    // against cwd and turn it into a durable-looking pseudo-path.
    if (isPendingTabPath(sessionPath)) {
      if (this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
        this.dispatchArch({
          kind: 'Command',
          cmd: {
            kind: 'SelectSession',
            corrId: crypto.randomUUID(),
            sessionPath,
          },
        });
      } else {
        this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot open: the session is still being created.' });
      }
      this.scheduleRender();
      return;
    }

    // A foreground selection has priority over restored/background hydration.
    // Cancel both queued and in-flight preload work for this path before the
    // new selection epoch is minted; the preload record fence suppresses any
    // stale session.opened payload that resolves later.
    this.state.cancelPreload(sessionPath);

    // Host-side entry: generate the impure bits the reducer can't (the data
    // epoch + Date.now placeholder modifiedAt + the selection token), then
    // dispatch the OpenSession Command. The reducer owns the optimistic tab
    // setup (placeholder summary, tab open, select, unread-finished clear) and
    // emits PersistTabs + OpenSession; the runner owns the backend session.open
    // RPC + failure recovery.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the open) so failure recovery
    // can restore it. The reducer synchronously sets activeSessionPath =
    // sessionPath during the dispatch, so calling beginSelectionRequest after
    // would snapshot the opened path instead. The epoch is bumped before the
    // token so attach.ts can detect stale session.opened payloads for this
    // open. Mirrors createNewSession.
    const archState = this.getArchState();
    const existing = archState.sessions.sessions.find((s) => s.path === sessionPath);
    const wasOpenTab = archState.sessions.openTabPaths.includes(sessionPath);
    const transcriptLoaded = Object.prototype.hasOwnProperty.call(
      archState.transcript.windowBySession,
      sessionPath,
    );

    // Fast path for an already-open, host-hydrated tab. Selection is entirely
    // host-owned, and background backend events are explicitly session-scoped,
    // so reopening the backend runtime and rebuilding metadata is unnecessary
    // for an ordinary tab click. This also keeps rapid clicks out of the global
    // create/open lifecycle FIFO.
    if (
      wasOpenTab
      && existing
      && !existing.isPlaceholder
      && transcriptLoaded
      && this.state.isSessionSnapshotKnown(sessionPath)
    ) {
      // A previous cold open may still be queued/in flight. Keep its request
      // record for operation cleanup, but revoke its right to reactivate that
      // older target when session.opened eventually arrives.
      this.state.supersedeSelectionOwnership();
      if (archState.sessions.activeSessionPath !== sessionPath) {
        const previousSessionPath = archState.sessions.activeSessionPath;
        const corrId = crypto.randomUUID();
        this.dispatchArch({
          kind: 'Command',
          cmd: { kind: 'SelectSession', corrId, sessionPath },
        });
        this.notifyViewedTransition(sessionPath, previousSessionPath, transitionEpoch);
        this.dispatchArch({
          kind: 'Command',
          cmd: {
            kind: 'PersistTabs',
            corrId,
            openTabPaths: archState.sessions.openTabPaths,
            activeSessionPath: sessionPath,
            pinnedTabPaths: archState.sessions.pinnedTabPaths,
            pinnedTabGroups: archState.sessions.pinnedTabGroups,
          },
        });
      }
      this.state.touchSessionTranscript(sessionPath);
      this.state.evictInactiveTranscriptWindows();
      this.scheduleRender();
      bootLog('session-tabs', 'session.select.warm', { sessionPath });
      return;
    }

    const requestEpoch = this.state.bumpSessionDataEpoch(sessionPath);
    const operationId = crypto.randomUUID();
    const selectionToken = this.state.beginSelectionRequest(
      sessionPath,
      undefined,
      wasOpenTab,
      !existing,
      requestEpoch,
      operationId,
    );

    auditLog('session-service', 'session.open.requested', {
      selectionToken,
      sessionPath,
    });

    bootLog('session-tabs', 'session.open.requested', {
      selectionToken,
      sessionPath,
      wasOpenTab,
      hadExistingSummary: !!existing,
    });

    const placeholderSummary: SessionSummary | null = existing
      ? null
      : {
        path: sessionPath,
        name: 'Loading...',
        isPlaceholder: true,
        cwd: archState.sessions.workspaceCwd ?? '',
        modifiedAt: new Date().toISOString(),
        messageCount: 0,
      };

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'OpenSession',
        corrId: crypto.randomUUID(),
        sessionPath,
        placeholderSummary,
        selectionToken,
        operationId,
        operationAttempt: 1,
        operationSource: operationSourceFromRenderer(source),
        causalParentOperationId,
        backendGeneration: this.state.getBackendGeneration(),
      },
    });

    // Host-side transcript-window LRU: touch the opened session + evict inactive
    // windows. Stays host-side rather than reading reducer state from the session service.
    this.state.touchSessionTranscript(sessionPath);
    this.state.evictInactiveTranscriptWindows();
    this.scheduleRender();
  }

  async closeSession(
    sessionPath: string,
    nextPath: string | null,
    selectionChanged = false,
    causalParentOperationId?: string,
  ): Promise<void> {
    // Thin host-side cleanup — the reducer already did the tab-close +
    // per-session map clearing + select-next-tab (via the CloseSession Command
    // handler, which computed nextPath and passed it through the Effect). This
    // method does ONLY the host-side work the reducer can't:
    //   - clearSelectionRequestsForPath (host-local selection timer cleanup)
    //   - onSessionClosed (disk-persisting analytics: finalize run as
    //     'closed' + dispatch ActiveRunSummaryChanged(null) —
    //     redundant since the reducer already cleared the run summary, but
    //     idempotent)
    //   - clearSessionScope (host-local runtime state: busySeqMap,
    //     sessionOperationQueues, dataEpochs, etc. + dispatches
    //     SessionScopeCleared{removeSessionSummary:false} — redundant since
    //     the reducer already cleared the maps, but idempotent)
    //   - evictInactiveTranscriptWindows (host-local LRU)
    //   - assertSelectionInvariant (debug assertion)
    //   - the recursive openSession(nextPath) when nextPath is not yet
    //     summarized/pending (the edge case where a tab is open but its
    //     session hasn't been loaded yet — e.g. startup tab restore before the
    //     sessions list is populated). The openSession dispatches the
    //     OpenSession Command, which inserts a placeholder + re-selects +
    //     emits the OpenSession Effect → runner does the session.open RPC.
    //     If the open fails, handleSelectionFailure's wasOpenTab=true branch
    //     skips teardown (nextPath is already open) — the tab stays open but
    //     unopened, matching the pre-migration behavior.
    //
    // NO backend RPC for close (unlike create/open/duplicate). NO CloseTab
    // dispatch (the reducer already removed from openTabPaths). NO
    // saveOpenTabs (replaced by PersistTabs Effect). NO SelectSession dispatch
    // (the reducer already selected nextPath). NO placeholder creation (moved
    // to openSession).
    auditLog('session-service', 'session.close.requested', {
      nextPath,
      sessionPath,
    });

    if (selectionChanged) {
      // The reducer emits the runtime-free backend notification for a resolved
      // successor. This host-local epoch only invalidates failures from older
      // fast-path notifications after the close changed visual selection.
      this.visualTransitionEpoch += 1;
    }

    this.state.clearSelectionRequestsForPath(sessionPath);
    this.runObserver.onSessionClosed(sessionPath);
    this.state.clearSessionScope(sessionPath);

    // Recursive open: only when nextPath exists and is NOT already summarized
    // or pending (the edge case). The reducer already set activeSessionPath =
    // nextPath; the openSession will re-select (redundant, idempotent) +
    // insert a placeholder + emit the backend session.open RPC.
    if (nextPath) {
      const archState = this.getArchState();
      const isSummarizedOrPending =
        isPendingTabPath(nextPath) || !!archState.sessions.sessions.find((s) => s.path === nextPath);
      if (!isSummarizedOrPending) {
        void this.openSession(nextPath, undefined, causalParentOperationId);
      }
    }

    this.state.evictInactiveTranscriptWindows();
    this.state.assertSelectionInvariant('closeSession');
    this.scheduleRender();
  }

  duplicateSession(sourceSessionPath: string, initiatingSource?: RendererCommandContext): void {
    // Host-side entry: generate the impure bits the reducer can't (pending
    // path counter + Date.now placeholder modifiedAt + the selection token),
    // then dispatch the DuplicateSession Command. The reducer owns the
    // optimistic tab setup (placeholder copy summary, tab open adjacent to the
    // source, select, running state, active-run summary) and emits PersistTabs
    // + DuplicateSession; the runner owns the backend session.duplicate RPC +
    // failure recovery. Mirrors createNewSession.
    //
    // beginSelectionRequest MUST run before the Command dispatch: it snapshots
    // `previousActivePath` (the active tab before the duplicate) so failure
    // recovery can restore it. The reducer synchronously sets activeSessionPath
    // = pending during the dispatch, so calling beginSelectionRequest after
    // would snapshot the pending path instead.
    //
    // Guards stay host-side: a missing/pending source can't build a
    // placeholder (the source's name/cwd/messageCount are read here) and
    // dispatches no Command, so there is no optimistic change to revert.
    const archState = this.getArchState();
    const source = archState.sessions.sessions.find((s) => s.path === sourceSessionPath);
    if (!source) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot duplicate: session not found.' });
      this.scheduleRender();
      return;
    }

    if (isPendingTabPath(sourceSessionPath)) {
      this.dispatchArch({ kind: 'NoticeShown', notice: 'Cannot duplicate: session is still being created.' });
      this.scheduleRender();
      return;
    }

    const pendingPath = this.state.createPendingSessionPath();
    const operationId = crypto.randomUUID();
    this.visualTransitionEpoch += 1;
    const selectionToken = this.state.beginSelectionRequest(pendingPath, pendingPath, false, false, undefined, operationId);

    const placeholderSummary: SessionSummary = {
      path: pendingPath,
      name: `${source.name} (copy)`,
      cwd: source.cwd,
      modifiedAt: new Date().toISOString(),
      messageCount: source.messageCount,
      modelId: source.modelId,
      provider: source.provider,
      thinkingLevel: source.thinkingLevel,
      isPlaceholder: true,
    };

    auditLog('session-service', 'session.duplicate.requested', {
      sourceSessionPath,
      pendingPath,
      selectionToken,
      operationId,
    });

    this.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'DuplicateSession',
        corrId: crypto.randomUUID(),
        sessionPath: pendingPath,
        sourceSessionPath,
        placeholderSummary,
        selectionToken,
        operationId,
        operationSource: operationSourceFromRenderer(initiatingSource),
        backendGeneration: this.state.getBackendGeneration(),
      },
    });
    this.scheduleRender();
  }

  /** Retry a delayed create/duplicate without minting a new operation identity.
   * This is host-owned so any future retry UI cannot accidentally create a new
   * pending tab or lose the original queued sends. */
  retryCreateSession(operationId: string): boolean {
    const operation = this.getArchState().operations[operationId];
    if (!operation || operation.phase !== 'ambiguous' || operation.terminal) return false;
    const summary = this.getArchState().sessions.sessions.find((item) => item.path === operation.session.pendingPath);
    if ((!summary && !operation.hidden)
      || (operation.kind === 'session.duplicate' && !operation.session.sourcePath)) return false;
    if (!this.state.retryCreateOperation(operationId)) return false;
    const corrId = crypto.randomUUID();
    if (operation.kind === 'session.create') {
      this.dispatchArch({
        kind: 'Command',
        cmd: {
          kind: 'CreateSession',
          corrId,
          sessionPath: operation.session.pendingPath,
          cwd: operation.cwd ?? summary?.cwd ?? this.getArchState().sessions.workspaceCwd ?? '',
          placeholderSummary: summary ?? {
            path: operation.session.pendingPath,
            name: 'New Session',
            cwd: operation.cwd ?? this.getArchState().sessions.workspaceCwd ?? '',
            modifiedAt: new Date().toISOString(),
            messageCount: 0,
            isPlaceholder: true,
          },
          selectionToken: operation.causal.selectionToken,
          operationId,
          operationAttempt: operation.attempt + 1,
          operationSource: operation.source,
          causalParentOperationId: operation.causal.parentOperationId,
          backendGeneration: operation.backendGeneration,
        },
      });
    } else if (operation.session.sourcePath) {
      this.dispatchArch({
        kind: 'Command',
        cmd: {
          kind: 'DuplicateSession',
          corrId,
          sessionPath: operation.session.pendingPath,
          sourceSessionPath: operation.session.sourcePath,
          placeholderSummary: summary ?? {
            path: operation.session.pendingPath,
            name: 'Session copy',
            cwd: this.getArchState().sessions.workspaceCwd ?? '',
            modifiedAt: new Date().toISOString(),
            messageCount: 0,
            isPlaceholder: true,
          },
          selectionToken: operation.causal.selectionToken,
          operationId,
          operationAttempt: operation.attempt + 1,
          operationSource: operation.source,
          causalParentOperationId: operation.causal.parentOperationId,
          backendGeneration: operation.backendGeneration,
        },
      });
    }
    this.scheduleRender();
    return true;
  }
}
