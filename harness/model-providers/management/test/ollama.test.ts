import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverModels, normalizeOllamaBaseUrl, loadDiscoveryCache, saveDiscoveryCache } from '../discovery';
import { resolveProviderModelList } from '../../catalog/provider-model-resolution';
import { captureProviderRuntimeProjection } from '../../runtime/projection';
import { createProviderManagementService } from '../service';
import type { ProviderManagementAuthPort } from '../auth-port';

const definition = { id: 'ollama', kind: 'ollama' as const, name: 'Ollama', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', authMethods: ['local' as const], discovery: 'ollama' as const };
const probe = async () => {
  const calls: string[] = [];
  const snapshot = await discoverModels({ kind: 'ollama', baseUrl: 'http://localhost:11434/', signal: new AbortController().signal,
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [
        { name: 'qwen3.5:9b', details: { format: 'gguf' } },
        { name: 'cloud', remote_model: 'upstream', remote_host: 'https://ollama.com' },
        { name: 'new-cloud', remote_model: 'other' },
      ] });
      assert.equal(init?.method, 'POST');
      const model = JSON.parse(String(init?.body)).model;
      return Response.json({ ...(model === 'qwen3.5:9b' ? {} : { remote_model: model }),
        capabilities: ['completion', 'thinking', 'vision'], parameters: 'temperature 1',
        model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } });
    } });
  return { snapshot, calls };
};
test('Ollama local and remote metadata never infer serving limits or free cloud prices', async () => {
  const { snapshot, calls } = await probe();
  assert.deepEqual(calls, ['http://localhost:11434/api/tags', ...Array(3).fill('http://localhost:11434/api/show')]);
  assert.deepEqual(snapshot.models['qwen3.5:9b'].pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  for (const metadata of Object.values(snapshot.models)) {
    assert.equal(metadata.contextWindow, undefined); assert.equal(metadata.maxTokens, undefined);
  }
  assert.equal(snapshot.models.cloud.pricing, undefined);
  const native = (id: string, cost: number) => ({ provider: 'ollama', id, name: id, api: 'openai-completions', baseUrl: definition.baseUrl,
    input: ['text' as const], reasoning: true, contextWindow: 8192, maxTokens: 512,
    cost: { input: cost, output: cost, cacheRead: cost, cacheWrite: cost } });
  const nativeModels = [native('qwen3.5:9b', 0), native('cloud', 1)];
  const captured = captureProviderRuntimeProjection({ config: { version: 1, providers: { ollama: { enabled: true,
    api: 'openai-completions', baseUrl: definition.baseUrl, credentialRef: { source: 'none' },
    modelPreferences: { cloud: { visible: false, subagentEligible: false } },
    modelOverrides: { 'qwen3.5:9b': { maxTokens: 1024 } } } } }, configRevision: `sha256:${'a'.repeat(64)}`,
    legacyModels: nativeModels, builtinModels: nativeModels, discovered: { ollama: snapshot } })!;
  assert.equal(captured.models.find(m => m.id === 'qwen3.5:9b')?.model?.maxTokens, 1024);
  assert.equal(captured.models.find(m => m.id === 'cloud')?.model?.cost.input, 1);
  assert.equal(captured.models.find(m => m.id === 'cloud')?.visible, false);
  assert.equal(captured.models.find(m => m.id === 'cloud')?.subagentEligible, false);
  assert.equal(captured.models.find(m => m.id === 'new-cloud')?.rejection, 'unsupported-or-incomplete-runtime-model');
});
test('remote Ollama aliases cannot inherit shipped local zero prices through resolution and capture', async () => {
  for (const evidence of ['remote_model', 'remote_host'] as const) {
    for (const source of ['tag', 'show'] as const) {
      const snapshot = await discoverModels({ kind: 'ollama', baseUrl: definition.baseUrl, signal: new AbortController().signal,
        fetch: async url => Response.json(String(url).endsWith('/api/tags') ? { models: [
          { name: 'qwen3.5:9b', details: { format: 'gguf' }, ...(source === 'tag' ? { [evidence]: 'remote' } : {}) },
        ] } : { capabilities: ['completion'], model_info: { 'general.architecture': 'qwen35' },
          ...(source === 'show' ? { [evidence]: 'remote' } : {}) }) });
      const native = { provider: 'ollama', id: 'qwen3.5:9b', name: 'Qwen', api: 'openai-completions', baseUrl: definition.baseUrl,
        input: ['text' as const], reasoning: false, contextWindow: 8192, maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const config = { version: 1 as const, providers: { ollama: { enabled: true } } };
      const resolved = resolveProviderModelList({ config, shipped: { ollama: { models: { [native.id]: { pricing: native.cost } } } }, discovered: { ollama: snapshot } });
      assert.equal(resolved.providers.ollama.models[native.id].metadata.pricing, undefined);
      const input = { config, configRevision: `sha256:${'a'.repeat(64)}`, legacyModels: [native], builtinModels: [native], discovered: { ollama: snapshot } };
      assert.equal(captureProviderRuntimeProjection(input)?.models[0].rejection, 'unsupported-or-incomplete-runtime-model');
      const paid = { ...native, cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 2 } };
      assert.equal(captureProviderRuntimeProjection({ ...input, legacyModels: [paid], builtinModels: [paid] })?.models[0].model?.cost.output, 2);
      assert.equal(captureProviderRuntimeProjection({ ...input, config: { version: 1, providers: { ollama: { enabled: true,
        modelOverrides: { [native.id]: { pricing: native.cost } } } } } })?.models[0].model?.cost.input, 0);
      const dir = await mkdtemp(join(tmpdir(), 'pie-remote-alias-'));
      try {
        await saveDiscoveryCache(dir, 'ollama', 'daemon', snapshot, 1);
        const cached = await loadDiscoveryCache(dir, 'ollama', 'daemon');
        assert.equal(cached?.models[native.id].execution, 'remote');
        assert.equal(captureProviderRuntimeProjection({ ...input, discovered: { ollama: cached! } })?.models[0].rejection, 'unsupported-or-incomplete-runtime-model');
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
});
test('Ollama endpoint normalization rejects ambiguous paths and credential-bearing URLs', () => {
  assert.equal(normalizeOllamaBaseUrl('http://localhost:11434/v1/'), definition.baseUrl);
  for (const url of ['http://localhost:11434/api', 'http://user:secret@localhost:11434', 'http://localhost:11434/v1?q=x', 'http://localhost:11434/#fragment'])
    assert.throws(() => normalizeOllamaBaseUrl(url));
});
test('Ollama cache preserves incomplete metadata and rejects mismatched provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-ollama-cache-'));
  try {
    const { snapshot } = await probe();
    await saveDiscoveryCache(dir, 'ollama', 'daemon-A', snapshot, 1);
    assert.equal(await loadDiscoveryCache(dir, 'ollama', 'daemon-B'), undefined);
    const loaded = await loadDiscoveryCache(dir, 'ollama', 'daemon-A');
    assert.equal(loaded?.models.cloud.pricing, undefined);
    assert.equal(loaded?.models['qwen3.5:9b'].contextWindow, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Ollama local connection saves keyless configuration without authentication calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-ollama-service-'));
  const forbidden = async (): Promise<never> => { throw new Error('No auth calls allowed'); };
  const auth: ProviderManagementAuthPort = { definitions: () => [definition], hasSavedCredential: () => false,
    stageOAuthLogin: forbidden, saveCredential: forbidden, getApiKey: forbidden, discoveryBaseUrl: forbidden };
  const service = createProviderManagementService({ configFile: join(dir, 'providers.yaml'), modelCacheDir: join(dir, 'cache'), auth,
    fetch: async url => { assert.equal(String(url), 'http://localhost:11434/api/tags'); return Response.json({ models: [] }); } });
  try {
    const read = await service.request({ type: 'read-provider', operationId: 'read', id: 'ollama' });
    assert.equal(read.draft?.baseUrl, definition.baseUrl);
    const connected = await service.request({ type: 'connect', operationId: 'connect', expectedRevision: null,
      method: 'local', draft: { ...read.draft!, enabled: true, baseUrl: 'http://localhost:11434/' } });
    assert.equal(connected.status, 'ok');
    const refreshed = await service.request({ type: 'refresh', operationId: 'refresh', id: 'ollama' });
    assert.equal(refreshed.status, 'ok'); assert.equal(refreshed.draft?.credentialSource, 'none');
    assert.equal(refreshed.draft?.baseUrl, definition.baseUrl);
  } finally { service.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); await rm(dir, { recursive: true, force: true }); }
});
