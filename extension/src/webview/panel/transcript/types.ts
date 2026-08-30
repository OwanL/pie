import type { ComponentChildren } from 'preact';

import type { ChatMessage, ChatPrefs, ComposerInput, InlineEditDraft, PruningResult, PruningSettings, SystemPromptEntry, ThinkingLevel, ToolCall, TranscriptWindow } from '../../../shared/protocol';
import type { LiveTurnPhase } from '../../../shared/live-pipeline-protocol';
import type { TranscriptContextMenuType } from '../chat-prefs';

/** Message-level metadata bound once per row in `MessageItemView`, so every
 *  right-click inside the row (assistant text, reasoning, tool cards, user
 *  messages, system messages, compaction-summary shells) can reach the same
 *  enriched transcript menu. The webview computes the eligibility flags
 *  optimistically; the host router re-validates before dispatching. */
export interface TranscriptMessageMenuInfo {
  messageId: string;
  role: ChatMessage['role'];
  /** Transcript surface that owns this row. Captured independently of the
   * mutable active-tab ref so actions remain correctly session-addressed. */
  sessionPath?: string;
  /** Optional target-specific plain text. Row wrappers fill this from the
   * message, reasoning block, or renderer when appropriate. Tool renderers
   * omit it unless they have a meaningful plain-text representation. */
  plainText?: string;
  /** Whether the Edit action applies (eligible, non-editing user messages). */
  editable: boolean;
  /** Whether destructive "Delete from here" (truncateAfter) applies: durable,
   *  non-streaming, non-queued transcript messages only. */
  canTruncate: boolean;
}

export type TranscriptContextMenuHandler = (
  type: TranscriptContextMenuType,
  rawData: string,
  e: MouseEvent,
  /** Message-level metadata for right-clicks that occurred inside a transcript
   *  message row. Absent for menus opened outside a row. */
  message?: Partial<TranscriptMessageMenuInfo>,
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
