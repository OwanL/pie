import { useCallback, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

import { bindResizeMouseup } from './bind-resize-mouseup';

export interface UseResizableWidthOptions {
  /** Minimum width in px. Default 160. */
  minWidth?: number;
  /** Maximum width in px. Defaults to 80% of the viewport width at drag start. */
  maxWidth?: number;
  /** Called when a drag begins. */
  onResizeStart?: () => void;
}

export interface ResizableWidth<T extends HTMLElement> {
  /** Attach to the element whose width is being controlled. */
  elRef: RefObject<T>;
  /** Resolved width in px once the user has resized; `null` until then (the
   *  element falls back to its CSS width). */
  width: number | null;
  /** Resolved minimum width in px (defaults to 160). */
  minWidth: number;
  /** Resolved maximum width in px (opts.maxWidth, else 80% of viewport width).
   *  `undefined` when `window` is unavailable (SSR) — the drag/keyboard
   *  handlers re-read the live viewport at call time. */
  maxWidth: number | undefined;
  /** Returns a mousedown handler bound to the given edge. */
  startResize: (edge: 'left' | 'right') => (e: MouseEvent) => void;
  /** Adjust the width by `delta` px, clamped to [minWidth, maxWidth]. Used by
   *  keyboard resize; mirrors the drag's onResizeStart side effect. */
  resizeBy: (delta: number) => void;
  /** Clear the user-set width, reverting to the CSS default. */
  reset: () => void;
}

/**
 * Horizontal resize logic — the width analogue of `useResizableHeight`. A
 * `'left'` edge handle (on a right-docked surface) grows when dragged left
 * (`startX - clientX`); a `'right'` edge handle grows when dragged right
 * (`clientX - startX`). Width is ephemeral webview-local state
 * (STATE_CONTRACT § Webview-Local State — drag state); it is intentionally
 * not persisted, mirroring the height-resize precedent.
 */
export function useResizableWidth<T extends HTMLElement = HTMLElement>(
  opts: UseResizableWidthOptions = {},
): ResizableWidth<T> {
  const { minWidth = 160, maxWidth, onResizeStart } = opts;
  const [width, setWidth] = useState<number | null>(null);
  const elRef = useRef<T>(null);
  // Guard `window` for SSR (preact-render-to-string has no window). In the
  // real webview window is always defined so this is a concrete number; the
  // drag + keyboard handlers also re-read the live viewport at call time.
  const resolvedMaxWidth = maxWidth
    ?? (typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.8) : undefined);

  // `edge` is a call-time argument (not a closure dep): each handle binds
  // `startResize('left')` / `startResize('right')` once, capturing its edge.
  const startResize = useCallback(
    (edge: 'left' | 'right') => (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elRef.current;
      if (!el) return;
      const startX = e.clientX;
      const startW = el.clientWidth;
      const maxW = maxWidth ?? Math.round(window.innerWidth * 0.8);
      onResizeStart?.();
      const onMove = (ev: MouseEvent) => {
        const delta = edge === 'left' ? startX - ev.clientX : ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxW, Math.round(startW + delta)));
        setWidth(next);
      };
      bindResizeMouseup(onMove, 'col-resize');
    },
    [minWidth, maxWidth, onResizeStart],
  );

  // Keyboard resize: adjust the width by a delta, clamped to the resolved
  // range. Reads the live clientWidth when no user width is set yet so the
  // arrow keys work before the first drag. Mirrors the drag's onResizeStart.
  const resizeBy = useCallback(
    (delta: number) => {
      const el = elRef.current;
      if (!el) return;
      onResizeStart?.();
      const base = width ?? el.clientWidth;
      const maxW = resolvedMaxWidth ?? Math.round(window.innerWidth * 0.8);
      const next = Math.max(minWidth, Math.min(maxW, Math.round(base + delta)));
      setWidth(next);
    },
    [minWidth, resolvedMaxWidth, width, onResizeStart],
  );

  const reset = useCallback(() => setWidth(null), []);

  return { elRef, width, minWidth, maxWidth: resolvedMaxWidth, startResize, resizeBy, reset };
}
