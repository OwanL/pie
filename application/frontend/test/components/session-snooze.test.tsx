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
  const result = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
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
      onNew: noop, onContextAction: noop, onSnooze: commands.snooze, onClose: () => { closed++; },
    });
  }
  act(() => render(h(Harness, {}), container));
  act(() => button(container, 'Snooze…').click());
  assert.equal(container.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Snooze A quiet session');
  act(() => button(container, preset.label).click());
  assert.deepEqual(posted, [{ type: 'snoozeSession', sessionPath: path, durationHours: preset.duration }]);
  assert.equal(closed, 1);
}));

test('snooze secondary menu supports arrow navigation, Back and one-layer Escape', () => fixture((container) => {
  let closed = 0;
  act(() => render(h(SessionTabContextMenu, {
    tabContextMenu: { x: 10, y: 10, tabPath: path }, sessionByPath: new Map([[path, session]]),
    runSummary: null, isPinned: false, hasDeferredTriggers: false,
    onNew: noop, onContextAction: noop, onSnooze: noop, onClose: () => { closed++; },
  }), container));
  act(() => button(container, 'Snooze…').click());
  assert.equal(document.activeElement, button(container, 'Back to tab actions'));
  press('ArrowDown');
  assert.equal(document.activeElement, button(container, '4 hours'));
  press('End');
  assert.equal(document.activeElement, button(container, 'Until Monday morning'));
  press('Escape');
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  act(() => button(container, 'Snooze…').click());
  press('ArrowLeft');
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  act(() => button(container, 'Snooze…').click());
  act(() => button(container, 'Back to tab actions').click());
  assert.equal(document.activeElement, button(container, 'Snooze…'));
  assert.equal(closed, 0);
  press('Escape');
  assert.equal(closed, 1);
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
    assert.ok(container.querySelector('.session-snooze-reason')?.textContent);
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
    onNew: noop, onContextAction: noop, onSnooze: () => { posted++; }, onClose: noop,
  };
  act(() => render(h(SessionTabContextMenu, { ...props,
    tabContextMenu: { ...props.tabContextMenu, tabPath: '__pending__:one' } }), container));
  assert.equal(button(container, 'Snooze…').disabled, true);
  act(() => render(h(SessionTabContextMenu, props), container));
  act(() => button(container, 'Snooze…').click());
  act(() => render(h(SessionTabContextMenu, { ...props, snoozeBlockedReason: 'Wait for session activity to finish before snoozing.' }), container));
  for (const preset of SNOOZE_PRESETS) {
    const item = button(container, preset.label);
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
  const css = readFileSync('application/frontend/styles/tabs.css', 'utf8');
  const imports = readFileSync('application/frontend/styles/index.css', 'utf8');
  assert.ok(imports.indexOf("'./composer.css'") > imports.indexOf("'./tabs.css'"));
  // Compound selectors must beat the generic/single-class minimums loaded later.
  assert.match(css, /\.block-context-menu\.session-tab-context-menu\s*\{[^}]*min-width:\s*min\(190px, calc\(100vw - 8px\)\)/);
  assert.match(css, /\.block-context-menu\.session-tab-context-menu\s*\{[^}]*max-width:\s*min\(340px, calc\(100vw - 8px\)\)/);
  assert.match(css, /\.block-context-menu\.snoozed-sessions-menu\s*\{[^}]*min-width:\s*min\(220px, calc\(100vw - 8px\)\)/);
  assert.match(css, /\.block-context-menu\.session-tab-context-menu \.context-menu-item\s*\{[^}]*white-space:\s*normal/);
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
