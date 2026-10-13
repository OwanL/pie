import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureProviderRuntimeProjection } from '../projection';
import { buildProviderRuntimePricingFacts } from '../pricing-facts';
import { approvedShippedRuntimeCatalog } from '../shipped-catalog';

test('deployed shipped authority captures exact Ollama local and cloud identities', () => {
  const shippedCatalog = approvedShippedRuntimeCatalog();
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: { ollama: { enabled: true } } },
    configRevision: `sha256:${'b'.repeat(64)}`, legacyModels: [], shippedCatalog,
    discovered: { ollama: { kind: 'public', complete: true, freshness: 'fresh', models: {
      'qwen3.5:9b': { name: 'qwen3.5:9b', input: ['text'], reasoning: false }, 'unpublished:cloud': { pricing: 'unknown' },
    } } } })!;
  const qwen = snapshot.models.find(row => row.providerId === 'ollama' && row.id === 'qwen3.5:9b')!;
  assert.equal(qwen.model?.contextWindow, 8192);
  assert.equal(qwen.model?.maxTokens, 512);
  assert.equal(snapshot.models.find(row => row.id === 'unpublished:cloud')?.model, undefined);
  const facts = buildProviderRuntimePricingFacts(snapshot);
  const deepseek = facts.map.get('ollama/deepseek-v4-pro:cloud')?.[0].pricing;
  assert.ok(deepseek?.peak);
  assert.deepEqual(deepseek, shippedCatalog.ollama.models?.['deepseek-v4-pro:cloud'].pricing);
  assert.equal(facts.map.get('ollama/qwen3.5:397b-cloud')?.[0].pricing?.cacheReadUnsupported, true);
});

test('approved shipped facts retain local limits and cloud applicability without registry proof', () => {
  const peak = { weekdaysUtc: [1, 2, 3, 4, 5], startMinutesUtc: 720, endMinutesUtc: 1080,
    override: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } };
  const input = { config: { version: 1 as const, providers: { ollama: { enabled: true } } },
    configRevision: `sha256:${'a'.repeat(64)}`, legacyModels: [],
    shippedCatalog: { ollama: { api: 'openai-completions' as const, baseUrl: 'http://localhost:11434/v1', models: {
      qwen: { input: ['text' as const], reasoning: false, contextWindow: 32768, maxTokens: 8192,
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      cloud: { input: ['text' as const], reasoning: false, contextWindow: 100000, maxTokens: 8192,
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, peak, cacheReadUnsupported: true } },
    } } } };
  const snapshot = captureProviderRuntimeProjection(input)!;
  assert.equal(snapshot.models.find(row => row.id === 'qwen')?.model?.contextWindow, 32768);
  const facts = buildProviderRuntimePricingFacts(snapshot);
  assert.deepEqual(facts.map.get('ollama/cloud')?.[0].pricing?.peak, peak);
  assert.equal(facts.map.get('ollama/cloud')?.[0].pricing?.cacheReadUnsupported, true);
  assert.equal(Object.isFrozen(snapshot.models[0].pricingFacts), true);
  const unknown = captureProviderRuntimeProjection({ ...input, config: { version: 1, providers: {
    ollama: { enabled: true, modelOverrides: { cloud: { pricing: 'unknown' } } },
  } } })!;
  assert.equal(unknown.models.find(row => row.id === 'cloud')?.model, undefined);
});
