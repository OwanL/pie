/** @jsxRuntime automatic */
/** @jsxImportSource preact */

/**
 * TranscriptHost renders a single TranscriptSurface for the active session
 * path only. Switching tabs remounts the surface for the newly active path,
 * so virtualizer measurements, scroll position, and collapsible state reset
 * on each tab switch (no hidden-but-mounted inactive surfaces are kept).
 */

import type {
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import type { TranscriptContextMenuHandler, TranscriptVirtualListProps } from './types';
import { TranscriptView } from '.';

interface TranscriptSurfaceProps extends TranscriptVirtualListProps {
  sessionPath: string;
  isActive: boolean;
}

function TranscriptSurface({
  sessionPath,
  isActive,
  sessionKey,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  loadingStatus,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
  onCancelPrepass,
}: TranscriptSurfaceProps) {
  const style = isActive
    ? 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column;visibility:visible;z-index:0;pointer-events:auto'
    : 'visibility:hidden;position:absolute;inset:0;z-index:-1;pointer-events:none;display:flex;flex-direction:column';

  return (
    <div
      class="transcript-surface"
      style={style}
      aria-hidden={!isActive}
      data-session-path={sessionPath}
    >
      <TranscriptView
        sessionKey={sessionKey}
        transcript={transcript}
        transcriptWindow={transcriptWindow}
        transcriptLoaded={transcriptLoaded}
        loadingStatus={loadingStatus}
        busy={busy}
        prefs={prefs}
        pruningSettings={pruningSettings}
        systemPrompts={systemPrompts}
        pruningResult={pruningResult}
        pendingAssistantModelId={pendingAssistantModelId}
        pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
        workingDirectory={workingDirectory}
        editingId={editingId}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        onLoadOlder={onLoadOlder}
        onLoadNewer={onLoadNewer}
        onJumpToLatest={onJumpToLatest}
        onCancelPrepass={onCancelPrepass}
      />
    </div>
  );
}

export interface TranscriptHostProps {
  openTabPaths: string[];
  activeSessionPath: string | null;
  // For now, these are shared from the active session's viewState.
  // Per-tab data will come from session stores in later phases.
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  transcriptLoaded: boolean;
  loadingStatus?: string;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[]) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  postMessage: (msg: any) => void;
  /** Cancel the in-flight pruning prepass from within the agent reply. */
  onCancelPrepass?: () => void;
  /** Optional session key; falls back to activeSessionPath when omitted. */
  sessionKey?: string | null;
}

export function TranscriptHost({
  openTabPaths,
  activeSessionPath,
  sessionKey,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  loadingStatus,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onCancelPrepass,
  postMessage,
}: TranscriptHostProps) {
  // Wrap the callbacks from the parent with postMessage so they carry
  // the active session path as part of the control message.
  const loadOlder = () => postMessage({
    type: 'loadOlderTranscript',
    sessionPath: activeSessionPath,
  });
  const loadNewer = () => postMessage({
    type: 'loadNewerTranscript',
    sessionPath: activeSessionPath,
  });
  const jumpToLatest = () => postMessage({
    type: 'jumpToLatestTranscript',
    sessionPath: activeSessionPath,
  });

  return (
    <div class="transcript-host" style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
      {activeSessionPath && openTabPaths.includes(activeSessionPath) && (
        <TranscriptSurface
          sessionPath={activeSessionPath}
          isActive
          sessionKey={sessionKey ?? activeSessionPath}
          transcript={transcript}
          transcriptWindow={transcriptWindow}
          transcriptLoaded={transcriptLoaded}
          loadingStatus={loadingStatus}
          busy={busy}
          prefs={prefs}
          pruningSettings={pruningSettings}
          systemPrompts={systemPrompts}
          pruningResult={pruningResult}
          pendingAssistantModelId={pendingAssistantModelId}
          pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
          workingDirectory={workingDirectory}
          editingId={editingId}
          onEditRequest={onEditRequest}
          onEditConfirm={onEditConfirm}
          onEditCancel={onEditCancel}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onJumpToLatest={jumpToLatest}
          onCancelPrepass={onCancelPrepass}
        />
      )}
    </div>
  );
}
