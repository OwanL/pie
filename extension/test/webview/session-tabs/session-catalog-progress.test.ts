import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
import { SessionTabs } from '../../../src/webview/panel/session-tabs';

installDom();

type SessionTabsProps = Parameters<typeof SessionTabs>[0];
const noop = () => undefined;

function props(progress: SessionTabsProps['sessionCatalogProgress']): SessionTabsProps {
  return {
    sessions: [],
    sessionCatalogProgress: progress,
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
  };
}

test('session tabs expose progressive history indexing without blocking actions', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  try {
    act(() => render(h(SessionTabs, props({ complete: false, processed: 24, total: 1_158 })), container));
    const indicator = container.querySelector('.session-tabs-indexing');
    assert.ok(indicator, 'the partial catalog has a visible, unobtrusive status');
    assert.match(indicator?.textContent ?? '', /Indexing/);
    assert.equal(
      indicator?.getAttribute('aria-label'),
      'Indexing session history: 24 of 1158 files processed',
    );
    assert.equal((container.querySelector('.session-tabs-new') as HTMLButtonElement).disabled, false);

    act(() => render(h(SessionTabs, props({ complete: true, processed: 1_158, total: 1_158 })), container));
    assert.equal(container.querySelector('.session-tabs-indexing'), null, 'the final catalog event clears the status');
  } finally {
    act(() => render(null, container));
    container.remove();
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
