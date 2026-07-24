import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClassifiedCriterion, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { hashToPrefix, sessionPathHash } from '../scripts/hash.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { backfillLegacySessionReviewIds, coerceSourceAnalyticsPayload } from '../scripts/source.ts';
import { coerceSessionReviewV2, deriveReviewAttainment } from '../scripts/review-analytics.ts';
import { buildSiteDataBundle } from '../scripts/site-data.ts';
import { sessionReviewAnalyticsHtml } from '../site/app.ts';
import { readMixedSessionReviews } from '../scripts/transcript-source.ts';
import { buildDuckDbDatabase, runNamedDuckDbQuery, writeDuckDbStagingExports } from '../scripts/duckdb.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

const MIXED_FIXTURE = fileURLToPath(new URL('../fixtures/session-reviews-v1-v2.jsonl', import.meta.url));

function criterion(overrides: Partial<ClassifiedCriterion>): ClassifiedCriterion {
  return {
    criterionId: 'criterion', statement: 'criterion', origin: 'explicit', importance: 'core',
    taxonomy: { activity: 'implement', surface: ['application_logic'], evidenceMode: ['automated_check'] },
    status: 'met', reason: 'none', evidenceRefs: [], findingRefs: [], ...overrides,
  };
}

async function sourceWithMixedReviews(): Promise<SourceAnalyticsPayload> {
  const source = deepClone(await loadFixture());
  const mixed = await readMixedSessionReviews(MIXED_FIXTURE);
  const run = source.completedRuns[0]!;
  source.sessionReviewsV2 = mixed.productionV2;
  source.legacySessionReviews = mixed.legacy;
  source.agentReviews = [];
  source.historicalSessions = [{
    sessionId: 'session-v2-fixture', normalizedSessionPath: run.sessionPath,
    startedAt: run.startedAt, endedAt: run.finalizedAt ?? run.updatedAt,
    firstUserMessageChars: 120,
    attributions: [{ modelId: run.modelId ?? '(unknown)', thinkingLevel: run.thinkingLevel ?? null, share: 1, successfulAssistantTurns: 1, attributedTokens: 100 }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 1, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['portable-export'], review: null,
  }];
  return source;
}

test('mixed review fixture preserves V1 as legacy and ingests canonical V2 separately', async () => {
  const mixed = await readMixedSessionReviews(MIXED_FIXTURE);
  assert.equal(mixed.legacy.length, 1);
  assert.equal(mixed.legacy[0]!.cohort, 'legacy_v1');
  assert.equal(mixed.legacy[0]!.identityFallback, true);
  assert.equal(mixed.productionV2.length, 1);
  assert.equal(mixed.productionV2[0]!.sessionId, 'session-v2-fixture');
  assert.equal(mixed.productionV2[0]!.reviewers.length, 5);
});

test('path fallback and legacy header backfill are canonical and idempotent', async () => {
  const windows = sessionPathHash(' C:\\Sessions\\Example.jsonl ');
  assert.equal(windows, sessionPathHash('c:/sessions//example.jsonl'));
  assert.equal(windows.length, 16);
  assert.equal(sessionPathHash('C:\\Sessions\\Example.jsonl'), windows);
  assert.equal(
    sessionPathHash('\\\\Server\\Share\\Example.jsonl'),
    hashToPrefix('//server/share/example.jsonl', 16),
    'UNC fallback preserves the leading // before hashing',
  );

  const legacy = (await readMixedSessionReviews(MIXED_FIXTURE)).legacy;
  const historical = [{ ...(await sourceWithMixedReviews()).historicalSessions![0]!, sessionId: 'resolved-header-id', normalizedSessionPath: legacy[0]!.normalizedSessionPath }];
  const once = backfillLegacySessionReviewIds(legacy, historical);
  const twice = backfillLegacySessionReviewIds(once, [{ ...historical[0]!, sessionId: 'must-not-overwrite' }]);
  assert.equal(once[0]!.sessionId, 'resolved-header-id');
  assert.equal(once[0]!.identityFallback, false);
  assert.deepEqual(twice, once, 'backfill fills missing stable IDs but never overwrites an existing one');
});

test('V2 analytics coercion strictly rejects malformed ledger hashes and pipeline provenance', async () => {
  const raw = (await fs.readFile(MIXED_FIXTURE, 'utf8')).trim().split(/\r?\n/)[1]!;
  const invalidReason = JSON.parse(raw) as any;
  invalidReason.ledger[0].reason = 'external_blocker';
  assert.equal(coerceSessionReviewV2(invalidReason), null);

  const tamperedFrozen = JSON.parse(raw) as any;
  tamperedFrozen.frozenLedger[0].statement = 'tampered after hashing';
  assert.equal(coerceSessionReviewV2(tamperedFrozen), null);

  const driftedPipeline = JSON.parse(raw) as any;
  driftedPipeline.provenance.pipeline.componentAssessmentIds[0] = 'wrong-assessment';
  assert.equal(coerceSessionReviewV2(driftedPipeline), null);

  const malformedComponents = JSON.parse(raw) as any;
  malformedComponents.components = malformedComponents.components.slice(0, 1);
  assert.equal(coerceSessionReviewV2(malformedComponents), null);

  const malformedIdentity = JSON.parse(raw) as any;
  malformedIdentity.identityFallback = 'false';
  assert.equal(coerceSessionReviewV2(malformedIdentity), null);
});

test('V2 loaders keep the deterministic latest canonical review per stable sessionId', async () => {
  const raw = JSON.parse((await fs.readFile(MIXED_FIXTURE, 'utf8')).trim().split(/\r?\n/)[1]!) as any;
  const older = { ...deepClone(raw), reviewId: 'review-older', reviewedAt: '2026-07-23T10:20:00.000Z' };
  const newer = { ...deepClone(raw), reviewId: 'review-newer', reviewedAt: '2026-07-25T10:20:00.000Z' };
  const payload = deepClone(await loadFixture()) as any;
  payload.sessionReviewsV2 = [newer, older];
  assert.deepEqual(coerceSourceAnalyticsPayload(payload).sessionReviewsV2?.map((review) => review.reviewId), ['review-newer']);

  await withTempDir(async (dir) => {
    const sidecar = path.join(dir, 'reviews.jsonl');
    await fs.writeFile(sidecar, [JSON.stringify(older), JSON.stringify(newer)].join('\n'));
    assert.deepEqual((await readMixedSessionReviews(sidecar)).productionV2.map((review) => review.reviewId), ['review-newer']);
  });
});

test('derived attainment reports delivered vs controllable and keeps qualityIndexV1 outcome-only', () => {
  const ledger = [
    criterion({ criterionId: 'core', status: 'met' }),
    criterion({ criterionId: 'external', importance: 'supporting', status: 'blocked', reason: 'external_blocker' }),
    criterion({ criterionId: 'unknown', importance: 'optional', status: 'not_assessable', reason: 'human_evidence_missing' }),
    criterion({ criterionId: 'old', importance: 'supporting', status: 'superseded', reason: 'none' }),
  ];
  const attainment = deriveReviewAttainment(ledger);
  assert.equal(attainment.deliveredOverall, 'mostly_achieved');
  assert.equal(attainment.controllableOverall, 'achieved');
  assert.equal(attainment.supporting.externalBlocked, 1);
  assert.equal(attainment.supporting.controllableDenominator, 0);
  assert.equal(attainment.qualityIndexV1, 100);

  const allExternal = deriveReviewAttainment([criterion({ status: 'blocked', reason: 'external_blocker' })]);
  assert.equal(allExternal.deliveredOverall, 'not_achieved');
  assert.equal(allExternal.controllableOverall, 'not_assessable');
  assert.equal(allExternal.qualityIndexV1, null);

  const partial = deriveReviewAttainment([
    criterion({ criterionId: 'core', status: 'partly_met', reason: 'attempt_failed' }),
    ...Array.from({ length: 8 }, (_, index) => criterion({ criterionId: `optional-${index}`, importance: 'optional', status: 'met' })),
  ]);
  assert.equal(partial.controllableOverall, 'partly_achieved');
  assert.ok(partial.qualityIndexV1! >= 25 && partial.qualityIndexV1! <= 59, 'optional success cannot escape the core-driven band');
});

test('V2 preparation joins by stable sessionId and exposes separate diagnostics', async () => {
  const prepared = prepareSourceAnalytics(await sourceWithMixedReviews());
  const review = prepared.sessionReviewsV2[0]!;
  assert.equal(prepared.runs[0]!.sessionId, 'session-v2-fixture');
  assert.equal(prepared.runs[0]!.identityFallback, false);
  assert.equal(review.joinKey, 'session_id');
  assert.deepEqual(review.runIds, [prepared.runs[0]!.runId]);
  assert.equal(review.attainment.qualityIndexV1, 100, 'stored fixture score is ignored and deterministically re-derived');
  assert.equal(review.criterionCoverage, 1);
  assert.equal(review.externalBlockerRate, 0);

  const bundle = buildSiteDataBundle(prepared);
  assert.equal(bundle.agentReviewComparison.cohort, 'legacy_v1');
  assert.equal(bundle.sessionReviewAnalytics.cohort, 'v2_production');
  assert.equal(bundle.sessionReviewAnalytics.summary.reviewCount, 1);
  assert.equal(bundle.sessionReviewAnalytics.summary.meanQualityIndexV1, 100);
  assert.equal(bundle.sessionReviewAnalytics.process.verificationDiscipline[0]!.value, 'proportionate');
  assert.equal(bundle.sessionReviewAnalytics.findings.total, 0);
  assert.equal(bundle.sessionReviewAnalytics.disagreement.adjudicatedCount, 0);
  assert.equal(bundle.sessionReviewAnalytics.reviewers.bucketDowngradeCount, 0);
  assert.equal(bundle.sessionReviewAnalytics.legacy.sidecarReviewCount, 1);

  const family = prepared.runs[0]!.modelFamily!;
  const leaderboard = bundle.modelLeaderboard.rows.find((row) => row.modelId === family)!;
  assert.equal(leaderboard.agentOutcomeCount, 1, 'V2 quality review enters the V2 review channel');
  assert.equal(leaderboard.meanQualityIndexV1, 100);
  assert.equal(leaderboard.legacyAgentReviewCount, 0);
});

test('moved sessions join by run header sessionId without any path match', async () => {
  const source = await sourceWithMixedReviews();
  const run = source.completedRuns[0]!;
  run.sessionId = 'session-v2-fixture';
  run.sessionPath = 'D:\\renamed\\moved-session.jsonl';
  source.historicalSessions = [];

  const prepared = prepareSourceAnalytics(source);
  assert.equal(prepared.runs[0]!.sessionId, 'session-v2-fixture');
  assert.equal(prepared.runs[0]!.identityFallback, false);
  assert.equal(prepared.sessionReviewsV2[0]!.joinKey, 'session_id');
  assert.deepEqual(prepared.sessionReviewsV2[0]!.runIds, [run.runId]);
});

test('mixed-model V2 reviews use one unit of fractional attribution mass', async () => {
  const source = await sourceWithMixedReviews();
  const first = source.completedRuns[0]!;
  first.sessionId = 'session-v2-fixture';
  const second = { ...deepClone(first), runId: 'mixed-family-run', taskGroupId: 'mixed-family-task', modelId: 'fractional-family-b', sessionPath: 'D:\\moved\\same-session.jsonl' };
  source.completedRuns.push(second);
  source.historicalSessions = [];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(source));
  const attributed = bundle.modelLeaderboard.rows.filter((row) => row.agentEvidenceMass > 0);
  assert.equal(attributed.length, 2);
  assert.equal(attributed.reduce((sum, row) => sum + row.agentEvidenceMass, 0), 1);
  assert.deepEqual(attributed.map((row) => row.agentEvidenceMass).sort(), [0.5, 0.5]);
  assert.ok(attributed.every((row) => row.mixedAttributionMass === 0.5));
});

