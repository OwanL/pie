import assert from 'node:assert/strict';
import test from 'node:test';

import { runComputeDropIndex, runCommitDrag } from '../../../src/webview/panel/session-tabs/drag-and-drop/drag-state';
import type { SessionTabDragState } from '../../../src/webview/panel/session-tabs/types';

/**
 * Focused unit tests for the pinned-strip drop computation and commit. The
 * drag-state helpers read live DOM rects off the strip, so each test builds a
 * minimal mock strip whose `[data-pinned-item]` elements report fixed rects —
 * no layout engine required. This isolates the sourceIsGroupChip distinction
 * (requirement 2) and the dropdown-member ungroup-at-owning-group gap
 * (requirement 4) from the rest of the DnD wiring.
 */

interface MockRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface MockElement {
  getBoundingClientRect(): MockRect;
  getAttribute(name: string): string | null;
}

function pinnedElement(path: string, rect: MockRect, isGroup: boolean): MockElement {
  return {
    getBoundingClientRect() {
      return rect;
    },
    getAttribute(name: string): string | null {
      if (name === 'data-pinned-item-path') return path;
      if (name === 'data-pinned-item-group') return isGroup ? 'true' : null;
      return null;
    },
  };
}

function makeStrip(elements: MockElement[], stripRect: MockRect): { current: HTMLElement | null } {
  return {
    current: {
      getBoundingClientRect() {
        return stripRect;
      },
      querySelectorAll() {
        return elements;
      },
    } as unknown as HTMLElement,
  };
}

// Group chip [/a, /b] spans x [0, 50]; standalone /c spans x [60, 110].
const GROUP_RECT: MockRect = { left: 0, right: 50, top: 0, bottom: 40, width: 50, height: 40 };
const STANDALONE_RECT: MockRect = { left: 60, right: 110, top: 0, bottom: 40, width: 50, height: 40 };
const STRIP_RECT: MockRect = { left: 0, right: 120, top: 0, bottom: 40, width: 120, height: 40 };

function pinnedElements(): MockElement[] {
  return [
    pinnedElement('/a', GROUP_RECT, true),
    pinnedElement('/c', STANDALONE_RECT, false),
  ];
}

// Center of /c is x = 85 (within its central ~60% drop-on band [70, 100]).
const CENTER_OF_STANDALONE_X = 85;
const STRIP_CENTER_Y = 20;

test('a dropdown member can center-drop onto a standalone pinned tab (group/append)', () => {
  const strip = makeStrip(pinnedElements(), STRIP_RECT);
  const result = runComputeDropIndex(CENTER_OF_STANDALONE_X, STRIP_CENTER_Y, strip, {
    sourcePath: '/b',
    sourceIsPinned: true,
    sourceIsGroupChip: false,
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
  });
  assert.deepEqual(result, { dropIndex: null, dropOnPath: '/c', dropOnIsGroup: false });
});

test('a whole group chip cannot center-drop onto a standalone pinned tab (falls through to a gap reorder)', () => {
  const strip = makeStrip(pinnedElements(), STRIP_RECT);
  const result = runComputeDropIndex(CENTER_OF_STANDALONE_X, STRIP_CENTER_Y, strip, {
    sourcePath: '/a',
    sourceIsPinned: true,
    sourceIsGroupChip: true,
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b']],
  });
  // No merge target for a whole group onto a standalone → gap reorder.
  assert.equal(result?.dropOnPath, null);
  assert.equal(result?.dropOnIsGroup, false);
  assert.equal(result?.dropIndex, 1);
});

test('a whole group chip can center-drop onto a different group (merge)', () => {
  // Reuse the same geometry but treat /c as a group member of a second group.
  const elements = [
    pinnedElement('/a', GROUP_RECT, true),
    pinnedElement('/c', STANDALONE_RECT, true),
  ];
  const strip = makeStrip(elements, STRIP_RECT);
  const result = runComputeDropIndex(CENTER_OF_STANDALONE_X, STRIP_CENTER_Y, strip, {
    sourcePath: '/a',
    sourceIsPinned: true,
    sourceIsGroupChip: true,
    pinnedTabPaths: ['/a', '/b', '/c', '/d'],
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  });
  assert.deepEqual(result, { dropIndex: null, dropOnPath: '/c', dropOnIsGroup: true });
});

// ─── runCommitDrag: dropdown-member ungroup at the gap before its owning group ─

interface CallbackSpies {
  calls: Record<string, unknown[][]>;
  callbacks: {
    onMove: (...a: unknown[]) => void;
    onMovePinnedItem: (...a: unknown[]) => void;
    onGroupPinnedTab: (...a: unknown[]) => void;
    onMergePinnedGroups: (...a: unknown[]) => void;
    onUngroupPinnedTab: (...a: unknown[]) => void;
    onSelect: (...a: unknown[]) => void;
  };
}

