import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';
import { removeFromArray } from './helpers.js';
import {
  pinTab,
  unpinTab,
  cleanPinnedTabGroups,
  groupPinnedTab,
  mergePinnedGroups,
  ungroupPinnedTab,
  dissolvePinnedGroup,
  unpinPinnedGroup,
  movePinnedItem,
  findPinnedGroupIndex,
  isPendingTabPath,
  pinAndMergeToFirstPinned,
} from '../../../shared/tab-behavior.js';

/** Build a `PersistTabs` effect carrying the full sessions tab slice
 *  (open / active / pinned / groups). Centralized so every group mutation
 *  persists the new `pinnedTabGroups` alongside the pinned paths. */
function persistTabsEffect(corrId: string, state: ArchState) {
  return {
    kind: 'PersistTabs' as const,
    corrId,
    openTabPaths: state.sessions.openTabPaths,
    activeSessionPath: state.sessions.activeSessionPath,
    pinnedTabPaths: state.sessions.pinnedTabPaths,
    pinnedTabGroups: state.sessions.pinnedTabGroups,
  };
}

/** Reducer result for a pinned-tab/group mutation: apply the given next tab
 *  fields to `state.sessions` and emit a `PersistTabs` effect carrying the
 *  resulting full tab slice. */
function pinnedMutationResult(
  corrId: string,
  state: ArchState,
  nextTabs: Partial<Pick<ArchState['sessions'], 'openTabPaths' | 'pinnedTabPaths' | 'pinnedTabGroups'>>,
): ReducerResult {
  const nextState = {
    ...state,
    sessions: { ...state.sessions, ...nextTabs },
  };
  return { state: nextState, effects: [persistTabsEffect(corrId, nextState)] };
}

export function handleCloseTab(state: ArchState, cmd: Extract<Command, { kind: 'CloseTab' }>): ReducerResult {
  // Closing a tab also unpins it — a pinned tab cannot outlive its open tab
  // (the pinned ⊆ openTabPaths invariant). Group membership is cleaned too:
  // the closed path is dropped from any group (which may dissolve below 2).
  // No PersistTabs effect here: the CloseTab Command is only dispatched
  // directly by handleSelectionFailure (which emits its own PersistTabs) —
  // normal close flows through the CloseSession Command, whose handler emits
  // PersistTabs.
  const nextOpenTabPaths = removeFromArray(state.sessions.openTabPaths, cmd.sessionPath);
  const nextPinnedTabPaths = removeFromArray(state.sessions.pinnedTabPaths, cmd.sessionPath);
  return {
    state: {
      ...state,
      sessions: {
        ...state.sessions,
        openTabPaths: nextOpenTabPaths,
        pinnedTabPaths: nextPinnedTabPaths,
        pinnedTabGroups: cleanPinnedTabGroups(state.sessions.pinnedTabGroups, nextPinnedTabPaths),
        unreadFinishedSessionPaths: removeFromArray(
          state.sessions.unreadFinishedSessionPaths,
          cmd.sessionPath,
        ),
      },
    },
    effects: [],
  };
}

export function handlePersistTabs(state: ArchState, cmd: Extract<Command, { kind: 'PersistTabs' }>): ReducerResult {
  return {
    state,
    effects: [
      {
        kind: 'PersistTabs',
        corrId: cmd.corrId,
        openTabPaths: cmd.openTabPaths,
        activeSessionPath: cmd.activeSessionPath,
        pinnedTabPaths: cmd.pinnedTabPaths,
        pinnedTabGroups: cmd.pinnedTabGroups,
      },
    ],
  };
}

/** Toggle a tab's pinned state (browser-style). The reducer owns the reorder
 *  that keeps pinned tabs as the leading prefix of `openTabPaths` and emits a
 *  PersistTabs effect so the runner writes globalState. No backend RPC.
 *  Unpinning also cleans group membership (the unpinned tab leaves any group,
 *  which may dissolve below 2). */
export function handleTogglePinTab(state: ArchState, cmd: Extract<Command, { kind: 'TogglePinTab' }>): ReducerResult {
  const { sessionPath } = cmd;
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  // Only open, real, non-pending tabs can be pinned. A pending placeholder (a
  // backend `session.create` still in flight, registered in `openTabPaths`)
  // has no durable session to pin — it is a no-op (the webview disables the
  // menu item for pending tabs; this guard mirrors `handleSend`'s own guard).
  // A tab that is no longer open is likewise a no-op.
  if (isPendingTabPath(sessionPath) || !openTabPaths.includes(sessionPath)) {
    return { state, effects: [] };
  }
  const isPinned = pinnedTabPaths.includes(sessionPath);
  const next = isPinned
    ? unpinTab(openTabPaths, pinnedTabPaths, sessionPath)
    : pinTab(openTabPaths, pinnedTabPaths, sessionPath);
  // Unpinning removes the tab from the pinned set, so drop it from any group
  // (a freshly pinned tab is never in a group — groups only hold pinned paths).
  const nextPinnedTabGroups = isPinned
    ? cleanPinnedTabGroups(pinnedTabGroups, next.pinnedTabPaths)
    : pinnedTabGroups;
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: next.openTabPaths,
    pinnedTabPaths: next.pinnedTabPaths,
    pinnedTabGroups: nextPinnedTabGroups,
  });
}

/** Pin an unpinned tab and merge it into the leftmost pinned-strip item
 *  ("Pin and Merge" context-menu item): the leftmost standalone pinned tab
 *  starts a group with it; the leftmost group absorbs it. Pure state mutation
 *  + PersistTabs effect. No-op if the tab is pending, not open, or already
 *  pinned. */
