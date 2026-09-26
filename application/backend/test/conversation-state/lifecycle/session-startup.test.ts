import test from 'node:test';
import assert from 'node:assert/strict';

import { publishBackendReady } from '../../../agent-connection/backend-ready';
import { seedHistoryCompactionEnvironment } from '../../../session-actions/runtime-prefs-bootstrap';
import { DEFAULT_HISTORY_COMPACTION_SETTINGS, HISTORY_COMPACTION_ENV } from '../../../../lib/protocol/index.js';
import { buildRestoredSessionSummaries } from '../../../conversation-state/restored-session-summaries';
import { createInitialArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import type { Event } from '../../../conversation-state/events';

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
