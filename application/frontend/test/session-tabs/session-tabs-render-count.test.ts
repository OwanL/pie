import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render, options } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
import type { SessionSummary } from '../../../lib/protocol/index.js';
import { SessionTabs } from '../../session-tabs';

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

// Count actual presentation executions by the root vnode produced by the tab body,
// rather than DOM mutations (which can be absent even after a wasted render).
test('cloned snapshots, status, selection and creation changes respect per-tab render barriers', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const counts = new Map<string, number>();
  const previous = options.vnode;
  options.vnode = (vnode) => {
    previous?.(vnode);
    const path = (vnode.props as Record<string, unknown>)['data-tab-path'];
    if (vnode.type === 'div' && typeof path === 'string') counts.set(path, (counts.get(path) ?? 0) + 1);
  };
  let current = props();
  current.sessions.push(session('/sessions/c', 'Gamma'));
  current.openTabPaths.push('/sessions/c');
  current.onRetryCreate = noop;
  const publish = () => act(() => render(h(SessionTabs, current), container));
  const expect = (a: number, b: number, c: number) => assert.deepEqual(
    current.openTabPaths.map((path) => counts.get(path)), [a, b, c]);
  try {
    publish();
    expect(1, 1, 1);
    current = cloneHostSnapshot(current);
    publish();
    expect(1, 1, 1);
    current = { ...cloneHostSnapshot(current), runningSessionPaths: [] };
    publish();
    expect(2, 1, 1);
    current = { ...cloneHostSnapshot(current), activeSession: current.sessions[1] };
    publish();
    expect(3, 2, 1);
    current = cloneHostSnapshot(current);
    current.sessions[2] = { ...current.sessions[2], creationState: 'delayed', createOperationId: 'first' };
    publish();
    expect(3, 2, 2);
    current = cloneHostSnapshot(current);
    current.sessions[2] = { ...current.sessions[2], createOperationId: 'second' };
    publish();
    expect(3, 2, 3);
    // A changed operation id must update the retry closure, not just the label.
    let retried = '';
    current = { ...current, onRetryCreate: (id) => { retried = id; } };
    publish();
    (container.querySelector('.session-tab-retry') as HTMLButtonElement).click();
    assert.equal(retried, 'second');
    current = cloneHostSnapshot(current);
    current.sessions[2] = { ...current.sessions[2], creationState: undefined };
    publish();
    assert.equal(container.querySelector('.session-tab-retry'), null);
    current = { ...cloneHostSnapshot(current),
      unreadFinishedSessionPaths: ['/sessions/c'],
      deferredSessionPaths: ['/sessions/c'], deferredTimerSessionPaths: ['/sessions/c'],
    };
    publish();
    const tab = container.querySelector('[data-tab-path="/sessions/c"]')!;
    assert.ok(tab.classList.contains('deferred-timer'));
    assert.ok(!tab.classList.contains('unread-finished'));
    assert.equal((tab.querySelector('.session-tab-close') as HTMLButtonElement).disabled, true);
    current = { ...cloneHostSnapshot(current), pendingExtensionUIRequestsBySession: {
      '/sessions/c': { request: {} as never },
    } };
    publish();
    assert.match(tab.querySelector('[role="tab"]')!.getAttribute('title')!, /waiting for your answer/);
  } finally {
    act(() => render(null, container));
    options.vnode = previous;
    container.remove();
  }
});
