/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useLayoutEffect, useRef } from 'preact/hooks';

import {
  createTranscriptScrollbarDragSnapshot,
  deriveTranscriptScrollbarGeometry,
  resolveTranscriptScrollbarDrag,
  type TranscriptScrollbarDragSnapshot,
  type TranscriptScrollbarGeometry,
} from './transcript-scrollbar-model';
import {
  dispatchTranscriptScrollbarInteractionEnd,
  dispatchTranscriptScrollbarInteractionStart,
} from './transcript-scrollbar-events';

interface TranscriptScrollbarProps {
  scrollRef: { current: HTMLDivElement | null };
  /** Reactive signal that the virtual spacer changed without a scroll event. */
  totalSize: number;
  hidden?: boolean;
}

interface ActiveDrag {
  pointerId: number;
  snapshot: TranscriptScrollbarDragSnapshot;
}

function setThumbGeometry(
  thumb: HTMLDivElement,
  thumbSize: number,
  thumbOffset: number,
): void {
  thumb.style.height = `${thumbSize}px`;
  thumb.style.transform = `translateY(${thumbOffset}px)`;
}

function readGeometry(
  scrollElement: HTMLDivElement,
): TranscriptScrollbarGeometry {
  return deriveTranscriptScrollbarGeometry({
    scrollTop: scrollElement.scrollTop,
    scrollHeight: scrollElement.scrollHeight,
    clientHeight: scrollElement.clientHeight,
    // The track is initially hidden to prevent first-paint flash, so measuring
    // its own clientHeight would create a hidden/zero-height deadlock. It spans
    // the same viewport as the scroll element by CSS contract.
    trackSize: scrollElement.clientHeight,
  });
}

function applyIdleGeometry(
  track: HTMLDivElement,
  thumb: HTMLDivElement,
  geometry: TranscriptScrollbarGeometry,
  scrollTop: number,
  suppressed: boolean,
): void {
  track.hidden = suppressed || !geometry.hasOverflow;
  track.tabIndex = !suppressed && geometry.hasOverflow ? 0 : -1;
  track.setAttribute('aria-valuemax', `${Math.round(geometry.maxScroll)}`);
  track.setAttribute('aria-valuenow', `${Math.round(Math.min(geometry.maxScroll, Math.max(0, scrollTop)))}`);
  setThumbGeometry(thumb, geometry.thumbSize, geometry.thumbOffset);
}

function wheelDeltaPixels(event: WheelEvent, viewportHeight: number): number {
  const rawDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return rawDelta * 16;
  if (event.deltaMode === 2) return rawDelta * viewportHeight;
  return rawDelta;
}

/**
 * A deterministic overlay scrollbar for the virtual transcript. Native
 * scrollbar drag mapping is recalculated whenever scrollHeight changes, which
 * lets a streaming/remeasured transcript move the thumb away from the mouse.
 * This control snapshots that mapping at pointerdown and reconciles to live
 * geometry only after pointerup.
 */
