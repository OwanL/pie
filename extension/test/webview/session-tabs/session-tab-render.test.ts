import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';

import { installDom } from '../../_helpers/dom';
installDom();

import { SessionTab } from '../../../src/webview/panel/session-tabs/session-tab';
import { SessionTabContextMenu } from '../../../src/webview/panel/session-tabs/session-tab-context-menu';
import { PENDING_SESSION_PREFIX } from '../../../src/shared/tab-behavior';
import type { SessionSummary } from '../../../src/shared/protocol';

test('pending new-session tab shows background preparation without disabling interaction', () => {
  const tabPath = `${PENDING_SESSION_PREFIX}new`;
  const summary: SessionSummary = {
    path: tabPath,
    name: 'New Session',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
  const html = renderToString(h(SessionTab, {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, summary]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set<string>(),
    startingModelPathSet: new Set<string>(),
    unreadFinishedPathSet: new Set<string>(),
    activePath: tabPath,
    hasPendingExtensionUIRequest: false,
    isPinned: false,
    isDropTarget: false,
    hasDeferredTriggers: false,
    hasDeferredTimer: false,
    onContextMenu: () => undefined,
    onPointerDown: () => undefined,
    onClick: () => undefined,
    onClose: () => undefined,
  }));

  assert.match(html, /preparing in background/);
  assert.match(html, /session-tab-running/);
  assert.doesNotMatch(html, /session-tab-main[^>]*disabled/);
});

test('tab shows a subtle title sheen while its LLM title is pending', () => {
  const tabPath = '/sessions/title-pending';
  const summary: SessionSummary = {
    path: tabPath,
    name: 'Investigate why invited users cannot…',
    cwd: '/workspace',
    modifiedAt: '2026-08-30T00:00:00.000Z',
    messageCount: 1,
    isPlaceholder: true,
  };
  const props = {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, summary]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set<string>(),
    generatingTitlePathSet: new Set([tabPath]),
    startingModelPathSet: new Set<string>(),
    unreadFinishedPathSet: new Set<string>(),
    activePath: tabPath,
    hasPendingExtensionUIRequest: false,
    isDropTarget: false,
    hasDeferredTriggers: false,
    hasDeferredTimer: false,
    onContextMenu: () => undefined,
    onPointerDown: () => undefined,
    onClick: () => undefined,
    onClose: () => undefined,
  };
  const html = renderToString(h(SessionTab, { ...props, isPinned: false }));
  assert.match(html, /session-tab-label session-title-loading/);
  assert.match(html, /data-label="Investigate why invited users cannot/);
  assert.doesNotMatch(html, /loading-wheel/);
  assert.match(html, /Investigate why invited users cannot/);

  const pinnedHtml = renderToString(h(SessionTab, { ...props, isPinned: true }));
  assert.match(pinnedHtml, /session-tab-avatar session-title-loading session-title-loading-avatar/);
  assert.doesNotMatch(pinnedHtml, /loading-wheel/);
});

test('tab context menu exposes menu semantics for every action', () => {
  const tabPath = '/sessions/context-menu';
  const summary: SessionSummary = {
    path: tabPath,
    name: 'Context Menu Session',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
  };
  const html = renderToString(h(SessionTabContextMenu, {
    tabContextMenu: { x: 20, y: 30, tabPath },
    sessionByPath: new Map([[tabPath, summary]]),
    runSummary: null,
    isPinned: false,
    hasDeferredTriggers: false,
    onNew: () => undefined,
    onContextAction: () => undefined,
  }));

  assert.match(html, /role="menu"/);
  assert.match(html, /aria-label="Context Menu Session tab actions"/);
  // Pin, Duplicate, Close, plus the parity actions New Session and Copy Session Path.
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 5);
  assert.equal((html.match(/role="separator"/g) ?? []).length, 2);
  assert.match(html, /New Session/);
  assert.match(html, /Copy Session Path/);
});

