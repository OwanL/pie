import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  verifyPiRuntimeArtifact,
  type GenerationPiRuntimeDescriptor,
  type PiRuntimeTarget,
} from '../../../../lib/pi-runtime/artifact.mjs';
import { captureProviderRuntimeProjection } from '../projection';
import { createProviderRuntimeServices } from '../services';
import { readProviderRuntimeProjection, saveProviderRuntimeProjection } from '../store';
import { loadSdk, type ColdCoordinatorSdkModule, type SdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';


const artifactRoot = process.env.PIE_PROVIDER_RUNTIME_ARTIFACT;
const target: PiRuntimeTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const revision = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('compiled native provider services preserve scoped auth and static headers across registration and replacement', {
  skip: !artifactRoot && 'requires PIE_PROVIDER_RUNTIME_ARTIFACT=<absolute verified runtime root>',
}, async (t) => {
  assert.ok(artifactRoot && path.isAbsolute(artifactRoot), 'explicitly select an absolute compiled runtime artifact');
  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target });
  const descriptor: GenerationPiRuntimeDescriptor = {
    schemaVersion: 1, artifactDir: verified.artifactDir, sdkPath: verified.sdkPath,
    cliPath: path.join(verified.sdkPath, 'dist/cli.js'), identity: verified.identity, manifest: verified.manifest,
  };
  const sdk = await loadSdk(verified.sdkPath, {
    mode: 'source-artifact', descriptor, backendTarget: target, surface: 'cold',
  }) as ColdCoordinatorSdkModule;
  const fullSdk = sdk as unknown as SdkModule;
  const emptyAuth = sdk.AuthStorage.inMemory!();
  const registry = sdk.ModelRegistry.inMemory!(emptyAuth);
  const copilot = registry.getAll().find(model => model.provider === 'github-copilot' && model.headers && Object.keys(model.headers).length);
  const openai = registry.getAll().find(model => model.provider === 'openai' && model.cost
    && Object.values(model.cost).some(rate => typeof rate === 'number' && rate > 0));
  assert.ok(copilot, 'compiled SDK exposes a header-bearing GitHub Copilot model');
  assert.ok(openai, 'compiled SDK exposes a priced OpenAI model');
  const builtinCopilot = sdk.getProviderRuntimeBuiltinModel!('github-copilot', copilot.id)!;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-native-services-artifact-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const credentialFile = path.join(temp, 'owned-credentials.json');
  const artifactDir = path.join(temp, 'runtime-artifacts');
  const auth = sdk.createProviderManagementAuth!(credentialFile);
  const envName = 'PIE_TEST_CAPTURED_KEY';
  const previousEnv = process.env[envName];
  t.after(() => { if (previousEnv === undefined) delete process.env[envName]; else process.env[envName] = previousEnv; });
  process.env[envName] = 'fake-private-environment-key';
  // Native AuthStorage resolves stored configuration references, not raw strings.
  const savedReference = '${' + envName + '}';
  await auth.saveCredential('github-copilot', { type: 'api_key', key: savedReference });
  // A stored OpenAI key is intentionally excluded by the captured `none` policy.
  await auth.saveCredential('openai', { type: 'api_key', key: 'must-not-fallback' });
  const scope = await auth.getRuntimeCredentialScope!('github-copilot');
  assert.ok(scope);
  const envModel = { ...openai, provider: 'native-env-reference', api: 'openai-completions' };
  const snapshot = captureProviderRuntimeProjection({
    config: { version: 1, providers: {
      'github-copilot': { enabled: true, credentialRef: { source: 'saved' } },
      openai: { enabled: true, credentialRef: { source: 'none' } },
      'native-env-reference': {
        enabled: true, api: 'openai-completions', baseUrl: envModel.baseUrl,
        credentialRef: { source: 'environment', name: envName }, manualModels: [envModel.id],
        modelOverrides: { [envModel.id]: {
          name: envModel.name, input: envModel.input, reasoning: envModel.reasoning,
          contextWindow: envModel.contextWindow, maxTokens: envModel.maxTokens,
          pricing: { ...envModel.cost },
        } },
      },
    } },
    configRevision: revision('native-services-artifact'),
    legacyModels: [builtinCopilot, openai, envModel], builtinModels: [builtinCopilot, openai],
    credentialScopes: { 'github-copilot': scope },
  });
  assert.ok(snapshot);
  const reference = await saveProviderRuntimeProjection(artifactDir, snapshot);
  const loaded = await readProviderRuntimeProjection(artifactDir, reference);
  assert.deepEqual(loaded, snapshot);
  assert.equal(JSON.stringify(loaded).includes(savedReference), false);
  assert.equal(JSON.stringify(loaded).includes('fake-private-environment-key'), false);
  assert.equal(JSON.stringify(loaded).includes(envName), true);
  assert.equal(JSON.stringify(loaded).includes(JSON.stringify(builtinCopilot.headers)), false);

  const legacy = sdk.AuthStorage.inMemory!();
  const services = createProviderRuntimeServices(fullSdk, loaded, legacy, { credentialFile });
  const privateCopilot = services.modelRegistry.find('github-copilot', copilot.id)!;
  assert.deepEqual(privateCopilot.headers, builtinCopilot.headers);
  assert.equal(JSON.stringify(privateCopilot).includes(JSON.stringify(builtinCopilot.headers)), true);
  const publicRows = JSON.stringify(services.modelRegistry.getAll());
  assert.equal(publicRows.includes('fake-private-environment-key'), false);
  assert.equal(JSON.stringify(loaded).includes('fake-private-environment-key'), false);
  const savedResult = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'github-copilot', id: copilot.id });
  assert.equal(savedResult.ok, true);
  if (!savedResult.ok) throw new Error(savedResult.error);
  assert.equal(savedResult.apiKey, 'fake-private-environment-key');
  assert.notEqual(savedResult.apiKey, savedReference);
  assert.deepEqual(savedResult.headers, builtinCopilot.headers);
  assert.notEqual(JSON.stringify(loaded), JSON.stringify(savedResult));
  const noneResult = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'openai', id: openai.id });
  assert.equal(noneResult.ok, true);
  if (noneResult.ok) assert.equal(noneResult.apiKey, 'unused', 'none policy does not fall back to stored credentials');
  const environmentResult = await services.modelRegistry.getApiKeyAndHeaders({ provider: envModel.provider, id: envModel.id });
  assert.equal(environmentResult.ok, true);
  if (environmentResult.ok) assert.equal(environmentResult.apiKey, 'fake-private-environment-key');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('unexpected network request'); }) as typeof fetch;
  try {
    const mutableRegistry = services.modelRegistry as typeof services.modelRegistry & {
      registerProvider?: (provider: string, config: Record<string, unknown>) => void;
    };
    assert.equal(typeof mutableRegistry.registerProvider, 'function', 'native registry exposes provider registration');
    mutableRegistry.registerProvider!('github-copilot', { baseUrl: 'https://attacker.invalid/v1', api: 'openai-completions', headers: { Authorization: 'public-override' }, apiKey: 'public-override' });
    const afterRegistration = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'github-copilot', id: copilot.id });
    assert.deepEqual(afterRegistration, savedResult, 'late public registration cannot replace private captured auth');

    await auth.saveCredential('github-copilot', { type: 'api_key', key: 'replacement-private-key' });
    assert.equal((await services.modelRegistry.getApiKeyAndHeaders({ provider: 'github-copilot', id: copilot.id })).ok, false,
      'replacement invalidates the captured credential scope');
    const nextScope = await auth.getRuntimeCredentialScope!('github-copilot');
    const nextSnapshot = captureProviderRuntimeProjection({
      config: { version: 1, providers: { 'github-copilot': { enabled: true, credentialRef: { source: 'saved' } } } },
      configRevision: revision('native-services-artifact-replacement'), legacyModels: [builtinCopilot], builtinModels: [builtinCopilot],
      credentialScopes: { 'github-copilot': nextScope },
    })!;
    const next = createProviderRuntimeServices(fullSdk, nextSnapshot, legacy, { credentialFile });
    const nextResult = await next.modelRegistry.getApiKeyAndHeaders({ provider: 'github-copilot', id: copilot.id });
    assert.equal(nextResult.ok, true);
    if (nextResult.ok) assert.equal(nextResult.apiKey, 'replacement-private-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
