/**
 * Keyboard invocation of context menus: the `ContextMenu`/`Menu` key and
 * Shift+F10 behave like a right-click on the focused trigger.
 *
 * Every panel context menu opens through exactly one path — the trigger's
 * mouse `onContextMenu` handler. Keyboard requests are therefore translated
 * into a synthetic, grounded `contextmenu` MouseEvent dispatched from the
 * focused element at its bounding rect, so mouse and keyboard share one open
 * path and one set of open-time behaviors (trigger capture, focus restore,
 * menu keyboard support).
 */

/** True when this keydown asks for the context menu (Menu/ContextMenu key or Shift+F10). */
export function isContextMenuKeyRequest(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || event.key === 'Menu' || (event.key === 'F10' && event.shiftKey);
}

/** Dispatch a synthetic `contextmenu` MouseEvent from `trigger` at the center
 *  of its bounding rect, so clientX/clientY-driven positioning behaves like a
 *  native right-click grounded at the trigger. Returns whether dispatch ran. */
export function dispatchSyntheticContextMenu(trigger: HTMLElement): boolean {
  const rect = trigger.getBoundingClientRect();
  return trigger.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
}

/**
 * Shared keydown handler for keyboard-focusable context-menu triggers:
 * translates the ContextMenu/Menu key and Shift+F10 into a synthetic
 * `contextmenu` dispatched from the focused element (the trigger that received
 * the event). The event then bubbles through that element's existing mouse
 * `onContextMenu` handlers — e.g. nested tool/daemon/file-path menus keep
 * precedence over the row fallback exactly as with a real right-click.
 *
 * No-ops for editable elements (native text menu) and for already-handled
 * events, so a request dispatched by an inner trigger is never re-dispatched
 * while bubbling to an outer one.
 */
export function handleContextMenuKeyRequest(event: KeyboardEvent): void {
  if (!isContextMenuKeyRequest(event) || event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  dispatchSyntheticContextMenu(target);
}