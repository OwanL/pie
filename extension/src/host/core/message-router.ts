import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import type { WebviewToHostMessage, SessionSummary, ChatPrefs, PruningSettings, ToolResultPruningSettings, PruningMode } from '../../shared/protocol';
import type { Event } from './events';
import type { ArchState } from './reducer';
import { bootLog } from '../util/audit';
import { appendPieError, appendPieLog, showPieLogs } from '../util/pie-log';
import { buildOptimisticUserParts, buildPromptText } from './composer';
import { resolveSettingsPath } from '../util/settings-path';

/** Minimal sidebar provider surface the router needs. */
export interface SidebarProviderLike {
  reveal(): void;
  postState(): void;
  postImperative(msg: any): void;
}

/** Minimal session-service surface the router needs. */
export interface SessionServiceLike {
  bumpSessionDataEpoch(sessionPath: string): void;
  addFilesystemPaths(requestedSessionPath: string | undefined, paths: string[], source: 'picker' | 'drop'): Promise<void>;
  createNewSession(): string;
  openSession(sessionPath: string): void;
  duplicateSession(sessionPath: string): void;
  loadOlderTranscript(sessionPath?: string): Promise<void>;
  loadNewerTranscript(sessionPath?: string): Promise<void>;
  jumpToLatestTranscript(sessionPath?: string): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void>;
  /** Notify deferred triggers that the user sent a message in `sessionPath`. */
  notifyUserInput(sessionPath: string): void;
  /** Cancel a deferred trigger (or all for `sessionPath` when `triggerId` is
   *  omitted). Invoked by the webview's status-strip cancel affordance. */
  cancelDeferredTrigger(sessionPath: string, triggerId?: string): void;
}

/**
 * Routes incoming {@link WebviewToHostMessage} instances to the appropriate
 * handler logic. Each `type` case is a private method; the public {@link handle}
 * dispatches to it.
 *
 * Extracted from `PieExtension` (design decision #10) so that the extension
 * class remains a thin orchestrator — wiring, lifecycle, CQRS dispatch, and
 * the render pipeline.
 */
export class MessageRouter {

  constructor(
    private readonly dispatchEvent: (event: Event) => void,
    private readonly getArchState: () => ArchState,
    private readonly service: SessionServiceLike,
    private readonly sidebarProvider: SidebarProviderLike,
    private readonly scheduleRender: () => void,
    private readonly deriveSessionNameFromTextFn: (text: string) => { name: string; isPlaceholder: boolean },
    private readonly isPendingTabPathFn: (path: string) => boolean,
  ) {
  }

  async handle(msg: WebviewToHostMessage): Promise<void> {
    try {
      await this.routeMessage(msg);
    } catch (err) {
      appendPieError('message-router', 'handle failed', err, { messageType: msg?.type });
      // User-initiated send/edit: surface a notice so the failure isn't silent.
      if (msg?.type === 'send' || msg?.type === 'editMessage') {
        this.dispatchEvent({ kind: 'NoticeShown', notice: 'Failed to process your message. See the pie log for details.' });
      }
    }
  }

  private async routeMessage(msg: WebviewToHostMessage): Promise<void> {
    if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
      // Read ArchState fields directly instead of running a full O(transcript)
      // `selectViewState` projection purely to log five fields. These inbound
      // messages fire on webview (re)connect / focus / snapshot recovery, and
      // the projection was the only work they did — dropping it removes a
      // whole-transcript walk per handshake. Mirrors `scheduleRender`'s
      // direct-read pattern.
      const arch = this.getArchState();
      const activeSessionPath = arch.sessions.activeSessionPath ?? null;
      bootLog('extension-host', `webview.${msg.type}`, {
        activeSessionPath,
        backendReady: arch.settings.backendReady,
        notice: arch.settings.notice,
        openTabCount: arch.sessions.openTabPaths.length,
        transcriptLoaded: activeSessionPath
          ? Object.prototype.hasOwnProperty.call(arch.transcript.windowBySession, activeSessionPath)
          : false,
      });
    }

