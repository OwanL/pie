import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SessionReviewV2Source, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle, validateSiteDataBundle } from '../scripts/site-data.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { coerceSessionReviewV2 } from '../scripts/review-analytics.ts';
import { deepClone, loadFixture } from './helpers.ts';

const V2_FIXTURE = fileURLToPath(new URL('../fixtures/session-reviews-v2.jsonl', import.meta.url));
const RAW_V2_REVIEW = JSON.parse((await fs.readFile(V2_FIXTURE, 'utf8')).trim()) as Record<string, unknown>;

function review(reviewId: string, sessionId: string, path: string): SessionReviewV2Source {
  return { ...coerceSessionReviewV2(deepClone(RAW_V2_REVIEW))!, reviewId, sessionId, sessionPathAtReview: path, identityFallback: false };
}

function emptyDiagnostics(count: number) {
  return {
    rawProductionCount: count,
    acceptedCount: count,
    rejectedCount: 0,
    rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 0, unsupported_index: 0, invalid_identity: 0, invalid_payload: 0 },
  };
}

/**
 * Simulate `queryAllRunAnalyticsStores` merging two workspace stores into one
 * payload (the same runId can appear under old and new repo paths). The merged
 * payload must dedupe by runId and aggregate reviews across both stores.
 */
test('merged multi-store payload dedupes by runId and aggregates reviews across workspaces', async () => {
  const base = deepClone(await loadFixture());
  const runA = base.completedRuns[0]!; // run-001, workspace A
  const runB = base.completedRuns[1]!; // run-002, workspace B

  // The same run recorded under an old repo path (workspace B), newer updatedAt,
  // different model — dedupe must keep the newer closed version.
  const runAMigrated = deepClone(runA);
  runAMigrated.updatedAt = '2030-01-01T00:00:00.000Z';
  runAMigrated.modelId = 'claude-sonnet-4';

  // Stable headers so reviews join across the merged set.
  runA.sessionId = 'sess-A';
  runAMigrated.sessionId = 'sess-A';
  runB.sessionId = 'sess-B';

  const merged: SourceAnalyticsPayload = {
    ...base,
    workspaceKey: 'all',
    completedRuns: [runA, runAMigrated, runB],
    openRuns: [],
    sessionReviewsV2: [
      review('rev-A', 'sess-A', runA.sessionPath),
      review('rev-B', 'sess-B', runB.sessionPath),
    ],
    sessionReviewV2Diagnostics: emptyDiagnostics(2),
  };

  const prepared = prepareSourceAnalytics(merged);

  // run-001 appears twice; only the newer (migrated) version survives.
  const run001s = prepared.runs.filter((r) => r.runId === runA.runId);
  assert.equal(run001s.length, 1);
  assert.equal(run001s[0]!.modelFamily, 'claude-sonnet-4');
  assert.equal(run001s[0]!.sessionId, 'sess-A');

  // Both reviews join across the merged workspace set.
  assert.equal(prepared.sessionReviewsV2.length, 2);
  assert.ok(prepared.sessionReviewsV2.every((r) => r.joinKey === 'session_id'));
  assert.equal(prepared.reviewJoinCoverage.totalReviews, 2);
  assert.equal(prepared.reviewJoinCoverage.joinedCount, 2);

  // Actionability bundles aggregate across both workspaces' families.
  const bundle = buildSiteDataBundle(prepared);
  assert.equal(bundle.evidenceReliability.effectiveReviewedFamilies, 2);
  assert.ok(bundle.outcomeCorrelations.analyzableSessionCount >= 1);
});

test('the full bundle validates (structural + numeric) after cross-workspace aggregation', async () => {
  const base = deepClone(await loadFixture());
  const runA = base.completedRuns[0]!;
  runA.sessionId = 'sess-A';
  const merged: SourceAnalyticsPayload = {
    ...base,
    workspaceKey: 'all',
    completedRuns: [...base.completedRuns, deepClone(runA)],
    openRuns: [],
    sessionReviewsV2: [review('rev-A', 'sess-A', runA.sessionPath)],
    sessionReviewV2Diagnostics: emptyDiagnostics(1),
  };
  const prepared = prepareSourceAnalytics(merged);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);
  assert.equal(bundle.manifest.completedRunCount, prepared.runs.filter((r) => r.status !== 'open').length);
});
