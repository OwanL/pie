import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashCanonicalJson } from '../../extensions/session-reviewer/src/hash.ts';
import type { ClassifiedCriterion, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { coerceSessionReviewV2, deriveReviewAttainment } from '../scripts/review-analytics.ts';
import { coerceSourceAnalyticsPayload } from '../scripts/source.ts';
import { readSessionReviewsV2 } from '../scripts/transcript-source.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

const V2_FIXTURE = fileURLToPath(new URL('../fixtures/session-reviews-v2.jsonl', import.meta.url));
const RAW_V2_REVIEW = JSON.parse((await fs.readFile(V2_FIXTURE, 'utf8')).trim()) as Record<string, any>;

function criterion(overrides: Partial<ClassifiedCriterion>): ClassifiedCriterion {
  return {
    criterionId: 'criterion', statement: 'criterion', origin: 'explicit', importance: 'core',
    taxonomy: { activity: 'implement', surface: ['application_logic'], evidenceMode: ['automated_check'] },
    status: 'met', reason: 'none', evidenceRefs: [], ...overrides,
  };
}

function asSmallOnly(raw: Record<string, any>): Record<string, any> {
  const review = deepClone(raw);
  for (const entry of [...review.proposals, review.consolidation, ...review.components]) {
    entry.requestedBucket = 'small';
    entry.bucket = 'small';
    entry.bucketDowngraded = false;
  }
  return review;
}

async function sourceWithReview(): Promise<SourceAnalyticsPayload> {
  const source = deepClone(await loadFixture());
  const review = coerceSessionReviewV2(deepClone(RAW_V2_REVIEW));
  assert.ok(review);
  const run = source.completedRuns[0]!;
  run.sessionId = review.sessionId;
  source.sessionReviewsV2 = [review];
  source.sessionReviewV2Diagnostics = {
    rawProductionCount: 1, acceptedCount: 1, rejectedCount: 0,
    rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 0, unsupported_index: 0, invalid_identity: 0, invalid_payload: 0 },
  };
  return source;
}

test('V2-only fixture ingests canonical production review', async () => {
  const sidecar = await readSessionReviewsV2(V2_FIXTURE);
  assert.equal(sidecar.reviews.length, 1);
  assert.equal(sidecar.reviews[0]!.sessionId, 'session-v2-fixture');
  assert.equal(sidecar.reviews[0]!.rubricVersion, 'session-review-v2.1');
  assert.equal(sidecar.reviews[0]!.indexVersion, 'v1');
  assert.deepEqual(sidecar.diagnostics, {
    rawProductionCount: 1, acceptedCount: 1, rejectedCount: 0,
    rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 0, unsupported_index: 0, invalid_identity: 0, invalid_payload: 0 },
  });
});

test('V2 ingestion records coarse stable rejection diagnostics and ignores V1 lines', async () => {
  await withTempDir(async (dir) => {
    const sidecarPath = path.join(dir, 'reviews.jsonl');
    const badRubric = { ...deepClone(RAW_V2_REVIEW), reviewId: 'bad-rubric', rubricVersion: 'session-review-v2' };
    const badIndex = { ...deepClone(RAW_V2_REVIEW), reviewId: 'bad-index', indexVersion: 'v2' };
    const badPayload = deepClone(RAW_V2_REVIEW);
    badPayload.reviewId = 'bad-payload';
    badPayload.frozenLedgerSha256 = '0'.repeat(64);
    const legacy = { sessionPath: 'C:/legacy.jsonl', rating: 5, completion: 'fully' };
    await fs.writeFile(sidecarPath, [RAW_V2_REVIEW, badRubric, badIndex, badPayload, legacy].map((value) => JSON.stringify(value)).join('\n'));

    const sidecar = await readSessionReviewsV2(sidecarPath);
    assert.equal(sidecar.reviews.length, 1);
    assert.deepEqual(sidecar.diagnostics, {
      rawProductionCount: 4, acceptedCount: 1, rejectedCount: 3,
      rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 1, unsupported_index: 1, invalid_identity: 0, invalid_payload: 1 },
    });
  });
});

test('portable source coercion retains V2 ingestion diagnostics', async () => {
  const payload = deepClone(await loadFixture()) as any;
  const invalid = deepClone(RAW_V2_REVIEW);
  invalid.sessionId = '';
  payload.sessionReviewsV2 = [RAW_V2_REVIEW, invalid];
  const source = coerceSourceAnalyticsPayload(payload);
  assert.equal(source.sessionReviewsV2?.length, 1);
  assert.equal(source.sessionReviewV2Diagnostics.rawProductionCount, 2);
  assert.equal(source.sessionReviewV2Diagnostics.acceptedCount, 1);
  assert.equal(source.sessionReviewV2Diagnostics.rejectedCount, 1);
  assert.equal(source.sessionReviewV2Diagnostics.rejectedByReason.invalid_identity, 1);
});

