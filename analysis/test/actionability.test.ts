import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EvidenceReliabilityData,
  OutcomeCorrelationData,
  OutcomeCorrelationDimension,
  ReviewJoinCoverage,
} from '../scripts/contracts.ts';
import {
  CEILING_PERFECT_THRESHOLD,
  DOMINANT_SHARE_THRESHOLD,
  MIN_ANALYZABLE_SESSIONS,
  MIN_EFFECTIVE_FAMILIES,
  MIN_GROUP_N,
  assessReliability,
  deriveActionabilityInsights,
  differenceExcludesZero,
  largestDifference,
  renderInsightCards,
} from '../site/actionability.ts';

function ci(lower: number, upper: number) {
  return { lower, upper, level: 0.95 as const };
}

function diff(
  referenceValue: string,
  comparisonValue: string,
  observedMeanDifference: number,
  differenceCi95: { lower: number; upper: number; level: 0.95 } | null,
  referenceSessionCount: number,
  comparisonSessionCount: number,
): OutcomeCorrelationDimension['differences'][number] {
  return { referenceValue, comparisonValue, observedMeanDifference, differenceCi95, referenceSessionCount, comparisonSessionCount };
}

function dimension(
  name: OutcomeCorrelationDimension['dimension'],
  groups: OutcomeCorrelationDimension['groups'],
  differences: OutcomeCorrelationDimension['differences'],
): OutcomeCorrelationDimension {
  return {
    dimension: name,
    description: 'test dimension',
    includedSessionCount: groups.reduce((sum, g) => sum + g.sessionCount, 0),
    untrackedSessionCount: 0,
    groups,
    differences,
  };
}

function group(value: string, sessionCount: number, mean: number, meanCi95: ReturnType<typeof ci> | null) {
  return { value, sessionCount, meanQualityIndexV1: mean, meanCi95 };
}

function reliableEvidence(): EvidenceReliabilityData {
  return {
    schemaVersion: 7,
    cohortLabel: 'test',
    reviewedSessionCount: 40,
    attributedSessionCount: 40,
    unattributedCount: 0,
    effectiveReviewedFamilies: 5,
    dominantFamily: { family: 'family-a', share: 0.4, reviewedSessionCount: 16 },
    ceilingSaturation: { perfectRate: 0.2, achievedBandRate: 0.3, medianQualityIndexV1: 80, distinctQualityIndexValues: 12 },
    familyShares: [],
    notes: [],
  };
}

function joinCoverage(unmatched = 2, total = 40): ReviewJoinCoverage {
  return {
    totalReviews: total,
    joinedCount: total - unmatched,
    unmatchedCount: unmatched,
    byJoinKey: { session_id: total - unmatched, path_fallback: 0, unmatched },
    unmatchedByReason: { no_run_for_identity: unmatched, identity_conflict_at_path: 0 },
  };
}

function correlations(dimensions: OutcomeCorrelationDimension[], analyzable = 30): OutcomeCorrelationData {
  return {
    schemaVersion: 7,
    cohortLabel: 'test',
    outcomeMetric: 'qualityIndexV1',
    outcomeSource: 'canonical_v2_qualityIndexV1_unchanged',
    unitOfAnalysis: 'session',
    analyzableSessionCount: analyzable,
    unmatchedExcludedCount: 0,
    dimensions,
    notes: [],
  };
}

test('differenceExcludesZero is true only when the CI lies entirely above or below zero', () => {
  assert.equal(differenceExcludesZero(diff('a', 'b', 10, ci(2, 18), 10, 10)), true);
  assert.equal(differenceExcludesZero(diff('a', 'b', -10, ci(-18, -2), 10, 10)), true);
  assert.equal(differenceExcludesZero(diff('a', 'b', 5, ci(-3, 13), 10, 10)), false);
  assert.equal(differenceExcludesZero(diff('a', 'b', 5, null, 10, 10)), false);
});

test('largestDifference picks the largest-magnitude difference', () => {
  const dim = dimension('thinkingLevel', [], [
    diff('medium', 'low', 5, ci(-1, 11), 10, 10),
    diff('medium', 'high', 17, ci(8, 26), 10, 10),
  ]);
  assert.equal(largestDifference(dim)!.comparisonValue, 'high');
});

