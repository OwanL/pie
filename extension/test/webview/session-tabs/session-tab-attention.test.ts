import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { SessionTab } from '../../../src/webview/panel/session-tabs';
import type { SessionSummary } from '../../../src/shared/protocol';

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
    startingModelPathSet: new Set(),
    unreadFinishedPathSet: new Set(),
    // `activePath` (a stable string) replaces the previous `activeSession`
    // object prop — SessionTab now derives `isActive` from this path, and the
    // tab bar passes an optimistic override here while a click awaits the host
    // round-trip. These tests drive the component directly, so they pass the
    // plain host path.
    activePath: null,
    hasPendingExtensionUIRequest: false,
    isPinned: false,
    isDropTarget: false,
    hasDeferredTriggers: false,
    hasDeferredTimer: false,
    onContextMenu: noop,
    onPointerDown: noop,
    onClick: noop,
    onClose: noop,
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
    isDropTarget: false,
  });

  assert.ok(classList(tab).includes('pinned'), 'pinned tab gets the pinned class');
  assert.ok(tab.querySelector('.session-tab-avatar'), 'pinned tab renders the letter-avatar');
  assert.ok(!tab.querySelector('.session-tab-label'), 'pinned tab drops the title text');
  assert.ok(!tab.querySelector('.session-tab-close'), 'pinned tab hides the close button (unpin via context menu)');
  assert.ok(!tab.querySelector('.session-tab-run-badge'), 'tab does not render run badges');

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

test('a pending deferred timer replaces the misleading finished indicator with an hourglass', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    unreadFinishedPathSet: new Set(['/sessions/alpha']),
    hasDeferredTriggers: true,
    hasDeferredTimer: true,
  });

  assert.ok(classList(tab).includes('deferred-timer'));
  assert.ok(!classList(tab).includes('unread-finished'));
  assert.ok(tab.querySelector('.session-tab-deferred-timer'), 'timer hourglass renders');
  assert.ok(!tab.querySelector('.session-tab-finished'), 'green finished dot is suppressed');

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for deferred timer)');
});

test('a running tab in the starting-model phase renders the muted starting-model dot', () => {
  // Pruning already succeeded but the model has not yet started streaming (the
  // post-pruning, pre-commit window — includes concurrency-limit waits). The
  // running dot gets the `starting-model` modifier so the wait is visually
  // distinct from active streaming.
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    runningPathSet: new Set(['/sessions/alpha']),
    startingModelPathSet: new Set(['/sessions/alpha']),
  });

  assert.ok(classList(tab).includes('running'), 'running tab keeps the running class');
  const dot = tab.querySelector('.session-tab-running') as HTMLElement;
  assert.ok(dot, 'running dot renders');
  assert.ok(classList(dot).includes('starting-model'), 'starting-model phase renders the muted dot modifier');
});

test('a running tab that is streaming (not in starting-model) renders the plain running dot', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activePath: alpha.path,
    runningPathSet: new Set(['/sessions/alpha']),
    startingModelPathSet: new Set(),
  });

  const dot = tab.querySelector('.session-tab-running') as HTMLElement;
  assert.ok(dot, 'running dot renders');
  assert.ok(!classList(dot).includes('starting-model'), 'streaming tab does not get the muted modifier');
});
