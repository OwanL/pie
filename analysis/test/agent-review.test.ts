import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentReviewSourceEvent, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { coerceSourceAnalyticsPayload, loadSourceAnalytics } from '../scripts/source.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { LEADERBOARD_MINIMUM_SCORED_RUNS } from '../scripts/leaderboard-scoring.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

const SCHEMA_VERSION = 1;

function makeReview(
  sessionPath: string,
  runId: string,
  opts: {
    rating?: number;
    completion?: 'fully' | 'partial' | 'setback';
    done?: boolean;
    reviewerBuckets?: string[];
    reviewerCount?: number;
    taskGroupId?: string;
    recordedAt?: string;
  } = {},
): AgentReviewSourceEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'agent_review',
    recordedAt: opts.recordedAt ?? '2026-07-04T09:00:00.000Z',
    sessionPath,
    runId,
    taskGroupId: opts.taskGroupId ?? 'task-001',
    done: opts.done ?? true,
    rating: opts.rating ?? 4,
    completion: opts.completion ?? 'fully',
    reason: 'looks good',
    evaluatedAt: '2026-07-04T09:01:00.000Z',
    reviewerBuckets: opts.reviewerBuckets ?? ['medium'],
    reviewerCount: opts.reviewerCount ?? 1,
  };
}

