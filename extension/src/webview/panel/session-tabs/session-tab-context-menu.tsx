/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ActiveRunSummary, SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { getSessionTabRunMenuItems } from './run-state';
import type { SessionTabContextAction } from './types';
import { CheckmarkIcon, CloseIcon, DuplicateIcon } from './icons';

export interface SessionTabContextMenuProps {
  tabContextMenu: { x: number; y: number; tabPath: string };
  sessionByPath: Map<string, SessionSummary>;
  runSummary: ActiveRunSummary | null;
  isPinned: boolean;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
}

export function SessionTabContextMenu({
  tabContextMenu,
  sessionByPath,
  runSummary,
  isPinned,
  onContextAction,
}: SessionTabContextMenuProps) {
  const ctxSession = sessionByPath.get(tabContextMenu.tabPath);
  const ctxLabel = ctxSession?.name ?? 'New Session';
  const isPending = isPendingTabPath(tabContextMenu.tabPath);
  const menuTop = Math.min(tabContextMenu.y, window.innerHeight - 100);
  const menuLeft = Math.min(tabContextMenu.x, window.innerWidth - 210);
  const runItems = getSessionTabRunMenuItems(runSummary);

  return (
    <div
      class="block-context-menu session-tab-context-menu"
      style={`position:fixed;top:${menuTop}px;left:${menuLeft}px`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class="session-tab-context-title" title={ctxLabel}>{ctxLabel}</div>
      <button
        class="context-menu-item"
        type="button"
        onClick={() => onContextAction(isPinned ? 'unpin' : 'pin', tabContextMenu.tabPath)}
      >
        <CheckmarkIcon />
        {isPinned ? 'Unpin Tab' : 'Pin Tab'}
      </button>
      <div class="context-menu-separator" />
      {runItems.map((item) => (
        <button
          key={item.action}
          class="context-menu-item"
          type="button"
          onClick={() => onContextAction(item.action, tabContextMenu.tabPath)}
        >
          <CheckmarkIcon />
          {item.label}
        </button>
      ))}
      {runItems.length > 0 && <div class="context-menu-separator" />}
      <button
        class="context-menu-item"
        type="button"
        disabled={isPending}
        onClick={() => onContextAction('duplicate', tabContextMenu.tabPath)}
      >
        <DuplicateIcon />
        Duplicate Tab
      </button>
      <button
        class="context-menu-item"
        type="button"
        onClick={() => onContextAction('close', tabContextMenu.tabPath)}
      >
        <CloseIcon />
        Close Tab
      </button>
    </div>
  );
}
