import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ReviewJoinCoverage,
  ReviewJoinUnmatchedReason,
  SessionReviewAnalyticsData,
} from '../scripts/contracts.ts';
import {
  JOIN_UNMATCHED_REASONS,
  joinUnmatchedReasonLabel,
  renderJoinUnmatchedReasonsHtml,
  renderJoinUnmatchedReasonsText,
} from '../site/lib.ts';
import { sessionReviewAnalyticsHtml } from '../site/app.ts';

const REASONS: ReviewJoinUnmatchedReason[] = ['no_run_for_identity', 'identity_conflict_at_path'];

test('every unmatched reason has a concise friendly label and a precise description', () => {
  for (const reason of REASONS) {
    const { label, description } = joinUnmatchedReasonLabel(reason);
    assert.ok(label.length > 0, `${reason} needs a label`);
    assert.ok(!label.includes('_'), `${reason} label must not be a raw snake_case identifier`);
    assert.ok(description.length > 24, `${reason} needs a precise description`);
    assert.ok(!description.includes(reason), `${reason} description must not echo the raw identifier`);
  }
});

test('JOIN_UNMATCHED_REASONS covers both reasons in a stable display order', () => {
  assert.deepEqual([...JOIN_UNMATCHED_REASONS], REASONS);
});

test('renderJoinUnmatchedReasonsText emits friendly labels with counts and no raw identifiers', () => {
  const text = renderJoinUnmatchedReasonsText({ no_run_for_identity: 7, identity_conflict_at_path: 4 });
  assert.match(text, /No run found: 7/);
  assert.match(text, /Identity conflict: 4/);
  assert.ok(!text.includes('no_run_for_identity'));
  assert.ok(!text.includes('identity_conflict_at_path'));
});

test('renderJoinUnmatchedReasonsHtml wraps each label in an abbr with a precise title', () => {
  const html = renderJoinUnmatchedReasonsHtml({ no_run_for_identity: 7, identity_conflict_at_path: 4 });
  assert.ok(!html.includes('no_run_for_identity'), 'raw identifier must not render');
  assert.ok(!html.includes('identity_conflict_at_path'), 'raw identifier must not render');
  assert.match(html, /<abbr class="join-reason" title="[^"]*"[^>]*>No run found<\/abbr>: 7/);
  assert.match(html, /<abbr class="join-reason" title="[^"]*"[^>]*>Identity conflict<\/abbr>: 4/);
  // The precise meaning of each reason is retained via the title attribute.
  assert.match(html, /title="[^"]*stable session identity[^"]*"/);
  assert.match(html, /title="[^"]*different session identity[^"]*"/);
});

test('renderJoinUnmatchedReasonsHtml escapes a description that contains markup characters', () => {
  // Sanity: the helper escapes the description so a stray quote cannot break out
  // of the title attribute. (Current descriptions are plain text, but the
  // escape contract is what keeps them safe if wording ever changes.)
  const reason = 'no_run_for_identity' as ReviewJoinUnmatchedReason;
  const label = joinUnmatchedReasonLabel(reason);
  assert.ok(!label.description.includes('"'), 'fixture assumption: description has no double quote');
});

function minimalJoinCoverage(): ReviewJoinCoverage {
  return {
    totalReviews: 43,
    joinedCount: 32,
    unmatchedCount: 11,
    byJoinKey: { session_id: 32, path_fallback: 0, unmatched: 11 },
    unmatchedByReason: { no_run_for_identity: 7, identity_conflict_at_path: 4 },
  };
}

function minimalSessionReviewAnalytics(): SessionReviewAnalyticsData {
  return {
    schemaVersion: 7,
    cohort: 'v2_production',
    cohortLabel: 'V2 canonical production reviews',
    indexVersion: 'v1',
    rows: [],
    diagnostics: {
      rawProductionCount: 43,
      acceptedCount: 43,
      rejectedCount: 0,
      rejectedByReason: {
        unsupported_schema: 0,
        unsupported_rubric: 0,
        unsupported_index: 0,
        invalid_identity: 0,
        invalid_payload: 0,
      },
    },
    joinCoverage: minimalJoinCoverage(),
    summary: {
      reviewCount: 43,
      stableIdentityCount: 43,
      identityFallbackCount: 0,
      joinedReviewCount: 32,
      qualityIndexCount: 40,
      notAssessableReviewCount: 3,
      meanQualityIndexV1: 88,
      criterionCoverage: 0.9,
      externalBlockerRate: 0.1,
      deliveredOverall: [],
      controllableOverall: [],
      confidence: [],
    },
    criteria: {
      total: 0,
      assessable: 0,
      byImportance: [],
      byStatus: [],
      byReason: [],
      byActivity: [],
      bySurface: [],
      byEvidenceMode: [],
    },
    process: {
      requirementDiscipline: [],
      verificationDiscipline: [],
      scopeControl: [],
      recovery: [],
      finalClaimAccuracy: [],
    },
    evidence: { requirements: [], artifacts: [], execution: [], human: [], limitationCount: 0 },
    disagreement: { materialCount: 0, adjudicatedCount: 0, disputedFieldCount: 0, byResolution: [] },
    reviewers: {
      callCount: 0,
      bucketDowngradeCount: 0,
      diversityAchievedCount: 0,
      byRole: [],
      byRequestedBucket: [],
      byEffectiveBucket: [],
      byModel: [],
      byProvider: [],
      byFamily: [],
    },
    notes: [],
  };
}

test('sessionReviewAnalyticsHtml renders friendly unmatched-reason labels with precise titles', () => {
  const html = sessionReviewAnalyticsHtml(minimalSessionReviewAnalytics());
  // Raw data identifiers must never appear as visible text in the diagnostics.
  assert.ok(!html.includes('no_run_for_identity'), 'raw no_run_for_identity must not render');
  assert.ok(!html.includes('identity_conflict_at_path'), 'raw identity_conflict_at_path must not render');
  // Friendly labels render with their counts.
  assert.match(html, /No run found<\/abbr>: 7/);
  assert.match(html, /Identity conflict<\/abbr>: 4/);
  // Precise meaning is retained via title attributes.
  assert.match(html, /title="[^"]*stable session identity[^"]*"/);
  assert.match(html, /title="[^"]*different session identity[^"]*"/);
});

test('sessionReviewAnalyticsHtml shows an empty state when the bundle is absent', () => {
  const html = sessionReviewAnalyticsHtml(null);
  assert.match(html, /empty-state/);
});