test('delayed create exposes an explicit retry affordance', () => {
  const tabPath = `${PENDING_SESSION_PREFIX}delayed`;
  const summary: SessionSummary = {
    path: tabPath, name: 'New Session', cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
    creationState: 'delayed', createOperationId: 'create-op-1',
  };
  const html = renderToString(h(SessionTab, {
    tabPath, index: 0,
    sessionByPath: new Map([[tabPath, summary]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set<string>(), startingModelPathSet: new Set<string>(),
    unreadFinishedPathSet: new Set<string>(), activePath: tabPath,
    hasPendingExtensionUIRequest: false, isPinned: false, isDropTarget: false,
    hasDeferredTriggers: false, hasDeferredTimer: false,
    onContextMenu: () => undefined, onPointerDown: () => undefined,
    onClick: () => undefined, onClose: () => undefined,
    onRetryCreate: () => undefined,
  }));
  assert.match(html, /session-tab-retry/);
  assert.match(html, /Retry session creation/);
});

test('tab omits run and review badges', () => {
  const tabPath = '/sessions/reviewed';
  const summary: SessionSummary = {
    path: tabPath,
    name: 'Reviewed Session',
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    reviewed: true,
    reviewId: 'review-1',
    reviewedAt: '2026-01-01T01:00:00.000Z',
  };
  const html = renderToString(h(SessionTab, {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, summary]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set<string>(),
    startingModelPathSet: new Set<string>(),
    unreadFinishedPathSet: new Set<string>(),
    activePath: tabPath,
    hasPendingExtensionUIRequest: false,
    isPinned: false,
    isDropTarget: false,
    hasDeferredTriggers: false,
    hasDeferredTimer: false,
    onContextMenu: () => undefined,
    onPointerDown: () => undefined,
    onClick: () => undefined,
    onClose: () => undefined,
  }));

  assert.match(html, /session-tab-label[^>]*>Reviewed Session</);
  assert.doesNotMatch(html, /session-tab-run-badge/);
  assert.doesNotMatch(html, /session-tab-review-badge/);
  assert.doesNotMatch(html, />Done</);
  assert.doesNotMatch(html, />✓5</);
});

// ─── SessionTabContextMenu: New Session / Copy Session Path / pending pin ──

function renderContextMenu(props: {
  tabPath: string;
  runSummary?: import('../../../src/shared/protocol').ActiveRunSummary | null;
  isPinned?: boolean;
}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const actions: Array<{ action: import('../../../src/webview/panel/session-tabs/types').SessionTabContextAction; tabPath: string }> = [];
  let newCount = 0;
  let closes = 0;
  act(() => {
    render(h(SessionTabContextMenu, {
      tabContextMenu: { x: 10, y: 10, tabPath: props.tabPath, triggerEl: null },
      sessionByPath: new Map(),
      runSummary: props.runSummary ?? null,
      isPinned: props.isPinned ?? false,
      hasDeferredTriggers: false,
      onNew: () => { newCount += 1; },
      onContextAction: (action, path) => { actions.push({ action, tabPath: path }); },
      onClose: () => { closes += 1; },
    }), host);
  });
  return {
    host,
    actions,
    newClicked: () => newCount,
    closes: () => closes,
    buttons: () => Array.from(host.querySelectorAll('button')),
  };
}

function cleanupContextMenu(host: HTMLDivElement): void {
  act(() => { render(null, host); });
  host.remove();
}

function clickButton(host: HTMLDivElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button'))
    .find((el) => el.textContent?.trim().includes(label));
  assert.ok(button, `expected a ${label} button`);
  act(() => { (button as HTMLButtonElement).click(); });
  return button as HTMLButtonElement;
}

test('tab context menu: New Session uses the onNew affordance and closes the menu', () => {
  const menu = renderContextMenu({ tabPath: '/sessions/a' });
  clickButton(menu.host, 'New Session');
  assert.equal(menu.newClicked(), 1);
  assert.equal(menu.closes(), 1);
  assert.deepEqual(menu.actions, [], 'New Session is not a per-tab context action');
  cleanupContextMenu(menu.host);
});

test('tab context menu: Copy Session Path stays webview-local with copied feedback', async () => {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    const menu = renderContextMenu({ tabPath: '/sessions/copy-me' });
    const button = clickButton(menu.host, 'Copy Session Path');
    assert.equal(menu.closes(), 0, 'copy stays open to show feedback');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['/sessions/copy-me']);
    assert.match(button.textContent ?? '', /Copied!/);
    cleanupContextMenu(menu.host);
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('tab context menu: pending tabs cannot offer or pin (pin disabled)', () => {
  const menu = renderContextMenu({ tabPath: `${PENDING_SESSION_PREFIX}wait` });
  const pin = Array.from(menu.host.querySelectorAll('button'))
    .find((el) => el.textContent?.trim().includes('Pin Tab'));
  assert.ok(pin, 'expected a Pin Tab button');
  assert.equal((pin as HTMLButtonElement).disabled, true, 'pin is disabled for pending tabs');
  clickButton(menu.host, 'Pin Tab');
  assert.deepEqual(menu.actions, [], 'a disabled pin must not dispatch');
  // Copy Session Path is equally meaningless for a pending sentinel path.
  const copy = Array.from(menu.host.querySelectorAll('button'))
    .find((el) => el.textContent?.trim().includes('Copy Session Path'));
  assert.equal((copy as HTMLButtonElement).disabled, true);
  cleanupContextMenu(menu.host);
});
