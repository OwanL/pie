/**
 * Bind `mousemove` / `mouseup` listeners and manage the resize cursor.
 *
 * Shared by `use-resizable-height` and `use-resizable-width` to avoid
 * duplicate mouseup-cleanup listener logic. The cursor style is supplied by
 * the caller since each axis uses a different cursor (`row-resize` /
 * `col-resize`).
 *
 * Call-time effect:
 * 1. Registers `onMove` on `window` for `mousemove`.
 * 2. Registers the cleanup handler on `window` for `mouseup`.
 * 3. Sets `document.body.style.cursor` to the caller's cursor value.
 * 4. Sets `document.body.style.userSelect = 'none'`.
 *
 * When the user releases the mouse, the cleanup handler removes both
 * listeners and clears `cursor` / `userSelect` on `document.body`.
 *
 * No return value — all binding is internal to the helper.
 */
export function bindResizeMouseup(
  onMove: (e: MouseEvent) => void,
  cursor: string,
): void {
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
}
