/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useCallback, useLayoutEffect, useState } from 'preact/hooks';

import { cx } from './cx';
import { ResizeHandle } from './resize-handle';
import { useResizableHeight } from './use-resizable-height';

interface ResizablePreProps {
  /** Site-specific classes for the `<pre>` (font, padding, white-space, bg). */
  class?: string;
  minHeight?: number;
  maxHeight?: number;
  onScroll?: () => void;
  onResizeStart?: () => void;
  /** Quiet touch-only cue, shown only while this pre actually overflows. */
  scrollHint?: string;
  scrollLabel?: string;
  children: ComponentChildren;
}

/**
 * A `<pre>` scroll region bracketed by top + bottom resize handles, for
 * non-streaming expanded code (tool-call results, pruning raw output). The
 * `<pre>` carries the site classes; height is ephemeral webview-local state
 * until the user drags a handle, after which it overrides the CSS default.
 *
 * Streaming panes (shell terminal, subagent thread) call `useResizableHeight`
 * directly so they can keep their own stick-to-bottom logic + ref.
 */
export function ResizablePre({ class: className, minHeight, maxHeight, onScroll, onResizeStart, scrollHint, scrollLabel = 'Tool output', children }: ResizablePreProps) {
  const {
    scrollRef,
    height,
    minHeight: minH,
    maxHeight: maxH,
    canResize,
    startResize,
    resizeBy,
    reset,
  } = useResizableHeight<HTMLPreElement>({ minHeight, maxHeight, onResizeStart });
  const [overflows, setOverflows] = useState(false);
  // Conditional edge fades (Tabs-4 pattern, classes styled in tool-call.css):
  // while clipped columns sit towards an edge, fade it as a visible scroll
  // affordance; fades clear once that direction is scrolled to the end.
  const [fades, setFades] = useState({ left: false, right: false });
  const measureHint = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = Boolean(el && (
      el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1
    ));
    setOverflows((previous) => previous === next ? previous : next);
    const nextLeft = el.scrollLeft > 1;
    const nextRight = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    setFades((previous) => previous.left === nextLeft && previous.right === nextRight ? previous : { left: nextLeft, right: nextRight });
  }, [scrollRef]);
  // Content and user height/reset changes can change scroll dimensions without
  // changing the observed box. Measure after render as well as on box resize.
  useLayoutEffect(() => { measureHint(); });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureHint) : undefined;
    observer?.observe(el);
    if (typeof window !== 'undefined') window.addEventListener('resize', measureHint);
    // Horizontal scroll position only changes which edge (if any) is clipped;
    // keep the fades faithful while the user scrolls.
    el.addEventListener('scroll', measureHint, { passive: true });
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', measureHint);
      el.removeEventListener('scroll', measureHint);
    };
  }, [scrollHint, scrollRef, measureHint]);
  return (
    <div class="resizable-scroll-area">
      {canResize && (
        <ResizeHandle
          edge="top"
          onMouseDown={startResize('top')}
          height={height}
          minHeight={minH}
          maxHeight={maxH}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
      <pre
        ref={scrollRef}
        tabIndex={overflows ? 0 : undefined}
        role={overflows ? 'region' : undefined}
        aria-label={overflows ? scrollLabel : undefined}
        class={cx('resizable-scroll-area-scroll', fades.left && 'fade-left', fades.right && 'fade-right', className)}
        onScroll={onScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        {children}
      </pre>
      {scrollHint && overflows && <div class="resizable-scroll-hint">{scrollHint}</div>}
      {canResize && (
        <ResizeHandle
          edge="bottom"
          onMouseDown={startResize('bottom')}
          height={height}
          minHeight={minH}
          maxHeight={maxH}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
    </div>
  );
}
