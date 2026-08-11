import assert from 'node:assert/strict';
import test from 'node:test';

import { qualifyModelId, resolvePricingCatalogKey, stripProviderPrefix } from '../../src/shared/model-id';

test('stripProviderPrefix removes a provider prefix and leaves bare ids unchanged', () => {
  assert.equal(stripProviderPrefix('ollama/glm-5.2:cloud'), 'glm-5.2:cloud');
  assert.equal(stripProviderPrefix('openai-codex/gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(stripProviderPrefix('glm-5.2:cloud'), 'glm-5.2:cloud');
  assert.equal(stripProviderPrefix('gpt-5.6-sol'), 'gpt-5.6-sol');
  // Leading/trailing slashes are not provider prefixes.
  assert.equal(stripProviderPrefix('/leading'), '/leading');
  assert.equal(stripProviderPrefix('trailing/'), 'trailing/');
  // Only the last slash is treated as the prefix boundary.
  assert.equal(stripProviderPrefix('a/b/c'), 'c');
});

test('qualifyModelId does not duplicate an existing provider prefix', () => {
  assert.equal(qualifyModelId('gpt-5.6-sol', 'github-copilot'), 'github-copilot/gpt-5.6-sol');
  assert.equal(qualifyModelId('github-copilot/gpt-5.6-sol', 'github-copilot'), 'github-copilot/gpt-5.6-sol');
  assert.equal(qualifyModelId('gpt-5.6-sol', undefined), 'gpt-5.6-sol');
  assert.equal(qualifyModelId(undefined, 'github-copilot'), undefined);
});

test('resolvePricingCatalogKey prefers the full id and falls back to the suffix', () => {
  const catalog = new Set(['glm-5.2:cloud', 'gpt-5.6-sol']);
  const has = (key: string) => catalog.has(key);
  assert.equal(resolvePricingCatalogKey('glm-5.2:cloud', has), 'glm-5.2:cloud');
  assert.equal(resolvePricingCatalogKey('ollama/glm-5.2:cloud', has), 'glm-5.2:cloud');
  assert.equal(resolvePricingCatalogKey('openai-codex/gpt-5.6-sol', has), 'gpt-5.6-sol');
  assert.equal(resolvePricingCatalogKey('unknown-model', has), null);
  assert.equal(resolvePricingCatalogKey(undefined, has), null);
  assert.equal(resolvePricingCatalogKey('', has), null);
});
