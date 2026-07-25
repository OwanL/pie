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
import { buildDuckDbDatabase, runDuckDbQuery, runNamedDuckDbQuery, writeDuckDbStagingExports } from '../scripts/duckdb.ts';
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

// The canonical V2 fixture review (line 2 of the mixed sidecar) is the basis for
// amendment/adjudication and not-assessable synthetic cases below. It is parsed
// once at module load; every test deep-clones before mutating.
const RAW_V2_REVIEW = JSON.parse((await fs.readFile(MIXED_FIXTURE, 'utf8')).trim().split(/\r?\n/)[1]!) as Record<string, any>;

/** A canonical production review carrying all four amendment dispositions plus a
 *  medium-bucket adjudication. Mirrors the extension's amendment/adjudication
 *  contract (mapped target/downgrade, finding_downgraded severity, exact
 *  amendmentIds) so the analytics coercion has a valid base to mutate. */
function reviewWithAmendmentsAndAdjudication(): Record<string, any> {
  const review = deepClone(RAW_V2_REVIEW);
  const classifiedC1 = deepClone((review.ledger as any[])[0]!);
  const c2Definition = {
    criterionId: 'c2', statement: 'Added necessary-implied criterion', origin: 'necessary_implied',
    importance: 'core', taxonomy: { activity: 'implement', surface: ['application_logic'], evidenceMode: ['automated_check'] },
  };
  const classifiedC2 = { ...c2Definition, status: 'met', reason: 'none', evidenceRefs: ['transcript:2'], findingRefs: [] };
  review.ledger = [classifiedC1, classifiedC2];
  review.attainment = deriveReviewAttainment(review.ledger as ClassifiedCriterion[]);
  const amendmentIds = ['am-accepted', 'am-mapped', 'am-downgraded', 'am-rejected'];
  review.amendments = [
    { amendmentId: 'am-accepted', disposition: 'accepted', definition: c2Definition, classifiedCriterion: classifiedC2 },
    { amendmentId: 'am-mapped', disposition: 'mapped_to_existing', targetCriterionId: 'c1', downgradedClassification: classifiedC1 },
    { amendmentId: 'am-downgraded', disposition: 'finding_downgraded', downgradedSeverity: 'minor' },
    { amendmentId: 'am-rejected', disposition: 'rejected' },
  ];
  review.disagreement = { material: true, adjudicated: true, disputedFields: [] };
  review.adjudication = {
    reviewerId: 'reviewer-adjudicator', toolCallId: 'call-adjudicator',
    requestedBucket: 'medium', bucket: 'medium', bucketDowngraded: false,
    modelId: 'model-adjudicator', provider: 'provider-b', family: 'family-b', thinkingLevel: null,
    promptHash: 'prompt-adjudicator', rubricVersion: review.rubricVersion,
    adjudicationId: 'adjudication-1', assessedAt: '2026-07-24T10:15:00.000Z',
    amendmentIds: [...amendmentIds], resolvedFields: [],
    canonicalOverall: { deliveredOverall: 'achieved', controllableOverall: 'achieved' },
  };
  review.provenance.pipeline.amendmentIds = [...amendmentIds];
  review.provenance.pipeline.adjudicationId = 'adjudication-1';
  return review;
}

/** A V2 review whose controllable attainment is `not_assessable` (every core
 *  criterion is externally blocked), so its derived qualityIndexV1 is null. */
function notAssessableReview(): Record<string, any> {
  const review = deepClone(RAW_V2_REVIEW);
  (review.ledger as any[])[0]!.status = 'blocked';
  (review.ledger as any[])[0]!.reason = 'external_blocker';
  review.reviewId = 'review-not-assessable';
  review.sessionId = 'session-not-assessable';
  review.sessionPathAtReview = 'C:\\sessions\\not-assessable.jsonl';
  review.attainment = deriveReviewAttainment(review.ledger as ClassifiedCriterion[]);
  return review;
}

