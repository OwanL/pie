import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary } from '../../../../src/shared/protocol';

function summary(path: string, name = path.slice(1)): SessionSummary {
  return { path, name, cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
}

function stateWith(opts: {
  openTabPaths: string[];
  pinnedTabPaths?: string[];
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
      activeSessionPath: opts.activeSessionPath ?? opts.openTabPaths[0] ?? null,
    },
  };
}

// ─── TogglePinTab ───────────────────────────────────────────────────────────

test('TogglePinTab pins an open tab: moves it to the end of the pinned prefix', () => {
  const state = stateWith({ openTabPaths: ['/a', '/b', '/c'], activeSessionPath: '/a' });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'p1', sessionPath: '/b' },
  });
  // /b becomes the only pinned tab → it leads the strip.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/b', '/a', '/c']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b']);
  // Active session is untouched by pinning.
  assert.equal(result.state.sessions.activeSessionPath, '/a');
  // Emits a PersistTabs effect carrying the new pinned set.
  const persist = (result.effects as any[]).find((e) => e.kind === 'PersistTabs');
  assert.ok(persist, 'expected a PersistTabs effect');
  assert.deepEqual(persist.pinnedTabPaths, ['/b']);
  assert.deepEqual(persist.openTabPaths, ['/b', '/a', '/c']);
});

test('TogglePinTab pins a tab onto an existing pinned group at its tail', () => {
  const state = stateWith({ openTabPaths: ['/a', '/b', '/c'], pinnedTabPaths: ['/a'] });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'p2', sessionPath: '/c' },
  });
  // /c moves to the tail of the pinned prefix (right after /a).
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/c', '/b']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a', '/c']);
});

test('TogglePinTab unpins a tab and drops it to the start of the unpinned region', () => {
  const state = stateWith({
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b'],
    activeSessionPath: '/c',
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'p3', sessionPath: '/a' },
  });
  // /a leaves the pinned prefix and lands right after the remaining pinned tab (/b).
  assert.deepEqual(result.state.sessions.openTabPaths, ['/b', '/a', '/c']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/b']);
  assert.equal(result.state.sessions.activeSessionPath, '/c');
});

test('TogglePinTab is a no-op for a tab that is not open', () => {
  const state = stateWith({ openTabPaths: ['/a'], pinnedTabPaths: [] });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'p4', sessionPath: '/missing' },
  });
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test('TogglePinTab on an already-pinned tab toggles it off (unpins)', () => {
  const state = stateWith({ openTabPaths: ['/a', '/b'], pinnedTabPaths: ['/a'] });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'TogglePinTab', corrId: 'p5', sessionPath: '/a' },
  });
  // togglePinTab flips the state — an already-pinned tab becomes unpinned,
  // dropping to the start of the unpinned region (here index 0, right after the
  // now-empty pinned prefix). The context menu shows "Pin" vs "Unpin" based on
  // current state, so the host-side command is a pure toggle.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/b']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, []);
});

// ─── MoveSessionTab zone clamping ───────────────────────────────────────────

test('MoveSessionTab clamps a pinned tab to the pinned zone (cannot cross into unpinned)', () => {
  const state = stateWith({
    openTabPaths: ['/p1', '/p2', '/a', '/b'],
    pinnedTabPaths: ['/p1', '/p2'],
  });
  // Ask to move /p1 (index 0) all the way to index 3 (inside the unpinned zone).
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MoveSessionTab', corrId: 'm1', sessionPath: '/p1', fromIndex: 0, toIndex: 3 },
  });
  // Clamped to the pinned zone — /p1 swaps with /p2, it does NOT reach the unpinned region.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/p2', '/p1', '/a', '/b']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/p1', '/p2']);
});

test('MoveSessionTab clamps an unpinned tab to the unpinned zone (cannot enter pinned)', () => {
  const state = stateWith({
    openTabPaths: ['/p', '/a', '/b'],
    pinnedTabPaths: ['/p'],
  });
  // Ask to move /b (index 2) to index 0 (inside the pinned zone).
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'MoveSessionTab', corrId: 'm2', sessionPath: '/b', fromIndex: 2, toIndex: 0 },
  });
  // Clamped to the start of the unpinned zone (index 1) — /b cannot leapfrog /p.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/p', '/b', '/a']);
});

// ─── OpenTabsChanged restore normalization ──────────────────────────────────

