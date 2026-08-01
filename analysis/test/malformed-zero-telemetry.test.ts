import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle, validateSiteDataBundle } from '../scripts/site-data.ts';
import { validateSiteDataBundleNumericFields } from '../scripts/validate-site-data.ts';
import { coerceSourceAnalyticsPayload } from '../scripts/source.ts';
import { makePrepared, makeReview, makeRun } from './actionability-helpers.ts';

/** Recursively assert no NaN/Infinity leaks into any emitted numeric field. */
function assertNoNaNInfinity(value: unknown, path = 'bundle'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value} (NaN/Infinity leaked)`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNaNInfinity(entry, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertNoNaNInfinity(entry, `${path}.${key}`);
    }
  }
}

function minimalZeroRun() {
  return {
    sessionPath: '/tmp/session.jsonl',
    runId: 'run-zero',
    taskGroupId: 'task-zero',
    status: 'closed',
    startedAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    sendCount: 0,
    assistantTurnCount: 0,
    assistantTurnDurationMs: 0,
    busyDurationMs: 0,
    busyPeriodCount: 0,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 0,
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: {},
    fileMutation: {},
    fileExtensions: {},
    verification: {},
  };
}

test('a minimal zero-telemetry raw payload coerces, prepares, builds, and validates without NaN', () => {
  const raw = {
    schemaVersion: 1,
    exportedAt: '2026-07-24T00:00:00.000Z',
    workspaceKey: 'zero-telemetry',
    completedRuns: [minimalZeroRun()],
    openRuns: [],
    pruningDecisions: [],
    pruningEvents: [],
    toolResultPruningEvents: [],
  };
  const source = coerceSourceAnalyticsPayload(raw) as SourceAnalyticsPayload;
  assert.equal(source.sessionReviewV2Diagnostics.rawProductionCount, 0);

  const prepared = prepareSourceAnalytics(source);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);
  assertNoNaNInfinity(bundle);

  assert.equal(bundle.sessionReviewAnalytics.joinCoverage.totalReviews, 0);
  assert.equal(bundle.outcomeCorrelations.analyzableSessionCount, 0);
  assert.equal(bundle.evidenceReliability.reviewedSessionCount, 0);
});

test('an entirely empty source produces a valid, NaN-free bundle', () => {
  const bundle = buildSiteDataBundle(makePrepared([], []));
  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);
  assertNoNaNInfinity(bundle);
  assert.equal(bundle.manifest.completedRunCount, 0);
  assert.equal(bundle.outcomeCorrelations.dimensions.length, 6);
  assert.equal(bundle.evidenceReliability.effectiveReviewedFamilies, 0);
});

test('not-assessable reviews (null qualityIndexV1) are excluded from outcome correlations and reliability', () => {
  const run = makeRun({ runId: 'r1', modelId: 'glm-5.2', verificationTotalCount: 1, initialUserMessageChars: 10 });
  const notAssessable = makeReview(run, 'na', null);
  const scored = makeReview(run, 'sc', 100);
  const bundle = buildSiteDataBundle(makePrepared([run], [notAssessable, scored]));
  validateSiteDataBundle(bundle);
  assertNoNaNInfinity(bundle);
  // Only the scored review has an outcome to correlate.
  assert.equal(bundle.outcomeCorrelations.analyzableSessionCount, 1);
  assert.equal(bundle.outcomeCorrelations.unmatchedExcludedCount, 0);
  assert.equal(bundle.evidenceReliability.reviewedSessionCount, 1);
  assert.equal(bundle.evidenceReliability.ceilingSaturation.perfectRate, 1);
});

test('a run with null functional settings and untracked behaviors still yields finite correlation groups', () => {
  const run = makeRun({ runId: 'r1', modelId: 'glm-5.2', verificationTotalCount: 0, fsPruningMode: null, fsSubagentAlwaysParentModel: null, initialUserMessageChars: null, thinkingLevel: null });
  const bundle = buildSiteDataBundle(makePrepared([run], [makeReview(run, 'r', 70)]));
  validateSiteDataBundle(bundle);
  validateSiteDataBundleNumericFields(bundle);
  assertNoNaNInfinity(bundle);

  const pruning = bundle.outcomeCorrelations.dimensions.find((d) => d.dimension === 'pruningMode')!;
  assert.equal(pruning.untrackedSessionCount, 1);
  assert.equal(pruning.differences.length, 0); // untracked excluded
  const thinking = bundle.outcomeCorrelations.dimensions.find((d) => d.dimension === 'thinkingLevel')!;
  assert.equal(thinking.untrackedSessionCount, 1);
  const prompt = bundle.outcomeCorrelations.dimensions.find((d) => d.dimension === 'promptSizeBand')!;
  assert.equal(prompt.untrackedSessionCount, 1);
});
