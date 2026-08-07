import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHorizontalDropIndex,
  getNextVisibleTabPathOnClose,
  getVisibleTabPaths,
  insertTabRespectingPinnedPrefix,
  isPendingTabPath,
  moveOpenTabPath,
  normalizeStoredTabPaths,
  pinTab,
  reorderOpenTabsPinnedFirst,
  unpinTab,
  findPinnedGroupIndex,
  derivePinnedItems,
  cleanPinnedTabGroups,
  replacePathInPinnedTabGroups,
  normalizeStoredPinnedTabGroups,
  reconcilePinnedGroups,
  groupPinnedTab,
  mergePinnedGroups,
  ungroupPinnedTab,
  movePinnedItem,
} from '../../../src/shared/tab-behavior';

const sessions = [
  {
    path: '/workspace/a',
    name: 'A',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 1,
  },
  {
    path: '/workspace/b',
    name: 'B',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 2,
  },
  {
    path: '/workspace/c',
    name: 'C',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 3,
  },
  {
    path: '/other/x',
    name: 'X',
    cwd: '/other',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 4,
  },
];

test('getVisibleTabPaths follows open tab order without PI session-list filtering', () => {
  const visiblePaths = getVisibleTabPaths({
    openTabPaths: ['/workspace/a', '/other/x', '__pending__:1', '/workspace/c', '/workspace/missing'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
  });

  assert.deepEqual(visiblePaths, ['/workspace/a', '/other/x', '__pending__:1', '/workspace/c', '/workspace/missing']);
});

test('getVisibleTabPaths keeps the active workspace tab visible before the session list catches up', () => {
  const visiblePaths = getVisibleTabPaths({
    openTabPaths: ['/workspace/a', '/workspace/b'],
    sessions: [sessions[0]],
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
  });

  assert.deepEqual(visiblePaths, ['/workspace/a', '/workspace/b']);
});

test('closing an active tab prefers the tab on the right', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/workspace/b', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
    closingPath: '/workspace/b',
  });

  assert.equal(nextPath, '/workspace/c');
});

test('closing the last visible tab falls back to the tab on the left', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/workspace/b', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[2].path,
    closingPath: '/workspace/c',
  });

  assert.equal(nextPath, '/workspace/b');
});

test('closing a visible cross-workspace tab follows open tab order', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/other/x', '/workspace/b'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[3].path,
    closingPath: '/other/x',
  });

  assert.equal(nextPath, '/workspace/b');
});

test('closing a visible tab can select an adjacent pending tab', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '__pending__:1', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[0].path,
    closingPath: '/workspace/a',
  });

  assert.equal(nextPath, '__pending__:1');
});

test('closing the only visible tab returns null', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[0].path,
    closingPath: '/workspace/a',
  });

  assert.equal(nextPath, null);
});

test('pending-tab detection survives SDK path normalization', () => {
  assert.equal(isPendingTabPath('__pending__:1-abc'), true);
  assert.equal(isPendingTabPath('/workspace/__pending__:1-abc'), true);
  assert.equal(isPendingTabPath('C:\\workspace\\__pending__:1-abc'), true);
  assert.equal(isPendingTabPath('/workspace/session.jsonl'), false);
  assert.equal(isPendingTabPath('/workspace/not__pending__:1-abc'), false);
});

test('normalizeStoredTabPaths removes transient and duplicate tabs', () => {
  const paths = normalizeStoredTabPaths([
    '/workspace/a',
    '__pending__:1',
    'C:\\workspace\\__pending__:2',
    '/workspace/__pending__:3',
    '/workspace/a',
    '',
    null,
    '/workspace/b',
  ]);

  assert.deepEqual(paths, ['/workspace/a', '/workspace/b']);
});

test('normalizeStoredTabPaths accepts {path, name} objects alongside strings', () => {
  const paths = normalizeStoredTabPaths([
    '/workspace/a',
    { path: '/workspace/b', name: 'My Session' },
    '__pending__:1',
    '/workspace/a', // duplicate
    { path: '/workspace/c' }, // no name — still a valid path entry
  ]);

  assert.deepEqual(paths, ['/workspace/a', '/workspace/b', '/workspace/c']);
});

