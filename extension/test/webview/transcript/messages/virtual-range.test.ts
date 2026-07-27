import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRangeWithPinnedIndexes } from '../../../../src/webview/panel/transcript/virtual-range';

test('virtual range keeps an active inline-editor row mounted outside the viewport', () => {
  const range = { startIndex: 40, endIndex: 50, overscan: 2, count: 100 };

  const indexes = extractRangeWithPinnedIndexes(range, [7]);

  assert.ok(indexes.includes(7));
  assert.ok(indexes.includes(38));
  assert.ok(indexes.includes(52));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

test('virtual range ignores stale pinned indexes after transcript rows change', () => {
  const range = { startIndex: 0, endIndex: 4, overscan: 1, count: 5 };

  assert.deepEqual(extractRangeWithPinnedIndexes(range, [-1, 5]), [0, 1, 2, 3, 4]);
});
