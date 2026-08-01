import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutcomeCorrelationDimension } from '../scripts/contracts.ts';
import { MODEL_PALETTE, modelColorScale } from '../site/lib.ts';
import { dimensionTitle, evidenceReliabilityHtml, outcomeDimensionSpec } from '../site/charts/outcomes.ts';

function ci(lower: number, upper: number) {
  return { lower, upper, level: 0.95 as const };
}

function dim(
  name: OutcomeCorrelationDimension['dimension'],
  groups: OutcomeCorrelationDimension['groups'],
  differences: OutcomeCorrelationDimension['differences'] = [],
): OutcomeCorrelationDimension {
  return {
    dimension: name,
    description: 'test',
    includedSessionCount: groups.reduce((s, g) => s + g.sessionCount, 0),
    untrackedSessionCount: 0,
    groups,
    differences,
  };
}

function specLayers(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  return spec.layer as Array<Record<string, unknown>>;
}

test('outcomeDimensionSpec renders group means as points with 95% CI rules and n labels', () => {
  const dimension = dim('verificationUsage', [
    { value: 'verified', sessionCount: 22, meanQualityIndexV1: 88, meanCi95: ci(80, 96) },
    { value: 'unverified', sessionCount: 10, meanQualityIndexV1: 80, meanCi95: ci(60, 100) },
  ]);
  const spec = outcomeDimensionSpec(dimension)!;
  assert.equal(spec.width, 'container');
  const layers = specLayers(spec);
  // rule (CI), circle (mean), text (n label)
  assert.equal(layers.length, 3);
  assert.equal((layers[0]!.mark as { type: string }).type, 'rule');
  assert.equal((layers[1]!.mark as { type: string }).type, 'circle');
  assert.equal((layers[2]!.mark as { type: string }).type, 'text');
  const yScale = ((layers[1]!.encoding as { y: { scale: { domain: number[] } } }).y).scale;
  assert.deepEqual(yScale.domain, [0, 100]);
  assert.ok(typeof spec.description === 'string' && spec.description.length > 0);
});

test('a group with n<5 is flagged low-N in its label and the chart description', () => {
  const dimension = dim('compaction', [
    { value: 'none', sessionCount: 23, meanQualityIndexV1: 90, meanCi95: ci(82, 98) },
    { value: 'compacted', sessionCount: 3, meanQualityIndexV1: 83, meanCi95: ci(60, 100) },
  ]);
  const spec = outcomeDimensionSpec(dimension)!;
  const values = (spec.data as { values: Array<{ nLabel: string }> }).values;
  const compacted = values.find((v) => v.nLabel.includes('low-N'));
  assert.ok(compacted, 'the low-N group must carry a low-N label');
  assert.match(spec.description as string, /fewer than 5 sessions/);
});

test('a single-group dimension still renders without crashing', () => {
  const dimension = dim('pruningMode', [
    { value: 'auto', sessionCount: 30, meanQualityIndexV1: 88, meanCi95: ci(81, 95) },
  ]);
  const spec = outcomeDimensionSpec(dimension);
  assert.ok(spec !== null);
});

test('a dimension with no groups returns null', () => {
  assert.equal(outcomeDimensionSpec(dim('pruningMode', [], [])), null);
});

test('a group with a null CI (n<2) still plots its mean point', () => {
  const dimension = dim('thinkingLevel', [
    { value: 'low', sessionCount: 1, meanQualityIndexV1: 100, meanCi95: null },
    { value: 'medium', sessionCount: 18, meanQualityIndexV1: 82, meanCi95: ci(70, 94) },
  ]);
  const spec = outcomeDimensionSpec(dimension)!;
  const values = (spec.data as { values: Array<{ value: string; ciAvailable: boolean }> }).values;
  assert.ok(values.some((v) => v.value === 'low' && !v.ciAvailable));
  assert.ok(values.some((v) => v.value === 'medium' && v.ciAvailable));
});

test('dimensionTitle maps every dimension name to a human label', () => {
  const names: OutcomeCorrelationDimension['dimension'][] = ['verificationUsage', 'compaction', 'thinkingLevel', 'promptSizeBand', 'pruningMode', 'subagentParentModel'];
  for (const name of names) {
    const title = dimensionTitle({ dimension: name, description: '', includedSessionCount: 0, untrackedSessionCount: 0, groups: [], differences: [] });
    assert.ok(title.length > 0);
    assert.notEqual(title, name);
  }
});

test('evidenceReliabilityHtml surfaces join loss, dominant skew, and ceiling saturation', () => {
  const correlations = { schemaVersion: 7, cohortLabel: 'x', outcomeMetric: 'qualityIndexV1' as const, outcomeSource: 'canonical_v2_qualityIndexV1_unchanged' as const, unitOfAnalysis: 's', analyzableSessionCount: 32, unmatchedExcludedCount: 11, dimensions: [], notes: [] };
  const reliability = { schemaVersion: 7, cohortLabel: 'x', reviewedSessionCount: 43, attributedSessionCount: 32, unattributedCount: 11, effectiveReviewedFamilies: 6, dominantFamily: { family: 'gpt-5.6-sol', share: 0.8125, reviewedSessionCount: 26 }, ceilingSaturation: { perfectRate: 0.5349, achievedBandRate: 0.5581, medianQualityIndexV1: 100, distinctQualityIndexValues: 21 }, familyShares: [], notes: [] };
  const joinCoverage = { totalReviews: 43, joinedCount: 32, unmatchedCount: 11, byJoinKey: { session_id: 32, path_fallback: 0, unmatched: 11 }, unmatchedByReason: { no_run_for_identity: 11, identity_conflict_at_path: 0 } };
  const html = evidenceReliabilityHtml(correlations as never, reliability as never, joinCoverage as never);
  assert.match(html, /Review join loss/);
  assert.match(html, /11\/43/);
  assert.match(html, /Dominant-model skew/);
  assert.match(html, /gpt-5\.6-sol/);
  assert.match(html, /Ceiling saturation/);
  assert.match(html, /Analyzable cohort/);
});

