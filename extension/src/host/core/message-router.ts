import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import type { WebviewToHostMessage, SessionSummary, ChatPrefs, DetailResult, LazyDetailRef, PruningSettings, SessionTitlesSettings, ToolResultPruningSettings, PruningMode, RendererCommandContext } from '../../shared/protocol';
import type { Event } from './events';
import type { ArchState } from './reducer';
import { bootLog } from '../util/audit';
import { appendPieError, appendPieLog, showPieLogs } from '../util/pie-log';
import { buildOptimisticUserParts, buildPromptText } from './composer';
import { resolveSettingsPath } from '../util/settings-path';
import { NEW_SESSION_NAME } from '../../shared/session-name';
import { operationSourceFromRenderer } from './operation-types.js';

/** Minimal sidebar provider surface the router needs. */
export interface SidebarProviderLike {
  reveal(): void;
  postState(): void;
  postSelectionState?(): void;
  postImperative(msg: any): void;
  /** Renderer-scoped immediate snapshot (browser server plan §4.1): handshake
   *  messages answer their OWN renderer, not the sidebar. */
  requestState?(rendererId?: string): void;
  /** Renderer-scoped imperative (browser server plan §4.4): lazy-detail
   *  responses answer the INITIATING renderer, not the sidebar. */
  postImperativeToRenderer?(rendererId: string, msg: any): void;
}

/** Minimal session-service surface the router needs. */
export interface SessionServiceLike {
  bumpSessionDataEpoch(sessionPath: string): void;
  addFilesystemPaths(requestedSessionPath: string | undefined, paths: string[], source: 'picker' | 'drop'): Promise<void>;
  createNewSession(source?: RendererCommandContext): string;
  openSession(sessionPath: string, source?: RendererCommandContext, causalParentOperationId?: string): void;
  duplicateSession(sessionPath: string, source?: RendererCommandContext): void;
  retryCreateOperation(operationId: string): boolean;
  getBackendGeneration?(): number;
  loadOlderTranscript(sessionPath?: string): Promise<void>;
  loadNewerTranscript(sessionPath?: string): Promise<void>;
  jumpToLatestTranscript(sessionPath?: string): Promise<void>;
  loadDetail?(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void>;
  setSessionTitlesSettings(updates: Partial<SessionTitlesSettings>): Promise<void>;
  /** Consume `user_input` triggers using the real prompt (no synthetic Send). */
  notifyUserInput(sessionPath: string, corrId: string): void;
  /** Cancel a deferred trigger (or all for `sessionPath` when `triggerId` is
   *  omitted). Invoked by the webview's status-strip cancel affordance. */
  cancelDeferredTrigger(sessionPath: string, triggerId?: string): void;
}

/**
 * Inbound message types whose routing failures must NOT raise a user notice.
 * These are machine-generated transport/render evidence, handshake traffic and
 * webview log forwarding — a notice for them would be noise, not signal.
 */
const SILENT_ROUTE_FAILURE_TYPES: ReadonlySet<WebviewToHostMessage['type']> = new Set([
  'ready',
  'refreshState',
  'requestSnapshot',
  'stateReceived',
  'appCommitted',
  'transcriptCommitted',
  'transcriptCommitBlocked',
  'paintObserved',
  'renderFailure',
  'log',
]);

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
  private readonly recentCloseInteractionIds = new Set<string>();
  private readonly closeInteractionOrder: string[] = [];

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

  async handle(msg: WebviewToHostMessage, context?: RendererCommandContext): Promise<void> {
    try {
      await this.routeMessage(msg, context);
    } catch (err) {
      appendPieError('message-router', 'handle failed', err, { messageType: msg?.type });
      // User-initiated send/edit: surface a notice so the failure isn't silent.
      if (msg?.type === 'send' || msg?.type === 'editMessage') {
        this.dispatchEvent({ kind: 'NoticeShown', notice: 'Failed to process your message. See the pie log for details.' });
      } else if (!SILENT_ROUTE_FAILURE_TYPES.has(msg?.type as WebviewToHostMessage['type'])) {
        // Every other route is user-initiated too (interrupt, openSession,
        // requestDetail, setModel, addPaths, ...). Without a notice the UI
        // simply does nothing and the user has no signal that the action
        // failed. Transport/render-evidence and log messages are excluded:
        // they are machine-generated and a notice would be pure noise.
        this.dispatchEvent({ kind: 'NoticeShown', notice: 'That action could not be completed. See the pie log for details.' });
      }
    }
  }

