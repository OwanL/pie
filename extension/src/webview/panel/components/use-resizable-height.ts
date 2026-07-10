import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

import { bindResizeMouseup } from './bind-resize-mouseup';

export interface UseResizableHeightOptions {
  /** Minimum height in px. Default 120. */
  minHeight?: number;
  /** Maximum height in px. Defaults to 80% of the viewport at drag start. */
  maxHeight?: number;
  /** Called when a drag begins (e.g. to reset a stick-to-bottom flag). */
  onResizeStart?: () => void;
}

export interface ResizableHeight<T extends HTMLElement> {
  /** Attach to the scrollable element. */
  scrollRef: RefObject<T>;
  /** Resolved height in px once the user has resized; `null` until then (the
   *  element falls back to its CSS height/max-height). */
  height: number | null;
  /** Resolved minimum height in px (defaults to 120). */
  minHeight: number;
  /** Resolved maximum height in px (opts.maxHeight, else 80% of viewport).
   *  `undefined` when `window` is unavailable (SSR) — the drag/keyboard
   *  handlers re-read the live viewport at call time. */
  maxHeight: number | undefined;
  /** Whether the resize handles should be rendered. Handles only appear when
   *  the content overflows the visible area (so a single-line section isn't
   *  bracketed by grab targets that crowd out its own clickable content), or
   *  once the user has resized (so they can keep adjusting without the
   *  handles vanishing the moment content fits). */
  canResize: boolean;
  /** Returns a mousedown handler bound to the given edge. */
  startResize: (edge: 'top' | 'bottom') => (e: MouseEvent) => void;
  /** Adjust the height by `delta` px, clamped to [minHeight, maxHeight]. Used
   *  by keyboard resize; mirrors the drag's onResizeStart side effect. */
  resizeBy: (delta: number) => void;
  /** Clear the user-set height, reverting to the CSS default. */
  reset: () => void;
}

/**
 * Vertical resize logic shared by every scrollable expanded section in the
 * transcript. Supports BOTH a top and a bottom drag handle so users can grow
 * the visible slice in place without scrolling. Height is ephemeral
 * webview-local state (STATE_CONTRACT § Webview-Local State — drag state); it
 * is intentionally not persisted.
 *
 * Generalises the original subagent top-only handle in tool-call-item.tsx.
 *
 * Handles are gated by `canResize`: callers should render the top/bottom
 * `ResizeHandle` only when `canResize` is true. This keeps short sections
 * (whose content fits naturally within the CSS max-height) free of the grab
 * strips that would otherwise crowd their clickable area — a single-line
 * result has no business being resizable.
 */
export function useResizableHeight<T extends HTMLElement = HTMLElement>(
  opts: UseResizableHeightOptions = {},
): ResizableHeight<T> {
  const { minHeight = 120, maxHeight, onResizeStart } = opts;
  const [height, setHeight] = useState<number | null>(null);
  // Whether the scroll content currently overflows its visible area. Drives
  // `canResize` so handles only appear when there is something to scroll (or
  // the user has already opted into resizing). Measured after every render —
  // cheap (two layout reads) and stable (setState bails when unchanged), and
  // it catches streaming content growth that a ResizeObserver would miss
  // (the border-box stays capped at max-height while scrollHeight keeps
  // climbing as content streams in).
  const [contentOverflows, setContentOverflows] = useState(false);
  const scrollRef = useRef<T>(null);
  // Guard `window` for SSR (preact-render-to-string has no window). In the
  // real webview window is always defined so this is a concrete number; the
  // drag + keyboard handlers also re-read the live viewport at call time.
  const resolvedMaxHeight = maxHeight
    ?? (typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.8) : undefined);

  // Re-measure overflow after every render. Runs in a layout effect so the
  // handle visibility is correct before paint (no flash of the wrong state).
  // setState bails out when the boolean is unchanged, so there is no render
  // loop. A 1px tolerance absorbs sub-pixel rounding at the exact boundary.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const overflows = el.scrollHeight - el.clientHeight > 1;
    setContentOverflows((prev) => (prev === overflows ? prev : overflows));
  });

  const canResize = contentOverflows || height !== null;

  // `edge` is a call-time argument (not a closure dep): each handle binds
  // `startResize('top')` / `startResize('bottom')` once, capturing its edge.
  const startResize = useCallback(
    (edge: 'top' | 'bottom') => (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = scrollRef.current;
      if (!el) return;
      const startY = e.clientY;
      const startH = el.clientHeight;
      const maxH = maxHeight ?? Math.round(window.innerHeight * 0.8);
      onResizeStart?.();
      const onMove = (ev: MouseEvent) => {
        const delta = edge === 'top' ? startY - ev.clientY : ev.clientY - startY;
        const next = Math.max(minHeight, Math.min(maxH, Math.round(startH + delta)));
        setHeight(next);
      };
      bindResizeMouseup(onMove, 'row-resize');
    },
    [minHeight, maxHeight, onResizeStart],
  );

  // Keyboard resize: adjust the height by a delta, clamped to the resolved
  // range. Reads the live clientHeight when no user height is set yet so the
  // arrow keys work before the first drag. Mirrors the drag's onResizeStart.
  const resizeBy = useCallback(
    (delta: number) => {
      const el = scrollRef.current;
      if (!el) return;
      onResizeStart?.();
      const base = height ?? el.clientHeight;
      const maxH = resolvedMaxHeight ?? Math.round(window.innerHeight * 0.8);
      const next = Math.max(minHeight, Math.min(maxH, Math.round(base + delta)));
      setHeight(next);
    },
    [minHeight, resolvedMaxHeight, height, onResizeStart],
  );

  const reset = useCallback(() => setHeight(null), []);

  return { scrollRef, height, minHeight, maxHeight: resolvedMaxHeight, canResize, startResize, resizeBy, reset };
}
