/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';

import type { SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';

export interface PinnedTabGroupProps {
  /** Member paths in insertion order. Any member identifies the group; the
   *  first member is used as the chip's data-pinned-item-path identifier. */
  members: string[];
  /** Position of this group chip among the pinned items (seeds the initial
   *  drag drop gap). */
  itemIndex: number;
  sessionByPath: Map<string, SessionSummary>;
  runningPathSet: Set<string>;
  startingModelPathSet: Set<string>;
  unreadFinishedPathSet: Set<string>;
  deferredTimerPathSet: Set<string>;
  /** Effective active session path (host or optimistic). */
  activePath: string | null;
  /** Whether this chip is the current group/merge drop target (highlight). */
  isDropTarget: boolean;
  /** Whether the dropdown is open. */
  open: boolean;
  onToggleOpen: (firstMemberPath: string) => void;
  onClose: () => void;
  onSelectMember: (path: string) => void;
  /** Start a drag of the whole group chip. */
  onChipPointerDown: (event: PointerEvent, sourcePath: string, itemIndex: number) => void;
  /** Start a drag of a dropdown member (ungroup on gap-drop). */
  onMemberPointerDown: (event: PointerEvent, sourcePath: string) => void;
}

/** Tiles shown in the 2×2 avatar grid: up to 4 members, or the first 3 plus a
 *  "+" tile when there are 5 or more. */
type AvatarTile = { kind: 'avatar'; path: string } | { kind: 'plus'; count: number };

function buildAvatarTiles(members: readonly string[]): AvatarTile[] {
  if (members.length <= 4) {
    return members.map((path) => ({ kind: 'avatar', path } as AvatarTile));
  }
  return [
    ...members.slice(0, 3).map((path) => ({ kind: 'avatar', path } as AvatarTile)),
    { kind: 'plus', count: members.length },
  ];
}

function PinnedTabGroupView({
  members,
  itemIndex,
  sessionByPath,
  runningPathSet,
  startingModelPathSet,
  unreadFinishedPathSet,
  deferredTimerPathSet,
  activePath,
  isDropTarget,
  open,
  onToggleOpen,
  onClose,
  onSelectMember,
  onChipPointerDown,
  onMemberPointerDown,
}: PinnedTabGroupProps) {
  const chipRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const firstMember = members[0] ?? '';
  const hasActiveMember = activePath !== null && members.includes(activePath);

  // Measure the chip's viewport rect when the dropdown opens so the dropdown
  // can be fixed-positioned just below it (escaping the strip's overflow).
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const chip = chipRef.current;
    if (!chip) return;
    const rect = chip.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 2, left: rect.left });
  }, [open]);

  // Close on outside pointerdown / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && dropdownRef.current?.contains(target)) return;
      if (target && chipRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  const onChipClick = useCallback(() => {
    onToggleOpen(firstMember);
  }, [onToggleOpen, firstMember]);

  const tiles = buildAvatarTiles(members);

  const chipClassBits = ['pinned-tab-group'];
  if (hasActiveMember) chipClassBits.push('active');
  if (isDropTarget) chipClassBits.push('drop-target-on');
  if (open) chipClassBits.push('open');

  return (
    <>
      <div
        ref={chipRef}
        class={chipClassBits.join(' ')}
        data-pinned-item="true"
        data-pinned-item-path={firstMember}
        data-pinned-item-group="true"
        title={`${members.length} pinned sessions`}
      >
        <button
          class="pinned-tab-group-main"
          type="button"
          aria-label={`Pinned group of ${members.length} sessions`}
          aria-expanded={open}
          onClick={onChipClick}
          onPointerDown={(event) => onChipPointerDown(event as PointerEvent, firstMember, itemIndex)}
        >
          <span class="pinned-tab-group-grid" aria-hidden="true">
            {tiles.map((tile, index) =>
              tile.kind === 'plus' ? (
                <span key={`plus:${index}`} class="pinned-tab-group-tile pinned-tab-group-plus" aria-hidden="true">
                  +
                </span>
              ) : (
                <span
                  key={tile.path}
                  class={`pinned-tab-group-tile${activePath === tile.path ? ' member-active' : ''}`}
                  style={{ background: getTabAvatarColor(tile.path) }}
                  aria-hidden="true"
                >
                  {getTabAvatarLabel(sessionByPath.get(tile.path)?.name ?? '?')}
                </span>
              ),
            )}
          </span>
        </button>
      </div>
      {open && anchor && (
        <div
          ref={dropdownRef}
          class="pinned-tab-group-dropdown"
          style={{ top: `${anchor.top}px`, left: `${anchor.left}px` }}
          role="list"
          aria-label="Pinned group members"
        >
          {members.map((memberPath) => {
            const session = sessionByPath.get(memberPath);
            const label = session?.name ?? 'New Session';
            const isActive = activePath === memberPath;
            const isRunning = runningPathSet.has(memberPath);
            const isStartingModel = isRunning && startingModelPathSet.has(memberPath);
            const isUnreadFinished = unreadFinishedPathSet.has(memberPath) && !deferredTimerPathSet.has(memberPath);
            const isPreparing = isPendingTabPath(memberPath);
            const isDeferredTimer = deferredTimerPathSet.has(memberPath);
            const rowClassBits = ['pinned-tab-group-member'];
            if (isActive) rowClassBits.push('active');
            if (isRunning) rowClassBits.push('running');
            return (
              <button
                key={memberPath}
                class={rowClassBits.join(' ')}
                type="button"
                title={label}
                onClick={() => onSelectMember(memberPath)}
                onPointerDown={(event) => onMemberPointerDown(event as PointerEvent, memberPath)}
              >
                <span
                  class="pinned-tab-group-member-avatar"
                  style={{ background: getTabAvatarColor(memberPath) }}
                  aria-hidden="true"
                >
                  {getTabAvatarLabel(label)}
                </span>
                <span class="pinned-tab-group-member-label">{label}</span>
                {isRunning || isPreparing
                  ? <span class={isStartingModel ? 'session-tab-running starting-model' : 'session-tab-running'} aria-hidden="true" />
                  : isDeferredTimer
                    ? <span class="session-tab-deferred-timer" aria-hidden="true">⌛</span>
                    : isUnreadFinished
                      ? <span class="session-tab-finished" aria-hidden="true" />
                      : null}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

export const PinnedTabGroup = memo(PinnedTabGroupView);
