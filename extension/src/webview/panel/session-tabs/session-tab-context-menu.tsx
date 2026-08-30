/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveRunSummary, SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { writeTextToClipboard } from '../components/clipboard';
import { useMenuListeners } from '../components/useMenuListeners';
import { useMenuTriggerAria } from '../components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../components/useMenuViewportClamp';
import { getSessionTabRunMenuItems } from './run-state';
import type { SessionTabContextAction, SessionTabContextMenuState } from './types';
import type { PinnedItem } from '../../../shared/tab-behavior';
import { CheckmarkIcon, CloseIcon, DuplicateIcon } from './icons';

export interface SessionTabContextMenuProps {
  tabContextMenu: SessionTabContextMenuState;
  sessionByPath: Map<string, SessionSummary>;
  runSummary: ActiveRunSummary | null;
  isPinned: boolean;
  /** Rendered pinned strip items used for dynamic Group with… actions. */
  pinnedItems?: PinnedItem[];
  /** True when this tab's session owns a pending deferred trigger — greys out
   *  the Close Tab item with an explanatory tooltip. */
  hasDeferredTriggers: boolean;
  /** Create a new session (the strip's existing "+" affordance). */
  onNew: () => void;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
  onGroupPinnedTab?: (sourcePath: string, targetPath: string) => void;
  onUngroupPinnedTab?: (sourcePath: string, toItemIndex: number) => void;
  onClose?: () => void;
}

export function SessionTabContextMenu({
  tabContextMenu,
  sessionByPath,
  runSummary,
  isPinned,
  pinnedItems = [],
  hasDeferredTriggers,
  onNew,
  onContextAction,
  onGroupPinnedTab,
  onUngroupPinnedTab,
  onClose,
}: SessionTabContextMenuProps) {
  const ctxSession = sessionByPath.get(tabContextMenu.tabPath);
  const ctxLabel = ctxSession?.name ?? 'New Session';
  const isPending = isPendingTabPath(tabContextMenu.tabPath);
  const target = tabContextMenu.target;
  const isGroupMember = target?.kind === 'group-member';
  const groupActions = isPinned && target?.kind === 'tab'
    ? pinnedItems.filter((item) => item.kind === 'group' || item.path !== tabContextMenu.tabPath)
    : [];
  // "Pin and Merge" is only offered to unpinned, non-pending tabs with at
  // least one pinned strip item to merge into (the leftmost one).
  const canPinAndMerge = !isPinned && !isPending && target?.kind !== 'group' && pinnedItems.length > 0;
  const runItems = getSessionTabRunMenuItems(runSummary);
  const { ref, pos } = useMenuViewportClamp({
    x: tabContextMenu.x,
    y: tabContextMenu.y,
    triggerEl: tabContextMenu.triggerEl,
    restoreFocusOnClose: true,
    refocusKey: `${isPending}:${hasDeferredTriggers}:${isGroupMember}:${groupActions.length}:${canPinAndMerge}:${runItems.map((item) => item.action).join(',')}`,
  });
  useMenuTriggerAria(tabContextMenu.triggerEl);
  useMenuListeners(ref, onClose ?? (() => {}));

  // Webview-local copy feedback for "Copy Session Path" (same pattern as the
  // changed-file menu's Copy path). The timer is cleared on unmount.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const copySessionPath = () => {
    void writeTextToClipboard(tabContextMenu.tabPath).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1100);
    });
  };

  return (
    <div
      ref={ref}
      class="block-context-menu session-tab-context-menu"
      role="menu"
      aria-label={`${ctxLabel} tab actions`}
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class="session-tab-context-title" title={ctxLabel}>{ctxLabel}</div>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        title={isPending ? 'A pending session cannot be pinned yet.' : undefined}
        onClick={() => onContextAction(isPinned ? 'unpin' : 'pin', tabContextMenu.tabPath)}
      >
        <CheckmarkIcon />
        {isPinned ? 'Unpin Tab' : 'Pin Tab'}
      </button>
      {canPinAndMerge && (
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          title="Pin this tab and group it with the leftmost pinned tab (merging into a group when the leftmost item is one)"
          onClick={() => onContextAction('pin-merge', tabContextMenu.tabPath)}
        >
          <CheckmarkIcon />
          Pin and Merge
        </button>
      )}
      {isGroupMember && (
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => {
            if (onUngroupPinnedTab) onUngroupPinnedTab(tabContextMenu.tabPath, target.groupItemIndex);
            onClose?.();
          }}
        >
          <CheckmarkIcon />
          Remove from Group
        </button>
      )}
      {groupActions.length > 0 && (
        <>
          <div class="context-menu-separator" role="separator" />
          {groupActions.map((item) => {
            const targetPath = item.kind === 'group' ? (item.members[0] ?? '') : item.path;
            const targetName = sessionByPath.get(targetPath)?.name ?? 'New Session';
            const label = item.kind === 'group'
              ? `Group with ${targetName} (${item.members.length})`
              : `Group with ${targetName}`;
            return (
              <button
                key={`group-with:${targetPath}`}
                class="context-menu-item"
                role="menuitem"
                type="button"
                onClick={() => {
                  if (targetPath && onGroupPinnedTab) onGroupPinnedTab(tabContextMenu.tabPath, targetPath);
                  onClose?.();
                }}
              >
                <CheckmarkIcon />
                {label}
              </button>
            );
          })}
        </>
      )}
      <div class="context-menu-separator" role="separator" />
      {runItems.map((item) => (
        <button
          key={item.action}
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => onContextAction(item.action, tabContextMenu.tabPath)}
        >
          <CheckmarkIcon />
          {item.label}
        </button>
      ))}
      {runItems.length > 0 && <div class="context-menu-separator" role="separator" />}
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        onClick={() => onContextAction('duplicate', tabContextMenu.tabPath)}
      >
        <DuplicateIcon />
        Duplicate Tab
      </button>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={hasDeferredTriggers}
        title={hasDeferredTriggers ? 'Pending deferred trigger(s) — cancel from the status bar first.' : undefined}
        onClick={() => onContextAction('close', tabContextMenu.tabPath)}
      >
        <CloseIcon />
        Close Tab
      </button>
      <div class="context-menu-separator" role="separator" />
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        title="Create a new session in this tab strip"
        onClick={() => {
          onNew();
          onClose?.();
        }}
      >
        <CheckmarkIcon />
        New Session
      </button>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        title={isPending ? 'The session path exists once the session has been created.' : undefined}
        onClick={copySessionPath}
      >
        <CheckmarkIcon />
        {copied ? 'Copied!' : 'Copy Session Path'}
      </button>
    </div>
  );
}
