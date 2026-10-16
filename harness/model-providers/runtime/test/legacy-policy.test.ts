import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureProviderRuntimeProjection } from '../projection';
import { assertProviderRuntimeModel, availableProviderRuntimeModels } from '../services';
import type { NativeRuntimeModel } from '../contracts';

const native: NativeRuntimeModel = { provider: 'custom', id: 'one', name: 'Private native',
  api: 'openai-completions', baseUrl: 'https://native.example/v1', input: ['text'], reasoning: true,
  contextWindow: 1234, maxTokens: 456, cost: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 },
  compat: { supportsDeveloperRole: false }, thinkingLevelMap: { high: 'native-high' } };
const revision = `sha256:${'a'.repeat(64)}`;

test('legacy policy overlays preserve native/custom definitions, not catalog, discovery or transport overrides', () => {
  const second = { ...native, id: 'two', api: 'anthropic-messages', baseUrl: 'https://second.example/v2' };
  const snapshot = captureProviderRuntimeProjection({ configRevision: revision, legacyModels: [native, second],
    config: { version: 1, providers: { custom: { enabled: true, credentialRef: { source: 'legacy' },
      api: 'openai-responses', baseUrl: 'https://override.example', manualModels: ['invented'],
      modelOverrides: { one: { name: 'Override', pricing: 'unknown' } },
      modelPreferences: { one: { visible: false, subagentEligible: false } } } } },
    shippedCatalog: { custom: { models: { one: { name: 'Shipped', baseUrl: 'https://shipped.example', pricing: 'unknown' } } } },
    discovered: { custom: { kind: 'account', complete: true, freshness: 'fresh', models: { one: { name: 'Discovered' } } } },
  })!;
  assert.equal(snapshot.models.length, 2);
  assert.deepEqual(snapshot.models.map(row => row.model), [native, second]);
  assert.equal(snapshot.models[0].visible, false);
  assert.equal(snapshot.models[0].subagentEligible, false);
  assert.deepEqual(snapshot.models[0].credential, { source: 'legacy' });
});

test('removed providers have no new capture fallback; disabled providers remain pinned disabled', () => {
  const capture = (removed: boolean) => captureProviderRuntimeProjection({ configRevision: revision, legacyModels: [native],
    config: { version: 1, providers: { custom: { enabled: !removed, credentialRef: { source: 'legacy' }, ...(removed ? { removed: true as const } : {}) } } } })!;
  const pinned = capture(false);
  assert.equal(capture(true).models.length, 0);
  assert.deepEqual(assertProviderRuntimeModel(pinned, 'custom', 'one'), native);
  const disabled = captureProviderRuntimeProjection({ configRevision: revision, legacyModels: [native],
    config: { version: 1, providers: { custom: { enabled: false, credentialRef: { source: 'legacy' } } } } })!;
  assert.equal(disabled.models.length, 1);
  assert.equal(disabled.models[0].enabled, false);
  assert.deepEqual(disabled.models[0].model, native);
  assert.throws(() => assertProviderRuntimeModel(disabled, 'custom', 'one'));
  assert.deepEqual(availableProviderRuntimeModels(disabled, { credentialFile: 'unused', savedCredential: () => undefined,
    legacyHasAuth: () => true, defaultHasAuth: () => true }), []);
});

test('legacy overlays never approximate untrusted native headers with headerless dispatch', () => {
  const snapshot = captureProviderRuntimeProjection({ configRevision: revision,
    legacyModels: [{ ...native, headers: { Authorization: 'private' } }],
    config: { version: 1, providers: { custom: { enabled: true, credentialRef: { source: 'legacy' } } } } })!;
  assert.equal(snapshot.models[0].model, undefined);
  assert.equal(snapshot.models[0].rejection, 'unsupported-or-incomplete-runtime-model');
  assert.ok(!JSON.stringify(snapshot).includes('private'));
});
