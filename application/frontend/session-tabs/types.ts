import type { RefObject } from 'preact';
import type { SessionTabRunAction } from './run-state';

export type SessionTabContextAction = SessionTabRunAction | 'duplicate' | 'close' | 'pin' | 'unpin' | 'pin-merge';

/** The kind of tab-strip target that opened a context menu. Group members use
 * the containing item's index so Remove from Group can preserve its former
 * group-chip position. */
export type SessionTabContextTarget =
  | { kind: 'tab' }
  | { kind: 'group-member'; groupItemIndex: number }
  | { kind: 'group'; members: string[] };

export interface SessionTabContextMenuState {
  x: number;
  y: number;
  /** For ordinary tabs and group members this is the session path. For a
   * group it is the first member, which is the host command identifier. */
  tabPath: string;
  target?: SessionTabContextTarget;
  triggerEl?: HTMLElement | null;
}

export type TabDragCandidate = {
  pointerId: number;
  sourceIndex: number;
  sourcePath: string;
  startX: number;
  startY: number;
  offsetX: number;
  tabWidth: number;
  tabHeight: number;
  tabTop: number;
  /** True when the drag started from a group chip (the source is a group,
   *  identified by any member path). Group-chip drags merge onto other groups
   *  and reorder as a block. */
  sourceIsGroupChip: boolean;
  /** True when the drag started from a group dropdown member. Gap-drops
   *  ungroup the member (instead of reordering a block). */
  sourceFromDropdown: boolean;
};

export type SessionTabDragState = {
  pointerId: number;
  sourceIndex: number;
  sourcePath: string;
  offsetX: number;
  tabWidth: number;
  tabHeight: number;
  tabTop: number;
  /** Gap index for a reorder drop (zone-specific: pinned-item-space for a
   *  pinned source, unpinned-gap-space for an unpinned source), or null when
   *  the pointer is outside the source's zone or centered on a pinned item
   *  (a group/merge drop instead). */
  dropIndex: number | null;
  /** The pinned item path the pointer is centered over (a group/merge drop),
   *  or null. For a group chip the identifier is its first member path. */
  dropOnPath: string | null;
  /** Whether `dropOnPath` is a group chip (vs a standalone pinned tab). */
  dropOnIsGroup: boolean;
  sourceIsGroupChip: boolean;
  sourceFromDropdown: boolean;
};

export interface UseTabDragAndDropOptions {
  openTabPaths: string[];
  /** Pinned tab paths (browser-style: clustered at the far left). Constrains
   *  drag-and-drop so a pinned tab can only be dropped within the pinned zone
   *  (and an unpinned tab only within the unpinned zone). */
  pinnedTabPaths: string[];
  /** Pinned-session groups (Discord-style clustering). Drives group/merge
   *  drop semantics and pinned-item-space reorder indices. */
  pinnedTabGroups: string[][];
  onMove: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  /** Reorder a pinned item (standalone chip or group block) within the pinned
   *  strip. `toItemIndex` is in pinned-item-space (source-removed). */
  onMovePinnedItem: (sourcePath: string, toItemIndex: number) => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onDuplicate: (path: string) => void;
  onTogglePin: (tabPath: string) => void;
  /** Pin an unpinned tab and merge it into the leftmost pinned item. */
  onPinAndMerge: (tabPath: string) => void;
  /** Group a pinned tab with a target (Discord-style "drag onto"). */
  onGroupPinnedTab: (sourcePath: string, targetPath: string) => void;
  /** Merge two pinned groups (group chip onto group chip). */
  onMergePinnedGroups: (sourcePath: string, targetPath: string) => void;
  /** Remove a pinned tab from its group and reposition it standalone. */
  onUngroupPinnedTab: (sourcePath: string, toItemIndex: number) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
  stripRef: RefObject<HTMLDivElement>;
}

export interface UseTabDragAndDropResult {
  dragState: SessionTabDragState | null;
  tabContextMenu: SessionTabContextMenuState | null;
  setTabContextMenu: (v: SessionTabContextMenuState | null) => void;
  closeContextMenu: () => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onPinnedItemPointerDown: (event: PointerEvent, sourcePath: string, sourceIsGroupChip: boolean, sourceFromDropdown: boolean, itemIndex: number) => void;
  onClick: (tabPath: string) => void;
  onContextMenu: (event: MouseEvent, tabPath: string, target?: SessionTabContextTarget, triggerEl?: HTMLElement | null) => void;
  onContextAction: (action: SessionTabContextAction, tabPath: string) => void;
  autoScrollTickRef: RefObject<() => void>;
  dragCandidateRef: RefObject<TabDragCandidate | null>;
  dragStateRef: RefObject<SessionTabDragState | null>;
  ghostElementRef: RefObject<HTMLDivElement>;
}