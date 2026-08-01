import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { SITE_DATA_FILE_NAMES } from '../scripts/contracts.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

test('site data generation writes the V2-only expected bundle and round-trips', async () => {
  await withTempDir(async (dir) => {
    const prepared = prepareSourceAnalytics(await loadFixture());
    const bundle = buildSiteDataBundle(prepared, new Date('2026-05-14T00:00:00.000Z'));
    validateSiteDataBundle(bundle);
    await writeSiteData(dir, bundle);
    const names = (await fs.readdir(dir)).sort();
    assert.deepEqual(names, [...SITE_DATA_FILE_NAMES].sort());

    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.manifest.schemaVersion, 7);
    assert.equal(roundTrip.manifest.completedRunCount, 7);
    assert.equal(roundTrip.runSummary.rows.length, 8);
    assert.equal(roundTrip.sessionReviewAnalytics.cohort, 'v2_production');
    assert.deepEqual(roundTrip.sessionReviewAnalytics.diagnostics, prepared.sessionReviewV2Diagnostics);
  });
});

test('session review site analytics carries complete V2 ingestion accounting', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  prepared.sessionReviewV2Diagnostics = {
    rawProductionCount: 5,
    acceptedCount: 2,
    rejectedCount: 3,
    rejectedByReason: {
      unsupported_schema: 1,
      unsupported_rubric: 1,
      unsupported_index: 0,
      invalid_identity: 0,
      invalid_payload: 1,
    },
  };
  const analytics = buildSiteDataBundle(prepared).sessionReviewAnalytics;
  assert.deepEqual(analytics.diagnostics, prepared.sessionReviewV2Diagnostics);
  validateSiteDataBundle(buildSiteDataBundle(prepared));
});

test('site data generation handles open-only and empty V2 review cohorts', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.openRuns = fixture.completedRuns.map((run) => ({ ...run, status: 'open' as const, finalizedAt: undefined, finalizationReason: undefined }));
  fixture.completedRuns = [];
  fixture.sessionReviewsV2 = [];
  fixture.sessionReviewV2Diagnostics = {
    rawProductionCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 0, unsupported_index: 0, invalid_identity: 0, invalid_payload: 0 },
  };
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);
  assert.equal(bundle.overview.totalCompletedRuns, 0);
  assert.equal(bundle.overview.totalOpenRuns, fixture.openRuns.length);
  assert.equal(bundle.sessionReviewAnalytics.summary.reviewCount, 0);
});

test('model quality and timeline retain runtime analytics without removed result fields', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  assert.ok(bundle.modelQuality.rows.length > 0);
  assert.ok(bundle.timeline.rows.length > 0);
  assert.ok(bundle.modelQuality.rows.every((row) => typeof row.runCount === 'number' && typeof row.v2ReviewCount === 'number'));
  assert.ok(bundle.timeline.rows.every((row) => typeof row.averageBusyDurationMs === 'number'));
});

test('verification impact buckets each verification kind by its own count', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  const target = prepared.runs.find((run) => run.status !== 'open')!;
  const sample = prepared.verificationUsage[0]!;
  prepared.verificationUsage = prepared.verificationUsage.filter((row) => row.runId !== target.runId);
  prepared.verificationUsage.push(
    { ...sample, runId: target.runId, kind: 'test', count: 3 },
    { ...sample, runId: target.runId, kind: 'build', count: 1 },
  );
  const rows = buildSiteDataBundle(prepared).verificationImpact.rows;
  assert.ok(rows.some((row) => row.verificationKind === 'test' && row.countBucket === '2-3'));
  assert.ok(rows.some((row) => row.verificationKind === 'build' && row.countBucket === '1'));
});

test('unexpected files and nested directories fail site-data reads', async () => {
  await withTempDir(async (dir) => {
    await writeSiteData(dir, buildSiteDataBundle(prepareSourceAnalytics(await loadFixture())));
    await fs.writeFile(path.join(dir, 'unexpected-artifact.json'), '{}');
    await assert.rejects(() => readSiteDataBundle(dir), /Unexpected JSON file.*unexpected-artifact/);
    await fs.rm(path.join(dir, 'unexpected-artifact.json'));
    await fs.mkdir(path.join(dir, 'extra'));
    await assert.rejects(() => readSiteDataBundle(dir), /Unexpected subdirectory/);
  });
});

test('site data validation rejects malformed tool usage and diagnostics payloads', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const tool = deepClone(bundle) as any;
  tool.toolUsage.rows = [{ callCount: 1, runId: 'run-x' }];
  assert.throws(() => validateSiteDataBundle(tool), /missing toolName/);

  const diagnostics = deepClone(bundle) as any;
  diagnostics.sessionReviewAnalytics.diagnostics.rawProductionCount = 2;
  diagnostics.sessionReviewAnalytics.diagnostics.acceptedCount = 0;
  diagnostics.sessionReviewAnalytics.diagnostics.rejectedCount = 0;
  assert.throws(() => validateSiteDataBundle(diagnostics), /raw count must equal accepted \+ rejected/);
});

test('leaderboard validation requires V2 review evidence, current tiers, and valid intervals', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const missingEvidence = deepClone(bundle) as any;
  delete missingEvidence.modelLeaderboard.rows[0].reviewEvidenceMass;
  assert.throws(() => validateSiteDataBundle(missingEvidence), /reviewEvidenceMass is invalid/);

  const staleTier = deepClone(bundle) as any;
  staleTier.modelLeaderboard.rows[0].evidenceTier = 'invalid';
  assert.throws(() => validateSiteDataBundle(staleTier), /invalid evidenceTier/);

  const invalidProvider = deepClone(bundle) as any;
  invalidProvider.modelLeaderboard.rows[0].providers[0].runCount += 99;
  assert.throws(() => validateSiteDataBundle(invalidProvider), /provider runCount sum/);
});

test('token throughput retains errored tokenless turns and retry timing', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  prepared.turnThroughput.push({
    runId: 'retention-run', endedAt: '2026-05-10T15:00:00.000Z', startedDay: '2026-05-10', modelId: 'gpt-4.1', modelFamily: 'gpt-4.1', provider: null,
    thinkingLevel: 'medium', experimentAssignment: null, outputTokens: 0, generationDurationMs: 0, concurrentBusySessions: 1, status: 'error', tokensPerSecond: null,
    turnLatencyMs: null, overheadMs: null, providerLatencyMs: null, providerQueueMs: null, providerQueueAttemptCount: 0, inputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, contextTokens: null,
  });
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);
  assert.equal(bundle.tokenThroughput.rows.find((row) => row.runId === 'retention-run')?.tokensPerSecond, null);
  assert.equal(bundle.retryTiming.rows[0]?.scheduledDelayMs, 1000);
});