test('V2 coercion accepts the full amendment + adjudication envelope and rejects every malformed disposition/adjudication payload', () => {
  assert.ok(coerceSessionReviewV2(reviewWithAmendmentsAndAdjudication()), 'the canonical amendment/adjudication envelope must coerce');

  const rejects = (mutate: (review: Record<string, any>) => void, label: string): void => {
    const review = reviewWithAmendmentsAndAdjudication();
    mutate(review);
    assert.equal(coerceSessionReviewV2(review), null, `expected rejection: ${label}`);
  };

  // Adjudication: requestedBucket must be medium, rubricVersion must match, assessedAt must be ISO,
  // and amendmentIds must exactly match the adjudicated amendments.
  rejects((r) => { r.adjudication.requestedBucket = 'small'; r.adjudication.bucket = 'small'; }, 'adjudication requestedBucket not medium');
  rejects((r) => { r.adjudication.rubricVersion = 'wrong'; }, 'adjudication rubricVersion mismatch');
  rejects((r) => { r.adjudication.assessedAt = 'not-a-date'; }, 'adjudication assessedAt not ISO');
  rejects((r) => { r.adjudication.amendmentIds = ['am-accepted']; }, 'adjudication amendmentIds not exact');
  rejects((r) => { r.adjudication.amendmentIds = ['am-accepted', 'am-mapped', 'am-downgraded', 'am-rejected', 'am-extra']; }, 'adjudication amendmentIds extra id');

  // Amendment dispositions: an unknown disposition is rejected (mutate the
  // rejected amendment so the ledger/accepted-criterion invariant is untouched
  // and only the disposition enum check can catch it).
  rejects((r) => { (r.amendments as any[])[3]!.disposition = 'garbage'; }, 'unknown amendment disposition');

  // mapped_to_existing: mapped target must be a frozen criterion, the downgrade
  // classification must be present, point at the target, and match the ledger.
  rejects((r) => { delete (r.amendments as any[])[1]!.targetCriterionId; }, 'mapped_to_existing missing target');
  rejects((r) => { (r.amendments as any[])[1]!.targetCriterionId = 'c2'; }, 'mapped_to_existing target not frozen');
  rejects((r) => { delete (r.amendments as any[])[1]!.downgradedClassification; }, 'mapped_to_existing missing downgrade classification');
  rejects((r) => { (r.amendments as any[])[1]!.downgradedClassification.criterionId = 'c2'; }, 'mapped_to_existing downgrade points at wrong criterion');

  // finding_downgraded: severity must be minor or nit.
  rejects((r) => { (r.amendments as any[])[2]!.downgradedSeverity = 'critical'; }, 'finding_downgraded severity critical');
  rejects((r) => { delete (r.amendments as any[])[2]!.downgradedSeverity; }, 'finding_downgraded missing severity');
});