test('portable source coercion keeps the first canonical production review', async () => {
  const payload = deepClone(await loadFixture()) as any;
  payload.sessionReviewsV2 = [
    { ...deepClone(RAW_V2_REVIEW), reviewId: 'review-first' },
    { ...deepClone(RAW_V2_REVIEW), reviewId: 'review-duplicate', reviewedAt: '2026-07-25T10:20:00.000Z' },
  ];
  const source = coerceSourceAnalyticsPayload(payload);
  assert.deepEqual(source.sessionReviewsV2?.map((review) => review.reviewId), ['review-first']);
  assert.equal(source.sessionReviewV2Diagnostics.acceptedCount, 2);
});

test('V2 coercion accepts canonical frozen-ledger hashes after key reordering', () => {
  const review = deepClone(RAW_V2_REVIEW);
  const criterion = review.frozenLedger[0];
  review.frozenLedger[0] = {
    importance: criterion.importance,
    statement: criterion.statement,
    criterionId: criterion.criterionId,
    taxonomy: { evidenceMode: criterion.taxonomy.evidenceMode, surface: criterion.taxonomy.surface, activity: criterion.taxonomy.activity },
    origin: criterion.origin,
  };
  const canonicalHash = hashCanonicalJson(review.frozenLedger);
  review.frozenLedgerSha256 = canonicalHash;
  review.consolidation.frozenLedgerSha256 = canonicalHash;
  review.provenance.pipeline.frozenLedgerSha256 = canonicalHash;
  assert.ok(coerceSessionReviewV2(review));
});

test('V2 coercion enforces rubric and index versions', () => {
  assert.ok(coerceSessionReviewV2(deepClone(RAW_V2_REVIEW)));
  const oldRubric = deepClone(RAW_V2_REVIEW);
  oldRubric.rubricVersion = 'session-review-v2';
  assert.equal(coerceSessionReviewV2(oldRubric), null);
  const wrongIndex = deepClone(RAW_V2_REVIEW);
  wrongIndex.indexVersion = 'v2';
  assert.equal(coerceSessionReviewV2(wrongIndex), null);
});

test('V2 coercion accepts consolidation without a redundant frozen ledger', () => {
  const review = deepClone(RAW_V2_REVIEW);
  delete review.consolidation.frozenLedger;
  delete review.consolidation.frozenLedgerSha256;
  assert.ok(coerceSessionReviewV2(review), 'simplified consolidation (no frozen ledger) is accepted');

  const mismatched = deepClone(RAW_V2_REVIEW);
  mismatched.consolidation.frozenLedgerSha256 = '0'.repeat(64);
  assert.equal(coerceSessionReviewV2(mismatched), null, 'supplied consolidation frozen ledger must still match');
});

test('V2 coercion accepts mixed and small-only profiles with matching orchestration buckets', () => {
  assert.ok(coerceSessionReviewV2(deepClone(RAW_V2_REVIEW)), 'small+medium profile is accepted');
  const smallOnly = asSmallOnly(RAW_V2_REVIEW);
  assert.ok(coerceSessionReviewV2(smallOnly), 'small+small profile is accepted');

  const mixedSmallConsolidation = deepClone(RAW_V2_REVIEW);
  mixedSmallConsolidation.consolidation.requestedBucket = 'small';
  mixedSmallConsolidation.consolidation.bucket = 'small';
  assert.equal(coerceSessionReviewV2(mixedSmallConsolidation), null, 'small consolidation is rejected for mixed profile');
  const downgradedMixedConsolidation = deepClone(RAW_V2_REVIEW);
  downgradedMixedConsolidation.consolidation.bucket = 'small';
  downgradedMixedConsolidation.consolidation.bucketDowngraded = true;
  assert.ok(coerceSessionReviewV2(downgradedMixedConsolidation), 'mixed-profile consolidation may downgrade effectively to small');

  const smallOnlyMediumConsolidation = asSmallOnly(RAW_V2_REVIEW);
  smallOnlyMediumConsolidation.consolidation.requestedBucket = 'medium';
  smallOnlyMediumConsolidation.consolidation.bucket = 'medium';
  assert.equal(coerceSessionReviewV2(smallOnlyMediumConsolidation), null, 'medium consolidation is rejected for small-only profile');
});

