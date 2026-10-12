import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectProviderRuntimeModels } from '../model-info';
import { captureProviderRuntimeProjection } from '../projection';
import type { NativeRuntimeModel } from '../contracts';

const revision = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const native: NativeRuntimeModel = {
  provider: 'captured', id: 'reasoning', name: 'Captured reasoning model', api: 'openai-completions',
  baseUrl: 'https://captured.example/v1', input: ['text', 'image'], reasoning: true,
  thinkingLevelMap: { off: null, xhigh: 'high', max: null }, contextWindow: 1000, maxTokens: 100,
  cost: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test('public runtime model info preserves captured capabilities and exact known pricing without private projection data', () => {
  const secretHeader = 'private-builtin-header-value';
  const builtin = { ...native, headers: { 'X-Compiled-Private': secretHeader } };
  const snapshot = captureProviderRuntimeProjection({
    config: { version: 1, providers: {
      captured: {
        enabled: true, credentialRef: { source: 'saved' },
        modelPreferences: { reasoning: { subagentEligible: false } },
      },
      disabled: { enabled: false },
      hidden: { enabled: true, modelPreferences: { reasoning: { visible: false } } },
      unknownPrice: { enabled: true, modelOverrides: { reasoning: { pricing: 'unknown' } } },
      rejected: { enabled: true },
    } },
    configRevision: revision('public-model-info'),
    legacyModels: [
      builtin,
      { ...native, provider: 'disabled' },
      { ...native, provider: 'hidden' },
      { ...native, provider: 'unknownPrice' },
      { ...native, provider: 'rejected', contextWindow: 0 },
    ],
    builtinModels: [builtin],
    credentialScopes: { captured: 'private-saved-scope-uuid' },
  })!;

  const publicModels = projectProviderRuntimeModels(snapshot);
  assert.equal(publicModels.length, 1);
  assert.deepEqual(publicModels[0], {
    id: 'reasoning', provider: 'captured', name: 'Captured reasoning model', reasoning: true,
    thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], inputKinds: ['text', 'image'],
    contextWindow: 1000, maxTokens: 100,
    subagent: { eligible: false, pricing: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 } },
  });
  assert.equal(snapshot.models.find(row => row.providerId === 'captured')?.builtinHeaders?.provider, 'captured');
  const serialized = JSON.stringify(publicModels);
  for (const privateValue of [secretHeader, 'private-saved-scope-uuid', 'builtinHeaders', 'sha256']) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} must not be public model info`);
  }
  assert.ok(!publicModels.some(model => ['disabled', 'hidden', 'unknownPrice', 'rejected'].includes(model.provider)));
});

test('available model filtering uses exact provider/id pairs and deduplicates duplicate admissions', () => {
  const snapshot = captureProviderRuntimeProjection({
    config: { version: 1, providers: {} }, configRevision: revision('available-filter'),
    legacyModels: [
      native,
      { ...native, provider: 'other', name: 'Same id, other provider' },
      { ...native, id: 'other-id', name: 'Same provider, other id' },
    ],
  })!;
  const models = projectProviderRuntimeModels(snapshot, [
    { provider: 'captured', id: 'reasoning' },
    { provider: 'captured', id: 'reasoning' },
    { provider: 'other', id: 'reasoning' },
    { provider: 'captured', id: 'not-present' },
  ]);
  assert.deepEqual(models.map(model => [model.provider, model.id]), [
    ['captured', 'reasoning'], ['other', 'reasoning'],
  ]);
});
