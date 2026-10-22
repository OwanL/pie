import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { wasMenuDismissedByTab } from './useMenuListeners';

export interface UseMenuViewportClampOptions {
  x: number;
  y: number;
  /** The element which opened the menu, used for focus restoration. */
  triggerEl?: HTMLElement | null;
  /** When true, focus is restored when the menu unmounts. Defaults to false. */
  restoreFocusOnClose?: boolean;
  /** Optional value which causes focus to be repaired when menu items change. */
  refocusKey?: unknown;
}

export interface UseMenuViewportClampResult {
  ref: { current: HTMLDivElement | null };
  pos: { top: number; left: number };
  prepareTabExit: () => void;
}

/**
 * Shared viewport-clamp + focus-management logic for fixed-position context
 * menus. Measures the rendered menu after mount and flips/clamps it so it stays
 * inside the viewport, then moves focus to the first enabled menu item.
 */
export function useMenuViewportClamp({
  x,
  y,
  triggerEl,
  restoreFocusOnClose = false,
  refocusKey,
}: UseMenuViewportClampOptions): UseMenuViewportClampResult {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: y, left: x });

  // Position: measure the RENDERED menu after mount and clamp to the viewport.
  // offsetWidth/offsetHeight are deliberately used instead of a transformed
  // bounding rect so panel-scale-in does not skew the correction.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const margin = 4;
    const measure = () => {
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
      setPos((previous) => previous.top === top && previous.left === left ? previous : { top, left });
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, [x, y]);

  // Focus management: use the explicit trigger when provided. The active
  // element fallback preserves the old opt-in behavior for callers which have
  // not yet captured a trigger.
  useEffect(() => {
    if (restoreFocusOnClose) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      triggerRef.current = triggerEl ?? previousFocusRef.current;
    }
    const menuNode = ref.current;
    const firstItem = ref.current?.querySelector<HTMLButtonElement>('button.context-menu-item:not(:disabled)');
    firstItem?.focus();
    return () => {
      if (!restoreFocusOnClose || wasMenuDismissedByTab(menuNode)) return;
      triggerRef.current?.focus?.({ preventScroll: true });
      // Some context-menu targets are layout wrappers rather than focusable
      // controls. Do not leave focus on a removed menu in that case.
      if (document.activeElement !== triggerRef.current) {
        previousFocusRef.current?.focus?.({ preventScroll: true });
      }
    };
  }, [restoreFocusOnClose, triggerEl]);

  // A menu may remain mounted while one of its items is removed (for example,
  // cancelling one deferred trigger). Keep keyboard focus inside the overlay
  // instead of leaving it on a detached button.
  useEffect(() => {
    if (refocusKey === undefined || ref.current?.contains(document.activeElement)) return;
    ref.current?.querySelector<HTMLButtonElement>('button.context-menu-item:not(:disabled)')?.focus();
  }, [refocusKey]);

  const prepareTabExit = () => {
    // Use the same logical anchor and fallback as ordinary focus restoration.
    // This must happen during keydown, before native sequential navigation.
    triggerRef.current?.focus?.({ preventScroll: true });
    if (document.activeElement !== triggerRef.current) {
      previousFocusRef.current?.focus?.({ preventScroll: true });
    }
    // A pointer-opened menu can have a nonfocusable wrapper as its trigger
    // and no previously focused control. Give native Tab a starting point in
    // that wrapper's document position without permanently changing tab order.
    const trigger = triggerRef.current;
    if (ref.current?.contains(document.activeElement) && trigger) {
      const tabIndex = trigger.getAttribute('tabindex');
      trigger.setAttribute('tabindex', '-1');
      trigger.focus({ preventScroll: true });
      if (tabIndex === null) trigger.removeAttribute('tabindex');
      else trigger.setAttribute('tabindex', tabIndex);
    }
    // Portalled menu items must not become the next native Tab destination.
    // Inert also covers any nested menus without enumerating focusable DOM.
    ref.current?.setAttribute('inert', '');
  };

  return { ref, pos, prepareTabExit };
}
