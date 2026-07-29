import type { SessionSummary } from './protocol';

export const PENDING_SESSION_PREFIX = '__pending__:';

export type HorizontalDropRect = {
  left: number;
  right: number;
};

export function isPendingTabPath(sessionPath: string): boolean {
  return sessionPath.startsWith(PENDING_SESSION_PREFIX);
}

export function readStoredOpenTabPath(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object'
      ? (typeof (value as Record<string, unknown>)['path'] === 'string'
          ? ((value as Record<string, unknown>)['path'] as string)
          : null)
      : null;
}

/**
 * Normalize a stored tab-path list (read back from globalState) into a clean
 * `string[]`. Accepts both the legacy bare-string format and the newer
 * `{ path, name? }` object format, drops pending paths, and de-duplicates while
 * preserving order. Generic over open vs pinned tabs — both are persisted as
 * path lists and need the same normalization on restore.
 */
export function normalizeStoredTabPaths(storedPaths: readonly unknown[]): string[] {
  const seenPaths = new Set<string>();
  const normalizedPaths: string[] = [];

  for (const value of storedPaths) {
    // Accept both old string format and new {path, name?} object format.
    const path = readStoredOpenTabPath(value);

    if (!path || isPendingTabPath(path) || seenPaths.has(path)) {
      continue;
    }

    normalizedPaths.push(path);
    seenPaths.add(path);
  }

  return normalizedPaths;
}

type VisibleTabOptions = {
  openTabPaths: string[];
  sessions: SessionSummary[];
  workspaceCwd: string | null;
  activeSessionPath: string | null;
};

export function getVisibleTabPaths({
  openTabPaths,
}: VisibleTabOptions): string[] {
  const seenPaths = new Set<string>();
  const visiblePaths: string[] = [];

  for (const sessionPath of openTabPaths) {
    if (seenPaths.has(sessionPath)) {
      continue;
    }

    visiblePaths.push(sessionPath);
    seenPaths.add(sessionPath);
  }

  return visiblePaths;
}

/** Result of a pin/unpin mutation: the new `openTabPaths` (still the canonical
 *  strip order) and the new `pinnedTabPaths`. */
export interface PinTabResult {
  openTabPaths: string[];
  pinnedTabPaths: string[];
}

/**
 * Pin a tab (browser semantics). Maintains the invariant that pinned tabs form
 * the leading prefix of `openTabPaths`: the tab is moved to the end of the
 * pinned prefix and appended to `pinnedTabPaths`. Idempotent — pinning a tab
 * that is already pinned is a no-op. Pending paths cannot be pinned (the
 * caller guards this; the helper still tolerates them defensively).
 */
export function pinTab(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): PinTabResult {
  if (pinnedTabPaths.includes(sessionPath)) {
    return { openTabPaths: [...openTabPaths], pinnedTabPaths: [...pinnedTabPaths] };
  }
  const nextPinned = [...pinnedTabPaths, sessionPath];
  // Remove from the current position, then reinsert as the LAST pinned tab
  // (the tail of the pinned prefix). After removal the pinned prefix holds
  // `nextPinned.length - 1` tabs, so the new tail index is that count.
  const withoutPath = openTabPaths.filter((p) => p !== sessionPath);
  const insertAt = Math.min(nextPinned.length - 1, withoutPath.length);
  const nextOpen = [...withoutPath];
  nextOpen.splice(insertAt, 0, sessionPath);
  return { openTabPaths: nextOpen, pinnedTabPaths: nextPinned };
}

/**
 * Unpin a tab (browser semantics). Removes the tab from `pinnedTabPaths` and
 * moves it to the START of the unpinned region (right after the remaining
 * pinned tabs), preserving the pinned-prefix invariant. Idempotent — unpinning
 * a tab that is not pinned is a no-op.
 */
export function unpinTab(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): PinTabResult {
  if (!pinnedTabPaths.includes(sessionPath)) {
    return { openTabPaths: [...openTabPaths], pinnedTabPaths: [...pinnedTabPaths] };
  }
  const nextPinned = pinnedTabPaths.filter((p) => p !== sessionPath);
  const withoutPath = openTabPaths.filter((p) => p !== sessionPath);
  // Reinsert at the start of the unpinned region (index = remaining pinned count).
  const insertAt = Math.min(nextPinned.length, withoutPath.length);
  const nextOpen = [...withoutPath];
  nextOpen.splice(insertAt, 0, sessionPath);
  return { openTabPaths: nextOpen, pinnedTabPaths: nextPinned };
}

