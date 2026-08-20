import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
import type { SessionSummary } from '../../../src/shared/protocol';
import { SessionTabs } from '../../../src/webview/panel/session-tabs';

installDom();

type SessionTabsProps = Parameters<typeof SessionTabs>[0];

const noop = () => undefined;

function session(path: string, name: string): SessionSummary {
  return { path, name, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 10 };
}

function mockResizeObserver() {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  return () => { globalThis.ResizeObserver = original; };
}

function baseProps(overrides: Partial<SessionTabsProps> = {}): SessionTabsProps {
  return {
    sessions: [],
    openTabPaths: [],
    pinnedTabPaths: [],
    pinnedTabGroups: [],
    runningSessionPaths: [],
    startingModelSessionPaths: [],
    unreadFinishedSessionPaths: [],
    activeSession: null,
    backendReady: true,
    hideConnectingWheel: false,
    pendingExtensionUIRequestsBySession: {},
    runSummariesBySession: {},
    onSelect: noop,
    onClose: noop,
    onMove: noop,
    onMovePinnedItem: noop,
    onNew: noop,
    onDuplicate: noop,
    onTogglePin: noop,
    onGroupPinnedTab: noop,
    onMergePinnedGroups: noop,
    onUngroupPinnedTab: noop,
    onRunAction: noop,
    deferredSessionPaths: [],
    deferredTimerSessionPaths: [],
    ...overrides,
  };
}

function mount(props: SessionTabsProps): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(SessionTabs, props), container));
  return {
    container,
    unmount: () => act(() => render(null, container)),
  };
}

test('a pinned group renders a single chip with data-pinned-item-group and a 2×2 avatar grid', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  }));
  try {
    const chip = container.querySelector('.pinned-tab-group') as HTMLElement | null;
    assert.ok(chip, 'group chip renders');
    assert.equal(chip!.getAttribute('data-pinned-item-group'), 'true');
    assert.equal(chip!.getAttribute('data-pinned-item-path'), '/a');
    // 2 members → 2 avatar tiles in the grid.
    assert.equal(chip!.querySelectorAll('.pinned-tab-group-tile:not(.pinned-tab-group-plus)').length, 2);
    // No dropdown yet.
    assert.equal(container.querySelectorAll('.pinned-tab-group-dropdown').length, 0);
  } finally {
    unmount();
    restore();
  }
});

test('a group of 5 shows the first 3 avatars plus a "+" tile', () => {
  const restore = mockResizeObserver();
  const paths = ['/a', '/b', '/c', '/d', '/e'];
  const sessions = paths.map((p, i) => session(p, `S${i}`));
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: paths,
    pinnedTabPaths: paths,
    pinnedTabGroups: [paths],
  }));
  try {
    const chip = container.querySelector('.pinned-tab-group') as HTMLElement | null;
    assert.ok(chip);
    assert.equal(chip!.querySelectorAll('.pinned-tab-group-tile:not(.pinned-tab-group-plus)').length, 3);
    assert.equal(chip!.querySelectorAll('.pinned-tab-group-plus').length, 1);
  } finally {
    unmount();
    restore();
  }
});

test('clicking a group chip opens a dropdown listing each member', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  }));
  try {
    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    const dropdown = container.querySelector('.pinned-tab-group-dropdown') as HTMLElement | null;
    assert.ok(dropdown, 'dropdown opens on chip click');
    assert.equal(dropdown!.querySelectorAll('.pinned-tab-group-member').length, 2);
    assert.match(dropdown!.textContent ?? '', /Alpha/);
    assert.match(dropdown!.textContent ?? '', /Beta/);
  } finally {
    unmount();
    restore();
  }
});

test('selecting a member fires onSelect and leaves the dropdown open', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  let selected: string | null = null;
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
    onSelect: (path: string) => { selected = path; },
  }));
  try {
    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    const members = container.querySelectorAll<HTMLButtonElement>('.pinned-tab-group-member');
    assert.equal(members.length, 2);
    act(() => { members[1].dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.equal(selected, '/b');
    // Dropdown stays open after member select.
    assert.ok(container.querySelector('.pinned-tab-group-dropdown'), 'dropdown stays open after member select');
  } finally {
    unmount();
    restore();
  }
});

test('an open dropdown re-associates with the surviving group when its first member is dragged out', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta'), session('/c', 'Gamma')];
  let props = baseProps({
    sessions,
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/a', '/b', '/c']],
  });
  const { container, unmount } = mount(props);
  try {
    // Open the dropdown for the group.
    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.ok(container.querySelector('.pinned-tab-group-dropdown'), 'dropdown opens');
    // Simulate the first member /a being ungrouped to the front: it leaves the
    // group and becomes a standalone chip; the group survives as [/b, /c].
    props = {
      ...props,
      pinnedTabPaths: ['/a', '/b', '/c'],
      pinnedTabGroups: [['/b', '/c']],
    };
    act(() => render(h(SessionTabs, props), container));
    // The dropdown stays open, now associated with the surviving group.
    assert.ok(container.querySelector('.pinned-tab-group-dropdown'), 'dropdown stays open on the surviving group');
    // It lists the surviving members (not the dragged-out /a).
    assert.equal(container.querySelectorAll('.pinned-tab-group-member').length, 2);
  } finally {
    unmount();
    restore();
  }
});

test('an open dropdown closes when its group fully dissolves (no surviving group)', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  let props = baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  });
  const { container, unmount } = mount(props);
  try {
    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.ok(container.querySelector('.pinned-tab-group-dropdown'));
    // The group dissolves entirely (both members become standalone).
    props = { ...props, pinnedTabGroups: [] };
    act(() => render(h(SessionTabs, props), container));
    assert.equal(container.querySelectorAll('.pinned-tab-group-dropdown').length, 0, 'dropdown closes when the group dissolves');
  } finally {
    unmount();
    restore();
  }
});

test('Escape closes an open group dropdown', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  }));
  try {
    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.ok(container.querySelector('.pinned-tab-group-dropdown'));
    act(() => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(container.querySelectorAll('.pinned-tab-group-dropdown').length, 0, 'Escape closes the dropdown');
  } finally {
    unmount();
    restore();
  }
});

test('a group whose active member is selected gets the active chip styling', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
    activeSession: sessions[1],
  }));
  try {
    const chip = container.querySelector('.pinned-tab-group') as HTMLElement | null;
    assert.ok(chip);
    assert.ok(chip!.classList.contains('active'), 'chip is active when a member is active');
    assert.equal(chip!.querySelectorAll('.pinned-tab-group-tile.member-active').length, 1, 'active member tile is highlighted');
  } finally {
    unmount();
    restore();
  }
});
