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

  if (payload.replacesSessionPath && payload.replacesSessionPath !== session.path) {
    deps.dispatchArch({
      kind: 'PendingPathReplaced',
      oldPendingPath: payload.replacesSessionPath,
      newSessionPath: session.path,
    });
    deps.runObserver.replaceSessionPath(
      payload.replacesSessionPath,
      session.path,
      session.identityFallback === true ? undefined : session.sessionId?.trim() || undefined,
    );
    deps.state.clearSessionScope(payload.replacesSessionPath, true);
  }

  if (flags.createResolution?.fresh && flags.createResolution.operation) {
    deps.dispatchArch({
      kind: 'CreateOperationSucceeded',
      operationId: flags.createResolution.operation.operationId,
      pendingPath: flags.createResolution.operation.pendingPath,
      sessionPath: session.path,
    });
  }

  if (flags.createResolution?.fresh && flags.createResolution.operation) {
    handlePendingPathReplacement(
      deps,
      flags.selectionRequest,
      flags.createResolution.operation,
      session.path,
      session.identityFallback === true ? undefined : session.sessionId?.trim() || undefined,
    );
  }

  const transcriptResolution = resolveAndDispatch(payload, deps, session.path, flags.staleSessionData);

  applyPostDispatchState(deps, payload, session.path, flags, transcriptResolution.transcript);

  if (payload.snapshotUnavailable) {
    deps.dispatchArch({
      kind: 'Error',
      sessionPath: session.path,
      error: payload.snapshotUnavailable.message,
      detail: `${payload.snapshotUnavailable.code}: the durable transcript was not truncated for transport.`,
    });
  }

  finalizeSessionOpening(deps, payload, flags);
}

function computeOpeningFlags(payload: SessionOpenedPayload, deps: ApplySessionOpenedDeps) {
  const { session, selectionToken } = payload;
  const archState = deps.getArchState();
  const selectionRequest = deps.state.getSelectionRequest(selectionToken);
  const operation = payload.operationId
    ? archState.pending.createOperations[payload.operationId]
    : selectionRequest?.operationId
      ? archState.pending.createOperations[selectionRequest.operationId]
      : undefined;
  const operationMatches = !!operation
    && (!payload.operationId || operation.operationId === payload.operationId)
    && (!payload.operationId || selectionToken === operation.selectionToken)
    && (!payload.operationId || !!selectionToken)
    && operation.pendingPath !== session.path;
  const fresh = operationMatches
    && (operation.status === 'pending' || operation.status === 'delayed-awaiting-outcome');
  const duplicate = operationMatches
    && operation.status === 'succeeded'
    && operation.resolvedSessionPath === session.path;
  const rejected = !!payload.operationId && (!operation || !operationMatches || operation.status === 'failed');
  const createResolution = operation
    ? { operation, fresh, duplicate, rejected, hidden: operation.hidden === true }
    : undefined;
  const staleSessionData = selectionRequest?.requestEpoch !== undefined
    && deps.state.getSessionDataEpoch(session.path) !== selectionRequest.requestEpoch;
  const replacementSource = payload.replacesSessionPath;
  const replacementWasOpen = !!replacementSource
    && archState.sessions.openTabPaths.includes(replacementSource);
  const replacementWasActive = !!replacementSource
    && archState.sessions.activeSessionPath === replacementSource;
  const shouldOpenTab = rejected
    ? archState.sessions.openTabPaths.includes(session.path)
    : (createResolution?.fresh
        ? !createResolution.hidden
        : !!selectionRequest || replacementWasOpen || archState.sessions.openTabPaths.includes(session.path));
  const shouldActivate = !createResolution?.hidden && !rejected && (replacementWasActive || (selectionToken
    ? (deps.state.isCurrentSelectionToken(selectionToken) && !duplicate)
    : (archState.sessions.activeSessionPath === session.path
        || (!!selectionRequest?.pendingPath
            && selectionRequest.pendingPath !== session.path
            && archState.sessions.activeSessionPath === selectionRequest.pendingPath))));

  return { selectionRequest, staleSessionData, shouldOpenTab, shouldActivate, createResolution };
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
  operation: NonNullable<ReturnType<typeof computeOpeningFlags>['createResolution']>['operation'],
  sessionPath: string,
  stableSessionId: string | undefined,
): void {
  const pendingPath = operation.pendingPath ?? selectionRequest?.pendingPath;
  if (!pendingPath || pendingPath === sessionPath) return;

  deps.dispatchArch({
    kind: 'PendingPathReplaced',
    oldPendingPath: pendingPath,
    newSessionPath: sessionPath,
  });

  deps.runObserver.replaceSessionPath(pendingPath, sessionPath, stableSessionId);
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
  const transcriptUnavailable = payload.snapshotUnavailable !== undefined;
  // Skip-transcript path: the backend omitted the tail window because the
  // host requested `transcript: 'skip'` (it already has the transcript loaded
  // and the session is idle). Keep the host's existing transcript + window
  // instead of merging/replacing with the empty incoming snapshot — otherwise
  // the view would clear. File-change derivation below uses the kept transcript.
  const existingWindow = deps.getArchState().transcript.windowBySession[sessionPath];
  const transcriptResolution = (payload.transcriptSkipped || transcriptUnavailable) && existingWindow
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

  const selectionRequest = deps.state.getSelectionRequest(payload.selectionToken);
  const requestFences = payload.operationAttempt !== undefined
    ? selectionRequest?.modelFencesByOperationAttempt?.[payload.operationAttempt]
    : selectionRequest;
  deps.dispatchArch({
    kind: 'SessionOpened',
    sessionPath,
    payload: resolvedPayload,
    backendGeneration: requestFences?.backendGeneration ?? deps.state.getBackendGeneration(),
    // An unsolicited snapshot has no host request-start fence. Treat its model
    // metadata as unfenced rather than stamping it fresh at receipt; lifecycle
    // snapshots carry the exact values captured by their SelectionRequest.
    modelWriteFence: requestFences?.modelWriteFence ?? -1,
    modelHydrationRevision: requestFences?.modelHydrationRevision ?? -1,
    catalogHydrationRevision: requestFences?.catalogHydrationRevision ?? -1,
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
    && !flags.createResolution?.hidden
    && !flags.createResolution?.rejected
  ) {
    deps.dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath } });
  }
  const activeExtensionIds = payload.analyticsFactors?.activeExtensions ?? [];
  if (activeExtensionIds.length > 0 || deps.getArchState().settings.availableExtensions.length === 0) {
    deps.dispatchArch({ kind: 'AvailableExtensionsChanged', extensions: deriveAvailableExtensions(
      activeExtensionIds,
    ) });
  }
  deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: deriveFileChangesFromTranscript(transcript, resolveSessionCwd(deps.getArchState().sessions.sessions, deps.getArchState().sessions.workspaceCwd, sessionPath)) });
}