/**
 * Insert a not-yet-open tab into `openTabPaths` while preserving the
 * pinned-prefix invariant. A pinned path lands inside the pinned prefix (at its
 * `pinnedTabPaths` position, clamped to the count of currently-open pinned
 * tabs); an unpinned path appends at the end. Used by OpenSession (reopening a
 * pinned tab) — DuplicateSession builds its own insertion so the unpinned copy
 * can land adjacent to its source when the source is unpinned.
 */
export function insertTabRespectingPinnedPrefix(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): string[] {
  if (openTabPaths.includes(sessionPath)) {
    return [...openTabPaths];
  }
  const pinnedIndex = pinnedTabPaths.indexOf(sessionPath);
  if (pinnedIndex === -1) {
    return [...openTabPaths, sessionPath];
  }
  const openPinnedCount = pinnedTabPaths.filter((p) => openTabPaths.includes(p)).length;
  const insertAt = Math.min(pinnedIndex, openPinnedCount);
  const next = [...openTabPaths];
  next.splice(insertAt, 0, sessionPath);
  return next;
}

/**
 * Reorder `openTabPaths` so the pinned tabs form the leading prefix (in
 * `pinnedTabPaths` order), followed by the unpinned tabs in their existing
 * `openTabPaths` order. Pinned paths absent from `openTabPaths` are dropped
 * (the pinned ⊆ open invariant). Used by startup restore to normalize whatever
 * was persisted into the canonical pinned-first order.
 */
export function reorderOpenTabsPinnedFirst(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
): PinTabResult {
  const openSet = new Set(openTabPaths);
  const pinned = pinnedTabPaths.filter((p) => openSet.has(p));
  const pinnedSet = new Set(pinned);
  const unpinned = openTabPaths.filter((p) => !pinnedSet.has(p));
  return { openTabPaths: [...pinned, ...unpinned], pinnedTabPaths: pinned };
}

export function getHorizontalDropIndex(rects: readonly HorizontalDropRect[], clientX: number): number {
  if (rects.length === 0) {
    return 0;
  }

  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    const midpoint = rect.left + ((rect.right - rect.left) / 2);
    if (clientX <= midpoint) {
      return index;
    }
  }

  return rects.length;
}

export function moveOpenTabPath(
  openTabPaths: readonly string[],
  options: { sessionPath?: string; fromIndex: number; toIndex: number },
): string[] {
  if (openTabPaths.length <= 1) {
    return [...openTabPaths];
  }

  const nextPaths = [...openTabPaths];
  const resolvedFromIndex =
    options.sessionPath !== undefined
      ? nextPaths.indexOf(options.sessionPath)
      : -1;
  const fromIndex = resolvedFromIndex === -1 ? options.fromIndex : resolvedFromIndex;

  if (fromIndex < 0 || fromIndex >= nextPaths.length) {
    return nextPaths;
  }

  const toIndex = Math.max(0, Math.min(options.toIndex, nextPaths.length - 1));
  if (fromIndex === toIndex) {
    return nextPaths;
  }

  const [movedPath] = nextPaths.splice(fromIndex, 1);
  nextPaths.splice(toIndex, 0, movedPath);
  return nextPaths;
}

type NextTabOnCloseOptions = VisibleTabOptions & {
  closingPath: string;
};

export function getNextVisibleTabPathOnClose({ closingPath, ...options }: NextTabOnCloseOptions): string | null {
  const visiblePaths = getVisibleTabPaths(options);
  const closingIndex = visiblePaths.indexOf(closingPath);
  if (closingIndex === -1) {
    return null;
  }

  const remainingPaths = visiblePaths.filter((sessionPath) => sessionPath !== closingPath);
  if (remainingPaths.length === 0) {
    return null;
  }

  const nextIndex = Math.min(closingIndex, remainingPaths.length - 1);
  return remainingPaths[nextIndex] ?? null;
}

