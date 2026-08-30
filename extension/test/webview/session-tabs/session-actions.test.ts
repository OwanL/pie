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
  return { path, name, cwd: '/workspace', modifiedAt: '2026-08-30T00:00:00.000Z', messageCount: 3 };
}

test('session tab actions omit session history and retain new session', () => {
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
    assert.equal(container.querySelector('[aria-label="Open session history"]'), null);
    assert.equal(container.querySelector('[role="dialog"][aria-label="Session history"]'), null);
    assert.ok(container.querySelector('[aria-label="New session"]'));
  } finally {
    act(() => render(null, container));
    container.remove();
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
