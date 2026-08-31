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
    generatingTitleSessionPaths: ['/a'],
  }));
  try {
    const generatingTile = container.querySelector('.pinned-tab-group-tile.session-title-loading');
    assert.ok(generatingTile, 'generating member avatar uses the quiet sheen instead of a wheel');
    assert.doesNotMatch(container.innerHTML, /loading-wheel/);

    const chipButton = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    const dropdown = container.querySelector('.pinned-tab-group-dropdown') as HTMLElement | null;
    assert.ok(dropdown, 'dropdown opens on chip click');
    assert.equal(dropdown!.querySelectorAll('.pinned-tab-group-member').length, 2);
    assert.ok(dropdown!.querySelector('.pinned-tab-group-member-label.session-title-loading'));
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

test('right-clicking a group chip opens its dedicated menu without Close Group', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta'), session('/c', 'Gamma'), session('/d', 'Delta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: sessions.map((entry) => entry.path),
    pinnedTabPaths: sessions.map((entry) => entry.path),
    pinnedTabGroups: [['/a', '/b'], ['/c', '/d']],
  }));
  try {
    const chip = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chip);
    act(() => { chip!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
    const menu = container.querySelector('.pinned-group-context-menu');
    assert.ok(menu, 'group chip context menu opens');
    assert.match(menu!.textContent ?? '', /Open Group/);
    assert.match(menu!.textContent ?? '', /Copy Session Paths/);
    assert.match(menu!.textContent ?? '', /Merge with Gamma \(2\)/);
    assert.match(menu!.textContent ?? '', /Dissolve Group/);
    assert.match(menu!.textContent ?? '', /Unpin Group/);
    assert.doesNotMatch(menu!.textContent ?? '', /Close Group/);
  } finally {
    unmount();
    restore();
  }
});

test('right-clicking a dropdown member opens the full session menu with its group action', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  let removed: { path: string; index: number } | null = null;
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
    runSummariesBySession: { '/a': { runId: 'run-a', status: 'closed' } },
    onUngroupPinnedTab: (path: string, index: number) => { removed = { path, index }; },
  }));
  try {
    const chip = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chip);
    act(() => { chip!.click(); });
    const member = container.querySelector<HTMLButtonElement>('.pinned-tab-group-member');
    assert.ok(member);
    act(() => { member!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
    assert.equal(container.querySelector('.pinned-tab-group-dropdown'), null, 'opening member menu closes the dropdown');
    const menu = container.querySelector('.session-tab-context-menu');
    assert.ok(menu);
    const menuText = menu!.textContent ?? '';
    for (const label of [
      'Unpin Tab',
      'Remove from Group',
      'Continue task',
      'Start new task',
      'Duplicate Tab',
      'Close Tab',
      'New Session',
      'Copy Session Path',
    ]) {
      assert.match(menuText, new RegExp(label), `group member menu includes ${label}`);
    }
    const remove = Array.from(menu!.querySelectorAll('button')).find((button) => button.textContent?.includes('Remove from Group')) as HTMLButtonElement | undefined;
    assert.ok(remove);
    act(() => { remove!.click(); });
    assert.deepEqual(removed, { path: '/a', index: 0 });
  } finally {
    unmount();
    restore();
  }
});

test('a grouped dropdown member exposes Close Tab and closes that session', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  let closedPath: string | null = null;
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
    onClose: (path: string) => { closedPath = path; },
  }));
  try {
    const chip = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chip);
    act(() => { chip!.click(); });
    const members = container.querySelectorAll<HTMLButtonElement>('.pinned-tab-group-member');
    assert.equal(members.length, 2);
    act(() => { members[1].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
    const menu = container.querySelector('.session-tab-context-menu');
    assert.ok(menu, 'the grouped member uses the full session context menu');
    const close = Array.from(menu!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Close Tab')) as HTMLButtonElement | undefined;
    assert.ok(close, 'the session context menu includes Close Tab');
    act(() => { close!.click(); });
    assert.equal(closedPath, '/b');
    assert.equal(container.querySelector('.session-tab-context-menu'), null, 'the menu closes after the action');
  } finally {
    unmount();
    restore();
  }
});

