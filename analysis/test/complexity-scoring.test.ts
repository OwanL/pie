import assert from 'node:assert/strict';
import test from 'node:test';

import { percentileRanks } from '../scripts/complexity-scoring.ts';

test('percentileRanks preserves input order and gives ties their shared mid-rank', () => {
  assert.deepEqual(percentileRanks([3, 1, 1, 2, 3]), [0.8, 0.2, 0.2, 0.5, 0.8]);
});
