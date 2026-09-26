import {
  TAB_DRAG_EDGE_SCROLL_PX,
  TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX,
  TAB_DRAG_VERTICAL_SLOP_PX,
} from './constants';

import type { SessionTabDragState } from '../types';

export function runAutoScrollTick(
  dragStateRef: { current: SessionTabDragState | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  stripRef: { current: HTMLElement | null },
  autoScrollFrameRef: { current: number | null },
  autoScrollRunner: () => void,
  syncDragFromPointer: (clientX: number, clientY: number) => void,
): void {
  const drag = dragStateRef.current;
  const pointer = pointerPositionRef.current;
  const strip = stripRef.current;
  if (!drag || !pointer || !strip) {
    autoScrollFrameRef.current = null;
    return;
  }

  const stripRect = strip.getBoundingClientRect();
  const withinVerticalBounds =
    pointer.y >= stripRect.top - TAB_DRAG_VERTICAL_SLOP_PX &&
    pointer.y <= stripRect.bottom + TAB_DRAG_VERTICAL_SLOP_PX;

  let nextDelta = 0;
  if (withinVerticalBounds && strip.scrollWidth > strip.clientWidth) {
    if (pointer.x < stripRect.left + TAB_DRAG_EDGE_SCROLL_PX) {
      const distance = Math.max(pointer.x - stripRect.left, 0);
      const ratio = 1 - (distance / TAB_DRAG_EDGE_SCROLL_PX);
      nextDelta = -Math.ceil(ratio * TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX);
    } else if (pointer.x > stripRect.right - TAB_DRAG_EDGE_SCROLL_PX) {
      const distance = Math.max(stripRect.right - pointer.x, 0);
      const ratio = 1 - (distance / TAB_DRAG_EDGE_SCROLL_PX);
      nextDelta = Math.ceil(ratio * TAB_DRAG_EDGE_SCROLL_MAX_STEP_PX);
    }
  }

  if (nextDelta !== 0) {
    const previousScrollLeft = strip.scrollLeft;
    strip.scrollLeft += nextDelta;
    if (strip.scrollLeft !== previousScrollLeft) {
      syncDragFromPointer(pointer.x, pointer.y);
      autoScrollFrameRef.current = window.requestAnimationFrame(autoScrollRunner);
    } else {
      // At the scroll limit (or no overflow): stop until the pointer moves
      // again and runPointerMove re-arms the loop.
      autoScrollFrameRef.current = null;
    }
  } else {
    // Pointer not in an edge zone: stop the loop. runPointerMove re-arms it
    // when the pointer re-enters an edge zone.
    autoScrollFrameRef.current = null;
  }
}

export function runStopAutoScrollLoop(
  autoScrollFrameRef: { current: number | null },
): void {
  if (autoScrollFrameRef.current !== null) {
    window.cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }
}

export function runEnsureAutoScrollLoop(
  autoScrollFrameRef: { current: number | null },
  autoScrollRunner: () => void,
): void {
  if (autoScrollFrameRef.current === null) {
    autoScrollFrameRef.current = window.requestAnimationFrame(autoScrollRunner);
  }
}
