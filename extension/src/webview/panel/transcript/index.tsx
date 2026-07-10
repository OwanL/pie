/** @jsxRuntime automatic */
/** @jsxImportSource preact */

// Side-effect: register all built-in row and tool renderers
import './register-builtins';

import { isTranscriptHydrating } from './state';

import { LoadingIndicator } from '../components/loading-indicator';
import { MessageItem, ReasoningBlock } from './message-item';
export {
  formatToolCallResultForDisplay,
  ToolCallCard,
} from './tool-call-card';
export { splitSummaryPath } from '../file-path';
export {
  getRenderableUserParts,
  messageHasUserImages,
} from './parts';
export {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  rawMessagesToChatMessages,
  subagentSingleResultToChatMessages,
} from './subagent';
export type {
  SubagentResult,
  SubagentSingleResult,
} from './subagent';
import type { TranscriptVirtualListProps } from './types';
import { TranscriptVirtualList } from './virtual-list';

export { MessageItem, ReasoningBlock };

export function TranscriptView({
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
}: TranscriptVirtualListProps) {
  const transcriptHydrating = isTranscriptHydrating({ transcript, systemPrompts, transcriptLoaded });

  if (transcriptHydrating) {
    return (
      <div class="transcript">
        <div class="transcript-loading">
          <LoadingIndicator status={loadingStatus} />
        </div>
      </div>
    );
  }

  return (
    <TranscriptVirtualList
      {...{ sessionKey, transcript, transcriptWindow, busy, prefs, pruningSettings, systemPrompts, pruningResult, pendingAssistantModelId, pendingAssistantThinkingLevel, workingDirectory, editingId, onEditRequest, onEditConfirm, onEditCancel, onOpenFile, onContextMenu, onLoadOlder, onLoadNewer, onJumpToLatest, onCancelPrepass }}
    />
  );
}