    switch (msg.type) {
      case 'ready':
        return this.onReady();

      case 'refreshState':
        return await this.onRefreshState();

      case 'requestSnapshot':
        return this.onRequestSnapshot();

      case 'send':
        return await this.onSend(msg as Extract<WebviewToHostMessage, { type: 'send' }>);

      case 'editMessage':
        return await this.onEditMessage(msg as Extract<WebviewToHostMessage, { type: 'editMessage' }>);

      case 'interrupt':
        return this.onInterrupt(msg as Extract<WebviewToHostMessage, { type: 'interrupt' }>);
      case 'clearQueue':
        return this.onClearQueue(msg as Extract<WebviewToHostMessage, { type: 'clearQueue' }>);

      case 'openFilePicker':
        return await this.onOpenFilePicker();

      case 'addComposerInput':
        return await this.onAddComposerInput(msg as Extract<WebviewToHostMessage, { type: 'addComposerInput' }>);

      case 'setComposerDraft':
        return this.onSetComposerDraft(msg as Extract<WebviewToHostMessage, { type: 'setComposerDraft' }>);

      case 'removeComposerInput':
        return this.onRemoveComposerInput(msg as Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>);

      case 'openFile':
        return await this.onOpenFile(msg as Extract<WebviewToHostMessage, { type: 'openFile' }>);

      case 'newSession':
        return this.onNewSession();

      case 'openSession':
        return this.onOpenSession(msg as Extract<WebviewToHostMessage, { type: 'openSession' }>);

      case 'closeSession':
        return await this.onCloseSession(msg as Extract<WebviewToHostMessage, { type: 'closeSession' }>);

      case 'duplicateSession':
        return await this.onDuplicateSession(msg as Extract<WebviewToHostMessage, { type: 'duplicateSession' }>);

      case 'moveSessionTab':
        return this.onMoveSessionTab(msg as Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>);

      case 'togglePinTab':
        return this.onTogglePinTab(msg as Extract<WebviewToHostMessage, { type: 'togglePinTab' }>);

      case 'loadOlderTranscript':
        return await this.onLoadOlderTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>);

