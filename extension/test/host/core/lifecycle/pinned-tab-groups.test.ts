import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { SessionSummary } from '../../../../src/shared/protocol';

function summary(path: string, name = path.slice(1)): SessionSummary {
  return { path, name, cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
}

function stateWith(opts: {
  openTabPaths: string[];
  pinnedTabPaths?: string[];
  pinnedTabGroups?: string[][];
  activeSessionPath?: string | null;
  sessions?: SessionSummary[];
}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: opts.sessions ?? opts.openTabPaths.map((p) => summary(p)),
      openTabPaths: opts.openTabPaths,
      pinnedTabPaths: opts.pinnedTabPaths ?? [],
      pinnedTabGroups: opts.pinnedTabGroups ?? [],
      activeSessionPath: opts.activeSessionPath ?? opts.openTabPaths[0] ?? null,
    },
  };
}

function persistEffect(result: { effects: unknown[] }) {
  return (result.effects as Array<{ kind: string; pinnedTabGroups: string[][]; pinnedTabPaths: string[]; openTabPaths: string[] }>)
    .find((e) => e.kind === 'PersistTabs');
}

// ─── GroupPinnedTab ────────────────────────────────────────────────────────

test('GroupPinnedTab creates a new [target, source] pair from two standalone pinned tabs', () => {
  const state = stateWith({ openTabPaths: ['/a', '/b', '/c'], pinnedTabPaths: ['/a', '/b', '/c'] });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'GroupPinnedTab', corrId: 'g1', sourcePath: '/b', targetPath: '/a' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b']]);
  // The group is contiguous: /a, /b stay at the front; /c follows.
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/b', '/c']);
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/b', '/c']);
  const persist = persistEffect(result);
  assert.ok(persist);
  assert.deepEqual(persist.pinnedTabGroups, [['/a', '/b']]);
});

test('GroupPinnedTab appends a standalone tab to an existing group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'GroupPinnedTab', corrId: 'g2', sourcePath: '/d', targetPath: '/a' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b', '/d']]);
  // /d moves to sit right after /b (contiguous with the group).
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/b', '/d', '/c']);
});

test('GroupPinnedTab moves a member between groups and dissolves the old group below 2', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'GroupPinnedTab', corrId: 'g3', sourcePath: '/a', targetPath: '/c' },
  });
  // /a joins [/c, /d] → [/c, /d, /a]; [/b] dissolves to standalone.
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/c', '/d', '/a']]);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b', '/c', '/d', '/a']);
});

test('GroupPinnedTab is a no-op when source and target are already in the same group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'GroupPinnedTab', corrId: 'g4', sourcePath: '/a', targetPath: '/b' },
  });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test('GroupPinnedTab is a no-op when the source is not pinned', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a'],
    pinnedTabGroups: [],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'GroupPinnedTab', corrId: 'g5', sourcePath: '/b', targetPath: '/a' },
  });
  assert.equal(result.state, state);
});

// ─── MergePinnedGroups ─────────────────────────────────────────────────────

test('MergePinnedGroups merges target-then-source into one contiguous group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MergePinnedGroups', corrId: 'm1', sourcePath: '/c', targetPath: '/a' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b', '/c', '/d']]);
  // Source members move after the target group's last member.
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/b', '/c', '/d']);
});

test('MergePinnedGroups is a no-op when both paths are in the same group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MergePinnedGroups', corrId: 'm2', sourcePath: '/a', targetPath: '/b' },
  });
  assert.equal(result.state, state);
});

test('MergePinnedGroups is a no-op when the target is not a group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MergePinnedGroups', corrId: 'm3', sourcePath: '/a', targetPath: '/c' },
  });
  assert.equal(result.state, state);
});

// ─── UngroupPinnedTab ──────────────────────────────────────────────────────

test('UngroupPinnedTab removes a member, dissolves the old group below 2, and repositions it', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'UngroupPinnedTab', corrId: 'u1', sourcePath: '/a', toItemIndex: 1 },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, []);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b', '/a', '/c']);
});

test('UngroupPinnedTab leaves a 3-group intact as a 2-group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b', '/c']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'UngroupPinnedTab', corrId: 'u2', sourcePath: '/b', toItemIndex: 0 },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/c']]);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b', '/a', '/c', '/d']);
});

// ─── Whole-group context-menu commands ─────────────────────────────────────

test('DissolvePinnedGroup removes the group but preserves pinned members and flat order', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/x', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/x', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'DissolvePinnedGroup', corrId: 'dg1', sourcePath: '/b' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/b', '/x', '/c', '/d']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/c', '/d']]);
  assert.deepEqual(persistEffect(result)?.pinnedTabPaths, ['/a', '/b', '/x', '/c', '/d']);
});

