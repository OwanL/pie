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
  return {
    path,
    name,
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 10,
  };
}

function props(): SessionTabsProps {
  const sessions = [session('/sessions/a', 'Alpha'), session('/sessions/b', 'Beta')];
  return {
    sessions,
    openTabPaths: sessions.map((item) => item.path),
    pinnedTabPaths: [],
    pinnedTabGroups: [],
    runningSessionPaths: ['/sessions/a'],
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
}

function cloneHostSnapshot(value: SessionTabsProps): SessionTabsProps {
  return {
    ...value,
    sessions: structuredClone(value.sessions),
    openTabPaths: [...value.openTabPaths],
    pinnedTabPaths: [...value.pinnedTabPaths],
    pinnedTabGroups: value.pinnedTabGroups.map((g) => [...g]),
    runningSessionPaths: [...value.runningSessionPaths],
    startingModelSessionPaths: [...value.startingModelSessionPaths],
    unreadFinishedSessionPaths: [...value.unreadFinishedSessionPaths],
    activeSession: value.activeSession ? structuredClone(value.activeSession) : null,
    pendingExtensionUIRequestsBySession: structuredClone(value.pendingExtensionUIRequestsBySession),
    runSummariesBySession: structuredClone(value.runSummariesBySession),
  };
}

test('an equivalent host snapshot does not rerender the session-tab strip', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const OriginalResizeObserver = globalThis.ResizeObserver;
  let observerConstructions = 0;
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {
      observerConstructions += 1;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  try {
    const initial = props();
    act(() => render(h(SessionTabs, initial), container));
    assert.equal(observerConstructions, 1, 'initial tab strip mounts one layout observer');

    act(() => render(h(SessionTabs, cloneHostSnapshot(initial)), container));
    assert.equal(observerConstructions, 1, 'equivalent cloned state must hold the tab memo barrier');

    const renamed = cloneHostSnapshot(initial);
    renamed.sessions[1] = { ...renamed.sessions[1], name: 'Beta renamed' };
    act(() => render(h(SessionTabs, renamed), container));
    assert.equal(observerConstructions, 2, 'a visible tab change must cross the memo barrier');
    assert.match(container.textContent, /Beta renamed/);
  } finally {
    act(() => render(null, container));
    container.remove();
    globalThis.ResizeObserver = OriginalResizeObserver;
  }
});