test('moveOpenTabPath reorders a tab to the front', () => {
  const nextPaths = moveOpenTabPath(['/workspace/a', '/workspace/b', '/workspace/c'], {
    sessionPath: '/workspace/c',
    fromIndex: 2,
    toIndex: 0,
  });

  assert.deepEqual(nextPaths, ['/workspace/c', '/workspace/a', '/workspace/b']);
});

test('moveOpenTabPath falls back to the drag source index when the tab path changed mid-drag', () => {
  const nextPaths = moveOpenTabPath(['/workspace/a', '/workspace/resolved', '/workspace/c'], {
    sessionPath: '__pending__:1',
    fromIndex: 1,
    toIndex: 0,
  });

  assert.deepEqual(nextPaths, ['/workspace/resolved', '/workspace/a', '/workspace/c']);
});

test('getHorizontalDropIndex returns the boundary between tab midpoints', () => {
  const rects = [
    { left: 0, right: 100 },
    { left: 110, right: 210 },
    { left: 220, right: 320 },
  ];

  assert.equal(getHorizontalDropIndex(rects, -10), 0);
  assert.equal(getHorizontalDropIndex(rects, 40), 0);
  assert.equal(getHorizontalDropIndex(rects, 160), 1);
  assert.equal(getHorizontalDropIndex(rects, 260), 2);
  assert.equal(getHorizontalDropIndex(rects, 400), 3);
});

// ─── Pinned-tab ordering (browser-style: pinned tabs cluster at the left) ────

test('pinTab moves a tab to the front of the pinned prefix and records it as pinned', () => {
  // No pinned tabs yet — pinning /b moves it to the head of the strip (the
  // pinned area lives at the far left, like a browser).
  const result = pinTab(['/a', '/b', '/c'], [], '/b');
  assert.deepEqual(result.openTabPaths, ['/b', '/a', '/c']);
  assert.deepEqual(result.pinnedTabPaths, ['/b']);
});

test('pinTab moves an unpinned tab from the end into the pinned prefix', () => {
  // /a is already pinned (prefix); pinning /c moves it to the tail of the pinned group.
  const result = pinTab(['/a', '/b', '/c'], ['/a'], '/c');
  assert.deepEqual(result.openTabPaths, ['/a', '/c', '/b']);
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/c']);
});

test('pinTab is idempotent for an already-pinned tab', () => {
  const result = pinTab(['/a', '/b'], ['/a'], '/a');
  assert.deepEqual(result.openTabPaths, ['/a', '/b']);
  assert.deepEqual(result.pinnedTabPaths, ['/a']);
});

test('unpinTab moves a pinned tab to the start of the unpinned region', () => {
  const result = unpinTab(['/a', '/b', '/c'], ['/a', '/b'], '/a');
  // /a leaves the pinned prefix and lands right after the remaining pinned tab (/b).
  assert.deepEqual(result.openTabPaths, ['/b', '/a', '/c']);
  assert.deepEqual(result.pinnedTabPaths, ['/b']);
});

test('unpinTab is idempotent for a tab that is not pinned', () => {
  const result = unpinTab(['/a', '/b'], [], '/a');
  assert.deepEqual(result.openTabPaths, ['/a', '/b']);
  assert.deepEqual(result.pinnedTabPaths, []);
});

test('insertTabRespectingPinnedPrefix appends unpinned tabs at the end', () => {
  assert.deepEqual(insertTabRespectingPinnedPrefix(['/a', '/b'], ['/a'], '/c'), ['/a', '/b', '/c']);
});

test('insertTabRespectingPinnedPrefix reopens a pinned tab inside the pinned prefix', () => {
  // /b is pinned but not currently open — reopening lands it at its pinned position.
  assert.deepEqual(insertTabRespectingPinnedPrefix(['/a'], ['/a', '/b'], '/b'), ['/a', '/b']);
});

