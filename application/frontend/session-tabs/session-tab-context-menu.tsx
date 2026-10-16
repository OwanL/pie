/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveRunSummary, SessionSummary } from '../../lib/protocol/index.js';
import { isPendingTabPath } from '../../lib/session-tabs/tab-behavior.js';
import { writeTextToClipboard } from '../lib/components/clipboard';
import { useMenuListeners } from '../lib/components/useMenuListeners';
import { useMenuTriggerAria } from '../lib/components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../lib/components/useMenuViewportClamp';
import { getSessionTabRunMenuItems } from './run-state';
import type { SessionTabContextAction, SessionTabContextMenuState } from './types';
import type { PinnedItem } from '../../lib/session-tabs/tab-behavior.js';
import { type SnoozeDuration } from './snooze';
import { SnoozeSubmenu } from './snooze-submenu';

export interface SessionTabContextMenuProps {
  tabContextMenu: SessionTabContextMenuState;
  sessionByPath: Map<string, SessionSummary>;
  runSummary: ActiveRunSummary | null;
  isPinned: boolean;
  /** Rendered pinned strip items used for dynamic Group with… actions. */
  pinnedItems?: PinnedItem[];
  /** True when this tab's session is the delivery target of a pending
   *  deferred trigger — greys out the Close tab item with an explanatory
   *  tooltip. */
  hasDeferredTriggers: boolean;
  snoozeBlockedReason?: string;
  onSnooze?: (path: string, duration: SnoozeDuration) => void;
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
  snoozeBlockedReason,
  onSnooze,
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
  // "Pin and group" is only offered to unpinned, non-pending tabs with at
  // least one pinned strip item to merge into (the leftmost one).
  const canPinAndMerge = !isPinned && !isPending && target?.kind !== 'group' && pinnedItems.length > 0;
  const runItems = getSessionTabRunMenuItems(runSummary);
  const [snoozeView, setSnoozeView] = useState(false);
  const snoozeReason = isPending ? 'A pending session cannot be snoozed yet.'
    : hasDeferredTriggers ? 'Cancel pending deferred triggers before snoozing.' : snoozeBlockedReason;
  const { ref, pos } = useMenuViewportClamp({
    x: tabContextMenu.x,
    y: tabContextMenu.y,
    triggerEl: tabContextMenu.triggerEl,
    restoreFocusOnClose: true,
    refocusKey: `${snoozeReason}:${isPending}:${hasDeferredTriggers}:${isGroupMember}:${groupActions.length}:${canPinAndMerge}:${runItems.map((item) => item.action).join(',')}`,
  });
  const snoozeItemRef = useRef<HTMLButtonElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const closeChild = () => { cancelClose(); setSnoozeView(false); snoozeItemRef.current?.focus(); };
  const openChild = (keyboard: boolean) => {
    cancelClose();
    if (snoozeReason) return;
    setKeyboardOpen(keyboard); setSnoozeView(true);
  };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setSnoozeView(false), 350); };
  useEffect(() => () => cancelClose(), []);
  useMenuTriggerAria(tabContextMenu.triggerEl);
  useMenuListeners(ref, () => {
    if (snoozeView) closeChild();
    else onClose?.();
  }, {
    onOutsideClick: (event) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !childRef.current?.contains(event.target as Node)) onClose?.();
    },
    onResize: () => onClose?.(),
    onKey: (event) => {
      if (event.key === 'ArrowRight' && document.activeElement === snoozeItemRef.current) {
        event.preventDefault(); openChild(true);
      }
    },
  });

  // Webview-local copy feedback for "Copy session path" (same pattern as the
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
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        title={isPending ? 'The session path exists once the session has been created.' : undefined}
        onClick={copySessionPath}
      >
        {copied ? 'Copied!' : 'Copy session path'}
      </button>
      <div class="context-menu-separator" role="separator" />
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        title={isPending ? 'A pending session cannot be pinned yet.' : undefined}
        onClick={() => onContextAction(isPinned ? 'unpin' : 'pin', tabContextMenu.tabPath)}
      >
        {isPinned ? 'Unpin tab' : 'Pin tab'}
      </button>
      {canPinAndMerge && (
        <button
          class="context-menu-item"
          role="menuitem"
          type="button"
          title="Pin this tab and group it with the leftmost pinned tab (merging into a group when the leftmost item is one)"
          onClick={() => onContextAction('pin-merge', tabContextMenu.tabPath)}
        >
          Pin and group
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
          Remove from group
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
                {label}
              </button>
            );
          })}
        </>
      )}
      {runItems.map((item) => (
        <button
          key={item.action}
          class="context-menu-item"
          role="menuitem"
          type="button"
          onClick={() => onContextAction(item.action, tabContextMenu.tabPath)}
        >
          {item.label}
        </button>
      ))}
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={isPending}
        onClick={() => onContextAction('duplicate', tabContextMenu.tabPath)}
      >
        Duplicate tab
      </button>
      <button ref={snoozeItemRef} class="context-menu-item" role="menuitem" type="button"
        disabled={!!snoozeReason} title={snoozeReason}
        aria-haspopup="menu" aria-expanded={snoozeView}
        aria-label={snoozeReason ? `Snooze…: ${snoozeReason}` : undefined}
        onMouseEnter={() => openChild(false)} onMouseLeave={scheduleClose}
        onClick={() => openChild(true)}>
        Snooze…<span class="snooze-submenu-arrow" aria-hidden="true">›</span>
      </button>
      {snoozeView && snoozeItemRef.current && <SnoozeSubmenu trigger={snoozeItemRef.current}
        menuRef={childRef} label={ctxLabel} reason={snoozeReason} keyboard={keyboardOpen}
        onClose={closeChild} onEnter={cancelClose} onLeave={scheduleClose}
        onSelect={(duration) => { onSnooze?.(tabContextMenu.tabPath, duration); onClose?.(); }} />}
      <div class="context-menu-separator" role="separator" />
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        disabled={hasDeferredTriggers}
        title={hasDeferredTriggers ? 'Pending deferred trigger(s) — cancel from the status bar first.' : undefined}
        onClick={() => onContextAction('close', tabContextMenu.tabPath)}
      >
        Close tab
      </button>
    </div>
  );
}