test('a clear, well-powered difference yields an actionable card with quantified evidence', () => {
  const dim = dimension('thinkingLevel', [
    group('medium', 18, 82, ci(70, 94)),
    group('high', 8, 92, ci(79, 105)),
  ], [diff('medium', 'high', 10.5, ci(2.5, 18.5), 18, 8)]);
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  const card = result.cards.find((c) => c.id === 'behavior-thinkingLevel')!;
  assert.equal(card.tone, 'actionable');
  assert.match(card.finding, /high.*10\.5 points higher than medium/);
  assert.match(card.finding, /95% CI 2\.5 to 18\.5/);
  assert.match(card.evidence, /n=8 vs n=18/);
  assert.match(card.caveat, /Observational/);
  assert.match(card.caveat, /not prove the behavior caused/);
  assert.equal(result.evidenceTooSkewed, false);
});

test('a difference whose CI crosses zero is downgraded to a caveat, not actionable', () => {
  const dim = dimension('verificationUsage', [
    group('verified', 22, 88, ci(80, 96)),
    group('unverified', 10, 89, ci(72, 106)),
  ], [diff('verified', 'unverified', 1, ci(-17, 19), 22, 10)]);
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  const card = result.cards.find((c) => c.id === 'behavior-verificationUsage')!;
  assert.equal(card.tone, 'caveat');
  assert.match(card.caveat, /crosses zero/);
  assert.match(card.caveat, /could be noise/);
});

test('a low-N group produces a low-N warning in the caveat', () => {
  const dim = dimension('compaction', [
    group('none', 23, 90, ci(82, 98)),
    group('compacted', 3, 83, ci(60, 100)),
  ], [diff('none', 'compacted', -7, ci(-25, 11), 23, 3)]);
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  const card = result.cards.find((c) => c.id === 'behavior-compaction')!;
  assert.equal(card.tone, 'caveat');
  assert.match(card.evidence, /low-N/);
  assert.match(card.caveat, new RegExp(`fewer than ${MIN_GROUP_N}`));
});

test('single-group dimensions produce no behavioral card', () => {
  const dim = dimension('pruningMode', [group('auto', 30, 88, ci(81, 95))], []);
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  assert.ok(!result.cards.some((c) => c.id === 'behavior-pruningMode'));
});

test('reliability cards surface join loss, dominant skew, and ceiling saturation', () => {
  const result = deriveActionabilityInsights({ correlations: correlations([]), reliability: reliableEvidence(), joinCoverage: joinCoverage(5, 40) });
  assert.ok(result.cards.some((c) => c.id === 'reliability-join-loss' && c.tone === 'reliability'));
  assert.ok(result.cards.some((c) => c.id === 'reliability-dominant-skew'));
  assert.ok(result.cards.some((c) => c.id === 'reliability-ceiling'));
  const join = result.cards.find((c) => c.id === 'reliability-join-loss')!;
  assert.match(join.finding, /5 of 40/);
  assert.match(join.evidence, /No run found: 5/);
  assert.match(join.evidence, /Identity conflict: 0/);
  assert.ok(!join.evidence.includes('no_run_for_identity'), 'raw reason identifier must not leak into the evidence text');
  assert.ok(!join.evidence.includes('identity_conflict_at_path'), 'raw reason identifier must not leak into the evidence text');
});

test('too-skewed evidence emits a no-recommendation card and downgrades behavioral cards', () => {
  const skewed: EvidenceReliabilityData = {
    ...reliableEvidence(),
    effectiveReviewedFamilies: 2,
    dominantFamily: { family: 'family-a', share: 0.85, reviewedSessionCount: 34 },
    ceilingSaturation: { perfectRate: 0.6, achievedBandRate: 0.65, medianQualityIndexV1: 100, distinctQualityIndexValues: 8 },
  };
  const dim = dimension('thinkingLevel', [
    group('medium', 18, 82, ci(70, 94)),
    group('high', 8, 92, ci(79, 105)),
  ], [diff('medium', 'high', 10, ci(2, 18), 18, 8)]);
  const result = deriveActionabilityInsights({ correlations: correlations([dim], 30), reliability: skewed, joinCoverage: joinCoverage() });
  assert.equal(result.evidenceTooSkewed, true);
  const noRec = result.cards.find((c) => c.tone === 'no-recommendation');
  assert.ok(noRec, 'a no-recommendation card must be emitted');
  assert.match(noRec!.finding, /dominates 85%/);
  assert.match(noRec!.finding, /perfect score/);
  // Even a clear difference is downgraded to caveat when evidence is skewed.
  const behavior = result.cards.find((c) => c.id === 'behavior-thinkingLevel')!;
  assert.equal(behavior.tone, 'caveat');
  assert.match(behavior.caveat, /too skewed to turn this into a recommendation/);
});

