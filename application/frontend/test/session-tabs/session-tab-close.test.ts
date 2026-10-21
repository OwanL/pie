import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { projectSessionTabProps, SessionTabPresentation, type SessionTabProps } from '../../session-tabs/session-tab';
import type { SessionSummary } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

function makeSession(path: string, name: string): SessionSummary {
  return { path, name, cwd: '/repo', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
}

const noop = () => undefined;

function renderTab(overrides: Partial<SessionTabProps> = {}): {
  tab: HTMLElement;
  close: HTMLButtonElement;
  closedPaths: string[];
  clickedPaths: string[];
} {
  const tabPath = overrides.tabPath ?? '/sessions/alpha';
  const closedPaths: string[] = [];
  const clickedPaths: string[] = [];
  const props: SessionTabProps = {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, makeSession(tabPath, 'Alpha')]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set(),
    startingModelPathSet: new Set(),
    unreadFinishedPathSet: new Set(),
    activePath: null,
    hasPendingExtensionUIRequest: false,
    isPinned: false,
    isDropTarget: false,
    hasDeferredTriggers: false,
    hasDeferredTimer: false,
    onContextMenu: noop,
    onPointerDown: noop,
    onClick: (path) => { clickedPaths.push(path); },
    onClose: (path) => { closedPaths.push(path); },
    ...overrides,
  };

  act(() => {
    render(h(SessionTabPresentation, projectSessionTabProps(props)), container);
  });

  const tab = container.querySelector('.session-tab');
  assert.ok(tab, 'session-tab root element should render');
  const close = tab.querySelector('.session-tab-close');
  assert.ok(close, 'close button should render on an unpinned tab');
  return { tab: tab as HTMLElement, close: close as HTMLButtonElement, closedPaths, clickedPaths };
}

// A tab that is the delivery target of a pending deferred trigger must not be
// closable, but the × also must not drop out of the tab order: it stays
// focusable (aria-disabled instead of disabled, with the block reason exposed
// as an accessible description) and its activation is guarded against clicks
// and keyboard Enter/Space — which arrive through the same click event.
test('deferred-target close button stays focusable, exposes the block reason, and guards activation', () => {
  const { tab, close, closedPaths, clickedPaths } = renderTab({ hasDeferredTriggers: true });

  assert.equal(close.disabled, false, 'hard-disabled would remove it from the tab order');
  assert.equal(close.getAttribute('aria-disabled'), 'true', 'disabled state is announced');
  const reason = 'Pending deferred trigger(s) — cancel from the status bar first.';
  assert.equal(close.getAttribute('aria-description'), reason, 'concise reason exposed as the accessible description');
  assert.equal(close.getAttribute('title'), reason, 'native tooltip survives for pointer users');
  assert.equal(close.getAttribute('aria-label'), 'Close Alpha', 'base label keeps the action discoverable');
  assert.ok(!tab.classList.contains('drop-target-on'));

  act(() => {
    close.focus();
    close.click();
  });
  assert.deepEqual(closedPaths, [], 'a blocked close must not close (pointer activation)');
  assert.deepEqual(clickedPaths, [], 'a blocked close must not fall through to the parent tab click');
  assert.equal(document.activeElement, close, 'guarding activation preserves focus');
});

test('close button without deferred triggers remains enabled and closes', () => {
  const { close, closedPaths, clickedPaths } = renderTab({});

  assert.equal(close.disabled, false);
  assert.equal(close.getAttribute('aria-disabled'), null);
  assert.equal(close.getAttribute('aria-description'), null);
  assert.equal(close.getAttribute('title'), 'Close Alpha');

  act(() => { close.click(); });
  assert.deepEqual(closedPaths, ['/sessions/alpha']);
  assert.deepEqual(clickedPaths, [], 'closing never propagates to the parent tab click');
});