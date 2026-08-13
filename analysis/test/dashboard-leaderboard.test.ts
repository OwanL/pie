import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle } from '../scripts/site-data.ts';
import {
  DEFAULT_FILTERS,
  applyFilters,
  coverageSummary,
  leaderboardRows,
  overviewCardValues,
  sessionReviewAnalyticsHtml,
} from '../site/app.ts';
import { loadFixture } from './helpers.ts';

test('dashboard leaderboard consumes the generated V2 family rows without a second scoring path', async () => {
  const prepared = prepareSourceAnalytics(await loadFixture());
  const generated = buildSiteDataBundle(prepared).modelLeaderboard;
  const dashboard = leaderboardRows(prepared.runs, generated);

  assert.deepEqual(dashboard.rows, generated.rows);
  assert.equal(dashboard.tableRows.length, generated.rows.length);
  for (const displayed of dashboard.tableRows) {
    const source = generated.rows.find((row) => row.modelId === displayed.modelId)!;
    assert.equal(displayed.rank, source.rank);
    assert.equal(displayed.score, source.compositeScore);
    assert.match(displayed.reviewLabel, /reviews/);
    assert.ok(['review-backed', 'thin-review', 'telemetry-only'].includes(displayed.evidenceTier));
  }
});

test('dashboard makes sparse evidence and rank uncertainty conspicuous while retaining rank text', async () => {
  const generated = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture())).modelLeaderboard;
  const ranked = generated.rows.find((row) => row.rank !== null);
  if (ranked) {
    ranked.evidenceTier = 'thin-review';
    ranked.scoreInterval80 = { lower: 0.3, upper: 0.7, level: 0.8, bestRank: 1, worstRank: 3 };
  }
  const displayed = leaderboardRows([], generated).tableRows.find((row) => row.modelId === ranked?.modelId);
  if (displayed) {
    assert.match(displayed.rankLabel, /^#/);
    assert.match(displayed.evidenceWarning, /SPARSE EVIDENCE/);
    assert.match(displayed.evidenceWarning, /RANK UNCERTAIN/);
    assert.equal(displayed.rankRangeLabel, '#1–#3');
  }

  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(html, /Sparse review evidence and overlapping rank intervals/);
  assert.equal((html.match(/class="toggle"/g) ?? []).length, 1);
  assert.match(html, /id="latest-run"/);
  assert.match(html, /id="overview-freshness"/);
  assert.match(html, /id="tool-result-pruning-impact"/);
});

test('default filters preserve the runtime cohort and family-keyed model filtering', async () => {
  const runs = prepareSourceAnalytics(await loadFixture()).runs;
  assert.equal(applyFilters(runs, DEFAULT_FILTERS).length, runs.length);
  const family = runs.find((run) => run.modelFamily)?.modelFamily;
  if (family) {
    const filtered = applyFilters(runs, { ...DEFAULT_FILTERS, modelId: family });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((run) => (run.modelFamily?.trim() || run.modelId?.trim()) === family));
  }
});

test('coverage summary reports only runtime completion and telemetry coverage', () => {
  const runs = [
    { status: 'open', totalEstimatedCostUsd: 1, tokenReportedTurnCount: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, mixedModelConfig: false, identityFallback: false },
    { status: 'closed', totalEstimatedCostUsd: 2, tokenReportedTurnCount: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, mixedModelConfig: false, identityFallback: false },
    { status: 'closed', totalEstimatedCostUsd: null, tokenReportedTurnCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, mixedModelConfig: true, identityFallback: true },
  ] as any[];
  assert.deepEqual(coverageSummary(runs), {
    selectedRunCount: 3,
    completed: { count: 2, percentage: 2 / 3 },
    priced: { count: 1, percentage: 1 / 2 },
    tokenTelemetry: { count: 1, percentage: 1 / 2 },
    mixedModel: { count: 1, percentage: 1 / 2 },
    stableIdentity: { count: 1, percentage: 1 / 2 },
  });
});

test('filtered overview values use filtered result issues and the even-sample median', () => {
  const runs = [
    { runId: 'a', status: 'closed', updatedAt: '2026-01-01T00:00:00.000Z', busyDurationMs: 1000, toolCallCount: 2, toolFailureCount: 0, resultIssueCount: 1 },
    { runId: 'b', status: 'closed', updatedAt: '2026-01-02T00:00:00.000Z', busyDurationMs: 3000, toolCallCount: 2, toolFailureCount: 0, resultIssueCount: 0 },
    { runId: 'open', status: 'open', updatedAt: '2026-01-03T00:00:00.000Z', busyDurationMs: 9000, toolCallCount: 9, toolFailureCount: 0, resultIssueCount: 9 },
  ] as any[];
  const values = overviewCardValues(runs, {} as any, false);
  assert.equal(values.busy, 2000, 'filtered cards use the canonical even-sample median');
  assert.equal(values.resultIssues, 0.25, 'result issues are divided by completed filtered tool calls');
  assert.equal(values.latestRunTimestamp, '2026-01-02T00:00:00.000Z', 'open runs do not define overview freshness');
});

test('session review analytics renders V2 ingestion diagnostics including rejection reasons', async () => {
  const analytics = buildSiteDataBundle(prepareSourceAnalytics(await loadFixture())).sessionReviewAnalytics;
  analytics.diagnostics = {
    rawProductionCount: 4,
    acceptedCount: 2,
    rejectedCount: 2,
    rejectedByReason: {
      unsupported_schema: 1,
      unsupported_rubric: 0,
      unsupported_index: 0,
      invalid_identity: 0,
      invalid_payload: 1,
    },
  };
  const html = sessionReviewAnalyticsHtml(analytics);
  assert.match(html, /Raw:<\/strong> 4/);
  assert.match(html, /Accepted:<\/strong> 2/);
  assert.match(html, /Rejected:<\/strong> 2/);
  assert.match(html, /unsupported_schema: 1/);
  assert.match(html, /invalid_payload: 1/);
});