test('OpenTabsChanged reorders openTabPaths so pinned tabs lead and drops pinned paths no longer open', () => {
  const state = stateWith({ openTabPaths: ['/stale'], pinnedTabPaths: [] });
  const result = reducer(state, {
    kind: 'OpenTabsChanged',
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/c', '/gone'],
  });
  // /c (pinned) moves to the front; /gone (pinned but not restored) is dropped.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/c', '/a', '/b']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/c']);
});

test('OpenTabsChanged prunes an existing pinned set when pinnedTabPaths is omitted', () => {
  const state = stateWith({ openTabPaths: ['/a', '/b'], pinnedTabPaths: ['/a', '/dropped'] });
  const result = reducer(state, { kind: 'OpenTabsChanged', openTabPaths: ['/a', '/b'] });
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/a']);
});

// ─── CloseSession removes from pinned ───────────────────────────────────────

test('CloseSession removes the closed tab from pinnedTabPaths and selects the next tab', () => {
  const state = stateWith({
    openTabPaths: ['/p', '/a'],
    pinnedTabPaths: ['/p'],
    activeSessionPath: '/p',
    sessions: [summary('/p', 'Pinned'), summary('/a', 'Alpha')],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'CloseSession', corrId: 'c1', sessionPath: '/p' },
  });
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, []);
  assert.equal(result.state.sessions.activeSessionPath, '/a');
  const persist = (result.effects as any[]).find((e) => e.kind === 'PersistTabs');
  assert.ok(persist);
  assert.deepEqual(persist.pinnedTabPaths, []);
});

// ─── DuplicateSession clamps the unpinned copy out of the pinned prefix ──────

test('DuplicateSession places the unpinned copy after the pinned group, not inside it', () => {
  const placeholder: SessionSummary = {
    path: '/__pending__:1-x', name: 'P1 (copy)', cwd: '/w',
    modifiedAt: '2024-02-01T00:00:00.000Z', messageCount: 1, isPlaceholder: true,
  };
  const state = stateWith({
    openTabPaths: ['/p1', '/p2', '/a'],
    pinnedTabPaths: ['/p1', '/p2'],
    activeSessionPath: '/p1',
    sessions: [summary('/p1', 'P1'), summary('/p2', 'P2'), summary('/a', 'A')],
  });
  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'DuplicateSession', corrId: 'd1',
      sessionPath: '/__pending__:1-x', sourceSessionPath: '/p1',
      placeholderSummary: placeholder, selectionToken: 'tok',
    },
  });
  // The copy is unpinned, so it lands at the start of the unpinned region (after /p2),
  // NOT between /p1 and /p2 inside the pinned prefix.
  assert.deepEqual(result.state.sessions.openTabPaths, ['/p1', '/p2', '/__pending__:1-x', '/a']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/p1', '/p2']);
});

// ─── SessionClosed evicts from pinnedTabPaths (pinned ⊆ openTabPaths invariant) ─

test('SessionClosed removes the evicted session from pinnedTabPaths', () => {
  // SessionClosed → removeSessionFromState (full eviction). A pinned tab that
  // the backend evicts must not leave a dangling pinned entry, or the drag
  // clamp + restore normalize would read a stale pinned-prefix size.
  const state = stateWith({
    openTabPaths: ['/p', '/a'],
    pinnedTabPaths: ['/p'],
    sessions: [summary('/p', 'Pinned'), summary('/a', 'Alpha')],
  });
  const result = reducer(state, { kind: 'SessionClosed', sessionPath: '/p' });
  assert.deepEqual(result.state.sessions.openTabPaths, ['/a']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, []);
});

// ─── TabOpened with insertAfter respects the pinned prefix ──────────────────

test('TabOpened after a pinned tab places the new unpinned tab at the start of the unpinned region', () => {
  const state = stateWith({
    openTabPaths: ['/p1', '/p2', '/a'],
    pinnedTabPaths: ['/p1', '/p2'],
    sessions: [summary('/p1'), summary('/p2'), summary('/a')],
  });
  const result = reducer(state, {
    kind: 'TabOpened',
    sessionPath: '/new',
    insertAfter: '/p1',
  });
  // /new is unpinned → it cannot land between /p1 and /p2; it goes to the start
  // of the unpinned region (right after the pinned group).
  assert.deepEqual(result.state.sessions.openTabPaths, ['/p1', '/p2', '/new', '/a']);
  assert.deepEqual(result.state.sessions.pinnedTabPaths, ['/p1', '/p2']);
});
