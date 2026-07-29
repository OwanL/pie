import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';

import { buildDuckDbDatabase, openDuckDbQuerySession, runNamedDuckDbQuery, runDuckDbQuery } from '../scripts/duckdb.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import type { PreparedToolResultIssueRow } from '../scripts/contracts.ts';
import { loadFixture } from './helpers.ts';

// Building the DuckDB database from the fixture dominates test time (~450ms).
// Build it ONCE at module load (top-level await) so the cost is paid during
// module setup rather than attributed to any test case, then run every named
// query against the shared database. (A `before()` hook would work functionally
// but `node:test` rolls hook time into the first test's reported duration.)
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-duckdb-test-'));
const sharedDbPath = path.join(tempDir, 'usage.duckdb');
const exportsDir = path.join(tempDir, 'exports');
const prepared = prepareSourceAnalytics(await loadFixture());
await buildDuckDbDatabase({
  dbPath: sharedDbPath,
  exportsDir,
  prepared,
});
const sharedDb = await openDuckDbQuerySession(sharedDbPath);

after(async () => {
  await sharedDb.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('DuckDB build and named queries work against the fixture', async () => {
  const modelQualityRows = await sharedDb.queryNamed('model_quality');
  const sessionReviewRows = await sharedDb.queryNamed('session_review_quality');
  const toolUsageRows = await sharedDb.queryNamed('tool_usage');
  const toolFailureRows = await sharedDb.queryNamed('tool_failures');
  const timelineRows = await sharedDb.queryNamed('timeline');

  assert.ok(modelQualityRows.length >= 3);
  assert.ok(Array.isArray(sessionReviewRows));
  assert.ok(toolUsageRows.some((row) => row['tool_name'] === 'bash'));
  assert.ok(Array.isArray(toolFailureRows));
  assert.ok(timelineRows.some((row) => row['bucket_start'] === '2026-05-10'));
});

test('DuckDB exposes only V2 review quality tables and metrics', async () => {
  const rows = await sharedDb.queryNamed('model_quality');
  assert.ok(rows.every((row) => 'v2_review_count' in row && 'mean_quality_index_v1' in row));

  const tables = await sharedDb.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
  const tableNames = new Set(tables.map((row) => String(row['table_name'])));
  assert.ok(tableNames.has('session_reviews_v2'));
  assert.ok(tableNames.has('review_criteria_v2'));
  assert.equal(tableNames.has('review_findings_v2'), false);
  assert.ok(tableNames.has('review_reviewers_v2'));
  assert.equal(tableNames.has('agent_reviews'), false);

  const runColumns = await sharedDb.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'runs'");
  const runColumnNames = new Set(runColumns.map((row) => String(row['column_name'])));
  for (const removed of ['scored', 'resolution', 'satisfaction', 'outcome_source', 'first_attempt_success']) {
    assert.equal(runColumnNames.has(removed), false, `${removed} must not remain in runs`);
  }

  const views = await sharedDb.query("SELECT view_name FROM duckdb_views() WHERE schema_name = 'main'");
  assert.equal(views.some((row) => row['view_name'] === 'outcomes'), false);

  const leaderboardSql = await fs.readFile(new URL('../queries/model_leaderboard.sql', import.meta.url), 'utf8');
  const leaderboardRows = await sharedDb.query(leaderboardSql);
  assert.ok(leaderboardRows.every((row) => 'v2_review_count' in row && 'mean_quality_index_v1' in row));
});

test('V2 review mass flows through model quality and leaderboard SQL', async () => {
  const base = prepared.runs.find((run) => run.status !== 'open' && !run.mixedModelConfig && !run.mixedTreatmentConfig);
  assert.ok(base, 'fixture must contain a stable run');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-duckdb-v2-review-'));
  try {
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({ dbPath, exportsDir: path.join(dir, 'exports'), prepared });
    const runId = base.runId.replaceAll("'", "''");
    await runDuckDbQuery(dbPath, `UPDATE runs SET session_id = 'v2-review-sql-session', identity_fallback = FALSE WHERE run_id = '${runId}'`);
    await runDuckDbQuery(dbPath, `
      INSERT INTO session_reviews_v2 (
        review_id, session_id, identity_fallback, quality_index_v1,
        criterion_coverage, external_blocker_rate, blinding_applied
      ) VALUES ('v2-review-sql', 'v2-review-sql-session', FALSE, 87, 1, 0, TRUE)
    `);

    const qualityRows = await runNamedDuckDbQuery(dbPath, 'model_quality');
    assert.ok(qualityRows.some((row) => Number(row['v2_review_count']) > 0 && Number(row['mean_quality_index_v1']) === 87));

    const leaderboardSql = await fs.readFile(new URL('../queries/model_leaderboard.sql', import.meta.url), 'utf8');
    const leaderboardRows = await runDuckDbQuery(dbPath, leaderboardSql);
    assert.ok(leaderboardRows.some((row) => Number(row['v2_review_count']) > 0 && Number(row['mean_quality_index_v1']) === 87));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('model leaderboard SQL uses one latest stable run per task group for process diagnostics', async () => {
  const base = prepared.runs.find((run) => run.status !== 'open' && !run.mixedModelConfig && !run.mixedTreatmentConfig);
  assert.ok(base, 'fixture must contain an attributable stable run');
  const first = {
    ...base,
    runId: 'terminal-a-first',
    taskGroupId: 'terminal-task',
    startedAt: '2026-05-10T01:00:00.000Z',
    editRevisitRate: 0.1,
  };
  const later = {
    ...base,
    runId: 'terminal-a-later',
    taskGroupId: 'terminal-task',
    startedAt: '2026-05-10T02:00:00.000Z',
    editRevisitRate: 0.5,
  };
  const tiedByRunId = {
    ...later,
    runId: 'terminal-z-later',
    editRevisitRate: 0.8,
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-duckdb-terminal-task-'));
  try {
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: { ...prepared, runs: [first, later, tiedByRunId] },
    });
    const sql = await fs.readFile(new URL('../queries/model_leaderboard.sql', import.meta.url), 'utf8');
    const rows = await runDuckDbQuery(dbPath, sql);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.['run_count']), 3, 'all retries remain provenance');
    assert.equal(Number(rows[0]?.['attributable_task_count']), 1);
    assert.equal(Number(rows[0]?.['file_churn_rate']), 0.8, 'latest timestamp then greatest runId selects the canonical diagnostic run');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DuckDB runs expose aggregate tool timing coverage', async () => {
  const rows = await sharedDb.query(
    'SELECT tool_duration_ms, timed_tool_call_count FROM runs ORDER BY run_id LIMIT 1',
  );

  assert.equal(typeof rows[0]?.['tool_duration_ms'], 'string');
  assert.equal(typeof rows[0]?.['timed_tool_call_count'], 'number');
});

test('DuckDB accepts unsigned Windows native exit codes', async () => {
  const failure = prepared.toolFailures[0];
  assert.ok(failure, 'fixture must contain a tool failure row');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-duckdb-exit-code-'));
  try {
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: {
        ...prepared,
        toolFailures: [{ ...failure, runId: 'windows-native-exit', exitCode: 3_221_225_781 }],
      },
    });
    const rows = await runDuckDbQuery(
      dbPath,
      "SELECT exit_code FROM tool_failures WHERE run_id = 'windows-native-exit'",
    );
    assert.equal(rows[0]?.['exit_code'], '3221225781');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cost columns are surfaced in core_runs, model_quality, and timeline', async () => {
  const coreRunsRows = await sharedDb.queryNamed('core_runs');
  assert.ok(coreRunsRows.length > 0);
  assert.ok(coreRunsRows.every((row) => 'estimated_cost_usd' in row), 'core_runs must expose estimated_cost_usd');
  assert.ok(coreRunsRows.some((row) => row['estimated_cost_usd'] != null), 'at least one priced run');

  const modelQualityRows2 = await sharedDb.queryNamed('model_quality');
  assert.ok(
    modelQualityRows2.every((row) => 'average_estimated_cost_usd' in row && 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'model_quality must expose cost columns',
  );
  assert.ok(modelQualityRows2.some((row) => row['average_estimated_cost_usd'] != null), 'at least one priced model cell');

  const timelineRows2 = await sharedDb.queryNamed('timeline');
  assert.ok(
    timelineRows2.every((row) => 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'timeline must expose cost columns',
  );
});

test('verification_impact buckets per-kind counts instead of the run total', async () => {
  const rows = await sharedDb.queryNamed('verification_impact');
  assert.ok(rows.length > 0, 'verification_impact should return rows');

  // The fixture has at least one run with multiple verification kinds; the
  // SQL should bucket each kind by its own count, not the run's total bucket.
  const testRows = rows.filter((row) => row['verification_kind'] === 'test');
  const otherRows = rows.filter((row) => row['verification_kind'] === 'other');

  assert.ok(
    testRows.some((row) => row['count_bucket'] === '1' || row['count_bucket'] === '2-3' || row['count_bucket'] === '4+'),
    'test kind should carry a non-run-total bucket',
  );
  assert.ok(
    otherRows.some((row) => row['count_bucket'] === '1'),
    'other kind with a single count should be bucketed as 1',
  );
  assert.ok(
    rows.some((row) => row['verification_kind'] === 'none' && row['count_bucket'] === '0'),
    'none kind should map missing usage to bucket 0',
  );
});

test('runs table maps every scalar PreparedRunRow field (no silent drops)', async () => {
  // Structural regression: commits 07613de / 11bd5d1 / 245f351 added fields to
  // PreparedRunRow (prepare.ts) but the duckdb.ts mapper + runsTableSchema() were
  // never updated, so the fields were silently dropped from runs.json and the
  // DuckDB `runs` table. SQL queries and runs.json consumers saw nothing for
  // compaction, auto-retry, subagent cost, or file-churn signals even though the
  // producer captured them. This test enumerates PreparedRunRow fields and
  // asserts each (except an explicit excluded set of nested/complex fields) has
  // a matching runs-table column, so the gap cannot recur for a future field.
  const rows = await sharedDb.query('SELECT * FROM runs LIMIT 1');
  assert.equal(rows.length, 1, 'fixture should produce at least one run row');
  const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const duckColumns = new Set(Object.keys(rows[0]).map(toCamel));

  // PreparedRunRow fields intentionally NOT mapped to the flat runs table:
  // nested objects/arrays whose sub-fields ARE extracted (verification_test_count
  // etc. come from verificationCountsByKind) or that are only consumed by the
  // dashboard path (skillEntries, the fs* functional-settings fields).
  const excluded = new Set([
    'skillEntries',
    'fsSubagentAlwaysParentModel',
    'fsPruningMode',
    'fsPruningEnabled',
    'fsExtensionToggles',
    'fsToolResultPruningEnabled',
    'fsToolResultPruningProfile',
    'verificationCountsByKind',
  ]);

  const sampleRun = prepared.runs[0];
  const missing = Object.keys(sampleRun).filter(
    (field) => !duckColumns.has(field) && !excluded.has(field),
  );
  assert.deepEqual(
    missing,
    [],
    `PreparedRunRow fields missing from the DuckDB runs table — add them to toDuckDbRunRow + runsTableSchema + DuckDbRunRow: ${missing.join(', ')}`,
  );

  // Spot-check the previously-dropped fields are present and correctly valued.
  // run-001 has no subagents but does have an auxiliary pruning call whose
  // provider-qualified model is intentionally unpriced in the fixture, so the
  // complete total must remain unknown rather than silently equal parent-only cost.
  // The fixture includes one measured retry on run-001. This also guards
  // against positional misalignment between the mapper and the schema.
  const priced = await sharedDb.query(
    "SELECT estimated_cost_usd, total_estimated_cost_usd, subagent_estimated_cost_usd, compaction_count, auto_retry_count FROM runs WHERE run_id = 'run-001'",
  );
  if (priced.length > 0) {
    const row = priced[0];
    assert.equal(row['subagent_estimated_cost_usd'], 0, 'fixture runs have no subagent usage → subagent cost is 0');
    assert.equal(row['total_estimated_cost_usd'], null, 'unpriced auxiliary usage must make the complete total unknown');
    assert.equal(row['compaction_count'], 0, 'legacy fixture runs coerce compaction_count to 0');
    assert.equal(row['auto_retry_count'], 1, 'run-001 includes one measured retry');
  }
});

test('turn_throughput table maps every scalar PreparedTurnThroughputRow field (no silent drops)', async () => {
  // Structural regression analogous to the runs-table test: enumerate
  // PreparedTurnThroughputRow fields and assert each has a matching
  // turn_throughput column, so per-turn token/context fields cannot be silently
  // dropped from the DuckDB export. inputTokens/cacheReadTokens/cacheWriteTokens/
  // contextTokens were added to the prepared row but the DuckDB interface/mapper/
  // schema lagged; this test pins them so the gap cannot recur.
  const rows = await sharedDb.query('SELECT * FROM turn_throughput LIMIT 1');
  assert.ok(rows.length >= 1, 'fixture should produce at least one turn_throughput row');
  const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const duckColumns = new Set(Object.keys(rows[0]).map(toCamel));

  const sampleRow = prepared.turnThroughput[0];
  assert.ok(sampleRow, 'fixture should produce prepared turn-throughput rows');
  const missing = Object.keys(sampleRow).filter((field) => !duckColumns.has(field));
  assert.deepEqual(
    missing,
    [],
    `PreparedTurnThroughputRow fields missing from the DuckDB turn_throughput table — add them to toDuckDbTurnThroughputRow + turnThroughputTableSchema + DuckDbTurnThroughputRow: ${missing.join(', ')}`,
  );

  // Spot-check the per-turn token/context columns exist and coerce correctly for
  // fixture samples that predate per-turn token reporting (0 / NULL). BIGINT is
  // JSON-serialized as a string ('0'), so coerce via Number() before the strict
  // equality check (the test module uses node:assert/strict).
  const tokenCols = await sharedDb.query(
    'SELECT input_tokens, cache_read_tokens, cache_write_tokens, context_tokens FROM turn_throughput LIMIT 1',
  );
  assert.ok(tokenCols.length > 0);
  assert.equal(Number(tokenCols[0]['input_tokens']), 0, 'fixture samples lack per-turn input tokens → 0');
  assert.equal(Number(tokenCols[0]['cache_read_tokens']), 0, 'fixture samples lack per-turn cache-read tokens → 0');
  assert.equal(Number(tokenCols[0]['cache_write_tokens']), 0, 'fixture samples lack per-turn cache-write tokens → 0');
  assert.equal(tokenCols[0]['context_tokens'], null, 'fixture samples lack per-turn context tokens → NULL');
});

test('tool_result_issues table maps prepared rows and preserves sample detail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-tool-result-issues-'));
  try {
    const base = prepared.runs.find((run) => run.status !== 'open')!;
    const run: typeof base = {
      ...base,
      runId: 'issue-run',
      taskGroupId: 'issue-task',
    };
    const issues: PreparedToolResultIssueRow[] = [
      {
        runId: 'issue-run',
        toolName: 'bash',
        resultIssueKind: 'verification_failure',
        count: 2,
        exitCode: 1,
        errorExcerpt: 'tests failed',
        verificationKinds: ['test'],
        startedAt: run.startedAt,
        startedDay: run.startedDay,
        modelId: run.modelId,
        thinkingLevel: run.thinkingLevel,
        experimentAssignment: run.experimentAssignment,
        mixedTreatmentConfig: run.mixedTreatmentConfig,
      },
      {
        runId: 'issue-run',
        toolName: 'bash',
        resultIssueKind: 'probe_no_match',
        count: 1,
        exitCode: null,
        errorExcerpt: null,
        verificationKinds: [],
        startedAt: run.startedAt,
        startedDay: run.startedDay,
        modelId: run.modelId,
        thinkingLevel: run.thinkingLevel,
        experimentAssignment: run.experimentAssignment,
        mixedTreatmentConfig: run.mixedTreatmentConfig,
      },
    ];
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: { ...prepared, runs: [run], toolResultIssues: issues },
    });
    const rows = await runDuckDbQuery(
      dbPath,
      "SELECT * FROM tool_result_issues WHERE run_id = 'issue-run' ORDER BY result_issue_kind",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.['result_issue_kind'], 'probe_no_match');
    assert.equal(rows[1]?.['result_issue_kind'], 'verification_failure');
    assert.equal(rows[1]?.['count'], 2);
    assert.equal(rows[1]?.['exit_code'], '1');
    assert.equal(rows[1]?.['error_excerpt'], 'tests failed');
    assert.deepEqual(rows[1]?.['verification_kinds'], ['test']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runs table exposes new captured fields: treatmentChangeKinds, lastTurnUsage, and skill-pruning prepass tokens', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-runs-extra-'));
  try {
    const base = prepared.runs.find((run) => run.status !== 'open')!;
    const run: typeof base = {
      ...base,
      runId: 'extra-run',
      taskGroupId: 'extra-task',
      treatmentChangeKinds: ['model', 'thinking'] as any,
      lastTurnInputTokens: 10,
      lastTurnOutputTokens: 20,
      lastTurnCacheReadTokens: 5,
      lastTurnCacheWriteTokens: 2,
      lastTurnTotalTokens: 37,
      lastTurnReasoningTokens: 15,
      skillPruningPrepassInputTokens: 100,
      skillPruningPrepassOutputTokens: 20,
      skillPruningPrepassCacheReadTokens: 5,
      skillPruningPrepassCacheWriteTokens: 3,
      skillPruningPrepassDurationMs: 450,
      criticalPathDurationMs: 700,
    };
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: { ...prepared, runs: [run] },
    });
    const rows = await runDuckDbQuery(
      dbPath,
      "SELECT treatment_change_kinds, last_turn_reasoning_tokens, skill_pruning_prepass_input_tokens, skill_pruning_prepass_duration_ms, critical_path_duration_ms FROM runs WHERE run_id = 'extra-run'",
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.['treatment_change_kinds'], ['model', 'thinking']);
    assert.equal(rows[0]?.['last_turn_reasoning_tokens'], '15');
    assert.equal(rows[0]?.['skill_pruning_prepass_input_tokens'], '100');
    assert.equal(rows[0]?.['skill_pruning_prepass_duration_ms'], '450');
    assert.equal(rows[0]?.['critical_path_duration_ms'], '700');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('turn_throughput table exposes per-turn provider and tool_usage exposes timed_call_count', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-throughput-provider-'));
  try {
    const base = prepared.runs.find((run) => run.status !== 'open')!;
    const run: typeof base = { ...base, runId: 'throughput-run', taskGroupId: 'throughput-task' };
    const throughput = [
      {
        ...prepared.turnThroughput[0],
        runId: 'throughput-run',
        provider: 'openai',
        providerQueueMs: 125,
        providerQueueAttemptCount: 2,
      },
    ];
    const toolUsage = [
      {
        ...prepared.toolUsage[0],
        runId: 'throughput-run',
        toolName: 'bash',
        timedCallCount: 3,
        totalDurationMs: 3000,
        meanDurationMs: 1000,
      },
    ];
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: { ...prepared, runs: [run], turnThroughput: throughput, toolUsage },
    });
    const tpRows = await runDuckDbQuery(
      dbPath,
      "SELECT provider, provider_queue_ms, provider_queue_attempt_count FROM turn_throughput WHERE run_id = 'throughput-run'",
    );
    assert.equal(tpRows[0]?.['provider'], 'openai');
    assert.equal(tpRows[0]?.['provider_queue_ms'], '125');
    assert.equal(tpRows[0]?.['provider_queue_attempt_count'], 2);
    const toolRows = await runDuckDbQuery(
      dbPath,
      "SELECT timed_call_count, mean_duration_ms FROM tool_usage WHERE run_id = 'throughput-run' AND tool_name = 'bash'",
    );
    assert.equal(toolRows[0]?.['timed_call_count'], 3);
    assert.equal(toolRows[0]?.['mean_duration_ms'], 1000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('retry_timing table and named query expose scheduled and measured timing', async () => {
  const rows = await sharedDb.queryNamed('retry_timing');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['source_id'], 'run-001-retry-1');
  assert.equal(rows[0]?.['scheduled_delay_ms'], '1000');
  assert.equal(rows[0]?.['measured_delay_ms'], '1080');
  assert.equal(rows[0]?.['duration_ms'], '4200');
});

