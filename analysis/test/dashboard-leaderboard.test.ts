import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { createModelLeaderboard } from '../scripts/leaderboard.ts';
import {
  DEFAULT_FILTERS,
  applyFilters,
  compositionByModelRows,
  coverageSummary,
  leaderboardRows,
  modelThinkingRows,
} from '../site/app.ts';
import { deepClone, loadFixture } from './helpers.ts';

/**
 * The dashboard recomputes its leaderboard in-browser via `leaderboardRows` (independent of the
 * persisted `model-leaderboard.json`). This guards that the user-facing computation is also
 * provider-agnostic: provider-specific ids sharing a family collapse into one row, with a
 * `providersLabel` making the collapse visible — mirroring `createModelLeaderboard`.
 */
test('dashboard leaderboardRows is provider-agnostic: collapses provider-specific ids sharing a family into one row', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  function addScoredRun(runId: string, modelId: string): void {
    const run = deepClone(baseRun);
    run.runId = runId;
    run.taskGroupId = `${runId}-task`;
    run.modelId = modelId;
    run.thinkingLevel = 'high';
    run.status = 'scored';
    run.scored = true;
    run.finalizationReason = 'scored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    run.outcome = { resolution: 'resolved' as const, satisfaction: 5 };
    fixture.completedRuns.push(run);
    fixture.outcomes.push({
      schemaVersion: 1,
      kind: 'run_outcome' as const,
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome,
    });
  }

  // GLM 5.2 across two providers (5 scored tasks each) — must collapse into ONE row.
  for (let index = 0; index < 5; index += 1) addScoredRun(`umans-glm-${index}`, 'umans-glm-5.2');
  for (let index = 0; index < 5; index += 1) addScoredRun(`ollama-glm-${index}`, 'glm-5.2:cloud');
  // A distinct model (different family) must NOT collapse with GLM 5.2.
  for (let index = 0; index < 10; index += 1) addScoredRun(`gpt-${index}`, 'gpt-5.2');

  const prepared = prepareSourceAnalytics(fixture);
  const dashboard = leaderboardRows(prepared.runs);

  const glmRow = dashboard.rows.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glmRow, 'GLM 5.2 should appear as a single provider-agnostic row');
  assert.equal(glmRow!.runCount, 10, 'both providers collapsed into one row');
  assert.equal(glmRow!.scoredRunCount, 10);
  // The collapse is surfaced so provider differences stay investigable.
  const glmDisplayed = dashboard.tableRows.find((row) => row.modelId === 'glm-5.2')!;
  assert.equal(
    glmDisplayed.providersLabel,
    '2 providers · glm-5.2:cloud, umans-glm-5.2',
    'providersLabel lists the collapsed provider-specific ids',
  );

  // Distinct family stays a separate row (no over-collapsing).
  const gptRow = dashboard.rows.find((row) => row.modelId === 'gpt-5.2');
  assert.ok(gptRow, 'GPT-5.2 should appear as its own row');
  assert.equal(gptRow!.runCount, 10);
  // Single provider whose id equals the family → nothing to surface.
  assert.equal(dashboard.tableRows.find((row) => row.modelId === 'gpt-5.2')!.providersLabel, '');

  // No provider-specific id leaks as its own row.
  assert.ok(
    !dashboard.rows.some((row) => row.modelId === 'umans-glm-5.2'),
    'umans-glm-5.2 must not appear as its own row',
  );
  assert.ok(
    !dashboard.rows.some((row) => row.modelId === 'glm-5.2:cloud'),
    'glm-5.2:cloud must not appear as its own row',
  );
});

