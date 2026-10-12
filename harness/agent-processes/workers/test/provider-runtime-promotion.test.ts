import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { WorkerRuntimeHost, capturedWorkerSettlementPricingResolver } from '../worker-runtime-host';
import { buildProviderRuntimePricingFacts } from '../../../model-providers/runtime/index';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection';

const canonicalRevision = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const snapshot = { version: 1 as const, configRevision: canonicalRevision('worker-capture'), models: [{ providerId: 'private', id: 'm', enabled: true, visible: true, subagentEligible: false, credential: { source: 'none' as const }, model: { provider: 'private', id: 'm', name: 'Private', api: 'openai-completions', baseUrl: 'https://invalid.example', input: ['text' as const], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 } } }] };

test('captured worker settlement uses captured provider-qualified rates, never a fallback', () => {
  const price = capturedWorkerSettlementPricingResolver(buildProviderRuntimePricingFacts(snapshot));
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
  assert.equal(price({ model: 'm', provider: 'private', usage })?.catalogVersion, canonicalRevision(JSON.stringify(snapshot)));
  assert.equal(price({ model: 'm', provider: 'private', usage })?.inputUsdPerMillionTokens, 2);
  assert.equal(price({ model: 'm', provider: 'other', usage }), undefined);
  assert.equal(price({ model: 'missing', provider: 'private', usage }), undefined);
});

test('captured worker catalog cannot fall back to synced global catalog or report managed models globally', () => {
  let reports = 0;
  const host = new WorkerRuntimeHost({ server: { onDetailDrain: () => () => {}, sendRuntimeReportFrame: () => { reports++; } } as any, owner: {} as any, sdkRuntime: createSyntheticSourceTestSdkRuntime('/sdk') });
  const internal = host as any;
  internal.providerSnapshot = snapshot;
  internal.syncedCatalogModels = [{ id: 'global' }];
  assert.throws(() => internal.availableModels(), /Captured provider registry/);
  internal.reportRuntimeCatalog();
  assert.equal(reports, 0);
  const options = internal.capturedProviderServices({});
  assert.equal(typeof options.providerServices, 'function');
  internal.providerSnapshot = undefined;
  assert.deepEqual(internal.capturedProviderServices({}), {});
});
