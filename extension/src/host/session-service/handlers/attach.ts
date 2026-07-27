import * as vscode from 'vscode';
import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import type { OnSessionCompleted } from '../types';
import type { BusyChangedPayload, EventEnvelope, SessionOpenedPayload } from '../../../shared/protocol';
import { resolveSessionOpenedTranscript } from '../../core/session-opened-transcript';
import { deriveFileChangesFromTranscript, resolveSessionCwd } from '../../core/file-change-derivation';
import { deriveAvailableExtensions } from '../available-extensions.js';
import { bootLog, auditLog } from '../../util/audit';
import { shouldFlashFinishedTab } from '../../sidebar/completion-notification';
import { backendExitEvents, type InterruptedSessionActivity } from '../backend-exit-events.js';
import { appendPieLog } from '../../util/pie-log.js';

interface ApplySessionOpenedDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  runObserver: RunObserver;
  scheduleRender: () => void;
  context: vscode.ExtensionContext;
  state: SessionServiceState;
}

export function applySessionOpenedPayload(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
): void {
  const { session, selectionToken } = payload;
  appendPieLog('info', 'event-trace', 'session.opened.received', {
    sessionPath: session.path,
    selectionToken: selectionToken ?? null,
    transcriptLength: payload.transcript?.length ?? 0,
    transcriptWindow: payload.transcriptWindow ? {
      totalCount: payload.transcriptWindow.totalCount,
      loadedStart: payload.transcriptWindow.loadedStart,
      loadedEnd: payload.transcriptWindow.loadedEnd,
    } : null,
    transcriptSkipped: payload.transcriptSkipped ?? false,
  });
  const flags = computeOpeningFlags(payload, deps);

  logSessionOpened(payload, deps, flags);

  handlePendingPathReplacement(deps, flags.selectionRequest, session.path);

  const transcriptResolution = resolveAndDispatch(payload, deps, session.path, flags.staleSessionData);

  applyPostDispatchState(deps, payload, session.path, flags, transcriptResolution.transcript);

  finalizeSessionOpening(deps, session.path, selectionToken);
}

function computeOpeningFlags(payload: SessionOpenedPayload, deps: ApplySessionOpenedDeps) {
  const { session, selectionToken } = payload;
  const selectionRequest = deps.state.getSelectionRequest(selectionToken);
  const staleSessionData = selectionRequest?.requestEpoch !== undefined
    && deps.state.getSessionDataEpoch(session.path) !== selectionRequest.requestEpoch;
  const shouldOpenTab = !!selectionRequest || deps.getArchState().sessions.openTabPaths.includes(session.path);
  const shouldActivate = selectionToken
    ? deps.state.isCurrentSelectionToken(selectionToken)
    : (deps.getArchState().sessions.activeSessionPath === session.path
        || (!!selectionRequest?.pendingPath
            && selectionRequest.pendingPath !== session.path
            && deps.getArchState().sessions.activeSessionPath === selectionRequest.pendingPath));

  return { selectionRequest, staleSessionData, shouldOpenTab, shouldActivate };
}

function logSessionOpened(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
  flags: ReturnType<typeof computeOpeningFlags>,
): void {
  const { session, selectionToken } = payload;
  bootLog('session-service', 'session.opened', {
    selectionToken: selectionToken ?? null,
    sessionPath: session.path,
    shouldActivate: flags.shouldActivate,
    shouldOpenTab: flags.shouldOpenTab,
    staleSessionData: flags.staleSessionData,
    activeSessionPath: deps.getArchState().sessions.activeSessionPath,
    isCurrentSelectionToken: selectionToken ? deps.state.isCurrentSelectionToken(selectionToken) : 'no-token',
  });

  bootLog('session-events', 'session.opened', {
    activeSessionPath: deps.getArchState().sessions.activeSessionPath,
    selectionToken: selectionToken ?? null,
    sessionPath: session.path,
    shouldActivate: flags.shouldActivate,
    shouldOpenTab: flags.shouldOpenTab,
    transcriptLoaded: true,
  });
}

function handlePendingPathReplacement(
  deps: ApplySessionOpenedDeps,
  selectionRequest: ReturnType<typeof computeOpeningFlags>['selectionRequest'],
  sessionPath: string,
): void {
  if (!selectionRequest?.pendingPath || selectionRequest.pendingPath === sessionPath) {
    return;
  }

  const pendingPath = selectionRequest.pendingPath;

  deps.dispatchArch({
    kind: 'PendingPathReplaced',
    oldPendingPath: pendingPath,
    newSessionPath: sessionPath,
  });

  deps.runObserver.replaceSessionPath(pendingPath, sessionPath);
  deps.state.clearSessionScope(pendingPath, true);
}

