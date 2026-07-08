/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type {
  ViewState,
  ChatMessage,
  WebviewToHostMessage,
  ThinkingLevel,
} from '../../shared/protocol';
import { FileChangesPanel } from './file-changes-panel';
import { LoadingIndicator } from './components/loading-indicator';
import { TranscriptHost } from './transcript/transcript-host';
import type { PanelSurface } from './panel-state';
import type { AppHandlers } from './use-app-handlers';

export interface PanelMainProps {
  panelSurface: PanelSurface;
  hasActiveTabs: boolean;
  showSessionChrome: boolean;
  needsSessionRecovery: boolean;
  loadingStatus: string;
  activeSessionPath: string | null;
  activeSession: ViewState['activeSession'];
  fileChanges: ViewState['fileChanges'];
  fileChangesExpanded: ViewState['fileChangesExpanded'];
  readFilePaths: ViewState['readFilePaths'];
  handlers: Pick<AppHandlers, 'handleOpenFileDiff' | 'handleOpenFileInEditor' | 'handleRevertFile' | 'handleSetFileChangesExpanded' | 'handleSetFileRead' | 'handleEditRequest' | 'handleEditSend' | 'handleCancelEdit' | 'handleOpenFile' | 'handleOpenContextMenu' | 'handleNewSession'>;
  postMessage: (msg: WebviewToHostMessage) => void;
  mergedTranscript: ChatMessage[];
  transcriptWindow: ViewState['transcriptWindow'];
  transcriptLoaded: ViewState['transcriptLoaded'];
  busy: ViewState['busy'];
  prefs: ViewState['prefs'];
  pruningSettings: ViewState['pruningSettings'];
  systemPrompts: ViewState['systemPrompts'];
  pruningResult: ViewState['pruningResult'];
  pendingAssistantModelId: string;
  pendingAssistantThinkingLevel: ThinkingLevel;
  editingMessageId: ViewState['editingMessageId'];
  workspaceCwd: ViewState['workspaceCwd'];
  openTabPaths: ViewState['openTabPaths'];
  /** Wired to the agent-reply pruning chip's Cancel button (Brief F). */
  onCancelPrepass: () => void;
}

export const PanelMain = memo(function PanelMain({
  panelSurface,
  hasActiveTabs,
  showSessionChrome,
  needsSessionRecovery,
  loadingStatus,
  activeSessionPath,
  activeSession,
  fileChanges,
  fileChangesExpanded,
  readFilePaths,
  handlers,
  postMessage,
  mergedTranscript,
  transcriptWindow,
  transcriptLoaded,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  editingMessageId,
  workspaceCwd,
  openTabPaths,
  onCancelPrepass,
}: PanelMainProps) {
  return (
    <div class="panel-main">
      {showSessionChrome && fileChanges.length > 0 && (
        <FileChangesPanel
          key={activeSessionPath ?? 'none'}
          fileChanges={fileChanges}
          expanded={fileChangesExpanded}
          onToggleExpanded={handlers.handleSetFileChangesExpanded}
          onOpenDiff={handlers.handleOpenFileDiff}
          onOpenInEditor={handlers.handleOpenFileInEditor}
          onRevertFile={handlers.handleRevertFile}
          readFilePaths={readFilePaths}
          onSetFileRead={handlers.handleSetFileRead}
        />
      )}
      <div class="panel-content">
      {panelSurface === 'loading' ? (
        <div class="empty-state empty-state--loading">
          <LoadingIndicator status={loadingStatus} />
        </div>
      ) : !hasActiveTabs ? (
        <div class="empty-state">
          <div class="empty-state-title">Start a session</div>
          <div class="empty-state-sub">
            Sessions stay in tabs, and model settings remain visible while you work.
          </div>
          <button class="btn" onClick={handlers.handleNewSession}>New Session</button>
        </div>
      ) : needsSessionRecovery ? (
        <div class="empty-state empty-state--loading">
          <LoadingIndicator status={loadingStatus} />
        </div>
      ) : (
        <TranscriptHost
          openTabPaths={openTabPaths}
          activeSessionPath={activeSessionPath}
          loadingStatus={loadingStatus}
          transcript={mergedTranscript}
          transcriptWindow={transcriptWindow}
          transcriptLoaded={transcriptLoaded}
          busy={busy}
          prefs={prefs}
          pruningSettings={pruningSettings}
          systemPrompts={systemPrompts}
          pruningResult={pruningResult}
          pendingAssistantModelId={pendingAssistantModelId}
          pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
          workingDirectory={activeSession?.cwd ?? workspaceCwd}
          editingId={editingMessageId}
          onEditRequest={handlers.handleEditRequest}
          onEditConfirm={handlers.handleEditSend}
          onEditCancel={handlers.handleCancelEdit}
          onOpenFile={handlers.handleOpenFile}
          onContextMenu={handlers.handleOpenContextMenu}
          postMessage={postMessage}
          onCancelPrepass={onCancelPrepass}
        />
      )}
      </div>
    </div>
  );
});
