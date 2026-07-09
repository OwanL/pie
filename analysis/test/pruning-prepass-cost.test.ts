/**
 * Verifies the new prepass-cost data points flow end-to-end through the
 * analytics ETL: pruning.jsonl decision (with prepass usage / input estimate /
 * code version) → prepare → DuckDB `pruning_events` → the
 * `pruning_prepass_cost` named query, grouped by code_version cohort so
 * old-code (NULL) vs new-code (SHA) runs can be split.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';

import { buildDuckDbDatabase, runNamedDuckDbQuery } from '../scripts/duckdb.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import type { PruningSourceDecision, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { deepClone, loadFixture } from './helpers.ts';

function makeDecision(opts: Partial<PruningSourceDecision> & { timestamp: string; sessionPath: string }): PruningSourceDecision {
  return {
    sessionId: opts.sessionPath,
    mode: 'auto',
    query: 'test query',
    llmModel: 'gpt-5-mini',
    llmThinkingLevel: 'minimal',
    llmLatencyMs: 5000,
    included: ['kept-skill'],
    excluded: ['pruned-skill'],
    skillBlockTokens: 300,
    originalBlockTokens: 1000,
    toolIncluded: ['read'],
    toolExcluded: ['web_search'],
    toolBlockTokens: 600,
    originalToolBlockTokens: 1500,
    ...opts,
  };
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-pruning-cost-'));
const dbPath = path.join(tempDir, 'usage.duckdb');
const exportsDir = path.join(tempDir, 'exports');

const fixture: SourceAnalyticsPayload = deepClone(await loadFixture());
// Two cohorts: old-code (no code_version / estimate — predates the field) and
// new-code (git SHA + locally-estimated input size + provider-reported usage).
fixture.pruningDecisions = [
  makeDecision({ timestamp: '2026-07-09T05:00:00.000Z', sessionPath: 'SENTINEL_SESSION_PATH_ALPHA', llmLatencyMs: 8000 }),
  makeDecision({ timestamp: '2026-07-09T05:30:00.000Z', sessionPath: 'SENTINEL_SESSION_PATH_ALPHA', llmLatencyMs: 9000, codeVersion: 'abc1234', prepassInputEstimateTokens: 950, prepassInputTokens: 980, prepassOutputTokens: 60 }),
  makeDecision({ timestamp: '2026-07-09T06:00:00.000Z', sessionPath: 'SENTINEL_SESSION_PATH_ALPHA', llmLatencyMs: 6000, codeVersion: 'abc1234', prepassInputEstimateTokens: 950, prepassInputTokens: 970, prepassOutputTokens: 55 }),
];

await buildDuckDbDatabase({ dbPath, exportsDir, prepared: prepareSourceAnalytics(fixture) });

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('pruning_prepass_cost: groups by code_version cohort and surfaces the new cost columns', async () => {
  const rows = await runNamedDuckDbQuery(dbPath, 'pruning_prepass_cost');
  // Two cohorts: old-code (NULL code_version) + new-code ("abc1234").
  assert.equal(rows.length, 2, `expected 2 cohorts, got ${rows.length}: ${JSON.stringify(rows)}`);

  const newCohort = rows.find((r) => r['code_version'] === 'abc1234');
  const oldCohort = rows.find((r) => r['code_version'] == null); // null or undefined
  assert.ok(newCohort, 'new-code cohort (git SHA) present');
  assert.ok(oldCohort, 'old-code cohort (NULL code_version, predates the field) present');

  // DuckDB returns COUNT(*) (BIGINT) as a string; coerce numerics. NULL aggregates
  // come back as JS null/undefined, so use a loose null check.
  assert.equal(Number(newCohort!['prepass_count']), 2);
  assert.equal(Number(oldCohort!['prepass_count']), 1);

  // Locally-estimated prepass input size flows through (always present for new code).
  assert.equal(Number(newCohort!['avg_input_estimate_tokens']), 950);
  // Provider-reported usage flows through too (avg of 980 & 970).
  assert.equal(Number(newCohort!['avg_input_tokens_reported']), 975);

  // Old cohort has no estimate (AVG over NULL → NULL).
  assert.ok(oldCohort!['avg_input_estimate_tokens'] == null, 'old cohort estimate is null');
});
