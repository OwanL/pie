/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';
import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';

import type { ChatMessage, ChatMessagePart, ChatPrefs } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { toMouseEvent } from '../../utils/preact-events';
import { BufferedTextPart } from '../buffered-text-part';
import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  userImageSrc,
} from '../parts';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../types';
import { ReasoningBlock } from './reasoning-block';

interface AssistantPartsProps {
  messageId: string;
  parts: NonNullable<ReturnType<typeof assistantPartsFromMessage>>;
  prefs: ChatPrefs;
  isCurrentlyStreaming: boolean;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

function AssistantParts({
  messageId,
  parts,
  prefs,
  isCurrentlyStreaming,
  renderToolCall,
  onContextMenu,
  getMessageRaw,
}: AssistantPartsProps) {
  // Group consecutive tool-call parts that share a `parallelGroupId` so a
  // parallel batch (e.g. two bash calls fired together) renders with the
  // parallel indentation strip instead of reading as two unrelated sequential
  // cards. Only defined group ids merge; calls without one (legacy sessions)
  // and batches of size 1 render as ordinary single tool-call entries.
  type ToolCallPart = Extract<ChatMessagePart, { kind: 'toolCall' }>;
  type RenderItem =
    | { type: 'single'; part: ChatMessagePart; index: number }
    | { type: 'parallel'; groupId: string; items: Array<{ part: ToolCallPart; index: number }> };

  const items: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (
      part.kind === 'toolCall' &&
      typeof part.toolCall.parallelGroupId === 'string' &&
      part.toolCall.parallelGroupId.length > 0
    ) {
      const groupId = part.toolCall.parallelGroupId;
      const batch: Array<{ part: ToolCallPart; index: number }> = [
        { part, index: i },
      ];
      let j = i + 1;
      while (j < parts.length) {
        const nextPart = parts[j];
        if (
          nextPart.kind !== 'toolCall' ||
          nextPart.toolCall.parallelGroupId !== groupId
        ) {
          break;
        }
        batch.push({ part: nextPart, index: j });
        j += 1;
      }
      if (batch.length > 1) {
        items.push({ type: 'parallel', groupId, items: batch });
      } else {
        items.push({ type: 'single', part, index: i });
      }
      i = j;
      continue;
    }

    items.push({ type: 'single', part, index: i });
    i += 1;
  }

  return (
    <>
      {items.map((item) => {
        if (item.type === 'parallel') {
          // While at least one sibling in the batch is still running, mark the
          // finished (completed) members so the user can see at a glance which
          // calls have settled vs which are still active. The mark is
          // transient: once every member is done, `blockActive` flips false and
          // no member carries the class — "done" is then implicit. Failed
          // members are excluded so their failure treatment stays prominent.
          const blockActive = item.items.some(
            ({ part }) => part.toolCall.status === 'running',
          );
          return (
            <div class="tool-call-parallel-group" key={`pg-${messageId}-${item.groupId}`}>
              {item.items.map(({ part, index }) => (
                <div
                  class={
                    blockActive && part.toolCall.status === 'completed'
                      ? 'tool-call-list tool-call-parallel-item-done'
                      : 'tool-call-list'
                  }
                  key={`tool-${part.toolCall.id}-${index}`}
                >
                  {renderToolCall(part.toolCall, onContextMenu)}
                </div>
              ))}
            </div>
          );
        }

        const { part, index } = item;
        if (part.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={`reasoning-${messageId}-${index}`}
              text={part.text}
              autoExpand={prefs.autoExpandReasoning}
              collapsibleKey={`reasoning:${messageId}:${index}`}
              streaming={isCurrentlyStreaming && index === parts.length - 1}
              onContextMenu={(e) => onContextMenu('reasoning', part.text, e)}
            />
          );
        }

        if (part.kind === 'toolCall') {
          return (
            <div class="tool-call-list" key={`tool-${part.toolCall.id}-${index}`}>
              {renderToolCall(part.toolCall, onContextMenu)}
            </div>
          );
        }

        return (
          <BufferedTextPart
            key={`text-${messageId}-${index}`}
            messageId={messageId}
            index={index}
            text={part.text}
            // Only the last part is actively streaming (new text is appended
            // there); earlier text parts are complete. Passing streaming=true
            // to every part would spin up a never-stopping rAF loop per part
            // for the whole streaming duration (see use-buffered-text).
            streaming={isCurrentlyStreaming && index === parts.length - 1}
            onContextMenu={(e) => {
              onContextMenu('message', getMessageRaw(), toMouseEvent(e));
            }}
          />
        );
      })}
    </>
  );
}