test('insertTabRespectingPinnedPrefix is a no-op for an already-open tab', () => {
  assert.deepEqual(insertTabRespectingPinnedPrefix(['/a', '/b'], [], '/a'), ['/a', '/b']);
});

test('reorderOpenTabsPinnedFirst puts pinned tabs first and drops pinned paths no longer open', () => {
  const result = reorderOpenTabsPinnedFirst(['/b', '/a', '/c', '/d'], ['/a', '/x']);
  // /a (pinned) moves to the front; /x (pinned but not open) is dropped from both arrays.
  assert.deepEqual(result.openTabPaths, ['/a', '/b', '/c', '/d']);
  assert.deepEqual(result.pinnedTabPaths, ['/a']);
});

test('reorderOpenTabsPinnedFirst is a no-op when nothing is pinned', () => {
  const result = reorderOpenTabsPinnedFirst(['/a', '/b'], []);
  assert.deepEqual(result.openTabPaths, ['/a', '/b']);
  assert.deepEqual(result.pinnedTabPaths, []);
});

// ─── Pinned-session groups (Discord-style clustering) ───────────────────────

test('findPinnedGroupIndex returns the group index for any member, -1 for standalone', () => {
  const groups = [['/a', '/b'], ['/c', '/d', '/e']];
  assert.equal(findPinnedGroupIndex(groups, '/a'), 0);
  assert.equal(findPinnedGroupIndex(groups, '/b'), 0);
  assert.equal(findPinnedGroupIndex(groups, '/e'), 1);
  assert.equal(findPinnedGroupIndex(groups, '/z'), -1);
});

test('derivePinnedItems emits standalone chips and contiguous group chips in pinned order', () => {
  // pinnedTabPaths: [g0members..., standalone, g1members...]
  const items = derivePinnedItems(['/a', '/b', '/x', '/c', '/d'], [['/a', '/b'], ['/c', '/d']]);
  assert.deepEqual(items, [
    { kind: 'group', members: ['/a', '/b'] },
    { kind: 'standalone', path: '/x' },
    { kind: 'group', members: ['/c', '/d'] },
  ]);
});

test('derivePinnedItems treats an ungrouped pinned tab as standalone', () => {
  const items = derivePinnedItems(['/a', '/b', '/c'], [['/a', '/b']]);
  assert.deepEqual(items, [
    { kind: 'group', members: ['/a', '/b'] },
    { kind: 'standalone', path: '/c' },
  ]);
});

test('cleanPinnedTabGroups drops members no longer valid, dedupes, and dissolves <2', () => {
  const groups = [['/a', '/b', '/gone'], ['/c', '/d'], ['/e']];
  const cleaned = cleanPinnedTabGroups(groups, ['/a', '/b', '/c', '/d', '/e']);
  assert.deepEqual(cleaned, [['/a', '/b'], ['/c', '/d']]);
});

test('cleanPinnedTabGroups keeps the first group when a path appears in two groups', () => {
  const groups = [['/a', '/b'], ['/b', '/c']];
  const cleaned = cleanPinnedTabGroups(groups, ['/a', '/b', '/c']);
  assert.deepEqual(cleaned, [['/a', '/b']]); // /b already seen → second group dissolves to [/c] → dropped
});

test('replacePathInPinnedTabGroups migrates a member path and dedupes', () => {
  const groups = [['/pending:1', '/b'], ['/c', '/pending:1']];
  const next = replacePathInPinnedTabGroups(groups, '/pending:1', '/real');
  assert.deepEqual(next, [['/real', '/b'], ['/c', '/real']]);
  // Dedupe when old + new collapse (both become /real in one group).
  const collapsed = replacePathInPinnedTabGroups([['/a', '/b']], '/a', '/b');
  assert.deepEqual(collapsed, [], 'a deduped one-member group dissolves');
});