test('dashboard renders delivered/controllable and review diagnostics from the V2 artifact', async () => {
  const analytics = buildSiteDataBundle(prepareSourceAnalytics(await sourceWithMixedReviews())).sessionReviewAnalytics;
  const html = sessionReviewAnalyticsHtml(analytics);
  for (const label of ['Delivered', 'Controllable', 'Criterion coverage', 'External blocker rate', 'Confidence', 'Process diagnostics', 'Evidence &amp; findings', 'Disagreement &amp; reviewers']) {
    assert.match(html, new RegExp(label));
  }
  const appSource = await fs.readFile(new URL('../site/app.ts', import.meta.url), 'utf8');
  assert.match(appSource, /session-review-analytics\.json/);
});

test('V1 selfClose placeholders are excluded from legacy sidecar reads', async () => {
  await withTempDir(async (dir) => {
    const sidecar = path.join(dir, 'reviews.jsonl');
    await fs.writeFile(sidecar, [
      JSON.stringify({ sessionPath: 'C:\\sessions\\placeholder.jsonl', selfClose: true, done: true, rating: 5, completion: 'fully', evaluatedAt: '2026-07-20T00:00:00.000Z' }),
      JSON.stringify({ sessionPath: 'C:\\sessions\\real.jsonl', done: true, rating: 4, completion: 'fully', evaluatedAt: '2026-07-21T00:00:00.000Z' }),
    ].join('\n'));
    const mixed = await readMixedSessionReviews(sidecar);
    assert.equal(mixed.legacy.length, 1);
    assert.match(mixed.legacy[0]!.normalizedSessionPath, /real\.jsonl$/);
  });
});