  private async routeMessage(msg: WebviewToHostMessage, context?: RendererCommandContext): Promise<void> {
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
        return this.onReady(context);

      case 'refreshState':
        return await this.onRefreshState(context);

      case 'requestSnapshot':
        return this.onRequestSnapshot(context);

      case 'send':
        return await this.onSend(msg as Extract<WebviewToHostMessage, { type: 'send' }>, undefined, context);

      case 'editMessage':
        return await this.onEditMessage(msg as Extract<WebviewToHostMessage, { type: 'editMessage' }>, context);

      case 'interrupt':
        return this.onInterrupt(msg as Extract<WebviewToHostMessage, { type: 'interrupt' }>, context);
      case 'compact':
        return this.onCompact(msg as Extract<WebviewToHostMessage, { type: 'compact' }>, context);
      case 'clearQueue':
        return this.onClearQueue(msg as Extract<WebviewToHostMessage, { type: 'clearQueue' }>, context);

      case 'openFilePicker':
        return await this.onOpenFilePicker();

      case 'addComposerInput':
        return await this.onAddComposerInput(msg as Extract<WebviewToHostMessage, { type: 'addComposerInput' }>);

      case 'setComposerDraft':
        return this.onSetComposerDraft(msg as Extract<WebviewToHostMessage, { type: 'setComposerDraft' }>);

      case 'removeComposerInput':
        return this.onRemoveComposerInput(msg as Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>);

      case 'openFile':
        return await this.onOpenFile(msg as Extract<WebviewToHostMessage, { type: 'openFile' }>, context);

      case 'newSession':
        return this.onNewSession(context);

      case 'openSession':
        return this.onOpenSession(msg as Extract<WebviewToHostMessage, { type: 'openSession' }>, context);

      case 'closeSession':
        return await this.onCloseSession(msg as Extract<WebviewToHostMessage, { type: 'closeSession' }>, context);

      case 'requestDetail':
        return await this.onRequestDetail(msg as Extract<WebviewToHostMessage, { type: 'requestDetail' }>, context);

      case 'detail.subscribe':
        return this.onDetailSubscribe(msg as Extract<WebviewToHostMessage, { type: 'detail.subscribe' }>, context);

      case 'detail.unsubscribe':
        return this.onDetailUnsubscribe(msg as Extract<WebviewToHostMessage, { type: 'detail.unsubscribe' }>, context);

      case 'detail.fetchPages':
        return this.onDetailFetchPages(msg as Extract<WebviewToHostMessage, { type: 'detail.fetchPages' }>, context);

      case 'duplicateSession':
        return await this.onDuplicateSession(msg as Extract<WebviewToHostMessage, { type: 'duplicateSession' }>, context);

      case 'retryCreateOperation':
        this.service.retryCreateOperation(msg.operationId);
        return;

      case 'moveSessionTab':
        return this.onMoveSessionTab(msg as Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>);

      case 'togglePinTab':
        return this.onTogglePinTab(msg as Extract<WebviewToHostMessage, { type: 'togglePinTab' }>);
      case 'pinAndMergePinnedTab':
        return this.onPinAndMergePinnedTab(msg as Extract<WebviewToHostMessage, { type: 'pinAndMergePinnedTab' }>);
      case 'groupPinnedTab':
        return this.onGroupPinnedTab(msg as Extract<WebviewToHostMessage, { type: 'groupPinnedTab' }>, context);
      case 'mergePinnedGroups':
        return this.onMergePinnedGroups(msg as Extract<WebviewToHostMessage, { type: 'mergePinnedGroups' }>, context);
      case 'ungroupPinnedTab':
        return this.onUngroupPinnedTab(msg as Extract<WebviewToHostMessage, { type: 'ungroupPinnedTab' }>, context);
      case 'dissolvePinnedGroup':
        return this.onDissolvePinnedGroup(msg as Extract<WebviewToHostMessage, { type: 'dissolvePinnedGroup' }>, context);
      case 'unpinPinnedGroup':
        return this.onUnpinPinnedGroup(msg as Extract<WebviewToHostMessage, { type: 'unpinPinnedGroup' }>, context);
      case 'movePinnedItem':
        return this.onMovePinnedItem(msg as Extract<WebviewToHostMessage, { type: 'movePinnedItem' }>, context);

      case 'loadOlderTranscript':
        return await this.onLoadOlderTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>, context);

      case 'loadNewerTranscript':
        return await this.onLoadNewerTranscript(msg as Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>, context);

      case 'jumpToLatestTranscript':
        return await this.onJumpToLatestTranscript(msg as Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>, context);

      case 'startNewTask':
        return this.onStartNewTask(msg as Extract<WebviewToHostMessage, { type: 'startNewTask' }>);

      case 'continueTask':
        return this.onContinueTask(msg as Extract<WebviewToHostMessage, { type: 'continueTask' }>);

      case 'setModel':
        return this.onSetModel(msg as Extract<WebviewToHostMessage, { type: 'setModel' }>, context);

      case 'openFileDiff':
        return await this.onOpenFileDiff(msg as Extract<WebviewToHostMessage, { type: 'openFileDiff' }>);

      case 'openFileInEditor':
        return await this.onOpenFileInEditor(msg as Extract<WebviewToHostMessage, { type: 'openFileInEditor' }>);

      case 'revertFile':
        return await this.onRevertFile(msg as Extract<WebviewToHostMessage, { type: 'revertFile' }>, context);

      case 'truncateAfter':
        return this.onTruncateAfter(msg as Extract<WebviewToHostMessage, { type: 'truncateAfter' }>, context);

      case 'setFileRead':
        return this.onSetFileRead(msg as Extract<WebviewToHostMessage, { type: 'setFileRead' }>);

      case 'setSystemPromptToggles':
        return this.onSetSystemPromptToggles(msg as Extract<WebviewToHostMessage, { type: 'setSystemPromptToggles' }>);

      case 'setPrefs':
        return this.onSetPrefs(msg as Extract<WebviewToHostMessage, { type: 'setPrefs' }>);

      case 'mcpListRequested':
        return this.onMcpListRequested(msg as Extract<WebviewToHostMessage, { type: 'mcpListRequested' }>);

      case 'mcpSetServerEnabled':
        return this.onMcpSetServerEnabled(msg as Extract<WebviewToHostMessage, { type: 'mcpSetServerEnabled' }>);

