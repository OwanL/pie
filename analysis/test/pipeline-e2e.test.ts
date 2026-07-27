import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { loadFixture, withTempDir } from './helpers.ts';

test('analysis pipeline prepares, builds, validates, and round-trips the V2-only bundle', async () => {
  const source = await loadFixture();
  const prepared = prepareSourceAnalytics(source);
  const bundle = buildSiteDataBundle(prepared, new Date('2026-07-27T00:00:00.000Z'));

  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);
  assert.equal(bundle.manifest.completedRunCount, prepared.runs.filter((run) => run.status !== 'open').length);
  assert.equal(bundle.overview.totalCompletedRuns, bundle.manifest.completedRunCount);
  assert.equal(bundle.timeline.rows.reduce((sum, row) => sum + row.runCount, 0), bundle.manifest.completedRunCount);
  assert.equal(bundle.modelQuality.rows.reduce((sum, row) => sum + row.runCount, 0), bundle.manifest.completedRunCount);
  assert.deepEqual(bundle.sessionReviewAnalytics.diagnostics, source.sessionReviewV2Diagnostics);

  await withTempDir(async (dir) => {
    await writeSiteData(dir, bundle);
    const roundTrip = await readSiteDataBundle(dir);
    assert.deepEqual(roundTrip, bundle);
  });
});

test('runtime telemetry invariants remain intact across site generation', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  for (const run of bundle.runSummary.rows) {
    assert.ok(run.inputTokens >= 0);
    assert.ok(run.outputTokens >= 0);
    assert.ok(run.busyDurationMs >= 0);
    assert.ok(run.toolCallCount >= run.toolFailureCount);
    assert.ok(run.verificationTotalCount >= run.verificationFailureCount);
    assert.equal(run.lineMutationTotal, run.lineAdditions + run.lineDeletions + run.lineModifications);
    if (run.contextUtilization !== null) assert.ok(run.contextUtilization >= 0 && run.contextUtilization <= 1);
    if (run.cacheHitRatio !== null) assert.ok(run.cacheHitRatio >= 0 && run.cacheHitRatio <= 1);
  }
});

test('V2 leaderboard remains review-only while cost and process diagnostics stay present', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  assert.deepEqual(bundle.modelLeaderboard.sourceWeights, { review: 1, process: 0 });
  assert.ok(Object.values(bundle.modelLeaderboard.weights).every((weight) => weight === 0));
  for (const row of bundle.modelLeaderboard.rows) {
    assert.ok(['review-backed', 'thin-review', 'telemetry-only'].includes(row.evidenceTier));
    assert.equal(typeof row.reviewEvidenceMass, 'number');
    assert.equal(typeof row.processEvidenceMass, 'number');
    assert.ok(row.medianCostUsd === null || row.medianCostUsd >= 0);
    assert.ok(row.medianDurationMs === null || row.medianDurationMs >= 0);
    if (row.rank !== null) {
      assert.ok(row.scoreInterval80);
      assert.ok(row.scoreInterval80!.bestRank <= row.rank);
      assert.ok(row.scoreInterval80!.worstRank >= row.rank);
    }
  }
});

test('tool, verification, throughput, retry, and pruning artifacts remain available', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  assert.ok(Array.isArray(bundle.toolUsage.rows));
  assert.ok(Array.isArray(bundle.verificationImpact.rows));
  assert.ok(Array.isArray(bundle.tokenThroughput.rows));
  assert.ok(Array.isArray(bundle.retryTiming.rows));
  assert.ok(Array.isArray(bundle.pruningImpact.rows));
  assert.ok(Array.isArray(bundle.toolResultPruningImpact.rows));
  assert.ok(bundle.tokenThroughput.notes.length > 0);
  assert.ok(bundle.retryTiming.notes.length > 0);
});
