import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEADERBOARD_WEIGHTS,
  LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS,
  LEADERBOARD_MINIMUM_SCORED_RUNS,
  LEADERBOARD_MINIMUM_TASK_SCORING_COVERAGE,
  LEADERBOARD_SHRINKAGE_K,
  LEADERBOARD_TOKEN_EFFICIENCY_MAX,
  LEADERBOARD_OUTCOME_EXPONENT,
  LEADERBOARD_MASTERY_COMPLEXITY_WEIGHT,
} from '../scripts/leaderboard-scoring.ts';

test('leaderboard weights are the specified outcome-only convex combination', () => {
  assert.deepEqual(LEADERBOARD_WEIGHTS, {
    satisfaction: 8 / 15,
    resolutionRate: 7 / 15,
    fileChurn: 0,
    toolReliability: 0,
    verificationPassRate: 0,
    tokenEfficiency: 0,
  });
  const total = Object.values(LEADERBOARD_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `composite weights must sum to 1.0, got ${total}`);
});

test('post-treatment workload emphasis is disabled in compatibility exports', () => {
  assert.equal(LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS.size, 0);
  assert.equal(LEADERBOARD_OUTCOME_EXPONENT, 1);
  assert.equal(LEADERBOARD_MASTERY_COMPLEXITY_WEIGHT, 0);
});

test('scoring constants pin the task-count and coverage gates plus fixed regularization strength', () => {
  assert.equal(LEADERBOARD_MINIMUM_SCORED_RUNS, 10);
  assert.equal(LEADERBOARD_MINIMUM_TASK_SCORING_COVERAGE, 0.40);
  assert.equal(LEADERBOARD_SHRINKAGE_K, 4);
  assert.equal(LEADERBOARD_TOKEN_EFFICIENCY_MAX, 50);
  assert.ok(LEADERBOARD_SHRINKAGE_K > 0);
  assert.ok(LEADERBOARD_TOKEN_EFFICIENCY_MAX > 0);
});
