import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

test('site data generation writes the expected files and passes validation', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    const prepared = prepareSourceAnalytics(fixture);
    const bundle = buildSiteDataBundle(prepared, new Date('2026-05-14T00:00:00.000Z'));
    validateSiteDataBundle(bundle);

    await writeSiteData(dir, bundle);

    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.manifest.schemaVersion, 4);
    assert.equal(roundTrip.modelLeaderboard.schemaVersion, 4);
    assert.equal(roundTrip.manifest.completedRunCount, 7);
    assert.equal(roundTrip.runSummary.rows.length, 8);
    assert.ok(roundTrip.verificationImpact.summaryRows.length > 0);
    assert.ok(roundTrip.toolUsage.summaryRows.length > 0);
    assert.equal(roundTrip.modelLeaderboard.minimumTaskScoringCoverage, 0);
    assert.equal(roundTrip.modelLeaderboard.caseMix.minimumModelRatedTasksPerBand, 0);
    assert.ok(roundTrip.modelLeaderboard.rows.every((row) => (
      typeof row.attributableTaskCount === 'number'
      && typeof row.scoringCoverageGateFailed === 'boolean'
    )));
  });
});

test('model quality uses stable-treatment user outcomes and discloses supplemental exclusions', async () => {
  const fixture = deepClone(await loadFixture());
  const base = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];
  fixture.agentReviews = [];

  const add = (runId: string, source: 'user' | 'agent', mixed: boolean, satisfaction: number, mixedTreatment = false) => {
    const run = deepClone(base);
    run.runId = runId;
    run.taskGroupId = `${runId}-task`;
    run.modelId = 'quality-attribution-model';
    run.thinkingLevel = 'high';
    run.experimentAssignment = null;
    run.status = 'scored';
    run.scored = true;
    run.mixedModelConfig = mixed;
    run.mixedTreatmentConfig = mixedTreatment;
    run.outcome = {
      source,
      satisfaction,
      resolution: satisfaction === 5 ? 'resolved' : 'unresolved',
    };
    fixture.completedRuns.push(run);
  };
  add('quality-user', 'user', false, 5);
  add('quality-agent', 'agent', false, 1);
  add('quality-mixed', 'user', true, 1);
  add('quality-treatment', 'user', false, 1, true);

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);
  const row = bundle.modelQuality.rows.find((candidate) => candidate.modelId === 'quality-attribution-model')!;

  assert.equal(row.runCount, 4, 'operational denominator retains all completed runs');
  assert.equal(row.scoredRunCount, 1);
  assert.equal(row.agentOutcomeCount, 1);
  assert.equal(row.mixedModelExcludedOutcomeCount, 1);
  assert.equal(row.mixedTreatmentExcludedOutcomeCount, 1);
  assert.equal(row.averageSatisfaction, 5);
  assert.deepEqual(row.resolutionCounts, { resolved: 1, partiallyResolved: 0, unresolved: 0 });
  assert.match(bundle.modelQuality.notes.join(' '), /stable-model, stable-treatment user outcomes/i);
});

test('site data generation handles no-scored and open-only edge cases', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.completedRuns.forEach((run) => {
    run.scored = false;
    delete (run as Partial<typeof run>).outcome;
  });
  fixture.outcomes = [];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);
  assert.equal(bundle.overview.totalScoredRuns, 0);
  assert.equal(bundle.timeline.rows.length > 0, true);
});

test('unexpected files or nested directories in the site-data directory fail validation', async () => {
  await withTempDir(async (dir) => {
    const fixture = await loadFixture();
    const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
    await writeSiteData(dir, bundle);
    await fs.writeFile(path.join(dir, 'run-analytics.json'), JSON.stringify({ completedRuns: [] }), 'utf8');

    await assert.rejects(
      async () => await readSiteDataBundle(dir),
      /Unexpected JSON file found in site data directory: run-analytics.json/,
    );

    await fs.rm(path.join(dir, 'run-analytics.json'), { force: true });
    await fs.mkdir(path.join(dir, 'extra'), { recursive: true });
    await fs.writeFile(path.join(dir, 'extra', 'manifest.json'), '{}', 'utf8');

    await assert.rejects(
      async () => await readSiteDataBundle(dir),
      /Unexpected subdirectory found in site data directory: extra/,
    );
  });
});

