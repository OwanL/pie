import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProviderSelectorPolicy } from '../selector-policy';
import { availableProviderRuntimeModels } from '../services';
import { projectProviderRuntimeModels } from '../model-info';
import type { RuntimeSnapshot } from '../contracts';

test('current provider-qualified visibility re-shows captured hidden models without changing admission or pins', () => {
  const model = { provider: 'a', id: 'same', name: 'Same', api: 'openai-completions', baseUrl: 'https://example.com', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const snapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: ['a', 'b', 'disabled', 'unauthorized'].map(providerId => ({ providerId, id: 'same', enabled: providerId !== 'disabled', visible: providerId !== 'a', subagentEligible: false, credential: { source: 'legacy' }, model: { ...model, provider: providerId } })) } as RuntimeSnapshot;
  const current = applyProviderSelectorPolicy(snapshot, { version: 1, providers: { a: { enabled: false, modelPreferences: { same: { visible: true } } }, b: { enabled: true, modelPreferences: { same: { visible: false } } } } });
  const available = availableProviderRuntimeModels(current, { credentialFile: 'unused', savedCredential: () => undefined, legacyHasAuth: provider => provider !== 'unauthorized', defaultHasAuth: () => false });
  assert.deepEqual(projectProviderRuntimeModels(current, available).map(model => model.provider), ['a']);
  assert.equal(current.models[0].model, snapshot.models[0].model);
  assert.equal(current.models[0].credential, snapshot.models[0].credential);
  assert.equal(snapshot.models[0].visible, false);
  assert.equal(current.models[0].subagentEligible, false);
  assert.equal(current.models[0].enabled, true);
});
