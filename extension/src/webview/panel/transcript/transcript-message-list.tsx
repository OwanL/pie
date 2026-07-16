/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatMessage, ChatPrefs } from '../../../shared/protocol';

import { MessageItem } from './message-item';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';

export interface TranscriptMessageListProps {
  messages: ChatMessage[];
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  /**
   * When set, the nested transcript is rendered read-only (no edit affordances)
   * and never in a streaming state. Used for subagent transcripts, which mirror
   * the main transcript's look but are not directly editable.
   */
  readonly?: boolean;
  /**
   * Suffix appended to each message key so collapsible default-open state
   * recomputes when the relevant prefs change. Lets nested transcripts respond
   * to auto-expand pref toggles the same way the main transcript does.
   */
  collapsibleKey?: string;
}

const noop = () => {};

/**
 * Single source of truth for rendering a sequence of transcript messages.
 *
 * Both the main transcript (one `MessageItem` per virtualized row) and nested
 * subagent transcripts render through the same `MessageItem`; this component
 * captures the *list* rendering so subagent transcripts — at any nesting depth,
 * via the recursive `renderToolCall` — look and behave identically to the main
 * transcript.
 */
export function TranscriptMessageList({
  messages,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
  readonly,
  collapsibleKey,
}: TranscriptMessageListProps) {
  let latestRequestCreatedAt: string | undefined;
  const items = messages.map((message) => {
    if (message.role === 'user' && message.status !== 'queued') {
      latestRequestCreatedAt = message.createdAt;
    }
    return (
      <MessageItem
        key={collapsibleKey ? `${message.id}-${collapsibleKey}` : message.id}
        message={message}
        isStreaming={false}
        prefs={prefs}
        readonly={readonly}
        workingDirectory={workingDirectory}
        editingId={null}
        onEditRequest={noop}
        onEditConfirm={noop}
        onEditCancel={noop}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        renderToolCall={renderToolCall}
        requestCreatedAt={message.role === 'assistant' ? latestRequestCreatedAt : undefined}
      />
    );
  });

  return <>{items}</>;
}
