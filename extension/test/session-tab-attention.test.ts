import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { SessionTab } from '../src/webview/panel/session-tabs';
import type { ProxySessionStatus, SessionSummary } from '../src/shared/protocol';

// Derive the props type from the component so the test stays in sync with the
// real SessionTab signature without exporting a separate interface.
type SessionTabProps = Parameters<typeof SessionTab>[0];

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function makeSession(path: string, name: string): SessionSummary {
  return { path, name, cwd: '/repo', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
}

const noop = () => undefined;

function classList(el: Element): string[] {
  return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
}

function renderTab(overrides: Partial<SessionTabProps> = {}): HTMLElement {
  const tabPath = overrides.tabPath ?? '/sessions/alpha';
  const props: SessionTabProps = {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, makeSession(tabPath, 'Alpha')]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set(),
    unreadFinishedPathSet: new Set(),
    // `activePath` (a stable string) replaces the previous `activeSession`
    // object prop — SessionTab now derives `isActive` from this path, and the
    // tab bar passes an optimistic override here while a click awaits the host
    // round-trip. These tests drive the component directly, so they pass the
    // plain host path.
    activePath: null,
    hasPendingExtensionUIRequest: false,
    proxySessionStatus: null,
    activeRunSummary: null,
    isPinned: false,
    hasDeferredTriggers: false,
    onContextMenu: noop,
    onPointerDown: noop,
    onClick: noop,
    onClose: noop,
    onMarkComplete: noop,
    ...overrides,
  };

  act(() => {
    render(h(SessionTab, props), container);
  });

  const tab = container.querySelector('.session-tab');
  assert.ok(tab, 'session-tab root element should render');
  return tab as HTMLElement;
}

test('non-active tab with a pending extension UI request renders the attention class and waiting title', () => {
  // The pending tab is /sessions/alpha; a DIFFERENT session is active, so this
  // tab is non-active yet must still surface the attention indicator.
  const other = makeSession('/sessions/other', 'Other');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: other.path,
    hasPendingExtensionUIRequest: true,
  });

  assert.ok(classList(tab).includes('attention'), 'pending non-active tab gets the attention class');
  assert.ok(!classList(tab).includes('active'), 'non-active tab is not marked active');

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.ok(main);
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});

test('non-active tab without a pending request does not get the attention class', () => {
  const other = makeSession('/sessions/other', 'Other');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: other.path,
    hasPendingExtensionUIRequest: false,
  });

  assert.ok(!classList(tab).includes('attention'));
  assert.ok(!classList(tab).includes('active'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha');
});

test('active tab with a pending request keeps both the active and attention classes', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    hasPendingExtensionUIRequest: true,
  });

  // The active treatment must not regress when a request is pending: both the
  // active marker and the attention marker apply to the same tab.
  assert.ok(classList(tab).includes('active'));
  assert.ok(classList(tab).includes('attention'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});

test('pinned tab renders an avatar instead of a label, hides the close button, and keeps the full name on hover', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    isPinned: true,
  });

  assert.ok(classList(tab).includes('pinned'), 'pinned tab gets the pinned class');
  assert.ok(tab.querySelector('.session-tab-avatar'), 'pinned tab renders the letter-avatar');
  assert.ok(!tab.querySelector('.session-tab-label'), 'pinned tab drops the title text');
  assert.ok(!tab.querySelector('.session-tab-close'), 'pinned tab hides the close button (unpin via context menu)');
  assert.ok(!tab.querySelector('.session-tab-run-badge'), 'pinned tab drops the run badge (activity shows via the avatar ring)');

  // The avatar carries the session's first letter so two pinned tabs stay
  // distinguishable without title text. (The deterministic background color is
  // a pure function covered by tab-avatar.test.ts.)
  const avatar = tab.querySelector('.session-tab-avatar') as HTMLElement;
  assert.ok(avatar, 'avatar element renders');
  assert.equal(avatar.textContent, 'A');

  // The full name is still reachable on hover.
  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha');
});

test('parked proxy sessions get a distinct class, pause badge, and explanatory title', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const parked: ProxySessionStatus = {
    provider: 'umans',
    state: 'queued',
    activeSessions: 3,
    queuedSessions: 2,
    maxConcurrentRequests: 3,
  };
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    proxySessionStatus: parked,
    runningPathSet: new Set(['/sessions/alpha']),
  });

  assert.ok(classList(tab).includes('running'));
  assert.ok(classList(tab).includes('parked'));
  assert.ok(tab.querySelector('.session-tab-parked'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for proxy slot: umans 3/3, 2 queued)');
});

test('pending request wins title precedence over unread-finished', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    hasPendingExtensionUIRequest: true,
    // The path is also in the unread-finished set, so without precedence the
    // title would read "(finished, unread)". Pending must win.
    unreadFinishedPathSet: new Set(['/sessions/alpha']),
  });

  assert.ok(classList(tab).includes('attention'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});
