export const TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX = 24;

export interface TranscriptScrollbarMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  trackSize: number;
  minThumbSize?: number;
}

export interface TranscriptScrollbarGeometry {
  hasOverflow: boolean;
  maxScroll: number;
  thumbSize: number;
  maxThumbOffset: number;
  thumbOffset: number;
}

export interface TranscriptScrollbarDragSnapshot {
  pointerStart: number;
  thumbOffsetStart: number;
  thumbSize: number;
  maxThumbOffset: number;
  maxScroll: number;
}

export interface TranscriptScrollbarDragPosition {
  thumbOffset: number;
  scrollTop: number;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve the visual scrollbar geometry from one coherent set of layout
 * metrics. The result is also the immutable mapping captured for a drag.
 */
export function deriveTranscriptScrollbarGeometry({
  scrollTop,
  scrollHeight,
  clientHeight,
  trackSize,
  minThumbSize = TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX,
}: TranscriptScrollbarMetrics): TranscriptScrollbarGeometry {
  const viewport = Math.max(0, finiteOrZero(clientHeight));
  const content = Math.max(viewport, finiteOrZero(scrollHeight));
  const track = Math.max(0, finiteOrZero(trackSize));
  const maxScroll = Math.max(0, content - viewport);
  const hasOverflow = maxScroll > 0 && track > 0;

  if (!hasOverflow) {
    return {
      hasOverflow: false,
      maxScroll,
      thumbSize: track,
      maxThumbOffset: 0,
      thumbOffset: 0,
    };
  }

  const boundedMinimum = clamp(finiteOrZero(minThumbSize), 0, track);
  const proportionalSize = content > 0 ? track * (viewport / content) : track;
  const thumbSize = clamp(proportionalSize, boundedMinimum, track);
  const maxThumbOffset = Math.max(0, track - thumbSize);
  const boundedScrollTop = clamp(finiteOrZero(scrollTop), 0, maxScroll);
  const thumbOffset = maxScroll > 0
    ? (boundedScrollTop / maxScroll) * maxThumbOffset
    : 0;

  return {
    hasOverflow: true,
    maxScroll,
    thumbSize,
    maxThumbOffset,
    thumbOffset,
  };
}

export function createTranscriptScrollbarDragSnapshot(
  geometry: TranscriptScrollbarGeometry,
  pointerStart: number,
  thumbOffsetStart = geometry.thumbOffset,
): TranscriptScrollbarDragSnapshot {
  return {
    pointerStart: finiteOrZero(pointerStart),
    thumbOffsetStart: clamp(
      finiteOrZero(thumbOffsetStart),
      0,
      geometry.maxThumbOffset,
    ),
    thumbSize: geometry.thumbSize,
    maxThumbOffset: geometry.maxThumbOffset,
    maxScroll: geometry.maxScroll,
  };
}

/**
 * Map pointer movement through the frozen geometry captured at pointerdown.
 * Live content-height changes therefore cannot make the thumb drift away from
 * the pointer midway through a drag.
 */
export function resolveTranscriptScrollbarDrag(
  snapshot: TranscriptScrollbarDragSnapshot,
  pointerPosition: number,
): TranscriptScrollbarDragPosition {
  const pointerDelta = finiteOrZero(pointerPosition) - snapshot.pointerStart;
  const thumbOffset = clamp(
    snapshot.thumbOffsetStart + pointerDelta,
    0,
    snapshot.maxThumbOffset,
  );
  const scrollTop = snapshot.maxThumbOffset > 0
    ? (thumbOffset / snapshot.maxThumbOffset) * snapshot.maxScroll
    : 0;

  return { thumbOffset, scrollTop };
}
