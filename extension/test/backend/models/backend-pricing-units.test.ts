import assert from 'node:assert/strict';
import test from 'node:test';

import { parseModelPricing } from '../../../src/backend/pricing';

// ─── parseModelPricing ───────────────────────────────────────────────────────

test('parseModelPricing: full valid object returns all four rates', () => {
  const parsed = parseModelPricing({
    input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
  });
  assert.deepEqual(parsed, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
});

test('parseModelPricing: missing cache fields default to 0', () => {
  const parsed = parseModelPricing({ input: 5, output: 30 });
  assert.deepEqual(parsed, { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 });
});

test('parseModelPricing: all fields missing → all zero (free/local model)', () => {
  const parsed = parseModelPricing({});
  assert.deepEqual(parsed, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('parseModelPricing: rejects non-object inputs safely (array, null, primitives)', () => {
  assert.equal(parseModelPricing(null), undefined);
  assert.equal(parseModelPricing(undefined), undefined);
  assert.equal(parseModelPricing('not-an-object'), undefined);
  assert.equal(parseModelPricing(42), undefined);
  assert.equal(parseModelPricing(true), undefined);
  assert.equal(parseModelPricing([{ input: 1 }]), undefined); // array shape
});

test('parseModelPricing: non-number required field → undefined', () => {
  assert.equal(parseModelPricing({ input: '3', output: 15 }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: null }), undefined);
});

test('parseModelPricing: non-number optional cache field → undefined (whole record invalid)', () => {
  assert.equal(parseModelPricing({ input: 3, output: 15, cacheRead: '0.3' }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: 15, cacheWrite: null }), undefined);
});

test('parseModelPricing: negative rates rejected', () => {
  assert.equal(parseModelPricing({ input: -1, output: 15 }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: -2 }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: 15, cacheRead: -0.1 }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: 15, cacheWrite: -1 }), undefined);
});

test('parseModelPricing: non-finite rates (NaN/Infinity) rejected', () => {
  assert.equal(parseModelPricing({ input: NaN, output: 15 }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: Infinity }), undefined);
  assert.equal(parseModelPricing({ input: 3, output: 15, cacheRead: -Infinity }), undefined);
});

test('parseModelPricing: zero is a valid (free) rate, not rejected', () => {
  const parsed = parseModelPricing({ input: 0, output: 0 });
  assert.deepEqual(parsed, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