// ---------------------------------------------------------------------------
// Pinned-session groups (Discord-style clustering for pinned tabs).
//
// `pinnedTabGroups: string[][]` partitions some pinned tabs into unnamed
// groups. There are NO group ids — any member path identifies its group
// (`findPinnedGroupIndex`). A group renders as a single compact chip in the
// pinned strip; its members are listed in a dropdown below the bar.
//
// Invariants (enforced by the helpers below):
//  - Every group member is in `pinnedTabPaths` (groups ⊆ pinned ⊆ open).
//  - A path belongs to at most one group.
//  - A group's members appear CONTIGUOUSLY in `pinnedTabPaths`, in the same
//    order as the group array. Standalone (ungrouped) pinned tabs are single
//    entries. This makes the strip order derivable from `pinnedTabPaths`
//    alone: walk it, and the first member of a group signals a group chip
//    whose remaining members are absorbed.
//  - Groups with fewer than 2 members are dissolved (there is no point
//    clustering a single tab — it renders as a normal pinned chip).
// ---------------------------------------------------------------------------

/** A renderable pinned-strip item: a standalone pinned tab or a group chip. */
export type PinnedItem =
  | { kind: 'standalone'; path: string }
  | { kind: 'group'; members: string[] };

/** Result of a pinned-group mutation: the new flat pinned order + groups. */
export interface PinnedTabGroupsResult {
  pinnedTabPaths: string[];
  pinnedTabGroups: string[][];
}

/** Return the index of the group that contains `path`, or -1 when it is
 *  standalone (ungrouped). Any member path identifies its group. */
export function findPinnedGroupIndex(
  pinnedTabGroups: readonly string[][],
  path: string,
): number {
  for (let i = 0; i < pinnedTabGroups.length; i += 1) {
    if (pinnedTabGroups[i].includes(path)) {
      return i;
    }
  }
  return -1;
}

/** Derive the ordered list of pinned-strip items (standalone chips + group
 *  chips) from the flat `pinnedTabPaths` order and the group partition. Relies
 *  on the contiguity invariant: a group's first member (in `pinnedTabPaths`)
 *  emits the whole group chip and the remaining members are skipped. Stray
 *  non-first members (invariant violation) are skipped defensively. */
export function derivePinnedItems(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
): PinnedItem[] {
  const firstMemberToGroup = new Map<string, string[]>();
  const memberToGroup = new Map<string, string[]>();
  for (const group of pinnedTabGroups) {
    if (group.length === 0) continue;
    if (firstMemberToGroup.has(group[0])) continue; // dedupe: first group wins
    firstMemberToGroup.set(group[0], group);
    for (const member of group) {
      if (!memberToGroup.has(member)) memberToGroup.set(member, group);
    }
  }
  const items: PinnedItem[] = [];
  const consumed = new Set<string>();
  for (const path of pinnedTabPaths) {
    if (consumed.has(path)) continue;
    const group = firstMemberToGroup.get(path);
    if (group) {
      items.push({ kind: 'group', members: [...group] });
      for (const member of group) consumed.add(member);
    } else if (!memberToGroup.has(path)) {
      // Standalone (not a member of any group).
      items.push({ kind: 'standalone', path });
      consumed.add(path);
    }
    // A non-first group member encountered before its first member (invariant
    // violation) is skipped here; it will be reconciled by restore/clean.
  }
  return items;
}

/** Drop group members not in `validPaths`, dedupe across groups (first wins),
 *  and dissolve groups that fall below 2 members. Does NOT reorder
 *  `pinnedTabPaths` — used by close/evict/unpin where the caller already
 *  removed the path from `pinnedTabPaths` and only needs the groups cleaned. */
export function cleanPinnedTabGroups(
  pinnedTabGroups: readonly string[][],
  validPaths: readonly string[],
): string[][] {
  const validSet = new Set(validPaths);
  const seen = new Set<string>();
  const next: string[][] = [];
  for (const group of pinnedTabGroups) {
    const members: string[] = [];
    for (const member of group) {
      if (validSet.has(member) && !seen.has(member)) {
        seen.add(member);
        members.push(member);
      }
    }
    if (members.length >= 2) {
      next.push(members);
    }
  }
  return next;
}