function finalizeSessionOpening(
  deps: ApplySessionOpenedDeps,
  payload: SessionOpenedPayload,
  flags: ReturnType<typeof computeOpeningFlags>,
): void {
  const sessionPath = payload.session.path;
  const selectionToken = payload.selectionToken;
  deps.state.markSessionSnapshotKnown(sessionPath);
  // Protocol-v13 explicitly distinguishes durable browse hydration from an
  // execution runtime. Omission remains legacy-compatible and means ready.
  if (payload.runtimeReady !== false) {
    deps.state.markSessionRuntimeKnown(sessionPath);
  }
  deps.state.touchSessionTranscript(sessionPath);
  deps.state.evictInactiveTranscriptWindows();
  // A mismatched/old-generation create event may refresh durable cache, but it
  // cannot consume the current operation's waiter. Only the matching late
  // success (or an ordinary open) settles selection ownership.
  if (!flags.createResolution?.rejected) {
    deps.state.finishSelectionRequest(selectionToken);
  }
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
      pinnedTabGroups: archState.sessions.pinnedTabGroups,
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
  // The reducer has now applied the authoritative host running state. If the
  // last generating session became idle, deterministically resume the FIFO
  // background preload pump; the pump re-checks the full running set before
  // launching anything.
  if (!payload.busy) deps.state.resumePreloads();

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
    const exitNotice = `PI backend stopped${code !== null ? ` (code ${code})` : ''}`;
    // A dead generation is definitive for delayed creates: unlike a local RPC
    // timeout, no future event from this process can complete them. Fail only
    // those operation-ledger entries before clearing generation-scoped host
    // waiters; resolved operations remain tombstoned and stale opened events
    // cannot replace them.
    deps.state.failPendingCreateOperations(exitNotice);
    // Clear dead-process runtime state now, but generation ownership advances
    // exactly once when the replacement process starts. BackendClient follows
    // the same spawn-scoped generation rule.
    deps.state.resetRuntimeState({ advanceBackendGeneration: false });
    bootLog('session-events', 'backend.exited', {
      code,
      notice: exitNotice,
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