test('V2 coercion rejects incomplete and non-canonical envelopes', () => {
  const rejects = (mutate: (review: Record<string, any>) => void): void => {
    const review = deepClone(RAW_V2_REVIEW);
    mutate(review);
    assert.equal(coerceSessionReviewV2(review), null);
  };
  rejects((review) => { review.schemaVersion = 3; });
  rejects((review) => { delete review.provenance.evidenceManifest; });
  rejects((review) => { delete review.components[0].promptHash; });
  rejects((review) => { delete review.components[0].classifications.process; });
  rejects((review) => { review.ledger[0].status = 'unmet'; review.ledger[0].reason = 'incorrect_result'; });
});

test('V2 coercion rejects removed finding, amendment, and reviewer-check schema surfaces', () => {
  const rejects = (mutate: (review: Record<string, any>) => void): void => {
    const review = deepClone(RAW_V2_REVIEW);
    mutate(review);
    assert.equal(coerceSessionReviewV2(review), null);
  };
  rejects((review) => { review.ledger[0].findingRefs = []; });
  rejects((review) => { review.amendments = []; });
  rejects((review) => { review.findings = []; });
  rejects((review) => { review.reviewerChecks = []; });
  rejects((review) => { review.reviewerChecksSha256 = '0'.repeat(64); });
  rejects((review) => { review.proposals[0].findings = []; });
  rejects((review) => { review.proposals[0].candidateChecks = []; });
  rejects((review) => { review.components[0].classifications.findings = []; });
  rejects((review) => { review.components[0].classifications.proposedAmendments = []; });
  rejects((review) => { review.provenance.pipeline.reviewerChecksSha256 = '0'.repeat(64); });
  rejects((review) => { review.provenance.pipeline.amendmentIds = []; });
});

test('V2 loader keeps the first canonical production review per stable sessionId', async () => {
  const older = { ...deepClone(RAW_V2_REVIEW), reviewId: 'review-older', reviewedAt: '2026-07-23T10:20:00.000Z' };
  const newer = { ...deepClone(RAW_V2_REVIEW), reviewId: 'review-newer', reviewedAt: '2026-07-25T10:20:00.000Z' };
  await withTempDir(async (dir) => {
    const sidecarPath = path.join(dir, 'reviews.jsonl');
    await fs.writeFile(sidecarPath, [JSON.stringify(older), JSON.stringify(newer)].join('\n'));
    const sidecar = await readSessionReviewsV2(sidecarPath);
    assert.deepEqual(sidecar.reviews.map((review) => review.reviewId), ['review-older']);
    assert.equal(sidecar.diagnostics.acceptedCount, 2);
  });
});

test('derived attainment reports delivered and controllable V2 quality', () => {
  const ledger = [
    criterion({ criterionId: 'core', status: 'met' }),
    criterion({ criterionId: 'external', importance: 'supporting', status: 'blocked', reason: 'external_blocker' }),
    criterion({ criterionId: 'unknown', importance: 'optional', status: 'not_assessable', reason: 'human_evidence_missing' }),
  ];
  const attainment = deriveReviewAttainment(ledger);
  assert.equal(attainment.deliveredOverall, 'mostly_achieved');
  assert.equal(attainment.controllableOverall, 'achieved');
  assert.equal(attainment.qualityIndexV1, 100);

  const allExternal = deriveReviewAttainment([criterion({ status: 'blocked', reason: 'external_blocker' })]);
  assert.equal(allExternal.controllableOverall, 'not_assessable');
  assert.equal(allExternal.qualityIndexV1, null);

  const partial = deriveReviewAttainment([
    criterion({ criterionId: 'core', status: 'partly_met', reason: 'attempt_failed' }),
    ...Array.from({ length: 8 }, (_, index) => criterion({ criterionId: `optional-${index}`, importance: 'optional' })),
  ]);
  assert.equal(partial.controllableOverall, 'partly_achieved');
  assert.ok(partial.qualityIndexV1! >= 25 && partial.qualityIndexV1! <= 59);
});

test('V2 preparation joins by stable sessionId and carries ingestion diagnostics', async () => {
  const source = await sourceWithReview();
  const prepared = prepareSourceAnalytics(source);
  const review = prepared.sessionReviewsV2[0]!;
  assert.equal(review.joinKey, 'session_id');
  assert.deepEqual(review.runIds, [source.completedRuns[0]!.runId]);
  assert.equal(review.attainment.qualityIndexV1, 100);
  assert.deepEqual(prepared.sessionReviewV2Diagnostics, source.sessionReviewV2Diagnostics);
});
