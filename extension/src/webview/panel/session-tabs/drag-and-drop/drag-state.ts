import { TAB_DRAG_VERTICAL_SLOP_PX } from './constants';
import { getHorizontalDropIndex } from '../../../../shared/tab-behavior';
import { derivePinnedItems, findPinnedGroupIndex } from '../../../../shared/tab-behavior';

import type { TabDragCandidate, SessionTabDragState } from '../types';

/** Context describing the dragged tab's zone and the pinned-group structure,
 *  used to compute a zone-aware drop target (gap reorder vs group/merge) and
 *  to convert the gap index to the right coordinate space at commit. */
export interface DropZoneOptions {
  sourcePath: string;
  /** Whether the source is a pinned tab (grouped or standalone). */
  sourceIsPinned: boolean;
  /** Whether the source is a whole group chip (vs a dropdown member or a
   *  standalone chip). A group chip may merge onto another group but cannot
   *  group onto a standalone tab; a dropdown member (grouped, but not a chip
   *  drag) may center-drop onto a standalone to group with it. */
  sourceIsGroupChip: boolean;
  pinnedTabPaths: readonly string[];
  pinnedTabGroups: readonly string[][];
}

/** Central fraction of a pinned item that counts as an "on drop" (group/merge)
 *  rather than a gap reorder. Matches Discord's "drag onto the icon" feel:
 *  the central ~60% of the chip merges; the margins reorder. */
const PINNED_DROP_ON_FRACTION = 0.6;

export interface DropComputation {
  /** Gap index for a reorder, zone-specific (pinned-item-space for a pinned
   *  source, unpinned-gap-space for an unpinned source), or null when outside
   *  the zone or centered on a pinned item. */
  dropIndex: number | null;
  /** Pinned item path the pointer is centered over (group/merge), or null. */
  dropOnPath: string | null;
  dropOnIsGroup: boolean;
}

/** Clamp a raw pinned-item gap index to the pinned zone (0..pinnedItemCount,
 *  where pinnedItemCount is the number of pinned-item elements present, i.e.
 *  the source chip already hidden). */
function clampPinnedGap(dropIndex: number, pinnedItemCount: number): number {
  return Math.min(Math.max(dropIndex, 0), pinnedItemCount);
}

/** Clamp a raw unpinned gap index to the unpinned zone (0..unpinnedCount). */
function clampUnpinnedGap(dropIndex: number, unpinnedCount: number): number {
  return Math.min(Math.max(dropIndex, 0), unpinnedCount);
}

/** Find the pinned item element whose central region contains the pointer —
 *  an "on drop" (group/merge) target. Returns the item's identifying path and
 *  whether it is a group chip, or null when the pointer is in a gap/margin. */
function findPinnedDropOn(
  clientX: number,
  clientY: number,
  stripRect: { top: number; bottom: number },
  elements: HTMLElement[],
): { path: string; isGroup: boolean } | null {
  if (
    clientY < stripRect.top - TAB_DRAG_VERTICAL_SLOP_PX
    || clientY > stripRect.bottom + TAB_DRAG_VERTICAL_SLOP_PX
  ) {
    return null;
  }
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const margin = rect.width * ((1 - PINNED_DROP_ON_FRACTION) / 2);
    if (
      clientX >= rect.left + margin
      && clientX <= rect.right - margin
      && clientY >= rect.top - TAB_DRAG_VERTICAL_SLOP_PX
      && clientY <= rect.bottom + TAB_DRAG_VERTICAL_SLOP_PX
    ) {
      const path = element.getAttribute('data-pinned-item-path');
      if (path) {
        return { path, isGroup: element.getAttribute('data-pinned-item-group') === 'true' };
      }
    }
  }
  return null;
}

