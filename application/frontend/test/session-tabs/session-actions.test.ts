import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
import type { SessionSummary } from '../../../lib/protocol/index.js';
import { SessionTabs } from '../../session-tabs';

installDom();

type SessionTabsProps = Parameters<typeof SessionTabs>[0];
const noop = () => undefined;

function session(path: string, name: string): SessionSummary {
  return { path, name, cwd: '/workspace', modifiedAt: '2026-08-30T00:00:00.000Z', messageCount: 3 };
}

test('session tabs omit the actions button and retain new session and context menus', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const sessions = [session('/sessions/open', 'Open'), session('/sessions/closed', 'Closed')];
  const props: SessionTabsProps = {
    sessions,
    openTabPaths: ['/sessions/open'],
    pinnedTabPaths: [],
    pinnedTabGroups: [],
    runningSessionPaths: ['/sessions/closed'],
    startingModelSessionPaths: [],
    unreadFinishedSessionPaths: [],
    activeSession: sessions[0],
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
  };

  try {
    act(() => render(h(SessionTabs, props), container));
    assert.ok(container.querySelector('[aria-label="Open session history"]') === null);
    assert.ok(container.querySelector('[role="dialog"][aria-label="Session history"]') === null);
    assert.ok(container.querySelector('[aria-label="New session"]'));
    assert.ok(container.querySelector('[aria-label="Open session actions"]') === null,
      'session tabs do not render the removed ellipsis actions button');

    const tab = container.querySelector<HTMLElement>('.session-tab[data-tab-path="/sessions/open"]');
    assert.ok(tab);
    act(() => { tab.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 24, clientY: 36,
    })); });
    let menu = container.querySelector<HTMLElement>('.session-tab-context-menu');
    assert.ok(menu, 'right-click opens the existing tab context menu');
    assert.equal(menu.getAttribute('aria-label'), 'Open tab actions');
    assert.match(menu.getAttribute('style') ?? '', /top:\s*36px;\s*left:\s*24px/,
      'right-click menu is anchored at the pointer coordinates');

    act(() => { menu!.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })); });
    const mainButton = tab!.querySelector<HTMLElement>('.session-tab-main');
    assert.ok(mainButton);
    mainButton!.getBoundingClientRect = () => ({
      x: 70, y: 80, left: 70, top: 80, right: 90, bottom: 90, width: 20, height: 10,
      toJSON: () => ({}),
    });
    act(() => { mainButton.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
    })); });
    menu = container.querySelector<HTMLElement>('.session-tab-context-menu');
    assert.ok(menu, 'Shift+F10 opens the existing tab context menu');
    assert.equal(menu.getAttribute('aria-label'), 'Open tab actions');
    assert.match(menu.getAttribute('style') ?? '', /top:\s*85px;\s*left:\s*80px/,
      'keyboard menu is grounded at the invoking tab control instead of 0,0');
  } finally {
    act(() => render(null, container));
    container.remove();
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
