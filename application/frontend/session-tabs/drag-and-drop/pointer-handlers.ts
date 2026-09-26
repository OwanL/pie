import { TAB_DRAG_THRESHOLD_PX } from './constants';

import type { TabDragCandidate, SessionTabDragState } from '../types';

export function runPointerDown(
  event: PointerEvent,
  sourceIndex: number,
  sourcePath: string,
  openTabPaths: string[],
  sourceIsGroupChip: boolean,
  sourceFromDropdown: boolean,
  dragCandidateRef: { current: TabDragCandidate | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  beginTracking: () => void,
): void {
  if (openTabPaths.length <= 1 || dragCandidateRef.current || event.button !== 0 || !event.isPrimary) {
    return;
  }

  const currentTarget = event.currentTarget as HTMLElement | null;
  const tabElement = currentTarget?.closest('.session-tab, .pinned-tab-group') as HTMLElement | null;
  const rect = tabElement?.getBoundingClientRect() ?? currentTarget?.getBoundingClientRect();
  if (!rect) {
    return;
  }

  dragCandidateRef.current = {
    pointerId: event.pointerId,
    sourceIndex,
    sourcePath,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - rect.left,
    tabWidth: rect.width,
    tabHeight: rect.height,
    tabTop: rect.top,
    sourceIsGroupChip,
    sourceFromDropdown,
  };
  pointerPositionRef.current = { x: event.clientX, y: event.clientY };
  beginTracking();
  currentTarget?.setPointerCapture?.(event.pointerId);
}

export function runPointerMove(
  event: PointerEvent,
  dragCandidateRef: { current: TabDragCandidate | null },
  dragStateRef: { current: SessionTabDragState | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  setDragState: (state: SessionTabDragState | null) => void,
  syncDragFromPointer: (clientX: number, clientY: number) => void,
  ensureAutoScrollLoop: () => void,
  syncGhostPosition: (clientX: number) => void,
): void {
  const candidate = dragCandidateRef.current;
  if (!candidate || event.pointerId !== candidate.pointerId) {
    return;
  }

  pointerPositionRef.current = { x: event.clientX, y: event.clientY };
  // Drive the floating ghost transform imperatively (compositor-friendly,
  // no React state). No-op until the ghost mounts at drag start; subsequent
  // moves hit the live element. The initial transform is also seeded via a
  // useLayoutEffect keyed on dragState so the ghost never paints at left:0.
  syncGhostPosition(event.clientX);

  if (!dragStateRef.current) {
    const deltaX = event.clientX - candidate.startX;
    const deltaY = event.clientY - candidate.startY;
    if (Math.hypot(deltaX, deltaY) < TAB_DRAG_THRESHOLD_PX) {
      return;
    }

    const nextState: SessionTabDragState = {
      pointerId: candidate.pointerId,
      sourceIndex: candidate.sourceIndex,
      sourcePath: candidate.sourcePath,
      offsetX: candidate.offsetX,
      tabWidth: candidate.tabWidth,
      tabHeight: candidate.tabHeight,
      tabTop: candidate.tabTop,
      // No drop target yet — the first pointermove (which always follows,
      // since the threshold was just crossed) recomputes it in the correct
      // zone-specific space. Commit always re-syncs before reading it.
      dropIndex: null,
      dropOnPath: null,
      dropOnIsGroup: false,
      sourceIsGroupChip: candidate.sourceIsGroupChip,
      sourceFromDropdown: candidate.sourceFromDropdown,
    };
    dragStateRef.current = nextState;
    setDragState(nextState);
    document.body.classList.add('session-tab-dragging');
    ensureAutoScrollLoop();
    event.preventDefault();
    return;
  }

  syncDragFromPointer(event.clientX, event.clientY);
  // Re-arm the auto-scroll loop in case the pointer has (re)entered an edge
  // zone; the tick stops itself when nothing is scrolling, so this is cheap
  // and avoids a continuous rAF for the whole drag.
  ensureAutoScrollLoop();
  event.preventDefault();
}

export function runPointerUp(
  event: PointerEvent,
  dragCandidateRef: { current: TabDragCandidate | null },
  dragStateRef: { current: SessionTabDragState | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  syncDragFromPointer: (clientX: number, clientY: number) => void,
  commitDrag: () => void,
  endTracking: () => void,
): void {
  const candidate = dragCandidateRef.current;
  if (!candidate || event.pointerId !== candidate.pointerId) {
    return;
  }

  if (dragStateRef.current) {
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    syncDragFromPointer(event.clientX, event.clientY);
    commitDrag();
    return;
  }

  dragCandidateRef.current = null;
  pointerPositionRef.current = null;
  endTracking();
}

export function runPointerCancel(
  dragCandidateRef: { current: TabDragCandidate | null },
  resetDrag: (suppressClick: boolean) => void,
): void {
  if (!dragCandidateRef.current) {
    return;
  }
  resetDrag(false);
}

export function runWindowBlur(
  dragCandidateRef: { current: TabDragCandidate | null },
  resetDrag: (suppressClick: boolean) => void,
): void {
  if (!dragCandidateRef.current) {
    return;
  }
  resetDrag(false);
}

export function runOnClick(
  tabPath: string,
  suppressNextClickRef: { current: boolean },
  onSelect: (tabPath: string) => void,
): void {
  if (suppressNextClickRef.current) {
    return;
  }
  onSelect(tabPath);
}