export function runComputeDropIndex(
  clientX: number,
  clientY: number,
  stripRef: { current: HTMLElement | null },
  zone: DropZoneOptions,
): DropComputation | null {
  const strip = stripRef.current;
  if (!strip) {
    return null;
  }

  const stripRect = strip.getBoundingClientRect();
  if (
    clientY < stripRect.top - TAB_DRAG_VERTICAL_SLOP_PX
    || clientY > stripRect.bottom + TAB_DRAG_VERTICAL_SLOP_PX
  ) {
    return null;
  }

  if (zone.sourceIsPinned) {
    const elements = Array.from(strip.querySelectorAll<HTMLElement>('[data-pinned-item="true"]'));
    // Center-hit (group/merge) takes priority over a gap reorder — but only
    // when the drop would actually do something:
    //  - standalone or dropdown-member source onto any pinned item →
    //    group/append (a dropdown member may join a standalone, forming a new
    //    group, even though it is currently grouped);
    //  - group-chip source onto a different group → merge.
    // A group chip onto a standalone (no merge target) falls through to a gap
    // reorder, and a same-group hit is a no-op (falls through to a gap too).
    const dropOn = findPinnedDropOn(clientX, clientY, stripRect, elements);
    if (dropOn && dropOn.path !== zone.sourcePath) {
      const sourceGroupIdx = findPinnedGroupIndex(zone.pinnedTabGroups, zone.sourcePath);
      const targetGroupIdx = findPinnedGroupIndex(zone.pinnedTabGroups, dropOn.path);
      const sameGroup = sourceGroupIdx !== -1 && sourceGroupIdx === targetGroupIdx;
      // Only a whole-group-chip drag is blocked from landing on a standalone
      // (whole groups cannot group onto a standalone; they can only merge onto
      // another group). A dropdown member — grouped, but dragged as a single
      // tab — IS allowed to center-drop onto a standalone to group with it.
      const groupChipOntoStandalone = zone.sourceIsGroupChip && targetGroupIdx === -1;
      if (!sameGroup && !groupChipOntoStandalone) {
        return { dropIndex: null, dropOnPath: dropOn.path, dropOnIsGroup: dropOn.isGroup };
      }
    }
    const rects = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    const rawDropIndex = getHorizontalDropIndex(rects, clientX);
    return { dropIndex: clampPinnedGap(rawDropIndex, rects.length), dropOnPath: null, dropOnIsGroup: false };
  }

  // Unpinned source: gap reorder within the unpinned zone (0-based within
  // unpinned tabs; converted to a flat openTabPaths index at commit).
  const elements = Array.from(strip.querySelectorAll<HTMLElement>('[data-unpinned-tab="true"]'));
  const rects = elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  const rawDropIndex = getHorizontalDropIndex(rects, clientX);
  return { dropIndex: clampUnpinnedGap(rawDropIndex, rects.length), dropOnPath: null, dropOnIsGroup: false };
}

export function runSyncDragFromPointer(
  clientX: number,
  clientY: number,
  dragStateRef: { current: SessionTabDragState | null },
  stripRef: { current: HTMLElement | null },
  setDragState: (state: SessionTabDragState | null) => void,
  pinnedTabPathsRef: { current: readonly string[] },
  pinnedTabGroupsRef: { current: readonly string[][] },
): void {
  const current = dragStateRef.current;
  if (!current) {
    return;
  }

  const computation = runComputeDropIndex(clientX, clientY, stripRef, {
    sourcePath: current.sourcePath,
    sourceIsPinned: pinnedTabPathsRef.current.includes(current.sourcePath),
    sourceIsGroupChip: current.sourceIsGroupChip,
    pinnedTabPaths: pinnedTabPathsRef.current,
    pinnedTabGroups: pinnedTabGroupsRef.current,
  });
  // Live pointer position is NOT carried in React state (it would re-render
  // the parent every pointermove). The floating ghost transform is driven
  // imperatively; only a dropIndex / dropOnPath change warrants a state update.
  const nextDropIndex = computation?.dropIndex ?? null;
  const nextDropOnPath = computation?.dropOnPath ?? null;
  const nextDropOnIsGroup = computation?.dropOnIsGroup ?? false;
  if (
    current.dropIndex === nextDropIndex
    && current.dropOnPath === nextDropOnPath
    && current.dropOnIsGroup === nextDropOnIsGroup
  ) {
    return;
  }

  const nextState: SessionTabDragState = {
    ...current,
    dropIndex: nextDropIndex,
    dropOnPath: nextDropOnPath,
    dropOnIsGroup: nextDropOnIsGroup,
  };
  dragStateRef.current = nextState;
  setDragState(nextState);
}

export function runReleaseSuppressedClickSoon(
  suppressNextClickRef: { current: boolean },
  suppressClickTimerRef: { current: number | null },
): void {
  suppressNextClickRef.current = true;
  if (suppressClickTimerRef.current !== null) {
    window.clearTimeout(suppressClickTimerRef.current);
  }
  suppressClickTimerRef.current = window.setTimeout(() => {
    suppressNextClickRef.current = false;
    suppressClickTimerRef.current = null;
  }, 0);
}

export function runResetDrag(
  suppressClick: boolean,
  suppressNextClickRef: { current: boolean },
  suppressClickTimerRef: { current: number | null },
  dragCandidateRef: { current: TabDragCandidate | null },
  dragStateRef: { current: SessionTabDragState | null },
  pointerPositionRef: { current: { x: number; y: number } | null },
  setDragState: (state: SessionTabDragState | null) => void,
  endTracking: () => void,
): void {
  if (suppressClick) {
    runReleaseSuppressedClickSoon(suppressNextClickRef, suppressClickTimerRef);
  }
  dragCandidateRef.current = null;
  dragStateRef.current = null;
  pointerPositionRef.current = null;
  setDragState(null);
  endTracking();
}