test('site data generation tolerates unknown model ids and ignores unknown verification kinds', async () => {
  const fixture = deepClone(await loadFixture());
  delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).modelId;
  (fixture.completedRuns[0] as any).verification.countsByKind.unexpected = 99;

  const prepared = prepareSourceAnalytics(fixture);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);

  assert.equal(bundle.runSummary.rows[0]?.modelId, null);
  assert.ok(bundle.modelQuality.rows.some((row) => row.modelId === '(unknown)'));
  assert.ok(!JSON.stringify(bundle).includes('unexpected'));
});

test('site data treatment comparison normalizes null hashes and sorts by run count then experiment', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open').slice(0, 4);

  Object.assign(completedRuns[0]!, {
    promptFamily: null,
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-z',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[1]!, {
    promptFamily: null,
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-z',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[2]!, {
    promptFamily: 'family-a',
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-b',
    mixedTreatmentConfig: false,
  });
  Object.assign(completedRuns[3]!, {
    promptFamily: 'family-a',
    promptHashPrefix: null,
    toolSetHashPrefix: null,
    skillSetHashPrefix: null,
    experimentAssignment: 'exp-a',
    mixedTreatmentConfig: false,
  });

  prepared.runs = completedRuns;
  prepared.toolUsage = [];
  prepared.toolFailures = [];
  prepared.verificationUsage = [];
  prepared.backendErrors = [];
  prepared.fileExtensions = [];

  const bundle = buildSiteDataBundle(prepared);
  const rows = bundle.treatmentComparison.rows;

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.runCount, 2);
  assert.equal(rows[0]?.promptFamily, '(none)');
  assert.equal(rows[0]?.toolSetHashPrefix, null);
  assert.equal(rows[0]?.skillSetHashPrefix, null);
  assert.deepEqual(
    rows.filter((row) => row.promptFamily === 'family-a').map((row) => row.experimentAssignment),
    ['exp-a', 'exp-b'],
  );
});

test('verification impact buckets per-kind counts, not run total', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  const completedRuns = prepared.runs.filter((run) => run.status !== 'open');
  const targetRun = completedRuns[0]!;

  prepared.verificationUsage = prepared.verificationUsage.filter((row) => row.runId !== targetRun.runId);
  prepared.verificationUsage.push(
    { runId: targetRun.runId, kind: 'test', count: 3, runHadAnyFailure: false, startedAt: targetRun.startedAt, startedDay: targetRun.startedDay, modelId: targetRun.modelId, thinkingLevel: targetRun.thinkingLevel, experimentAssignment: targetRun.experimentAssignment, mixedTreatmentConfig: targetRun.mixedTreatmentConfig, scored: targetRun.scored, satisfaction: targetRun.satisfaction, resolution: targetRun.resolution },
    { runId: targetRun.runId, kind: 'build', count: 1, runHadAnyFailure: false, startedAt: targetRun.startedAt, startedDay: targetRun.startedDay, modelId: targetRun.modelId, thinkingLevel: targetRun.thinkingLevel, experimentAssignment: targetRun.experimentAssignment, mixedTreatmentConfig: targetRun.mixedTreatmentConfig, scored: targetRun.scored, satisfaction: targetRun.satisfaction, resolution: targetRun.resolution },
  );

  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);

  const testRows = bundle.verificationImpact.rows.filter((row) => row.verificationKind === 'test');
  const buildRows = bundle.verificationImpact.rows.filter((row) => row.verificationKind === 'build');

  assert.ok(testRows.some((row) => row.countBucket === '2-3'), 'test kind should be bucketed by its own count of 3');
  assert.ok(buildRows.some((row) => row.countBucket === '1'), 'build kind should be bucketed by its own count of 1');
  assert.ok(!testRows.some((row) => row.countBucket === '4+'), 'test kind should not inherit the run-total bucket of 4');
  assert.ok(!buildRows.some((row) => row.countBucket === '4+'), 'build kind should not inherit the run-total bucket of 4');
});