/** Replace `oldPath` with `newPath` inside every group (dedupe). Mirrors the
 *  pending-path-replacement migration for `pinnedTabPaths`: a pinned pending
 *  tab can be a group member, so when the pending path resolves to the real
 *  session path the group entry must follow it. */
export function replacePathInPinnedTabGroups(
  pinnedTabGroups: readonly string[][],
  oldPath: string,
  newPath: string,
): string[][] {
  if (oldPath === newPath) return pinnedTabGroups.map((group) => [...group]);
  const next = pinnedTabGroups.map((group) =>
    group.map((member) => (member === oldPath ? newPath : member)),
  );
  // Dedupe within each group (oldPath + newPath could collapse to one entry)
  // and preserve the global invariant that groups dissolve below two members.
  return next
    .map((group) => [...new Set(group)])
    .filter((group) => group.length >= 2);
}

/** Normalize a stored `pinnedTabGroups` value (read back from globalState) into
 *  a clean `string[][]`. Accepts an array of arrays of strings, dropping
 *  non-array / non-string entries, pending paths, and empty groups. Does NOT
 *  dissolve <2 here (the caller reconciles against the restored pinned tabs,
 *  which drops invalid members and dissolves in one pass). */
export function normalizeStoredPinnedTabGroups(stored: unknown): string[][] {
  if (!Array.isArray(stored)) return [];
  const groups: string[][] = [];
  for (const entry of stored) {
    if (!Array.isArray(entry)) continue;
    const members: string[] = [];
    for (const member of entry) {
      if (
        typeof member === 'string'
        && member !== ''
        && !isPendingTabPath(member)
        && !members.includes(member)
      ) {
        members.push(member);
      }
    }
    if (members.length > 0) {
      groups.push(members);
    }
  }
  return groups;
}

/** Reconcile groups against a canonical `pinnedTabPaths`: drop members no
 *  longer pinned, dedupe, dissolve <2, and REORDER `pinnedTabPaths` so each
 *  surviving group's members are contiguous in group order (restoring the
 *  contiguity invariant). Standalone tabs keep their relative order; a group
 *  block is placed at the position of its first-encountered member. Used by
 *  startup restore (`OpenTabsChanged`). */
export function reconcilePinnedGroups(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
): PinnedTabGroupsResult {
  const pinnedSet = new Set(pinnedTabPaths);
  // Clean first (drop invalid members, dedupe, dissolve <2).
  const cleaned = cleanPinnedTabGroups(pinnedTabGroups, pinnedTabPaths);
  const memberToGroupIndex = new Map<string, number>();
  cleaned.forEach((group, index) => {
    for (const member of group) memberToGroupIndex.set(member, index);
  });
  const emitted = new Set<number>();
  const items: PinnedItem[] = [];
  for (const path of pinnedTabPaths) {
    const groupIndex = memberToGroupIndex.get(path);
    if (groupIndex === undefined) {
      // Standalone (includes dissolved-group members still in pinnedTabPaths).
      if (!pinnedSet.has(path)) continue;
      items.push({ kind: 'standalone', path });
    } else if (emitted.has(groupIndex)) {
      continue; // group already emitted as a block
    } else {
      items.push({ kind: 'group', members: [...cleaned[groupIndex]] });
      emitted.add(groupIndex);
    }
  }
  const nextPinned: string[] = [];
  for (const item of items) {
    if (item.kind === 'group') {
      nextPinned.push(...item.members);
    } else {
      nextPinned.push(item.path);
    }
  }
  return { pinnedTabPaths: nextPinned, pinnedTabGroups: cleaned };
}

/** Group a pinned tab with a target (Discord-style "drag onto"). `sourcePath`
 *  is the dragged pinned tab; `targetPath` is any member of the target group
 *  (or a standalone pinned tab to start a new group with). The source leaves
 *  its old group (which dissolves below 2) and joins the target's group —
 *  appended if the target is already grouped, or forming a new `[target,
 *  source]` pair if the target is standalone. `pinnedTabPaths` is reordered so
 *  the resulting group is contiguous. No-op when source === target or they are
 *  already in the same group. */
