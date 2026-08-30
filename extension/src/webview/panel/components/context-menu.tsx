/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMenuListeners } from './useMenuListeners';
import { useState } from 'preact/hooks';

import type { ChatPrefs } from '../../../shared/protocol';
import {
  type ChatPrefContextType,
  type TranscriptContextMenuType,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  toggleChatPrefForContext,
} from '../chat-prefs';
import type { TranscriptMessageMenuInfo } from '../transcript/types';
import { writeTextToClipboard } from './clipboard';
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
   *  the message-scoped actions: Edit, Delete from here, and plain-text Copy
   *  when a plain-text representation exists. Absent for filePath menus and
   *  menus opened outside a message row. */
  message?: Partial<TranscriptMessageMenuInfo> | null;
  /** The live text selection captured at the moment the menu was opened, so
   * the "Copy" item can copy just the user's selection instead of the whole
   * block. Captured in handleOpenContextMenu (use-app-handlers.ts) rather than
   * at click time because the menu's focus-management moves focus to the
   * first item on open, which can clear the document's live selection. */
  selectionText: string;
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
  onOpenFile: (path: string) => void;
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
  const meta = menu.message ?? null;

  // Transcript menus intentionally remain open during scrolling: the menu is
  // fixed and transcript auto-scroll is part of normal streaming behavior.
  useMenuListeners(ref, onClose);

  const style = `position:fixed;top:${pos.top}px;left:${pos.left}px`;

  if (menu.type === 'filePath') {
    return (
      <div ref={ref} class="block-context-menu" role="menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => {
            onOpenFile(menu.rawData);
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
            void writeTextToClipboard(menu.rawData);
            onClose();
          }}
        >
          <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
          Copy Path
        </button>
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

  // Copy the user's current text selection. Only shown when a non-empty
  // selection was captured at open time, so right-clicking selected text gives
  // the familiar "copy what I highlighted" action instead of forcing the
  // whole-block "Copy raw".
  const copySelection = menu.selectionText ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        void writeTextToClipboard(menu.selectionText);
        onClose();
      }}
    >
      <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
      Copy
    </button>
  ) : null;

  // Copy the message's plain-text (markdown source) body. Only shown when a
  // plain-text representation exists — right-clicking a reasoning block or a
  // tool card leaves the copy surface to "Copy raw" (the JSON dump).
  const plainText = meta?.plainText;
  const copyText = plainText?.trim() ? (
    <button
      class="context-menu-item"
      role="menuitem"
      type="button"
      onClick={() => {
        void writeTextToClipboard(plainText);
        onClose();
      }}
    >
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
      {copySelection}
      {copyText}
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          void writeTextToClipboard(menu.rawData);
          onClose();
        }}
      >
        <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
        Copy raw
      </button>
      {destructiveGroup}
    </div>
  );
}