test('site data validation rejects malformed tool usage payloads', async () => {
  const fixture = await loadFixture();
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  const invalidSchema = deepClone(bundle) as any;
  invalidSchema.toolUsage.schemaVersion = 999;
  assert.throws(
    () => validateSiteDataBundle(invalidSchema),
    /tool-usage.json has an unexpected schemaVersion/,
  );

  const missingToolName = deepClone(bundle) as any;
  missingToolName.toolUsage.rows = [{ callCount: 1, runId: 'run-x' }];
  missingToolName.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(missingToolName),
    /tool-usage.json row 0 is missing toolName/,
  );

  const missingRows = deepClone(bundle) as any;
  delete missingRows.toolUsage.rows;
  assert.throws(
    () => validateSiteDataBundle(missingRows),
    /tool-usage.json is missing rows/,
  );

  const nonObjectRow = deepClone(bundle) as any;
  nonObjectRow.toolUsage.rows = [null];
  assert.throws(
    () => validateSiteDataBundle(nonObjectRow),
    /tool-usage.json row 0 must be an object/,
  );

  const invalidCallCount = deepClone(bundle) as any;
  invalidCallCount.toolUsage.rows = [{ toolName: 'bash', callCount: -1, runId: 'run-x' }];
  invalidCallCount.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(invalidCallCount),
    /tool-usage.json row 0 has an invalid callCount/,
  );

  const missingRunId = deepClone(bundle) as any;
  missingRunId.toolUsage.rows = [{ toolName: 'bash', callCount: 1 }];
  missingRunId.toolUsage.summaryRows = [];
  assert.throws(
    () => validateSiteDataBundle(missingRunId),
    /tool-usage.json row 0 is missing runId/,
  );

  const missingSummaryRows = deepClone(bundle) as any;
  delete missingSummaryRows.toolUsage.summaryRows;
  assert.throws(
    () => validateSiteDataBundle(missingSummaryRows),
    /tool-usage.json is missing summaryRows/,
  );

  const nonObjectSummaryRow = deepClone(bundle) as any;
  nonObjectSummaryRow.toolUsage.summaryRows = [null];
  assert.throws(
    () => validateSiteDataBundle(nonObjectSummaryRow),
    /tool-usage.json summary row 0 must be an object/,
  );

  const invalidSummaryRow = deepClone(bundle) as any;
  invalidSummaryRow.toolUsage.summaryRows = [{ toolName: 'bash', callCount: 1 }];
  assert.throws(
    () => validateSiteDataBundle(invalidSummaryRow),
    /tool-usage.json summary row 0 has an invalid affectedRunCount/,
  );

  const missingSummaryToolName = deepClone(bundle) as any;
  missingSummaryToolName.toolUsage.summaryRows = [{ callCount: 1, affectedRunCount: 0 }];
  assert.throws(
    () => validateSiteDataBundle(missingSummaryToolName),
    /tool-usage.json summary row 0 is missing toolName/,
  );
});

test('model leaderboard validation requires v4 evidence and interval fields', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const missingEvidence = deepClone(bundle) as any;
  delete missingEvidence.modelLeaderboard.rows[0].userEvidenceMass;
  assert.throws(() => validateSiteDataBundle(missingEvidence), /userEvidenceMass is invalid/);

  const missingSourceWeights = deepClone(bundle) as any;
  delete missingSourceWeights.modelLeaderboard.sourceWeights;
  assert.throws(() => validateSiteDataBundle(missingSourceWeights), /missing sourceWeights/);

  const invalidInterval = deepClone(bundle) as any;
  invalidInterval.modelLeaderboard.rows.find((row: any) => row.compositeScore !== null).scoreInterval80.lower = -1;
  assert.throws(() => validateSiteDataBundle(invalidInterval), /invalid scoreInterval80/);
});

test('model leaderboard validation catches provider runCount sum mismatch', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  mutated.modelLeaderboard.rows[0].providers[0].runCount += 999;
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /provider runCount sum.*!= row\.runCount/,
  );
});

test('model leaderboard validation catches provider scoredRunCount sum mismatch', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  mutated.modelLeaderboard.rows[0].providers[0].scoredRunCount += 999;
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /provider scoredRunCount sum.*!= row\.scoredRunCount/,
  );
});

test('model leaderboard validation catches missing dimensions', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  delete mutated.modelLeaderboard.rows[0].dimensions;
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /row 0 is missing dimensions/,
  );
});

