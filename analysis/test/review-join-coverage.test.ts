import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SessionReviewV2Source, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { createModelLeaderboard } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { coerceSessionReviewV2 } from '../scripts/review-analytics.ts';
import { createEvidenceReliability } from '../scripts/site-data.ts';
import { sessionPathHash } from '../scripts/hash.ts';
import { deepClone, loadFixture } from './helpers.ts';

const V2_FIXTURE = fileURLToPath(new URL('../fixtures/session-reviews-v2.jsonl', import.meta.url));
const RAW_V2_REVIEW = JSON.parse((await fs.readFile(V2_FIXTURE, 'utf8')).trim()) as Record<string, unknown>;

function baseReview(overrides: Partial<SessionReviewV2Source> & { reviewId: string; sessionId: string; sessionPathAtReview: string }): SessionReviewV2Source {
  const coerced = coerceSessionReviewV2(deepClone(RAW_V2_REVIEW))!;
  return { ...coerced, ...overrides };
}

function emptyDiagnostics(count: number) {
  return {
    rawProductionCount: count,
    acceptedCount: count,
    rejectedCount: 0,
    rejectedByReason: { unsupported_schema: 0, unsupported_rubric: 0, unsupported_index: 0, invalid_identity: 0, invalid_payload: 0 },
  };
}

test('join coverage classifies session_id, path_fallback, and both unmatched reasons without heuristic joins', async () => {
  const source = deepClone(await loadFixture());
  const [runA, runB, , runD] = source.completedRuns;

  // A: stable session-header id on the run → joined by session_id.
  runA!.sessionId = 'sess-A';
  const reviewA = baseReview({ reviewId: 'review-A', sessionId: 'sess-A', sessionPathAtReview: runA!.sessionPath, identityFallback: false });

  // B: run has no header; review identity is a path-hash fallback at the same path → path_fallback.
  const reviewB = baseReview({
    reviewId: 'review-B',
    sessionId: sessionPathHash(runB!.sessionPath),
    sessionPathAtReview: runB!.sessionPath,
    identityFallback: true,
  });

  // C: review identity matches no run and its path matches no run → no_run_for_identity.
  const reviewC = baseReview({ reviewId: 'review-C', sessionId: 'sess-C', sessionPathAtReview: '/orphan/session.jsonl', identityFallback: false });

  // D: a run exists at the review's exact path but carries a different stable header → identity_conflict_at_path.
  runD!.sessionId = 'sess-D-header';
  const reviewD = baseReview({ reviewId: 'review-D', sessionId: 'sess-D', sessionPathAtReview: runD!.sessionPath, identityFallback: false });

  source.sessionReviewsV2 = [reviewA, reviewB, reviewC, reviewD];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(4);
  const prepared = prepareSourceAnalytics(source);

  const byId = new Map(prepared.sessionReviewsV2.map((review) => [review.reviewId, review]));
  assert.equal(byId.get('review-A')!.joinKey, 'session_id');
  assert.equal(byId.get('review-A')!.unmatchedReason, null);
  assert.equal(byId.get('review-B')!.joinKey, 'path_fallback');
  assert.equal(byId.get('review-B')!.unmatchedReason, null);
  assert.equal(byId.get('review-C')!.joinKey, 'unmatched');
  assert.equal(byId.get('review-C')!.unmatchedReason, 'no_run_for_identity');
  assert.equal(byId.get('review-D')!.joinKey, 'unmatched');
  assert.equal(byId.get('review-D')!.unmatchedReason, 'identity_conflict_at_path');

  const coverage = prepared.reviewJoinCoverage;
  assert.deepEqual(coverage, {
    totalReviews: 4,
    joinedCount: 2,
    unmatchedCount: 2,
    byJoinKey: { session_id: 1, path_fallback: 1, unmatched: 2 },
    unmatchedByReason: { no_run_for_identity: 1, identity_conflict_at_path: 1 },
  });
});