function makeCallbacks(): CallbackSpies {
  const calls: Record<string, unknown[][]> = {
    onMove: [],
    onMovePinnedItem: [],
    onGroupPinnedTab: [],
    onMergePinnedGroups: [],
    onUngroupPinnedTab: [],
    onSelect: [],
  };
  return {
    calls,
    callbacks: {
      onMove: (...a: unknown[]) => calls.onMove.push(a),
      onMovePinnedItem: (...a: unknown[]) => calls.onMovePinnedItem.push(a),
      onGroupPinnedTab: (...a: unknown[]) => calls.onGroupPinnedTab.push(a),
      onMergePinnedGroups: (...a: unknown[]) => calls.onMergePinnedGroups.push(a),
      onUngroupPinnedTab: (...a: unknown[]) => calls.onUngroupPinnedTab.push(a),
      onSelect: (...a: unknown[]) => calls.onSelect.push(a),
    },
  };
}

function baseDragState(overrides: Partial<SessionTabDragState>): SessionTabDragState {
  return {
    pointerId: 1,
    sourceIndex: 0,
    sourcePath: '/b',
    offsetX: 0,
    tabWidth: 50,
    tabHeight: 40,
    tabTop: 0,
    dropIndex: null,
    dropOnPath: null,
    dropOnIsGroup: false,
    sourceIsGroupChip: false,
    sourceFromDropdown: false,
    ...overrides,
  };
}

test('a dropdown member dropped at the gap before its owning group ungroups (same-slot shortcut does not apply)', () => {
  const { calls, callbacks } = makeCallbacks();
  let resetCalls = 0;
  runCommitDrag(
    { current: baseDragState({ sourcePath: '/b', sourceFromDropdown: true, dropIndex: 0 }) },
    { current: ['/a', '/b', '/c'] },
    { current: ['/a', '/b', '/c'] },
    { current: [['/a', '/b']] },
    callbacks,
    () => { resetCalls += 1; },
  );
  // dropIndex 0 === the owning group's item index, but a dropdown source must
  // ungroup there rather than be swallowed by the same-slot click shortcut.
  assert.deepEqual(calls.onUngroupPinnedTab, [['/b', 0]]);
  assert.deepEqual(calls.onSelect, []);
  assert.deepEqual(calls.onMovePinnedItem, []);
  assert.equal(resetCalls, 1);
});

test('a standalone pinned chip same-slot release still activates (shortcut preserved)', () => {
  const { calls, callbacks } = makeCallbacks();
  let resetCalls = 0;
  runCommitDrag(
    { current: baseDragState({ sourcePath: '/a', sourceFromDropdown: false, dropIndex: 0 }) },
    { current: ['/a', '/b'] },
    { current: ['/a', '/b'] },
    { current: [] },
    callbacks,
    () => { resetCalls += 1; },
  );
  // dropIndex 0 === the standalone chip's item index → activate it.
  assert.deepEqual(calls.onSelect, [['/a']]);
  assert.deepEqual(calls.onMovePinnedItem, []);
  assert.deepEqual(calls.onUngroupPinnedTab, []);
  assert.equal(resetCalls, 1);
});

test('a dropdown member center-drop onto a standalone commits a group (group/append)', () => {
  const { calls, callbacks } = makeCallbacks();
  let resetCalls = 0;
  runCommitDrag(
    { current: baseDragState({ sourcePath: '/b', sourceFromDropdown: true, dropOnPath: '/c', dropIndex: null }) },
    { current: ['/a', '/b', '/c'] },
    { current: ['/a', '/b', '/c'] },
    { current: [['/a', '/b']] },
    callbacks,
    () => { resetCalls += 1; },
  );
  assert.deepEqual(calls.onGroupPinnedTab, [['/b', '/c']]);
  assert.deepEqual(calls.onUngroupPinnedTab, []);
  assert.deepEqual(calls.onSelect, []);
  assert.equal(resetCalls, 1);
});

test('a group chip center-drop onto another group commits a merge', () => {
  const { calls, callbacks } = makeCallbacks();
  let resetCalls = 0;
  runCommitDrag(
    { current: baseDragState({ sourcePath: '/a', sourceIsGroupChip: true, dropOnPath: '/c', dropIndex: null }) },
    { current: ['/a', '/b', '/c', '/d'] },
    { current: ['/a', '/b', '/c', '/d'] },
    { current: [['/a', '/b'], ['/c', '/d']] },
    callbacks,
    () => { resetCalls += 1; },
  );
  assert.deepEqual(calls.onMergePinnedGroups, [['/a', '/c']]);
  assert.deepEqual(calls.onGroupPinnedTab, []);
  assert.equal(resetCalls, 1);
});
