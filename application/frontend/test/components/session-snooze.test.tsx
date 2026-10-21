import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from '../helpers/dom';
installDom();
import { h, render, type ComponentProps } from 'preact';
import { act } from 'preact/test-utils';
import type { SessionCapabilities, SessionSummary, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { SessionTabs } from '../../session-tabs';
import { SessionTabContextMenu } from '../../session-tabs/session-tab-context-menu';
import { getSnoozeBlockedReason, SNOOZE_PRESETS } from '../../session-tabs/snooze';
import { useSnoozeCommands } from '../../session-tabs/use-snooze-commands';

const path = '/sessions/one.jsonl';
const session = { path, name: 'A quiet session' } as SessionSummary;
const idle: SessionCapabilities = { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true };
const noop = () => {};
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.replace('›', '').trim() === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
function press(key: string) {
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
}
function fixture(run: (container: HTMLDivElement) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  try { run(container); } finally { act(() => render(null, container)); container.remove(); }
}

for (const preset of SNOOZE_PRESETS) test(`snooze preset ${preset.label} sends an explicitly addressed command`, () => fixture((container) => {
  const posted: WebviewToHostMessage[] = [];
  let closed = 0;
  function Harness() {
    const commands = useSnoozeCommands((message) => posted.push(message));
    return h(SessionTabContextMenu, {
      tabContextMenu: { x: 10, y: 10, tabPath: path }, sessionByPath: new Map([[path, session]]),
      runSummary: null, isPinned: false, hasDeferredTriggers: false,
      onContextAction: noop, onSnooze: commands.snooze, onClose: () => { closed++; },
    });
  }
  act(() => render(h(Harness, {}), container));
  act(() => button(container, 'Snooze…').click());
  assert.ok(container.querySelector('[aria-label="A quiet session tab actions"]'));
  assert.ok(document.body.querySelector('[aria-label="Snooze A quiet session"]'));
  act(() => button(document.body, preset.label).click());
  assert.deepEqual(posted, [{ type: 'snoozeSession', sessionPath: path, durationHours: preset.duration }]);
  assert.equal(closed, 1);
}));

test('snooze cascading menu supports arrow navigation and one-layer Escape', () => fixture((container) => {
  let closed = 0;
  act(() => render(h(SessionTabContextMenu, {
    tabContextMenu: { x: 10, y: 10, tabPath: path }, sessionByPath: new Map([[path, session]]),
    runSummary: null, isPinned: false, hasDeferredTriggers: false,
    onContextAction: noop, onSnooze: noop, onClose: () => { closed++; },
  }), container));
  act(() => button(container, 'Snooze…').focus());
  press('ArrowRight');
  assert.equal(document.activeElement, button(document.body, '4 hours'));
  press('ArrowDown');
  press('ArrowUp');
  assert.equal(document.activeElement, button(document.body, '4 hours'));
  press('End');
  assert.equal(document.activeElement, button(document.body, 'Until Monday morning'));
  press('Escape');
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  act(() => button(container, 'Snooze…').click());
  press('ArrowLeft');
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  act(() => button(container, 'Snooze…').click());
  press('Escape');
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  assert.equal(closed, 0);
  press('Escape');
  assert.equal(closed, 1);
}));

test('hover-open submenu leaves parent keyboard navigation available', () => fixture((container) => {
  act(() => render(h(SessionTabContextMenu, {
    tabContextMenu: { x: 10, y: 10, tabPath: path }, sessionByPath: new Map([[path, session]]),
    runSummary: null, isPinned: false, hasDeferredTriggers: false,
    onContextAction: noop, onSnooze: noop, onClose: noop,
  }), container));
  const trigger = button(container, 'Snooze…');
  act(() => { trigger.focus(); trigger.dispatchEvent(new MouseEvent('mouseenter')); });
  assert.ok(document.body.querySelector('[aria-label="Snooze A quiet session"]'));
  assert.equal(document.activeElement, trigger);
  press('ArrowDown');
  assert.equal(document.activeElement, button(container, 'Close tab'));
  press('ArrowUp');
  assert.equal(document.activeElement, trigger);
  press('Home');
  assert.equal(document.activeElement, button(container, 'Copy session path'));
  press('End');
  assert.equal(document.activeElement, button(container, 'Close tab'));
  act(() => trigger.focus());
  press('ArrowRight');
  assert.equal(document.activeElement, button(document.body, '4 hours'));
}));

const tabsProps: ComponentProps<typeof SessionTabs> = {
  sessions: [session], openTabPaths: [path], pinnedTabPaths: [], pinnedTabGroups: [],
  runningSessionPaths: [], startingModelSessionPaths: [], unreadFinishedSessionPaths: [],
  activeSession: session, backendReady: true, pendingExtensionUIRequestsBySession: {}, runSummariesBySession: {},
  deferredSessionPaths: [], deferredTimerSessionPaths: [], sessionCapabilitiesBySession: { [path]: idle },
  onSelect: noop, onClose: noop, onMove: noop, onMovePinnedItem: noop, onNew: noop, onDuplicate: noop,
  onTogglePin: noop, onGroupPinnedTab: noop, onMergePinnedGroups: noop, onUngroupPinnedTab: noop, onRunAction: noop,
};
function contextMenu(container: HTMLElement) {
  const tab = container.querySelector('[role="tab"]');
  assert.ok(tab);
  act(() => { tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
}

test('idle-only guard covers pending, running, billable, primary operations and deferred targets', () => fixture((container) => {
  assert.equal(getSnoozeBlockedReason(path, idle, false, false, false, false), undefined);
  assert.match(getSnoozeBlockedReason('__pending__:one', idle, false, false, false, false) ?? '', /pending/i);
  assert.equal(getSnoozeBlockedReason(path, idle, false, false, false, true),
    'Respond to the pending extension request before snoozing.');
  const operation = { operationId: 'op', kind: 'session.open', phase: 'awaiting-commit', attempt: 1, committed: false, recovery: null } as const;
  const states: Array<Partial<typeof tabsProps>> = [
    { runningSessionPaths: [path] },
    { startingModelSessionPaths: [path] },
    { sessionCapabilitiesBySession: { [path]: { ...idle, billableActivity: true } } },
    { sessionCapabilitiesBySession: { [path]: { ...idle, primaryOperation: operation } } },
    { deferredSessionPaths: [path] },
    { pendingExtensionUIRequestsBySession: { [path]: { request: {
      id: 'request', sessionPath: path, method: 'confirm', title: 'Confirm', message: 'Continue?',
    } } } },
    { backendReady: false },
  ];
  let posted = 0;
  const onSnooze = () => { posted++; };
  act(() => render(h(SessionTabs, { ...tabsProps, onSnooze }), container));
  contextMenu(container);
  assert.equal(button(container, 'Snooze…').disabled, false);
  for (const state of states) {
    act(() => render(h(SessionTabs, { ...tabsProps, ...state, onSnooze }), container));
    const snooze = button(container, 'Snooze…');
    assert.equal(snooze.disabled, true);
    assert.ok(snooze.title);
    assert.equal(container.querySelector('.session-snooze-reason'), null);
    assert.ok(snooze.getAttribute('aria-label')?.includes(snooze.title));
    act(() => snooze.click());
    assert.equal(container.querySelector('[aria-label="Snooze A quiet session"]'), null);
  }
  assert.equal(posted, 0);
}));

test('pending tabs and activity arriving while presets are open cannot snooze', () => fixture((container) => {
  let posted = 0;
  const props = {
    tabContextMenu: { x: 10, y: 10, tabPath: path }, sessionByPath: new Map([[path, session]]),
    runSummary: null, isPinned: false, hasDeferredTriggers: false,
    onContextAction: noop, onSnooze: () => { posted++; }, onClose: noop,
  };
  act(() => render(h(SessionTabContextMenu, { ...props,
    tabContextMenu: { ...props.tabContextMenu, tabPath: '__pending__:one' } }), container));
  assert.equal(button(container, 'Snooze…').disabled, true);
  act(() => render(h(SessionTabContextMenu, props), container));
  act(() => button(container, 'Snooze…').click());
  act(() => render(h(SessionTabContextMenu, { ...props, snoozeBlockedReason: 'Wait for session activity to finish before snoozing.' }), container));
  for (const preset of SNOOZE_PRESETS) {
    const item = button(document.body, preset.label);
    assert.equal(item.disabled, true);
    act(() => item.click());
  }
  assert.equal(posted, 0);
}));

test('manage and restore early remain accessible with every tab snoozed; membership is host-owned', () => fixture((container) => {
  const posted: WebviewToHostMessage[] = [];
  const snoozed = [{ path, name: session.name, wakeAt: Date.UTC(2026, 9, 12, 9) }];
  function Harness({ sessions = snoozed }: { sessions?: typeof snoozed }) {
    const commands = useSnoozeCommands((message) => posted.push(message));
    return h(SessionTabs, { ...tabsProps, openTabPaths: [], activeSession: null,
      snoozedSessions: sessions, onSnooze: commands.snooze, onRestoreSnoozed: commands.restore });
  }
  act(() => render(h(Harness, { sessions: snoozed }), container));
  assert.equal(container.querySelector('[role="tab"]'), null);
  const manage = container.querySelector<HTMLButtonElement>('[aria-label="Manage snoozed sessions"]');
  assert.ok(manage);
  act(() => manage.click());
  assert.equal(manage.getAttribute('aria-expanded'), 'true');
  const restore = container.querySelector<HTMLButtonElement>('[aria-label="Restore early: A quiet session"]');
  assert.ok(restore);
  assert.equal(document.activeElement, restore);
  assert.equal(container.querySelector('time')?.getAttribute('datetime'), new Date(snoozed[0].wakeAt).toISOString());
  act(() => restore.click());
  assert.deepEqual(posted, [{ type: 'restoreSnoozedSession', sessionPath: path }]);
  assert.ok(container.querySelector('[aria-label="Restore early: A quiet session"]'), 'no optimistic local removal');
  press('Escape');
  assert.equal(document.activeElement, manage);
  act(() => render(h(Harness, { sessions: [] }), container));
  assert.equal(container.querySelector('[aria-label="Manage snoozed sessions"]'), null);
}));

test('tab action menus bound long titles to the compact viewport width', () => {
  const css = readFileSync(new URL('../../styles/tabs.css', import.meta.url), 'utf8');
  const imports = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
  assert.ok(imports.indexOf("'./composer.css'") > imports.indexOf("'./tabs.css'"));
  // Compound selectors must beat the generic/single-class minimums loaded later.
  assert.match(css, /\.block-context-menu\.session-tab-context-menu\s*\{[^}]*min-width:\s*min\(190px, calc\(100vw - 8px\)\)/);
  assert.match(css, /\.block-context-menu\.session-tab-context-menu\s*\{[^}]*max-width:\s*min\(340px, calc\(100vw - 8px\)\)/);
  assert.match(css, /\.block-context-menu\.snoozed-sessions-menu\s*\{[^}]*min-width:\s*min\(220px, calc\(100vw - 8px\)\)/);
  assert.ok(imports.includes("'./snooze-submenu.css'"));
});

test('host restoration focuses adjacent manager rows, then stable New session without selecting', () => fixture((container) => {
  const snoozed = ['First', 'Middle', 'Last'].map((name) => ({
    path: `/sessions/${name}.jsonl`, name, wakeAt: Date.UTC(2026, 9, 12, 9),
  }));
  const restored: string[] = [];
  let selected = 0;
  const props = { ...tabsProps, openTabPaths: [], activeSession: null,
    onSelect: () => { selected++; }, onRestoreSnoozed: (path: string) => { restored.push(path); } };
  const publish = (sessions: typeof snoozed) => act(() => render(h(SessionTabs, {
    ...props, snoozedSessions: sessions,
  }), container));
  const row = (name: string) => {
    const item = container.querySelector<HTMLButtonElement>(`[aria-label="Restore early: ${name}"]`);
    assert.ok(item);
    return item;
  };
  publish(snoozed);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Manage snoozed sessions"]')!.click());
  act(() => row('Middle').focus());
  act(() => row('Middle').click());
  publish([snoozed[0], snoozed[2]]);
  assert.equal(document.activeElement, row('Last'));
  act(() => row('Last').click());
  publish([snoozed[0]]);
  assert.equal(document.activeElement, row('First'));
  act(() => row('First').click());
  publish([]);
  assert.equal(document.activeElement, container.querySelector('[aria-label="New session"]'));
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(selected, 0);
  assert.deepEqual(restored, [snoozed[1].path, snoozed[2].path, snoozed[0].path]);
}));

/* Right-click context menu on snoozed entries. */

const snoozedEntries = [
  { path: '/s/A.jsonl', name: 'Alpha', wakeAt: Date.UTC(2026, 9, 19, 20) },
  { path: '/s/B.jsonl', name: 'Beta', wakeAt: Date.UTC(2026, 10, 23, 20) },
];

function mountSnoozedManager(container: HTMLDivElement, options: { withCloseCallback?: boolean } = {}) {
  const posted: WebviewToHostMessage[] = [];
  const closedPaths: string[] = [];
  const restored: string[] = [];
  function Harness() {
    const commands = useSnoozeCommands((message) => posted.push(message));
    return h(SessionTabs, { ...tabsProps, snoozedSessions: snoozedEntries, openTabPaths: [], activeSession: null,
      onSnooze: commands.snooze, onRestoreSnoozed: (path: string) => { restored.push(path); commands.restore(path); },
      ...(options.withCloseCallback !== false ? { onClose: (p: string) => closedPaths.push(p) } : {}) });
  }
  act(() => render(h(Harness, {}), container));
  const manage = container.querySelector<HTMLButtonElement>('[aria-label="Manage snoozed sessions"]');
  assert.ok(manage, 'manage trigger present');
  act(() => manage.click());
  return { posted, closedPaths, restored, manage };
}

function snoozedRow(container: HTMLElement, name: string) {
  const row = container.querySelector<HTMLButtonElement>(`[aria-label="Restore early: ${name}"]`);
  assert.ok(row, `missing snoozed row: ${name}`);
  return row;
}
function entryMenu(container: HTMLElement) {
  const menu = container.querySelector<HTMLDivElement>('[role="menu"][aria-label="Beta snoozed session actions"]');
  assert.ok(menu, 'entry context menu missing');
  return menu;
}
function openEntryViaRightClick(container: HTMLElement, name: string,
  pointer: { clientX: number; clientY: number } = { clientX: 24, clientY: 24 }) {
  const row = snoozedRow(container, name);
  let consumed = true;
  act(() => {
    consumed = row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, ...pointer,
    }));
  });
  return { row, consumed };
}
function entryItems(container: HTMLElement) {
  const buttons = Array.from(entryMenu(container).querySelectorAll<HTMLButtonElement>('button'));
  assert.equal(buttons[0]?.textContent?.trim(), 'Restore early', 'Restore is the first entry menu item');
  return buttons;
}

