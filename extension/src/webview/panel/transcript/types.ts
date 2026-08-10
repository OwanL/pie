import type { ComponentChildren } from 'preact';

import type {
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  InlineEditDraft,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  ToolCall,
  TranscriptWindow,
} from '../../../shared/protocol';
import type { LiveTurnPhase } from '../../../shared/live-pipeline-protocol';
import type { TranscriptContextMenuType } from '../chat-prefs';

export type TranscriptContextMenuHandler = (
  type: TranscriptContextMenuType,
  rawData: string,
  e: MouseEvent,
) => void;

export type RenderToolCall = (
  toolCall: ToolCall,
  onContextMenu: TranscriptContextMenuHandler,
) => ComponentChildren;

/**
 * Props shared by {@link TranscriptView} and {@link TranscriptSurface} (and
 * forwarded between them). Each component adds its own session-identity prop
 * (`sessionKey` / `sessionPath`) and `TranscriptSurface` adds `isActive`.
 */
export interface TranscriptCommonProps {
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  transcriptLoaded: boolean;
  loadingStatus?: string;
  busy: boolean;
  /** True while the active session runs a history-compaction LLM call; the
   *  activity row labels it "compacting history" instead of a generic
   *  thinking/preparing state. */
  compacting?: boolean;
  liveTurnPhase?: LiveTurnPhase | null;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  editingDraft?: InlineEditDraft | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[], queued?: boolean) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  /** Cancel the in-flight pruning prepass from within the agent reply. */
  onCancelPrepass?: () => void;
}

/** Shared by {@link TranscriptView} and {@link TranscriptVirtualList}. */
export interface TranscriptVirtualListProps extends TranscriptCommonProps {
  sessionKey: string | null;
}