test('stable transcript attribution is retained when a valid review has no run', async () => {
  const source = deepClone(await loadFixture());
  source.completedRuns = [];
  source.openRuns = [];
  source.historicalSessions = [{
    sessionId: 'sess-transcript', normalizedSessionPath: '/orphan/transcript.jsonl',
    startedAt: '2026-05-10T12:00:00.000Z', endedAt: '2026-05-10T12:05:00.000Z', firstUserMessageChars: 100,
    attributions: [{
      modelId: 'claude-opus-5', thinkingLevel: 'high', share: 1,
      successfulAssistantTurns: 1, attributedTokens: 100,
    }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['configured'],
  }];
  source.sessionReviewsV2 = [baseReview({
    reviewId: 'review-transcript', sessionId: 'sess-transcript', sessionPathAtReview: '/orphan/transcript.jsonl', identityFallback: false,
  })];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(1);

  const review = prepareSourceAnalytics(source).sessionReviewsV2[0]!;
  assert.equal(review.joinKey, 'unmatched');
  assert.equal(review.unmatchedReason, 'no_run_for_identity');
  assert.deepEqual(review.runIds, []);
  assert.deepEqual(review.modelFamilies, ['claude-opus-5']);
});

test('stable transcript attribution survives preparation into evidence reliability when coverage is missing', async () => {
  const source = deepClone(await loadFixture());
  source.completedRuns = [];
  source.openRuns = [];
  source.historicalSessions = [{
    sessionId: 'sess-reliability', normalizedSessionPath: '/orphan/reliability.jsonl',
    startedAt: '2026-05-10T12:00:00.000Z', endedAt: '2026-05-10T12:05:00.000Z', firstUserMessageChars: 100,
    attributions: [{
      modelId: 'claude-opus-5', thinkingLevel: 'high', share: 1,
      successfulAssistantTurns: 1, attributedTokens: 100,
    }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['configured'],
  }];
  source.sessionReviewsV2 = [baseReview({
    reviewId: 'review-reliability', sessionId: 'sess-reliability', sessionPathAtReview: '/orphan/reliability.jsonl', identityFallback: false,
  })];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(1);

  const prepared = prepareSourceAnalytics(source);
  const review = prepared.sessionReviewsV2[0]!;
  assert.equal(review.joinKey, 'unmatched');
  assert.equal(review.unmatchedReason, 'no_run_for_identity');
  assert.deepEqual(review.runIds, []);
  assert.deepEqual(review.modelFamilies, ['claude-opus-5']);

  const reliability = createEvidenceReliability(prepared);
  assert.equal(reliability.reviewedSessionCount, 1);
  assert.equal(reliability.attributedSessionCount, 1);
  assert.equal(reliability.unattributedCount, 0);
  assert.equal(reliability.effectiveReviewedFamilies, 1);
  assert.deepEqual(reliability.familyShares.map((entry) => entry.family), ['claude-opus-5']);
  assert.equal(reliability.familyShares[0]!.reviewedSessionCount, 1);
  assert.equal(reliability.familyShares[0]!.share, 1);
  assert.equal(reliability.dominantFamily!.family, 'claude-opus-5');
});

test('stable transcript attribution remains safe when a run at the same path has a conflicting identity', async () => {
  const source = deepClone(await loadFixture());
  const [run] = source.completedRuns;
  run!.sessionId = 'different-run-session';
  source.completedRuns = [run!];
  source.openRuns = [];
  source.historicalSessions = [{
    sessionId: 'reviewed-transcript-session', normalizedSessionPath: run!.sessionPath,
    startedAt: '2026-05-10T12:00:00.000Z', endedAt: '2026-05-10T12:05:00.000Z', firstUserMessageChars: 100,
    attributions: [{
      modelId: 'claude-opus-5', thinkingLevel: 'high', share: 1,
      successfulAssistantTurns: 1, attributedTokens: 100,
    }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['configured'],
  }];
  source.sessionReviewsV2 = [baseReview({
    reviewId: 'review-conflict', sessionId: 'reviewed-transcript-session', sessionPathAtReview: run!.sessionPath, identityFallback: false,
  })];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(1);

  const prepared = prepareSourceAnalytics(source);
  const review = prepared.sessionReviewsV2[0]!;
  assert.equal(review.joinKey, 'unmatched');
  assert.equal(review.unmatchedReason, 'identity_conflict_at_path');
  assert.deepEqual(review.modelFamilies, ['claude-opus-5']);
  const opus = createModelLeaderboard(prepared).rows.find((row) => row.modelId === 'claude-opus-5')!;
  assert.equal(opus.reviewEvidenceMass, 1);
  assert.equal(opus.transcriptOnlySessionCount, 1);
  assert.equal(opus.providers[0]!.transcriptEvidenceMass, 1);
});

test('path-fallback review does not manufacture a join against a run carrying a different stable header', async () => {
  // A fallback review (path-hash identity) at a path whose run carries a stable
  // header must NOT be joined by path — that would risk a false attribution.
  // It is reported as identity_conflict_at_path, never silently joined.
  const source = deepClone(await loadFixture());
  const [run] = source.completedRuns;
  run!.sessionId = 'stable-header-X';
  const review = baseReview({
    reviewId: 'review-fallback',
    sessionId: sessionPathHash(run!.sessionPath),
    sessionPathAtReview: run!.sessionPath,
    identityFallback: true,
  });
  source.sessionReviewsV2 = [review];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(1);
  const prepared = prepareSourceAnalytics(source);
  const row = prepared.sessionReviewsV2[0]!;
  assert.equal(row.joinKey, 'unmatched');
  assert.equal(row.unmatchedReason, 'identity_conflict_at_path');
  assert.deepEqual(row.runIds, []);
});

test('join coverage is all-zero and consistent when there are no reviews', async () => {
  const source: SourceAnalyticsPayload = deepClone(await loadFixture());
  source.sessionReviewsV2 = [];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(0);
  const prepared = prepareSourceAnalytics(source);
  assert.deepEqual(prepared.reviewJoinCoverage, {
    totalReviews: 0,
    joinedCount: 0,
    unmatchedCount: 0,
    byJoinKey: { session_id: 0, path_fallback: 0, unmatched: 0 },
    unmatchedByReason: { no_run_for_identity: 0, identity_conflict_at_path: 0 },
  });
});

test('a non-fallback review propagates its stable id to a no-header run at the same path', async () => {
  // The sound propagation path: a stable-id review at path P lets a no-header
  // run at path P inherit that id, so the review joins by session_id (not unmatched).
  const source = deepClone(await loadFixture());
  const [run] = source.completedRuns;
  // run has no header sessionId; the review attests the stable id for its path.
  const review = baseReview({ reviewId: 'review-propagate', sessionId: 'stable-propagated', sessionPathAtReview: run!.sessionPath, identityFallback: false });
  source.sessionReviewsV2 = [review];
  source.sessionReviewV2Diagnostics = emptyDiagnostics(1);
  const prepared = prepareSourceAnalytics(source);
  const row = prepared.sessionReviewsV2[0]!;
  assert.equal(row.joinKey, 'session_id');
  assert.equal(row.sessionId, 'stable-propagated');
  assert.equal(prepared.runs.find((r) => r.runId === run!.runId)!.identityFallback, false);
  assert.deepEqual(row.runIds, [run!.runId]);
});
