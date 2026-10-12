import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinatorProviderManagement, hasCoordinatorProviderConfiguration } from '../provider-management';
import type { ColdCoordinatorSdkModule } from '../../lib/sdk-integration/sdk';
import { createProviderManagementService } from '../../../model-providers/management/service';
import { readProviderRuntimeReference } from '../../../model-providers/runtime';
import type { NativeRuntimeModel, RuntimeEntryManager } from '../../../model-providers/runtime';
import type { ProviderManagementAuthPort } from '../../../model-providers/management/auth-port';

const native: NativeRuntimeModel = {
  provider: 'openai', id: 'gpt-test', name: 'Native GPT', api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1', input: ['text'], reasoning: false,
  contextWindow: 8192, maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
  headers: { authorization: 'Bearer SYNTHETIC_STATIC_HEADER' },
};

const config = (visible: boolean, price?: number) => `version: 1\nproviders:\n  openai:\n    enabled: true\n    credentialRef:\n      source: none\n    modelPreferences:\n      gpt-test:\n        visible: ${visible}\n        subagentEligible: false\n${price === undefined ? '' : `    modelOverrides:\n      gpt-test:\n        pricing:\n          input: ${price}\n          output: 2\n          cacheRead: 0.5\n          cacheWrite: 0.25\n`}`;

function makeSdk(counters: { authConstructors: number; builtinReads: number; authEffects: number }) {
  const auth: ProviderManagementAuthPort = {
    definitions: () => [{ id: 'openai', name: 'OpenAI', kind: 'openai', api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1', authMethods: [], discovery: 'openai' }],
    hasSavedCredential: () => { counters.authEffects++; throw new Error('unexpected auth read'); },
    stageOAuthLogin: async () => { counters.authEffects++; throw new Error('unexpected auth effect'); },
    saveCredential: async () => { counters.authEffects++; throw new Error('unexpected auth effect'); },
    getApiKey: async () => { counters.authEffects++; throw new Error('unexpected auth read'); },
    discoveryBaseUrl: async () => { counters.authEffects++; throw new Error('unexpected auth read'); },
  };
  return {
    createProviderManagementAuth: () => { counters.authConstructors++; return auth; },
    getProviderRuntimeBuiltinModel: (provider: string, id: string) => {
      counters.builtinReads++;
      return provider === native.provider && id === native.id ? structuredClone(native) : undefined;
    },
  } as unknown as ColdCoordinatorSdkModule;
}

test('coordinator runtime capture is SDK-free, durable and immutable across config changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pie-coordinator-provider-runtime-'));
  const configDir = join(root, 'configuration');
  const dataDir = join(root, 'data');
  await mkdir(configDir, { recursive: true });
  const envNames = ['PIE_PROVIDER_CONFIG_DIR', 'PIE_DATA_DIR'] as const;
  const prior = new Map(envNames.map(name => [name, process.env[name]]));
  process.env.PIE_PROVIDER_CONFIG_DIR = configDir;
  process.env.PIE_DATA_DIR = dataDir;
  const counters = { authConstructors: 0, builtinReads: 0, authEffects: 0 };
  const sdk = makeSdk(counters);
  let manager: Awaited<ReturnType<typeof createCoordinatorProviderManagement>> | undefined;
  try {
    assert.equal(await hasCoordinatorProviderConfiguration(), false);
    // The service's missing-config path must not invoke its builtin-model supplier.
    const pureService = createProviderManagementService({ configFile: join(configDir, 'providers.yaml'),
      modelCacheDir: join(dataDir, 'cache', 'provider-models'), auth: {
        definitions: () => [], hasSavedCredential: () => { counters.authEffects++; throw new Error('unexpected auth read'); },
        stageOAuthLogin: async () => { counters.authEffects++; throw new Error('unexpected auth effect'); },
        saveCredential: async () => { counters.authEffects++; throw new Error('unexpected auth effect'); },
        getApiKey: async () => { counters.authEffects++; throw new Error('unexpected auth read'); },
        discoveryBaseUrl: async () => { counters.authEffects++; throw new Error('unexpected auth read'); },
      } });
    try {
      assert.equal(await pureService.captureRuntimeProjection([native], () => {
        counters.builtinReads++;
        throw new Error('builtin model callback must not run for missing configuration');
      }), undefined);
    } finally { pureService.dispose(); }
    assert.equal(counters.authConstructors, 0);
    assert.equal(counters.authEffects, 0);

    await writeFile(join(configDir, 'providers.yaml'), config(false));
    assert.equal(await hasCoordinatorProviderConfiguration(), true);
    manager = await createCoordinatorProviderManagement(sdk, () => { throw new Error('capture must not publish management state'); });
    const reference = await manager.captureRuntimeProjection([native]);
    assert.ok(reference);
    assert.equal(counters.builtinReads, 1);
    assert.equal(counters.authEffects, 0);

    const location = manager.runtimeLocation(reference);
    assert.equal(location.artifactDir, join(configDir, 'provider-runtime'));
    assert.notEqual(location.artifactDir, join(dataDir, 'cache', 'provider-models'));
    const first = await manager.readRuntimeProjection(reference);
    assert.ok(first);
    const row = first.models.find(model => model.id === native.id)!;
    assert.equal(row.visible, false);
    assert.equal(row.subagentEligible, false);
    assert.deepEqual(row.model?.cost, native.cost);
    assert.equal(row.builtinHeaders?.provider, native.provider);
    assert.equal(row.builtinHeaders?.id, native.id);
    assert.match(row.builtinHeaders?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal('headers' in (row.model ?? {}), false);
    const artifactText = await readFile(join(location.artifactDir, `${reference.sha256}.json`), 'utf8');
    assert.equal(artifactText.includes('SYNTHETIC_STATIC_HEADER'), false);
    assert.equal(artifactText.includes('authorization'), false);

    const entries: { type: string; customType?: string; data?: unknown }[] = [];
    const entryManager: RuntimeEntryManager = {
      getEntries: () => entries,
      appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    };
    entryManager.appendCustomEntry('pie-provider-runtime-v1', reference);
    assert.deepEqual(readProviderRuntimeReference(entryManager), reference);

    await writeFile(join(configDir, 'providers.yaml'), config(true, 9));
    const nextReference = await manager.captureRuntimeProjection([native]);
    assert.ok(nextReference);
    assert.notDeepEqual(nextReference, reference);
    assert.deepEqual(await manager.readRuntimeProjection(reference), first);
    assert.equal((await manager.readRuntimeProjection(nextReference))?.models[0].visible, true);
    assert.equal(counters.authEffects, 0);

    await rm(join(configDir, 'providers.yaml'));
    assert.equal(await hasCoordinatorProviderConfiguration(), false);
    assert.equal(await manager.captureRuntimeProjection([native]), undefined);
  } finally {
    manager?.dispose();
    for (const name of envNames) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
