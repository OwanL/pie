import assert from 'node:assert/strict';
import test from 'node:test';

import type { PreparedRunRow } from '../scripts/contracts.ts';
import { costTrendByProviderRows, groupCostByModel, groupCostPerSessionByModel } from '../site/charts/cost.ts';

/**
 * Minimal run factory: the other PreparedRunRow fields are irrelevant to this
 * transform unit and are omitted via an `unknown` cast.
 */
function mkRun(
  model: string,
  session: string,
  cost: number | null,
  status = 'completed',
  family: string | null = model,
  totalCost: number | null = cost,
): PreparedRunRow {
  return {
    status,
    modelId: model,
    modelFamily: family,
    sessionPathHash: session,
    estimatedCostUsd: cost,
    totalEstimatedCostUsd: totalCost,
  } as unknown as PreparedRunRow;
}

/** Like {@link mkRun} but also sets the fields `costTrendByProviderRows` reads (`startedDay`, `provider`). */
function mkProviderRun(day: string, provider: string | null, cost: number | null, status = 'completed'): PreparedRunRow {
  return { status, startedDay: day, provider, estimatedCostUsd: cost, totalEstimatedCostUsd: cost, sessionPathHash: 's', modelId: 'm', modelFamily: 'm' } as unknown as PreparedRunRow;
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

test('groupCostByModel omits models with no priced rows but keeps reported free runs at $0', () => {
  assert.deepEqual(groupCostByModel([
    mkRun('unpriced', 's1', null),
    mkRun('unpriced', 's2', null),
  ]), []);

  const rows = groupCostByModel([
    mkRun('free', 's1', 99, 'completed', 'free', 0),
  ]);
  assert.equal(rows.length, 1);
  const free = rows[0]!;
  assert.equal(free.totalCostUsd, 0);
  assert.equal(free.avgCostUsdPerSession, 0);
  assert.equal(free.sessionCount, 1);
  assert.equal(free.withCostCount, 1);
  assert.equal(free.runCount, 1);
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

test('groupCostByModel sorts by total spend descending and caps at 12 model families', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 13; i += 1) {
    // Higher index → higher cost, so family 12 should top the list.
    runs.push(mkRun(`provider-model-${i}`, `s-${i}`, i + 1, 'completed', `family-${i}`));
  }
  const rows = groupCostByModel(runs);
  assert.equal(rows.length, 12, 'should cap at 12 model families');
  assert.equal(rows[0]!.model, 'family-12', 'highest-spend family first');
});

test('cost grouping collapses provider ids by family and requires complete totals', () => {
  const rows = groupCostByModel([
    mkRun('provider-a-model', 's-1', 0.10, 'completed', 'shared-family', 0.30),
    mkRun('provider-b-model', 's-2', 0.20, 'completed', 'shared-family'),
    mkRun('provider-c-model', 's-3', 50, 'completed', 'shared-family', null),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, 'shared-family');
  approx(rows[0]!.totalCostUsd, 0.50);
  approx(rows[0]!.avgCostUsdPerSession, 0.25);
  assert.equal(rows[0]!.withCostCount, 2, 'unknown total must not expose partial parent cost');
  assert.equal(rows[0]!.runCount, 3);
});

test('per-session cost is independently top-12 instead of inheriting total-spend selection', () => {
  const runs: PreparedRunRow[] = [];
  for (let i = 0; i < 12; i += 1) {
    // $60 total but only $30/session: these occupy the total-spend top 12.
    runs.push(mkRun(`bulk-${i}`, `bulk-${i}-a`, 30));
    runs.push(mkRun(`bulk-${i}`, `bulk-${i}-b`, 30));
  }
  // $50 total ranks 13th on spend, but $50/session is the highest per-session value.
  runs.push(mkRun('rare-expensive', 'rare-session', 50));

  assert.ok(!groupCostByModel(runs).some((row) => row.model === 'rare-expensive'));
  const perSession = groupCostPerSessionByModel(runs);
  assert.equal(perSession.length, 12);
  assert.equal(perSession[0]!.model, 'rare-expensive');
  assert.equal(perSession[0]!.avgCostUsdPerSession, 50);
});

test('costTrendByProviderRows groups daily cost by provider and sums across runs', () => {
  const rows = costTrendByProviderRows([
    mkProviderRun('2026-01-01', 'anthropic', 0.10),
    mkProviderRun('2026-01-01', 'anthropic', 0.20),
    mkProviderRun('2026-01-01', 'openai', 0.05),
    mkProviderRun('2026-01-02', 'anthropic', 0.40),
  ]);
  // 4 rows: 2 providers × 2 days; openai is imputed as $0 on day 2.
  assert.equal(rows.length, 4);
  const d1Anthropic = rows.find((r) => r.day === '2026-01-01' && r.provider === 'anthropic')!;
  const d1Openai = rows.find((r) => r.day === '2026-01-01' && r.provider === 'openai')!;
  const d2Anthropic = rows.find((r) => r.day === '2026-01-02' && r.provider === 'anthropic')!;
  const d2Openai = rows.find((r) => r.day === '2026-01-02' && r.provider === 'openai')!;
  assert.equal(d1Anthropic.day, '2026-01-01');
  assert.equal(d1Anthropic.provider, 'anthropic');
  approx(d1Anthropic.totalCostUsd, 0.30); // 0.10 + 0.20
  assert.equal(d1Anthropic.runCount, 2);
  approx(d1Openai.totalCostUsd, 0.05);
  assert.equal(d2Anthropic.day, '2026-01-02');
  approx(d2Anthropic.totalCostUsd, 0.40);
  approx(d2Openai.totalCostUsd, 0);
  assert.equal(d2Openai.runCount, 0);
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

test('costTrendByProviderRows imputes $0 for missing (day, provider) combinations', () => {
  const rows = costTrendByProviderRows([
    mkProviderRun('2026-01-01', 'anthropic', 0.10),
    mkProviderRun('2026-01-01', 'openai', 0.05),
    mkProviderRun('2026-01-02', 'anthropic', 0.40),
  ]);
  // 2 days × 2 providers = 4 rows; openai has no runs on day 2 but still gets a $0 point.
  assert.equal(rows.length, 4);
  const openaiDay2 = rows.find((r) => r.day === '2026-01-02' && r.provider === 'openai')!;
  assert.ok(openaiDay2, 'openai gets a day-2 row even though it had no runs that day');
  approx(openaiDay2.totalCostUsd, 0);
  assert.equal(openaiDay2.runCount, 0);
  const anthropicDay1 = rows.find((r) => r.day === '2026-01-01' && r.provider === 'anthropic')!;
  approx(anthropicDay1.totalCostUsd, 0.10);
});

test('costTrendByProviderRows returns an empty array when no runs have cost data', () => {
  assert.deepEqual(
    costTrendByProviderRows([mkProviderRun('2026-01-01', 'anthropic', null)]),
    [],
  );
});
