import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReliability } from '../scripts/site-data.ts';
import { makePrepared, makeReview, makeRun } from './actionability-helpers.ts';

function reviewOnFamily(runId: string, family: string, qualityIndexV1: number, reviewId: string) {
  const run = makeRun({ runId, modelId: family });
  const review = makeReview(run, reviewId, qualityIndexV1);
  return { run, review };
}

test('dominant family share, effective families, and ceiling saturation are computed over reviewed sessions', () => {
  const { run: ra1, review: r1 } = reviewOnFamily('a1', 'glm-5.2', 100, 'r1');
  const { run: ra2, review: r2 } = reviewOnFamily('a2', 'glm-5.2', 100, 'r2');
  const { run: ra3, review: r3 } = reviewOnFamily('a3', 'glm-5.2', 80, 'r3');
  const { run: rb1, review: r4 } = reviewOnFamily('b1', 'claude-sonnet-4', 60, 'r4');
  const data = makePrepared([ra1, ra2, ra3, rb1], [r1, r2, r3, r4]);
  const reliability = createEvidenceReliability(data);

  assert.equal(reliability.reviewedSessionCount, 4);
  assert.equal(reliability.attributedSessionCount, 4);
  assert.equal(reliability.unattributedCount, 0);
  assert.equal(reliability.effectiveReviewedFamilies, 2);
  assert.equal(reliability.dominantFamily!.family, 'glm-5.2');
  assert.equal(reliability.dominantFamily!.share, 0.75);
  assert.equal(reliability.dominantFamily!.reviewedSessionCount, 3);

  assert.equal(reliability.ceilingSaturation.perfectRate, 0.5); // two at 100
  assert.equal(reliability.ceilingSaturation.achievedBandRate, 0.5); // only the two 100s are >= 85 (80 < 85)
  assert.equal(reliability.ceilingSaturation.medianQualityIndexV1, 90); // median of [100,100,80,60] = 90
  assert.equal(reliability.ceilingSaturation.distinctQualityIndexValues, 3); // {100, 80, 60}

  assert.deepEqual(reliability.familyShares.map((s) => s.family), ['glm-5.2', 'claude-sonnet-4']);
  assert.equal(reliability.familyShares[0]!.share, 0.75);
  assert.equal(reliability.familyShares[1]!.share, 0.25);
});

test('a session spanning multiple families is split equally across them', () => {
  const runA = makeRun({ runId: 'a1', modelId: 'glm-5.2' });
  const runB = makeRun({ runId: 'b1', modelId: 'claude-sonnet-4' });
  const review = makeReview(runA, 'r1', 70, { runIds: [runA.runId, runB.runId], modelFamilies: ['glm-5.2', 'claude-sonnet-4'] });
  const data = makePrepared([runA, runB], [review]);
  const reliability = createEvidenceReliability(data);
  assert.equal(reliability.attributedSessionCount, 1);
  assert.equal(reliability.effectiveReviewedFamilies, 2);
  assert.equal(reliability.familyShares.length, 2);
  assert.equal(reliability.familyShares[0]!.reviewedSessionCount, 0.5);
  assert.equal(reliability.familyShares[1]!.reviewedSessionCount, 0.5);
  assert.equal(reliability.familyShares[0]!.share, 0.5);
  // Dominant share ties at 0.5; pick is deterministic (largest mass, then lexicographic).
  assert.ok(['glm-5.2', 'claude-sonnet-4'].includes(reliability.dominantFamily!.family));
  assert.equal(reliability.dominantFamily!.share, 0.5);
});

test('unmatched reviews with stable transcript attribution count toward family reliability', () => {
  const run = makeRun({ runId: 'a1', modelId: 'glm-5.2' });
  const joined = makeReview(run, 'r1', 100);
  const orphan = makeReview(run, 'r2', 100, { runIds: [], joinKey: 'unmatched', unmatchedReason: 'no_run_for_identity', sessionId: 'orphan', modelFamilies: ['claude-opus-5'] });
  const data = makePrepared([run], [joined, orphan]);
  const reliability = createEvidenceReliability(data);
  assert.equal(reliability.reviewedSessionCount, 2);
  assert.equal(reliability.attributedSessionCount, 2);
  assert.equal(reliability.unattributedCount, 0);
  assert.equal(reliability.ceilingSaturation.perfectRate, 1); // both at 100
  assert.equal(reliability.effectiveReviewedFamilies, 2);
  assert.deepEqual(reliability.familyShares.map((entry) => entry.family).sort(), ['claude-opus-5', 'glm-5.2']);
  assert.equal(reliability.dominantFamily!.share, 0.5);
});

test('zero reviews yield an empty but well-formed reliability bundle', () => {
  const reliability = createEvidenceReliability(makePrepared([], []));
  assert.equal(reliability.reviewedSessionCount, 0);
  assert.equal(reliability.attributedSessionCount, 0);
  assert.equal(reliability.unattributedCount, 0);
  assert.equal(reliability.effectiveReviewedFamilies, 0);
  assert.equal(reliability.dominantFamily, null);
  assert.equal(reliability.familyShares.length, 0);
  assert.equal(reliability.ceilingSaturation.perfectRate, 0);
  assert.equal(reliability.ceilingSaturation.medianQualityIndexV1, null);
  assert.ok(reliability.notes.length > 0);
});

test('full ceiling saturation makes the index non-discriminating', () => {
  const run = makeRun({ runId: 'a1', modelId: 'glm-5.2' });
  const reviews = [makeReview(run, 'r1', 100), makeReview(run, 'r2', 100)];
  const reliability = createEvidenceReliability(makePrepared([run], reviews));
  assert.equal(reliability.ceilingSaturation.perfectRate, 1);
  assert.equal(reliability.ceilingSaturation.distinctQualityIndexValues, 1);
});
