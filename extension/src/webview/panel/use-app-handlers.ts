import { useCallback, useMemo } from 'preact/hooks';
import type {
  ChatPrefs,
  ComposerInput,
  ComposerInputDraft,
  PruningSettings,
  ThinkingLevel,
  ToolResultPruningSettings,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { createLocalMessageId } from '../../shared/local-message-id';
import type { TranscriptContextMenuType } from './chat-prefs';
import type { ContextMenuState } from './components/context-menu';
import type { SessionTabRunAction } from './session-tabs/run-state';

export interface AppHandlers {
  handleSend: (text: string) => void;
  /** Brief H: re-send the (restored) composer draft as a `retrySend` — mirrors
   *  `handleSend` (optimistic message + draft-restore clear) but posts
   *  `retrySend` so the host can disable pruning atomically before re-sending
   *  (`disablePruning: true` → "retry without pruning"). The host's `onRetrySend`
   *  delegates to `onSend`, so the optimistic message, session-name derivation,
   *  and input pickup are identical to a fresh send. */
  handleRetrySend: (text: string, disablePruning?: boolean) => void;
  handleInterrupt: () => void;
  handleOpenFile: (path: string) => void;
  handleNewSession: () => void;
  handleCloseTab: (path: string) => void;
  handleDuplicateTab: (path: string) => void;
  handleTogglePinTab: (path: string) => void;
  handleGroupPinnedTab: (sourcePath: string, targetPath: string) => void;
  handleMergePinnedGroups: (sourcePath: string, targetPath: string) => void;
  handleUngroupPinnedTab: (sourcePath: string, toItemIndex: number) => void;
  handleMovePinnedItem: (sourcePath: string, toItemIndex: number) => void;
  handleCancelEdit: () => void;
  handleSetPrefs: (partial: Partial<ChatPrefs>) => void;
  handleSetSystemPromptToggles: (disabledEntries: string[]) => void;
  handleSetPruningSettings: (partial: Partial<PruningSettings>) => void;
  handleSetToolResultPruningSettings: (partial: Partial<ToolResultPruningSettings>) => void;
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
  handleOpenContextMenu: (type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => void;
}

export function useAppHandlers(
  postMessage: (msg: WebviewToHostMessage) => void,
  activeSessionPathRef: { current: string | null },
  setDraftRestore: (value: null) => void,
  addOptimisticMessage: (msg: { localId: string; text: string; sessionPath: string }) => void,
  setContextMenu: (state: ContextMenuState | null) => void,
  /** Brief E: set true synchronously on interrupt so the webview reflects
   *  "stopping…" within one frame (before the host round-trip clears
   *  `busy`). Cleared by `AppBody` when `busy` flips false (abort confirmed)
   *  or the active session changes. Allowlisted webview-local protocol-sync
   *  bookkeeping (in-flight UI gating). */
  setInterrupting: (value: boolean) => void,
): AppHandlers {
  const handleSend = useCallback((text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    setDraftRestore(null);

    const localId = createLocalMessageId();
    addOptimisticMessage({ localId, text, sessionPath });

    postMessage({ type: 'send', sessionPath, text, localId });
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage]);

  // Brief H: retry re-sends the restored draft. Mirrors `handleSend` (optimistic
  // message + draft-restore clear) but posts `retrySend` so the host can disable
  // pruning atomically before the re-send when `disablePruning` is set ("retry
  // without pruning"). The text comes from the composer's live draft (registered
  // into `sendRetryDraftRef` in AppBody) so an edit between rejection and retry
  // is honored — `draftRestore.text` would be stale once the user types.
  const handleRetrySend = useCallback((text: string, disablePruning?: boolean) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    setDraftRestore(null);

    const localId = createLocalMessageId();
    addOptimisticMessage({ localId, text, sessionPath });

    postMessage({ type: 'retrySend', sessionPath, text, localId, disablePruning });
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage]);

  const handleInterrupt = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    // Optimistic one-frame "stopping…" feedback: the host clears `busy` only
    // once the abort completes (a round-trip), so without this local flag the
    // Stop button + typing indicator would keep animating until then. The host
    // ALSO calls `abortInFlightSend` for a pre-ack send (Brief E) — this flag
    // is the visual mirror of that. `AppBody` clears it when `busy` flips false.
    setInterrupting(true);
    postMessage({ type: 'interrupt', sessionPath });
  }, [postMessage, activeSessionPathRef, setInterrupting]);

  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), [postMessage]);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), [postMessage]);
  const handleCloseTab = useCallback((path: string) => postMessage({
    type: 'closeSession', sessionPath: path, interactionId: crypto.randomUUID(),
  }), [postMessage]);
  const handleDuplicateTab = useCallback((path: string) => postMessage({ type: 'duplicateSession', sessionPath: path }), [postMessage]);
  const handleTogglePinTab = useCallback((path: string) => postMessage({ type: 'togglePinTab', sessionPath: path }), [postMessage]);
  const handleGroupPinnedTab = useCallback((sourcePath: string, targetPath: string) => postMessage({ type: 'groupPinnedTab', sourcePath, targetPath }), [postMessage]);
  const handleMergePinnedGroups = useCallback((sourcePath: string, targetPath: string) => postMessage({ type: 'mergePinnedGroups', sourcePath, targetPath }), [postMessage]);
  const handleUngroupPinnedTab = useCallback((sourcePath: string, toItemIndex: number) => postMessage({ type: 'ungroupPinnedTab', sourcePath, toItemIndex }), [postMessage]);
  const handleMovePinnedItem = useCallback((sourcePath: string, toItemIndex: number) => postMessage({ type: 'movePinnedItem', sourcePath, toItemIndex }), [postMessage]);
  const handleCancelEdit = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'cancelEdit', sessionPath });
  }, [postMessage, activeSessionPathRef]);
  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => postMessage({ type: 'setPrefs', prefs: partial }), [postMessage]);
  const handleSetSystemPromptToggles = useCallback((disabledEntries: string[]) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setSystemPromptToggles', sessionPath, disabledEntries });
  }, [postMessage, activeSessionPathRef]);
  const handleSetPruningSettings = useCallback((partial: Partial<PruningSettings>) => postMessage({ type: 'setPruningSettings', settings: partial }), [postMessage]);
  const handleSetToolResultPruningSettings = useCallback((partial: Partial<ToolResultPruningSettings>) => postMessage({ type: 'setToolResultPruningSettings', settings: partial }), [postMessage]);
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
    activeSessionPathRef.current = path;
    postMessage({ type: 'openSession', sessionPath: path });
  }, [postMessage, activeSessionPathRef]);

  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, [postMessage]);

  // Tab context-menu task actions. Selecting the tab first ensures the action
  // targets the session the user right-clicked.
  const handleTabRunAction = useCallback((action: SessionTabRunAction, tabPath: string) => {
    activeSessionPathRef.current = tabPath;
    postMessage({ type: 'openSession', sessionPath: tabPath });
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

  const handleOpenContextMenu = useCallback((type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => {
    // Capture the trigger element (the onContextMenu target) so the menu can
    // mirror its open state back onto the trigger via aria-haspopup/
    // aria-expanded (see components/context-menu.tsx). e.currentTarget is the
    // element the handler is bound to; read synchronously here, before the
    // event finishes dispatching.
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
      selectionText,
      x: e.clientX,
      y: e.clientY,
      triggerEl: e.currentTarget as HTMLElement | null,
    });
  }, [setContextMenu]);

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
      handleGroupPinnedTab,
      handleMergePinnedGroups,
      handleUngroupPinnedTab,
      handleMovePinnedItem,
      handleCancelEdit,
      handleSetPrefs,
      handleSetSystemPromptToggles,
      handleSetPruningSettings,
      handleSetToolResultPruningSettings,
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
      handleGroupPinnedTab,
      handleMergePinnedGroups,
      handleUngroupPinnedTab,
      handleMovePinnedItem,
      handleCancelEdit,
      handleSetPrefs,
      handleSetSystemPromptToggles,
      handleSetPruningSettings,
      handleSetToolResultPruningSettings,
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