interface UserTextPartProps {
  messageId: string;
  index: number;
  text: string;
  messageBodyRef: RefObject<HTMLDivElement>;
}

/** Memoized user text part: parses markdown only when `text` changes, not on
 *  every parent render (the transcript re-renders on each streaming token, so
 *  an inline renderMarkdown call in the map would re-parse visible user
 *  messages on every token). Only the first text part forwards the shared body
 *  ref so the inline editor's height capture keeps working. */
const UserTextPart = memo(function UserTextPart({ messageId, index, text, messageBodyRef }: UserTextPartProps) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      key={`user-text-${messageId}-${index}`}
      class="message-body"
      ref={index === 0 ? messageBodyRef : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

interface UserPartsProps {
  messageId: string;
  parts: NonNullable<ReturnType<typeof getRenderableUserParts>>;
  messageBodyRef: RefObject<HTMLDivElement>;
}

function UserParts({
  messageId,
  parts,
  messageBodyRef,
}: UserPartsProps) {
  return (
    <>
      {parts.map((part, index) => (
        part.kind === 'text' ? (
          <UserTextPart
            key={`user-text-${messageId}-${index}`}
            messageId={messageId}
            index={index}
            text={part.text}
            messageBodyRef={messageBodyRef}
          />
        ) : (
          <figure key={`user-image-${messageId}-${index}`} class="message-user-image">
            <img
              class="message-user-image-element"
              src={userImageSrc(part)}
              alt={part.name || 'Attached image'}
            />
            {(part.name || (part.width && part.height)) && (
              <figcaption class="message-user-image-caption">
                {part.name || 'Image'}
                {part.width && part.height ? ` · ${part.width}×${part.height}` : ''}
              </figcaption>
            )}
          </figure>
        )
      ))}
    </>
  );
}

interface MessageContentProps {
  messageId: string;
  role: ChatMessage['role'];
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  renderableUserParts: ReturnType<typeof getRenderableUserParts> | undefined;
  html: string;
  isCurrentlyStreaming: boolean;
  messageBodyRef: RefObject<HTMLDivElement>;
  prefs: ChatPrefs;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

export function MessageContent({
  messageId,
  role,
  combinedParts,
  renderableUserParts,
  html,
  isCurrentlyStreaming,
  messageBodyRef,
  prefs,
  renderToolCall,
  onContextMenu,
  getMessageRaw,
}: MessageContentProps) {
  if (role === 'assistant' && combinedParts) {
    return (
      <AssistantParts
        messageId={messageId}
        parts={combinedParts}
        prefs={prefs}
        isCurrentlyStreaming={isCurrentlyStreaming}
        renderToolCall={renderToolCall}
        onContextMenu={onContextMenu}
        getMessageRaw={getMessageRaw}
      />
    );
  }
  if (role === 'user' && renderableUserParts) {
    return (
      <UserParts
        messageId={messageId}
        parts={renderableUserParts}
        messageBodyRef={messageBodyRef}
      />
    );
  }
  return (
    <div
      class="message-body"
      ref={role === 'user' ? messageBodyRef : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
      onContextMenu={role === 'assistant' ? (e) => {
        e.preventDefault();
        onContextMenu('message', getMessageRaw(), toMouseEvent(e));
      } : undefined}
    />
  );
}
