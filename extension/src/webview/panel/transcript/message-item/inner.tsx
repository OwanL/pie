/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren, RefObject } from 'preact';

import type { ChatMessage, ChatPrefs, ComposerInput } from '../../../../shared/protocol';
import { cx } from '../../utils/cx';
import { InlineEditor } from '../inline-editor';
import type { PruningHeaderState } from '../pruning';
import { PruningHeaderPanel } from '../pruning-header';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../types';
import type { TurnActivityState } from '../activity';
import { assistantPartsFromMessage, getRenderableUserParts } from '../parts';
import { assistantReplyMeta } from '../header';
import type { StatusTone } from '../status-chip';
import { ErrorDetailWithFallback } from './error-detail';
import { MessageContent } from './content';
import { MessageFooter } from './footer';
import { MessageItemHeader, MessageHeaderActions } from './header';

interface MessageItemShellProps {
  messageId: string;
  role: ChatMessage['role'];
  /** Message status — used to dim queued (follow-up) user messages. */
  status: ChatMessage['status'];
  /** Host-side synthetic-send tag. `'deferred-trigger'` marks the auto-resume
   *  wake-up message so the shell can render it differently from a typed user
   *  message (dashed outline, muted fill, header badge). */
  customType?: string;
  isCurrentlyStreaming: boolean;
  isClickableUserMsg: boolean;
  isEditing: boolean;
  /** True only the first time a message id is mounted (genuinely new); used to
   *  gate the entrance animation so virtualized remounts don't replay it. */
  entered?: boolean;
  handleMessageClick: ((event: MouseEvent) => void) | undefined;
  children: ComponentChildren;
}

export function MessageItemShell({
  messageId,
  role,
  status,
  customType,
  isCurrentlyStreaming,
  isClickableUserMsg,
  isEditing,
  entered,
  handleMessageClick,
  children,
}: MessageItemShellProps) {
  const isDeferredTrigger = role === 'user' && customType === 'deferred-trigger';
  return (
    <div
      class={cx(
        // Width is role-scoped rather than set on the shell and overridden
        // via the cascade. A previous `w-fit` base fought the streaming
        // `w-[...]` override: while the agent streamed, the bubble width
        // tracked its content (growing per token, widening on long code lines),
        // so the whole transcript column resized horizontally. Assistant
        // replies now always fill the allowed width (--message-assistant-width)
        // whether streaming or completed, so the column stays stable whatever
        // the content. User bubbles stay content-fit; system messages stretch
        // the full width. No width transition is added (would re-introduce
        // horizontal motion).
        'flex min-w-0 flex-col gap-2 rounded-xl px-3 py-2.5',
        'transition-[background-color,box-shadow] duration-[var(--panel-duration-normal)]',
        'forced-colors:border forced-colors:border-[ButtonText]',
        role === 'assistant' &&
          'self-start w-[min(var(--message-assistant-width),100%)] max-w-[min(var(--message-assistant-width),100%)] max-[340px]:w-[min(var(--message-assistant-width-narrow),100%)] max-[340px]:max-w-[min(var(--message-assistant-width-narrow),100%)] rounded-xl bg-card shadow-sm',
        role === 'user' && 'w-fit max-w-[var(--message-assistant-width)] self-end rounded-xl shadow-none',
        role === 'user' && !isDeferredTrigger && 'bg-accent/15',
        // Deferred-trigger wake-up: keep the user-bubble shape (it honestly
        // enters the transcript as a user turn) but swap the solid accent fill
        // for a muted surface + dashed accent outline so it reads as
        // host-injected rather than typed. The `.deferred-trigger-bubble`
        // class carries the dashed border + fill in transcript.css.
        role === 'user' && isDeferredTrigger && 'deferred-trigger-bubble',
        role === 'system' && 'w-auto max-w-none self-stretch bg-surface shadow-none',
        role === 'user' && status === 'queued' && 'opacity-60 ring-1 ring-border-subtle',
        isClickableUserMsg && 'cursor-pointer hover:ring-1 hover:ring-border-subtle hover:bg-accent/20',
      )}
      data-message-id={messageId}
      data-role={role}
      data-queued={role === 'user' && status === 'queued' ? 'true' : undefined}
      data-deferred-trigger={isDeferredTrigger ? 'true' : undefined}
      data-entered={entered ? 'true' : undefined}
      data-editing={isEditing ? 'true' : undefined}
      data-streaming={isCurrentlyStreaming ? 'true' : undefined}
      onClick={handleMessageClick}
      title={status === 'queued'
        ? 'Waiting for the current tool calls to finish; this message will be injected before the next model response.'
        : isClickableUserMsg ? 'Click to edit' : undefined}
    >
      {children}
    </div>
  );
}