test('reopened sessions keep V2 review mass at 1.0 and match site-data across all three attribution queries', async () => {
  const source = await sourceWithMixedReviews();
  const closedRun = source.completedRuns[0]!;
  closedRun.sessionId = 'session-v2-fixture';
  source.historicalSessions = [];
  // A reopened session carries an in-progress (open) run that shares the stable
  // sessionId but attributes to a different model family. The open run must not
  // steal review mass before the author-cell weighting split.
  source.openRuns = [
    ...source.openRuns.filter((run) => run.runId !== closedRun.runId),
    {
      ...deepClone(closedRun), runId: 'reopened-open-run', taskGroupId: 'reopened-open-task',
      modelId: 'reopened-open-family', status: 'open', finalizedAt: undefined, finalizationReason: undefined,
      outcome: undefined, scored: false,
    },
  ];
  const prepared = prepareSourceAnalytics(source);
  const closedFamily = prepared.runs.find((run) => run.runId === closedRun.runId)!.modelFamily!;

  const assertMassForQuery = (rows: Array<Record<string, unknown>>, label: string): void => {
    const massByFamily = new Map<string, number>();
    for (const row of rows) {
      const family = String(row['model_family'] ?? row['model_id'] ?? '');
      const mass = Number(row['v2_review_count'] ?? 0);
      if (mass > 0) massByFamily.set(family, (massByFamily.get(family) ?? 0) + mass);
    }
    assert.equal([...massByFamily.values()].reduce((sum, value) => sum + value, 0), 1, `${label}: total V2 review mass must remain 1.0`);
    assert.equal(massByFamily.get(closedFamily), 1, `${label}: the closed-run family receives the full review`);
    assert.equal(massByFamily.get('reopened-open-family'), undefined, `${label}: the open run's family receives no mass`);
  };

  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'reviews.duckdb');
    await buildDuckDbDatabase({ dbPath, exportsDir: path.join(dir, 'exports'), prepared });
    const leaderboardSql = await fs.readFile(new URL('../queries/model_leaderboard.sql', import.meta.url), 'utf8');
    assertMassForQuery(await runNamedDuckDbQuery(dbPath, 'model_quality'), 'model_quality');
    assertMassForQuery(await runNamedDuckDbQuery(dbPath, 'session_review_quality'), 'session_review_quality');
    assertMassForQuery(await runDuckDbQuery(dbPath, leaderboardSql), 'model_leaderboard');
  });

  // Site-data (leaderboard.ts) excludes open runs from the stable attribution
  // set, so the DuckDB mass must agree with the site-data agent outcome mass.
  const bundle = buildSiteDataBundle(prepared);
  const closedRow = bundle.modelLeaderboard.rows.find((row) => row.modelId === closedFamily)!;
  assert.equal(closedRow.agentEvidenceMass, 1);
  assert.equal(closedRow.agentOutcomeCount, 1);
  assert.equal(
    bundle.modelLeaderboard.rows.find((row) => row.modelId === 'reopened-open-family'),
    undefined,
    'the reopened open-run family has no completed run and no site-data row',
  );
});

test('not-assessable review count is reconciled across SQL and site outputs', async () => {
  const source = deepClone(await loadFixture());
  const baseRun = source.completedRuns[0]!;
  const assessable = coerceSessionReviewV2(deepClone(RAW_V2_REVIEW))!;
  const notAssessable = coerceSessionReviewV2(notAssessableReview())!;
  assert.ok(assessable && notAssessable, 'both the assessable and not-assessable reviews must coerce');
  source.completedRuns = [
    { ...deepClone(baseRun), sessionId: 'session-v2-fixture' },
    { ...deepClone(baseRun), runId: 'run-na', taskGroupId: 'task-na', sessionId: 'session-not-assessable', sessionPath: 'C:\\sessions\\not-assessable-run.jsonl' },
  ];
  source.openRuns = [];
  source.sessionReviewsV2 = [assessable, notAssessable];
  source.legacySessionReviews = [];
  source.agentReviews = [];
  source.historicalSessions = [];

  const prepared = prepareSourceAnalytics(source);
  assert.equal(prepared.sessionReviewsV2.length, 2);
  assert.deepEqual(
    new Set(prepared.sessionReviewsV2.map((row) => row.attainment.qualityIndexV1)),
    new Set([null, 100]),
    'one review is assessable (qualityIndexV1=100) and one is not (null)',
  );

  // Site output: reviewCount == qualityIndexCount + notAssessableReviewCount.
  const summary = buildSiteDataBundle(prepared).sessionReviewAnalytics.summary;
  assert.equal(summary.reviewCount, 2);
  assert.equal(summary.qualityIndexCount, 1);
  assert.equal(summary.notAssessableReviewCount, 1);
  assert.equal(summary.reviewCount, summary.qualityIndexCount + summary.notAssessableReviewCount);

  // SQL output: the same partition is exposed as not_assessable_review_count,
  // with v2_review_count == quality_index_count + not_assessable_review_count.
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'reviews.duckdb');
    await buildDuckDbDatabase({ dbPath, exportsDir: path.join(dir, 'exports'), prepared });
    const rows = await runNamedDuckDbQuery(dbPath, 'session_review_quality');
    const total = (field: string): number => rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
    assert.equal(total('v2_review_count'), 2);
    assert.equal(total('quality_index_count'), 1);
    assert.equal(total('not_assessable_review_count'), 1);
    assert.equal(total('v2_review_count'), total('quality_index_count') + total('not_assessable_review_count'));
  });
});
