/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

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
export function ResizablePre({ class: className, minHeight, maxHeight, onScroll, onResizeStart, children }: ResizablePreProps) {
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
        class={cx('resizable-scroll-area-scroll', className)}
        onScroll={onScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        {children}
      </pre>
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
