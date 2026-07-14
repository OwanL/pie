import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHorizontalDropIndex,
  getNextVisibleTabPathOnClose,
  getVisibleTabPaths,
  insertTabRespectingPinnedPrefix,
  moveOpenTabPath,
  normalizeStoredTabPaths,
  pinTab,
  reorderOpenTabsPinnedFirst,
  unpinTab,
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

test('normalizeStoredTabPaths removes transient and duplicate tabs', () => {
  const paths = normalizeStoredTabPaths([
    '/workspace/a',
    '__pending__:1',
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
