import assert from 'node:assert/strict';
import test from 'node:test';

import {
  subagentDisplayCosts,
  subagentDisplayCostForEntry,
} from '../../../../src/webview/panel/transcript/subagent-cost';
import {
  createTokenPricingResolver,
  type TokenPricingResolver,
} from '../../../../src/webview/panel/session-tabs/token-usage';

const standardPricing = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  tiers: [{
    inputTokensAbove: 100,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
  }],
};

const pricingForModel = createTokenPricingResolver([{
  id: 'model',
  name: 'Model',
  provider: 'provider',
  reasoning: false,
  inputKinds: ['text'],
  subagent: { eligible: true, pricing: standardPricing },
}]);

function rawBilling(invocations: unknown[], usage?: Record<string, unknown>) {
  return {
    billing: [{
      path: '0',
      model: 'provider/model',
      provider: 'provider',
      ...(usage ? { usage } : {}),
      invocations,
    }],
  };
}

function invocation(usage: Record<string, unknown>) {
  return { invocationId: 'invocation', model: 'provider/model', provider: 'provider', usage };
}

const completeUsage = (input: number, output = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

test('qualified model IDs select provider pricing without ambiguous bare fallback', () => {
  const resolver = createTokenPricingResolver([
    { id: 'model', name: 'A', provider: 'provider-a', reasoning: false, inputKinds: ['text'], subagent: { eligible: true, pricing: standardPricing } },
    { id: 'model', name: 'B', provider: 'provider-b', reasoning: false, inputKinds: ['text'], subagent: { eligible: true, pricing: { ...standardPricing, input: 9 } } },
  ]);

  assert.equal(resolver('provider-a/model')?.input, 1);
  assert.equal(resolver('provider-b/model')?.input, 9);
  assert.equal(resolver('model'), undefined);
});

test('transcript reprices each provider invocation with its own long-context tier', () => {
  const result = subagentDisplayCosts(rawBilling([
    invocation(completeUsage(100, 10)),
    invocation(completeUsage(101, 10)),
  ]), 1, pricingForModel)[0];

  assert.deepEqual(result, {
    // 100-token invocation uses the base tier; 101-token invocation uses the
    // long-context tier. Pricing must not be applied to their aggregate 201.
    cost: (100 / 1_000_000) + (10 * 2 / 1_000_000)
      + (101 * 10 / 1_000_000) + (10 * 20 / 1_000_000),
    estimated: true,
  });
});

test('partial invocation channels remain unknown instead of becoming a zero estimate', () => {
  const result = subagentDisplayCosts(rawBilling([
    invocation({ input: 100, output: 10, cacheRead: 0 }),
  ]), 1, pricingForModel)[0];
  assert.equal(result, undefined);
});

test('free catalog pricing is displayed as a calculated zero estimate', () => {
  const freePricing: TokenPricingResolver = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const result = subagentDisplayCosts(rawBilling([
    invocation(completeUsage(100, 10)),
  ]), 1, freePricing)[0];
  assert.deepEqual(result, { cost: 0, estimated: true });
});

test('reported zero overrides catalog pricing and stays non-estimated', () => {
  const result = subagentDisplayCosts(rawBilling([
    invocation({ ...completeUsage(100, 10), providerReportedCostUsd: 0 }),
  ]), 1, pricingForModel)[0];
  assert.deepEqual(result, { cost: 0, estimated: false });
});

test('mixed reported, catalog, and unknown invocations are not masked by aggregate cost', () => {
  const result = subagentDisplayCosts(rawBilling([
    invocation({ ...completeUsage(100, 10), providerReportedCostUsd: 0.01 }),
    invocation(completeUsage(100, 10)),
    invocation({ input: 100 }),
  ], { providerReportedCostUsd: 0.01 }), 1, pricingForModel)[0];
  assert.equal(result, undefined);
});

test('per-invocation evidence combines reported and catalog costs', () => {
  const result = subagentDisplayCosts(rawBilling([
    invocation({ ...completeUsage(100, 10), providerReportedCostUsd: 0.01 }),
    invocation(completeUsage(100, 10)),
  ], { providerReportedCostUsd: 0.01 }), 1, pricingForModel)[0];
  assert.deepEqual(result, {
    cost: 0.01 + ((100 + (10 * 2)) / 1_000_000),
    estimated: true,
  });
});

test('multi-turn aggregate usage is not repriced as one invocation', () => {
  const result = subagentDisplayCostForEntry({
    path: '0',
    model: 'provider/model',
    provider: 'provider',
    usage: { ...completeUsage(100, 10), turns: 2 },
  }, pricingForModel);
  assert.equal(result, undefined);
});
