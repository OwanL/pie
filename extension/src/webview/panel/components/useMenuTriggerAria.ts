import { useEffect } from 'preact/hooks';

/**
 * Returns the element which should own menu trigger semantics for a context
 * menu event. Prefer a focusable descendant (for example, a tab button) over a
 * layout wrapper so closing the menu can return focus to something usable.
 */
export function getContextMenuTrigger(event: MouseEvent): HTMLElement | null {
  const target = event.target;
  if (typeof Element !== 'undefined' && target instanceof Element) {
    const focusable = target.closest<HTMLElement>('button:not(:disabled), [role="button"], [tabindex]');
    if (focusable) return focusable;
  }
  return typeof HTMLElement !== 'undefined' && event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : null;
}

/** Mirror the open state of a mounted menu onto the element which opened it. */
export function useMenuTriggerAria(triggerEl: HTMLElement | null | undefined, open = true): void {
  useEffect(() => {
    if (!triggerEl) return;
    const previousExpanded = triggerEl.getAttribute('aria-expanded');
    const previousHasPopup = triggerEl.getAttribute('aria-haspopup');
    triggerEl.setAttribute('aria-haspopup', 'menu');
    triggerEl.setAttribute('aria-expanded', String(open));
    return () => {
      // Context menus can be opened from disclosure controls. Restore their
      // prior expanded state instead of announcing that disclosure as closed,
      // unless another handler changed it while the menu was open.
      if (triggerEl.getAttribute('aria-expanded') === String(open)) {
        if (previousExpanded === null) triggerEl.setAttribute('aria-expanded', 'false');
        else triggerEl.setAttribute('aria-expanded', previousExpanded);
      }
      if (triggerEl.getAttribute('aria-haspopup') === 'menu' && previousHasPopup !== null && previousHasPopup !== 'menu') {
        triggerEl.setAttribute('aria-haspopup', previousHasPopup);
      }
    };
  }, [triggerEl, open]);
}
