/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import type { ChatMessage, ChatPrefs, ComposerInput, PruningResult, SystemPromptEntry, ToolCall } from '../../../shared/protocol';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import type { TranscriptRow } from './virtual-list-rows';

// --- Row Registry ---

export interface RowRendererProps {
  row: TranscriptRow;
  busy: boolean;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  workingDirectory: string | null;
  editingId: string | null;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  isLastRow: boolean;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[]) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onRequestOlder: () => void;
  onRequestNewer: () => void;
  renderToolCall: RenderToolCall;
  /** For message rows: the full transcript array. */
  transcript?: ChatMessage[];
  /** For message rows: the index of the message in the transcript array. */
  transcriptIndex?: number;
  /** Whether there are older messages available to load. */
  hasOlder?: boolean;
  /** Stable per-session key used to scope per-message entrance tracking so
   *  old sessions' ids are released when the session changes. */
  sessionKey?: string | null;
  /** Cancel the in-flight pruning prepass from within the agent reply. */
  onCancelPrepass?: () => void;
}

export type RowRenderer = (props: RowRendererProps) => ComponentChildren;

const rowRenderers = new Map<string, RowRenderer>();

export function registerRowRenderer(kind: string, renderer: RowRenderer): void {
  rowRenderers.set(kind, renderer);
}

export function getRowRenderer(kind: string): RowRenderer | undefined {
  return rowRenderers.get(kind);
}

// --- Tool Registry ---

export interface ToolRendererProps {
  toolCall: ToolCall;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

export type ToolRenderer = (props: ToolRendererProps) => ComponentChildren;

const toolRenderers = new Map<string, ToolRenderer>();

export function registerToolRenderer(name: string, renderer: ToolRenderer): void {
  toolRenderers.set(name, renderer);
}

export function getToolRenderer(name: string): ToolRenderer | undefined {
  return toolRenderers.get(name);
}

/** Get all registered row kinds (for testing). */
export function getRegisteredRowKinds(): string[] {
  return [...rowRenderers.keys()];
}

/** Get all registered tool names (for testing). */
export function getRegisteredToolNames(): string[] {
  return [...toolRenderers.keys()];
}
