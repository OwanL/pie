/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { lazy, memo, Suspense } from 'preact/compat';
import type {
  ViewState,
  ChatMessage,
  WebviewToHostMessage,
  ThinkingLevel,
} from '../../shared/protocol';
import { FileChangesPanel } from './file-changes-panel';
import { LoadingIndicator } from './components/loading-indicator';
import type { PanelSurface } from './panel-state';
import type { AppHandlers } from './use-app-handlers';
import { useCommittedAppSurface } from './transcript/commit-registry';

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
  /** True while the active session runs a history-compaction LLM call. */
  compacting: boolean;
  liveTurnPhase: ViewState['liveTurnPhase'];
  prefs: ViewState['prefs'];
  pruningSettings: ViewState['pruningSettings'];
  systemPrompts: ViewState['systemPrompts'];
  pruningResult: ViewState['pruningResult'];
  pendingAssistantModelId: string;
  pendingAssistantThinkingLevel: ThinkingLevel;
  editingMessageId: ViewState['editingMessageId'];
  editingDraft: ViewState['editingDraft'];
  workspaceCwd: ViewState['workspaceCwd'];
  openTabPaths: ViewState['openTabPaths'];
  /** Wired to the agent-reply pruning chip's Cancel button. */
  onCancelPrepass: () => void;
}

// Transcript rendering pulls in markdown sanitizing, syntax grammars, YAML,
// and the virtualizer. Keep that large dependency graph out of the entry chunk
// so the tab/session chrome can paint while the transcript chunk is fetched and
// parsed. Vite caches the module after its first load, so tab switches do not
// repeat the network or module-evaluation cost.
const TranscriptHost = lazy(async () => {
  const module = await import('./transcript/transcript-host');
  return { default: module.TranscriptHost };
});

function TranscriptSuspenseSurface() {
  useCommittedAppSurface('transcript-suspense');
  return (
    <div class="empty-state empty-state--loading transcript-suspense" data-render-surface="transcript-suspense">
      <LoadingIndicator status="Loading conversation" />
    </div>
  );
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
  compacting,
  liveTurnPhase,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  editingMessageId,
  editingDraft,
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
          prefs={prefs}
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
        <Suspense fallback={<TranscriptSuspenseSurface />}>
        <TranscriptHost
          openTabPaths={openTabPaths}
          activeSessionPath={activeSessionPath}
          loadingStatus={loadingStatus}
          transcript={mergedTranscript}
          transcriptWindow={transcriptWindow}
          transcriptLoaded={transcriptLoaded}
          busy={busy}
          compacting={compacting}
          liveTurnPhase={liveTurnPhase}
          prefs={prefs}
          pruningSettings={pruningSettings}
          systemPrompts={systemPrompts}
          pruningResult={pruningResult}
          pendingAssistantModelId={pendingAssistantModelId}
          pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
          workingDirectory={activeSession?.cwd ?? workspaceCwd}
          editingId={editingMessageId}
          editingDraft={editingDraft}
          onEditRequest={handlers.handleEditRequest}
          onEditConfirm={handlers.handleEditSend}
          onEditCancel={handlers.handleCancelEdit}
          onOpenFile={handlers.handleOpenFile}
          onContextMenu={handlers.handleOpenContextMenu}
          postMessage={postMessage}
          onCancelPrepass={onCancelPrepass}
        />
        </Suspense>
      )}
      </div>
    </div>
  );
});
