import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCompactTokens } from '../format-tokens';

test('formatCompactTokens keeps normal M/k-suffix values and zero', () => {
  assert.equal(formatCompactTokens(0), '0');
  assert.equal(formatCompactTokens(1), '1');
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(1_000), '1k');
  assert.equal(formatCompactTokens(1_234), '1.2k');
  assert.equal(formatCompactTokens(1_000_000), '1M');
  assert.equal(formatCompactTokens(1_500_000), '1.5M');
});

test('formatCompactTokens promotes only when one-decimal rounding rolls over the k unit', () => {
  assert.equal(formatCompactTokens(999_500), '999.5k');
  assert.equal(formatCompactTokens(999_949), '999.9k');
  assert.equal(formatCompactTokens(999_950), '1M');
  assert.equal(formatCompactTokens(999_999), '1M');
  assert.equal(formatCompactTokens(1_000_000), '1M');
});

test('formatCompactTokens keeps below-threshold values unsuffixed', () => {
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(1_000 - 0.001), '999.999');
});