test('DuckDB V2 model joins exclude unblinded reviews and do not weight sessions by run count', async () => {
  const source = await sourceWithMixedReviews();
  const originalRun = source.completedRuns[0]!;
  source.completedRuns.push({ ...deepClone(originalRun), runId: `${originalRun.runId}-retry`, taskGroupId: `${originalRun.taskGroupId}-retry` });
  source.sessionReviewsV2!.push({ ...deepClone(source.sessionReviewsV2![0]!), reviewId: 'unblinded-review', blindingApplied: false });
  const prepared = prepareSourceAnalytics(source);
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'reviews.duckdb');
    await buildDuckDbDatabase({ dbPath, exportsDir: path.join(dir, 'exports'), prepared });
    const qualityRows = await runNamedDuckDbQuery(dbPath, 'model_quality');
    const family = prepared.runs[0]!.modelFamily!;
    const row = qualityRows.find((entry) => entry.model_id === family)!;
    assert.equal(Number(row.v2_review_count), 1);
    assert.equal(Number(row.mean_quality_index_v1), 100);
  });
});

test('DuckDB splits one mixed-model V2 review instead of assigning full credit to every family', async () => {
  const source = await sourceWithMixedReviews();
  const first = source.completedRuns[0]!;
  first.sessionId = 'session-v2-fixture';
  source.completedRuns.push({
    ...deepClone(first), runId: 'sql-mixed-run', taskGroupId: 'sql-mixed-task',
    modelId: 'sql-fractional-family', sessionPath: 'D:\\moved\\sql-mixed.jsonl',
  });
  source.historicalSessions = [];
  const prepared = prepareSourceAnalytics(source);
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'fractional.duckdb');
    await buildDuckDbDatabase({ dbPath, exportsDir: path.join(dir, 'exports'), prepared });
    const rows = (await runNamedDuckDbQuery(dbPath, 'model_quality')).filter((row) => Number(row.v2_review_count) > 0);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => Number(row.v2_review_count)).sort(), [0.5, 0.5]);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.v2_review_count), 0), 1);
  });
});

