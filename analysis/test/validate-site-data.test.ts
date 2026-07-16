import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSiteDataBundle, validateSiteDataBundle } from '../scripts/site-data.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { deepClone, loadFixture } from './helpers.ts';

test('validateSiteDataBundleNumericFields accepts a valid bundle', async () => {
  const fixture = await loadFixture();
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundleNumericFields(bundle);
});

test('validateSiteDataBundleNumericFields rejects NaN count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.toolCallCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.toolCallCount must be a finite non-negative number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields rejects Infinity count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.outputTokens = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.outputTokens must be a finite non-negative number, got Infinity/,
  );
});

test('validateSiteDataBundleNumericFields rejects negative count fields in run summary', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.toolFailureCount = -3;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.toolFailureCount must be a finite non-negative number, got -3/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN nullable estimated cost', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.estimatedCostUsd = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.estimatedCostUsd must be null or a finite non-negative number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields allows null estimated cost and satisfaction', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.runSummary.rows[0]!.estimatedCostUsd = null;
  bundle.runSummary.rows[0]!.satisfaction = null;
  validateSiteDataBundleNumericFields(bundle);
});

test('validateSiteDataBundleNumericFields validates satisfaction bounds', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.overview.averageSatisfaction = 5.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.averageSatisfaction must be null or a finite number in \[1, 5\], got 5\.5/,
  );

  bundle.overview.averageSatisfaction = 0.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.averageSatisfaction must be null or a finite number in \[1, 5\], got 0\.5/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN in overview averages', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.overview.toolFailureRate = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /overview\.toolFailureRate must be null or a finite number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields rejects invalid complete and subagent costs', async () => {
  const fixture = deepClone(await loadFixture());
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  bundle.runSummary.rows[0]!.totalEstimatedCostUsd = -1;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.totalEstimatedCostUsd must be null or a finite non-negative number, got -1/,
  );

  bundle.runSummary.rows[0]!.totalEstimatedCostUsd = null;
  bundle.runSummary.rows[0]!.subagentEstimatedCostUsd = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /run-summary\.json row 0\.subagentEstimatedCostUsd must be null or a finite non-negative number, got NaN/,
  );
});

test('validateSiteDataBundleNumericFields rejects NaN in aggregate rows', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.modelQuality.rows[0]!.runCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-quality\.json row 0\.runCount must be a finite non-negative number, got NaN/,
  );

  bundle.modelQuality.rows[0]!.runCount = 0;
  bundle.modelQuality.rows[0]!.averageSatisfaction = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-quality\.json row 0\.averageSatisfaction must be null or a finite number in \[1, 5\], got Infinity/,
  );
});

test('validateSiteDataBundleNumericFields rejects invalid bias-aware leaderboard fields', async () => {
  const fixture = deepClone(await loadFixture());
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  bundle.modelLeaderboard.rows[0]!.effectiveTaskCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-leaderboard\.json row 0\.effectiveTaskCount must be a finite non-negative integer, got NaN/,
  );

  bundle.modelLeaderboard.rows[0]!.effectiveTaskCount = 0;
  bundle.modelLeaderboard.rows[0]!.attributableTaskCount = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-leaderboard\.json row 0\.attributableTaskCount must be a finite non-negative integer, got NaN/,
  );

  bundle.modelLeaderboard.rows[0]!.attributableTaskCount = 0;
  bundle.modelLeaderboard.minimumTaskScoringCoverage = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-leaderboard\.json minimumTaskScoringCoverage must be a finite number in \[0, 1\], got Infinity/,
  );

  bundle.modelLeaderboard.minimumTaskScoringCoverage = 0.40;
  bundle.modelLeaderboard.caseMix.initialUserMessageCoverage = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /model-leaderboard\.json caseMix\.initialUserMessageCoverage must be a finite non-negative number, got Infinity/,
  );
});

test('leaderboard validator enforces schema 5 and semantic constraints', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  assert.equal(bundle.manifest.schemaVersion, 5);
  assert.equal(bundle.modelLeaderboard.schemaVersion, 5);

  const stale = deepClone(bundle) as any;
  stale.manifest.schemaVersion = 2;
  delete stale.modelLeaderboard.rows[0].attributableTaskCount;
  assert.throws(
    () => validateSiteDataBundle(stale),
    /manifest\.json schemaVersion mismatch: expected 5, got 2\. Regenerate site data/,
    'schema mismatch must be reported before v5 field errors',
  );

  const threshold = deepClone(bundle);
  threshold.modelLeaderboard.minimumTaskScoringCoverage = 1.01;
  assert.throws(
    () => validateSiteDataBundleNumericFields(threshold),
    /minimumTaskScoringCoverage must be a finite number in \[0, 1\]/,
  );

  const coverage = deepClone(bundle);
  coverage.modelLeaderboard.rows[0]!.scoringCoverage = 1.01;
  assert.throws(
    () => validateSiteDataBundleNumericFields(coverage),
    /scoringCoverage must be a finite number in \[0, 1\]/,
  );

  const fractionalTasks = deepClone(bundle);
  fractionalTasks.modelLeaderboard.rows[0]!.effectiveTaskCount = 1.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(fractionalTasks),
    /effectiveTaskCount must be a finite non-negative integer/,
  );

  const processWeight = deepClone(bundle);
  processWeight.modelLeaderboard.weights.fileChurn = 0.1;
  assert.throws(
    () => validateSiteDataBundleNumericFields(processWeight),
    /process weights must be zero/,
  );

  const outcomeWeights = deepClone(bundle);
  outcomeWeights.modelLeaderboard.weights.satisfaction = 0.5;
  assert.throws(
    () => validateSiteDataBundleNumericFields(outcomeWeights),
    /satisfaction and resolution weights must sum to 1/,
  );

  const invalidSourceWeights = deepClone(bundle);
  (invalidSourceWeights.modelLeaderboard.sourceWeights as any).user = 0.9;
  assert.throws(
    () => validateSiteDataBundleNumericFields(invalidSourceWeights),
    /sourceWeights must sum to 1/,
  );
});

test('validateSiteDataBundleNumericFields rejects negative timeline counts', async () => {
  const fixture = deepClone(await loadFixture());
  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);

  bundle.timeline.rows[0]!.runCount = -1;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /timeline\.json row 0\.runCount must be a finite non-negative number, got -1/,
  );
});

test('validateSiteDataBundleNumericFields rejects invalid provider transcript fields', async () => {
  const fixture = deepClone(await loadFixture());
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  bundle.modelLeaderboard.rows[0]!.providers[0]!.transcriptOnlySessionCount = -1;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /providers\[0\]\.transcriptOnlySessionCount must be a finite non-negative number, got -1/,
  );

  bundle.modelLeaderboard.rows[0]!.providers[0]!.transcriptOnlySessionCount = 0;
  bundle.modelLeaderboard.rows[0]!.providers[0]!.transcriptEvidenceMass = Number.NaN;
  assert.throws(
    () => validateSiteDataBundleNumericFields(bundle),
    /providers\[0\]\.transcriptEvidenceMass must be a finite non-negative number, got NaN/,
  );
});
