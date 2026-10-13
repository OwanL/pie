import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyPiRuntimeArtifact, type GenerationPiRuntimeDescriptor, type PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { loadSdk, type SdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { approvedShippedRuntimeCatalog } from '../shipped-catalog';
import { captureProviderRuntimeProjection } from '../projection';
import { availableProviderRuntimeModels, createProviderRuntimeServices } from '../services';

const artifactRoot = process.env.PIE_PROVIDER_RUNTIME_ARTIFACT;
test('actual shipped Ollama catalog plus incomplete daemon discovery admits local and cloud models in native services', {
  skip: !artifactRoot && 'requires PIE_PROVIDER_RUNTIME_ARTIFACT=<absolute verified runtime root>',
}, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('unexpected network request'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.ok(artifactRoot && path.isAbsolute(artifactRoot));
  const target: PiRuntimeTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target });
  const descriptor: GenerationPiRuntimeDescriptor = { schemaVersion: 1, artifactDir: verified.artifactDir,
    sdkPath: verified.sdkPath, cliPath: path.join(verified.sdkPath, 'dist/cli.js'), identity: verified.identity, manifest: verified.manifest };
  const sdk = await loadSdk(verified.sdkPath, { mode: 'source-artifact', descriptor, backendTarget: target, surface: 'cold' });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-ollama-catalog-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const credentialFile = path.join(temp, 'absent-credentials.json');
  const snapshot = captureProviderRuntimeProjection({
    config: { version: 1, providers: { ollama: { enabled: true, api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1', credentialRef: { source: 'none' } } } },
    configRevision: `sha256:${'a'.repeat(64)}`, legacyModels: [], shippedCatalog: approvedShippedRuntimeCatalog(),
    // Same facts as the captured daemon listing: no request limits for either identity,
    // and no prices or capabilities for the known cloud alias.
    discovered: { ollama: { kind: 'account', complete: true, freshness: 'stale', models: {
      'qwen3.5:9b': { name: 'qwen3.5:9b', input: ['text', 'image'], reasoning: true,
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      'qwen3.5:cloud': { name: 'qwen3.5:cloud', execution: 'remote' },
      'gemma4:cloud': { name: 'gemma4:cloud', execution: 'remote', input: ['text', 'image'], reasoning: true },
    } } },
  })!;
  const unavailable = () => { throw new Error('must not consult credentials for none policy'); };
  const cold = availableProviderRuntimeModels(snapshot, { credentialFile, savedCredential: unavailable,
    legacyHasAuth: unavailable, defaultHasAuth: unavailable });
  const services = createProviderRuntimeServices(sdk as unknown as SdkModule, snapshot, sdk.AuthStorage.inMemory!(), { credentialFile });
  for (const id of ['qwen3.5:9b', 'qwen3.5:cloud']) {
    const row = snapshot.models.find(row => row.providerId === 'ollama' && row.id === id)!;
    assert.equal(row.rejection, undefined);
    assert.equal(row.credential.source, 'none');
    assert.ok(cold.some(model => model.provider === 'ollama' && model.id === id));
    const model = services.modelRegistry.getAvailable().find(model => model.provider === 'ollama' && model.id === id)!;
    assert.ok(model);
    assert.equal(model.baseUrl, 'http://localhost:11434/v1');
    assert.equal(model.api, 'openai-completions');
    const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
    assert.equal(auth.ok, true);
    assert.ok(auth.ok);
    assert.equal(auth.apiKey, 'unused');
    assert.equal(auth.headers, undefined);
    assert.equal(auth.env, undefined);
  }
  assert.equal(services.modelRegistry.find('ollama', 'gemma4:cloud'), undefined);
});
