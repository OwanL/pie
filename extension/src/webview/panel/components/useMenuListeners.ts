import { useEffect } from 'preact/hooks';

interface MenuRef {
  current: HTMLDivElement | null;
}

interface UseMenuListenersOptions {
  /** Called on mousedown outside the menu. Default: close. */
  onOutsideClick?: (e: MouseEvent) => void;
  /** Called on keydown inside the document. Default: close on Escape. */
  onKey?: (e: KeyboardEvent) => void;
  /** Called on window resize. Default: close. */
  onResize?: () => void;
}

/**
 * Hook that closes a menu on outside-click (mousedown), Escape key, or
 * window resize.  Mirrors the listener pattern used by every popup menu
 * component in the webview.
 *
 * Call from a component that has a `ref` pointing to the menu root element.
 * The default mousedown handler checks `ref.current && !ref.current.contains(e.target)`
 * so clicks inside the menu are ignored.
 *
 * Pass `onOutsideClick` / `onKey` / `onResize` to customise behaviour.
 * All listeners are removed on cleanup (unmount or dependency change).
 */
export function useMenuListeners(
  ref: MenuRef,
  onClose: () => void,
  options?: UseMenuListenersOptions,
): void {
  useEffect(() => {
    const onOutside =
      options?.onOutsideClick ??
      ((e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      });
    const onKey =
      options?.onKey ??
      ((e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      });
    const onRes = options?.onResize ?? (() => onClose());
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onRes);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onRes);
    };
  }, [ref, onClose, options]);
}
