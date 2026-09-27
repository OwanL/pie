/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMenuListeners } from './useMenuListeners';
import { useState } from 'preact/hooks';

import type { ChatPrefs } from '../../../lib/protocol/index.js';
import {
  type ChatPrefContextType,
  type TranscriptContextMenuType,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  toggleChatPrefForContext,
} from '../../shell/chat-prefs';
import type { TranscriptFilePathMenuInfo, TranscriptMessageMenuInfo } from '../../transcript/types';
import { writeTextToClipboard } from './clipboard';
import { markdownToReadableText } from './selection-copy';
import { useMenuTriggerAria } from './useMenuTriggerAria';
import { useMenuViewportClamp } from './useMenuViewportClamp';

export interface ContextMenuState {
  type: TranscriptContextMenuType;
  rawData: string;
  /** Session that owned the trigger when the menu opened. Message actions use
   * this captured address rather than the mutable active-session selection. */
  sessionPath: string | null;
  /** Message-level metadata captured when the menu was opened inside a
   *  transcript message row (bound once per row by MessageItemView). Powers
   *  message-scoped Copy, Copy as Markdown, Edit, and Delete from here actions.
   *  Absent for filePath menus and menus opened outside a message row. */
  message?: Partial<TranscriptMessageMenuInfo> | null;
  /** Original reference and captured cwd for file-path Open File fallback.
   *  rawData stays the resolved path so Copy Path preserves its semantics. */
  filePath?: TranscriptFilePathMenuInfo | null;
  /** The live selected text and its Markdown serialization captured before
   * menu focus moves and can collapse the document selection. */
  selectionText: string;
  selectionMarkdown?: string;
  x: number;
  y: number;
  /** The trigger element that opened the menu (the onContextMenu target),
   * used to mirror the menu's open state back onto the trigger via
   * aria-haspopup/aria-expanded. Captured from the contextmenu event in
   * handleOpenContextMenu (use-app-handlers.ts). */
  triggerEl: HTMLElement | null;
}