test('right-click opens a per-entry menu focused on Restore; Close uses the close-session callback',
() => fixture((container) => {
  const controls = mountSnoozedManager(container);
  const { consumed } = openEntryViaRightClick(container, 'Beta');
  assert.equal(consumed, false, 'native context menu is prevented');
  assert.match(entryMenu(container).textContent ?? '', /Beta/);
  const buttons = entryItems(container);
  const close = buttons.find((item) => item.textContent?.trim() === 'Close');
  assert.ok(close, 'Close item present with a close-session callback');
  assert.equal(document.activeElement, buttons[0], 'Restore receives initial focus');
  assert.equal(controls.posted.length, 0);
  act(() => close!.click());
  assert.deepEqual(controls.closedPaths, ['/s/B.jsonl']);
  assert.equal(controls.posted.length, 0, 'close posts no snooze commands');
  assert.equal(container.querySelector('[role="menu"][aria-label="Beta snoozed session actions"]'), null);
  assert.ok(container.querySelector('[aria-label="Snoozed sessions"]'), 'manager stays open');
  assert.equal(document.activeElement, snoozedRow(container, 'Beta'), 'focus returns to the row');
}));

test('entry menu Restore mirrors left-click restore while the manager stays open',
() => fixture((container) => {
  const controls = mountSnoozedManager(container);
  openEntryViaRightClick(container, 'Beta');
  act(() => entryItems(container)[0].click());
  assert.deepEqual(controls.posted, [{ type: 'restoreSnoozedSession', sessionPath: '/s/B.jsonl' }]);
  assert.deepEqual(controls.closedPaths, []);
  assert.ok(snoozedRow(container, 'Beta'), 'no optimistic local removal; membership stays host-owned');
  assert.ok(container.querySelector('[aria-label="Snoozed sessions"]'), 'manager stays open');
  assert.equal(document.activeElement, snoozedRow(container, 'Beta'));
}));

