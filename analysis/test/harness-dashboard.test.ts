import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelLeaderboardFromRuns } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { loadFixture } from './helpers.ts';
import { currentHarnessRuns, overviewCardValues } from '../site/app.ts';
import { newCharts } from '../site/charts/index.ts';
import { renderChartEntries, type ChartContext } from '../site/lib.ts';

test('dashboard separates filtered all-history and current-harness run cohorts', () => {
  const runs = [
    { runId: 'legacy', isCurrentHarness: false },
    { runId: 'current', isCurrentHarness: true },
    { runId: 'unknown' },
  ] as any[];
  assert.deepEqual(currentHarnessRuns(runs).map((run) => run.runId), ['current']);
});

test('chart registry scopes only explicitly current-harness entries', async () => {
  const seen: Array<[string, string, string[]]> = [];
  const context = {
    runs: [{ runId: 'legacy' }, { runId: 'current' }],
    currentHarnessRuns: [{ runId: 'current' }],
    runCohort: 'all-history',
  } as unknown as ChartContext;
  await renderChartEntries([
    { id: 'all', runCohort: 'all-history', render: async (ctx) => { seen.push([ctx.runCohort, ctx.runCohort, ctx.runs.map((run) => run.runId)]); } },
    { id: 'current', runCohort: 'current-harness', render: async (ctx) => { seen.push([ctx.runCohort, ctx.runCohort, ctx.runs.map((run) => run.runId)]); } },
    { id: 'artifact', runCohort: 'artifact', render: async (ctx) => { seen.push([ctx.runCohort, ctx.runCohort, ctx.runs.map((run) => run.runId)]); } },
  ], context);
  assert.deepEqual(seen, [
    ['all-history', 'all-history', ['legacy', 'current']],
    ['current-harness', 'current-harness', ['current']],
    ['artifact', 'artifact', ['legacy', 'current']],
  ]);
});

test('overview cards mix current-harness quality issues with all-history objective telemetry', () => {
  const legacy = {
    runId: 'legacy', status: 'closed', busyDurationMs: 1000, toolCallCount: 4, toolFailureCount: 2,
    resultIssueCount: 4, verificationTotalCount: 0, totalEstimatedCostUsd: 3,
  };
  const current = {
    runId: 'current', status: 'closed', busyDurationMs: 3000, toolCallCount: 2, toolFailureCount: 0,
    resultIssueCount: 1, verificationTotalCount: 1, totalEstimatedCostUsd: 5,
  };
  const values = overviewCardValues([legacy, current] as any, {
    totalCompletedRuns: 2, totalOpenRuns: 0, verificationRunRate: 0, toolFailureRate: 0.5,
    resultIssueRate: 1, medianBusyDurationMs: 2000, totalEstimatedCostUsd: 8, latestRunTimestamp: null,
  } as any, true, [current] as any);
  assert.equal(values.completed, 2);
  assert.equal(values.cost, 8);
  assert.equal(values.failures, 0.5);
  assert.equal(values.busy, 2000);
  assert.equal(values.verification, 1);
  assert.equal(values.resultIssues, 0.5);
});

test('leaderboard keeps V2 evidence population while sourcing runtime diagnostics from current harness runs', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const base = prepared.runs[0]!;
  const legacy = { ...base, runId: 'legacy-runtime', isCurrentHarness: false, harnessStatus: 'legacy' as const, totalEstimatedCostUsd: 99, busyDurationMs: 99000 };
  const current = { ...base, runId: 'current-runtime', isCurrentHarness: true, harnessStatus: 'current' as const, totalEstimatedCostUsd: 7, busyDurationMs: 7000 };
  const row = createModelLeaderboardFromRuns([legacy, current]).rows.find((candidate) => candidate.modelId === current.modelFamily)!;
  assert.equal(row.runCount, 1);
  assert.equal(row.medianCostUsd, 7);
  assert.equal(row.medianDurationMs, 7000);
});

test('every chart entry declares its data cohort, including artifact-backed outcomes', () => {
  assert.ok(newCharts.length > 0);
  assert.ok(newCharts.every((entry) => ['all-history', 'current-harness', 'artifact'].includes(entry.runCohort)));
  assert.ok(newCharts.filter((entry) => entry.runCohort === 'artifact').every((entry) => entry.id.startsWith('chart-outcome-')));
});