/** The browser must consume the generated implementation even on the paths that previously drifted. */
test('dashboard leaderboardRows has exact generated parity with missing telemetry and mixed-model runs', async () => {
  const fixture = deepClone(await loadFixture());
  const baseRun = fixture.completedRuns[0]!;
  fixture.completedRuns = [];
  fixture.openRuns = [];
  fixture.outcomes = [];

  const add = (
    modelId: string,
    index: number,
    options: { mixed?: boolean; source?: 'user' | 'agent'; satisfaction?: number } = {},
  ): void => {
    const run = deepClone(baseRun);
    run.runId = `${modelId}-${index}`;
    run.taskGroupId = `${modelId}-task-${index}`;
    run.modelId = modelId;
    run.thinkingLevel = 'high';
    run.status = 'scored';
    run.scored = true;
    run.mixedModelConfig = options.mixed ?? false;
    run.finalizationReason = 'scored';
    run.finalizedAt = '2026-05-10T14:19:00.000Z';
    run.outcome = {
      resolution: options.mixed ? 'unresolved' : 'resolved',
      satisfaction: options.satisfaction ?? (options.mixed ? 1 : 5),
      source: options.source ?? 'user',
    };
    fixture.completedRuns.push(run);
    fixture.outcomes.push({
      schemaVersion: 1,
      kind: 'run_outcome',
      recordedAt: '2026-05-10T14:19:00.000Z',
      sessionPath: baseRun.sessionPath,
      runId: run.runId,
      taskGroupId: run.taskGroupId,
      outcome: run.outcome,
    });
  };

  for (let index = 0; index < 12; index += 1) {
    add('observed-process-model', index, { source: index >= 10 ? 'agent' : 'user' });
  }
  for (let index = 0; index < 10; index += 1) {
    add('missing-process-model', index, { satisfaction: 3 });
  }
  add('missing-process-model', 10, { mixed: true });
  add('missing-process-model', 11, { mixed: true, source: 'agent' });

  const prepared = prepareSourceAnalytics(fixture);
  for (const run of prepared.runs) {
    if (run.modelId === 'observed-process-model') {
      run.editRevisitRate = 0.2;
      run.tokenEfficiency = 10;
      run.verificationTotalCount = 1;
      run.verificationState = 'passing';
      run.totalEstimatedCostUsd = 2;
      run.estimatedCostUsd = 99;
    } else {
      run.editRevisitRate = null;
      run.tokenEfficiency = null;
      run.verificationTotalCount = 0;
      run.verificationState = 'none';
      run.totalEstimatedCostUsd = null;
      run.estimatedCostUsd = 3;
    }
  }

  const generated = createModelLeaderboard(prepared);
  const browser = leaderboardRows(prepared.runs, generated);
  assert.deepEqual(browser.rows, generated.rows, 'browser exposes the exact generated leaderboard rows');

  const observed = browser.rows.find((row) => row.modelId === 'observed-process-model')!;
  assert.equal(observed.scoredRunCount, 10);
  assert.equal(observed.userOutcomeCount, 10);
  assert.equal(observed.agentOutcomeCount, 0, 'run outcomes marked agent are not sidecar review evidence');

  const missing = browser.rows.find((row) => row.modelId === 'missing-process-model')!;
  assert.equal(missing.mixedModelExcludedCount, 2);
  assert.equal(missing.scoredRunCount, 10);
  assert.equal(missing.dimensions.fileChurn.n, 0);
  assert.equal(missing.dimensions.tokenEfficiency.n, 0);
  assert.equal(missing.dimensions.verificationPassRate.n, 0);
  assert.equal(missing.medianCostUsd, null, 'explicitly unknown totals must not fall back to partial parent cost');

  const displayed = browser.tableRows.find((row) => row.modelId === missing.modelId)!;
  assert.equal(displayed.compositeScore, missing.compositeScore);
  assert.equal(displayed.mixedModelExcludedCount, missing.mixedModelExcludedCount);
  assert.equal(displayed.outcomeSourceLabel, `${missing.userOutcomeCount} legacy user / ${missing.agentOutcomeCount} V2 reviews / ${missing.legacyAgentReviewCount} legacy V1 agent`);
  assert.equal(
    browser.tableRows.find((row) => row.modelId === observed.modelId)!.outcomeSourceLabel,
    '10 legacy user / 0 V2 reviews / 0 legacy V1 agent',
  );
});

test('dashboard leaves families without V2 review evidence visible but unranked', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const base = prepared.runs.find((run) => run.outcomeSource === 'user' && !run.mixedModelConfig && !run.mixedTreatmentConfig)!;
  const runs: typeof prepared.runs = [];
  let minute = 0;
  const addTasks = (modelId: string, low: number, high: number, unscored = 0): void => {
    for (const [band, count, promptChars] of [['low', low, 20], ['high', high, 2_000]] as const) {
      for (let index = 0; index < count; index += 1) {
        minute += 1;
        runs.push({
          ...base,
          runId: `${modelId}-${band}-${index}`,
          taskGroupId: `${modelId}-${band}-task-${index}`,
          modelId,
          modelFamily: modelId,
          thinkingLevel: 'high',
          startedAt: `2026-05-10T02:${String(minute % 60).padStart(2, '0')}:00.000Z`,
          status: 'scored',
          scored: true,
          satisfaction: 4,
          resolution: 'resolved',
          outcomeSource: 'user',
          mixedModelConfig: false,
          mixedTreatmentConfig: false,
          initialUserMessageChars: promptChars,
        });
      }
    }
    for (let index = 0; index < unscored; index += 1) {
      minute += 1;
      runs.push({
        ...base,
        runId: `${modelId}-unscored-${index}`,
        taskGroupId: `${modelId}-unscored-task-${index}`,
        modelId,
        modelFamily: modelId,
        thinkingLevel: 'high',
        startedAt: `2026-05-10T03:${String(minute % 60).padStart(2, '0')}:00.000Z`,
        status: 'closed_unscored',
        scored: false,
        satisfaction: null,
        resolution: null,
        outcomeSource: null,
        mixedModelConfig: false,
        mixedTreatmentConfig: false,
        initialUserMessageChars: index % 2 === 0 ? 20 : 2_000,
      });
    }
  };

  addTasks('ranked-model', 10, 10);
  addTasks('coverage-gated-model', 5, 5, 16);
  addTasks('overlap-gated-model', 2, 8);
  addTasks('evidence-gated-model', 4, 5);

  const dashboard = leaderboardRows(runs);
  assert.equal(dashboard.composite.length, 0, 'legacy user outcomes cannot create a V2 rank');
  assert.equal(dashboard.tableRows.length, 4);
  assert.ok(dashboard.tableRows.every((row) => row.rank === null));
  assert.ok(dashboard.tableRows.every((row) => row.eligibilityLabel === 'telemetry-only'));
  assert.ok(dashboard.tableRows.every((row) => row.intervalLabel === '—' && row.rankRangeLabel === '—'));
});

