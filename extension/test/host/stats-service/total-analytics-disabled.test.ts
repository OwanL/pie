import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DisabledAnalyticsRuntime } from '../../../src/host/analytics-runtime.js';
import { DisabledStatsService } from '../../../src/host/stats-service/disabled.js';
import type { RunObserver } from '../../../src/host/stats-service/types.js';

test('disabled Stats has no filesystem or analytics projection side effects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-total-analytics-disabled-'));
  const dataRoot = path.join(root, 'data-outcomes');
  const legacyRoot = path.join(root, 'legacy');
  try {
    const stats = new DisabledStatsService();
    const observerKeys: Array<keyof RunObserver> = [
      'prepareForSend',
      'onAssistantTurnStarted',
      'onSkillPruningUsage',
      'onAssistantTurnEnded',
      'onAssistantTerminalWatermark',
      'onAgentSettled',
      'onSessionUsageSnapshot',
      'onBranchObserved',
      'onSessionDuplicated',
      'onToolStarted',
      'onToolFinished',
      'onInterrupted',
      'onCompaction',
      'onAuxiliaryLlmUsage',
      'onAutoRetry',
      'onAutoRetryMeasured',
      'onMessageEdited',
      'onTruncatedAfter',
      'onBackendError',
      'onContextUsageChanged',
      'onBusyChanged',
      'onModelConfigChanged',
      'onUnsupportedInputAttempt',
      'onSessionClosed',
      'setSessionPrivacy',
      'closePrivateSessionAnalytics',
      'replaceSessionPath',
    ];
    for (const key of observerKeys) {
      const callback = stats[key];
      if (typeof callback === 'function') {
        await Promise.resolve((callback as (...args: never[]) => unknown)());
      }
    }

    await stats.start();
    await stats.flush();
    await stats.shutdown();
    assert.deepEqual(await stats.queryRunAnalytics(), { completedRuns: [], openRuns: [] });
    assert.deepEqual(await stats.queryPersistedRunAnalytics(), { completedRuns: [], openRuns: [] });
    assert.deepEqual(stats.getSessionUsage(path.join(root, 'session.jsonl')), {
      samples: [],
      authority: 'unknown',
    });
    assert.deepEqual(stats.getWorkingTimeBySession(), {});
    assert.deepEqual(stats.getOpenRuns(), []);
    assert.deepEqual(stats.getPendingCompletedRuns(), []);
    assert.deepEqual(stats.getActivityIntervals(), []);
    assert.deepEqual(stats.getBillableInvocationRecords(), []);
    assert.equal(stats.getAnalyticsReadModel(), undefined);
    assert.equal(stats.getAnalyticsRevisionRefreshStats(), undefined);
    assert.throws(() => stats.getStorageDir(), /storage is unavailable/i);
    await assert.rejects(() => stats.exportRunAnalytics(path.join(root, 'export.json')), /export is unavailable/i);
    assert.equal(await exists(dataRoot), false);
    assert.equal(await exists(legacyRoot), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('disabled runtime reports legacy non-ready state without creating a receipt', async () => {
  const runtime = new DisabledAnalyticsRuntime();
  const readiness = await runtime.start();
  assert.equal(runtime.analyticsTimeZone, 'UTC');
  assert.deepEqual(readiness, {
    authority: 'legacy',
    manifestRevision: null,
    manifestSha256: null,
    generationId: null,
    recorderSchemaVersion: null,
    projectionRevision: null,
    recorderReady: false,
    queryReady: false,
  });
  runtime.recordLoadedGeneration();
  assert.equal(runtime.backendDescriptor(), undefined);
  await runtime.stop();
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
