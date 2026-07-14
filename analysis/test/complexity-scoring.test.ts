import assert from 'node:assert/strict';
import test from 'node:test';

import { complexityWeightedMean, hasComplexityVariance, percentileRanks } from '../scripts/complexity-scoring.ts';

test('percentileRanks preserves input order and gives ties their shared mid-rank', () => {
  assert.deepEqual(percentileRanks([3, 1, 1, 2, 3]), [0.8, 0.2, 0.2, 0.5, 0.8]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approx(actual: number | null, expected: number | null, epsilon = 1e-9): void {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.ok(actual !== null && Math.abs(actual - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}

type Pair = { complexity: number; outcome: number };

// ---------------------------------------------------------------------------
// complexityWeightedMean (the difficulty-emphasis mastery estimate)
// ---------------------------------------------------------------------------

test('complexityWeightedMean: empty pairs return null', () => {
  assert.equal(complexityWeightedMean([]), null);
});

test('complexityWeightedMean: single pair returns complexity × outcome', () => {
  approx(complexityWeightedMean([{ complexity: 0.8, outcome: 1 }]), 0.8);
  approx(complexityWeightedMean([{ complexity: 0.2, outcome: 0.5 }]), 0.1);
});

test('complexityWeightedMean: is the mean of complexity × outcome', () => {
  // (0.8×1 + 0.2×0.5) / 2 = (0.8 + 0.1) / 2 = 0.45
  approx(complexityWeightedMean([{ complexity: 0.8, outcome: 1 }, { complexity: 0.2, outcome: 0.5 }]), 0.45);
});

test('complexityWeightedMean: a model that only aces EASY tasks scores below one that aces HARD tasks', () => {
  // The core difficulty-emphasis property: perfect outcomes on low-complexity runs cannot match
  // perfect outcomes on high-complexity runs, even though both have a 100% raw success rate.
  const easyPerfect: Pair[] = Array.from({ length: 6 }, () => ({ complexity: 0.2, outcome: 1 }));
  const hardPerfect: Pair[] = Array.from({ length: 6 }, () => ({ complexity: 0.8, outcome: 1 }));
  assert.ok(complexityWeightedMean(hardPerfect)! > complexityWeightedMean(easyPerfect)!,
    'completing hard tasks must outrank completing easy tasks at equal success');
  approx(complexityWeightedMean(easyPerfect), 0.2);
  approx(complexityWeightedMean(hardPerfect), 0.8);
});

test('complexityWeightedMean: failing hard tasks scores below succeeding easy tasks on the same volume', () => {
  // A model that fails high-complexity runs (outcome 0) contributes nothing; a model that succeeds
  // on easy runs still earns (low) mastery. This keeps failed hard work from masquerading as strength.
  const hardFail: Pair[] = Array.from({ length: 6 }, () => ({ complexity: 0.8, outcome: 0 }));
  const easySuccess: Pair[] = Array.from({ length: 6 }, () => ({ complexity: 0.2, outcome: 1 }));
  assert.ok(complexityWeightedMean(easySuccess)! > complexityWeightedMean(hardFail)!,
    'succeeding on easy tasks must outrank failing on hard tasks');
  approx(complexityWeightedMean(hardFail), 0);
  approx(complexityWeightedMean(easySuccess), 0.2);
});

test('complexityWeightedMean: is bounded in [0, 1] for complexity, outcome in [0, 1]', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({ complexity: i / 10, outcome: i / 10 }));
  const m = complexityWeightedMean(pairs)!;
  assert.ok(m >= 0 && m <= 1, `mastery ${m} should be in [0,1]`);
});

test('complexityWeightedMean: outcome exponent > 1 penalizes partial outcomes so success dominates', () => {
  // Two runs at the same (high) complexity: one perfect (outcome 1), one partial (outcome 0.5).
  // With exponent 1 they contribute 0.8 and 0.4 (gap 0.4); with exponent 2 the partial run
  // contributes 0.8 × 0.25 = 0.2 (gap 0.6) — the partial outcome is penalized harder, so a model
  // must actually succeed to score well rather than merely attempting hard tasks.
  const perfect: Pair[] = [{ complexity: 0.8, outcome: 1 }];
  const partial: Pair[] = [{ complexity: 0.8, outcome: 0.5 }];
  approx(complexityWeightedMean(perfect, 1), 0.8);
  approx(complexityWeightedMean(partial, 1), 0.4);
  approx(complexityWeightedMean(perfect, 2), 0.8); // 1^2 = 1, unchanged
  approx(complexityWeightedMean(partial, 2), 0.2); // 0.5^2 = 0.25 → 0.8 × 0.25 = 0.2
  // A perfect-easy run (low complexity) must NOT beat a partial-hard run under exponent 2
  // unless the partial outcome is very low: success still matters, weighted by complexity.
  const easyPerfect: Pair[] = [{ complexity: 0.2, outcome: 1 }];
  assert.ok(complexityWeightedMean(perfect, 2)! > complexityWeightedMean(easyPerfect, 2)!,
    'completing a hard task perfectly must outrank completing an easy task perfectly');
});

test('complexityWeightedMean: exponent is a no-op on 0/1 outcomes (tool reliability, verification pass)', () => {
  // Binary outcomes are unaffected by the exponent (0^p = 0, 1^p = 1), so the exponent targets
  // continuous / partial outcomes (satisfaction, partial resolution) without distorting binary dims.
  const pairs: Pair[] = [{ complexity: 0.8, outcome: 1 }, { complexity: 0.8, outcome: 0 }];
  approx(complexityWeightedMean(pairs, 1), 0.4);
  approx(complexityWeightedMean(pairs, 2), 0.4);
  approx(complexityWeightedMean(pairs, 4), 0.4);
});

// ---------------------------------------------------------------------------
// hasComplexityVariance (difficultyEmphasized gate)
// ---------------------------------------------------------------------------

test('hasComplexityVariance: empty scores return false', () => {
  assert.equal(hasComplexityVariance([]), false);
});

test('hasComplexityVariance: single score returns false', () => {
  assert.equal(hasComplexityVariance([0.5]), false);
});

test('hasComplexityVariance: all identical scores return false', () => {
  // Identical-task fixtures (every run clones the same base) ⇒ zero variance ⇒ no genuine
  // difficulty emphasis (mastery collapses to a uniform rescaling of raw outcomes).
  assert.equal(hasComplexityVariance([0.5, 0.5, 0.5, 0.5]), false);
});

test('hasComplexityVariance: varying scores return true', () => {
  assert.equal(hasComplexityVariance([0.2, 0.5, 0.8]), true);
  assert.equal(hasComplexityVariance([0.1, 0.9]), true);
});

test('hasComplexityVariance: near-equal scores below epsilon return false', () => {
  assert.equal(hasComplexityVariance([0.5, 0.5 + 1e-12, 0.5 - 1e-12]), false);
});