test('Escape dismisses the entry menu, then the manager, one layer at a time',
() => fixture((container) => {
  mountSnoozedManager(container);
  openEntryViaRightClick(container, 'Beta');
  assert.ok(entryMenu(container));
  const row = snoozedRow(container, 'Beta');
  press('Escape');
  assert.equal(container.querySelector('[role="menu"][aria-label="Beta snoozed session actions"]'), null);
  assert.ok(container.querySelector('[aria-label="Snoozed sessions"]'), 'manager stays open');
  assert.equal(document.activeElement, row, 'focus returns to the row');
  press('Escape');
  assert.equal(container.querySelector('[aria-label="Snoozed sessions"]'), null);
  assert.equal(document.activeElement, container.querySelector('[aria-label="Manage snoozed sessions"]'));
}));

test('entry menu navigation and outside clicks keep layered dismissal intact',
() => fixture((container) => {
  mountSnoozedManager(container);
  openEntryViaRightClick(container, 'Beta');
  press('ArrowDown');
  assert.equal(document.activeElement, entryItems(container)[1], 'Close reachable by arrow');
  act(() => { entryMenu(container).querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.ok(entryMenu(container), 'mousedown inside the entry menu keeps both layers open');
  assert.ok(container.querySelector('[aria-label="Snoozed sessions"]'));
  act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.equal(container.querySelector('[role="menu"][aria-label="Beta snoozed session actions"]'), null);
  assert.equal(container.querySelector('[aria-label="Snoozed sessions"]'), null, 'outside click closes both layers');
}));

test('manager row pointer interaction does not dismiss the manager', () => fixture((container) => {
  mountSnoozedManager(container);
  act(() => { snoozedRow(container, 'Beta').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.ok(container.querySelector('[aria-label="Snoozed sessions"]'));
}));

test('left-click restore and keyboard context-menu dismissal coexist', () => fixture((container) => {
  const controls = mountSnoozedManager(container);
  // Left click remains the primary restore path.
  act(() => snoozedRow(container, 'Beta').click());
  assert.deepEqual(controls.posted, [{ type: 'restoreSnoozedSession', sessionPath: '/s/B.jsonl' }]);
  act(() => snoozedRow(container, 'Alpha').focus());
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
  })); });
  const menu = container.querySelector<HTMLDivElement>('[role="menu"][aria-label="Alpha snoozed session actions"]');
  assert.ok(menu, 'keyboard context menu opens the entry menu for Alpha');
  assert.equal(document.activeElement, menu.querySelector('button'));
  press('Escape');
  assert.equal(document.activeElement, snoozedRow(container, 'Alpha'));
  press('ContextMenu');
  assert.ok(container.querySelector('[aria-label="Alpha snoozed session actions"]'));
}));