test('model leaderboard validation catches non-contiguous rank', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  const firstRanked = mutated.modelLeaderboard.rows.find((row: any) => row.compositeScore !== null);
  firstRanked.rank = 5;
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /non-contiguous rank/,
  );
});

test('model leaderboard validation catches ranked row after unranked', async () => {
  const fixture = deepClone(await loadFixture());
  // Ensure an unknown family exists (compositeScore === null, unranked).
  delete (fixture.completedRuns[0] as Partial<typeof fixture.completedRuns[0]>).modelId;
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  const mutated = deepClone(bundle) as any;
  const rows = mutated.modelLeaderboard.rows as any[];
  const unrankedIndex = rows.findIndex((row) => row.compositeScore === null);
  assert.ok(unrankedIndex >= 0, 'fixture produces an unranked (unknown) family');
  assert.ok(unrankedIndex > 0, 'unranked row is not first (ranked rows precede it)');
  // Move the unranked row to the front so a ranked row follows it.
  const [unranked] = rows.splice(unrankedIndex, 1);
  rows.unshift(unranked);
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /ranked after unranked rows/,
  );
});

test('model leaderboard validation catches missing scoringCoverageGateFailed', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  delete mutated.modelLeaderboard.rows[0].scoringCoverageGateFailed;
  assert.throws(
    () => validateSiteDataBundle(mutated),
    /missing scoringCoverageGateFailed/,
  );
});

test('model leaderboard validation catches null compositeScore with non-null rank', async () => {
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
  const mutated = deepClone(bundle) as any;
  const unranked = mutated.modelLeaderboard.rows.find((row: any) => row.compositeScore === null);
  if (unranked) {
    unranked.rank = 1;
    assert.throws(
      () => validateSiteDataBundle(mutated),
      /null compositeScore but non-null rank/,
    );
  }
});

test('writeSiteData rejects JSON targets and unexpected non-JSON files', async () => {
  await withTempDir(async (dir) => {
    const bundle = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture()));
    const populatedDir = path.join(dir, 'site-data');
    await fs.mkdir(populatedDir, { recursive: true });
    await fs.writeFile(path.join(populatedDir, 'notes.txt'), 'unexpected', 'utf8');

    await assert.rejects(
      async () => await writeSiteData(populatedDir, bundle),
      /Unexpected non-JSON file found in site data directory: notes.txt/,
    );
    await assert.rejects(
      async () => await writeSiteData(path.join(dir, 'site-data.json'), bundle),
      /Site-data output must be a directory/,
    );
  });
});

test('token-throughput artifact retains errored/tokenless turns and validates per-turn token/context fields', async () => {
  const prepared = deepClone(prepareSourceAnalytics(await loadFixture()));
  // Inject an errored (tokenless) turn with null tokensPerSecond. It must be
  // retained in the artifact for coverage/error analysis — chart transforms
  // filter null tokensPerSecond at render time; the artifact must not drop rows.
  prepared.turnThroughput.push({
    runId: 'retention-run',
    endedAt: '2026-05-10T15:00:00.000Z',
    startedDay: '2026-05-10',
    modelId: 'gpt-4.1',
    modelFamily: 'gpt-4.1',
    thinkingLevel: 'medium',
    experimentAssignment: null,
    outputTokens: 0,
    generationDurationMs: 0,
    concurrentBusySessions: 1,
    status: 'error',
    tokensPerSecond: null,
    turnLatencyMs: null,
    overheadMs: null,
    providerLatencyMs: null,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: null,
  });

  const bundle = buildSiteDataBundle(prepared);
  // Validates the new inputTokens/cacheReadTokens/cacheWriteTokens/contextTokens
  // fields on every row, including the injected null-tokensPerSecond row.
  validateSiteDataBundle(bundle);

  const retained = bundle.tokenThroughput.rows.filter((row) => row.runId === 'retention-run');
  assert.equal(retained.length, 1, 'errored/tokenless turn must be retained in the artifact');
  assert.equal(retained[0]?.tokensPerSecond, null);
  assert.equal(retained[0]?.inputTokens, 0);
  assert.equal(retained[0]?.cacheReadTokens, 0);
  assert.equal(retained[0]?.cacheWriteTokens, 0);
  assert.equal(retained[0]?.contextTokens, null);
});
