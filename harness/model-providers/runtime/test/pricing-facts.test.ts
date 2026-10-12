import test from 'node:test';
import assert from 'node:assert/strict';
import { captureProviderRuntimeProjection } from '../projection';
import { buildProviderRuntimePricingFacts } from '../pricing-facts';
import type { NativeRuntimeModel } from '../contracts';

const model: NativeRuntimeModel = { provider: 'legacy', id: 'm', name: 'M', api: 'openai-completions',
  baseUrl: 'https://example.invalid', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };

test('pricing identity follows the immutable capture even when YAML revision is unchanged', () => {
  const input = { config: { version: 1 as const, providers: {} }, configRevision: `sha256:${'a'.repeat(64)}` };
  const first = captureProviderRuntimeProjection({ ...input, legacyModels: [model] })!;
  const second = captureProviderRuntimeProjection({ ...input, legacyModels: [{ ...model, cost: { ...model.cost, input: 9 } }] })!;
  const before = buildProviderRuntimePricingFacts(first);
  const after = buildProviderRuntimePricingFacts(second);
  assert.notEqual(before.catalogVersion, after.catalogVersion);
  assert.equal(before.map.get('legacy/m')?.[0].pricing?.input, 1);
  assert.equal(after.map.get('legacy/m')?.[0].pricing?.input, 9);
  assert.ok(Object.isFrozen(before.map.get('legacy/m')));
  assert.throws(() => before.map.get('legacy/m')!.push(after.map.get('legacy/m')![0]));
  assert.equal(before.map.get('legacy/m')?.length, 1);
  assert.equal(buildProviderRuntimePricingFacts(JSON.parse(JSON.stringify(first))).catalogVersion, before.catalogVersion);
});
