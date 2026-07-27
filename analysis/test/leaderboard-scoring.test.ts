import assert from 'node:assert/strict';
import test from 'node:test';

import { LEADERBOARD_WEIGHTS } from '../scripts/leaderboard-scoring.ts';

test('runtime diagnostic dimensions have zero V2 ranking weight', () => {
  assert.deepEqual(LEADERBOARD_WEIGHTS, {
    fileChurn: 0,
    toolReliability: 0,
    verificationPassRate: 0,
    tokenEfficiency: 0,
  });
});
