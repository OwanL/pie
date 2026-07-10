import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface UseMenuViewportClampOptions {
  x: number;
  y: number;
  /** When true, the element that was focused before the menu opened is
   * restored when the menu unmounts. Defaults to false. */
  restoreFocusOnClose?: boolean;
}

export interface UseMenuViewportClampResult {
  ref: { current: HTMLDivElement | null };
  pos: { top: number; left: number };
}

/**
 * Shared viewport-clamp + focus-management logic for fixed-position context
 * menus. Measures the rendered menu after mount and flips/clamps it so it stays
 * inside the viewport, then moves focus to the first menu item. Optionally
 * restores focus to the trigger element on unmount.
 */
export function useMenuViewportClamp({
  x,
  y,
  restoreFocusOnClose = false,
}: UseMenuViewportClampOptions): UseMenuViewportClampResult {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: y, left: x });

  // Position: measure the RENDERED menu after mount and clamp to the viewport.
  // If it would overflow the bottom/right, flip it above/left of the cursor
  // instead of clamping it under. Uses offsetWidth/offsetHeight so the
  // panel-scale-in transform doesn't skew the measurement. Runs before paint
  // (useLayoutEffect) so the corrected position is what the user first sees.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const margin = 4;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let top = y;
    let left = x;
    if (top + height > window.innerHeight - margin) {
      const flipped = y - height;
      top = flipped >= margin ? flipped : Math.max(margin, window.innerHeight - margin - height);
    }
    if (left + width > window.innerWidth - margin) {
      const flipped = x - width;
      left = flipped >= margin ? flipped : Math.max(margin, window.innerWidth - margin - width);
    }
    top = Math.max(margin, top);
    left = Math.max(margin, left);
    setPos({ top, left });
  }, [x, y]);

  // Focus management: capture the trigger that opened the menu when requested,
  // move focus to the first item on open, and restore focus to the trigger on
  // close when requested.
  useEffect(() => {
    if (restoreFocusOnClose) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    }
    const firstItem = ref.current?.querySelector<HTMLButtonElement>('button.context-menu-item');
    firstItem?.focus();
    return () => {
      if (restoreFocusOnClose) {
        triggerRef.current?.focus?.();
      }
    };
  }, []);

  return { ref, pos };
}
