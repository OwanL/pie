/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';

import type { SessionSummary } from '../../../shared/protocol';
import type { SessionTabDragState } from './types';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';

export interface FloatingSessionTabProps {
  dragState: SessionTabDragState;
  draggedPath: string;
  sessionByPath: Map<string, SessionSummary>;
  runningPathSet: Set<string>;
  activeSession: SessionSummary | null;
  isPinned: boolean;
  /** When the drag is a group chip, the member paths to render in the ghost's
   *  2×2 avatar grid (instead of a single avatar). */
  draggedMembers?: string[];
  ghostRef: RefObject<HTMLDivElement>;
}

type GhostTile = { kind: 'avatar'; path: string } | { kind: 'plus'; count: number };

function buildGhostTiles(members: readonly string[]): GhostTile[] {
  if (members.length <= 4) {
    return members.map((path) => ({ kind: 'avatar', path } as GhostTile));
  }
  return [
    ...members.slice(0, 3).map((path) => ({ kind: 'avatar', path } as GhostTile)),
    { kind: 'plus', count: members.length },
  ];
}

export function FloatingSessionTab({
  dragState,
  draggedPath,
  sessionByPath,
  runningPathSet,
  activeSession,
  isPinned,
  draggedMembers,
  ghostRef,
}: FloatingSessionTabProps) {
  const floatingSession = sessionByPath.get(draggedPath);
  const floatingLabel = floatingSession?.name ?? 'New Session';
  const floatingRunning = runningPathSet.has(draggedPath);
  const floatingActive = activeSession?.path === draggedPath;
  const isGroupChip = !!draggedMembers && draggedMembers.length > 0;

  if (isGroupChip) {
    const tiles = buildGhostTiles(draggedMembers!);
    const hasActiveMember = activeSession?.path != null && draggedMembers!.includes(activeSession.path);
    const classBits = ['pinned-tab-group', 'session-tab-floating'];
    if (hasActiveMember) classBits.push('active');
    return (
      <div
        ref={ghostRef}
        class={classBits.join(' ')}
        style={{
          width: `${dragState.tabWidth}px`,
          height: `${dragState.tabHeight}px`,
          left: 0,
          top: `${dragState.tabTop}px`,
        }}
        aria-hidden="true"
      >
        <div class="pinned-tab-group-main">
          <span class="pinned-tab-group-grid" aria-hidden="true">
            {tiles.map((tile, index) =>
              tile.kind === 'plus' ? (
                <span key={`plus:${index}`} class="pinned-tab-group-tile pinned-tab-group-plus" aria-hidden="true">+</span>
              ) : (
                <span
                  key={tile.path}
                  class="pinned-tab-group-tile"
                  style={{ background: getTabAvatarColor(tile.path) }}
                  aria-hidden="true"
                >
                  {getTabAvatarLabel(sessionByPath.get(tile.path)?.name ?? '?')}
                </span>
              ),
            )}
          </span>
        </div>
      </div>
    );
  }

  const classBits = ['session-tab', 'session-tab-floating'];
  if (floatingActive) classBits.push('active');
  if (isPinned) classBits.push('pinned');
  if (floatingRunning) classBits.push('running');

  return (
    <div
      ref={ghostRef}
      class={classBits.join(' ')}
      style={{
        width: `${dragState.tabWidth}px`,
        height: `${dragState.tabHeight}px`,
        left: 0,
        top: `${dragState.tabTop}px`,
      }}
      aria-hidden="true"
    >
      <span class="session-tab-shell" aria-hidden="true" />
      <div class="session-tab-main">
        {isPinned ? (
          <span
            class="session-tab-avatar"
            style={{ background: getTabAvatarColor(draggedPath) }}
            aria-hidden="true"
          >
            {getTabAvatarLabel(floatingLabel)}
          </span>
        ) : (
          <>
            {floatingRunning && <span class="session-tab-running" aria-hidden="true" />}
            <span class="session-tab-label">{floatingLabel}</span>
          </>
        )}
      </div>
      {!isPinned && <div class="session-tab-close" aria-hidden="true">×</div>}
    </div>
  );
}