function resolveAndDispatch(
  payload: SessionOpenedPayload,
  deps: ApplySessionOpenedDeps,
  sessionPath: string,
  staleSessionData: boolean,
) {
  const localTranscript = deps.getArchState().transcript.bySession[sessionPath] ?? [];
  // STATE_CONTRACT (Snapshot Recovery): a session.opened must not discard
  // in-memory optimistic or streaming transcript state that is newer than the
  // backend snapshot. The backend's `busy` flag alone is insufficient: during a
  // message EDIT the backend emits an intermediate truncate snapshot while idle
  // — `session.truncateAfter` rewrites the file and emits `session.opened`
  // (busy=false) BEFORE `message.send` starts the new turn. At that instant the
  // host still holds a pending optimistic edit message that is newer than the
  // truncated snapshot. Treating that snapshot as a full replace wiped the
  // optimistic message (and the original message + reply), so the transcript
  // cleared and the agent streamed a reply to nothing. Treat the host's own
  // running signal — set optimistically by Send/Edit and cleared on turn end —
  // as an additional preserve trigger so the optimistic state survives the
  // intermediate snapshot. The final agent_end snapshot arrives after
  // BusyChanged(false), so hostRunning is false there and the authoritative
  // transcript still wins.
  const hostRunning = deps.getArchState().sessions.runningSessionPaths.includes(sessionPath);
  const preserveBusy = payload.busy || staleSessionData || hostRunning;
  // Skip-transcript path: the backend omitted the tail window because the
  // host requested `transcript: 'skip'` (it already has the transcript loaded
  // and the session is idle). Keep the host's existing transcript + window
  // instead of merging/replacing with the empty incoming snapshot — otherwise
  // the view would clear. File-change derivation below uses the kept transcript.
  const existingWindow = deps.getArchState().transcript.windowBySession[sessionPath];
  const transcriptResolution = payload.transcriptSkipped && existingWindow
    ? { preserveLocal: true, transcript: localTranscript, transcriptWindow: existingWindow, aliases: [] as Array<{ aliasId: string; canonicalId: string }> }
    : resolveSessionOpenedTranscript({
        busy: preserveBusy,
        incomingTranscript: payload.transcript,
        incomingTranscriptWindow: payload.transcriptWindow,
        localTranscript,
      });
  const preserveStreamingState = transcriptResolution.preserveLocal && preserveBusy;

  const resolvedPayload: SessionOpenedPayload = {
    ...payload,
    transcript: transcriptResolution.transcript,
    transcriptWindow: transcriptResolution.transcriptWindow,
    ...(preserveStreamingState && { systemPrompts: undefined }),
  };

  deps.dispatchArch({
    kind: 'SessionOpened',
    sessionPath,
    payload: resolvedPayload,
  });

  return transcriptResolution;
}

function applyPostDispatchState(
  deps: ApplySessionOpenedDeps,
  payload: SessionOpenedPayload,
  sessionPath: string,
  flags: ReturnType<typeof computeOpeningFlags>,
  transcript: any[],
): void {
  if (flags.shouldOpenTab && !deps.getArchState().sessions.openTabPaths.includes(sessionPath)) {
    deps.dispatchArch({ kind: 'TabOpened', sessionPath });
  }
  if (flags.shouldActivate) {
    deps.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath } });
  }
  if (
    !flags.shouldActivate
    && flags.selectionRequest?.pendingPath
    && flags.selectionRequest.pendingPath !== sessionPath
    && deps.getArchState().sessions.activeSessionPath === flags.selectionRequest.pendingPath
  ) {
    deps.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath } });
  }
  if (payload.analyticsFactors) {
    deps.dispatchArch({ kind: 'AvailableExtensionsChanged', extensions: deriveAvailableExtensions(
      payload.analyticsFactors.activeExtensions,
    ) });
  }
  deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: deriveFileChangesFromTranscript(transcript, resolveSessionCwd(deps.getArchState().sessions.sessions, deps.getArchState().sessions.workspaceCwd, sessionPath)) });
}

function finalizeSessionOpening(
  deps: ApplySessionOpenedDeps,
  sessionPath: string,
  selectionToken: SessionOpenedPayload['selectionToken'],
): void {
  deps.state.touchSessionTranscript(sessionPath);
  deps.state.evictInactiveTranscriptWindows();
  deps.state.finishSelectionRequest(selectionToken);
  deps.state.assertSelectionInvariant('onSessionOpened');
  const archState = deps.getArchState();
  deps.dispatchArch({
    kind: 'Command',
    cmd: {
      kind: 'PersistTabs',
      corrId: `persist:${Date.now()}`,
      openTabPaths: archState.sessions.openTabPaths,
      activeSessionPath: archState.sessions.activeSessionPath,
      pinnedTabPaths: archState.sessions.pinnedTabPaths,
    },
  });
  deps.scheduleRender();
}