test('assessReliability flags each skew reason against its threshold', () => {
  const a = assessReliability(reliableEvidence(), correlations([], 30));
  assert.equal(a.tooSkewed, false);
  const sparse = assessReliability(reliableEvidence(), correlations([], MIN_ANALYZABLE_SESSIONS - 1));
  assert.ok(sparse.reasons.some((r) => r.includes('analyzable')));
  const skewed = assessReliability(
    { ...reliableEvidence(), dominantFamily: { family: 'x', share: DOMINANT_SHARE_THRESHOLD + 0.01, reviewedSessionCount: 1 } },
    correlations([], 30),
  );
  assert.ok(skewed.reasons.some((r) => r.includes('dominates')));
  const fewFamilies = assessReliability(
    { ...reliableEvidence(), effectiveReviewedFamilies: MIN_EFFECTIVE_FAMILIES - 1 },
    correlations([], 30),
  );
  assert.ok(fewFamilies.reasons.some((r) => r.includes('effective reviewed families')));
  const ceiling = assessReliability(
    { ...reliableEvidence(), ceilingSaturation: { perfectRate: CEILING_PERFECT_THRESHOLD + 0.01, achievedBandRate: 0.6, medianQualityIndexV1: 100, distinctQualityIndexValues: 5 } },
    correlations([], 30),
  );
  assert.ok(ceiling.reasons.some((r) => r.includes('perfect score')));
});

test('renderInsightCards emits accessible article markup with tone classes', () => {
  const dim = dimension('thinkingLevel', [
    group('medium', 18, 82, ci(70, 94)),
    group('high', 8, 92, ci(79, 105)),
  ], [diff('medium', 'high', 10, ci(2, 18), 18, 8)]);
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  const html = renderInsightCards(result);
  assert.match(html, /class="insight-card insight-actionable"/);
  assert.match(html, /aria-label=/);
  assert.ok(result.cards.length > 0);
});

test('renderInsightCards shows an empty state when no bundles are present', () => {
  const html = renderInsightCards({ cards: [], evidenceTooSkewed: false, skewReasons: [] });
  assert.match(html, /empty-state/);
});

test('all behavioral cards use observational-not-causal language', () => {
  const dims = [
    dimension('verificationUsage', [group('verified', 20, 88, ci(80, 96)), group('unverified', 10, 80, ci(60, 100))], [diff('verified', 'unverified', 8, ci(1, 15), 20, 10)]),
    dimension('thinkingLevel', [group('medium', 18, 82, ci(70, 94)), group('high', 8, 92, ci(79, 105))], [diff('medium', 'high', 10, ci(2, 18), 18, 8)]),
  ];
  const result = deriveActionabilityInsights({ correlations: correlations(dims), reliability: reliableEvidence(), joinCoverage: joinCoverage() });
  for (const card of result.cards.filter((c) => c.id.startsWith('behavior-'))) {
    assert.match(card.caveat, /Observational/);
    assert.match(card.caveat, /not .*caus/);
  }
});

test('renderInsightCards escapes data-derived model/group strings to prevent HTML injection', () => {
  const maliciousGroup = '<script>alert(1)</script>';
  const maliciousFamily = '<img src=x onerror=alert(1)>';
  const dim = dimension('thinkingLevel', [
    group('medium', 18, 82, ci(70, 94)),
    group(maliciousGroup, 8, 92, ci(79, 105)),
  ], [diff('medium', maliciousGroup, 10, ci(2, 18), 18, 8)]);
  const reliability: EvidenceReliabilityData = {
    ...reliableEvidence(),
    dominantFamily: { family: maliciousFamily, share: 0.4, reviewedSessionCount: 16 },
  };
  const result = deriveActionabilityInsights({ correlations: correlations([dim]), reliability, joinCoverage: joinCoverage() });
  const html = renderInsightCards(result);
  // Raw markup must not survive into the rendered HTML.
  assert.ok(!html.includes('<script>'), 'raw <script> tag must be escaped');
  assert.ok(!html.includes('</script>'), 'raw closing script tag must be escaped');
  assert.ok(!html.includes('<img'), 'raw <img tag must be escaped');
  // The escaped entities must be present, proving the value rendered as inert text.
  assert.ok(html.includes('&lt;script&gt;'), 'group value must be entity-escaped');
  assert.ok(html.includes('&lt;img'), 'dominant family must be entity-escaped');
});
