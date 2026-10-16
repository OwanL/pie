interface TriggerRect { left: number; right: number; top: number; bottom: number }

/** Prefer a side cascade; on narrow screens leave the trigger's row exposed. */
export function placeSnoozeSubmenu(rect: TriggerRect, width: number, height: number,
  viewportWidth: number, viewportHeight: number) {
  const gap = 4;
  const clampLeft = (left: number) => Math.max(gap, Math.min(left, viewportWidth - width - gap));
  if (rect.right + width <= viewportWidth - gap || rect.left - width >= gap) {
    return { left: clampLeft(rect.right + width <= viewportWidth - gap ? rect.right : rect.left - width),
      top: Math.max(gap, Math.min(rect.top, viewportHeight - height - gap)),
      maxHeight: Math.max(0, viewportHeight - gap * 2) };
  }
  const below = Math.max(0, viewportHeight - rect.bottom - gap);
  const above = Math.max(0, rect.top - gap);
  const useBelow = height <= below || below >= above;
  const maxHeight = useBelow ? below : above;
  return { left: clampLeft(rect.left),
    top: useBelow ? rect.bottom : Math.max(gap, rect.top - Math.min(height, maxHeight)), maxHeight };
}