interface MessageItemInnerProps {
  message: ChatMessage;
  isEditing: boolean;
  isCurrentlyStreaming: boolean;
  capturedHeight: number | null;
  initialInputs: ComposerInput[];
  pruningHeaderState: PruningHeaderState | undefined;
  pruningExpanded: boolean;
  setPruningExpanded: (fn: (v: boolean) => boolean) => void;
  pruningRawExpanded: boolean;
  setPruningRawExpanded: (fn: (v: boolean) => boolean) => void;
  statusLabel: string | null;
  statusTone: StatusTone;
  replyMeta: ReturnType<typeof assistantReplyMeta>;
  assistantMetaTooltip: string | null;
  html: string;
  getMessageRaw: () => string;
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  renderableUserParts: ReturnType<typeof getRenderableUserParts> | undefined;
  prefs: ChatPrefs;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  messageBodyRef: RefObject<HTMLDivElement>;
  hasActivityFooter: boolean | undefined;
  footerActivityState: TurnActivityState | null;
  recovery: { kind: 'available'; userId: string } | { kind: 'unloaded' } | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string, inputs?: ComposerInput[]) => void;
  onEditCancel: () => void;
  onCancelPrepass?: () => void;
}

export function MessageItemInner({
  message,
  isEditing,
  isCurrentlyStreaming,
  capturedHeight,
  initialInputs,
  pruningHeaderState,
  pruningExpanded,
  setPruningExpanded,
  pruningRawExpanded,
  setPruningRawExpanded,
  statusLabel,
  statusTone,
  replyMeta,
  assistantMetaTooltip,
  html,
  getMessageRaw,
  combinedParts,
  renderableUserParts,
  prefs,
  renderToolCall,
  onContextMenu,
  messageBodyRef,
  hasActivityFooter,
  footerActivityState,
  recovery,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onCancelPrepass,
}: MessageItemInnerProps) {
  const showHeaderActions = pruningHeaderState || statusLabel;
  const headerActions = showHeaderActions ? (
    <MessageHeaderActions
      pruningHeaderState={pruningHeaderState}
      pruningExpanded={pruningExpanded}
      onTogglePruning={() => setPruningExpanded((v) => !v)}
      statusLabel={statusLabel}
      statusTone={statusTone}
      onCancelPrepass={onCancelPrepass}
    />
  ) : null;

  return (
    <>
      <MessageItemHeader
        role={message.role}
        isCurrentlyStreaming={isCurrentlyStreaming}
        durationMs={message.durationMs}
        replyMeta={replyMeta}
        assistantMetaTooltip={assistantMetaTooltip}
        actions={headerActions}
        customType={message.customType}
      />

      {pruningHeaderState?.kind === 'result' && pruningExpanded && (
        <PruningHeaderPanel
          details={pruningHeaderState.details}
          rawExpanded={pruningRawExpanded}
          onRawToggle={() => setPruningRawExpanded((v) => !v)}
        />
      )}

      {message.status === 'error' && (
        <ErrorDetailWithFallback message={message} />
      )}

      {isEditing ? (
        <InlineEditor
          initialText={message.markdown}
          initialInputs={initialInputs}
          capturedHeight={capturedHeight}
          onConfirm={(text, inputs) => onEditConfirm(message.id, text, inputs)}
          onCancel={onEditCancel}
        />
      ) : (
        <>
          <MessageContent
            messageId={message.id}
            role={message.role}
            combinedParts={combinedParts}
            renderableUserParts={renderableUserParts}
            html={html}
            isCurrentlyStreaming={isCurrentlyStreaming}
            messageBodyRef={messageBodyRef}
            prefs={prefs}
            renderToolCall={renderToolCall}
            onContextMenu={onContextMenu}
            getMessageRaw={getMessageRaw}
          />

          <MessageFooter
            hasActivityFooter={hasActivityFooter}
            footerActivityState={footerActivityState}
            recovery={recovery}
            onEditRequest={onEditRequest}
          />
        </>
      )}
    </>
  );
}
