import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StatsService } from '../../analytics-views';
import { createInitialArchState } from '../../conversation-state/arch-state';
import { reducer } from '../../conversation-state/reducer';
import { legacyPrivacyStorageDirs } from '../../../../analytics/usage-accounting/canonical-accounting';

async function fixture(run: (stats: StatsService, advance: (ms: number) => void, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-live-stats-'));
  let state = createInitialArchState();
  let now = Date.parse('2026-01-01T00:00:00Z');
  let id = 0;
  const stats = new StatsService({
    dataOutcomesRootPath: root,
    workspaceId: 'live-test',
    getArchState: () => state,
    dispatchArchEvent: (event) => { state = reducer(state, event).state; },
    now: () => new Date(now),
    createId: () => `run-${++id}`,
  });
  try {
    await stats.start();
    await run(stats, (ms) => { now += ms; }, root);
  } finally {
    await stats.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('unavailable capture retains live run, usage, and working-time observations without persistence', async () => {
  await fixture(async (stats, advance, root) => {
    const session = '/sessions/live.jsonl';
    const runId = stats.prepareForSend(session, []);
    stats.onBusyChanged(session, true);
    stats.onAssistantTurnStarted(session, 'turn-1');
    advance(1_000);
    stats.onAssistantTurnEnded(session, 'turn-1', 900, {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30,
    });
    stats.onBusyChanged(session, false);
    const run = stats.getOpenRuns()[0]!;
    assert.equal(run.runId, runId);
    assert.equal(run.assistantTurnCount, 1);
    assert.equal(run.inputTokens, 10);
    assert.equal(run.outputTokens, 20);
    assert.equal(run.busyDurationMs, 1_000);
    assert.ok(stats.getWorkingTimeBySession()[session]);
    assert.equal(stats.getSessionUsage(session).authority, 'unknown', 'live runs never masquerade as durable usage');
    assert.equal('getBillableInvocationRecords' in stats, false);
    assert.equal('getActivityIntervals' in stats, false);
    stats.onSessionClosed(session);
    assert.deepEqual(stats.getOpenRuns(), []);
    assert.equal('getPendingCompletedRuns' in stats, false);
    await stats.shutdown();
    assert.deepEqual(await fs.readdir(root), [], 'no run store, checkpoint, export, ledger, or timeline is created');
  });
});

test('transient task boundaries, identity replacement, and queued input observations still work', async () => {
  await fixture(async (stats) => {
    const pending = '/sessions/pending.jsonl';
    const resolved = '/sessions/resolved.jsonl';
    stats.onUnsupportedInputAttempt(pending);
    const first = stats.prepareForSend(pending, []);
    stats.replaceSessionPath(pending, resolved, 'stable-root');
    assert.equal(stats.getOpenRuns()[0]?.sessionPath, resolved);
    assert.equal(stats.getOpenRuns()[0]?.unsupportedInputCount, 1);
    stats.startNewTask(resolved);
    const second = stats.prepareForSend(resolved, []);
    assert.notEqual(first, second);
    assert.notEqual(stats.getOpenRuns()[0]?.taskGroupId, first);
    stats.onModelConfigChanged(resolved, 'model', undefined, 'provider');
    stats.onContextUsageChanged(resolved, 50, 100);
    stats.onMessageEdited(resolved, 'message');
    stats.onTruncatedAfter(resolved, 'message');
    stats.onBackendError(resolved, 'TEST');
    const run = stats.getOpenRuns()[0]!;
    assert.equal(run.modelId, 'model');
    assert.equal(run.contextTokens, 50);
    assert.equal(run.messageEditCount, 1);
    assert.equal(run.truncatedAfterCount, 1);
    assert.deepEqual(run.backendErrorCodes, ['TEST']);
  });
});

test('unavailable capture never restores checkpoints or reconstructs transcript usage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-disabled-startup-'));
  try {
    const retired = legacyPrivacyStorageDirs({ dataOutcomesRootPath: root, workspaceId: 'live-test' })[0]!;
    await fs.mkdir(retired, { recursive: true });
    const files = ['run-snapshots.jsonl', 'run-state.json', 'billable-invocations.jsonl', 'activity-intervals.json'];
    for (const name of files) await fs.writeFile(path.join(retired, name), 'unparseable retired bytes\n');
    const restarted = new StatsService({ dataOutcomesRootPath: root, workspaceId: 'live-test', getArchState: createInitialArchState });
    try {
      await restarted.start();
      restarted.onSessionUsageSnapshot('/sessions/old.jsonl', 'old-root', {
        samples: [{ sourceId: 'old-message', kind: 'conversation', inputTokens: 10, outputTokens: 10,
          cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20 }],
      });
      assert.deepEqual(restarted.getOpenRuns(), []);
      assert.equal('getBillableInvocationRecords' in restarted, false);
      assert.equal(restarted.getSessionUsage('/sessions/old.jsonl').authority, 'unknown');
    } finally {
      await restarted.shutdown();
    }
    assert.deepEqual((await fs.readdir(retired)).sort(), files.sort());
    for (const name of files) assert.equal(await fs.readFile(path.join(retired, name), 'utf8'), 'unparseable retired bytes\n');
    for (const removed of ['store', 'runStore', 'ledger', 'activityTimeline', 'queryRunAnalytics',
      'queryPersistedRunAnalytics', 'exportRunAnalytics', 'getStorageDir']) {
      assert.equal(removed in restarted, false, `${removed} must not be owned by a fresh service`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shutdown is terminal even without a capture or read helper', async () => {
  await fixture(async (stats) => {
    await stats.shutdown();
    const stages = stats.getStartupStageMetrics().length;
    await stats.start();
    assert.equal(stats.getStartupStageMetrics().length, stages);
    assert.equal(stats.getSessionUsage('/sessions/late.jsonl').authority, 'unknown');
    assert.equal(stats.getAnalyticsRevisionRefreshStats(), undefined);
  });
});
