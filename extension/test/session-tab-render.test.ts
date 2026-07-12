import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { SessionTab } from '../src/webview/panel/session-tabs/session-tab';
import { PENDING_SESSION_PREFIX } from '../src/shared/tab-behavior';
import type { SessionSummary } from '../src/shared/protocol';

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
    activeRunSummary: null,
    isPinned: false,
    hasDeferredTriggers: false,
    onContextMenu: () => undefined,
    onPointerDown: () => undefined,
    onClick: () => undefined,
    onClose: () => undefined,
    onMarkComplete: () => undefined,
  }));

  assert.match(html, /preparing in background/);
  assert.match(html, /session-tab-running/);
  assert.doesNotMatch(html, /session-tab-main[^>]*disabled/);
});