test('dashboard model-quality mappings use stable-model stable-treatment user outcomes only', () => {
  const runs = [
    { runId: 'user', status: 'scored', scored: true, satisfaction: 5, resolution: 'resolved', outcomeSource: 'user', mixedModelConfig: false, modelId: 'm', modelFamily: 'm', thinkingLevel: 'high' },
    { runId: 'agent', status: 'scored', scored: true, satisfaction: 1, resolution: 'unresolved', outcomeSource: 'agent', mixedModelConfig: false, modelId: 'm', modelFamily: 'm', thinkingLevel: 'high' },
    { runId: 'mixed', status: 'scored', scored: true, satisfaction: 1, resolution: 'unresolved', outcomeSource: 'user', mixedModelConfig: true, mixedTreatmentConfig: true, modelId: 'm', modelFamily: 'm', thinkingLevel: 'high' },
    { runId: 'treatment', status: 'scored', scored: true, satisfaction: 1, resolution: 'unresolved', outcomeSource: 'user', mixedModelConfig: false, mixedTreatmentConfig: true, modelId: 'm', modelFamily: 'm', thinkingLevel: 'high' },
  ] as any[];

  const quality = modelThinkingRows(runs);
  assert.equal(quality.length, 1);
  assert.equal(quality[0]!.runCount, 4);
  assert.equal(quality[0]!.scoredRunCount, 1);
  assert.equal(quality[0]!.meanSatisfaction, 5);

  const composition = compositionByModelRows(runs);
  assert.equal(composition.find((row) => row.resolution === 'resolved')?.count, 1);
  assert.equal(composition.find((row) => row.resolution === 'unresolved')?.count, 0);
  assert.ok(composition.every((row) => row.scoredRunCount === 1));
});

test('default filters preserve the all-run base cohort', async () => {
  const runs = [
    { runId: 'open', status: 'open', scored: false, satisfaction: null, thinkingLevel: null, totalEstimatedCostUsd: 1, estimatedCostUsd: 1, tokenReportedTurnCount: 1, mixedModelConfig: false },
    { runId: 'scored', status: 'scored', scored: true, satisfaction: 5, thinkingLevel: 'high', totalEstimatedCostUsd: 2, estimatedCostUsd: 99, tokenReportedTurnCount: 1, mixedModelConfig: false },
    { runId: 'closed', status: 'closed', scored: false, satisfaction: null, thinkingLevel: 'low', totalEstimatedCostUsd: null, estimatedCostUsd: 3, tokenReportedTurnCount: 0, mixedModelConfig: true },
    { runId: 'agent', status: 'scored', scored: true, satisfaction: 4, thinkingLevel: 'high', totalEstimatedCostUsd: Number.NaN, estimatedCostUsd: null, tokenReportedTurnCount: 2, mixedModelConfig: false },
  ] as any[];

  assert.equal(DEFAULT_FILTERS.scoredOnly, false);
  assert.equal(applyFilters(runs, DEFAULT_FILTERS).length, runs.length);

  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const scoredOnlyControl = html.match(/<input id="filter-scored-only"[^>]*>/)?.[0];
  assert.ok(scoredOnlyControl, 'scored-only control exists');
  assert.doesNotMatch(scoredOnlyControl, /\bchecked\b/, 'HTML default is also unchecked');
});

test('coverageSummary reports filtered-cohort completion and telemetry coverage', () => {
  const runs = [
    { status: 'open', scored: false, satisfaction: null, totalEstimatedCostUsd: 1, estimatedCostUsd: 1, tokenReportedTurnCount: 1, mixedModelConfig: false },
    { status: 'scored', scored: true, satisfaction: 5, outcomeSource: 'user', totalEstimatedCostUsd: 2, estimatedCostUsd: 99, tokenReportedTurnCount: 1, mixedModelConfig: false },
    { status: 'closed', scored: false, satisfaction: null, totalEstimatedCostUsd: null, estimatedCostUsd: 3, tokenReportedTurnCount: 0, mixedModelConfig: true },
    { status: 'scored', scored: true, satisfaction: 4, outcomeSource: 'user', totalEstimatedCostUsd: Number.NaN, estimatedCostUsd: null, tokenReportedTurnCount: 2, mixedModelConfig: false },
  ] as any[];

  assert.deepEqual(coverageSummary(runs), {
    selectedRunCount: 4,
    completed: { count: 3, percentage: 3 / 4 },
    outcomeScored: { count: 2, percentage: 2 / 3 },
    priced: { count: 1, percentage: 1 / 3 },
    tokenTelemetry: { count: 2, percentage: 2 / 3 },
    mixedModel: { count: 1, percentage: 1 / 3 },
  });
});
