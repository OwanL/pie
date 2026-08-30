/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileChangeKind } from '../../shared/protocol';
import { writeTextToClipboard } from './components/clipboard';
import { useMenuListeners } from './components/useMenuListeners';
import { useMenuTriggerAria } from './components/useMenuTriggerAria';
import { useMenuViewportClamp } from './components/useMenuViewportClamp';
import { KIND_LABEL } from './file-changes-stats';
import { formatPathWithParentDepth } from './file-path';

export interface FileChangeContextMenuState {
  x: number;
  y: number;
  path: string;
  kind: FileChangeKind;
  /** Captured at open time so the menu can label/perform mark-read vs unread. */
  read: boolean;
  /** The row control which opened the menu, used for ARIA and focus restore. */
  triggerEl?: HTMLElement | null;
}

/**
 * Self-contained right-click menu for a changed-file row. Parity with the
 * per-row hover actions (Open in editor, View diff) plus the secondary actions
 * (Copy path, Mark read/unread, Revert). Revert is a two-step confirm (click
 * -> "Confirm revert?" -> click) to guard the destructive op, mirroring the
 * old in-row RevertButton. Positioned and clamped to the viewport, dismissed
 * on click-outside / Escape / scroll / resize (same posture as the transcript
 * ContextMenu). Rendered at the rail level (position: fixed) so it escapes
 * the drawer's overflow clipping.
 */
export function FileChangeContextMenu({
  menu,
  parentDepth,
  onOpenDiff,
  onOpenInEditor,
  onRevert,
  onSetFileRead,
  onClose,
}: {
  menu: FileChangeContextMenuState;
  parentDepth?: number;
  /** Show the file's diff (same target as the per-row LineStats click). */
  onOpenDiff: (path: string) => void;
  /** Open the file in the editor. Disabled for deleted files (no file to open). */
  onOpenInEditor: (path: string) => void;
  onRevert: (path: string) => void;
  onSetFileRead: (path: string, read: boolean) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { ref, pos } = useMenuViewportClamp({
    x: menu.x,
    y: menu.y,
    triggerEl: menu.triggerEl,
    restoreFocusOnClose: true,
  });
  useMenuTriggerAria(menu.triggerEl);
  useMenuListeners(ref, onClose, { closeOnScroll: true });

  // Clear the copied-feedback timer when the menu closes.
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copyPath = () => {
    void writeTextToClipboard(menu.path).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1100);
    });
  };

  const onRevertClick = () => {
    if (confirming) {
      onRevert(menu.path);
      onClose();
    } else {
      setConfirming(true);
    }
  };

  return (
    <div
      ref={ref}
      class="block-context-menu file-change-context-menu"
      role="menu"
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class="file-change-ctx-title" title={menu.path}>
        {KIND_LABEL[menu.kind]} · {parentDepth !== undefined ? formatPathWithParentDepth(menu.path, parentDepth) : menu.path}
      </div>
      <div class="context-menu-separator" role="separator" />
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={menu.kind === 'deleted'}
        title={menu.kind === 'deleted' ? 'The file was deleted — there is nothing to open.' : undefined}
        onClick={() => {
          onOpenInEditor(menu.path);
          onClose();
        }}
      >
        <span class="context-menu-check" aria-hidden="true" />
        Open in editor
      </button>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          onOpenDiff(menu.path);
          onClose();
        }}
      >
        <span class="context-menu-check" aria-hidden="true" />
        View diff
      </button>
      <div class="context-menu-separator" role="separator" />
      <button class="context-menu-item" role="menuitem" type="button" onClick={copyPath}>
        <span class="context-menu-check" aria-hidden="true" />
        {copied ? 'Copied!' : 'Copy path'}
      </button>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          onSetFileRead(menu.path, !menu.read);
          onClose();
        }}
      >
        <span class="context-menu-check" aria-hidden="true" />
        {menu.read ? 'Mark as unread' : 'Mark as read'}
      </button>
      <div class="context-menu-separator" role="separator" />
      <button
        class={`context-menu-item${confirming ? ' is-danger' : ''}`}
        role="menuitem"
        type="button"
        onClick={onRevertClick}
      >
        <span class="context-menu-check" aria-hidden="true" />
        {confirming ? 'Confirm revert?' : 'Revert changes'}
      </button>
    </div>
  );
}