test('DissolvePinnedGroup is a no-op for a standalone source', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'DissolvePinnedGroup', corrId: 'dg2', sourcePath: '/a' },
  });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test('UnpinPinnedGroup removes all group members from pins while leaving sessions open', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/x', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'UnpinPinnedGroup', corrId: 'ug1', sourcePath: '/a' },
  });
  assert.deepEqual(result.state.sessions.openTabPaths, ['/c', '/d', '/a', '/b', '/x']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/c', '/d']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/c', '/d']]);
  assert.deepEqual(persistEffect(result)?.pinnedTabGroups, [['/c', '/d']]);
});

test('UnpinPinnedGroup is a no-op for a standalone source', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'UnpinPinnedGroup', corrId: 'ug2', sourcePath: '/a' },
  });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

// ─── MovePinnedItem ────────────────────────────────────────────────────────

test('MovePinnedItem reorders a standalone chip before a group without changing groups', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MovePinnedItem', corrId: 'mv1', sourcePath: '/c', toItemIndex: 0 },
  });
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/c', '/a', '/b', '/d']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b']]);
});

test('MovePinnedItem moves a group block as a unit', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d', '/e'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d', '/e'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MovePinnedItem', corrId: 'mv2', sourcePath: '/c', toItemIndex: 0 },
  });
  // The [/c, /d] group moves before the [/a, /b] group.
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/c', '/d', '/a', '/b', '/e']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b'], ['/c', '/d']]);
});

// ─── TogglePinTab cleans groups on unpin ───────────────────────────────────

test('TogglePinTab unpinning a group member cleans the group (and dissolves below 2)', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
    activeSessionPath: '/c',
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'tp1', sessionPath: '/a' },
  });
  // /a unpins → leaves the group; [/b] dissolves to standalone.
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b', '/c']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, []);
});

test('TogglePinTab unpinning one member of a 3-group leaves a 2-group', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b', '/c']],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'tp2', sessionPath: '/b' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/c']]);
});

// ─── CloseSession cleans groups ────────────────────────────────────────────

test('CloseSession removes the closed group member and dissolves the group below 2', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
    activeSessionPath: '/a',
    sessions: [summary('/a'), summary('/b'), summary('/c')],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'CloseSession', corrId: 'c1', sessionPath: '/a' },
  });
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b', '/c']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, []);
  const persist = persistEffect(result);
  assert.ok(persist);
  assert.deepEqual(persist.pinnedTabGroups, []);
});

// ─── OpenTabsChanged reconciles groups on restore ──────────────────────────

test('OpenTabsChanged reconciles groups: drops invalid members, dissolves <2, restores contiguity', () => {
  const state = stateWith({ openTabPaths: ['/stale'], pinnedTabPaths: [], pinnedTabGroups: [] });
  const result = reducer(state, {
    kind: 'OpenTabsChanged',
    openTabPaths: ['/a', '/b', '/c', '/x'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    // /gone is not restored; [/a, /b, /gone] → [/a, /b]; [/c] is <2 → dissolved.
    pinnedTabGroups: [['/a', '/b', '/gone'], ['/c']],
  });
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/b', '/c']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b']]);
  // Pinned-first ordering: [/a, /b, /c] then unpinned /x.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/b', '/c', '/x']);
});

test('OpenTabsChanged with a 3-member group reorders it contiguous', () => {
  const state = stateWith({ openTabPaths: ['/stale'], pinnedTabPaths: [], pinnedTabGroups: [] });
  const result = reducer(state, {
    kind: 'OpenTabsChanged',
    openTabPaths: ['/a', '/c', '/x', '/b'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b', '/c']],
  });
  // Group members become contiguous in group order: /a, /b, /c then /x.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/b', '/c', '/x']);
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/a', '/b', '/c']]);
});

// ─── PendingPathReplaced migrates group members ────────────────────────────

test('PendingPathReplaced migrates group membership when a pinned pending member resolves', () => {
  // A pinned pending tab that is a group member resolves to the real path.
  const pending = '__pending__:1';
  const state = stateWith({
    openTabPaths: [pending, '/b'],
    pinnedTabPaths: [pending, '/b'],
    pinnedTabGroups: [[pending, '/b']],
    sessions: [{ path: pending, name: 'P', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0, isPlaceholder: true }, summary('/b')],
  });
  const result = reducer(state, {
    kind: 'PendingPathReplaced',
    oldPendingPath: pending,
    newSessionPath: '/real',
  });
  assert.deepEqual(result.state.sessions.pinnedTabGroups, [['/real', '/b']]);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/real', '/b']);
});