test('right-clicking a standalone pinned tab offers dynamic group targets', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta'), session('/c', 'Gamma')];
  let grouped: { source: string; target: string } | null = null;
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b', '/c'],
    pinnedTabPaths: ['/a', '/b', '/c'],
    pinnedTabGroups: [['/b', '/c']],
    onGroupPinnedTab: (source: string, target: string) => { grouped = { source, target }; },
  }));
  try {
    const standalone = container.querySelector<HTMLElement>('.session-tab[data-tab-path="/a"]');
    assert.ok(standalone);
    act(() => { standalone!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
    const menu = container.querySelector('.session-tab-context-menu');
    assert.ok(menu);
    const groupWith = Array.from(menu!.querySelectorAll('button')).find((button) => button.textContent?.includes('Group with Beta')) as HTMLButtonElement | undefined;
    assert.ok(groupWith);
    assert.match(groupWith!.textContent ?? '', /\(2\)/);
    act(() => { groupWith!.click(); });
    assert.deepEqual(grouped, { source: '/a', target: '/b' });
  } finally {
    unmount();
    restore();
  }
});

test('a group context menu copy uses newline-delimited paths and feedback', async () => {
  const restore = mockResizeObserver();
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writes: string[] = [];
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
    const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
    const { container, unmount } = mount(baseProps({
      sessions,
      openTabPaths: ['/a', '/b'],
      pinnedTabPaths: ['/a', '/b'],
      pinnedTabGroups: [['/a', '/b']],
    }));
    const chip = container.querySelector<HTMLButtonElement>('.pinned-tab-group-main');
    assert.ok(chip);
    act(() => { chip!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
    const menu = container.querySelector('.pinned-group-context-menu');
    assert.ok(menu);
    const copy = Array.from(menu!.querySelectorAll('button')).find((button) => button.textContent?.includes('Copy Session Paths')) as HTMLButtonElement | undefined;
    assert.ok(copy);
    act(() => { copy!.click(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['/a\n/b']);
    assert.match(copy!.textContent ?? '', /Copied!/);
    unmount();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
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

// Keyboard context-menu invocation: ContextMenu key / Shift+F10 on the focused
// control issue a grounded synthetic contextmenu that flows through the same
// onContextMenu open path as a right-click.
test('Shift+F10 on an ordinary tab main button opens the tab menu', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a'],
  }));
  try {
    const main = container.querySelector<HTMLElement>('.session-tab[data-tab-path="/a"] .session-tab-main');
    assert.ok(main);
    act(() => { main!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const menu = container.querySelector('.session-tab-context-menu');
    assert.ok(menu, 'the keyboard request opens the tab context menu');
    assert.equal(menu!.getAttribute('aria-label'), 'Alpha tab actions');
  } finally {
    unmount();
    restore();
  }
});

test('the ContextMenu key on a pinned-group chip opens its dedicated group menu', () => {
  const restore = mockResizeObserver();
  const sessions = [session('/a', 'Alpha'), session('/b', 'Beta')];
  const { container, unmount } = mount(baseProps({
    sessions,
    openTabPaths: ['/a', '/b'],
    pinnedTabPaths: ['/a', '/b'],
    pinnedTabGroups: [['/a', '/b']],
  }));
  try {
    const chipButton = container.querySelector<HTMLElement>('.pinned-tab-group-main');
    assert.ok(chipButton);
    act(() => { chipButton!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })); });
    const menu = container.querySelector('.pinned-group-context-menu');
    assert.ok(menu, 'the keyboard request opens the group chip menu');
    assert.match(menu!.textContent ?? '', /Open Group/);
  } finally {
    unmount();
    restore();
  }
});

test('Shift+F10 on a dropdown member closes the dropdown and opens its member menu', () => {
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
    act(() => { chipButton!.click(); });
    const member = container.querySelector<HTMLElement>('.pinned-tab-group-member');
    assert.ok(member);
    act(() => { member!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    assert.equal(container.querySelector('.pinned-tab-group-dropdown'), null, 'opening the member menu closes the dropdown (same as right-click)');
    const menu = container.querySelector('.session-tab-context-menu');
    assert.ok(menu, 'the keyboard request opens the member menu');
    assert.match(menu!.textContent ?? '', /Remove from Group/);
    act(() => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(container.querySelector('.session-tab-context-menu'), null);
    assert.equal(document.activeElement, chipButton, 'closing returns focus to the still-mounted group chip');
  } finally {
    unmount();
    restore();
  }
});
