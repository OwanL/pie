import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatMessage } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { assistantReplyMeta, formatAssistantMetaTooltip } from '../header';
import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
} from '../parts';
import { shouldOpenUserMessageEditor } from '../interactions';
import { AGENT_ACTIVITY_LABELS, type TurnActivityState } from '../activity';
import type { StatusTone } from '../status-chip';

export function buildMessageRaw(
  message: ChatMessage,
  combinedMarkdown: string,
  combinedThinking: string,
  combinedToolCalls: ChatMessage['toolCalls'],
  combinedParts: ReturnType<typeof assistantPartsFromMessage>,
): string {
  return JSON.stringify({
    role: message.role,
    createdAt: message.createdAt,
    status: message.status,
    markdown: combinedMarkdown,
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
    ...(combinedThinking ? { thinking: combinedThinking } : {}),
    ...(combinedToolCalls?.length ? { toolCalls: combinedToolCalls } : {}),
    ...(combinedParts?.length ? { parts: combinedParts } : {}),
    ...(message.userParts?.length ? { userParts: message.userParts } : {}),
  }, null, 2);
}

export function useMessageParts(message: ChatMessage) {
  const combinedParts = useMemo(() => (
    message.role === 'assistant'
      ? assistantPartsFromMessage(message)
      : undefined
  ), [message]);
  const combinedMarkdown = useMemo(() => (
    message.role === 'assistant'
      ? textFromMessageParts(combinedParts)
      : message.markdown
  ), [combinedParts, message.markdown, message.role]);
  const renderableUserParts = useMemo(() => getRenderableUserParts(message), [message]);
  const combinedThinking = useMemo(() => (
    message.role === 'assistant'
      ? reasoningFromMessageParts(combinedParts) ?? ''
      : message.thinking ?? ''
  ), [combinedParts, message.role, message.thinking]);
  const combinedToolCalls = useMemo(() => (
    message.role === 'assistant'
      ? toolCallsFromMessageParts(combinedParts)
      : message.toolCalls
  ), [combinedParts, message.role, message.toolCalls]);

  return {
    combinedParts,
    combinedMarkdown,
    renderableUserParts,
    combinedThinking,
    combinedToolCalls,
  };
}

export function useCaptureHeight(messageRole: ChatMessage['role']) {
  const messageBodyRef = useRef<HTMLDivElement>(null);
  const [capturedHeight, setCapturedHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = messageBodyRef.current;
    if (!el || messageRole !== 'user') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setCapturedHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [messageRole]);
  return { messageBodyRef, capturedHeight };
}

export function useMessageItemDerived({
  message,
  isStreaming,
  isLastAssistantMessage,
  activityState,
  editingId,
  readonly,
  combinedParts,
  combinedMarkdown,
  combinedThinking,
  combinedToolCalls,
  onEditRequest,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLastAssistantMessage?: boolean;
  activityState?: TurnActivityState | null;
  editingId: string | null;
  readonly?: boolean;
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  combinedMarkdown: string;
  combinedThinking: string;
  combinedToolCalls: ChatMessage['toolCalls'];
  onEditRequest: (messageId: string) => void;
}) {
  const isCurrentlyStreaming = isStreaming && message.status === 'streaming';
  const isEditing = editingId === message.id;

  const statusLabel =
    message.status === 'interrupted' ? 'Interrupted'
    : message.status === 'error' ? 'Error'
    : message.status === 'queued' ? 'Queued'
    : null;
  const statusTone: StatusTone =
    message.status === 'interrupted' ? 'interrupted'
    : message.status === 'error' ? 'error'
    : message.status === 'queued' ? 'neutral'
    : 'neutral';
  const replyMeta = assistantReplyMeta(message);
  const assistantMetaTooltip = formatAssistantMetaTooltip(message);

  const html = useMemo(() => {
    // Assistant messages with structured parts render through BufferedTextPart /
    // AssistantParts, which parse markdown per-part. Parsing the combined text
    // here too would duplicate marked+DOMPurify work on every streaming delta
    // for a result that is never consumed (MessageContent routes to
    // AssistantParts when combinedParts exists). Compaction summaries likewise
    // parse only after their collapsed card is opened.
    if ((message.role === 'assistant' && combinedParts) || message.customType === 'compaction-summary') return '';
    return renderMarkdown(combinedMarkdown);
  }, [message.role, message.customType, combinedParts, combinedMarkdown]);
  const getMessageRaw = useCallback(
    () => buildMessageRaw(message, combinedMarkdown, combinedThinking, combinedToolCalls, combinedParts as ReturnType<typeof assistantPartsFromMessage>),
    [
      combinedMarkdown,
      combinedParts,
      combinedThinking,
      combinedToolCalls,
      message.createdAt,
      message.modelId,
      message.role,
      message.status,
      message.thinkingLevel,
      message.userParts,
    ],
  );

  const isClickableUserMsg = message.role === 'user'
    && !isEditing
    && !isCurrentlyStreaming
    && !readonly;
  const footerActivityState = activityState ?? (
    isLastAssistantMessage && message.role === 'assistant' && isCurrentlyStreaming
      ? {
        phase: 'streaming' as const,
        label: AGENT_ACTIVITY_LABELS.responding,
        tone: 'active' as const,
        ariaLabel: 'Agent is responding',
      }
      : null
  );
  const hasActivityFooter = isLastAssistantMessage && message.role === 'assistant' && !!footerActivityState;
  const handleMessageClick = isClickableUserMsg
    ? (event: MouseEvent) => {
        if (!shouldOpenUserMessageEditor(event.target)) {
          return;
        }
        onEditRequest(message.id);
      }
    : undefined;

  return {
    isCurrentlyStreaming,
    isEditing,
    statusLabel,
    statusTone,
    replyMeta,
    assistantMetaTooltip,
    html,
    getMessageRaw,
    isClickableUserMsg,
    footerActivityState,
    hasActivityFooter,
    handleMessageClick,
  };
}

// Module-level record of message ids that have already "entered" (been mounted
// at least once) in the CURRENT session. Used by `useMessageEntrance` to play
// the entrance animation only for genuinely new messages, not for virtualized
// remounts (overscan unmount/remount would otherwise replay the animation as
// flicker). Scoped per session: when `sessionKey` changes the set is dropped so
// old sessions' ids are released (bounded to the current session's ids, cleared
// on webview reload).
const enteredMessageIds = new Set<string>();
let enteredSessionKey: string | null | undefined;

/**
 * Returns true the first time a message id is seen (genuinely new), false on
 * any subsequent mount (virtualized remount). The decision is stable for the
 * lifetime of a single mount — re-renders return the initial value — so the
 * entrance animation plays once and does not replay when the virtual list
 * remounts an already-seen row. The seen-id set is scoped to `sessionKey`:
 * switching sessions drops the previous session's ids so the set stays bounded
 * (the new session's messages animate in as genuinely new).
 */
export function useMessageEntrance(messageId: string, sessionKey?: string | null): boolean {
  // Drop the previous session's ids when the session changes so the set only
  // tracks the current session (bounded; old sessions are released).
  if (enteredSessionKey !== sessionKey) {
    enteredSessionKey = sessionKey;
    enteredMessageIds.clear();
  }
  const ref = useRef<{ entered: boolean } | null>(null);
  if (ref.current === null) {
    if (enteredMessageIds.has(messageId)) {
      ref.current = { entered: false };
    } else {
      enteredMessageIds.add(messageId);
      ref.current = { entered: true };
    }
  }
  return ref.current.entered;
}
