import assert from 'node:assert/strict';
import test from 'node:test';
import { capturedWorkerSettlementPricingResolver } from '../worker-runtime-host';
import type { CapturedPricingFacts, ModelTokenPricing } from '../../../../analytics/contracts/model-pricing-facts';

const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const complete = { input: 2, output: 3, cacheRead: 0, cacheWrite: 4 };
function resolver(pricing?: ModelTokenPricing) {
  const facts: CapturedPricingFacts = {
    catalogVersion: 'captured',
    map: new Map([['m', [{ id: 'm', provider: 'private', pricing }]]]),
  };
  return capturedWorkerSettlementPricingResolver(facts);
}

test('captured settlement retains unknown and inapplicable pricing', () => {
  assert.equal(resolver()({ provider: 'private', model: 'm', usage }), undefined);
  assert.equal(resolver(complete)({ provider: 'other', model: 'm', usage }), undefined);
  assert.equal(resolver({ ...complete, cacheReadUnsupported: true })({
    provider: 'private', model: 'm', usage: { ...usage, cacheRead: 1 },
  }), undefined);
});

test('captured settlement rejects incomplete or invalid rates without defaulting them', () => {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    for (const value of [undefined, NaN, Infinity, -1]) {
      // Synthetic malformed captured facts exercise the complete-rate bridge boundary.
      const pricing = { ...complete, [key]: value } as ModelTokenPricing;
      assert.equal(resolver(pricing)({ provider: 'private', model: 'm', usage }), undefined);
    }
  }
});

test('captured settlement returns complete rates including genuine zero', () => {
  assert.deepEqual(resolver(complete)({ provider: 'private', model: 'm', usage }), {
    catalogVersion: 'captured', inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 3, cacheReadUsdPerMillionTokens: 0,
    cacheWriteUsdPerMillionTokens: 4,
  });
});