test('normalizeStoredPinnedTabGroups accepts nested string arrays and drops junk', () => {
  const groups = normalizeStoredPinnedTabGroups([
    ['/a', '/b'],
    ['__pending__:1', '/c'], // pending dropped
    [''],
    [123, '/d'], // non-string dropped
    '/e', // not an array
    ['/f', '/f'], // dup within group collapses
    [], // empty dropped
  ]);
  assert.deepEqual(groups, [['/a', '/b'], ['/c'], ['/d'], ['/f']]);
});

test('normalizeStoredPinnedTabGroups returns [] for non-array input', () => {
  assert.deepEqual(normalizeStoredPinnedTabGroups(undefined), []);
  assert.deepEqual(normalizeStoredPinnedTabGroups('nope'), []);
  assert.deepEqual(normalizeStoredPinnedTabGroups(null), []);
});

test('reconcilePinnedGroups drops invalid members, dissolves <2, and makes groups contiguous', () => {
  // /gone is a member but not open; /c,/d,/e is non-contiguous; [/f] is <2.
  const result = reconcilePinnedGroups(
    ['/a', '/b', '/c', '/x', '/d', '/e', '/f'],
    [['/a', '/b', '/gone'], ['/c', '/d', '/e'], ['/f']],
  );
  // /gone dropped → [/a,/b]; [/c,/d,/e] reordered contiguous; [/f] dissolved.
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/c', '/d', '/e', '/x', '/f']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b'], ['/c', '/d', '/e']]);
});

test('groupPinnedTab creates a new [target, source] pair from two standalone pinned tabs', () => {
  const result = groupPinnedTab(['/a', '/b', '/c'], [], '/b', '/a');
  // /b joins /a → group [/a, /b], contiguous at /a's position.
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/c']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b']]);
});

test('groupPinnedTab appends a standalone tab to an existing group and keeps it contiguous', () => {
  const result = groupPinnedTab(['/a', '/b', '/c', '/d'], [['/a', '/b']], '/d', '/a');
  // /d appends to the group → [/a, /b, /d], contiguous after /b.
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/d', '/c']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b', '/d']]);
});

test('groupPinnedTab moves a member from one group to another and dissolves the old group below 2', () => {
  // Source group [/a, /b] (size 2) → removing /a leaves [/b] (dissolves).
  const result = groupPinnedTab(['/a', '/b', '/c', '/d'], [['/a', '/b'], ['/c', '/d']], '/a', '/c');
  // /a joins [/c, /d] → [/c, /d, /a]; [/b] dissolves to standalone.
  assert.deepEqual(result.pinnedTabGroups, [['/c', '/d', '/a']]);
  // /a lifted out of [/a,/b] and dropped after /d (contiguous with target group).
  assert.deepEqual(result.pinnedTabPaths, ['/b', '/c', '/d', '/a']);
});

test('groupPinnedTab is a no-op when source and target are already in the same group', () => {
  const result = groupPinnedTab(['/a', '/b'], [['/a', '/b']], '/a', '/b');
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b']]);
});

test('groupPinnedTab is a no-op when source === target', () => {
  const result = groupPinnedTab(['/a', '/b'], [], '/a', '/a');
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b']);
  assert.deepEqual(result.pinnedTabGroups, []);
});

test('mergePinnedGroups merges target-then-source and makes the block contiguous', () => {
  const result = mergePinnedGroups(
    ['/a', '/b', '/x', '/c', '/d'],
    [['/a', '/b'], ['/c', '/d']],
    '/c', // any source-group member
    '/a', // any target-group member
  );
  // merged = target [/a,/b] then source [/c,/d]; source members move after /b.
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b', '/c', '/d']]);
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/c', '/d', '/x']);
});

test('mergePinnedGroups is a no-op when both paths are in the same group', () => {
  const result = mergePinnedGroups(['/a', '/b'], [['/a', '/b']], '/a', '/b');
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b']]);
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b']);
});