test('coerceSourceAnalyticsPayload ingests and filters agentReviews', async () => {
  const fixture = await loadFixture();
  const targetRun = fixture.completedRuns[0]!;
  const payload: SourceAnalyticsPayload = {
    ...fixture,
    agentReviews: [
      makeReview(targetRun.sessionPath, targetRun.runId, { rating: 5, reviewerBuckets: ['medium', 'small'], reviewerCount: 2 }),
      makeReview(targetRun.sessionPath, targetRun.runId, { rating: 3, completion: 'partial' }),
      // Malformed entries below must be dropped:
      { schemaVersion: SCHEMA_VERSION, kind: 'run_outcome', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 4, completion: 'fully', reason: '', evaluatedAt: 'x', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // wrong kind
      { schemaVersion: SCHEMA_VERSION, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: 'yes', rating: 4, completion: 'fully', reason: '', evaluatedAt: 'x', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // non-boolean done
      { schemaVersion: SCHEMA_VERSION, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 'high', completion: 'fully', reason: '', evaluatedAt: 'x', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // non-number rating
      { schemaVersion: SCHEMA_VERSION, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 4, completion: 'bogus', reason: '', evaluatedAt: 'x', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // invalid completion
      { schemaVersion: SCHEMA_VERSION, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 4, completion: 'fully', reason: '', evaluatedAt: 'x', reviewerBuckets: ['medium', 7], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // non-string bucket
      { schemaVersion: SCHEMA_VERSION, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 4, completion: 'fully', reason: '', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // missing evaluatedAt
      { schemaVersion: 999, kind: 'agent_review', recordedAt: 'x', sessionPath: 's', runId: 'r', taskGroupId: 't', done: true, rating: 4, completion: 'fully', reason: '', evaluatedAt: 'x', reviewerBuckets: [], reviewerCount: 1 } as unknown as AgentReviewSourceEvent, // wrong schemaVersion
      'not-an-object' as unknown as AgentReviewSourceEvent,
    ],
  };

  const coerced = coerceSourceAnalyticsPayload(payload);
  assert.equal(coerced.agentReviews.length, 2, 'only the two well-formed reviews survive coercion');
  assert.equal(coerced.agentReviews[0]!.rating, 5);
  assert.deepEqual(coerced.agentReviews[0]!.reviewerBuckets, ['medium', 'small']);
  assert.equal(coerced.agentReviews[0]!.reviewerCount, 2);
  assert.equal(coerced.agentReviews[1]!.completion, 'partial');
});

test('coerceSourceAnalyticsPayload tolerates a missing agentReviews array', async () => {
  const fixture = deepClone(await loadFixture());
  const { agentReviews: _ignored, ...without } = fixture;
  const coerced = coerceSourceAnalyticsPayload(without);
  assert.deepEqual(coerced.agentReviews, []);
});

test('prepareSourceAnalytics joins agent reviews to runs by sessionPathHash + runId', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0]!;
  const sessionPath = targetRun.sessionPath;
  const runId = targetRun.runId;

  fixture.agentReviews = [
    makeReview(sessionPath, runId, { rating: 5, reviewerBuckets: ['medium', 'small'], reviewerCount: 2 }),
    // Same session path but a runId that does not match any run → must NOT join
    // (the composite key `${sessionPathHash}::${runId}` disambiguates same-session runs).
    makeReview(sessionPath, 'run-does-not-exist', { rating: 2 }),
  ];

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.agentReviews.length, 2);

  const joined = prepared.agentReviews[0]!;
  assert.equal(joined.runId, runId);
  assert.equal(joined.sessionPathHash, prepared.runs[0]!.sessionPathHash);
  assert.equal(joined.modelFamily, prepared.runs[0]!.modelFamily, 'joined row carries the matched run model family');
  assert.equal(joined.userSatisfaction, prepared.runs[0]!.satisfaction, 'joined row carries the user satisfaction');
  assert.deepEqual(joined.reviewerBuckets, ['medium', 'small'], 'reviewer buckets sorted');
  assert.equal(joined.agentRating, 5);

  const unjoined = prepared.agentReviews[1]!;
  assert.equal(unjoined.runId, 'run-does-not-exist');
  assert.equal(unjoined.modelFamily, null, 'unjoined row has null model family');
  assert.equal(unjoined.userSatisfaction, null, 'unjoined row has null user satisfaction');
});

test('completed agent reviews backfill supplemental outcomes without entering user-primary ranking', async () => {
  const fixture = deepClone(await loadFixture());
  const template = fixture.completedRuns.find((run) => run.status === 'closed_unscored')!;
  assert.ok(template, 'fixture must contain an unscored completed run');

  fixture.completedRuns = Array.from({ length: LEADERBOARD_MINIMUM_SCORED_RUNS }, (_, index) => ({
    ...deepClone(template),
    runId: `agent-run-${index}`,
    taskGroupId: `agent-task-${index}`,
    sessionPath: `${template.sessionPath}.agent-${index}`,
  }));
  fixture.openRuns = [];
  fixture.outcomes = [];
  fixture.agentReviews = fixture.completedRuns.map((run, index) => makeReview(
    run.sessionPath,
    run.runId,
    {
      rating: index === 0 ? 5 : 4,
      completion: index === 2 ? 'partial' : 'fully',
      taskGroupId: run.taskGroupId,
      recordedAt: `2026-07-04T09:00:0${index}.000Z`,
    },
  ));

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.runs.length, LEADERBOARD_MINIMUM_SCORED_RUNS);
  for (const run of prepared.runs) {
    assert.equal(run.status, 'scored');
    assert.equal(run.scored, true);
    assert.equal(run.outcomeSource, 'agent');
    assert.notEqual(run.satisfaction, null);
  }
  assert.equal(prepared.runs[2]!.resolution, 'partially_resolved');

  const bundle = buildSiteDataBundle(prepared);
  assert.equal(bundle.manifest.scoredRunCount, LEADERBOARD_MINIMUM_SCORED_RUNS);
  const modelId = prepared.runs[0]!.modelFamily!;
  const leaderboard = bundle.modelLeaderboard.rows.find((row) => row.modelId === modelId)!;
  assert.ok(leaderboard, 'agent-scored model remains visible in the leaderboard');
  assert.equal(leaderboard.scoredRunCount, 0);
  assert.equal(leaderboard.userOutcomeCount, 0);
  assert.equal(leaderboard.agentOutcomeCount, LEADERBOARD_MINIMUM_SCORED_RUNS);
  assert.ok(leaderboard.rank !== null, 'done sidecar reviews contribute their own calibrated agent channel');
  assert.equal(leaderboard.userChannelScore, null);
  assert.ok(leaderboard.agentChannelScore !== null);

  const quality = bundle.modelQuality.rows.find((row) => row.modelId === modelId)!;
  assert.equal(quality.scoredRunCount, 0);
  assert.equal(quality.agentOutcomeCount, LEADERBOARD_MINIMUM_SCORED_RUNS);

  const comparison = bundle.agentReviewComparison.perModel.find((row) => row.modelId === modelId)!;
  assert.equal(comparison.agentReviewCount, LEADERBOARD_MINIMUM_SCORED_RUNS);
  assert.equal(comparison.userOutcomeCount, 0, 'agent provenance is not mislabeled as user feedback');
  assert.equal(comparison.bothScoredCount, 0);
});

test('buildAgentReviewComparison compares agent vs user outcomes and reviewer coverage', async () => {
  const fixture = deepClone(await loadFixture());
  // run-001: gpt-4.1, user satisfaction 5; run-002: gpt-4.1, user satisfaction 3.
  const run001 = fixture.completedRuns.find((r) => r.runId === 'run-001')!;
  const run002 = fixture.completedRuns.find((r) => r.runId === 'run-002')!;

  fixture.agentReviews = [
    makeReview(run001.sessionPath, run001.runId, { rating: 5, reviewerBuckets: ['medium', 'small'], reviewerCount: 2 }),
    makeReview(run002.sessionPath, run002.runId, { rating: 4, completion: 'partial', reviewerBuckets: ['medium'], reviewerCount: 1 }),
  ];

  const prepared = prepareSourceAnalytics(fixture);
  const comparison = buildSiteDataBundle(prepared).agentReviewComparison;

  const gptFamily = prepared.runs.find((r) => r.runId === 'run-001')!.modelFamily!;
  const gptRow = comparison.perModel.find((row) => row.modelId === gptFamily)!;
  assert.ok(gptRow, 'gpt-4.1 family has a per-model row');

  assert.equal(gptRow.agentReviewCount, 2);
  assert.equal(gptRow.userOutcomeCount, 2, 'both gpt-4.1 runs were scored by the user');
  assert.equal(gptRow.bothScoredCount, 2);
  assert.equal(gptRow.agentAverageRating, 4.5); // (5 + 4) / 2
  assert.equal(gptRow.userAverageSatisfaction, 4); // (5 + 3) / 2
  assert.deepEqual(gptRow.agentCompletion, { fully: 1, partial: 1, setback: 0 });

  // run-001: agent 5 vs user 5 → exact; run-002: agent 4 vs user 3 → off-by-1.
  assert.equal(gptRow.agreement.exactCount, 1);
  assert.equal(gptRow.agreement.offByOneCount, 1);
  assert.equal(gptRow.agreement.offByTwoPlusCount, 0);
  assert.equal(gptRow.agreement.meanAbsDelta, 0.5); // (0 + 1) / 2

  const multiReviewer = comparison.reviewerBucketCoverage.find(
    (row) => JSON.stringify(row.reviewerBuckets) === JSON.stringify(['medium', 'small']),
  )!;
  assert.equal(multiReviewer.reviewCount, 1);
  assert.equal(multiReviewer.averageAgentRating, 5);

  const singleReviewer = comparison.reviewerBucketCoverage.find(
    (row) => JSON.stringify(row.reviewerBuckets) === JSON.stringify(['medium']),
  )!;
  assert.equal(singleReviewer.reviewCount, 1);
  assert.equal(singleReviewer.averageAgentRating, 4);

  assert.equal(comparison.overall.totalAgentReviews, 2);
  assert.equal(comparison.overall.totalScoredByBoth, 2);
  assert.ok(comparison.overall.totalRunsScoredByUser >= 2);
  assert.ok(comparison.notes.length > 0);
});

test('agent-review-comparison.json round-trips through write/read and validates', async () => {
  const fixture = deepClone(await loadFixture());
  const run001 = fixture.completedRuns.find((r) => r.runId === 'run-001')!;
  const run002 = fixture.completedRuns.find((r) => r.runId === 'run-002')!;
  fixture.agentReviews = [
    makeReview(run001.sessionPath, run001.runId, { rating: 5, reviewerBuckets: ['medium', 'small'], reviewerCount: 2 }),
    makeReview(run002.sessionPath, run002.runId, { rating: 3, completion: 'partial', reviewerBuckets: ['medium'] }),
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);

  await withTempDir(async (dir) => {
    await writeSiteData(dir, bundle);
    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.agentReviewComparison.overall.totalAgentReviews, 2);
    assert.equal(roundTrip.agentReviewComparison.overall.totalScoredByBoth, 2, 'both reviews join to runs with user outcomes');
    assert.equal(roundTrip.agentReviewComparison.perModel.length, bundle.agentReviewComparison.perModel.length);
  });
});

test('agentReviewComparison is empty-but-well-formed when no reviews were recorded', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.agentReviews = [];
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  assert.equal(bundle.agentReviewComparison.overall.totalAgentReviews, 0);
  assert.equal(bundle.agentReviewComparison.overall.totalScoredByBoth, 0);
  // No agent reviews → no reviewer-bucket signatures to group.
  assert.deepEqual(bundle.agentReviewComparison.reviewerBucketCoverage, []);
  // Per-model rows still surface user-outcome counts, but the agent side is zeroed out.
  assert.ok(bundle.agentReviewComparison.perModel.length > 0);
  for (const row of bundle.agentReviewComparison.perModel) {
    assert.equal(row.agentReviewCount, 0);
    assert.equal(row.bothScoredCount, 0);
    assert.equal(row.agentAverageRating, null);
    assert.equal(row.agreement.meanAbsDelta, null);
  }
  validateSiteDataBundle(bundle);
});

test('readAgentReviewsLog reads <storageDir>/agent-reviews.jsonl (missing file → [])', async () => {
  await withTempDir(async (dir) => {
    const review = makeReview('C:\\session\\path.jsonl', 'run-x', { rating: 4 });
    await fs.writeFile(path.join(dir, 'agent-reviews.jsonl'), `${JSON.stringify(review)}\nnot-json\n`, 'utf8');

    const loaded = await loadSourceAnalytics({ storageDir: dir });
    assert.equal(loaded.sourceKind, 'storage-dir');
    assert.equal(loaded.source.agentReviews.length, 1, 'malformed line dropped, well-formed line ingested');
    assert.equal(loaded.source.agentReviews[0]!.runId, 'run-x');
    assert.equal(loaded.source.agentReviews[0]!.rating, 4);

    // Missing file entirely → empty (best-effort, never throws).
    await withTempDir(async (empty) => {
      const emptyLoaded = await loadSourceAnalytics({ storageDir: empty });
      assert.deepEqual(emptyLoaded.source.agentReviews, []);
    });
  });
});
