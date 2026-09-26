/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

export interface DropGapProps {
  index: number;
  dropIndex: number | null;
  tabHeight: number;
  dragGapWidth: number;
}

// Memoized with primitive props so during a drag only the (at most two)
// DropGaps whose `dropIndex` matches re-render — not all of them — when the
// parent re-renders on each pointermove.
export const DropGap = memo(function DropGap({ index, dropIndex, tabHeight, dragGapWidth }: DropGapProps) {
  if (dropIndex === null || dropIndex !== index) {
    return null;
  }

  return (
    <div
      key={`drop-gap:${index}`}
      class="session-tab-drop-gap"
      style={{ width: `${dragGapWidth}px`, height: `${tabHeight}px` }}
      aria-hidden="true"
    >
      <span class="session-tab-drop-slot" />
      <span class="session-tab-drop-marker" />
    </div>
  );
});