test('mergePinnedGroups is a no-op when either path is ungrouped', () => {
  const result = mergePinnedGroups(['/a', '/b', '/c'], [['/a', '/b']], '/c', '/a');
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b']]);
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/c']);
});

test('ungroupPinnedTab removes a member, dissolves the old group below 2, and repositions it standalone', () => {
  // Drag /a out of [/a,/b] to item-index 1 (after /b).
  const result = ungroupPinnedTab(['/a', '/b', '/c'], [['/a', '/b']], '/a', 1);
  // [/b] dissolves; /a placed at flat index 1 (after /b, before /c).
  assert.deepEqual(result.pinnedTabGroups, []);
  assert.deepEqual(result.pinnedTabPaths, ['/b', '/a', '/c']);
});

test('ungroupPinnedTab removes a member from a 3-group leaving a 2-group intact', () => {
  const result = ungroupPinnedTab(['/a', '/b', '/c', '/d'], [['/a', '/b', '/c']], '/b', 0);
  // /b leaves → [/a, /c] stays a group; /b placed at item-index 0.
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/c']]);
  // /b removed then inserted at flat index 0.
  assert.deepEqual(result.pinnedTabPaths, ['/b', '/a', '/c', '/d']);
});

test('ungroupPinnedTab clamps the target index into range', () => {
  const result = ungroupPinnedTab(['/a', '/b'], [['/a', '/b']], '/a', 99);
  assert.deepEqual(result.pinnedTabGroups, []);
  assert.deepEqual(result.pinnedTabPaths, ['/b', '/a']);
});

test('ungroupPinnedTab places by item-space and never splits a surviving 3-member group (drop gap 2)', () => {
  // 4-member group [/a,/b,/c,/d] + standalone /x. Drag /b out to item gap 2
  // (the gap after /x in the source-removed item list).
  const result = ungroupPinnedTab(['/a', '/b', '/c', '/d', '/x'], [['/a', '/b', '/c', '/d']], '/b', 2);
  // The surviving group stays a single contiguous 3-member group [/a, /c, /d].
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/c', '/d']]);
  // Item-space (source-removed): [group[/a,/c,/d], standalone /x] → gap 2 lands
  // /b after /x. The flat order keeps [/a,/c,/d] contiguous; a flat-index
  // insert would have split the surviving group across /b.
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/c', '/d', '/x', '/b']);
});

test('ungroupPinnedTab at the gap before the surviving group keeps it intact', () => {
  // 4-member group [/a,/b,/c,/d] + standalone /x. Drag /b out to item gap 0
  // (the gap before the surviving group chip).
  const result = ungroupPinnedTab(['/a', '/b', '/c', '/d', '/x'], [['/a', '/b', '/c', '/d']], '/b', 0);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/c', '/d']]);
  assert.deepEqual(result.pinnedTabPaths, ['/b', '/a', '/c', '/d', '/x']);
});

test('movePinnedItem reorders a standalone chip among items without changing groups', () => {
  const result = movePinnedItem(['/a', '/b', '/c', '/d'], [['/a', '/b']], '/c', 0);
  // /c (standalone) moves before the group chip (item-index 0).
  assert.deepEqual(result.pinnedTabPaths, ['/c', '/a', '/b', '/d']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b']]);
});

test('movePinnedItem moves a group block as a unit', () => {
  const result = movePinnedItem(['/a', '/b', '/c', '/d', '/e'], [['/a', '/b'], ['/c', '/d']], '/c', 0);
  // The [/c,/d] group chip (identified by /c) moves to item-index 0.
  assert.deepEqual(result.pinnedTabPaths, ['/c', '/d', '/a', '/b', '/e']);
  assert.deepEqual(result.pinnedTabGroups, [['/a', '/b'], ['/c', '/d']]);
});

test('movePinnedItem clamps the target item index', () => {
  const result = movePinnedItem(['/a', '/b', '/c'], [['/a', '/b']], '/c', 99);
  // /c moves to the end (after the group).
  assert.deepEqual(result.pinnedTabPaths, ['/a', '/b', '/c']);
});