test('DuckDB staging exports stable-ID V2 review, criterion, finding, and reviewer tables', async () => {
  const prepared = prepareSourceAnalytics(await sourceWithMixedReviews());
  await withTempDir(async (dir) => {
    const paths = await writeDuckDbStagingExports(dir, prepared);
    const runRows = JSON.parse(await fs.readFile(paths.runsPath, 'utf8')) as Array<Record<string, unknown>>;
    const reviewRows = JSON.parse(await fs.readFile(paths.sessionReviewsV2Path, 'utf8')) as Array<Record<string, unknown>>;
    const criteria = JSON.parse(await fs.readFile(paths.reviewCriteriaV2Path, 'utf8')) as unknown[];
    const findings = JSON.parse(await fs.readFile(paths.reviewFindingsV2Path, 'utf8')) as unknown[];
    const reviewers = JSON.parse(await fs.readFile(paths.reviewReviewersV2Path, 'utf8')) as unknown[];
    assert.equal(runRows[0]!.session_id, 'session-v2-fixture');
    assert.equal(reviewRows[0]!.quality_index_v1, 100);
    assert.equal(criteria.length, 1);
    assert.equal(findings.length, 0);
    assert.equal(reviewers.length, 5);
    assert.equal(path.basename(paths.sessionReviewsV2Path), 'session-reviews-v2.json');
  });
});
