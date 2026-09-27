/** True when any non-collapsed document selection overlaps an element. Checking
 *  the full ranges (rather than only their anchor) also protects reverse and
 *  cross-block selections whose other endpoint is outside the element. */
export function hasSelectionOverlapping(element: Element | null): boolean {
  if (!element) return false;
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}
