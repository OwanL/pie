/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';
import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';

import type { ChatMessage, ChatMessagePart, ChatPrefs } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { toMouseEvent } from '../../utils/preact-events';
import { BufferedTextPart } from '../buffered-text-part';
import { useCommittedTextLeaf } from '../commit-registry';
import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  userImageSrc,
} from '../parts';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../types';
import { handleDelegatedFilePathClick, handleDelegatedFilePathContextMenu, handleDelegatedFilePathKeyDown } from '../file-path-interactions';
import { ReasoningBlock } from './reasoning-block';

interface AssistantPartsProps {
  messageId: string;
  parts: NonNullable<ReturnType<typeof assistantPartsFromMessage>>;
  prefs: ChatPrefs;
  isCurrentlyStreaming: boolean;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

function AssistantParts({
  messageId,
  parts,
  prefs,
  isCurrentlyStreaming,
  workingDirectory,
  onOpenFile,
  renderToolCall,
  onContextMenu,
  getMessageRaw,
}: AssistantPartsProps) {
  // Keep every consecutive tool-call run under one parent from its first
  // provisional card onward. Verified parallel batches are child annotations,
  // never replacement parents: mixed adjacent batches therefore stay under the
  // same first-tool-keyed wrapper without reparenting live cards.
  type ToolCallPart = Extract<ChatMessagePart, { kind: 'toolCall' }>;
  type ToolCallRun = { type: 'toolCalls'; items: Array<{ part: ToolCallPart; index: number }> };
  type RenderItem = ToolCallRun | { type: 'single'; part: Exclude<ChatMessagePart, ToolCallPart>; index: number };

  const items: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.kind === 'toolCall') {
      const run: ToolCallRun['items'] = [{ part, index: i }];
      let j = i + 1;
      while (j < parts.length && parts[j].kind === 'toolCall') {
        run.push({ part: parts[j] as ToolCallPart, index: j });
        j += 1;
      }
      items.push({ type: 'toolCalls', items: run });
      i = j;
      continue;
    }

    items.push({ type: 'single', part, index: i });
    i += 1;
  }

  return (
    <>
      {items.map((item) => {
        if (item.type === 'toolCalls') {
          const firstCall = item.items[0].part.toolCall;
          const annotations: Array<{
            groupId: string;
            start: boolean;
            end: boolean;
            active: boolean;
          } | undefined> = Array(item.items.length).fill(undefined);

          // A run may contain multiple adjacent batches. Only contiguous
          // segments of at least two calls with the same non-empty id earn the
          // visual strip; solo and distinct ids remain flat.
          let segmentStart = 0;
          while (segmentStart < item.items.length) {
            const groupId = item.items[segmentStart].part.toolCall.parallelGroupId;
            let segmentEnd = segmentStart + 1;
            while (
              typeof groupId === 'string'
              && groupId.length > 0
              && segmentEnd < item.items.length
              && item.items[segmentEnd].part.toolCall.parallelGroupId === groupId
            ) {
              segmentEnd += 1;
            }
            if (typeof groupId === 'string' && groupId.length > 0 && segmentEnd - segmentStart >= 2) {
              const active = item.items.slice(segmentStart, segmentEnd).some(
                ({ part }) => part.toolCall.status === 'drafting'
                  || part.toolCall.status === 'ready'
                  || part.toolCall.status === 'running',
              );
              for (let childIndex = segmentStart; childIndex < segmentEnd; childIndex += 1) {
                annotations[childIndex] = {
                  groupId,
                  start: childIndex === segmentStart,
                  end: childIndex === segmentEnd - 1,
                  active,
                };
              }
            }
            segmentStart = segmentEnd;
          }

          return (
            <div class="tool-call-list" key={`tool-run-${firstCall.id}`}>
              {item.items.map(({ part }, childIndex) => {
                const annotation = annotations[childIndex];
                const childClasses = [
                  'tool-call-run-child',
                  annotation && 'tool-call-parallel-child',
                  annotation?.start && 'tool-call-parallel-start',
                  annotation?.end && 'tool-call-parallel-end',
                  annotation?.active && part.toolCall.status === 'completed' && 'tool-call-parallel-item-done',
                ].filter(Boolean).join(' ');
                return (
                  <div
                    class={childClasses}
                    data-parallel-group-id={annotation?.groupId}
                    key={`tool-${part.toolCall.id}`}
                  >
                    {renderToolCall(part.toolCall, onContextMenu)}
                  </div>
                );
              })}
            </div>
          );
        }

        const { part, index } = item;
        if (part.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={`reasoning-${messageId}-${index}`}
              text={part.text}
              detailRef={part.detailRef}
              autoExpand={prefs.autoExpandReasoning}
              collapsibleKey={`reasoning:${messageId}:${index}`}
              streaming={isCurrentlyStreaming && index === parts.length - 1}
              onContextMenu={(e) => onContextMenu('reasoning', part.text, e)}
            />
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
            workingDirectory={workingDirectory}
            onOpenFile={onOpenFile}
            onFilePathContextMenu={onContextMenu}
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
  const html = useMemo(() => renderMarkdown(text, true, false), [text]);
  useCommittedTextLeaf(messageId, index, text);
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

interface StaticMessageBodyProps {
  messageId: string;
  text: string;
  html: string;
  role: ChatMessage['role'];
  messageBodyRef: RefObject<HTMLDivElement>;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

function StaticMessageBody({ messageId, text, html, role, messageBodyRef, workingDirectory, onOpenFile, onContextMenu, getMessageRaw }: StaticMessageBodyProps) {
  useCommittedTextLeaf(messageId, 0, text);
  return (
    <div
      class="message-body"
      ref={role === 'user' ? messageBodyRef : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={role === 'assistant' ? (e) => {
        handleDelegatedFilePathClick(e, workingDirectory, onOpenFile);
      } : undefined}
      onKeyDown={role === 'assistant' ? (e) => {
        handleDelegatedFilePathKeyDown(e, workingDirectory, onOpenFile);
      } : undefined}
      onContextMenu={role === 'assistant' ? (e) => {
        if (handleDelegatedFilePathContextMenu(e, workingDirectory, onContextMenu)) return;
        e.preventDefault();
        onContextMenu('message', getMessageRaw(), toMouseEvent(e));
      } : undefined}
    />
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
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
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
  workingDirectory,
  onOpenFile,
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
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
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
    <StaticMessageBody
      messageId={messageId}
      text={getMessageRaw()}
      html={html}
      role={role}
      messageBodyRef={messageBodyRef}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
      getMessageRaw={getMessageRaw}
    />
  );
}
