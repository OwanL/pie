import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedRunRow } from '../scripts/contracts.ts';
import { costTrendByProviderRows, groupCostByModel } from '../site/charts/cost.ts';

/**
 * Minimal run factory: `groupCostByModel` only reads `status`, `modelId`,
 * `sessionPathHash`, and `estimatedCostUsd`, so the other PreparedRunRow fields
 * are irrelevant to this unit and are omitted via an `unknown` cast.
 */
function mkRun(model: string, session: string, cost: number | null, status = 'completed'): PreparedRunRow {
  return { status, modelId: model, sessionPathHash: session, estimatedCostUsd: cost } as unknown as PreparedRunRow;
}

/** Like {@link mkRun} but also sets the fields `costTrendByProviderRows` reads (`startedDay`, `provider`). */
function mkProviderRun(day: string, provider: string | null, cost: number | null, status = 'completed'): PreparedRunRow {
  return { status, startedDay: day, provider, estimatedCostUsd: cost, sessionPathHash: 's', modelId: 'm' } as unknown as PreparedRunRow;
}

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}

test('groupCostByModel rolls runs up by session before averaging (per-session ≠ per-run)', () => {
  // Model "alpha": session s1 has 2 runs (0.10 + 0.20 = 0.30), session s2 has 1 run (0.05).
  // Per-session subtotals = [0.30, 0.05]; per-run costs = [0.10, 0.20, 0.05].
  const rows = groupCostByModel([
    mkRun('alpha', 's1', 0.10),
    mkRun('alpha', 's1', 0.20),
    mkRun('alpha', 's2', 0.05),
  ]);
  assert.equal(rows.length, 1);
  const alpha = rows[0]!;
  approx(alpha.totalCostUsd, 0.35);
  approx(alpha.avgCostUsdPerSession, 0.175); // (0.30 + 0.05) / 2
  approx(alpha.medianCostUsdPerSession, 0.175); // midpoint of [0.05, 0.30]
  approx(alpha.medianCostUsdPerRun, 0.10); // midpoint of [0.05, 0.10, 0.20]
  assert.equal(alpha.sessionCount, 2);
  assert.equal(alpha.withCostCount, 3);
  assert.equal(alpha.runCount, 3);

  // The whole point: averaging per run instead would give 0.35 / 3 ≈ 0.1167,
  // not 0.175 — confirming the per-session rollup is what's being computed.
  assert.notEqual(alpha.avgCostUsdPerSession, 0.1167);
});

test('groupCostByModel treats each single-run session as its own unit', () => {
  // Three sessions, one run each — here per-session == per-run.
  const rows = groupCostByModel([
    mkRun('beta', 's1', 0.10),
    mkRun('beta', 's2', 0.20),
    mkRun('beta', 's3', 0.05),
  ]);
  const beta = rows[0]!;
  approx(beta.totalCostUsd, 0.35);
  approx(beta.avgCostUsdPerSession, 0.1167); // 0.35 / 3, rounded to 4 dp
  approx(beta.medianCostUsdPerSession, 0.10);
  assert.equal(beta.sessionCount, 3);
});

test('groupCostByModel reports zero cost and zero sessions for models with no pricing', () => {
  const rows = groupCostByModel([
    mkRun('gamma', 's1', null),
    mkRun('gamma', 's2', null),
  ]);
  const gamma = rows[0]!;
  assert.equal(gamma.totalCostUsd, 0);
  assert.equal(gamma.avgCostUsdPerSession, 0);
  assert.equal(gamma.sessionCount, 0);
  assert.equal(gamma.withCostCount, 0);
  assert.equal(gamma.runCount, 2);
});

test('groupCostByModel excludes open runs', () => {
  const rows = groupCostByModel([
    mkRun('alpha', 's1', 0.10, 'completed'),
    mkRun('alpha', 's2', 0.20, 'open'), // ignored
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runCount, 1);
  assert.equal(rows[0]!.sessionCount, 1);
  approx(rows[0]!.totalCostUsd, 0.10);
});

test('groupCostByModel sorts by total spend descending and caps at 12 models', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 13; i += 1) {
    // Higher index → higher cost, so model 12 should top the list.
    runs.push(mkRun(`model-${i}`, `s-${i}`, i + 1));
  }
  const rows = groupCostByModel(runs);
  assert.equal(rows.length, 12, 'should cap at 12 models');
  assert.equal(rows[0]!.model, 'model-12', 'highest-spend model first');
});

test('costTrendByProviderRows groups daily cost by provider and sums across runs', () => {
  const rows = costTrendByProviderRows([
    mkProviderRun('2026-01-01', 'anthropic', 0.10),
    mkProviderRun('2026-01-01', 'anthropic', 0.20),
    mkProviderRun('2026-01-01', 'openai', 0.05),
    mkProviderRun('2026-01-02', 'anthropic', 0.40),
  ]);
  // 3 (day, provider) cells, sorted by day then provider.
  assert.equal(rows.length, 3);
  const [d1Anthropic, d1Openai, d2Anthropic] = rows;
  assert.equal(d1Anthropic!.day, '2026-01-01');
  assert.equal(d1Anthropic!.provider, 'anthropic');
  approx(d1Anthropic!.totalCostUsd, 0.30); // 0.10 + 0.20
  assert.equal(d1Anthropic!.runCount, 2);
  assert.equal(d1Openai!.provider, 'openai');
  approx(d1Openai!.totalCostUsd, 0.05);
  assert.equal(d2Anthropic!.day, '2026-01-02');
  approx(d2Anthropic!.totalCostUsd, 0.40);
});

test('costTrendByProviderRows excludes open runs, unpriced runs, and attributes null provider to (unknown)', () => {
  const rows = costTrendByProviderRows([
    mkProviderRun('2026-01-01', 'anthropic', 0.10, 'completed'),
    mkProviderRun('2026-01-01', 'anthropic', 0.99, 'open'), // open → ignored
    mkProviderRun('2026-01-01', null, 0.15), // null provider → (unknown)
    mkProviderRun('2026-01-01', 'openai', null), // unpriced → ignored
  ]);
  assert.equal(rows.length, 2);
  const anthropic = rows.find((r) => r.provider === 'anthropic')!;
  approx(anthropic.totalCostUsd, 0.10);
  const unknown = rows.find((r) => r.provider === '(unknown)')!;
  approx(unknown.totalCostUsd, 0.15);
});

test('costTrendByProviderRows folds the long tail beyond the top N into a single Other series', () => {
  // 9 distinct providers with strictly increasing spend; the 9th is the tail.
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 9; i += 1) {
    runs.push(mkProviderRun('2026-01-01', `p-${i}`, i + 1));
  }
  const rows = costTrendByProviderRows(runs);
  const providers = new Set(rows.map((r) => r.provider));
  assert.equal(providers.size, 9, 'top 8 + Other');
  assert.ok(providers.has('Other'), 'tail folded into Other');
  // The cheapest provider (p-0, spend 1) is the tail, NOT p-8 (spend 9).
  assert.ok(!providers.has('p-0'), 'lowest-spend provider rolled into Other');
  assert.ok(providers.has('p-8'), 'highest-spend provider kept');
  const other = rows.find((r) => r.provider === 'Other')!;
  approx(other.totalCostUsd, 1); // p-0's spend
});

test('costTrendByProviderRows returns an empty array when no runs have cost data', () => {
  assert.deepEqual(
    costTrendByProviderRows([mkProviderRun('2026-01-01', 'anthropic', null)]),
    [],
  );
});
