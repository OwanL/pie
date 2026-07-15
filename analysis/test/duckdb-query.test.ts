import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';

import { buildDuckDbDatabase, runNamedDuckDbQuery, runDuckDbQuery } from '../scripts/duckdb.ts';
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

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('DuckDB build and named queries work against the fixture', async () => {
  const modelQualityRows = await runNamedDuckDbQuery(sharedDbPath, 'model_quality');
  const toolUsageRows = await runNamedDuckDbQuery(sharedDbPath, 'tool_usage');
  const toolFailureRows = await runNamedDuckDbQuery(sharedDbPath, 'tool_failures');
  const timelineRows = await runNamedDuckDbQuery(sharedDbPath, 'timeline');

  assert.ok(modelQualityRows.length >= 3);
  assert.ok(toolUsageRows.some((row) => row['tool_name'] === 'bash'));
  assert.ok(Array.isArray(toolFailureRows));
  assert.ok(timelineRows.some((row) => row['bucket_start'] === '2026-05-10'));
});

test('model quality and leaderboard SQL use user-primary outcome attribution', async () => {
  const rows = await runNamedDuckDbQuery(sharedDbPath, 'model_quality');
  assert.ok(rows.every((row) => (
    'agent_outcome_count' in row
      && 'mixed_model_excluded_outcome_count' in row
      && 'mixed_treatment_excluded_outcome_count' in row
  )));

  const completed = prepared.runs.filter((run) => run.status !== 'open');
  const expectedMixed = completed.filter((run) => (
    run.scored && run.satisfaction !== null && run.mixedModelConfig
  )).length;
  const expectedStableUser = completed.filter((run) => (
    run.scored && run.satisfaction !== null && !run.mixedModelConfig && !run.mixedTreatmentConfig && run.outcomeSource === 'user'
  )).length;
  const expectedStableAgent = completed.filter((run) => (
    run.scored && run.satisfaction !== null && !run.mixedModelConfig && !run.mixedTreatmentConfig && run.outcomeSource === 'agent'
  )).length;
  const expectedMixedTreatment = completed.filter((run) => (
    run.scored && run.satisfaction !== null && !run.mixedModelConfig && run.mixedTreatmentConfig
  )).length;
  const sum = (field: string): number => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);

  assert.equal(sum('scored_run_count'), expectedStableUser);
  assert.equal(sum('agent_outcome_count'), expectedStableAgent);
  assert.equal(sum('mixed_model_excluded_outcome_count'), expectedMixed);
  assert.equal(sum('mixed_treatment_excluded_outcome_count'), expectedMixedTreatment);

  const leaderboardSql = await fs.readFile(new URL('../queries/model_leaderboard.sql', import.meta.url), 'utf8');
  const leaderboardRows = await runDuckDbQuery(sharedDbPath, leaderboardSql);
  const leaderboardSum = (field: string): number => leaderboardRows.reduce(
    (total, row) => total + Number(row[field] ?? 0),
    0,
  );
  assert.equal(leaderboardSum('scored_run_count'), expectedStableUser);
  assert.equal(leaderboardSum('user_outcome_count'), expectedStableUser);
  assert.equal(leaderboardSum('agent_outcome_count'), expectedStableAgent);
  assert.equal(leaderboardSum('mixed_model_excluded_count'), expectedMixed);
  assert.equal(leaderboardSum('mixed_treatment_excluded_count'), expectedMixedTreatment);
});