test('evidenceReliabilityHtml shows an empty state when all bundles are absent', () => {
  const html = evidenceReliabilityHtml(null, null, null);
  assert.match(html, /empty-state/);
});

test('evidenceReliabilityHtml renders friendly unmatched-reason labels, not raw identifiers, with precise titles', () => {
  const correlations = { schemaVersion: 7, cohortLabel: 'x', outcomeMetric: 'qualityIndexV1' as const, outcomeSource: 'canonical_v2_qualityIndexV1_unchanged' as const, unitOfAnalysis: 's', analyzableSessionCount: 32, unmatchedExcludedCount: 11, dimensions: [], notes: [] };
  const reliability = { schemaVersion: 7, cohortLabel: 'x', reviewedSessionCount: 43, attributedSessionCount: 32, unattributedCount: 11, effectiveReviewedFamilies: 6, dominantFamily: { family: 'gpt-5.6-sol', share: 0.8125, reviewedSessionCount: 26 }, ceilingSaturation: { perfectRate: 0.5349, achievedBandRate: 0.5581, medianQualityIndexV1: 100, distinctQualityIndexValues: 21 }, familyShares: [], notes: [] };
  const joinCoverage = { totalReviews: 43, joinedCount: 32, unmatchedCount: 11, byJoinKey: { session_id: 32, path_fallback: 0, unmatched: 11 }, unmatchedByReason: { no_run_for_identity: 7, identity_conflict_at_path: 4 } };
  const html = evidenceReliabilityHtml(correlations as never, reliability as never, joinCoverage as never);
  // Raw data identifiers must never appear as visible text.
  assert.ok(!html.includes('no_run_for_identity'), 'raw no_run_for_identity must not render');
  assert.ok(!html.includes('identity_conflict_at_path'), 'raw identity_conflict_at_path must not render');
  // Friendly labels render with their counts.
  assert.match(html, /No run found<\/abbr>: 7/);
  assert.match(html, /Identity conflict<\/abbr>: 4/);
  // Precise meaning is retained via title attributes on the labels.
  assert.match(html, /title="[^"]*stable session identity[^"]*"/);
  assert.match(html, /title="[^"]*different session identity[^"]*"/);
});

test('modelColorScale uses the extended palette so >5 families do not collide', () => {
  assert.ok(MODEL_PALETTE.length >= 10, 'palette must hold at least 10 distinct colors');
  const five = modelColorScale(['a', 'b', 'c', 'd', 'e']);
  assert.equal((five as { range: string[] }).range.length, MODEL_PALETTE.length);
  const nine = modelColorScale(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  // 9 ≤ palette length, so it still returns the full brand range (no collision).
  assert.equal((nine as { range: string[] }).range.length, MODEL_PALETTE.length);
  const tooMany = modelColorScale(Array.from({ length: MODEL_PALETTE.length + 1 }, (_, i) => `m${i}`));
  // Beyond the palette, fall back to a scheme rather than cycling/colliding.
  assert.ok('scheme' in tooMany);
});

test('evidenceReliabilityHtml escapes the dominant model family to prevent HTML injection', () => {
  const correlations = { schemaVersion: 7, cohortLabel: 'x', outcomeMetric: 'qualityIndexV1' as const, outcomeSource: 'canonical_v2_qualityIndexV1_unchanged' as const, unitOfAnalysis: 's', analyzableSessionCount: 32, unmatchedExcludedCount: 11, dimensions: [], notes: [] };
  const reliability = { schemaVersion: 7, cohortLabel: 'x', reviewedSessionCount: 43, attributedSessionCount: 32, unattributedCount: 11, effectiveReviewedFamilies: 6, dominantFamily: { family: '<script>alert(1)</script>', share: 0.8125, reviewedSessionCount: 26 }, ceilingSaturation: { perfectRate: 0.5349, achievedBandRate: 0.5581, medianQualityIndexV1: 100, distinctQualityIndexValues: 21 }, familyShares: [], notes: [] };
  const joinCoverage = { totalReviews: 43, joinedCount: 32, unmatchedCount: 11, byJoinKey: { session_id: 32, path_fallback: 0, unmatched: 11 }, unmatchedByReason: { no_run_for_identity: 11, identity_conflict_at_path: 0 } };
  const html = evidenceReliabilityHtml(correlations as never, reliability as never, joinCoverage as never);
  assert.ok(!html.includes('<script>'), 'raw <script> tag must be escaped');
  assert.ok(!html.includes('</script>'), 'raw closing script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'dominant family must be entity-escaped');
});
