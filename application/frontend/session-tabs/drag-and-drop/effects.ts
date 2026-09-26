import { useEffect, useLayoutEffect } from 'preact/hooks';

import type { SessionTabDragState } from '../types';

export function useDragEffects({
  dragState,
  dragStateRef,
  pointerPositionRef,
  openTabPaths,
  suppressClickTimerRef,
  endTracking,
  resetDrag,
  syncDragFromPointer,
  syncGhostPosition,
}: {
  dragState: SessionTabDragState | null;
  dragStateRef: { current: SessionTabDragState | null };
  pointerPositionRef: { current: { x: number; y: number } | null };
  openTabPaths: string[];
  suppressClickTimerRef: { current: number | null };
  endTracking: () => void;
  resetDrag: (suppressClick: boolean) => void;
  syncDragFromPointer: (clientX: number, clientY: number) => void;
  syncGhostPosition: (clientX: number) => void;
}) {
  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      endTracking();
    };
  }, [endTracking, suppressClickTimerRef]);

  useEffect(() => {
    if (!dragStateRef.current || !pointerPositionRef.current) {
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [dragState?.pointerId, syncDragFromPointer, dragStateRef, pointerPositionRef]);

  useEffect(() => {
    const current = dragStateRef.current;
    if (!current || !pointerPositionRef.current) {
      return;
    }

    // Reset if the source tab is no longer present (closed/replaced mid-drag),
    // whether by index-out-of-range or by path no longer being in the list.
    if (
      current.sourceIndex >= openTabPaths.length ||
      openTabPaths.indexOf(current.sourcePath) === -1
    ) {
      resetDrag(false);
      return;
    }

    syncDragFromPointer(pointerPositionRef.current.x, pointerPositionRef.current.y);
  }, [openTabPaths, resetDrag, syncDragFromPointer, dragStateRef, pointerPositionRef]);

  // Seed the floating ghost's initial transform once it mounts at drag start.
  // Per-move updates are written imperatively from runPointerMove (no React
  // state); this only bridges the gap between dragState creation (ghost not
  // yet mounted) and the first pointermove, so the ghost never paints at
  // left:0. Runs after commit, so ghostElementRef is already attached.
  useLayoutEffect(() => {
    if (!dragStateRef.current) {
      return;
    }
    const pointer = pointerPositionRef.current;
    if (pointer) {
      syncGhostPosition(pointer.x);
    }
  }, [dragState?.pointerId, syncGhostPosition, dragStateRef, pointerPositionRef]);
}