export function runCommitDrag(
  dragStateRef: { current: SessionTabDragState | null },
  openTabPathsRef: { current: string[] },
  pinnedTabPathsRef: { current: readonly string[] },
  pinnedTabGroupsRef: { current: readonly string[][] },
  callbacks: {
    onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
    onMovePinnedItem: (sourcePath: string, toItemIndex: number) => void;
    onGroupPinnedTab: (sourcePath: string, targetPath: string) => void;
    onMergePinnedGroups: (sourcePath: string, targetPath: string) => void;
    onUngroupPinnedTab: (sourcePath: string, toItemIndex: number) => void;
    onSelect: (path: string) => void;
  },
  resetDrag: (suppressClick: boolean) => void,
): void {
  const current = dragStateRef.current;
  if (!current) {
    resetDrag(false);
    return;
  }

  const pinnedTabPaths = pinnedTabPathsRef.current;
  const pinnedTabGroups = pinnedTabGroupsRef.current;
  const sourcePath = current.sourcePath;
  const sourceIsPinned = pinnedTabPaths.includes(sourcePath);

  // ── Center-hit: group / merge (pinned sources only). ──
  if (current.dropOnPath !== null) {
    const sourceGroupIdx = findPinnedGroupIndex(pinnedTabGroups, sourcePath);
    const targetGroupIdx = findPinnedGroupIndex(pinnedTabGroups, current.dropOnPath);
    if (current.sourceIsGroupChip && targetGroupIdx !== -1) {
      // Group chip onto a group → merge (target members then source members).
      if (sourceGroupIdx !== -1 && sourceGroupIdx !== targetGroupIdx) {
        callbacks.onMergePinnedGroups(sourcePath, current.dropOnPath);
      }
    } else if (!current.sourceIsGroupChip) {
      // Standalone / dropdown member onto a pinned item → group/append.
      // (Group chip onto a standalone is intentionally a no-op.)
      if (sourceGroupIdx !== targetGroupIdx) {
        callbacks.onGroupPinnedTab(sourcePath, current.dropOnPath);
      }
    }
    resetDrag(true);
    return;
  }

  // ── Gap reorder. ──
  if (current.dropIndex === null) {
    // Released outside the source's zone → cancel (no select: the pointer
    // left the strip, so this is not a click-equivalent).
    resetDrag(true);
    return;
  }

  if (sourceIsPinned) {
    // Detect a same-slot release (no movement between pinned items) so a
    // standalone pinned chip still activates on a threshold-jittered click.
    // Dropdown-member sources are excluded: their "same slot" is the gap
    // immediately before their owning group, which is a valid ungroup target —
    // not a click. Letting it fall through routes the release to
    // onUngroupPinnedTab instead of swallowing it.
    const items = derivePinnedItems(pinnedTabPaths, pinnedTabGroups);
    const sourceItemIndex = items.findIndex((item) =>
      item.kind === 'group' ? item.members.includes(sourcePath) : item.path === sourcePath,
    );
    if (!current.sourceFromDropdown && current.dropIndex === sourceItemIndex) {
      if (!current.sourceIsGroupChip) {
        callbacks.onSelect(sourcePath);
      }
      resetDrag(true);
      return;
    }
    if (current.sourceFromDropdown) {
      callbacks.onUngroupPinnedTab(sourcePath, current.dropIndex);
    } else {
      callbacks.onMovePinnedItem(sourcePath, current.dropIndex);
    }
    resetDrag(true);
    return;
  }

  // Unpinned gap: convert the unpinned-gap index (0-based within unpinned,
  // source-removed) to a flat openTabPaths index (the pinned prefix length is
  // the offset). The reducer re-resolves the from-index from the path and
  // clamps to the unpinned zone as a safety net.
  const currentPaths = openTabPathsRef.current;
  const sourceIndex = currentPaths.indexOf(sourcePath);
  const flatToIndex = pinnedTabPaths.length + current.dropIndex;
  if (sourceIndex !== -1 && flatToIndex !== sourceIndex) {
    callbacks.onMove(sourcePath, sourceIndex, flatToIndex);
  } else if (sourceIndex !== -1) {
    // Same-slot release (e.g. a click that jittered past the threshold): the
    // compatibility `click` was suppressed, so switch the tab explicitly.
    callbacks.onSelect(sourcePath);
  }
  resetDrag(true);
}