export function groupPinnedTab(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
  sourcePath: string,
  targetPath: string,
): PinnedTabGroupsResult {
  if (sourcePath === targetPath) {
    return { pinnedTabPaths: [...pinnedTabPaths], pinnedTabGroups: pinnedTabGroups.map((g) => [...g]) };
  }
  const sourceGroup = findPinnedGroupIndex(pinnedTabGroups, sourcePath);
  const targetGroup = findPinnedGroupIndex(pinnedTabGroups, targetPath);
  if (sourceGroup !== -1 && sourceGroup === targetGroup) {
    return { pinnedTabPaths: [...pinnedTabPaths], pinnedTabGroups: pinnedTabGroups.map((g) => [...g]) };
  }

  const nextGroups = pinnedTabGroups.map((g) => [...g]);
  // Remove the source from its old group; dissolve the old group below 2.
  if (sourceGroup !== -1) {
    const remaining = nextGroups[sourceGroup].filter((m) => m !== sourcePath);
    if (remaining.length >= 2) {
      nextGroups[sourceGroup] = remaining;
    } else {
      nextGroups.splice(sourceGroup, 1);
    }
  }
  // Append the source to the target group (or create a new pair).
  const targetIndex = findPinnedGroupIndex(nextGroups, targetPath);
  if (targetIndex !== -1) {
    nextGroups[targetIndex] = [...nextGroups[targetIndex], sourcePath];
  } else {
    nextGroups.push([targetPath, sourcePath]);
  }

  // Reorder pinnedTabPaths: lift the source out and drop it right after the
  // target group's last pre-existing member so the group stays contiguous.
  const withoutSource = pinnedTabPaths.filter((p) => p !== sourcePath);
  const anchorPath = targetIndex !== -1
    ? nextGroups[targetIndex].filter((m) => m !== sourcePath).at(-1)!
    : targetPath;
  const anchorIndex = withoutSource.indexOf(anchorPath);
  const insertAt = anchorIndex === -1 ? withoutSource.length : anchorIndex + 1;
  const nextPinned = [
    ...withoutSource.slice(0, insertAt),
    sourcePath,
    ...withoutSource.slice(insertAt),
  ];
  return { pinnedTabPaths: nextPinned, pinnedTabGroups: nextGroups };
}

/** Merge two groups (Discord-style "drag group chip onto group chip"). The
 *  target group's members come first, then the source group's members, forming
 *  a single group. The source group is removed and its members are reordered in
 *  `pinnedTabPaths` to sit immediately after the target group's last member
 *  (contiguous). `sourcePath` / `targetPath` are any member of their group.
 *  No-op when either path is ungrouped or both are in the same group. */
export function mergePinnedGroups(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
  sourcePath: string,
  targetPath: string,
): PinnedTabGroupsResult {
  const sourceGroupIndex = findPinnedGroupIndex(pinnedTabGroups, sourcePath);
  const targetGroupIndex = findPinnedGroupIndex(pinnedTabGroups, targetPath);
  if (sourceGroupIndex === -1 || targetGroupIndex === -1 || sourceGroupIndex === targetGroupIndex) {
    return { pinnedTabPaths: [...pinnedTabPaths], pinnedTabGroups: pinnedTabGroups.map((g) => [...g]) };
  }
  const sourceGroup = pinnedTabGroups[sourceGroupIndex];
  const targetGroup = pinnedTabGroups[targetGroupIndex];
  const merged = [...targetGroup, ...sourceGroup];

  const nextGroups = pinnedTabGroups
    .filter((_, i) => i !== sourceGroupIndex)
    .map((g) => [...g]);
  const newTargetIndex = findPinnedGroupIndex(nextGroups, targetPath);
  nextGroups[newTargetIndex] = merged;

  // Reorder: lift all source members out and drop them after the target
  // group's last member, preserving the merged (target-then-source) order.
  const sourceSet = new Set(sourceGroup);
  const withoutSource = pinnedTabPaths.filter((p) => !sourceSet.has(p));
  const anchorPath = targetGroup[targetGroup.length - 1];
  const anchorIndex = withoutSource.indexOf(anchorPath);
  const insertAt = anchorIndex === -1 ? withoutSource.length : anchorIndex + 1;
  const nextPinned = [
    ...withoutSource.slice(0, insertAt),
    ...sourceGroup,
    ...withoutSource.slice(insertAt),
  ];
  return { pinnedTabPaths: nextPinned, pinnedTabGroups: nextGroups };
}

