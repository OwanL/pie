import test from 'node:test';
import assert from 'node:assert/strict';

import { publishBackendReady } from '../../../../src/host/session-service/backend-ready';
import { findStartupSessionToOpen } from '../../../../src/shared/review-auto-close';
import { seedHistoryCompactionEnvironment } from '../../../../src/host/session-service/runtime-prefs-bootstrap';
import { DEFAULT_HISTORY_COMPACTION_SETTINGS, HISTORY_COMPACTION_ENV } from '../../../../src/shared/protocol';
import { buildRestoredSessionSummaries } from '../../../../src/host/core/restored-session-summaries';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';

test('buildRestoredSessionSummaries creates placeholders for string-only restored tabs', () => {
  const summaries = buildRestoredSessionSummaries(
    ['/workspace/a.jsonl'],
    ['/workspace/a.jsonl'],
    '/workspace',
    '2026-01-01T00:00:00.000Z',
  );

  assert.deepEqual(summaries, [{
    path: '/workspace/a.jsonl',
    name: 'Loading...',
    isPlaceholder: true,
    cwd: '/workspace',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
  }]);
});

test('buildRestoredSessionSummaries preserves persisted tab names', () => {
  const summaries = buildRestoredSessionSummaries(
    [{ path: '/workspace/a.jsonl', name: 'Fix startup' }],
    ['/workspace/a.jsonl'],
    '/workspace',
    '2026-01-01T00:00:00.000Z',
  );

  assert.equal(summaries[0]?.name, 'Fix startup');
  assert.equal(summaries[0]?.isPlaceholder, false);
});

test('startup seeds persisted history-compaction settings before the backend is spawned', () => {
  const env: NodeJS.ProcessEnv = {};
  const historyCompaction = {
    ...DEFAULT_HISTORY_COMPACTION_SETTINGS,
    enabled: false,
    thresholdMode: 'tokens' as const,
    softThreshold: 250_000,
    hardThreshold: 300_000,
    keepRecentTokens: 80_000,
  };

  seedHistoryCompactionEnvironment({ historyCompaction }, env);

  assert.deepEqual(JSON.parse(env[HISTORY_COMPACTION_ENV] ?? ''), historyCompaction);
});

test('fresh startup skips active closure targets when choosing a default session', () => {
  const summary = (path: string) => ({
    path, name: path, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
  });
  const closing = {
    ...summary('/workspace/closing.jsonl'),
    closureActions: [{
      actionId: 'close-1', kind: 'closeSelf' as const, targetSessionId: 'closing',
      status: 'pending' as const, attempts: 0, requestedAt: '2026-01-01T00:00:00.000Z',
    }],
  };

  assert.equal(findStartupSessionToOpen([closing, summary('/workspace/open.jsonl')]), '/workspace/open.jsonl');
  assert.equal(findStartupSessionToOpen([closing]), undefined);
});

test('initial reconciliation closure wins over later restored-session startup opens', () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };
  archState = {
    ...archState,
    sessions: {
      ...archState.sessions,
      openTabPaths: ['/workspace/closing.jsonl', '/workspace/surviving.jsonl'],
      activeSessionPath: '/workspace/closing.jsonl',
    },
  };

  // This is the startup order under regression: the backend's unconditional
  // reconciliation event drains the restored target before readiness publishes.
  dispatchArch({
    kind: 'Command',
    cmd: {
      kind: 'CloseSession', corrId: 'review-close-startup',
      sessionPath: '/workspace/closing.jsonl', ensureClosed: true, reviewClosure: true,
    },
  });

  const calls: string[] = [];
  const failure = publishBackendReady({
    dispatchArch,
    scheduleRender: () => calls.push(`render:${getArchState().settings.backendReady}`),
    openSession: (sessionPath) => calls.push(`open:${sessionPath}`),
    preloadSessions: (sessionPaths) => calls.push(`preload:${sessionPaths.join(',')}`),
    isRestoredSessionOpen: (sessionPath) => getArchState().sessions.openTabPaths.includes(sessionPath),
    restoredStartupPath: '/workspace/closing.jsonl',
    preloadPaths: ['/workspace/surviving.jsonl', '/workspace/also-closing.jsonl'],
  });

  assert.equal(failure, null);
  assert.deepEqual(calls, ['render:true', 'preload:/workspace/surviving.jsonl']);
  assert.equal(getArchState().sessions.openTabPaths.includes('/workspace/closing.jsonl'), false);
});

test('publishBackendReady sets backendReady before restore open and keeps it true on restore failure', () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const calls: string[] = [];
  const failure = publishBackendReady({
    dispatchArch,
    scheduleRender: () => {
      calls.push(`render:${getArchState().settings.backendReady}`);
    },
    openSession: () => {
      calls.push(`open:${getArchState().settings.backendReady}`);
      throw new Error('boom');
    },
    preloadSessions: () => {
      calls.push('preload');
    },
    isRestoredSessionOpen: () => true,
    restoredStartupPath: '/workspace/a.jsonl',
    preloadPaths: ['/workspace/b.jsonl'],
  });

  assert.equal(failure?.message, 'boom');
  assert.deepEqual(calls, ['render:true', 'open:true', 'render:true']);
  assert.equal(getArchState().settings.backendReady, true);
  assert.equal(getArchState().settings.notice, 'Failed to restore session: boom');
});