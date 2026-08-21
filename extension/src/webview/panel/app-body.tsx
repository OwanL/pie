/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import type {
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { ContextMenu, type ContextMenuState } from './components/context-menu';
import { NoticeBanner } from './components/notice-banner';
import { SessionTabs } from './ui';
import { AggregateStatsStrip } from './ui';
import { DeferredTriggersMenu } from './aggregate-stats-strip/deferred-triggers-menu';
import { NoticeContext } from './hooks/notice-context';
import { AskUserContext, selectFixedPromptRequest } from './hooks/ask-user-context';
import { useHostSync } from './hooks/use-host-sync';
import { useAppHandlers } from './use-app-handlers';
import { useSessionRecovery } from './use-session-recovery';
import { useAppBodyDerivedState } from './use-app-body-derived-state';
import { PanelMain } from './panel-main';
import { BottomSection } from './bottom-section';
import { useNoticeAction } from './use-notice-action';
import { useChatPrefsCss } from './use-chat-prefs-css';
import { useWarmupAudio } from './use-warmup-audio';
import { TranscriptCommitProvider } from './transcript/commit-registry';
import { InlineConfirmDialog } from './components/inline-confirm-dialog';
import { ConnectionBanner } from './components/connection-banner';
import type { ClientTransport } from '../transport/client-transport';

export interface AppBodyProps {
  adapter: {
    postMessage: (msg: WebviewToHostMessage) => void;
    transport: ClientTransport;
    initialState?: ViewState;
  };
}

export function AppBody({ adapter }: AppBodyProps) {
  const { postMessage, transport } = adapter;
  const {
    viewState,
    mergedTranscript,
    commitTarget,
    draftRestore,
    activeSessionPathRef,
    setDraftRestore,
    addOptimisticMessage,
    connectionState,
    inlineConfirm,
    respondToInlineConfirm,
  } = useHostSync(transport, adapter.initialState);
  const postApplicationCommand = useCallback(
    (message: WebviewToHostMessage) => connectionState === 'connected' && transport.postMessage(message),
    [connectionState, transport],
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const retryCreateOperation = useCallback((operationId: string) => {
    postApplicationCommand({ type: 'retryCreateOperation', operationId });
  }, [postApplicationCommand]);

  // Tracks which request IDs have an interactive inline prompt actually
  // mounted in the transcript. This is ephemeral DOM-presence bookkeeping,
  // not request logic: host state remains authoritative. A count (rather than
  // a Set) keeps registration correct if the same request is briefly mounted
  // twice during a transition.
  const [inlinePromptRequestCounts, setInlinePromptRequestCounts] = useState<Record<string, number>>({});
  const registerInlineRequest = useCallback((requestId: string) => {
    setInlinePromptRequestCounts((current) => ({
      ...current,
      [requestId]: (current[requestId] ?? 0) + 1,
    }));
  }, []);
  const unregisterInlineRequest = useCallback((requestId: string) => {
    setInlinePromptRequestCounts((current) => {
      const count = current[requestId] ?? 0;
      if (count <= 0) return current;
      const next = { ...current };
      if (count === 1) delete next[requestId];
      else next[requestId] = count - 1;
      return next;
    });
  }, []);

  // Brief E: optimistic one-frame "stopping…" flag for interrupt. Set
  // synchronously in `handleInterrupt` (use-app-handlers) so the click reflects
  // within one frame; cleared below when the host confirms the abort
  // (`busy` flips false) or the active session changes. Allowlisted webview-
  // local protocol-sync bookkeeping (in-flight UI gating).
  const [interrupting, setInterrupting] = useState(false);

  // Deferred-triggers cancel popup: webview-local ephemeral UI (the moral
  // equivalent of `contextMenu` — STATE_CONTRACT § Webview-Local State). Open
  // position is captured from the strip segment click; dismissed on
  // click-outside / Escape (handled inside the menu). `null` = closed.
  const [deferredMenu, setDeferredMenu] = useState<{ x: number; y: number } | null>(null);

  // Brief H: bridge from the AppBody-level NoticeBanner's Retry button to the
  //  composer-level live draft. The composer registers its `sendAsRetry` here;
  //  `handleNoticeAction` invokes it on a Retry click. A ref (not state) so a
  //  Retry click doesn't re-render — it just calls the latest registered closure.
  const sendRetryDraftRef = useRef<((disablePruning?: boolean) => void) | null>(null);

  const handlers = useAppHandlers(
    postApplicationCommand,
    activeSessionPathRef,
    setDraftRestore,
    addOptimisticMessage,
    viewState.busy,
    setContextMenu,
    setInterrupting,
    connectionState === 'connected',
  );

  useWarmupAudio();

  const derived = useAppBodyDerivedState(
    viewState,
    postMessage,
    registerInlineRequest,
    unregisterInlineRequest,
  );
  const fixedPendingExtensionUIRequest = useMemo(() => selectFixedPromptRequest(
    derived.activeSessionPath
      ? (viewState.pendingExtensionUIRequestsBySession[derived.activeSessionPath] ?? {})
      : {},
    inlinePromptRequestCounts,
  ), [
    derived.activeSessionPath,
    viewState.pendingExtensionUIRequestsBySession,
    inlinePromptRequestCounts,
  ]);

  // Brief E: clear the optimistic "stopping…" flag once the host confirms the
  // abort (`busy` flips false — the abort round-trip completed) or the active
  // session changes (transient UI clear per STATE_CONTRACT § Webview-Local
  // State). `busy` is the host's authoritative running signal; the local flag
  // only bridges the host round-trip so the click reflects within one frame.
  useEffect(() => {
    if (!viewState.busy) setInterrupting(false);
  }, [viewState.busy]);
  useEffect(() => {
    setInterrupting(false);
  }, [derived.activeSessionPath]);
  // Clear the deferred-triggers popup when no triggers remain. The menu's own
  // `onClose` (click-outside/Escape/resize) sets state to null, but the render
  // guard `deferredTriggers.length > 0` can unmount it without calling onClose
  // (e.g. the last trigger is cancelled via ×, or all triggers fire) — without
  // this, a stale `{x,y}` would linger and re-open the menu at the old position
  // when a new trigger is later registered, without a click.
  useEffect(() => {
    if (viewState.deferredTriggers.length === 0) setDeferredMenu(null);
  }, [viewState.deferredTriggers.length]);
  // While an interrupt is in-flight, suppress the transcript's busy-driven
  // typing indicator within one frame (the host clears `busy` only after the
  // abort completes). The transcript components are unchanged — only the
  // `busy` value they receive is gated.
  const transcriptBusy = viewState.busy && !interrupting;

  const handleNoticeAction = useNoticeAction(postMessage, sendRetryDraftRef);

  useSessionRecovery(viewState.backendReady, derived.needsSessionRecovery, derived.recoverySessionPath, viewState.notice, postMessage);

  useChatPrefsCss(viewState.prefs);

  // Session lookup for the deferred-triggers menu (resolves watcher session
  // paths to display names). Memoized on the sessions array ref.
  const sessionByPath = useMemo(
    () => new Map(viewState.sessions.map((s) => [s.path, s] as const)),
    [viewState.sessions],
  );
  const appCommitSurface = derived.panelSurface === 'loading' || derived.needsSessionRecovery
    ? 'loading'
    : !derived.hasActiveTabs
      ? 'empty'
      : 'transcript-suspense';

  return (
    <NoticeContext.Provider value={derived.noticeValue}>
    <TranscriptCommitProvider target={commitTarget} postMessage={postMessage} appSurface={appCommitSurface}>
    <AskUserContext.Provider value={derived.askUserContextValue}>
    <div id="app">
      {connectionState !== 'connected' && (
        <ConnectionBanner state={connectionState} />
      )}
      {inlineConfirm && (
        <InlineConfirmDialog
          confirm={inlineConfirm}
          onRespond={(confirmed) => respondToInlineConfirm(inlineConfirm.confirmId, confirmed)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          prefs={viewState.prefs}
          onSetPrefs={handlers.handleSetPrefs}
          onOpenFile={handlers.handleOpenFile}
          onClose={closeContextMenu}
        />
      )}
      {viewState.notice && (
        <NoticeBanner
          notice={viewState.notice}
          kind={viewState.noticeKind}
          rawDetail={viewState.noticeRaw}
          onAction={handleNoticeAction}
          onDismiss={() => postMessage({ type: 'dismissNotice' })}
        />
      )}

      {derived.showSessionChrome && (
        <SessionTabs
          sessions={viewState.sessions}
          openTabPaths={viewState.openTabPaths}
          pinnedTabPaths={viewState.pinnedTabPaths}
          pinnedTabGroups={viewState.pinnedTabGroups}
          runningSessionPaths={viewState.runningSessionPaths}
          startingModelSessionPaths={viewState.startingModelSessionPaths}
          unreadFinishedSessionPaths={viewState.unreadFinishedSessionPaths}
          activeSession={viewState.activeSession}
          backendReady={connectionState === 'connected' && viewState.backendReady}
          hideConnectingWheel={derived.transcriptHydrating || derived.needsSessionRecovery}
          pendingExtensionUIRequestsBySession={viewState.pendingExtensionUIRequestsBySession}
          runSummariesBySession={viewState.runSummariesBySession}
          onSelect={handlers.handleSelectTab}
          onClose={handlers.handleCloseTab}
          onMove={handlers.handleMoveTab}
          onNew={handlers.handleNewSession}
          onDuplicate={handlers.handleDuplicateTab}
          onRetryCreate={retryCreateOperation}
          onTogglePin={handlers.handleTogglePinTab}
          onGroupPinnedTab={handlers.handleGroupPinnedTab}
          onMergePinnedGroups={handlers.handleMergePinnedGroups}
          onUngroupPinnedTab={handlers.handleUngroupPinnedTab}
          onMovePinnedItem={handlers.handleMovePinnedItem}
          onRunAction={handlers.handleTabRunAction}
          deferredSessionPaths={derived.deferredSessionPaths}
          deferredTimerSessionPaths={derived.deferredTimerSessionPaths}
        />
      )}

      <PanelMain
        panelSurface={derived.panelSurface}
        hasActiveTabs={derived.hasActiveTabs}
        showSessionChrome={derived.showSessionChrome}
        needsSessionRecovery={derived.needsSessionRecovery}
        loadingStatus={derived.loadingStatus}
        activeSessionPath={derived.activeSessionPath}
        activeSession={viewState.activeSession}
        fileChanges={viewState.fileChanges}
        fileChangesExpanded={viewState.fileChangesExpanded}
        readFilePaths={viewState.readFilePaths}
        handlers={handlers}
        postMessage={postMessage}
        mergedTranscript={mergedTranscript}
        transcriptWindow={viewState.transcriptWindow}
        transcriptLoaded={viewState.transcriptLoaded}
        busy={transcriptBusy}
        compacting={viewState.compactingSessionPaths.includes(derived.activeSessionPath ?? '')}
        liveTurnPhase={viewState.liveTurnPhase}
        prefs={viewState.prefs}
        pruningSettings={viewState.pruningSettings}
        systemPrompts={viewState.systemPrompts}
        pruningResult={viewState.pruningResult}
        pendingAssistantModelId={derived.pendingAssistantModelId}
        pendingAssistantThinkingLevel={derived.pendingAssistantThinkingLevel}
        editingMessageId={viewState.editingMessageId}
        editingDraft={viewState.editingDraft}
        workspaceCwd={viewState.workspaceCwd}
        openTabPaths={viewState.openTabPaths}
        onCancelPrepass={handlers.handleInterrupt}
      />

      <BottomSection
        hasActiveTabs={derived.hasActiveTabs}
        needsSessionRecovery={derived.needsSessionRecovery}
        pendingExtensionUIRequest={fixedPendingExtensionUIRequest}
        activeSessionPath={derived.activeSessionPath}
        postMessage={postMessage}
        busy={viewState.busy}
        retryStatus={viewState.retryStatus}
        interrupting={interrupting}
        commandsAvailable={connectionState === 'connected' && viewState.backendReady}
        activeSession={viewState.activeSession}
        privacyMode={viewState.privacyMode}
        modelSettings={viewState.modelSettings}
        availableModels={viewState.availableModels}
        availableModelsStatus={viewState.availableModelsStatus}
        availableExtensions={viewState.availableExtensions}
        contextUsage={viewState.contextUsage}
        prefs={viewState.prefs}
        mcpServers={viewState.mcpServers}
        mcpServersStatus={viewState.mcpServersStatus}
        mcpPendingApply={viewState.mcpPendingApply}
        pruningSettings={viewState.pruningSettings}
        pruningCatalog={viewState.pruningCatalog}
        pruningResult={viewState.pruningResult}
        toolResultPruningSettings={viewState.toolResultPruningSettings}
        providerGateStats={viewState.aggregateStats.providerGate}
        systemPrompts={viewState.systemPrompts}
        transcript={viewState.transcript}
        transcriptWindow={viewState.transcriptWindow}
        sessionUsage={viewState.sessionUsage}
        draftRestore={draftRestore}
        draftText={viewState.draftText}
        sendRetryDraftRef={sendRetryDraftRef}
        pendingComposerInputs={viewState.pendingComposerInputs}
        activeRunSummary={viewState.activeRunSummary}
        tokenRateBySession={viewState.tokenRateBySession}
        compacting={viewState.compactingSessionPaths.includes(derived.activeSessionPath ?? '')}
        lastCompaction={viewState.lastCompactionBySession[derived.activeSessionPath ?? ''] ?? null}
        handlers={handlers}
      />

      {derived.showSessionChrome && !viewState.prefs.hideStatusStrip && (
        <AggregateStatsStrip
          stats={viewState.aggregateStats}
          deferredTriggers={viewState.deferredTriggers}
          onOpenDeferredMenu={(x, y) => setDeferredMenu({ x, y })}
        />
      )}
      {deferredMenu && viewState.deferredTriggers.length > 0 && (
        <DeferredTriggersMenu
          triggers={viewState.deferredTriggers}
          sessionByPath={sessionByPath}
          x={deferredMenu.x}
          y={deferredMenu.y}
          onCancel={handlers.handleCancelDeferredTrigger}
          onClose={() => setDeferredMenu(null)}
        />
      )}
    </div>
    </AskUserContext.Provider>
    </TranscriptCommitProvider>
    </NoticeContext.Provider>
  );
}
