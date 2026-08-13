import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSiteDataBundle, validateSiteDataBundle } from '../scripts/site-data.ts';
import { CURRENT_HARNESS_REVISION } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { deepClone, loadFixture } from './helpers.ts';

async function bundle() {
  const fixture = deepClone(await loadFixture());
  for (const run of [...fixture.completedRuns, ...fixture.openRuns]) run.harnessRevision = CURRENT_HARNESS_REVISION;
  return buildSiteDataBundle(prepareSourceAnalytics(fixture));
}

test('numeric validator accepts a valid V2-only bundle', async () => {
  validateSiteDataBundleNumericFields(await bundle());
});

test('numeric validator rejects invalid run telemetry', async () => {
  const data = await bundle();
  data.runSummary.rows[0]!.toolCallCount = Number.NaN;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /toolCallCount must be a finite non-negative number, got NaN/);

  data.runSummary.rows[0]!.toolCallCount = 0;
  data.runSummary.rows[0]!.totalEstimatedCostUsd = -1;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /totalEstimatedCostUsd must be null or a finite non-negative number, got -1/);
});

test('numeric validator rejects invalid aggregate runtime values', async () => {
  const data = await bundle();
  data.overview.toolFailureRate = Number.NaN;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /overview\.toolFailureRate must be null or a finite number, got NaN/);

  data.overview.toolFailureRate = null;
  data.timeline.rows[0]!.runCount = -1;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /timeline\.json row 0\.runCount must be a finite non-negative number, got -1/);
});

test('numeric validator validates V2 ingestion diagnostic counts and quality index', async () => {
  const data = await bundle();
  data.sessionReviewAnalytics.diagnostics.rejectedByReason.invalid_payload = -1;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /rejectedByReason\.invalid_payload must be a finite non-negative integer/);

  data.sessionReviewAnalytics.diagnostics.rejectedByReason.invalid_payload = 0;
  data.sessionReviewAnalytics.summary.meanQualityIndexV1 = 101;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /meanQualityIndexV1 must be null or a finite number in \[0, 100\]/);
});

test('leaderboard validator enforces review-only scoring and current evidence tiers', async () => {
  const data = deepClone(await bundle());
  assert.equal(data.modelLeaderboard.sourceWeights.review, 1);
  assert.equal(data.modelLeaderboard.sourceWeights.process, 0);

  (data.modelLeaderboard.sourceWeights as any).review = 0.9;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /review-only/);

  (data.modelLeaderboard.sourceWeights as any).review = 1;
  data.modelLeaderboard.weights.fileChurn = 0.1;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /process weights must be zero/);
});

test('numeric validator rejects invalid leaderboard coverage and provider transcript telemetry', async () => {
  const data = deepClone(await bundle());
  data.modelLeaderboard.minimumTaskScoringCoverage = Number.POSITIVE_INFINITY;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /minimumTaskScoringCoverage must be a finite number in \[0, 1\]/);

  data.modelLeaderboard.minimumTaskScoringCoverage = 0;
  data.modelLeaderboard.rows[0]!.providers[0]!.transcriptEvidenceMass = Number.NaN;
  assert.throws(() => validateSiteDataBundleNumericFields(data), /transcriptEvidenceMass must be a finite non-negative number, got NaN/);
});

test('structural validator rejects stale schema before row fields', async () => {
  const data = deepClone(await bundle()) as any;
  data.manifest.schemaVersion = 2;
  delete data.modelLeaderboard.rows[0].reviewEvidenceMass;
  assert.throws(() => validateSiteDataBundle(data), /schemaVersion mismatch: expected 7, got 2/);
});
