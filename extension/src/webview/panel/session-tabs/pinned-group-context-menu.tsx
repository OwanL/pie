/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import { writeTextToClipboard } from '../components/clipboard';
import { useMenuListeners } from '../components/useMenuListeners';
import { useMenuTriggerAria } from '../components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../components/useMenuViewportClamp';
import type { PinnedItem } from '../../../shared/tab-behavior';
import type { SessionSummary } from '../../../shared/protocol';
import type { SessionTabContextMenuState } from './types';
import { CheckmarkIcon, CloseIcon } from './icons';

export interface PinnedGroupContextMenuProps {
  menu: SessionTabContextMenuState;
  sessionByPath: Map<string, SessionSummary>;
  pinnedItems: PinnedItem[];
  onOpenGroup: (firstMemberPath: string) => void;
  onMergePinnedGroups: (sourcePath: string, targetPath: string) => void;
  onDissolvePinnedGroup: (sourcePath: string) => void;
  onUnpinPinnedGroup: (sourcePath: string) => void;
  onClose: () => void;
}

/** Dedicated context menu for a pinned group chip. Group-level mutations are
 * dispatched as one host command each; the webview never loops over members. */
export function PinnedGroupContextMenu({
  menu,
  sessionByPath,
  pinnedItems,
  onOpenGroup,
  onMergePinnedGroups,
  onDissolvePinnedGroup,
  onUnpinPinnedGroup,
  onClose,
}: PinnedGroupContextMenuProps) {
  const target = menu.target?.kind === 'group' ? menu.target : null;
  const members = target?.members ?? [];
  const sourcePath = menu.tabPath;
  const sourceName = sessionByPath.get(sourcePath)?.name ?? 'New Session';
  const mergeTargets = pinnedItems.filter((item): item is Extract<PinnedItem, { kind: 'group' }> => (
    item.kind === 'group' && item.members[0] !== sourcePath
  ));
  const { ref, pos } = useMenuViewportClamp({
    x: menu.x,
    y: menu.y,
    triggerEl: menu.triggerEl,
    restoreFocusOnClose: true,
    refocusKey: `${sourcePath}:${members.length}:${mergeTargets.length}`,
  });
  useMenuTriggerAria(menu.triggerEl);
  useMenuListeners(ref, onClose);

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copySessionPaths = () => {
    void writeTextToClipboard(members.join('\n')).then((success) => {
      setCopyState(success ? 'copied' : 'failed');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 1100);
    });
  };

  if (!target) return null;

  return (
    <div
      ref={ref}
      class="block-context-menu session-tab-context-menu pinned-group-context-menu"
      role="menu"
      aria-label={`${sourceName} pinned group actions`}
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div class="session-tab-context-title" title={sourceName}>{sourceName} · {members.length} sessions</div>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          onOpenGroup(sourcePath);
          onClose();
        }}
      >
        <CheckmarkIcon />
        Open Group
      </button>
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={copySessionPaths}
      >
        <CheckmarkIcon />
        {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed' : 'Copy Session Paths'}
      </button>
      <div class="context-menu-separator" role="separator" />
      {mergeTargets.map((item) => {
        const targetPath = item.members[0] ?? '';
        const targetName = sessionByPath.get(targetPath)?.name ?? 'New Session';
        return (
          <button
            key={`merge-with:${targetPath}`}
            class="context-menu-item"
            role="menuitem"
            type="button"
            onClick={() => {
              if (targetPath) onMergePinnedGroups(sourcePath, targetPath);
              onClose();
            }}
          >
            <CheckmarkIcon />
            Merge with {targetName} ({item.members.length})
          </button>
        );
      })}
      <div class="context-menu-separator" role="separator" />
      <button
        class="context-menu-item"
        role="menuitem"
        type="button"
        onClick={() => {
          onDissolvePinnedGroup(sourcePath);
          onClose();
        }}
      >
        <CheckmarkIcon />
        Dissolve Group
      </button>
      <button
        class="context-menu-item is-danger"
        role="menuitem"
        type="button"
        onClick={() => {
          onUnpinPinnedGroup(sourcePath);
          onClose();
        }}
      >
        <CloseIcon />
        Unpin Group
      </button>
    </div>
  );
}