      case 'mcpSetServerEnabledForSession':
        return this.onMcpSetServerEnabledForSession(msg as Extract<WebviewToHostMessage, { type: 'mcpSetServerEnabledForSession' }>, context);

      case 'setPrivacyMode':
        return this.onSetPrivacyMode(msg as Extract<WebviewToHostMessage, { type: 'setPrivacyMode' }>, context);

      case 'setPruningSettings':
        return await this.onSetPruningSettings(msg as Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>);

      case 'setToolResultPruningSettings':
        return await this.onSetToolResultPruningSettings(msg as Extract<WebviewToHostMessage, { type: 'setToolResultPruningSettings' }>);

      case 'setSessionTitlesSettings':
        return await this.onSetSessionTitlesSettings(msg as Extract<WebviewToHostMessage, { type: 'setSessionTitlesSettings' }>);

      case 'startEdit':
        return this.onStartEdit(msg as Extract<WebviewToHostMessage, { type: 'startEdit' }>);

      case 'cancelEdit':
        return this.onCancelEdit(msg as Extract<WebviewToHostMessage, { type: 'cancelEdit' }>);

      case 'dismissNotice':
        return this.onDismissNotice();

      case 'stateReceived':
      case 'appCommitted':
      case 'transcriptCommitted':
      case 'transcriptCommitBlocked':
      case 'paintObserved':
      case 'renderFailure':
        // SidebarViewProvider owns transport/render evidence. It forwards the
        // message here only to keep one inbound routing path; no reducer event
        // or side effect belongs to application state.
        return;

      case 'extensionUiResponse':
        return await this.onExtensionUiResponse(msg as Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>, context);

      case 'setFileChangesExpanded':
        return this.onSetFileChangesExpanded(msg as Extract<WebviewToHostMessage, { type: 'setFileChangesExpanded' }>);

      // ── Recovery actions surfaced from an error notice. These are
      //    side-effect-only (no reducer event), mirroring openFilePicker/openFile.
      case 'showLogs':
        return this.onShowLogs();

      case 'openSettings':
        return this.onOpenSettings();

      case 'restartBackend':
        return this.onRestartBackend(context);

      case 'retrySend':
        return await this.onRetrySend(msg as Extract<WebviewToHostMessage, { type: 'retrySend' }>, context);

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

  /** Command-level rejection reporting for browser sources (browser server
   *  plan §5.2): the browser command gate records exactly one `rejected`
   *  decision + ack. The trusted sidebar has no hook and is unaffected. */
  private rejectBrowser(msg: { type: string }, context: RendererCommandContext | undefined, reason: string): void {
    context?.onBrowserCommandRejected?.(msg.type, reason);
  }

  private postStateFor(context: RendererCommandContext | undefined): void {
    if (this.sidebarProvider.requestState && context?.rendererId) {
      this.sidebarProvider.requestState(context.rendererId);
      return;
    }
    this.sidebarProvider.postState();
  }

  private onReady(context?: RendererCommandContext): void {
    // A running tab may have been absent from the persisted open-tab list
    // during renderer reload. Host-owned live state never left ArchState, so
    // repairing an unmarked omission is a cheap tab projection repair, not a
    // reopen RPC.
    //
    // Every explicit running-tab close is intentional, whether it came from
    // ordinary user interaction or a durable review closure. Preserve that
    // host-owned intent across renderer reloads; only an unmarked omission is
    // repaired here.
    const arch = this.getArchState();
    const hiddenRunning = arch.sessions.runningSessionPaths.filter(
      (sessionPath) => !arch.sessions.openTabPaths.includes(sessionPath)
        && !arch.sessions.intentionallyHiddenRunningPaths.includes(sessionPath),
    );
    for (const sessionPath of hiddenRunning) {
      this.dispatchEvent({ kind: 'TabOpened', sessionPath });
    }
    if (!arch.sessions.activeSessionPath && hiddenRunning[0]) {
      this.dispatchEvent({
        kind: 'Command',
        cmd: { kind: 'SelectSession', corrId: crypto.randomUUID(), sessionPath: hiddenRunning[0] },
      });
    }
    // Handshake answers are renderer-scoped (browser server plan §4.1): the
    // readying renderer gets the snapshot, not the sidebar.
    this.postStateFor(context);
  }

  private async onRefreshState(context?: RendererCommandContext): Promise<void> {
    const activeSessionPath = this.getArchState().sessions.activeSessionPath;
    if (activeSessionPath && !this.isPendingTabPathFn(activeSessionPath)) {
      // Route through the CQRS reducer + effect runner instead of
      // calling the service directly. The HydrateModel effect is fire-and-forget;
      // the service's dispatched ModelSettingsHydrated/AvailableModelsChanged events apply
      // the results.
      this.dispatchEvent({
        kind: 'Command',
        cmd: { kind: 'HydrateModel', corrId: crypto.randomUUID(), sessionPath: activeSessionPath },
      });
    }
    this.postStateFor(context);
  }

  private onRequestSnapshot(context?: RendererCommandContext): void {
    this.postStateFor(context);
  }

