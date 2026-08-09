/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useMemo, useState } from 'preact/hooks';

import type { ChatMessage, ChatPrefs, ComposerInput, InlineEditDraft } from '../../../shared/protocol';
import type { PruningHeaderState } from './pruning';
import type { TurnActivityState } from './activity';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { chatMessageEqual } from './message-equal';
import { useCaptureHeight, useMessageEntrance, useMessageItemDerived, useMessageParts } from './message-item/hooks';
import { MessageItemInner, MessageItemShell } from './message-item/inner';
import { userImagePartsToInputs } from './parts';
import { MessageCommitContext, useCommittedMessageLeaf } from './commit-registry';
import { messageRenderIdentity } from './render-identity';

export { ReasoningBlock } from './message-item/reasoning-block';

export interface MessageItemProps {
  message: ChatMessage;
  isStreaming: boolean;
  prefs: ChatPrefs;
  readonly?: boolean;
  workingDirectory: string | null;
  editingId: string | null;
  editingDraft?: InlineEditDraft | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[], queued?: boolean) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  isLastAssistantMessage?: boolean;
  /** Timestamp of the user request that owns this assistant reply. */
  requestCreatedAt?: string;
  /** Pruning diagnostics folded into this assistant turn's header, when present. */
  pruningHeaderState?: PruningHeaderState;
  /** Structured in-flight activity for the current turn (last assistant row only). */
  activityState?: TurnActivityState | null;
  /** Stable per-session key used to scope the message entrance tracker so old
   *  sessions' ids are released when the session changes. */
  sessionKey?: string | null;
  /** Cancel the in-flight pruning prepass from within the agent reply. */
  onCancelPrepass?: () => void;
}

export function MessageItemView({
  message,
  isStreaming,
  prefs,
  readonly,
  workingDirectory: _workingDirectory,
  editingId,
  editingDraft,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile: _onOpenFile,
  onContextMenu,
  renderToolCall,
  isLastAssistantMessage,
  requestCreatedAt,
  pruningHeaderState,
  activityState,
  sessionKey,
  onCancelPrepass,
}: MessageItemProps) {

  const {
    combinedParts,
    combinedMarkdown,
    renderableUserParts,
    combinedThinking,
    combinedToolCalls,
  } = useMessageParts(message);

  const [pruningExpanded, setPruningExpanded] = useState(false);
  const [pruningRawExpanded, setPruningRawExpanded] = useState(false);

  const { messageBodyRef, capturedHeight } = useCaptureHeight(message.role);

  const renderIdentity = messageRenderIdentity(message);
  // Entrance state is render-only, so it follows the same host-projected
  // identity as row keys and scroll anchoring across live→durable handoff.
  const entered = useMessageEntrance(renderIdentity, sessionKey);

  const initialInputs = useMemo(() => userImagePartsToInputs(message), [message]);
  const commitOwner = useMemo(() => ({
    messageId: message.id,
    toolStateRevision: message.toolStateRevision ?? 0,
  }), [message.id, message.toolStateRevision]);
  useCommittedMessageLeaf(message);

  const derived = useMessageItemDerived({
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
  });

  return (
    <MessageItemShell
      messageId={message.id}
      renderIdentity={renderIdentity}
      role={message.role}
      status={message.status}
      customType={message.customType}
      isCurrentlyStreaming={derived.isCurrentlyStreaming}
      isClickableUserMsg={derived.isClickableUserMsg}
      isEditing={derived.isEditing}
      entered={entered}
      handleMessageClick={derived.handleMessageClick}
    >
      <MessageCommitContext.Provider value={commitOwner}>
      <MessageItemInner
        message={message}
        isEditing={derived.isEditing}
        isCurrentlyStreaming={derived.isCurrentlyStreaming}
        capturedHeight={capturedHeight}
        initialInputs={initialInputs}
        editingDraft={editingDraft}
        pruningHeaderState={pruningHeaderState}
        pruningExpanded={pruningExpanded}
        setPruningExpanded={setPruningExpanded}
        pruningRawExpanded={pruningRawExpanded}
        setPruningRawExpanded={setPruningRawExpanded}
        statusLabel={derived.statusLabel}
        statusTone={derived.statusTone}
        replyMeta={derived.replyMeta}
        assistantMetaTooltip={derived.assistantMetaTooltip}
        requestCreatedAt={requestCreatedAt}
        html={derived.html}
        getMessageRaw={derived.getMessageRaw}
        combinedParts={combinedParts}
        renderableUserParts={renderableUserParts}
        prefs={prefs}
        renderToolCall={renderToolCall}
        onContextMenu={onContextMenu}
        messageBodyRef={messageBodyRef}
        hasActivityFooter={derived.hasActivityFooter}
        footerActivityState={derived.footerActivityState}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onCancelPrepass={onCancelPrepass}
      />
      </MessageCommitContext.Provider>
    </MessageItemShell>
  );
}

export const MessageItem = memo(MessageItemView, areMessageItemPropsEqual);

/**
 * Custom `memo` comparer for {@link MessageItem}.
 *
 * The host posts a fresh structured-cloned `ViewState` ~7×/sec while
 * streaming, so the `message` prop is a new reference on every snapshot even
 * when the content is byte-identical. Preact's default shallow compare would
 * therefore never bail, re-rendering every visible row (hooks + markdown cache
 * lookups + reconciliation) on every token. Comparing `message` by content
 * (via {@link chatMessageEqual}, O(visible rows) — not O(transcript) — thanks
 * to virtualization) lets unchanged rows skip rendering entirely.
 *
 * The remaining props are all either stable across snapshots (handlers are
 * `useCallback`-stable from `useAppHandlers`; `prefs` is reference-stabilized
 * in `hydrateViewState`; `renderToolCall` is `useCallback`-stable) or
 * primitives (`isStreaming`, `editingId`,
 * `requestCreatedAt`, `sessionKey`, …), so shallow `===` is correct for them.
 *
 * `activityState` and `pruningHeaderState` are fresh references on every
 * snapshot (they come from the freshly-rebuilt `rows` array). That's fine: they
 * are `undefined` for all rows except the last assistant row (activity) and
 * pruning-result rows (pruning header), so `undefined === undefined` bails the
 * common rows, and the rows that do carry them are exactly the ones that need
 * to re-render (the streaming / just-pruned rows).
 */
export function areMessageItemPropsEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  if (!chatMessageEqual(prev.message, next.message)) return false;
  return (
    prev.isStreaming === next.isStreaming &&
    prev.prefs === next.prefs &&
    prev.readonly === next.readonly &&
    prev.workingDirectory === next.workingDirectory &&
    prev.editingId === next.editingId &&
    prev.editingDraft === next.editingDraft &&
    prev.isLastAssistantMessage === next.isLastAssistantMessage &&
    prev.requestCreatedAt === next.requestCreatedAt &&
    prev.sessionKey === next.sessionKey &&
    prev.onEditRequest === next.onEditRequest &&
    prev.onEditConfirm === next.onEditConfirm &&
    prev.onEditCancel === next.onEditCancel &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onContextMenu === next.onContextMenu &&
    prev.renderToolCall === next.renderToolCall &&
    prev.pruningHeaderState === next.pruningHeaderState &&
    prev.activityState === next.activityState &&
    prev.onCancelPrepass === next.onCancelPrepass
  );
}
