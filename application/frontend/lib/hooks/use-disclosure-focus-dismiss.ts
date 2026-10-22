import { useLayoutEffect } from 'preact/hooks';

interface ElementRef {
  current: HTMLElement | null;
}

/** Non-modal disclosures keep native Tab navigation and never restore focus.
 * Listen for a concrete destination, not blur: window deactivation is not exit. */
export function useDisclosureFocusDismiss(
  open: boolean,
  triggerRef: ElementRef,
  popupRef: ElementRef,
  onDismiss: () => void,
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [open, triggerRef, popupRef, onDismiss]);
}