      case 'loadNewerTranscript':
        return await this.onLoadNewerTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>);

      case 'jumpToLatestTranscript':
        return await this.onJumpToLatestTranscript(msg as Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>);

      case 'recordOutcome':
        return this.onRecordOutcome(msg as Extract<WebviewToHostMessage, { type: 'recordOutcome' }>);

      case 'startNewTask':
        return this.onStartNewTask(msg as Extract<WebviewToHostMessage, { type: 'startNewTask' }>);

      case 'continueTask':
        return this.onContinueTask(msg as Extract<WebviewToHostMessage, { type: 'continueTask' }>);

      case 'setModel':
        return this.onSetModel(msg as Extract<WebviewToHostMessage, { type: 'setModel' }>);

      case 'openFileDiff':
        return await this.onOpenFileDiff(msg as Extract<WebviewToHostMessage, { type: 'openFileDiff' }>);

      case 'openFileInEditor':
        return await this.onOpenFileInEditor(msg as Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>);

      case 'revertFile':
        return await this.onRevertFile(msg as Extract<WebviewToHostMessage, { type: 'revertFile' }>);

      case 'setFileRead':
        return this.onSetFileRead(msg as Extract<WebviewToHostMessage, { type: 'setFileRead' }>);

      case 'setSystemPromptToggles':
        return this.onSetSystemPromptToggles(msg as Extract<WebviewToHostMessage, { type: 'setSystemPromptToggles' }>);

      case 'setPrefs':
        return this.onSetPrefs(msg as Extract<WebviewToHostMessage, { type: 'setPrefs' }>);

      case 'setPruningSettings':
        return await this.onSetPruningSettings(msg as Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>);

      case 'setToolResultPruningSettings':
        return await this.onSetToolResultPruningSettings(msg as Extract<WebviewToHostMessage, { type: 'setToolResultPruningSettings' }>);

      case 'startEdit':
        return this.onStartEdit(msg as Extract<WebviewToHostMessage, { type: 'startEdit' }>);

      case 'cancelEdit':
        return this.onCancelEdit(msg as Extract<WebviewToHostMessage, { type: 'cancelEdit' }>);

      case 'dismissNotice':
        return this.onDismissNotice();

      case 'openOutcomeDialog':
        return this.onOpenOutcomeDialog(msg as Extract<WebviewToHostMessage, { type: 'openOutcomeDialog' }>);

      case 'closeOutcomeDialog':
        return this.onCloseOutcomeDialog(msg as Extract<WebviewToHostMessage, { type: 'closeOutcomeDialog' }>);

      case 'stateApplied':
        return this.onStateApplied(msg as Extract<WebviewToHostMessage, { type: 'stateApplied' }>);

      case 'extensionUiResponse':
        return await this.onExtensionUiResponse(msg as Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>);

      case 'setFileChangesExpanded':
        return this.onSetFileChangesExpanded(msg as Extract<WebviewToHostMessage, { type: 'setFileChangesExpanded' }>);

      // ── Brief H: recovery actions surfaced from an error notice. These are
      //    side-effect-only (no reducer event), mirroring openFilePicker/openFile.
      case 'showLogs':
        return this.onShowLogs();

      case 'openSettings':
        return this.onOpenSettings();

      case 'restartBackend':
        return this.onRestartBackend();

      case 'retrySend':
        return await this.onRetrySend(msg as Extract<WebviewToHostMessage, { type: 'retrySend' }>);

      case 'cancelDeferredTrigger':
        return this.onCancelDeferredTrigger(msg as Extract<WebviewToHostMessage, { type: 'cancelDeferredTrigger' }>);

      case 'log':
        return this.onLog(msg as Extract<WebviewToHostMessage, { type: 'log' }>);

      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Individual message handlers
  // ---------------------------------------------------------------------------

  private onReady(): void {
    this.sidebarProvider.postState();
  }

  private async onRefreshState(): Promise<void> {
    const activeSessionPath = this.getArchState().sessions.activeSessionPath;
    if (activeSessionPath) {
      // Phase 2: route through the CQRS reducer + effect runner instead of
      // calling the service directly. The HydrateModel effect is fire-and-forget;
      // the service's dispatched ModelSettingsHydrated/AvailableModelsChanged events apply
      // the results.
      this.dispatchEvent({
        kind: 'Command',
        cmd: { kind: 'HydrateModel', corrId: crypto.randomUUID(), sessionPath: activeSessionPath },
      });
    }
    this.sidebarProvider.postState();
  }

  private onRequestSnapshot(): void {
    this.sidebarProvider.postState();
  }

  private async onSend(msg: Extract<WebviewToHostMessage, { type: 'send' }>, opts?: { priorPruningMode?: PruningMode }): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const webviewLocalId = msg.localId;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: send arrived without a sessionPath.' });
      return;
    }

    // All sends — pending tab, backend-not-ready, or normal — go through the
    // Send Command. The reducer decides: pending paths queue into
    // sendQueueBySession (drained on PendingPathReplaced); !backendReady queues
    // into backendReadyQueueBySession (drained on BackendReadyChanged{ready:true});
    // otherwise the normal path (SendRpc). The optimistic message insert + draft
    // clear + session-name derivation happen uniformly in the reducer / onSend.

    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot send: the selected session is no longer open.' });
      return;
    }

    const inputs = [
      ...(this.getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? []),
    ];
    if (!text.trim() && inputs.length === 0) return;

    // Pre-compute values the reducer needs.
    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const localId = webviewLocalId ?? `local:${crypto.randomUUID()}`;

    // Optimistic session name.
    let previousSummary = null as SessionSummary | null;
    const session = this.getSessionByPath(sessionPath);
    if (session?.isPlaceholder) {
      const derived = this.deriveSessionNameFromTextFn(composedText);
      if (!derived.isPlaceholder && derived.name !== session.name) {
        previousSummary = session;
        this.dispatchEvent({ kind: 'SessionNameDerived', sessionPath, name: derived.name });
        this.scheduleRender();
      }
    }

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Send', corrId, sessionPath, text, inputs, composedText, localId, userParts, previousSummary, priorPruningMode: opts?.priorPruningMode, timestamp: Date.now() },
    });
    // After the user's message is dispatched, fire any `user_input` deferred
    // trigger for this session. The wake-up it injects lands as a follow-up
    // (queued after the user's turn) rather than preempting the user's
    // message. Synthetic wake-up sends bypass `onSend`, so this never
    // self-triggers.
    this.service.notifyUserInput(sessionPath);
  }

  private async onEditMessage(msg: Extract<WebviewToHostMessage, { type: 'editMessage' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: editMessage arrived without a sessionPath.' });
      return;
    }
    const inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
    if ((!text.trim() && inputs.length === 0) || !messageId) return;

    // Pre-flight validation.
    if (this.isPendingTabPathFn(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the session is still opening.' });
      return;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the selected session is no longer open.' });
      return;
    }

    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);

    const webviewLocalId = msg.localId;
    const localId = webviewLocalId ?? `local:edit:${crypto.randomUUID()}`;

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Edit', corrId, sessionPath, messageId, text, inputs, composedText, userParts, localId, timestamp: Date.now() },
    });
  }

  private onInterrupt(msg: Extract<WebviewToHostMessage, { type: 'interrupt' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: interrupt arrived without a sessionPath.' });
      return;
    }
    // Phase 3: route through the CQRS reducer + effect runner.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'Interrupt', corrId, sessionPath },
    });
    // Completion-notification suppression is now set in the EffectRunner's
    // InterruptRpc path (the side-effect executor), not as a router side-call.
  }

  private onClearQueue(msg: Extract<WebviewToHostMessage, { type: 'clearQueue' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: clearQueue arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'ClearQueue', corrId, sessionPath },
    });
  }

  private async onOpenFilePicker(): Promise<void> {
    // The service resolves the target session (possibly creating a new one via
    // createNewSession() when no session is active) + cleans the paths, then
    // dispatches the AddFilesystemPaths Command. The reducer owns the composer-
    // input append. Mirrors onNewSession -> service.createNewSession(). The
    // previous path dispatched the Command directly with sessionPath: undefined,
    // so the runner's legacy addFilesystemPaths had to resolve the session
    // inside the effect handler (re-entrant Command dispatch).
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: 'Attach',
      title: 'Attach file path(s) to message',
    });
    if (!uris || uris.length === 0) return;
    await this.service.addFilesystemPaths(undefined, uris.map((u) => u.fsPath), 'picker');
    this.sidebarProvider.postState();
  }

  private async onAddComposerInput(msg: Extract<WebviewToHostMessage, { type: 'addComposerInput' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'AddComposerInput', corrId, sessionPath: msg.sessionPath, input: msg.input },
    });
  }

  private onSetComposerDraft(msg: Extract<WebviewToHostMessage, { type: 'setComposerDraft' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetComposerDraft', corrId, sessionPath: msg.sessionPath, text: msg.text },
    });
  }

  private onRemoveComposerInput(msg: Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RemoveComposerInput', corrId, sessionPath: msg.sessionPath, inputId: msg.inputId },
    });
  }

  private async onOpenFile(msg: Extract<WebviewToHostMessage, { type: 'openFile' }>): Promise<void> {
    if (typeof msg.path !== 'string' || !msg.path.trim()) return;
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFile', corrId, path: msg.path },
    });
  }

  private onNewSession(): void {
    // The service generates the impure pending path + placeholder summary,
    // mints the selection token (before the reducer activates the pending tab
    // so failure recovery can restore the previous active path), and dispatches
    // the CreateSession Command. The reducer owns the optimistic tab setup.
    this.service.createNewSession();
    this.sidebarProvider.postState();
  }

  private onOpenSession(msg: Extract<WebviewToHostMessage, { type: 'openSession' }>): void {
    // The service mints the data epoch + selection token (before the reducer
    // activates the opened tab so failure recovery can restore the previous
    // active path) + builds the placeholder summary, and dispatches the
    // OpenSession Command. The reducer owns the optimistic tab setup. Mirrors
    // onNewSession -> service.createNewSession(). The previous path dispatched
    // the OpenSession Command directly with a fake random selectionToken that
    // was never registered with beginSelectionRequest, so handleSelectionFailure
    // could not restore the previous active tab on failure.
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    this.service.openSession(msg.sessionPath);
    this.sidebarProvider.postState();
  }

  private onDuplicateSession(msg: Extract<WebviewToHostMessage, { type: 'duplicateSession' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: duplicateSession arrived without a sessionPath.' });
      return;
    }
    // The service generates the impure pending path + placeholder summary
    // (name "${source.name} (copy)"), mints the selection token (before the
    // reducer activates the copy tab so failure recovery can restore the
    // previous active path), and dispatches the DuplicateSession Command. The
    // reducer owns the optimistic tab setup. Mirrors onNewSession ->
    // service.createNewSession(). The previous path dispatched the
    // DuplicateSession Command directly with only the source sessionPath (no
    // pending path, placeholder, or registered selection token), so the runner
    // fell back to the old fat service.duplicateSession imperative path.
    this.service.duplicateSession(sessionPath);
    this.sidebarProvider.postState();
  }

  private onCloseSession(msg: Extract<WebviewToHostMessage, { type: 'closeSession' }>): void {
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetOutcomeDialog', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, visible: false } });
    this.sidebarProvider.postState();
  }

  private onMoveSessionTab(msg: Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'MoveSessionTab', corrId, sessionPath: msg.sessionPath, fromIndex: msg.fromIndex, toIndex: msg.toIndex },
    });
    this.sidebarProvider.postState();
  }

  private onTogglePinTab(msg: Extract<WebviewToHostMessage, { type: 'togglePinTab' }>): void {
    // Pure state mutation — no service / backend RPC. The reducer owns the
    // reorder that keeps pinned tabs as the leading prefix of openTabPaths and
    // emits a PersistTabs effect. Mirrors onMoveSessionTab.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'TogglePinTab', corrId, sessionPath: msg.sessionPath },
    });
    this.sidebarProvider.postState();
  }

  private async onLoadOlderTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadOlderTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadOlderTranscript', corrId, sessionPath },
    });
  }

  private async onLoadNewerTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadNewerTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadNewerTranscript', corrId, sessionPath },
    });
  }

  private async onJumpToLatestTranscript(msg: Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: jumpToLatestTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'JumpToLatestTranscript', corrId, sessionPath },
    });
  }

  private onRecordOutcome(msg: Extract<WebviewToHostMessage, { type: 'recordOutcome' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RecordOutcome', corrId, sessionPath: msg.sessionPath, outcome: msg.outcome },
    });
  }

  private onStartNewTask(msg: Extract<WebviewToHostMessage, { type: 'startNewTask' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'StartNewTask', corrId, sessionPath: msg.sessionPath },
    });
  }

  private onContinueTask(msg: Extract<WebviewToHostMessage, { type: 'continueTask' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'ContinueTask', corrId, sessionPath: msg.sessionPath },
    });
  }

  private onSetModel(msg: Extract<WebviewToHostMessage, { type: 'setModel' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'SetModel',
        corrId: crypto.randomUUID(),
        sessionPath: msg.sessionPath || '',
        modelSettings: {
          defaultModel: msg.defaultModel,
          defaultProvider: msg.defaultProvider,
          defaultThinkingLevel: msg.defaultThinkingLevel,
        },
      },
    });
  }

  private onOpenFileDiff(msg: Extract<WebviewToHostMessage, { type: 'openFileDiff' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFileDiff', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath, status: 'modified' },
    });
    // Viewing the diff marks the file read (email-like: opening = read).
    this.markFileViewedRead(msg.sessionPath, msg.filePath);
  }

  private async onOpenFileInEditor(msg: Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFileInEditor', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath },
    });
    // Viewing the file marks it read (email-like: opening = read).
    this.markFileViewedRead(msg.sessionPath, msg.filePath);
  }

  /** Mark a changed file read as a side effect of viewing it (open diff /
   *  open in editor). Dispatches a pure `SetFileRead` command; the reducer
   *  owns the read-set mutation and `dispatchArchEvent` schedules the render. */
  private markFileViewedRead(sessionPath: string, filePath: string): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetFileRead', corrId: crypto.randomUUID(), sessionPath, filePath, read: true },
    });
  }

  private onSetFileRead(msg: Extract<WebviewToHostMessage, { type: 'setFileRead' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetFileRead', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, filePath: msg.filePath, read: msg.read },
    });
  }

  private onSetSystemPromptToggles(msg: Extract<WebviewToHostMessage, { type: 'setSystemPromptToggles' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'SetSystemPromptToggles',
        corrId: crypto.randomUUID(),
        sessionPath: msg.sessionPath,
        disabledEntries: [...msg.disabledEntries],
      },
    });
    this.scheduleRender();
  }

  private onRevertFile(msg: Extract<WebviewToHostMessage, { type: 'revertFile' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RevertFile', corrId, sessionPath: msg.sessionPath, filePath: msg.filePath },
    });
    this.dispatchEvent({ kind: 'FileChangeRemoved', sessionPath: msg.sessionPath, filePath: msg.filePath });
    this.scheduleRender();
  }

  private onSetPrefs(msg: Extract<WebviewToHostMessage, { type: 'setPrefs' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetPrefs', corrId: crypto.randomUUID(), prefs: msg.prefs },
    });
  }

  private async onSetPruningSettings(msg: Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetPruningSettings', corrId, settings: msg.settings },
    });
    this.scheduleRender();
  }

  private async onSetToolResultPruningSettings(msg: Extract<WebviewToHostMessage, { type: 'setToolResultPruningSettings' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetToolResultPruningSettings', corrId, settings: msg.settings },
    });
    this.scheduleRender();
  }

  private onStartEdit(msg: Extract<WebviewToHostMessage, { type: 'startEdit' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: msg.sessionPath, messageId: msg.messageId },
    });
  }

  private onCancelEdit(msg: Extract<WebviewToHostMessage, { type: 'cancelEdit' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetEditingMessage', corrId, sessionPath: msg.sessionPath, messageId: null },
    });
  }

  private onDismissNotice(): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'DismissNotice', corrId },
    });
  }

  private onOpenOutcomeDialog(msg: Extract<WebviewToHostMessage, { type: 'openOutcomeDialog' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: msg.sessionPath, visible: true },
    });
  }

  private onCloseOutcomeDialog(msg: Extract<WebviewToHostMessage, { type: 'closeOutcomeDialog' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetOutcomeDialog', corrId, sessionPath: msg.sessionPath, visible: false },
    });
  }

  private onStateApplied(msg: Extract<WebviewToHostMessage, { type: 'stateApplied' }>): void {
    bootLog('webview', 'state.applied', { ...msg.payload });
  }

  private onSetFileChangesExpanded(msg: Extract<WebviewToHostMessage, { type: 'setFileChangesExpanded' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetFileChangesExpanded', corrId, sessionPath: msg.sessionPath, expanded: msg.expanded },
    });
  }

  private async onExtensionUiResponse(msg: Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>): Promise<void> {
    // STATE_CONTRACT: webview must address its response to a specific session.
    // Falling back to the active session would let a prompt opened in tab A be
    // resolved against tab B if the user switched tabs before clicking.
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: extensionUiResponse arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RespondExtensionUI', corrId, sessionPath, requestId: msg.response.id, approved: msg.response.confirmed === true, response: msg.response },
    });
  }

  // ── Brief H: recovery action handlers (side-effect only) ────────────────

  /** `showLogs` — reveal the pie OutputChannel so the user can inspect
   *  diagnostics after a malformed-response / backend-exit error. The channel
   *  is created lazily on first request and reused. Pure side effect: no
   *  reducer event, no notice change. */
  private onShowLogs(): void {
    showPieLogs(true);
  }

  /** `log` — forward a webview-originated log through the host logger
   *  (`appendPieLog` → the `pie` OutputChannel / pie.log) so webview logs are
   *  durable and visible without opening devtools. The webview cannot import
   *  host utilities, so it posts a `log` message (see `webview/panel/utils/log.ts`);
   *  this is the host-side sink. Severity is carried in the message (`warn` |
   *  `error`) and attributed to the `webview` scope. */
  private onLog(msg: Extract<WebviewToHostMessage, { type: 'log' }>): void {
    appendPieLog(msg.level, 'webview', msg.message, msg.data);
  }

  /** `openSettings` — open the pruning settings file (`settings.json` in
   *  `PI_CODING_AGENT_DIR`) so the user can adjust `prepassTimeoutSec` / mode
   *  after a timeout. Falls back to the VS Code Settings UI filtered to "pie"
   *  when the settings file path cannot be resolved. */
  private async onOpenSettings(): Promise<void> {
    const settingsPath = resolveSettingsPath();
    if (settingsPath) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(settingsPath));
        await vscode.window.showTextDocument(doc);
        return;
      } catch (err) {
        bootLog('webview', 'openSettings.openFileFailed', { settingsPath, error: String(err) });
      }
    }
    await vscode.commands.executeCommand('workbench.action.openSettings', 'pie');
  }

  /** `restartBackend` — re-run the registered `pie.restartBackend` command
   *  after a backend-exit error. The command owns the full restart lifecycle. */
  private async onRestartBackend(): Promise<void> {
    await vscode.commands.executeCommand('pie.restartBackend');
  }

  /** `retrySend` — re-send the draft text (composer draft + inputs were
   *  restored on rollback). When `disablePruning` is set, disable pruning
   *  (`mode: 'off'`) BEFORE re-sending so the slow prepass is skipped —
   *  atomically, on the host, to avoid a race where the send's prepass reads
   *  stale settings. Delegates to {@link onSend} so the optimistic message,
   *  session-name derivation, and input pickup are identical to a fresh send. */
  private async onRetrySend(msg: Extract<WebviewToHostMessage, { type: 'retrySend' }>): Promise<void> {
    let priorPruningMode: PruningMode | undefined;
    if (msg.disablePruning) {
      // Brief H: capture the user's prior pruning mode BEFORE disabling, so the
      //   host restores it once the retried send resolves (commit / fire /
      //   pre-ack failure — handled by the EffectRunner's in-flight send via
      //   `restorePruningMode`; or the backend-ready-watchdog drop for a queued
      //   retry that never recovers). Only capture+disable when pruning isn't
      //   already off: a chained retry-without-pruning (a second click while the
      //   first is still in flight) would otherwise capture 'off' and restore to
      //   'off' permanently. The first retry's restore covers the original
      //   mode. (A concurrent retry whose commit fires mid a second retry's
      //   prepass is a narrow remaining race — the original mode is restored
      //   correctly, but the second retry's prepass may run with pruning on.)
      const currentMode = this.getArchState().settings.pruningSettings.mode;
      if (currentMode !== 'off') {
        priorPruningMode = currentMode;
        try {
          await this.service.setPruningSettings({ mode: 'off' });
        } catch (err) {
          bootLog('webview', 'retrySend.disablePruningFailed', { error: String(err) });
        }
      }
    }
    await this.onSend(
      {
        type: 'send',
        sessionPath: msg.sessionPath,
        text: msg.text,
        localId: msg.localId,
      },
      priorPruningMode !== undefined ? { priorPruningMode } : undefined,
    );
  }

  /** `cancelDeferredTrigger` — cancel a deferred trigger (or all for the
   *  session when `triggerId` is omitted) from the webview's status-strip
   *  cancel affordance. Side-effect only (no reducer event): the registry
   *  owns the in-memory set + sidecar op, and requests its own re-render. */
  private onCancelDeferredTrigger(msg: Extract<WebviewToHostMessage, { type: 'cancelDeferredTrigger' }>): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: cancelDeferredTrigger arrived without a sessionPath.' });
      return;
    }
    this.service.cancelDeferredTrigger(sessionPath, msg.triggerId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up a session from the arch state by path.
   */
  private getSessionByPath(path: string | null | undefined): SessionSummary | null {
    if (!path) return null;
    return this.getArchState().sessions.sessions.find(s => s.path === path) ?? null;
  }
}