test('host membership updates dismiss removed entry actions and focus the neighboring row', () => fixture((container) => {
  const restored: string[] = [];
  const publish = (sessions: typeof snoozedEntries, backendReady = true) => act(() => render(h(SessionTabs, {
    ...tabsProps, snoozedSessions: sessions, openTabPaths: [], activeSession: null,
    onRestoreSnoozed: (path: string) => restored.push(path), backendReady,
  }), container));
  publish(snoozedEntries);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Manage snoozed sessions"]')!.click());
  openEntryViaRightClick(container, 'Beta');
  publish([snoozedEntries[0]]);
  assert.equal(container.querySelector('[aria-label="Beta snoozed session actions"]'), null);
  assert.equal(document.activeElement, snoozedRow(container, 'Alpha'));
  openEntryViaRightClick(container, 'Alpha');
  publish([snoozedEntries[0]], false);
  assert.equal(container.querySelector('[aria-label="Alpha snoozed session actions"]'), null);
  const backendDownRow = snoozedRow(container, 'Alpha');
  assert.equal(backendDownRow.disabled, false, 'backend-not-ready row stays focusable (aria-disabled)');
  assert.equal(backendDownRow.getAttribute('aria-disabled'), 'true');
  act(() => backendDownRow.click());
  assert.deepEqual(restored, [], 'a backend-not-ready row must not restore');
  publish([]);
  assert.equal(document.activeElement, container.querySelector('[aria-label="New session"]'));
}));