/** Items arrive in strict presentation/retention priority order. Never show a
 * lower-priority item instead of an item that could not fit completely. */
export function allocateAggregateStrip(availableWidth: number, widths: readonly number[], gap = 8): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 0;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    // A zero-width measurement is not ready, not a free item.
    if (!Number.isFinite(width) || width <= 0) break;
    const next = used + (count > 0 ? gap : 0) + width;
    if (next > availableWidth) break;
    used = next;
    count++;
  }
  return count;
}
