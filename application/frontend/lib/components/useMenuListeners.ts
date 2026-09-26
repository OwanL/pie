import { useEffect, useRef } from 'preact/hooks';

interface MenuRef {
  current: HTMLDivElement | null;
}

export interface UseMenuListenersOptions {
  /** Called on mousedown outside the menu. Default: close. */
  onOutsideClick?: (e: MouseEvent) => void;
  /** Optional key customization. Prevent the event to override navigation. */
  onKey?: (e: KeyboardEvent) => void;
  /** Called on window resize. Default: close. */
  onResize?: () => void;
  /** Close on a capture-phase scroll event. Defaults to false. */
  closeOnScroll?: boolean;
  /** Optional customization for the scroll dismissal. */
  onScroll?: () => void;
}

interface MenuListenerEntry {
  ref: MenuRef;
  latest: {
    current: {
      onClose: () => void;
      options: UseMenuListenersOptions | undefined;
    };
  };
}

// The most recently mounted menu is the top overlay. Keeping this small stack
// lets a document-level Escape listener close only that overlay, even though
// every menu owns its own dismissal lifecycle.
const menuStack: MenuListenerEntry[] = [];

function enabledItems(ref: MenuRef): HTMLButtonElement[] {
  return Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.context-menu-item:not(:disabled)') ?? []);
}

function moveFocus(event: KeyboardEvent, ref: MenuRef): void {
  const node = ref.current;
  if (!node) return;
  // Arrow navigation belongs to the menu while focus is in it. Escape is
  // intentionally handled regardless of focus so an overlay can always close.
  const target = event.target;
  if (!(target instanceof Node && node.contains(target)) && !node.contains(document.activeElement)) return;

  const items = enabledItems(ref);
  if (items.length === 0) return;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex: number | null = null;
  if (event.key === 'ArrowDown') nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % items.length;
  else if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = items.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  items[nextIndex]?.focus();
}

/**
 * Shared dismissal and keyboard behavior for popup menus. Subscriptions are
 * mounted once per menu; callback/options refs keep inline props from causing
 * listener churn or stale closures.
 */
export function useMenuListeners(
  ref: MenuRef,
  onClose: () => void,
  options?: UseMenuListenersOptions,
): void {
  const latest = useRef({ onClose, options });
  latest.current = { onClose, options };

  useEffect(() => {
    // Keep the entry's object stable while its callback data is refreshed on
    // every render by the ref assigned above.
    const entry: MenuListenerEntry = { ref, latest };
    menuStack.push(entry);

    const onOutside = (event: MouseEvent) => {
      const current = entry.latest.current;
      if (current.options?.onOutsideClick) {
        current.options.onOutsideClick(event);
      } else if (ref.current && !ref.current.contains(event.target as Node)) {
        current.onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (menuStack[menuStack.length - 1] !== entry) return;
      const current = entry.latest.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        current.onClose();
        return;
      }
      current.options?.onKey?.(event);
      if (!event.defaultPrevented) moveFocus(event, ref);
    };
    const onResize = () => {
      entry.latest.current.options?.onResize?.();
      if (!entry.latest.current.options?.onResize) entry.latest.current.onClose();
    };
    const onScroll = () => {
      const current = entry.latest.current;
      if (!current.options?.closeOnScroll) return;
      current.options.onScroll?.();
      if (!current.options.onScroll) current.onClose();
    };

    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    // Always keep this subscription stable; the current options decide whether
    // a given menu opts into scroll dismissal.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      const index = menuStack.indexOf(entry);
      if (index >= 0) menuStack.splice(index, 1);
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [ref]);
}