test('latency_friction query preserves measured coverage and tool overlap', async () => {
  const rows = await sharedDb.queryNamed('latency_friction');
  const run = rows.find((row) => row['run_id'] === 'run-001');
  assert.equal(run?.['skill_pruning_prepass_duration_ms'], '350');
  assert.equal(run?.['median_provider_queue_ms'], 60);
  assert.equal(run?.['provider_queue_attempt_count'], '2');
  assert.equal(run?.['median_scheduled_retry_delay_ms'], 1000);
  assert.equal(run?.['overlapping_tool_duration_ms'], '2300');
});

test('core_runs exposes model attribution, mixed config, and parent/subagent/total cost', async () => {
  const rows = await sharedDb.queryNamed('core_runs');
  assert.ok(rows.length > 0, 'core_runs should return rows');
  for (const row of rows) {
    assert.ok('model_family' in row, 'core_runs must expose model_family');
    assert.ok('mixed_model_config' in row, 'core_runs must expose mixed_model_config');
    assert.ok('estimated_cost_usd' in row, 'core_runs must expose parent cost (estimated_cost_usd)');
    assert.ok('subagent_estimated_cost_usd' in row, 'core_runs must expose subagent_estimated_cost_usd');
    assert.ok('total_estimated_cost_usd' in row, 'core_runs must expose total_estimated_cost_usd');
  }
  // Fixture runs have no subagent usage. Complete totals may still be null when
  // a tracked auxiliary call has no provider-qualified pricing.
  const priced = rows.filter((row) => row['estimated_cost_usd'] != null);
  assert.ok(priced.length > 0, 'at least one priced run');
  for (const row of priced) {
    assert.equal(row['subagent_estimated_cost_usd'], 0, 'fixture runs have no subagent usage → subagent cost is 0');
    if (row['total_estimated_cost_usd'] !== null) {
      assert.ok(Number(row['total_estimated_cost_usd']) >= Number(row['estimated_cost_usd']));
    }
  }
});
