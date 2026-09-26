import { defaultRangeExtractor, type Range } from '@tanstack/virtual-core';

/** Keep active inline editors mounted even when their row leaves the viewport. */
export function extractRangeWithPinnedIndexes(range: Range, pinnedIndexes: readonly number[]): number[] {
  const indexes = new Set(defaultRangeExtractor(range));
  for (const index of pinnedIndexes) {
    if (index >= 0 && index < range.count) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}
