/**
 * Hook for drag-and-drop tab reordering with edge scrolling,
 * context menu support, and click suppression.
 */

import { useState, useRef, useCallback } from 'preact/hooks';

import type {
  TabDragCandidate,
  SessionTabDragState,
  UseTabDragAndDropOptions,
  UseTabDragAndDropResult,
} from './types';

import {
  runAutoScrollTick,
  runStopAutoScrollLoop,
  runEnsureAutoScrollLoop,
} from './drag-and-drop/auto-scroll';
import {
  runPointerDown,
  runPointerMove,
  runPointerUp,
  runPointerCancel,
  runWindowBlur,
  runOnClick,
} from './drag-and-drop/pointer-handlers';
import {
  runSyncDragFromPointer,
  runResetDrag,
  runCommitDrag,
} from './drag-and-drop/drag-state';
import { useDragEffects } from './drag-and-drop/effects';
import { useTabContextMenu } from './drag-and-drop/context-menu';

export function useTabDragAndDrop({
  openTabPaths,
  pinnedTabPaths,
  pinnedTabGroups,
  onMove,
  onMovePinnedItem,
  onSelect,
  onClose,
  onDuplicate,
  onTogglePin,
  onGroupPinnedTab,
  onMergePinnedGroups,
  onUngroupPinnedTab,
  onRunAction,
  stripRef,
}: UseTabDragAndDropOptions): UseTabDragAndDropResult {
  const openTabPathsRef = useRef(openTabPaths);
  const pinnedTabPathsRef = useRef(pinnedTabPaths);
  const pinnedTabGroupsRef = useRef(pinnedTabGroups);
  const dragCandidateRef = useRef<TabDragCandidate | null>(null);
  const dragStateRef = useRef<SessionTabDragState | null>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const ghostElementRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const pointerMoveHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const pointerUpHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const pointerCancelHandlerRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const windowBlurHandlerRef = useRef<() => void>(() => undefined);
  const autoScrollTickRef = useRef<() => void>(() => undefined);
  const [dragState, setDragState] = useState<SessionTabDragState | null>(null);

  openTabPathsRef.current = openTabPaths;
  pinnedTabPathsRef.current = pinnedTabPaths;
  pinnedTabGroupsRef.current = pinnedTabGroups;

  const pointerMoveListener = useCallback((event: PointerEvent) => {
    pointerMoveHandlerRef.current(event);
  }, []);
  const pointerUpListener = useCallback((event: PointerEvent) => {
    pointerUpHandlerRef.current(event);
  }, []);
  const pointerCancelListener = useCallback((event: PointerEvent) => {
    pointerCancelHandlerRef.current(event);
  }, []);
  const windowBlurListener = useCallback(() => {
    windowBlurHandlerRef.current();
  }, []);
  const autoScrollRunner = useCallback(() => {
    autoScrollTickRef.current();
  }, []);

  const stopAutoScrollLoop = useCallback(() => {
    runStopAutoScrollLoop(autoScrollFrameRef);
  }, []);

  const beginTracking = useCallback(() => {
    window.addEventListener('pointermove', pointerMoveListener);
    window.addEventListener('pointerup', pointerUpListener);
    window.addEventListener('pointercancel', pointerCancelListener);
    window.addEventListener('blur', windowBlurListener);
  }, [pointerMoveListener, pointerUpListener, pointerCancelListener, windowBlurListener]);

  const endTracking = useCallback(() => {
    window.removeEventListener('pointermove', pointerMoveListener);
    window.removeEventListener('pointerup', pointerUpListener);
    window.removeEventListener('pointercancel', pointerCancelListener);
    window.removeEventListener('blur', windowBlurListener);
    stopAutoScrollLoop();
    document.body.classList.remove('session-tab-dragging');
  }, [pointerMoveListener, pointerUpListener, pointerCancelListener, windowBlurListener, stopAutoScrollLoop]);

  const syncDragFromPointer = useCallback((clientX: number, clientY: number) => {
    runSyncDragFromPointer(clientX, clientY, dragStateRef, stripRef, setDragState, pinnedTabPathsRef, pinnedTabGroupsRef);
  }, []);

  // Drive the floating ghost's transform imperatively from the pointermove
  // path so React state (and the parent re-render) stays untouched between
  // dropIndex changes. Reads live refs only, so it needs no deps.
  const syncGhostPosition = useCallback((clientX: number) => {
    const ghost = ghostElementRef.current;
    const current = dragStateRef.current;
    if (!ghost || !current) {
      return;
    }
    ghost.style.transform = `translate3d(${clientX - current.offsetX}px, 0, 0)`;
  }, []);

  const ensureAutoScrollLoop = useCallback(() => {
    runEnsureAutoScrollLoop(autoScrollFrameRef, autoScrollRunner);
  }, [autoScrollRunner]);

  const resetDrag = useCallback((suppressClick: boolean) => {
    runResetDrag(suppressClick, suppressNextClickRef, suppressClickTimerRef, dragCandidateRef, dragStateRef, pointerPositionRef, setDragState, endTracking);
  }, [endTracking]);

  const commitDrag = useCallback(() => {
    runCommitDrag(dragStateRef, openTabPathsRef, pinnedTabPathsRef, pinnedTabGroupsRef, {
      onMove,
      onMovePinnedItem,
      onGroupPinnedTab,
      onMergePinnedGroups,
      onUngroupPinnedTab,
      onSelect,
    }, resetDrag);
  }, [onMove, onMovePinnedItem, onGroupPinnedTab, onMergePinnedGroups, onUngroupPinnedTab, onSelect, resetDrag]);

  autoScrollTickRef.current = () => {
    runAutoScrollTick(
      dragStateRef,
      pointerPositionRef,
      stripRef,
      autoScrollFrameRef,
      autoScrollRunner,
      syncDragFromPointer,
    );
  };

  pointerMoveHandlerRef.current = (event: PointerEvent) => {
    runPointerMove(
      event,
      dragCandidateRef,
      dragStateRef,
      pointerPositionRef,
      setDragState,
      syncDragFromPointer,
      ensureAutoScrollLoop,
      syncGhostPosition,
    );
  };

  pointerUpHandlerRef.current = (event: PointerEvent) => {
    runPointerUp(
      event,
      dragCandidateRef,
      dragStateRef,
      pointerPositionRef,
      syncDragFromPointer,
      commitDrag,
      endTracking,
    );
  };

  pointerCancelHandlerRef.current = () => {
    runPointerCancel(dragCandidateRef, resetDrag);
  };

  windowBlurHandlerRef.current = () => {
    runWindowBlur(dragCandidateRef, resetDrag);
  };

  useDragEffects({
    dragState,
    dragStateRef,
    pointerPositionRef,
    openTabPaths,
    suppressClickTimerRef,
    endTracking,
    resetDrag,
    syncDragFromPointer,
    syncGhostPosition,
  });

  const { tabContextMenu, setTabContextMenu, onContextMenu, onContextAction } = useTabContextMenu({
    onDuplicate,
    onClose,
    onTogglePin,
    onRunAction,
  });

  const onPointerDown = useCallback((event: PointerEvent, sourceIndex: number, sourcePath: string) => {
    runPointerDown(event, sourceIndex, sourcePath, openTabPaths, false, false, dragCandidateRef, pointerPositionRef, beginTracking);
  }, [beginTracking, openTabPaths.length]);

  /** Pointer-down on a pinned group chip or a dropdown member. The source is
   *  identified by any member path; `sourceIsGroupChip` marks a whole-group
   *  drag (merge/reorder-block) and `sourceFromDropdown` marks a dropdown
   *  member drag (ungroup on gap-drop). `itemIndex` seeds the initial drop
   *  gap (overwritten on the first pointermove). */
  const onPinnedItemPointerDown = useCallback((
    event: PointerEvent,
    sourcePath: string,
    sourceIsGroupChip: boolean,
    sourceFromDropdown: boolean,
    itemIndex: number,
  ) => {
    runPointerDown(event, itemIndex, sourcePath, openTabPaths, sourceIsGroupChip, sourceFromDropdown, dragCandidateRef, pointerPositionRef, beginTracking);
  }, [beginTracking, openTabPaths.length]);

  const onClick = useCallback((tabPath: string) => {
    runOnClick(tabPath, suppressNextClickRef, onSelect);
  }, [onSelect]);

  return {
    dragState,
    tabContextMenu,
    setTabContextMenu,
    onPointerDown,
    onPinnedItemPointerDown,
    onClick,
    onContextMenu,
    onContextAction,
    autoScrollTickRef,
    dragCandidateRef,
    dragStateRef,
    ghostElementRef,
  };
}
