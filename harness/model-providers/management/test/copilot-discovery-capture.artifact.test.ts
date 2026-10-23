import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { loadSdk, type SourceArtifactSdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture.js';
import { createProviderManagementService } from '../service';
import { createProviderRuntimeServices } from '../../runtime/services';
import { parseModelPricing } from '../../pricing/pricing-core';
import { providerProtocolOptions, type ProviderApi } from '../../catalog/provider-config';

// Synthetic native OAuth exercises modifyModels without login, refresh or external traffic.
test('Copilot discovery captures the native account endpoint and saved scope for a native request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-copilot-discovery-capture-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  const access = 'synthetic;proxy-ep=proxy.business.githubcopilot.com;';
  const refresh = 'synthetic-unused-refresh';
  const calls: string[] = [];
  const observedRequests: { authorization?: string | null; integration?: string | null; contentType?: string | null; body?: unknown }[] = [];
  let unexpected = 0;
  let modelId = '';
  let phase: 'offline' | 'discovery' | 'runtime' = 'offline';
  const interceptedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    if (phase === 'discovery' && request.method === 'GET' && request.url === 'https://api.business.githubcopilot.com/models') {
      observedRequests.push({ authorization: request.headers.get('Authorization'), integration: request.headers.get('Copilot-Integration-Id') });
      return Response.json({ data: [{ id: modelId, name: 'Synthetic account listing', model_picker_enabled: true,
        supported_endpoints: ['/chat/completions'], billing: { token_prices: { default: { input_price: 1, output_price: 2 } } } }] });
    }
    if (phase === 'runtime' && request.method === 'POST' && request.url === 'https://api.business.githubcopilot.com/chat/completions') {
      observedRequests.push({ authorization: request.headers.get('Authorization'), integration: request.headers.get('Copilot-Integration-Id'),
        contentType: request.headers.get('content-type'), body: await request.json() });
      return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 });
    }
    unexpected++;
    throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
  };
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  // Never delegate, including SDK loading and broker construction.
  globalThis.fetch = interceptedFetch;
  let service: ReturnType<typeof createProviderManagementService> | undefined;
  try {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
    assert.ok(sdk.createProviderManagementAuth);
    const credentialFile = join(dir, 'credentials.json');
    const auth = sdk.createProviderManagementAuth(credentialFile);
    await auth.saveCredential!('github-copilot', { type: 'oauth', access, refresh, expires: Date.now() + 3_600_000 });
    const baseline = sdk.getProviderManagementModels!('github-copilot');
    const builtin = baseline.find(model => model.api === 'openai-completions');
    assert.ok(builtin);
    modelId = builtin.id;
    service = createProviderManagementService({ configFile: join(dir, 'providers.yaml'), modelCacheDir: join(dir, 'cache'), auth,
      fetch: interceptedFetch, readEnvironment: () => undefined,
      shipped: id => id === 'github-copilot' ? { models: Object.fromEntries(baseline.filter(model => providerProtocolOptions.includes(model.api as ProviderApi)).map(model => [model.id, {
        name: model.name, api: model.api as ProviderApi, baseUrl: model.baseUrl, input: model.input,
        reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, pricing: parseModelPricing(model.cost),
      }])) } : undefined });
    const detail = await service.request({ type: 'read-provider', operationId: 'read', id: 'github-copilot' });
    assert.equal(detail.status, 'ok');
    assert.ok(detail.draft);
    const saved = await service.request({ type: 'save', operationId: 'save', expectedRevision: detail.snapshot.configRevision,
      draft: { ...detail.draft, enabled: true, credentialSource: 'saved' } });
    assert.equal(saved.status, 'ok');
    assert.deepEqual(calls, []);
    phase = 'discovery';
    const discovered = await service.request({ type: 'refresh', operationId: 'refresh', id: 'github-copilot' });
    assert.equal(discovered.status, 'ok');
    const discoveredModel = discovered.draft?.models.find(model => model.id === modelId);
    assert.equal(discoveredModel?.name, 'Synthetic account listing');
    assert.deepEqual(calls, ['GET https://api.business.githubcopilot.com/models']);
    assert.deepEqual(observedRequests[0], { authorization: `Bearer ${access}`, integration: 'vscode-chat' });
    phase = 'offline';
    const captured = await service.captureRuntimeProjection(baseline, baseline);
    assert.ok(captured);
    const row = captured.models.find(model => model.providerId === 'github-copilot' && model.id === modelId);
    assert.ok(row?.model);
    assert.equal(row.model.name, 'Synthetic account listing');
    assert.equal(row.model.baseUrl, 'https://api.business.githubcopilot.com');
    assert.equal(row.rejection, undefined);
    assert.deepEqual(row.credential, { source: 'saved', scope: await auth.getRuntimeCredentialScope!('github-copilot') });
    assert.ok(!JSON.stringify(captured).includes(access));
    assert.ok(!JSON.stringify(captured).includes(refresh));
    const runtime = createProviderRuntimeServices(sdk, captured, undefined, { credentialFile });
    const selected = runtime.modelRegistry.find('github-copilot', modelId);
    assert.ok(selected);
    const requestAuth = await runtime.modelRegistry.getApiKeyAndHeaders(selected);
    assert.equal(requestAuth.ok, true);
    assert.equal(requestAuth.apiKey, access);
    assert.deepEqual(calls, ['GET https://api.business.githubcopilot.com/models']);
    phase = 'runtime';
    const response = await stream(selected as Parameters<typeof stream>[0], {
      messages: [{ role: 'user', content: 'artifact fixture', timestamp: 0 }],
    }, { apiKey: requestAuth.apiKey, headers: requestAuth.headers }).result();
    assert.equal(response.stopReason, 'error');
    assert.match(response.errorMessage ?? '', /401|synthetic unauthorized/);
    assert.deepEqual(calls, ['GET https://api.business.githubcopilot.com/models', 'POST https://api.business.githubcopilot.com/chat/completions']);
    const runtimeRequest = observedRequests[1];
    assert.deepEqual(runtimeRequest, { authorization: `Bearer ${access}`, integration: 'vscode-chat', contentType: 'application/json',
      body: { model: modelId, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'artifact fixture' }] } });
    assert.equal(unexpected, 0);
  } finally {
    service?.dispose();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