export function handleBusyChangedPayload(
  payload: BusyChangedPayload,
  sessionPath: string,
  deps: {
    getArchState: () => ArchState;
    dispatchArch: (event: Event) => void;
    runObserver: RunObserver;
    scheduleRender: () => void;
    context: vscode.ExtensionContext;
    state: SessionServiceState;
    onSessionCompleted?: OnSessionCompleted;
  },
): void {
  auditLog('session-service', 'busy.changed', {
    busy: payload.busy,
    seq: payload.seq ?? null,
    sessionPath,
  });

  if (!deps.state.acceptBusySeq(sessionPath, payload.seq)) {
    return;
  }

  const wasRunning = deps.getArchState().sessions.runningSessionPaths.includes(sessionPath);

  if (payload.busy) {
    deps.state.clearCompletionSuppression(sessionPath);
  }

  deps.dispatchArch({
    kind: 'BusyChanged',
    sessionPath,
    running: payload.busy,
  });
  deps.runObserver.onBusyChanged(sessionPath, payload.busy);

  // Clear pending extension UI request when the session finishes.
  if (!payload.busy) {
    if (deps.getArchState().settings.pendingExtensionUIRequestsBySession[sessionPath]) {
      deps.dispatchArch({ kind: 'PendingExtensionUIRequestsCleared', sessionPath });
    }
  }

  if (wasRunning && !payload.busy && !deps.state.consumeCompletionSuppression(sessionPath)) {
    if (
      deps.getArchState().sessions.openTabPaths.includes(sessionPath) &&
      shouldFlashFinishedTab({
        suppressNotifications: deps.getArchState().settings.prefs.suppressCompletionNotifications,
        sessionIsActive: deps.getArchState().sessions.activeSessionPath === sessionPath,
      })
    ) {
      // unreadFinishedSessionPaths is already handled by the reducer's BusyChanged handler
    }

    deps.onSessionCompleted?.({
      sessionPath,
    });
  }

  deps.state.evictInactiveTranscriptWindows();
  deps.scheduleRender();
}

interface AttachDeps {
  context: vscode.ExtensionContext;
  scheduleRender: () => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  onSessionCompleted?: OnSessionCompleted;
}

export function attach(
  backend: {
    onEvent: (handler: (event: EventEnvelope) => void) => vscode.Disposable;
    onExit: (handler: (info: { code: number | null; stderr: string }) => void) => vscode.Disposable;
  },
  deps: AttachDeps,
  handlers: {
    handleBackendEvent: (event: EventEnvelope) => void;
  },
): vscode.Disposable[] {
  const eventDisposable = backend.onEvent((event: EventEnvelope) => {
    handlers.handleBackendEvent(event);
  });

  const exitDisposable = backend.onExit(({ code, stderr }) => {
    // Snapshot running sessions BEFORE we clear them. If the backend died
    // while one or more sessions were streaming, those sessions' in-flight
    // assistant messages will never receive a `message.aborted` event (the
    // backend is gone), so without an explicit `SessionsInterrupted` dispatch
    // they would stay `status: 'streaming'` forever and the user would never
    // be alerted that the interruption was not their doing. The pure
    // `backendExitEvents` helper decides the exact event sequence so the
    // alert policy is unit-tested independently of vscode.
    const arch = deps.getArchState();
    const runningSessionPaths = [...new Set(arch.sessions.runningSessionPaths)];
    const activityBySession: Record<string, InterruptedSessionActivity> = {};
    for (const sessionPath of runningSessionPaths) {
      if (arch.settings.pendingExtensionUIRequestsBySession[sessionPath]) {
        activityBySession[sessionPath] = 'waiting for user input';
      } else {
        const messages = arch.transcript.bySession[sessionPath] ?? [];
        const runningTool = messages.some((message) => message.toolCalls?.some((tool) => tool.status === 'running'));
        activityBySession[sessionPath] = runningTool ? 'running a tool' : 'generating';
      }
    }
    bootLog('session-events', 'backend.exited', {
      code,
      notice: `PI backend stopped${code !== null ? ` (code ${code})` : ''}`,
      runningSessionPaths,
    });
    for (const event of backendExitEvents(runningSessionPaths, code, stderr, Date.now(), activityBySession)) {
      deps.dispatchArch(event);
    }
    deps.scheduleRender();
  });

  return [eventDisposable, exitDisposable];
}

export function detach(disposables: vscode.Disposable[]): void {
  for (const d of disposables) {
    d.dispose();
  }
}