/** Remove a pinned tab from its group and reposition it as a standalone pinned
 *  tab at `toItemIndex` (item-space, relative to the pinned strip AFTER the
 *  source is removed). The old group dissolves below 2. Used when a dropdown
 *  member is dragged to a pinned-strip gap.
 *
 *  Placement is by pinned ITEM-space (standalone chips + group chips, source
 *  removed), never flat `pinnedTabPaths` index: a surviving group is a single
 *  item whether or not the source was a member, so inserting the standalone
 *  source at a gap can never split a surviving group across the dropped tab. */
export function ungroupPinnedTab(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
  sourcePath: string,
  toItemIndex: number,
): PinnedTabGroupsResult {
  const sourceGroup = findPinnedGroupIndex(pinnedTabGroups, sourcePath);
  const nextGroups = pinnedTabGroups.map((g) => [...g]);
  if (sourceGroup !== -1) {
    const remaining = nextGroups[sourceGroup].filter((m) => m !== sourcePath);
    if (remaining.length >= 2) {
      nextGroups[sourceGroup] = remaining;
    } else {
      nextGroups.splice(sourceGroup, 1);
    }
  }
  // Derive items from the already-mutated groups: the source is no longer a
  // member, so the surviving group stays one contiguous item and the source
  // appears as a standalone. Drop the source item, then reinsert it at the
  // requested gap and rebuild the flat order from the item list.
  const items = derivePinnedItems(pinnedTabPaths, nextGroups);
  const withoutSource = items.filter((item) =>
    item.kind === 'group' ? !item.members.includes(sourcePath) : item.path !== sourcePath,
  );
  const clampedTo = Math.max(0, Math.min(toItemIndex, withoutSource.length));
  const reordered: PinnedItem[] = [
    ...withoutSource.slice(0, clampedTo),
    { kind: 'standalone', path: sourcePath },
    ...withoutSource.slice(clampedTo),
  ];
  const nextPinned: string[] = [];
  for (const item of reordered) {
    if (item.kind === 'group') {
      nextPinned.push(...item.members);
    } else {
      nextPinned.push(item.path);
    }
  }
  return { pinnedTabPaths: nextPinned, pinnedTabGroups: nextGroups };
}

/** Reorder a pinned item (standalone chip or group block) horizontally within
 *  the pinned strip. `sourcePath` is any member of the moved item (for a group
 *  chip, any member identifies it). `toItemIndex` is the target gap in item-
 *  space, relative to the pinned items AFTER the source item is removed. Group
 *  membership is unchanged — only the flat `pinnedTabPaths` order is rebuilt
 *  from the reordered item list (so a group block moves as a unit). */
export function movePinnedItem(
  pinnedTabPaths: readonly string[],
  pinnedTabGroups: readonly string[][],
  sourcePath: string,
  toItemIndex: number,
): PinnedTabGroupsResult {
  const items = derivePinnedItems(pinnedTabPaths, pinnedTabGroups);
  const sourceItemIndex = items.findIndex((item) =>
    item.kind === 'group' ? item.members.includes(sourcePath) : item.path === sourcePath,
  );
  if (sourceItemIndex === -1) {
    return { pinnedTabPaths: [...pinnedTabPaths], pinnedTabGroups: pinnedTabGroups.map((g) => [...g]) };
  }
  const sourceItem = items[sourceItemIndex];
  const withoutSource = items.filter((_, i) => i !== sourceItemIndex);
  const clampedTo = Math.max(0, Math.min(toItemIndex, withoutSource.length));
  const reordered = [
    ...withoutSource.slice(0, clampedTo),
    sourceItem,
    ...withoutSource.slice(clampedTo),
  ];
  const nextPinned: string[] = [];
  for (const item of reordered) {
    if (item.kind === 'group') {
      nextPinned.push(...item.members);
    } else {
      nextPinned.push(item.path);
    }
  }
  return { pinnedTabPaths: nextPinned, pinnedTabGroups: pinnedTabGroups.map((g) => [...g]) };
}