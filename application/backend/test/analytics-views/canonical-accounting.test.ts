import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StatsService } from '../../analytics-views/service';
import { createInitialArchState } from '../../conversation-state/arch-state';
import { CanonicalAnalyticsCapture } from '../../../../analytics/capture/canonical-capture';
import { legacyPrivacyStorageDirs } from '../../../../analytics/usage-accounting/canonical-accounting';
import { createHash } from 'node:crypto';

test('canonical lifecycle has no legacy persistence owners and preserves retired files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-canonical-accounting-'));
  const options = { dataOutcomesRootPath: dir, workspaceId: 'canonical-test', legacyUsageDataRootPath: path.join(dir, 'old'), legacyWorkspaceIds: ['old-workspace'] };
  const state = createInitialArchState();
  const sessionPath = path.join(dir, 'session.jsonl');
  const observations: unknown[] = [];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical', generationId: 'test-generation', workspaceId: options.workspaceId,
    buildId: 'test-build', processGeneration: 'test-process',
    sink: { submit: (value) => { observations.push(value); } },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const dirs = legacyPrivacyStorageDirs(options);
  // Deliberately invalid retired bytes: startup/read/flush must not parse them.
  await fs.mkdir(dirs[0]!, { recursive: true });
  for (const name of ['billable-invocations.jsonl', 'activity-intervals.json', 'run-snapshots.jsonl']) {
    await fs.writeFile(path.join(dirs[0]!, name), 'retired bytes\n');
  }
  const stats = new StatsService({ ...options, analyticsCapture: capture, getArchState: () => state });
  try {
    assert.equal((stats as unknown as { legacySettlement?: unknown }).legacySettlement, undefined);
    await stats.start();
    stats.prepareForSend(sessionPath, []);
    await stats.setSessionPrivacy(sessionPath, true); // open privacy never suppresses canonical capture
    stats.onAssistantTurnStarted(sessionPath, 'turn');
    stats.onAssistantTurnEnded(sessionPath, 'turn', 1, {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, reportedCostUsd: 0,
    });
    assert.ok(observations.length > 0);
    assert.equal('queryRunAnalytics' in stats, false);
    assert.equal('queryPersistedRunAnalytics' in stats, false);
    assert.equal('getActivityIntervals' in stats, false);
    assert.equal('getBillableInvocationRecords' in stats, false);
    assert.equal('getPendingCompletedRuns' in stats, false);
    stats.getSessionUsage(sessionPath);
    await stats.shutdown();
    for (const name of ['billable-invocations.jsonl', 'activity-intervals.json', 'run-snapshots.jsonl']) {
      assert.equal(await fs.readFile(path.join(dirs[0]!, name), 'utf8'), 'retired bytes\n');
    }
    assert.deepEqual((await fs.readdir(dirs[0]!)).sort(), ['activity-intervals.json', 'billable-invocations.jsonl', 'run-snapshots.jsonl']);
  } finally {
    await stats.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('path-only privacy selectors retain exact retired side-channel locations', () => {
  const options = { dataOutcomesRootPath: path.join(os.tmpdir(), 'unused-outcomes'), legacyUsageDataRootPath: path.join(os.tmpdir(), 'unused-legacy'), workspaceId: 'main', legacyWorkspaceIds: ['old', 'main'] };
  const hashes = ['main', 'old'].map((id) => createHash('sha256').update(id).digest('hex').slice(0, 16));
  const roots = [
    path.join(options.legacyUsageDataRootPath, 'runs'),
    path.join(options.legacyUsageDataRootPath, 'usage-data'),
    path.join(options.legacyUsageDataRootPath, 'data', 'outcomes'),
    path.join(options.dataOutcomesRootPath, 'runs'),
    path.join(options.dataOutcomesRootPath, 'usage-data'),
    options.dataOutcomesRootPath,
  ];
  assert.deepEqual(legacyPrivacyStorageDirs(options), [...new Set([
    path.join(options.dataOutcomesRootPath, hashes[0]!),
    ...roots.flatMap((root) => hashes.map((hash) => path.join(root, hash))),
  ])]);
});
