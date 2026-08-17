/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Fragment, type ComponentChildren, type RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatMessage } from '../../../shared/protocol';

/**
 * Bounded virtualized rendering of a nested message list (subagent detail
 * transcripts). Only the viewport rows plus a small overscan are mounted;
 * top/bottom spacers sized from content estimates keep the scroll metrics
 * stable. Rows are keyed by their stable semantic identity
 * (`messageRenderIdentity`), so streaming appends and rebases never remount
 * unrelated rows.
 *
 * The estimate only sizes the spacers — rows flow normally, so an imperfect
 * estimate shifts content but can never overlap rows.
 */

export const NESTED_VIRTUALIZE_MIN_MESSAGES = 24;
export const NESTED_VIRTUALIZE_OVERSCAN = 4;

export function estimateNestedMessageHeight(message: ChatMessage): number {
  const base = 44;
  const chars = (message.markdown?.length ?? 0) + (message.thinking?.length ?? 0);
  const textLines = Math.min(24, Math.ceil(chars / 96));
  const toolRows = (message.toolCalls?.length ?? 0) * 26;
  const imageRows = (message.userParts?.length ?? 0) > 0 ? 48 : 0;
  return base + textLines * 18 + toolRows + imageRows;
}

export interface NestedRowRange {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  /** Cumulative start offsets; `offsets[i]` is the top of row `i`. */
  offsets: readonly number[];
}

/** Pure viewport→range mapping. A non-positive viewport height renders the
 *  full list (nothing measured yet). */
export function computeNestedRowRange(input: {
  estimates: readonly number[];
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): NestedRowRange {
  const { estimates, scrollTop, viewportHeight, overscan = NESTED_VIRTUALIZE_OVERSCAN } = input;
  const count = estimates.length;
  const offsets = new Array<number>(count + 1);
  let total = 0;
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) {
    total += Math.max(0, estimates[index] ?? 0);
    offsets[index + 1] = total;
  }
  if (count === 0) return { startIndex: 0, endIndex: -1, totalHeight: 0, offsets };
  if (viewportHeight <= 0 || !Number.isFinite(scrollTop)) {
    return { startIndex: 0, endIndex: count - 1, totalHeight: total, offsets };
  }
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  // First row whose start offset is <= top: binary search on offsets.
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= top) low = mid;
    else high = mid - 1;
  }
  const firstVisible = low;
  // First row whose start offset is >= bottom (exclusive end).
  low = 0;
  high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] ?? 0) >= bottom) high = mid;
    else low = mid + 1;
  }
  const afterVisible = low;
  return {
    startIndex: Math.max(0, firstVisible - overscan),
    endIndex: Math.min(count - 1, afterVisible - 1 + overscan),
    totalHeight: total,
    offsets,
  };
}

export interface NestedVirtualListProps<T> {
  rows: readonly T[];
  getKey: (row: T, index: number) => string;
  estimateHeight: (row: T, index: number) => number;
  scrollRef: RefObject<HTMLElement | null>;
  overscan?: number;
  renderRow: (row: T, index: number) => ComponentChildren;
}

export function NestedVirtualList<T>({
  rows,
  getKey,
  estimateHeight,
  scrollRef,
  overscan = NESTED_VIRTUALIZE_OVERSCAN,
  renderRow,
}: NestedVirtualListProps<T>) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const frameRef = useRef<number | null>(null);

  const estimates = useMemo(
    () => rows.map((row, index) => Math.max(0, estimateHeight(row, index))),
    [rows, estimateHeight],
  );
  const range = useMemo(
    () => computeNestedRowRange({
      estimates,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.height,
      overscan,
    }),
    [estimates, viewport.scrollTop, viewport.height, overscan],
  );

  const scheduleScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const element = scrollRef.current;
      if (!element) return;
      setViewport((previous) => previous.scrollTop === element.scrollTop
        ? previous
        : { ...previous, scrollTop: element.scrollTop });
    });
  }, [scrollRef]);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewport((previous) => (previous.height === element.clientHeight && previous.scrollTop === element.scrollTop)
      ? previous
      : { scrollTop: element.scrollTop, height: element.clientHeight });
  }, [scrollRef]);

  useLayoutEffect(() => {
    measure();
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener('scroll', scheduleScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', scheduleScroll);
      observer?.disconnect();
    };
  }, [scrollRef, measure, scheduleScroll]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // Nothing measured yet (or no real layout): render every row. This also
  // keeps small/static environments (tests, first paint) deterministic.
  if (viewport.height <= 0) {
    return (
      <>
        {rows.map((row, index) => (
          <Fragment key={getKey(row, index)}>{renderRow(row, index)}</Fragment>
        ))}
      </>
    );
  }

  const { startIndex, endIndex, totalHeight, offsets } = range;
  if (startIndex > endIndex) {
    return <div class="nested-virtual-list" style={{ height: `${totalHeight}px` }} aria-hidden="true" />;
  }
  const visibleRows = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    visibleRows.push(<Fragment key={getKey(row, index)}>{renderRow(row, index)}</Fragment>);
  }
  return (
    <div class="nested-virtual-list">
      <div style={{ height: `${offsets[startIndex] ?? 0}px` }} aria-hidden="true" />
      {visibleRows}
      <div style={{ height: `${(totalHeight - (offsets[endIndex + 1] ?? totalHeight))}px` }} aria-hidden="true" />
    </div>
  );
}
