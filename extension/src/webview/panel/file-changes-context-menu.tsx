/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileChangeKind } from '../../shared/protocol';
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
}

/**
 * Self-contained right-click menu for a changed-file row. Hosts the secondary
 * actions (Copy path, Revert) that don't earn a spot in the per-row hover
 * buttons — those stay limited to the two primary actions (View diff, View in
 * editor). Revert is a two-step confirm (click -> "Confirm revert?" -> click) to
 * guard the destructive op, mirroring the old in-row RevertButton. Positioned
 * and clamped to the viewport, dismissed on click-outside / Escape / scroll /
 * resize (same posture as the transcript ContextMenu). Rendered at the rail
 * level (position: fixed) so it escapes the drawer's overflow clipping.
 */
export function FileChangeContextMenu({
  menu,
  parentDepth,
  onRevert,
  onSetFileRead,
  onClose,
}: {
  menu: FileChangeContextMenuState;
  parentDepth?: number;
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
  });

  // Clear the copied-feedback timer when the menu closes.
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // Dismiss on click-outside / Escape / scroll / resize.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const scroll = () => onClose();
    const resize = () => onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [onClose]);

  const copyPath = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(menu.path)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {
        /* ignore */
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
      <div class="context-menu-separator" />
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
