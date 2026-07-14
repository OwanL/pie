import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateNormalizedCost,
  parseModelPricing,
  type ModelTokenPricing,
} from '../../../src/backend/pricing';

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

// ─── estimateNormalizedCost ───────────────────────────────────────────────────
//
// blended = (3·input + 1·output) / 4
// normalized = 10 · √(blended / 6.00)

test('estimateNormalizedCost: claude-sonnet-4.6 baseline ($3 in / $15 out) → cost 10', () => {
  // blended = (9 + 15) / 4 = 6.00  →  10·√(6/6) = 10
  const cost = estimateNormalizedCost({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 10);
});

test('estimateNormalizedCost: zero tokens → 0 cost (no division/NaN)', () => {
  assert.equal(estimateNormalizedCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test('estimateNormalizedCost: input-only rate weights 3:1 over output', () => {
  // blended = (3·6 + 1·0) / 4 = 4.5  →  10·√(4.5/6) = 10·√0.75
  const cost = estimateNormalizedCost({ input: 6, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 10 * Math.sqrt(0.75));
});

test('estimateNormalizedCost: output-only rate weights 1:4 of input', () => {
  // blended = (3·0 + 1·24) / 4 = 6  →  10·√1 = 10
  const cost = estimateNormalizedCost({ input: 0, output: 24, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 10);
});

test('estimateNormalizedCost: scales with the square root of blended price', () => {
  // Doubling the blended rate from 6 → 12 increases cost by √2, not 2×.
  const baseline = estimateNormalizedCost({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
  const doubled = estimateNormalizedCost({ input: 6, output: 30, cacheRead: 0, cacheWrite: 0 });
  assert.equal(doubled, baseline * Math.SQRT2);
});

test('estimateNormalizedCost: cache rates do not affect the normalized cost', () => {
  const a: ModelTokenPricing = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
  const b: ModelTokenPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  assert.equal(estimateNormalizedCost(a), estimateNormalizedCost(b));
});

test('estimateNormalizedCost: very expensive model yields a large but finite cost', () => {
  // $75 in / $300 out → blended = (225 + 300)/4 = 131.25 → 10·√(131.25/6)
  const cost = estimateNormalizedCost({ input: 75, output: 300, cacheRead: 0, cacheWrite: 0 });
  assert.ok(Number.isFinite(cost));
  assert.ok(cost > 10);
  assert.equal(cost, 10 * Math.sqrt(131.25 / 6));
});