export function handlePinAndMergePinnedTab(state: ArchState, cmd: Extract<Command, { kind: 'PinAndMergePinnedTab' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (isPendingTabPath(cmd.sessionPath) || !openTabPaths.includes(cmd.sessionPath) || pinnedTabPaths.includes(cmd.sessionPath)) {
    return { state, effects: [] };
  }
  const result = pinAndMergeToFirstPinned(openTabPaths, pinnedTabPaths, pinnedTabGroups, cmd.sessionPath);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Group a pinned tab with a target (Discord-style "drag onto"). Pure state
 *  mutation + PersistTabs effect. No-op if the source is not pinned (only
 *  pinned tabs can be grouped). */
export function handleGroupPinnedTab(state: ArchState, cmd: Extract<Command, { kind: 'GroupPinnedTab' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath) || !pinnedTabPaths.includes(cmd.targetPath)) {
    return { state, effects: [] };
  }
  // No-op when the source is dropped on itself or onto a tab already in its
  // group — return the same state reference (no persistence churn).
  const sourceGroup = findPinnedGroupIndex(pinnedTabGroups, cmd.sourcePath);
  const targetGroup = findPinnedGroupIndex(pinnedTabGroups, cmd.targetPath);
  if (cmd.sourcePath === cmd.targetPath || (sourceGroup !== -1 && sourceGroup === targetGroup)) {
    return { state, effects: [] };
  }
  const result = groupPinnedTab(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath, cmd.targetPath);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Merge two pinned groups (Discord-style "drag group chip onto group chip").
 *  Pure state mutation + PersistTabs effect. No-op if either path is not a
 *  pinned group member or both are in the same group. */
export function handleMergePinnedGroups(state: ArchState, cmd: Extract<Command, { kind: 'MergePinnedGroups' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath) || !pinnedTabPaths.includes(cmd.targetPath)) {
    return { state, effects: [] };
  }
  // No-op when either path is ungrouped or both are in the same group.
  const sourceGroup = findPinnedGroupIndex(pinnedTabGroups, cmd.sourcePath);
  const targetGroup = findPinnedGroupIndex(pinnedTabGroups, cmd.targetPath);
  if (sourceGroup === -1 || targetGroup === -1 || sourceGroup === targetGroup) {
    return { state, effects: [] };
  }
  const result = mergePinnedGroups(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath, cmd.targetPath);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Remove a pinned tab from its group and reposition it as a standalone pinned
 *  tab at `toItemIndex`. Pure state mutation + PersistTabs effect. No-op if the
 *  source is not pinned. */
export function handleUngroupPinnedTab(state: ArchState, cmd: Extract<Command, { kind: 'UngroupPinnedTab' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath)) {
    return { state, effects: [] };
  }
  const result = ungroupPinnedTab(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath, cmd.toItemIndex);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Dissolve exactly one pinned group while preserving its members' pinned state
 * and flat order. Pure state mutation + PersistTabs effect. */
export function handleDissolvePinnedGroup(state: ArchState, cmd: Extract<Command, { kind: 'DissolvePinnedGroup' }>): ReducerResult {
  const { pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath) || findPinnedGroupIndex(pinnedTabGroups, cmd.sourcePath) === -1) {
    return { state, effects: [] };
  }
  const result = dissolvePinnedGroup(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath);
  return pinnedMutationResult(cmd.corrId, state, {
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Unpin exactly one whole pinned group while leaving every member session
 * open. Pure state mutation + PersistTabs effect. */
export function handleUnpinPinnedGroup(state: ArchState, cmd: Extract<Command, { kind: 'UnpinPinnedGroup' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath) || findPinnedGroupIndex(pinnedTabGroups, cmd.sourcePath) === -1) {
    return { state, effects: [] };
  }
  const result = unpinPinnedGroup(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Reorder a pinned item (standalone chip or group block) horizontally. Pure
 *  state mutation + PersistTabs effect. No-op if the source is not pinned. */
export function handleMovePinnedItem(state: ArchState, cmd: Extract<Command, { kind: 'MovePinnedItem' }>): ReducerResult {
  const { openTabPaths, pinnedTabPaths, pinnedTabGroups } = state.sessions;
  if (!pinnedTabPaths.includes(cmd.sourcePath)) {
    return { state, effects: [] };
  }
  const result = movePinnedItem(pinnedTabPaths, pinnedTabGroups, cmd.sourcePath, cmd.toItemIndex);
  return pinnedMutationResult(cmd.corrId, state, {
    openTabPaths: reorderPinnedPrefix(openTabPaths, result.pinnedTabPaths),
    pinnedTabPaths: result.pinnedTabPaths,
    pinnedTabGroups: result.pinnedTabGroups,
  });
}

/** Reorder the pinned prefix of `openTabPaths` to match a mutated
 *  `pinnedTabPaths` order, leaving the unpinned suffix untouched. Group
 *  mutations only reorder pinned tabs (within the pinned prefix), so the
 *  unpinned region is preserved as-is. */
function reorderPinnedPrefix(openTabPaths: readonly string[], nextPinnedTabPaths: readonly string[]): string[] {
  const pinnedSet = new Set(nextPinnedTabPaths);
  const unpinned = openTabPaths.filter((p) => !pinnedSet.has(p));
  return [...nextPinnedTabPaths, ...unpinned];
}
