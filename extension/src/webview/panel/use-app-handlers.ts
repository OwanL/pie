import { useCallback, useMemo } from 'preact/hooks';
import type {
  ChatPrefs,
  ComposerInput,
  ComposerInputDraft,
  PruningSettings,
  SessionTitlesSettings,
  ThinkingLevel,
  ToolResultPruningSettings,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { createLocalMessageId } from '../../shared/local-message-id';
import type { TranscriptContextMenuType } from './chat-prefs';
import type { ContextMenuState } from './components/context-menu';
import { getContextMenuTrigger } from './components/useMenuTriggerAria';
import type { TranscriptMessageMenuInfo } from './transcript/types';
import type { SessionTabRunAction } from './session-tabs/run-state';

export interface AppHandlers {
  handleSend: (text: string) => boolean;
  /** Re-send the (restored) composer draft as a `retrySend` — mirrors
   *  `handleSend` (optimistic message + draft-restore clear) but posts
   *  `retrySend` so the host can disable pruning atomically before re-sending
   *  (`disablePruning: true` → "retry without pruning"). The host's `onRetrySend`
   *  delegates to `onSend`, so the optimistic message, session-name derivation,
   *  and input pickup are identical to a fresh send. */
  handleRetrySend: (text: string, disablePruning?: boolean) => boolean;
  handleInterrupt: () => boolean;
  handleOpenFile: (path: string) => void;
  handleNewSession: () => void;
  handleCloseTab: (path: string) => void;
  handleDuplicateTab: (path: string) => void;
  handleTogglePinTab: (path: string) => void;
  handlePinAndMergePinnedTab: (path: string) => void;
  handleGroupPinnedTab: (sourcePath: string, targetPath: string) => void;
  handleMergePinnedGroups: (sourcePath: string, targetPath: string) => void;
  handleUngroupPinnedTab: (sourcePath: string, toItemIndex: number) => void;
  handleDissolvePinnedGroup: (sourcePath: string) => void;
  handleUnpinPinnedGroup: (sourcePath: string) => void;
  handleMovePinnedItem: (sourcePath: string, toItemIndex: number) => void;
  handleCancelDeferredTrigger: (sessionPath: string, triggerId?: string) => void;
  handleCancelEdit: () => void;
  handleSetPrefs: (partial: Partial<ChatPrefs>) => void;
  /** Re-read the effective MCP server config into `ViewState.mcpServers`. */
  handleMcpListRequested: () => void;
  /** Persist a per-server `disabled` override (`.pi/mcp.json`); takes effect
   *  on the next session reload / backend restart. */
  handleMcpSetServerEnabled: (name: string, enabled: boolean) => void;
  handleMcpSetServerEnabledForSession: (name: string, enabled: boolean) => void;
  handleSetPrivacyMode: (enabled: boolean) => void;
  handleSetSystemPromptToggles: (disabledEntries: string[]) => void;
  handleSetPruningSettings: (partial: Partial<PruningSettings>) => void;
  handleSetToolResultPruningSettings: (partial: Partial<ToolResultPruningSettings>) => void;
  handleSetSessionTitlesSettings: (partial: Partial<SessionTitlesSettings>) => void;
  handleEditRequest: (messageId: string) => void;
  handleAddComposerInput: (input: ComposerInputDraft) => void;
  handleRemoveComposerInput: (inputId: string) => void;
  handleSelectTab: (path: string) => void;
  handleMoveTab: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  handleTabRunAction: (action: SessionTabRunAction, tabPath: string) => void;
  handleModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
  handleEditSend: (messageId: string, text: string, inputs?: ComposerInput[]) => void;
  handleOpenFileDiff: (filePath: string) => void;
  handleOpenFileInEditor: (filePath: string) => void;
  handleRevertFile: (filePath: string) => void;
  handleSetFileChangesExpanded: (expanded: boolean) => void;
  handleSetFileRead: (filePath: string, read: boolean) => void;
  handleOpenContextMenu: (
    type: TranscriptContextMenuType,
    rawData: string,
    e: MouseEvent,
    message?: Partial<TranscriptMessageMenuInfo>,
  ) => void;
}

export function useAppHandlers(
  transportPostMessage: (msg: WebviewToHostMessage) => boolean,
  activeSessionPathRef: { current: string | null },
  setDraftRestore: (value: null) => void,
  addOptimisticMessage: (msg: { localId: string; text: string; sessionPath: string; queued: boolean }) => void,
  isBusy: boolean,
  setContextMenu: (state: ContextMenuState | null) => void,
  /** Set true synchronously on interrupt so the webview reflects
   *  "stopping…" within one frame (before the host round-trip clears
   *  `busy`). Cleared by `AppBody` when `busy` flips false (abort confirmed)
   *  or the active session changes. Allowlisted webview-local protocol-sync
   *  bookkeeping (in-flight UI gating). */
  setInterrupting: (value: boolean) => void,
  /** Browser commands are unavailable until rendererHello completes. */
  commandsAvailable = true,
): AppHandlers {
  // Every handler in this hook is an application command. Keep one guard at
  // the transport boundary so secondary controls (tabs, model/settings,
  // attachments, file actions) cannot mutate local refs or appear accepted
  // while a browser renderer is between registrations.
  const postMessage = useCallback((message: WebviewToHostMessage): boolean => (
    commandsAvailable && transportPostMessage(message)
  ), [commandsAvailable, transportPostMessage]);

  const handleSend = useCallback((text: string) => {
    if (!commandsAvailable) return false;
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return false;

    const localId = createLocalMessageId();
    if (!postMessage({ type: 'send', sessionPath, text, localId })) return false;

    setDraftRestore(null);
    // An empty submit is a continuation command. It deliberately has no
    // optimistic user row because no user message is added to PI context.
    if (text.trim().length > 0) {
      addOptimisticMessage({ localId, text, sessionPath, queued: isBusy });
    }
    return true;
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage, isBusy, commandsAvailable]);

  // Retry re-sends the restored draft. Mirrors `handleSend` (optimistic
  // message + draft-restore clear) but posts `retrySend` so the host can disable
  // pruning atomically before the re-send when `disablePruning` is set ("retry
  // without pruning"). The text comes from the composer's live draft (registered
  // into `sendRetryDraftRef` in AppBody) so an edit between rejection and retry
  // is honored — `draftRestore.text` would be stale once the user types.
  const handleRetrySend = useCallback((text: string, disablePruning?: boolean) => {
    if (!commandsAvailable) return false;
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return false;

    const localId = createLocalMessageId();
    if (!postMessage({ type: 'retrySend', sessionPath, text, localId, disablePruning })) return false;

    setDraftRestore(null);
    addOptimisticMessage({ localId, text, sessionPath, queued: isBusy });
    return true;
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage, isBusy, commandsAvailable]);

  const handleInterrupt = useCallback(() => {
    if (!commandsAvailable) return false;
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return false;
    if (!postMessage({ type: 'interrupt', sessionPath })) return false;
    // Optimistic one-frame "stopping…" feedback: the host clears `busy` only
    // once the abort completes (a round-trip), so without this local flag the
    // Stop button + typing indicator would keep animating until then. The host
    // ALSO calls `abortInFlightSend` for a pre-ack send — this flag
    // is the visual mirror of that. `AppBody` clears it when `busy` flips false.
    setInterrupting(true);
    return true;
  }, [postMessage, activeSessionPathRef, setInterrupting, commandsAvailable]);

  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), [postMessage]);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), [postMessage]);
  const handleCloseTab = useCallback((path: string) => postMessage({
    type: 'closeSession', sessionPath: path, interactionId: crypto.randomUUID(),
  }), [postMessage]);
  const handleDuplicateTab = useCallback((path: string) => postMessage({ type: 'duplicateSession', sessionPath: path }), [postMessage]);
  const handleTogglePinTab = useCallback((path: string) => postMessage({ type: 'togglePinTab', sessionPath: path }), [postMessage]);
  const handlePinAndMergePinnedTab = useCallback((path: string) => postMessage({ type: 'pinAndMergePinnedTab', sessionPath: path }), [postMessage]);
  const handleGroupPinnedTab = useCallback((sourcePath: string, targetPath: string) => postMessage({ type: 'groupPinnedTab', sourcePath, targetPath }), [postMessage]);
  const handleMergePinnedGroups = useCallback((sourcePath: string, targetPath: string) => postMessage({ type: 'mergePinnedGroups', sourcePath, targetPath }), [postMessage]);
  const handleUngroupPinnedTab = useCallback((sourcePath: string, toItemIndex: number) => postMessage({ type: 'ungroupPinnedTab', sourcePath, toItemIndex }), [postMessage]);
  const handleMovePinnedItem = useCallback((sourcePath: string, toItemIndex: number) => postMessage({ type: 'movePinnedItem', sourcePath, toItemIndex }), [postMessage]);
  const handleDissolvePinnedGroup = useCallback((sourcePath: string) => postMessage({ type: 'dissolvePinnedGroup', sourcePath }), [postMessage]);
  const handleUnpinPinnedGroup = useCallback((sourcePath: string) => postMessage({ type: 'unpinPinnedGroup', sourcePath }), [postMessage]);
  // Cancel a deferred trigger. `sessionPath` is the trigger's watcher session
  // (carried on the trigger itself), not necessarily the active session, so it
  // is passed explicitly rather than read from the ref. Omit `triggerId` to
  // cancel every active trigger for that session.
  const handleCancelDeferredTrigger = useCallback((sessionPath: string, triggerId?: string) => {
    postMessage({ type: 'cancelDeferredTrigger', sessionPath, triggerId });
  }, [postMessage]);
  const handleCancelEdit = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'cancelEdit', sessionPath });
  }, [postMessage, activeSessionPathRef]);
  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => postMessage({ type: 'setPrefs', prefs: partial }), [postMessage]);
  const handleMcpListRequested = useCallback(() => postMessage({ type: 'mcpListRequested' }), [postMessage]);
  const handleMcpSetServerEnabled = useCallback(
    (name: string, enabled: boolean) => postMessage({ type: 'mcpSetServerEnabled', name, enabled }),
    [postMessage],
  );
  const handleMcpSetServerEnabledForSession = useCallback(
    (name: string, enabled: boolean) => {
      const sessionPath = activeSessionPathRef.current;
      if (!sessionPath) return;
      postMessage({ type: 'mcpSetServerEnabledForSession', sessionPath, name, enabled });
    },
    [postMessage, activeSessionPathRef],
  );
  const handleSetPrivacyMode = useCallback((enabled: boolean) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setPrivacyMode', sessionPath, enabled });
  }, [postMessage, activeSessionPathRef]);
  const handleSetSystemPromptToggles = useCallback((disabledEntries: string[]) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setSystemPromptToggles', sessionPath, disabledEntries });
  }, [postMessage, activeSessionPathRef]);
  const handleSetPruningSettings = useCallback((partial: Partial<PruningSettings>) => postMessage({ type: 'setPruningSettings', settings: partial }), [postMessage]);
  const handleSetToolResultPruningSettings = useCallback((partial: Partial<ToolResultPruningSettings>) => postMessage({ type: 'setToolResultPruningSettings', settings: partial }), [postMessage]);
  const handleSetSessionTitlesSettings = useCallback((partial: Partial<SessionTitlesSettings>) => postMessage({ type: 'setSessionTitlesSettings', settings: partial }), [postMessage]);
  const handleEditRequest = useCallback((messageId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'startEdit', sessionPath, messageId });
  }, [postMessage, activeSessionPathRef]);

  const handleAddComposerInput = useCallback((input: ComposerInputDraft) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'addComposerInput', sessionPath, input });
  }, [postMessage, activeSessionPathRef]);

  const handleRemoveComposerInput = useCallback((inputId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'removeComposerInput', sessionPath, inputId });
  }, [postMessage, activeSessionPathRef]);

  const handleSelectTab = useCallback((path: string) => {
    if (!postMessage({ type: 'openSession', sessionPath: path })) return;
    activeSessionPathRef.current = path;
  }, [postMessage, activeSessionPathRef]);

  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, [postMessage]);

  // Tab context-menu task actions. Selecting the tab first ensures the action
  // targets the session the user right-clicked.
  const handleTabRunAction = useCallback((action: SessionTabRunAction, tabPath: string) => {
    if (!postMessage({ type: 'openSession', sessionPath: tabPath })) return;
    activeSessionPathRef.current = tabPath;
    if (action === 'startNewTask') {
      postMessage({ type: 'startNewTask', sessionPath: tabPath });
    } else if (action === 'continueTask') {
      postMessage({ type: 'continueTask', sessionPath: tabPath });
    }
  }, [postMessage, activeSessionPathRef]);

  const handleModelChange = useCallback((model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    // defaultProvider is sent as a separate field (never encoded in
    // defaultModel) so the backend can resolve duplicate ids across providers
    // and persist it for session restore. Omitted (undefined) when only the
    // thinking level changes — the backend then keeps the current provider.
    postMessage({ type: 'setModel', sessionPath, defaultModel: model, defaultProvider: provider, defaultThinkingLevel: thinkingLevel });
  }, [postMessage, activeSessionPathRef]);

  const handleEditSend = useCallback((messageId: string, text: string, inputs?: ComposerInput[], queued?: boolean) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    const localId = createLocalMessageId('edit');
    postMessage({ type: 'editMessage', sessionPath, messageId, text, inputs, localId, queued });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFileDiff = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileDiff', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFileInEditor = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileInEditor', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleRevertFile = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'revertFile', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleSetFileChangesExpanded = useCallback((expanded: boolean) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setFileChangesExpanded', sessionPath, expanded });
  }, [postMessage, activeSessionPathRef]);

  const handleSetFileRead = useCallback((filePath: string, read: boolean) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setFileRead', sessionPath, filePath, read });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenContextMenu = useCallback(
    (type: TranscriptContextMenuType, rawData: string, e: MouseEvent, message?: Partial<TranscriptMessageMenuInfo>) => {
    // Capture the trigger element (the onContextMenu target) so the menu can
    // mirror its open state back onto the trigger via aria-haspopup/
    // aria-expanded (see components/context-menu.tsx). Resolve it
    // synchronously, before the event finishes dispatching.
    //
    // Also capture the live text selection *now*: a right-click (contextmenu)
    // does not clear the selection, so this is the user's highlighted text.
    // Reading it later (e.g. when the "Copy" item is clicked) would be too
    // late — the menu's open effect moves focus to the first item, which can
    // collapse the document selection. Stored on the menu state so the
    // "Copy" item can copy just the selection instead of the whole block.
    const selectionText = window.getSelection()?.toString() ?? '';
    setContextMenu({
      type,
      rawData,
      sessionPath: message?.sessionPath ?? activeSessionPathRef.current,
      message: message ?? null,
      selectionText,
      x: e.clientX,
      y: e.clientY,
      triggerEl: getContextMenuTrigger(e),
    });
    },
    [setContextMenu, activeSessionPathRef],
  );

  return useMemo(
    () => ({
      handleSend,
      handleRetrySend,
      handleInterrupt,
      handleOpenFile,
      handleNewSession,
      handleCloseTab,
      handleDuplicateTab,
      handleTogglePinTab,
      handlePinAndMergePinnedTab,
      handleGroupPinnedTab,
      handleMergePinnedGroups,
      handleUngroupPinnedTab,
      handleDissolvePinnedGroup,
      handleUnpinPinnedGroup,
      handleMovePinnedItem,
      handleCancelDeferredTrigger,
      handleCancelEdit,
      handleSetPrefs,
      handleMcpListRequested,
      handleMcpSetServerEnabled,
      handleMcpSetServerEnabledForSession,
      handleSetPrivacyMode,
      handleSetSystemPromptToggles,
      handleSetPruningSettings,
      handleSetToolResultPruningSettings,
      handleSetSessionTitlesSettings,
      handleEditRequest,
      handleAddComposerInput,
      handleRemoveComposerInput,
      handleSelectTab,
      handleMoveTab,
      handleTabRunAction,
      handleModelChange,
      handleEditSend,
      handleOpenFileDiff,
      handleOpenFileInEditor,
      handleRevertFile,
      handleSetFileChangesExpanded,
      handleSetFileRead,
      handleOpenContextMenu,

    }),
    [
      handleSend,
      handleRetrySend,
      handleInterrupt,
      handleOpenFile,
      handleNewSession,
      handleCloseTab,
      handleDuplicateTab,
      handleTogglePinTab,
      handlePinAndMergePinnedTab,
      handleGroupPinnedTab,
      handleMergePinnedGroups,
      handleUngroupPinnedTab,
      handleDissolvePinnedGroup,
      handleUnpinPinnedGroup,
      handleMovePinnedItem,
      handleCancelDeferredTrigger,
      handleCancelEdit,
      handleSetPrefs,
      handleMcpListRequested,
      handleMcpSetServerEnabled,
      handleMcpSetServerEnabledForSession,
      handleSetPrivacyMode,
      handleSetSystemPromptToggles,
      handleSetPruningSettings,
      handleSetToolResultPruningSettings,
      handleSetSessionTitlesSettings,
      handleEditRequest,
      handleAddComposerInput,
      handleRemoveComposerInput,
      handleSelectTab,
      handleMoveTab,
      handleTabRunAction,
      handleModelChange,
      handleEditSend,
      handleOpenFileDiff,
      handleOpenFileInEditor,
      handleRevertFile,
      handleSetFileChangesExpanded,
      handleSetFileRead,
      handleOpenContextMenu,
    ],
  );
}