  private onCompact(msg: Extract<WebviewToHostMessage, { type: 'compact' }>, context?: RendererCommandContext): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'Compact', corrId, operationId: crypto.randomUUID(), operationAttempt: 1,
        operationSource: operationSourceFromRenderer(context),
        backendGeneration: this.service.getBackendGeneration?.() ?? 0,
        sessionPath: msg.sessionPath,
      },
    });
  }

  private async onSend(msg: Extract<WebviewToHostMessage, { type: 'send' }>, opts?: { priorPruningMode?: PruningMode }, context?: RendererCommandContext): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const webviewLocalId = msg.localId;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: send arrived without a sessionPath.' });
      return;
    }

    // All sends — pending tab, backend-not-ready, or normal — go through the
    // Send Command. The reducer decides: pending paths queue into
    // sendQueueBySession (drained on PendingPathReplaced); !backendReady queues
    // into backendReadyQueueBySession (drained on BackendReadyChanged{ready:true});
    // otherwise the normal path (SendRpc). The optimistic message insert + draft
    // clear + session-name derivation happen uniformly in the reducer / onSend.

    const archState = this.getArchState();
    if (!archState.sessions.openTabPaths.includes(sessionPath)) {
      this.rejectBrowser(msg, context, 'session-not-open');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot send: the selected session is no longer open.' });
      return;
    }

    const inputs = [
      ...(archState.composer.pendingComposerInputsBySession[sessionPath] ?? []),
    ];
    const ambiguousSend = Object.values(archState.operations ?? {}).find((operation) =>
      operation.kind === 'message.send'
      && !operation.terminal
      && (operation.phase === 'ambiguous' || operation.commit === 'unknown')
      && (operation.session.resolvedPath ?? operation.session.pendingPath) === sessionPath,
    );
    if (ambiguousSend) {
      this.rejectBrowser(msg, context, 'send-outcome-ambiguous');
      const rejected = {
        type: 'sendRejected' as const,
        sessionPath,
        text,
        ...(webviewLocalId ? { localId: webviewLocalId } : {}),
        inputs,
      };
      if (context?.rendererId && this.sidebarProvider.postImperativeToRenderer) {
        this.sidebarProvider.postImperativeToRenderer(context.rendererId, rejected);
      } else {
        this.sidebarProvider.postImperative(rejected);
      }
      return;
    }
    if (!text.trim() && inputs.length === 0) {
      // Codex-style continuation: an empty submit is an execution command, not
      // an empty user message. It deliberately bypasses the normal Send path,
      // so there is no optimistic user row, prompt expansion, or skill-pruning
      // prepass. The backend remains authoritative about whether the durable
      // tail is actually an interrupted assistant turn.
      this.dispatchEvent({
        kind: 'Command',
        cmd: {
          kind: 'Continue',
          corrId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          operationAttempt: 1,
          operationSource: operationSourceFromRenderer(context),
          backendGeneration: this.service.getBackendGeneration?.() ?? 0,
          sessionPath,
        },
      });
      return;
    }

    // Pre-compute values the reducer needs.
    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const localId = webviewLocalId ?? `local:${crypto.randomUUID()}`;

    // Show a literal first-prompt snippet immediately. It remains replaceable
    // until the asynchronous title model writes a durable session name.
    let previousSummary = null as SessionSummary | null;
    const session = this.getSessionByPath(sessionPath);
    if (session?.isPlaceholder && session.name === NEW_SESSION_NAME) {
      const derived = this.deriveSessionNameFromTextFn(composedText);
      if (derived.name !== session.name) {
        previousSummary = session;
        this.dispatchEvent({
          kind: 'SessionNameDerived',
          sessionPath,
          name: derived.name,
          isPlaceholder: derived.isPlaceholder,
          sourcePrompt: composedText,
        });
        this.scheduleRender();
      }
    }

    // Dispatch through CQRS spine.
    const corrId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'Send', corrId, operationId, operationAttempt: 1,
        operationSource: operationSourceFromRenderer(context),
        backendGeneration: this.service.getBackendGeneration?.() ?? 0, sessionPath, text, inputs,
        composedText, localId, userParts, previousSummary,
        priorPruningMode: opts?.priorPruningMode, timestamp: Date.now(),
      },
    });
    // After the real message is dispatched, durably consume any `user_input`
    // trigger for this session. The real prompt is itself the wake-up; the
    // registry must not inject a second synthetic Send.
    this.service.notifyUserInput(sessionPath, corrId);
  }

  private async onEditMessage(msg: Extract<WebviewToHostMessage, { type: 'editMessage' }>, context?: RendererCommandContext): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: editMessage arrived without a sessionPath.' });
      return;
    }
    const inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
    if ((!text.trim() && inputs.length === 0) || !messageId) {
      this.rejectBrowser(msg, context, 'empty-edit');
      return;
    }

    // Pre-flight validation.
    if (this.isPendingTabPathFn(sessionPath)) {
      this.rejectBrowser(msg, context, 'session-still-opening');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the session is still opening.' });
      return;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.rejectBrowser(msg, context, 'session-not-open');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot edit: the selected session is no longer open.' });
      return;
    }

    const composedText = buildPromptText(text, inputs);
    const userParts = buildOptimisticUserParts(text, inputs);
    const corrId = crypto.randomUUID();
    const target = this.getArchState().transcript.bySession[sessionPath]?.find((message) => message.id === messageId);

    if (msg.queued || (target?.role === 'user' && target.status === 'queued')) {
      if (target?.role !== 'user' || target.status !== 'queued') {
        this.rejectBrowser(msg, context, 'queued-message-already-delivered');
        this.dispatchEvent({
          kind: 'Command',
          cmd: { kind: 'SetEditingMessage', corrId, sessionPath, messageId: null },
        });
        this.dispatchEvent({ kind: 'NoticeShown', notice: 'That queued message was already delivered and can no longer be edited in place.' });
        return;
      }
      this.dispatchEvent({
        kind: 'Command',
        cmd: { kind: 'EditQueued', corrId, sessionPath, messageId, text, inputs, composedText, userParts },
      });
      return;
    }

    const webviewLocalId = msg.localId;
    const localId = webviewLocalId ?? `local:edit:${crypto.randomUUID()}`;

    // Assign operation identity once at trusted ingress. Retries and status
    // reconciliation retain this identity while corrId remains presentation-only.
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'Edit', corrId, operationId: crypto.randomUUID(), operationAttempt: 1,
        operationSource: operationSourceFromRenderer(context),
        backendGeneration: this.service.getBackendGeneration?.() ?? 0,
        sessionPath, messageId, text, inputs, composedText, userParts, localId, timestamp: Date.now(),
      },
    });
  }

  private onInterrupt(msg: Extract<WebviewToHostMessage, { type: 'interrupt' }>, context?: RendererCommandContext): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: interrupt arrived without a sessionPath.' });
      return;
    }
    // Route through the CQRS reducer + effect runner.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'Interrupt', corrId, operationId: crypto.randomUUID(), operationAttempt: 1,
        operationSource: operationSourceFromRenderer(context),
        backendGeneration: this.service.getBackendGeneration?.() ?? 0,
        sessionPath,
      },
    });
    // Completion-notification suppression is now set in the EffectRunner's
    // InterruptRpc path (the side-effect executor), not as a router side-call.
  }

  private onClearQueue(msg: Extract<WebviewToHostMessage, { type: 'clearQueue' }>, context?: RendererCommandContext): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
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

  private async onOpenFile(msg: Extract<WebviewToHostMessage, { type: 'openFile' }>, context?: RendererCommandContext): Promise<void> {
    if (typeof msg.path !== 'string' || !msg.path.trim()) {
      this.rejectBrowser(msg, context, 'missing-path');
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'OpenFile', corrId, path: msg.path },
    });
  }

  private onNewSession(context?: RendererCommandContext): void {
    // The service generates the impure pending path + placeholder summary,
    // mints the selection token (before the reducer activates the pending tab
    // so failure recovery can restore the previous active path), and dispatches
    // the CreateSession Command. The reducer owns the optimistic tab setup.
    this.service.createNewSession(context);
    // The optimistic tab is a selection, just like opening an existing one.
    // Do not wait for the previous transcript's commit before showing it.
    if (this.sidebarProvider.postSelectionState) this.sidebarProvider.postSelectionState();
    else this.sidebarProvider.postState();
  }

  private onOpenSession(
    msg: Extract<WebviewToHostMessage, { type: 'openSession' }>,
    context?: RendererCommandContext,
  ): void {
    // The service mints the data epoch + selection token (before the reducer
    // activates the opened tab so failure recovery can restore the previous
    // active path) + builds the placeholder summary, and dispatches the
    // OpenSession Command. The reducer owns the optimistic tab setup. Mirrors
    // onNewSession -> service.createNewSession(). The previous path dispatched
    // the OpenSession Command directly with a fake random selectionToken that
    // was never registered with beginSelectionRequest, so handleSelectionFailure
    // could not restore the previous active tab on failure.
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.service.openSession(msg.sessionPath, context);
    // Explicit selection is interaction-critical: do not make it wait behind
    // an accepted streaming snapshot's transcript-commit gate.
    if (this.sidebarProvider.postSelectionState) this.sidebarProvider.postSelectionState();
    else this.sidebarProvider.postState();
  }

  private onDuplicateSession(msg: Extract<WebviewToHostMessage, { type: 'duplicateSession' }>, context?: RendererCommandContext): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
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
    this.service.duplicateSession(sessionPath, context);
    if (this.sidebarProvider.postSelectionState) this.sidebarProvider.postSelectionState();
    else this.sidebarProvider.postState();
  }

  private onCloseSession(
    msg: Extract<WebviewToHostMessage, { type: 'closeSession' }>,
    context?: RendererCommandContext,
  ): void {
    if (msg.interactionId) {
      if (this.recentCloseInteractionIds.has(msg.interactionId)) return;
      this.recentCloseInteractionIds.add(msg.interactionId);
      this.closeInteractionOrder.push(msg.interactionId);
      if (this.closeInteractionOrder.length > 128) {
        const retired = this.closeInteractionOrder.shift();
        if (retired) this.recentCloseInteractionIds.delete(retired);
      }
    }
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'CloseSession',
        corrId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        operationAttempt: 1,
        operationSource: operationSourceFromRenderer(context),
        backendGeneration: this.service.getBackendGeneration?.() ?? 0,
        sessionPath: msg.sessionPath,
      },
    });
    this.dispatchEvent({ kind: 'Command', cmd: { kind: 'SetEditingMessage', corrId: crypto.randomUUID(), sessionPath: msg.sessionPath, messageId: null } });
    this.sidebarProvider.postState();
  }

  private async onRequestDetail(
    msg: Extract<WebviewToHostMessage, { type: 'requestDetail' }>,
    context?: RendererCommandContext,
  ): Promise<void> {
    let result: DetailResult;
    try {
      result = this.service.loadDetail
        ? await this.service.loadDetail(msg.sessionPath, msg.ref)
        : { sessionPath: msg.sessionPath, key: msg.ref.key, status: 'unavailable', message: 'Detail retrieval is unavailable.' };
    } catch (error) {
      // Always settle the initiating card, even if an unexpected service
      // exception escapes its ordinary error normalization. The outer router
      // catch can show a notice, but it cannot release the webview's serialized
      // lazy-detail lane without this key-scoped terminal result.
      appendPieError('message-router', 'detail request failed', error, {
        sessionPath: msg.sessionPath,
        detailKey: msg.ref.key,
      });
      result = {
        sessionPath: msg.sessionPath,
        key: msg.ref.key,
        status: 'failure',
        message: 'Could not load details. Retry to try again.',
      };
    }
    // Lazy-detail responses are renderer-scoped (browser server plan §4.4):
    // the INITIATING renderer gets the result, never a broadcast to the
    // sidebar. A browser expanding a tool detail must not hang waiting for a
    // response that was posted to the sidebar hub.
    if (context?.rendererId && this.sidebarProvider.postImperativeToRenderer) {
      this.sidebarProvider.postImperativeToRenderer(context.rendererId, { type: 'detailResult', result });
      return;
    }
    this.sidebarProvider.postImperative({ type: 'detailResult', result });
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

  private onPinAndMergePinnedTab(msg: Extract<WebviewToHostMessage, { type: 'pinAndMergePinnedTab' }>): void {
    // Pure state mutation — no service / backend RPC. The reducer pins the tab
    // and groups it with the leftmost pinned item, then emits a PersistTabs
    // effect. Mirrors onTogglePinTab.
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'PinAndMergePinnedTab', corrId, sessionPath: msg.sessionPath },
    });
    this.sidebarProvider.postState();
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  /** A finite, nonnegative integer — the only acceptable `toItemIndex` for a
   *  pinned-item gap drop. Rejects NaN, ±Infinity, negatives, and fractions
   *  before they reach the reducer (the helpers clamp defensively, but a
   *  malformed index from a stale/out-of-sync webview is a protocol defect). */
  private isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }

  private onGroupPinnedTab(msg: Extract<WebviewToHostMessage, { type: 'groupPinnedTab' }>, context?: RendererCommandContext): void {
    // Pure state mutation — the reducer joins the source pinned tab to the
    // target's group (creating one if the target is standalone) and emits a
    // PersistTabs effect. No backend RPC.
    if (!this.isNonEmptyString(msg.sourcePath) || !this.isNonEmptyString(msg.targetPath)) {
      this.rejectBrowser(msg, context, 'invalid-paths');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: groupPinnedTab arrived without a sourcePath or targetPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'GroupPinnedTab', corrId, sourcePath: msg.sourcePath, targetPath: msg.targetPath },
    });
    this.sidebarProvider.postState();
  }

  private onMergePinnedGroups(msg: Extract<WebviewToHostMessage, { type: 'mergePinnedGroups' }>, context?: RendererCommandContext): void {
    // Pure state mutation — the reducer merges the source group into the
    // target group (target members then source members) and emits a
    // PersistTabs effect. No backend RPC.
    if (!this.isNonEmptyString(msg.sourcePath) || !this.isNonEmptyString(msg.targetPath)) {
      this.rejectBrowser(msg, context, 'invalid-paths');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: mergePinnedGroups arrived without a sourcePath or targetPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'MergePinnedGroups', corrId, sourcePath: msg.sourcePath, targetPath: msg.targetPath },
    });
    this.sidebarProvider.postState();
  }

  private onUngroupPinnedTab(msg: Extract<WebviewToHostMessage, { type: 'ungroupPinnedTab' }>, context?: RendererCommandContext): void {
    // Pure state mutation — the reducer removes the source from its group
    // (dissolving it below 2) and repositions it as a standalone pinned tab.
    // No backend RPC.
    if (!this.isNonEmptyString(msg.sourcePath) || !this.isNonNegativeInteger(msg.toItemIndex)) {
      this.rejectBrowser(msg, context, 'invalid-source-or-index');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: ungroupPinnedTab arrived with an invalid sourcePath or toItemIndex.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'UngroupPinnedTab', corrId, sourcePath: msg.sourcePath, toItemIndex: msg.toItemIndex },
    });
    this.sidebarProvider.postState();
  }

  private onDissolvePinnedGroup(msg: Extract<WebviewToHostMessage, { type: 'dissolvePinnedGroup' }>, context?: RendererCommandContext): void {
    if (!this.isNonEmptyString(msg.sourcePath)) {
      this.rejectBrowser(msg, context, 'invalid-source-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: dissolvePinnedGroup arrived without a sourcePath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'DissolvePinnedGroup', corrId, sourcePath: msg.sourcePath },
    });
    this.sidebarProvider.postState();
  }

  private onUnpinPinnedGroup(msg: Extract<WebviewToHostMessage, { type: 'unpinPinnedGroup' }>, context?: RendererCommandContext): void {
    if (!this.isNonEmptyString(msg.sourcePath)) {
      this.rejectBrowser(msg, context, 'invalid-source-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: unpinPinnedGroup arrived without a sourcePath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'UnpinPinnedGroup', corrId, sourcePath: msg.sourcePath },
    });
    this.sidebarProvider.postState();
  }

  private onMovePinnedItem(msg: Extract<WebviewToHostMessage, { type: 'movePinnedItem' }>, context?: RendererCommandContext): void {
    // Pure state mutation — the reducer reorders a pinned item (standalone
    // chip or group block) within the pinned strip. No backend RPC.
    if (!this.isNonEmptyString(msg.sourcePath) || !this.isNonNegativeInteger(msg.toItemIndex)) {
      this.rejectBrowser(msg, context, 'invalid-source-or-index');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: movePinnedItem arrived with an invalid sourcePath or toItemIndex.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'MovePinnedItem', corrId, sourcePath: msg.sourcePath, toItemIndex: msg.toItemIndex },
    });
    this.sidebarProvider.postState();
  }

  private async onLoadOlderTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadOlderTranscript' }>, context?: RendererCommandContext): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadOlderTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadOlderTranscript', corrId, sessionPath },
    });
  }

  private async onLoadNewerTranscript(msg: Extract<WebviewToHostMessage, { type: 'loadNewerTranscript' }>, context?: RendererCommandContext): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: loadNewerTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'LoadNewerTranscript', corrId, sessionPath },
    });
  }

  private async onJumpToLatestTranscript(msg: Extract<WebviewToHostMessage, { type: 'jumpToLatestTranscript' }>, context?: RendererCommandContext): Promise<void> {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: jumpToLatestTranscript arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'JumpToLatestTranscript', corrId, sessionPath },
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

  private onSetModel(msg: Extract<WebviewToHostMessage, { type: 'setModel' }>, context?: RendererCommandContext): void {
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
        // Trusted source for the M2 inline-confirmation seam: the effect
        // runner asks the INITIATING renderer (browser) instead of showing an
        // invisible desktop modal. Never client-supplied.
        ...(context ? { source: { rendererId: context.rendererId, kind: context.kind, rendererGeneration: context.rendererGeneration } } : {}),
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

  // ─── Detail subscription routing ───────────────────────────────────
  // The webview owns `detailKey`; every message carries its exact renderer
  // `viewGeneration`. Commands flow through the reducer (which stores nothing)
  // to the EffectRunner, which mints the subscription ID and hands the
  // subscription lifecycle to the session service. Stream content returns as
  // detail imperatives carrying the full `HostDetailRoute`.

  private onDetailSubscribe(msg: Extract<WebviewToHostMessage, { type: 'detail.subscribe' }>, context?: RendererCommandContext): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'DetailSubscribe',
        corrId: crypto.randomUUID(),
        viewGeneration: msg.viewGeneration,
        detailKey: msg.detailKey,
        detailAttempt: msg.detailAttempt,
        address: msg.address,
        ...(msg.cursor !== undefined ? { cursor: msg.cursor } : {}),
        // Trusted renderer identity (browser server plan §5.4): the complete
        // ownership key is {hostInstanceId, viewGeneration, rendererId,
        // rendererGeneration, detailKey}. Never client-supplied.
        ...(context ? { rendererId: context.rendererId, rendererGeneration: context.rendererGeneration } : {}),
      },
    });
  }

  private onDetailUnsubscribe(msg: Extract<WebviewToHostMessage, { type: 'detail.unsubscribe' }>, context?: RendererCommandContext): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'DetailUnsubscribe',
        corrId: crypto.randomUUID(),
        viewGeneration: msg.viewGeneration,
        detailKey: msg.detailKey,
        detailAttempt: msg.detailAttempt,
        reason: msg.reason,
        ...(context ? { rendererId: context.rendererId, rendererGeneration: context.rendererGeneration } : {}),
      },
    });
  }

  private onDetailFetchPages(msg: Extract<WebviewToHostMessage, { type: 'detail.fetchPages' }>, context?: RendererCommandContext): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'DetailFetchPages',
        corrId: crypto.randomUUID(),
        viewGeneration: msg.viewGeneration,
        detailKey: msg.detailKey,
        detailAttempt: msg.detailAttempt,
        ref: msg.ref,
        ...(context ? { rendererId: context.rendererId, rendererGeneration: context.rendererGeneration } : {}),
      },
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

  private onRevertFile(msg: Extract<WebviewToHostMessage, { type: 'revertFile' }>, context?: RendererCommandContext): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'RevertFile',
        corrId,
        sessionPath: msg.sessionPath,
        filePath: msg.filePath,
        // Source-aware confirmation (browser server plan §9): a browser
        // source must confirm inline in ITS renderer before the destructive
        // revert runs; never an invisible desktop modal.
        ...(context ? { source: { rendererId: context.rendererId, kind: context.kind, rendererGeneration: context.rendererGeneration } } : {}),
      },
    });
    // The changed-file row is only removed AFTER the revert succeeds — the
    // `FileRevertResult` event carries `filePath` and the reducer drops the
    // matching row on `ok:true`. Removing here (before confirmation/confirm
    // success) made a declined inline confirm or a failed revert lose the
    // row (and the user's read state) despite the file keeping its changes.
    this.scheduleRender();
  }

  /** `truncateAfter` — destructive transcript "Delete from here". Explicitly
   *  session-addressed: verify the session is open and the message still
   *  exists in THAT session before dispatching the `TruncateAfter` command
   *  (never an implicit fallback to the viewed/active session). Browser
   *  rejections are explicit via the browser rejection seam. */
  private onTruncateAfter(msg: Extract<WebviewToHostMessage, { type: 'truncateAfter' }>, context?: RendererCommandContext): void {
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : '';
    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
    if (!sessionPath || !messageId) {
      this.rejectBrowser(msg, context, 'missing-target');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: truncateAfter arrived without a sessionPath or messageId.' });
      return;
    }
    if (this.isPendingTabPathFn(sessionPath)) {
      this.rejectBrowser(msg, context, 'session-still-opening');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot delete from here: the session is still opening.' });
      return;
    }
    if (!this.getArchState().sessions.openTabPaths.includes(sessionPath)) {
      this.rejectBrowser(msg, context, 'session-not-open');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot delete from here: the selected session is no longer open.' });
      return;
    }
    if (messageId.startsWith('local:')) {
      this.rejectBrowser(msg, context, 'non-durable-message');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: truncateAfter arrived for a non-durable message.' });
      return;
    }
    // The message must still exist in the addressed session's transcript — a
    // stale renderer (another renderer truncated, or the row scrolled out of
    // the loaded window then dropped) must reject rather than dispatch a
    // command targeting a vanished entry.
    const target = this.getArchState().transcript.bySession[sessionPath]?.find((message) => message.id === messageId);
    if (!target) {
      this.rejectBrowser(msg, context, 'message-not-found');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Cannot delete from here: that message is no longer in this session\'s transcript.' });
      return;
    }
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'TruncateAfter', corrId: crypto.randomUUID(), sessionPath, messageId },
    });
    this.scheduleRender();
  }

  private onSetPrefs(msg: Extract<WebviewToHostMessage, { type: 'setPrefs' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetPrefs', corrId: crypto.randomUUID(), prefs: msg.prefs },
    });
  }

  private onMcpListRequested(_msg: Extract<WebviewToHostMessage, { type: 'mcpListRequested' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'McpListRequested', corrId: crypto.randomUUID() },
    });
  }

  private onMcpSetServerEnabled(msg: Extract<WebviewToHostMessage, { type: 'mcpSetServerEnabled' }>): void {
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'McpSetServerEnabled',
        corrId: crypto.randomUUID(),
        name: msg.name,
        enabled: msg.enabled,
      },
    });
  }

  private onMcpSetServerEnabledForSession(msg: Extract<WebviewToHostMessage, { type: 'mcpSetServerEnabledForSession' }>, context?: RendererCommandContext): void {
    if (!msg.sessionPath || !this.getArchState().sessions.openTabPaths.includes(msg.sessionPath)) {
      this.rejectBrowser(msg, context, 'session-not-open');
      return;
    }
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'McpSetServerEnabledForSession',
        corrId: crypto.randomUUID(),
        sessionPath: msg.sessionPath,
        name: msg.name,
        enabled: msg.enabled,
      },
    });
  }

  private onSetPrivacyMode(msg: Extract<WebviewToHostMessage, { type: 'setPrivacyMode' }>, context?: RendererCommandContext): void {
    if (!msg.sessionPath || !this.getArchState().sessions.openTabPaths.includes(msg.sessionPath)) {
      this.rejectBrowser(msg, context, 'session-not-open');
      return;
    }
    this.dispatchEvent({
      kind: 'Command',
      cmd: {
        kind: 'SetPrivacyMode',
        corrId: crypto.randomUUID(),
        sessionPath: msg.sessionPath,
        enabled: msg.enabled,
      },
    });
    this.scheduleRender();
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

  private async onSetSessionTitlesSettings(msg: Extract<WebviewToHostMessage, { type: 'setSessionTitlesSettings' }>): Promise<void> {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetSessionTitlesSettings', corrId, settings: msg.settings },
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

  private onSetFileChangesExpanded(msg: Extract<WebviewToHostMessage, { type: 'setFileChangesExpanded' }>): void {
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'SetFileChangesExpanded', corrId, sessionPath: msg.sessionPath, expanded: msg.expanded },
    });
  }

  private async onExtensionUiResponse(msg: Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>, context?: RendererCommandContext): Promise<void> {
    // STATE_CONTRACT: webview must address its response to a specific session.
    // Falling back to the active session would let a prompt opened in tab A be
    // resolved against tab B if the user switched tabs before clicking.
    const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
    if (!sessionPath) {
      this.rejectBrowser(msg, context, 'missing-session-path');
      this.dispatchEvent({ kind: 'NoticeShown', notice: 'Protocol defect: extensionUiResponse arrived without a sessionPath.' });
      return;
    }
    const corrId = crypto.randomUUID();
    this.dispatchEvent({
      kind: 'Command',
      cmd: { kind: 'RespondExtensionUI', corrId, sessionPath, requestId: msg.response.id, approved: msg.response.confirmed === true, response: msg.response },
    });
  }

  // ── Recovery action handlers (side-effect only) ────────────────

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
  private async onRestartBackend(context?: RendererCommandContext): Promise<void> {
    await vscode.commands.executeCommand('pie.restartBackend', operationSourceFromRenderer(context));
  }

  /** `retrySend` — re-send the draft text (composer draft + inputs were
   *  restored on rollback). When `disablePruning` is set, disable pruning
   *  (`mode: 'off'`) BEFORE re-sending so the slow prepass is skipped —
   *  atomically, on the host, to avoid a race where the send's prepass reads
   *  stale settings. Delegates to {@link onSend} so the optimistic message,
   *  session-name derivation, and input pickup are identical to a fresh send. */
  private async onRetrySend(msg: Extract<WebviewToHostMessage, { type: 'retrySend' }>, context?: RendererCommandContext): Promise<void> {
    let priorPruningMode: PruningMode | undefined;
    if (msg.disablePruning) {
      // Capture the user's prior pruning mode BEFORE disabling, so the
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
      context,
    );
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