export function TranscriptScrollbar({ scrollRef, totalSize, hidden = false }: TranscriptScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const syncGeometryRef = useRef<() => void>(() => undefined);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scrollElement || !track || !thumb) return;

    const syncGeometry = () => {
      // Keep both the visual size and the pointer-to-scroll denominator frozen
      // while dragging. Scroll/ResizeObserver updates are reconciled at release.
      if (activeDragRef.current) return;
      const geometry = readGeometry(scrollElement);
      applyIdleGeometry(track, thumb, geometry, scrollElement.scrollTop, hiddenRef.current);
    };
    syncGeometryRef.current = syncGeometry;

    const beginInteraction = () => {
      dispatchTranscriptScrollbarInteractionStart(scrollElement);
    };
    const endInteraction = () => {
      dispatchTranscriptScrollbarInteractionEnd(scrollElement);
    };

    const finishDrag = (event?: PointerEvent) => {
      const activeDrag = activeDragRef.current;
      if (!activeDrag) return;
      if (event && event.pointerId !== activeDrag.pointerId) return;

      activeDragRef.current = null;
      track.classList.remove('is-dragging');
      if (typeof track.hasPointerCapture === 'function'
        && track.hasPointerCapture(activeDrag.pointerId)) {
        track.releasePointerCapture(activeDrag.pointerId);
      }
      endInteraction();
      // Content position remains user-owned. Only the thumb is rebased to the
      // now-current scroll range, avoiding a second transcript jump on release.
      syncGeometry();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (activeDragRef.current) return;
      const geometry = readGeometry(scrollElement);
      if (!geometry.hasOverflow) return;

      event.preventDefault();
      event.stopPropagation();
      track.focus({ preventScroll: true });

      const trackRect = track.getBoundingClientRect();
      const localPointer = event.clientY - trackRect.top;
      const pressedThumb = event.target === thumb || thumb.contains(event.target as Node);
      const initialThumbOffset = pressedThumb
        ? geometry.thumbOffset
        : Math.min(
            geometry.maxThumbOffset,
            Math.max(0, localPointer - geometry.thumbSize / 2),
          );
      const snapshot = createTranscriptScrollbarDragSnapshot(
        geometry,
        event.clientY,
        initialThumbOffset,
      );

      activeDragRef.current = { pointerId: event.pointerId, snapshot };
      track.classList.add('is-dragging');
      track.setPointerCapture?.(event.pointerId);
      beginInteraction();

      const initialPosition = resolveTranscriptScrollbarDrag(snapshot, event.clientY);
      setThumbGeometry(thumb, snapshot.thumbSize, initialPosition.thumbOffset);
      scrollElement.scrollTop = initialPosition.scrollTop;
    };

    const onPointerMove = (event: PointerEvent) => {
      const activeDrag = activeDragRef.current;
      if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;

      event.preventDefault();
      const position = resolveTranscriptScrollbarDrag(activeDrag.snapshot, event.clientY);
      // Write the thumb directly so a heavy transcript render cannot add a
      // framework commit between the pointer and the visible pill.
      setThumbGeometry(thumb, activeDrag.snapshot.thumbSize, position.thumbOffset);
      scrollElement.scrollTop = position.scrollTop;
    };
    const onWindowBlur = () => finishDrag();

    const onWheel = (event: WheelEvent) => {
      const delta = wheelDeltaPixels(event, scrollElement.clientHeight);
      if (delta === 0) return;
      event.preventDefault();
      beginInteraction();
      scrollElement.scrollTop += delta;
      endInteraction();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      let nextScrollTop: number | null = null;
      const page = Math.max(40, scrollElement.clientHeight * 0.9);
      switch (event.key) {
        case 'ArrowUp': nextScrollTop = scrollElement.scrollTop - 40; break;
        case 'ArrowDown': nextScrollTop = scrollElement.scrollTop + 40; break;
        case 'PageUp': nextScrollTop = scrollElement.scrollTop - page; break;
        case 'PageDown': nextScrollTop = scrollElement.scrollTop + page; break;
        case 'Home': nextScrollTop = 0; break;
        case 'End': nextScrollTop = scrollElement.scrollHeight; break;
        case ' ': nextScrollTop = scrollElement.scrollTop + (event.shiftKey ? -page : page); break;
        default: return;
      }

      event.preventDefault();
      event.stopPropagation();
      beginInteraction();
      scrollElement.scrollTop = nextScrollTop;
      endInteraction();
    };

    scrollElement.addEventListener('scroll', syncGeometry, { passive: true });
    track.addEventListener('pointerdown', onPointerDown);
    track.addEventListener('wheel', onWheel, { passive: false });
    track.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', finishDrag, { passive: true });
    window.addEventListener('pointercancel', finishDrag, { passive: true });
    window.addEventListener('blur', onWindowBlur);
    track.addEventListener('lostpointercapture', finishDrag);
    const resizeObserver = new ResizeObserver(syncGeometry);
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(track);
    syncGeometry();

    return () => {
      const dragWasActive = activeDragRef.current !== null;
      activeDragRef.current = null;
      if (dragWasActive) endInteraction();
      scrollElement.removeEventListener('scroll', syncGeometry);
      track.removeEventListener('pointerdown', onPointerDown);
      track.removeEventListener('wheel', onWheel);
      track.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('blur', onWindowBlur);
      track.removeEventListener('lostpointercapture', finishDrag);
      resizeObserver.disconnect();
      syncGeometryRef.current = () => undefined;
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    // The virtual spacer can change without a browser scroll/resize event.
    // During a drag this intentionally no-ops; pointerup performs reconciliation.
    syncGeometryRef.current();
  }, [hidden, totalSize]);

  return (
    <div
      ref={trackRef}
      class="transcript-scrollbar"
      role="scrollbar"
      aria-label="Transcript scroll position"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-valuenow={0}
      tabIndex={-1}
      hidden
    >
      <div ref={thumbRef} class="transcript-scrollbar-thumb" />
    </div>
  );
}