export function ContextMenu({
  menu,
  prefs,
  onSetPrefs,
  onOpenFile,
  onEditMessage,
  onTruncateAfter,
  onClose,
}: {
  menu: ContextMenuState;
  prefs: ChatPrefs;
  onSetPrefs: (p: Partial<ChatPrefs>) => void;
  onOpenFile: (path: string, reference?: string, workingDirectory?: string) => void;
  /** Edit an eligible user message (routes to the existing `startEdit` flow). */
  onEditMessage: (sessionPath: string, messageId: string) => void;
  /** Destructive "Delete from here" (host-validated truncateAfter). */
  onTruncateAfter: (sessionPath: string, messageId: string) => void;
  onClose: () => void;
}) {
  const { ref, pos } = useMenuViewportClamp({
    x: menu.x,
    y: menu.y,
    triggerEl: menu.triggerEl,
    restoreFocusOnClose: true,
  });
  useMenuTriggerAria(menu.triggerEl);

  // "Delete from here" is destructive (truncates this message and everything
  // after it), so it takes a two-step confirm: click turns the item into
  // "Confirm delete?", a second click issues the command. The component only
  // mounts while a menu is open, so confirming state resets on close.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copyFailure, setCopyFailure] = useState(false);
  const meta = menu.message ?? null;
  const copyAndClose = (text: string) => {
    setCopyFailure(false);
    void writeTextToClipboard(text).then((copied) => {
      if (copied) onClose();
      else setCopyFailure(true);
    });
  };
  const copyFailureNotice = copyFailure ? (
    <div role="status" aria-live="polite" style="padding:4px 10px;color:var(--panel-muted);font-size:11px">
      Couldn’t copy to clipboard.
    </div>
  ) : null;

  const onMenuKey = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Node && ref.current?.contains(target))) return;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
    if (!menu.selectionText || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== 'c') return;

    event.preventDefault();
    setCopyFailure(false);
    void writeTextToClipboard(menu.selectionText).then((copied) => {
      if (!copied) setCopyFailure(true);
    });
  };

  // Transcript menus intentionally remain open during scrolling: the menu is
  // fixed and transcript auto-scroll is part of normal streaming behavior.
  useMenuListeners(ref, onClose, { onKey: onMenuKey });

  const style = `position:fixed;top:${pos.top}px;left:${pos.left}px`;

  if (menu.type === 'filePath') {
    return (
      <div ref={ref} class="block-context-menu" role="menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => {
            onOpenFile(menu.rawData, menu.filePath?.reference, menu.filePath?.workingDirectory);
            onClose();
          }}
        >
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
          Open File
        </button>
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => {
            copyAndClose(menu.rawData);
          }}
        >
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
          Copy Path
        </button>
        {copyFailureNotice}
      </div>
    );
  }

  const prefType: ChatPrefContextType | null = menu.type === 'message' ? null : menu.type;
  const checked = prefType ? getChatPrefContextValue(prefs, prefType) : false;
  const expandLabel = prefType ? getChatPrefContextLabel(prefType) : '';
  const expandToggle = prefType ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        onSetPrefs(toggleChatPrefForContext(prefs, prefType));
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={checked ? '' : 'opacity:0'}>
        <polyline points="2.5,6.5 5,9 10.5,3.5" />
      </svg>
      {expandLabel}
    </button>
  ) : null;

  const hasMessageCopy = menu.type === 'message' || menu.type === 'reasoning';
  const markdownBody = menu.type === 'reasoning'
    ? meta?.markdownText ?? meta?.plainText ?? menu.rawData
    : meta?.markdownText ?? meta?.plainText ?? '';
  const hasSelection = menu.selectionText.length > 0;

  // Message and reasoning menus have one plain-text and one Markdown action.
  // A captured selection always wins over the entire message/block body.
  const copyMessageText = hasMessageCopy ? (
    <button class="context-menu-item" role="menuitem" type="button" onClick={() => copyAndClose(
      hasSelection ? menu.selectionText : markdownToReadableText(markdownBody),
    )}>
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy
    </button>
  ) : null;
  const copyMessageMarkdown = hasMessageCopy ? (
    <button class="context-menu-item" role="menuitem" type="button" onClick={() => copyAndClose(
      hasSelection ? menu.selectionMarkdown ?? menu.selectionText : markdownBody,
    )}>
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy as Markdown
    </button>
  ) : null;

  // Tool-specific menus retain their existing selection / renderer-provided
  // text behavior and Copy raw action; tool JSON is not called Markdown.
  const copySelection = !hasMessageCopy && hasSelection ? (
    <button class="context-menu-item" role="menuitem" type="button" onClick={() => copyAndClose(menu.selectionText)}>
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy
    </button>
  ) : null;
  const plainText = meta?.plainText;
  const copyText = !hasMessageCopy && plainText?.trim() ? (
    <button class="context-menu-item" role="menuitem" type="button" onClick={() => copyAndClose(plainText)}>
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy text
    </button>
  ) : null;

  // Edit an eligible user message (durable, not streaming, not readonly, not
  // already inline-editing) through the existing startEdit flow.
  const messageId = meta?.messageId;
  const editItem = meta?.editable && messageId && menu.sessionPath ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        onEditMessage(menu.sessionPath!, messageId);
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Edit
    </button>
  ) : null;

  // Destructive "Delete from here": host-validated truncateAfter. Two-step
  // confirm guards the destructive dispatch.
  const truncateItem = meta?.canTruncate && messageId && menu.sessionPath ? (
    <button
      class={`context-menu-item${confirmingDelete ? ' is-danger' : ''}`}
      role="menuitem"
      type="button"
      onClick={() => {
        if (confirmingDelete) {
          onTruncateAfter(menu.sessionPath!, messageId);
          onClose();
        } else {
          setConfirmingDelete(true);
        }
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      {confirmingDelete ? 'Confirm delete?' : 'Delete from here'}
    </button>
  ) : null;

  const destructiveGroup = editItem || truncateItem ? (
    <>
      <div class="context-menu-separator" role="separator" />
      {editItem}
      {truncateItem}
    </>
  ) : null;

  return (
    <div ref={ref} class="block-context-menu" role="menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {expandToggle}
      {copyMessageText}
      {copyMessageMarkdown}
      {copySelection}
      {copyText}
      {!hasMessageCopy ? (
        <button class="context-menu-item" role="menuitem" type="button" onClick={() => copyAndClose(menu.rawData)}>
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
          Copy raw
        </button>
      ) : null}
      {copyFailureNotice}
      {destructiveGroup}
    </div>
  );
}