test('model leaderboard SQL uses one latest scored run per task group', async () => {
  const base = prepared.runs.find((run) => (
    run.status !== 'open'
    && run.scored
    && run.satisfaction !== null
    && !run.mixedModelConfig
    && !run.mixedTreatmentConfig
    && run.outcomeSource === 'user'
  ));
  assert.ok(base, 'fixture must contain an attributable user-scored run');
  const first = {
    ...base,
    runId: 'terminal-a-first',
    taskGroupId: 'terminal-task',
    startedAt: '2026-05-10T01:00:00.000Z',
    satisfaction: 5,
    resolution: 'resolved' as const,
  };
  const later = {
    ...base,
    runId: 'terminal-a-later',
    taskGroupId: 'terminal-task',
    startedAt: '2026-05-10T02:00:00.000Z',
    satisfaction: 1,
    resolution: 'unresolved' as const,
  };
  const tiedByRunId = {
    ...later,
    runId: 'terminal-z-later',
    satisfaction: 2,
    resolution: 'partially_resolved' as const,
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
    assert.equal(Number(rows[0]?.['scored_run_count']), 3, 'all retries remain provenance');
    assert.equal(Number(rows[0]?.['effective_task_count']), 1, 'the task has one outcome vote');
    assert.equal(Number(rows[0]?.['attributable_task_count']), 1);
    assert.equal(Number(rows[0]?.['scoring_coverage']), 1);
    assert.equal(Number(rows[0]?.['avg_satisfaction']), 2, 'latest timestamp then greatest runId selects the terminal vote');
    assert.equal(Number(rows[0]?.['resolution_rate']), 0.5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DuckDB runs expose aggregate tool timing coverage', async () => {
  const rows = await runDuckDbQuery(
    sharedDbPath,
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
  const coreRunsRows = await runNamedDuckDbQuery(sharedDbPath, 'core_runs');
  assert.ok(coreRunsRows.length > 0);
  assert.ok(coreRunsRows.every((row) => 'estimated_cost_usd' in row), 'core_runs must expose estimated_cost_usd');
  assert.ok(coreRunsRows.some((row) => row['estimated_cost_usd'] != null), 'at least one priced run');

  const modelQualityRows2 = await runNamedDuckDbQuery(sharedDbPath, 'model_quality');
  assert.ok(
    modelQualityRows2.every((row) => 'average_estimated_cost_usd' in row && 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'model_quality must expose cost columns',
  );
  assert.ok(modelQualityRows2.some((row) => row['average_estimated_cost_usd'] != null), 'at least one priced model cell');

  const timelineRows2 = await runNamedDuckDbQuery(sharedDbPath, 'timeline');
  assert.ok(
    timelineRows2.every((row) => 'total_estimated_cost_usd' in row && 'priced_run_count' in row),
    'timeline must expose cost columns',
  );
});

test('verification_impact buckets per-kind counts instead of the run total', async () => {
  const rows = await runNamedDuckDbQuery(sharedDbPath, 'verification_impact');
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
  const rows = await runDuckDbQuery(sharedDbPath, 'SELECT * FROM runs LIMIT 1');
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
  // total cost = parent + subagent; fixture runs have no subagent usage, so
  // total == parent and the friction counters coerce to 0. This also guards
  // against positional misalignment between the mapper and the schema.
  const priced = await runDuckDbQuery(
    sharedDbPath,
    'SELECT estimated_cost_usd, total_estimated_cost_usd, subagent_estimated_cost_usd, compaction_count, auto_retry_count FROM runs WHERE estimated_cost_usd IS NOT NULL LIMIT 1',
  );
  if (priced.length > 0) {
    const row = priced[0];
    assert.equal(row['subagent_estimated_cost_usd'], 0, 'fixture runs have no subagent usage → subagent cost is 0');
    assert.equal(row['total_estimated_cost_usd'], row['estimated_cost_usd'], 'total cost = parent + subagent (0)');
    assert.equal(row['compaction_count'], 0, 'legacy fixture runs coerce compaction_count to 0');
    assert.equal(row['auto_retry_count'], 0, 'legacy fixture runs coerce auto_retry_count to 0');
  }
});

test('turn_throughput table maps every scalar PreparedTurnThroughputRow field (no silent drops)', async () => {
  // Structural regression analogous to the runs-table test: enumerate
  // PreparedTurnThroughputRow fields and assert each has a matching
  // turn_throughput column, so per-turn token/context fields cannot be silently
  // dropped from the DuckDB export. inputTokens/cacheReadTokens/cacheWriteTokens/
  // contextTokens were added to the prepared row but the DuckDB interface/mapper/
  // schema lagged; this test pins them so the gap cannot recur.
  const rows = await runDuckDbQuery(sharedDbPath, 'SELECT * FROM turn_throughput LIMIT 1');
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
  const tokenCols = await runDuckDbQuery(
    sharedDbPath,
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
        scored: run.scored,
        satisfaction: run.satisfaction,
        resolution: run.resolution,
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
        scored: run.scored,
        satisfaction: run.satisfaction,
        resolution: run.resolution,
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
    };
    const dbPath = path.join(dir, 'usage.duckdb');
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: path.join(dir, 'exports'),
      prepared: { ...prepared, runs: [run] },
    });
    const rows = await runDuckDbQuery(
      dbPath,
      "SELECT treatment_change_kinds, last_turn_reasoning_tokens, skill_pruning_prepass_input_tokens FROM runs WHERE run_id = 'extra-run'",
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.['treatment_change_kinds'], ['model', 'thinking']);
    assert.equal(rows[0]?.['last_turn_reasoning_tokens'], '15');
    assert.equal(rows[0]?.['skill_pruning_prepass_input_tokens'], '100');
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
      "SELECT provider FROM turn_throughput WHERE run_id = 'throughput-run'",
    );
    assert.equal(tpRows[0]?.['provider'], 'openai');
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

test('core_runs exposes model attribution, outcome source, mixed config, and parent/subagent/total cost', async () => {
  const rows = await runNamedDuckDbQuery(sharedDbPath, 'core_runs');
  assert.ok(rows.length > 0, 'core_runs should return rows');
  for (const row of rows) {
    assert.ok('model_family' in row, 'core_runs must expose model_family');
    assert.ok('outcome_source' in row, 'core_runs must expose outcome_source');
    assert.ok('mixed_model_config' in row, 'core_runs must expose mixed_model_config');
    assert.ok('estimated_cost_usd' in row, 'core_runs must expose parent cost (estimated_cost_usd)');
    assert.ok('subagent_estimated_cost_usd' in row, 'core_runs must expose subagent_estimated_cost_usd');
    assert.ok('total_estimated_cost_usd' in row, 'core_runs must expose total_estimated_cost_usd');
  }
  // Headline total = parent + subagent; fixture runs have no subagent usage, so
  // total == parent and subagent == 0 on priced rows.
  const priced = rows.filter((row) => row['estimated_cost_usd'] != null);
  assert.ok(priced.length > 0, 'at least one priced run');
  for (const row of priced) {
    assert.equal(row['subagent_estimated_cost_usd'], 0, 'fixture runs have no subagent usage → subagent cost is 0');
    assert.equal(row['total_estimated_cost_usd'], row['estimated_cost_usd'], 'total cost = parent + subagent (0)');
  }
});
