import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { currentProviderSelectorSnapshot } from '../selector-policy';
import { availableProviderRuntimeModels } from '../services';
import { projectProviderRuntimeModels } from '../model-info';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProviderRuntimeProjection } from '../projection';
import { createProviderRuntimeServices, assertProviderRuntimeModel, type ProviderRuntimeAuthStorage } from '../services';
import { buildProviderRuntimePricingFacts } from '../pricing-facts';
import { resolveCapturedInvocationPricing } from '../../pricing/captured-invocation-pricing';
import { createPiProviderAuth } from '../../management/pi-auth';
import { readProviderRuntimeProjection, saveProviderRuntimeProjection } from '../store';
import type { NativeRuntimeModel } from '../contracts';
import type { StagedProviderCredential } from '../../management/auth-port';
import type { SdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';

test('native configured auth admits entryless legacy providers only', () => {
  const fixture = syntheticSdk();
  fixture.legacy.hasAuth = () => false;
  const models = ['ollama', 'unauthenticated', 'managed'].map(provider => ({ ...native, provider }));
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
    managed: { enabled: true, credentialRef: { source: 'none' } },
  } }, configRevision: canonicalRevision('configured-auth'), legacyModels: models, builtinModels: models })!;
  (fixture.sdk.ModelRegistry as any).create = () => ({
    hasConfiguredAuth: (model: NativeRuntimeModel) => model.provider === 'ollama',
    getError: () => undefined,
    getApiKeyAndHeaders() { throw new Error('Admission must not resolve credentials'); },
  });
  const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, {
    credentialFile: unopenedCredentialFile, legacyModelsFile: 'private-models.json',
  });
  assert.deepEqual(services.modelRegistry.getAvailable().map(model => model.provider).sort(), ['managed', 'ollama']);
  assert.equal(services.modelRegistry.hasConfiguredAuth(models[0]), true);
  assert.equal(services.modelRegistry.hasConfiguredAuth(models[1]), false);
  assert.equal(services.modelRegistry.hasConfiguredAuth(models[2]), true);
  assert.deepEqual(availableProviderRuntimeModels(snapshot, {
    credentialFile: unopenedCredentialFile, savedCredential: () => undefined,
    legacyHasAuth: (_id, model) => model.provider === 'ollama', defaultHasAuth: () => false,
  }).map(model => model.provider).sort(), ['managed', 'ollama']);
});

test('live explicit removal blocks captured keyless and legacy auth without deleting definitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-live-removal-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  try {
    const fixture = syntheticSdk();
    const models = ['local', 'legacy', 'default'].map(provider => ({ ...native, provider }));
    const snapshot = captureProviderRuntimeProjection({ configRevision: canonicalRevision('removal'), legacyModels: models, builtinModels: models,
      config: { version: 1, providers: { local: { enabled: true, credentialRef: { source: 'none' } }, default: { enabled: true } } } })!;
    const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: unopenedCredentialFile });
    const before = services.modelRegistry.getAll();
    for (const removed of [true, false]) {
      await writeFile(join(dir, 'providers.yaml'), JSON.stringify({ version: 1, providers: Object.fromEntries(models.map(model => [model.provider, { enabled: false, ...(removed ? { removed: true } : {}) }])) }));
      assert.deepEqual(services.modelRegistry.getAll(), before);
      assert.equal(services.modelRegistry.getAvailable().length, removed ? 0 : 3);
      const { projectRegistryModels, loadConfiguredModels } = await import('../../catalog/model-catalog');
      assert.equal(projectRegistryModels(models as never).length, removed ? 0 : 3);
      await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: Object.fromEntries(models.map(model => [model.provider, { models: [model] }])) }));
      const catalog = await loadConfiguredModels(dir);
      assert.equal(catalog.ok, true);
      assert.equal(catalog.models.length, removed ? 0 : 3);
      for (const model of models) {
        assert.ok(services.modelRegistry.find(model.provider, model.id));
        assert.equal(services.authStorage.hasAuth(model.provider), !removed);
        assert.equal(services.authStorage.getAuthStatus(model.provider).configured, !removed);
        assert.equal(services.modelRegistry.hasConfiguredAuth(model), !removed);
        assert.equal((await services.modelRegistry.getApiKeyAndHeaders(model)).ok, !removed);
        if (removed) {
          await assert.rejects(services.authStorage.getApiKey(model.provider));
          assert.throws(() => assertProviderRuntimeModel(snapshot, model.provider, model.id));
          assert.equal(services.modelRegistry.isModelEligibleForSubagent!(model.provider, model.id), false);
        } else assert.ok(assertProviderRuntimeModel(snapshot, model.provider, model.id));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

const canonicalRevision = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const unopenedCredentialFile = join(tmpdir(), `pie-unopened-credentials-${process.pid}.json`);
const native: NativeRuntimeModel = { provider: 'saved', id: 'same', name: 'Captured', api: 'openai-completions', baseUrl: 'https://captured.example/v1', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
function syntheticSdk() {
  const central = new Map<string, StagedProviderCredential>();
  let legacyCalls = 0;
  let refreshes = 0;
  const auth = (saved: boolean) => ({
    getOAuthProviders: () => [{ id: 'saved', name: 'Saved', modifyModels: (models: NativeRuntimeModel[]) => models.map(model => ({ ...model, baseUrl: 'https://account.example/v1' })) }],
    get: (id: string) => saved ? central.get(id) : undefined,
    list: () => [...central.keys()],
    setAsync: async (id: string, value: StagedProviderCredential) => { assert.ok(saved); central.set(id, value); },
    removeAsync: async (id: string) => { central.delete(id); },
    drainErrors: () => [], login: async () => {}, reload() {},
    hasAuth: (id: string) => saved ? central.has(id) : id === 'default',
    getAuthStatus: () => ({ configured: true }),
    getProviderEnv: () => undefined,
    async getApiKey(id: string, opts?: { includeFallback?: boolean }) {
      if (!saved) return opts?.includeFallback === false ? undefined : id === 'default' ? 'native-environment-key' : undefined;
      const credential = central.get(id);
      if (credential?.type === 'api_key') return credential.key;
      if (credential?.type === 'oauth') {
        refreshes++;
        central.set(id, { ...credential, access: 'fresh-access' });
        return 'native-oauth-key';
      }
      return undefined;
    },
  });
  const sdk = {
    AuthStorage: { inMemory: () => auth(false), create: () => auth(true), createAsync: async () => auth(true) },
    ModelRegistry: { inMemory: (authStorage: ProviderRuntimeAuthStorage) => ({
      authStorage, find: () => native, getAll: () => [native], getAvailable: () => [native],
      refresh: () => { throw new Error('native refresh must never change the capture'); }, getError: () => undefined,
      async getApiKeyAndHeaders(model: NativeRuntimeModel) {
        return { ok: true, apiKey: await authStorage.getApiKey(model.provider, { includeFallback: false }),
          headers: { 'native-header': model.baseUrl } };
      },
    }) },
  } as unknown as SdkModule;
  const legacy = { ...auth(false), getApiKey: async () => { legacyCalls++; return 'legacy-key'; }, hasAuth: () => true };
  return { sdk, central, legacy, legacyCalls: () => legacyCalls, refreshes: () => refreshes };
}

test('saved capture: scoped central native auth, refresh retains epoch, reconnect rejects old capture with no legacy/env fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-services-'));
  try {
    const fixture = syntheticSdk();
    const credentialFile = join(dir, 'managed.json');
    const auth = createPiProviderAuth(fixture.sdk.AuthStorage as never, credentialFile);
    await auth.saveCredential('saved', { type: 'oauth', access: 'private', refresh: 'private', expires: 0 });
    const scope = await auth.getRuntimeCredentialScope!('saved');
    const adjusted = await auth.runtimeModels!('saved', [native]);
    const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: { saved: { enabled: true, credentialRef: { source: 'saved' } } } }, configRevision: canonicalRevision('saved-capture'), legacyModels: adjusted, builtinModels: [native], credentialScopes: { saved: scope } })!;
    const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile });
    const model = services.modelRegistry.find('saved', 'same')!;
    assert.equal(model.baseUrl, 'https://account.example/v1');
    assert.ok(Object.isFrozen(model));
    const result = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'saved', id: 'same' });
    assert.deepEqual(result, { ok: true, apiKey: 'native-oauth-key', headers: { 'native-header': 'https://account.example/v1' } });
    assert.equal(fixture.refreshes(), 1);
    assert.equal(await auth.getRuntimeCredentialScope!('saved'), scope);
    assert.equal(services.modelRegistry.isUsingOAuth(model), true);
    await auth.saveCredential('saved', { type: 'api_key', key: 'replacement' });
    assert.equal(services.modelRegistry.getAvailable().length, 0);
    const stale = await services.modelRegistry.getApiKeyAndHeaders(model);
    assert.equal(stale.ok, false);
    assert.equal(fixture.legacyCalls(), 0);
    const next = captureProviderRuntimeProjection({ config: { version: 1, providers: { saved: { enabled: true, credentialRef: { source: 'saved' } } } }, configRevision: canonicalRevision('saved-next'), legacyModels: [native], builtinModels: [native], credentialScopes: { saved: await auth.getRuntimeCredentialScope!('saved') } })!;
    const fresh = createProviderRuntimeServices(fixture.sdk, next, fixture.legacy, { credentialFile });
    assert.equal(await fresh.authStorage.getApiKey('saved'), 'replacement');
    const missing = captureProviderRuntimeProjection({ config: { version: 1, providers: { saved: { enabled: true, credentialRef: { source: 'saved' } } } }, configRevision: canonicalRevision('saved-no-scope'), legacyModels: [native], builtinModels: [native] })!;
    const closed = createProviderRuntimeServices(fixture.sdk, missing, fixture.legacy, { credentialFile });
    await assert.rejects(closed.authStorage.getApiKey('saved'), /authentication is unavailable/);
    assert.equal(fixture.legacyCalls(), 0);
    const ref = await saveProviderRuntimeProjection(dir, snapshot);
    assert.deepEqual(await readProviderRuntimeProjection(dir, ref), snapshot);
    assert.ok(!JSON.stringify(snapshot).includes('private'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('immutable masks: hidden dispatch allowed; disabled, unsupported and unpriced fail closed; local none never saved lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-services-'));
  // getAvailable() applies live selector policy from the provider config dir; pin it
  // to the private fixture so assertions stay independent of the real profile.
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  try {
    const fixture = syntheticSdk();
    fixture.central.set('local', { type: 'api_key', key: 'must-not-be-used' });
    const models = ['local', 'disabled', 'hidden', 'default', 'unmanaged', 'unpriced'].map(provider => ({ ...native, provider }));
    const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
      local: { enabled: true, credentialRef: { source: 'none' } },
      disabled: { enabled: false, credentialRef: { source: 'none' } },
      hidden: { enabled: true, credentialRef: { source: 'none' }, modelPreferences: { same: { visible: false, subagentEligible: false } } },
      default: { enabled: true }, unpriced: { enabled: true, modelOverrides: { same: { pricing: 'unknown' } } },
    } }, configRevision: canonicalRevision('immutable-masks'), legacyModels: models, builtinModels: models })!;
    const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: join(dir, 'managed.json') });
    assert.equal(await services.authStorage.getApiKey('local'), 'unused');
    assert.equal(services.authStorage.get('local'), undefined);
    assert.equal(await services.authStorage.getApiKey('default', { includeFallback: false }), 'native-environment-key');
    assert.equal(await services.authStorage.getApiKey('unmanaged'), 'legacy-key');
    assert.equal(fixture.legacyCalls(), 1);
    assert.ok(services.modelRegistry.find('hidden', 'same'));
    assert.ok(!services.modelRegistry.getAvailable().some(model => model.provider === 'hidden'));
    assert.ok(services.modelRegistry.getAll().some(model => model.provider === 'hidden'));
    for (const provider of ['disabled', 'unpriced', 'missing']) {
      assert.equal(services.modelRegistry.find(provider, 'same'), undefined);
      assert.equal((await services.modelRegistry.getApiKeyAndHeaders({ provider, id: 'same' })).ok, false);
    }
    assert.throws(() => assertProviderRuntimeModel(snapshot, 'hidden', 'same', { subagent: true }));
    assert.ok(assertProviderRuntimeModel(snapshot, 'hidden', 'same'));
    const before = services.modelRegistry.getAll();
    services.modelRegistry.refresh();
    assert.deepEqual(services.modelRegistry.getAll(), before);
  } finally {
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR;
    else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('raw native auth false does not make an otherwise eligible captured model ineligible', () => {
  const raw = { ...native, provider: 'raw-no-auth' };
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
    'raw-no-auth': { enabled: true },
  } }, configRevision: canonicalRevision('raw-no-auth-eligibility'), legacyModels: [raw], builtinModels: [raw] })!;
  const fixture = syntheticSdk();
  const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: unopenedCredentialFile });
  assert.equal(services.authStorage.hasAuth('raw-no-auth'), false);
  assert.equal(services.modelRegistry.isModelEligibleForSubagent?.('raw-no-auth', 'same'), true);
  assert.ok(!services.modelRegistry.getAvailable().some(model => model.provider === 'raw-no-auth'));
});

test('subagent-ineligible captured models remain directly findable but fail the provider-qualified eligibility predicate', () => {
  const ineligible = { ...native, provider: 'default' };
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
    default: { enabled: true, modelPreferences: { same: { visible: true, subagentEligible: false } } },
  } }, configRevision: canonicalRevision('eligibility'), legacyModels: [ineligible], builtinModels: [ineligible] })!;
  const fixture = syntheticSdk();
  const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: join(tmpdir(), `pie-eligibility-${process.pid}.json`) });
  assert.equal(services.modelRegistry.find('default', 'same')?.provider, 'default');
  assert.ok(services.modelRegistry.getAll().some(model => model.provider === 'default' && model.id === 'same'));
  assert.ok(services.modelRegistry.getAvailable().some(model => model.provider === 'default' && model.id === 'same'));
  assert.equal(services.modelRegistry.isModelEligibleForSubagent?.('default', 'same'), false);
  assert.equal(services.modelRegistry.isModelEligibleForSubagent?.('default', 'unknown'), false);
});

test('native Codex protocol/compat retained, generic unknown protocol rejected; exact complete pricing facts and qualified rates', () => {
  const codex = { ...native, provider: 'openai-codex', api: 'openai-codex-responses', compat: { supportsStore: false }, thinkingLevelMap: { high: 'high' } };
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
    custom: { enabled: true, api: 'openai-codex-responses', baseUrl: 'https://custom.example', manualModels: ['new'], modelOverrides: { new: { input: ['text'], reasoning: false, contextWindow: 100, maxTokens: 10, pricing: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } } },
  } }, configRevision: canonicalRevision('pricing-facts'), legacyModels: [codex, native, { ...native, provider: 'another', cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 } }] })!;
  assert.equal(snapshot.models.find(row => row.providerId === 'custom')?.model, undefined);
  assert.equal(snapshot.models.find(row => row.providerId === 'openai-codex')?.model?.api, 'openai-codex-responses');
  assert.deepEqual(snapshot.models.find(row => row.providerId === 'openai-codex')?.model?.compat, codex.compat);
  const facts = buildProviderRuntimePricingFacts(snapshot);
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(resolveCapturedInvocationPricing({ facts, provider: 'saved', modelId: 'same', usage })?.calculatedCostUsd, 1);
  assert.equal(resolveCapturedInvocationPricing({ facts, provider: 'another', modelId: 'another/same', usage })?.calculatedCostUsd, 9);
  assert.equal(resolveCapturedInvocationPricing({ facts, provider: 'missing', modelId: 'same', usage }), undefined);
  assert.equal(resolveCapturedInvocationPricing({ facts, provider: undefined, modelId: 'same', usage }), undefined);
  assert.equal(facts.catalogVersion, canonicalRevision(JSON.stringify(snapshot)));
  assert.equal((facts.map as unknown as { set?: unknown }).set, undefined);
  assert.ok(Object.isFrozen(facts.map.get('same')));
  // Credential-bearing native model headers cannot cross the snapshot DTO; never
  // silently dispatch such a model without its native request requirements.
  const headerBaseline = { ...native, headers: { Authorization: 'private-secret' } };
  const rejected = captureProviderRuntimeProjection({ config: { version: 1, providers: {} }, configRevision: canonicalRevision('headers'), legacyModels: [headerBaseline] })!;
  assert.equal(rejected.models[0].model, undefined);
  assert.ok(!JSON.stringify(rejected).includes('private-secret'));
  const tiered = captureProviderRuntimeProjection({ config: { version: 1, providers: {} }, configRevision: canonicalRevision('tiers'), legacyModels: [{ ...native, cost: { ...native.cost, tiers: [] } }] })!;
  assert.equal(tiered.models[0].model, undefined);
});

test('late native provider registration cannot change captured request headers or scoped auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-services-registration-'));
  try {
    const builtin = { ...native, headers: { 'Editor-Version': 'compiled-editor/1' } };
    const registrations = new WeakMap<object, Map<string, Record<string, unknown>>>();
    const registries: Array<{ registerProvider(provider: string, config: Record<string, unknown>): void }> = [];
    const fixture = syntheticSdk();
    fixture.sdk.ModelRegistry.inMemory = (authStorage: ProviderRuntimeAuthStorage) => {
      const providers = new Map<string, Record<string, unknown>>();
      const registry = {
        authStorage,
        find: () => builtin,
        getAll: () => [builtin],
        getAvailable: () => [builtin],
        refresh() {},
        getError: () => undefined,
        registerProvider(provider: string, config: Record<string, unknown>) {
          providers.set(provider, { ...config });
        },
        async getApiKeyAndHeaders(model: NativeRuntimeModel) {
          const config = providers.get(model.provider);
          const headers = { ...model.headers, ...(config?.headers as Record<string, string> | undefined) };
          return { ok: true, apiKey: await authStorage.getApiKey(model.provider), headers };
        },
      };
      registrations.set(registry, providers);
      registries.push(registry);
      return registry;
    };
    fixture.sdk.getProviderRuntimeBuiltinModel = () => builtin;
    const auth = createPiProviderAuth(fixture.sdk.AuthStorage as never, join(dir, 'managed.json'));
    await auth.saveCredential('saved', { type: 'api_key', key: 'captured-scope-key' });
    const scope = await auth.getRuntimeCredentialScope!('saved');
    const snapshot = captureProviderRuntimeProjection({
      config: { version: 1, providers: { saved: { enabled: true, credentialRef: { source: 'saved' } } } },
      configRevision: canonicalRevision('late-native-registration'),
      legacyModels: [builtin], builtinModels: [builtin], credentialScopes: { saved: scope },
    })!;
    assert.ok(snapshot.models[0].builtinHeaders);
    assert.equal(snapshot.models[0].model?.headers, undefined);
    assert.ok(!JSON.stringify(snapshot).includes('compiled-editor/1'));
    assert.ok(!JSON.stringify(snapshot).includes('mutable-secret'));

    const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: join(dir, 'managed.json') });
    assert.equal(registries.length, 2);
    assert.notEqual(registrations.get(registries[0]), registrations.get(registries[1]));
    // A late dynamic API registration mutates the exposed registry's native provider config.
    registries[0].registerProvider('saved', { headers: { Authorization: 'mutable-secret' } });
    assert.deepEqual(registrations.get(registries[0])?.get('saved')?.headers, { Authorization: 'mutable-secret' });

    const model = services.modelRegistry.find('saved', 'same')!;
    assert.deepEqual(model.headers, builtin.headers);
    assert.ok(services.modelRegistry.getAll().some(item => item.provider === 'saved' && item.id === 'same'));
    const result = await services.modelRegistry.getApiKeyAndHeaders(model);
    assert.deepEqual(result, { ok: true, apiKey: 'captured-scope-key', headers: { 'Editor-Version': 'compiled-editor/1' } });
    assert.ok(!JSON.stringify(result).includes('mutable-secret'));
    assert.equal(registrations.get(registries[1])?.has('saved'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compiled static headers require exact proof and are restored privately; SDK replacement fails closed', () => {
  const builtin = { ...native, headers: { 'Editor-Version': 'compiled-editor/1' } };
  const input = { config: { version: 1 as const, providers: {} }, configRevision: canonicalRevision('builtin-headers'), legacyModels: [builtin], builtinModels: [builtin] };
  const snapshot = captureProviderRuntimeProjection(input)!;
  assert.ok(snapshot.models[0].model);
  assert.ok(snapshot.models[0].builtinHeaders);
  assert.equal(JSON.stringify(snapshot).includes('compiled-editor/1'), false);
  assert.equal(snapshot.models[0].model!.headers, undefined);
  const fixture = syntheticSdk();
  fixture.sdk.getProviderRuntimeBuiltinModel = () => builtin;
  const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: unopenedCredentialFile });
  assert.deepEqual(services.modelRegistry.find(native.provider, native.id)!.headers, builtin.headers);
  assert.deepEqual(services.modelRegistry.getAll()[0].headers, builtin.headers);
  assert.equal(typeof services.authStorage.hasAuth(native.provider), 'boolean');
  assert.deepEqual(Object.keys(services.authStorage.getAll()), []);
  const secret = captureProviderRuntimeProjection({ ...input, legacyModels: [{ ...builtin, headers: { Authorization: 'secret' } }] })!;
  assert.equal(secret.models[0].model, undefined);
  assert.equal(JSON.stringify(secret).includes('secret'), false);
  fixture.sdk.getProviderRuntimeBuiltinModel = () => ({ ...builtin, headers: { 'Editor-Version': 'compiled-editor/2' } });
  assert.throws(() => createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, { credentialFile: unopenedCredentialFile }), /definition is unavailable or changed/);
});

test('legacy request resolution stays private and provider-qualified managed models bypass legacy request headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-services-legacy-request-'));
  try {
    const fixture = syntheticSdk();
    const credentialFile = join(dir, 'managed.json');
    const fakeLegacyModelsFile = join(dir, 'unread-models.json');
    const privateLegacyHeaders = { Authorization: 'private-legacy-header' };
    let legacyRequestCalls = 0;
    fixture.sdk.ModelRegistry.create = (_authStorage: unknown, modelsFile: string) => {
      assert.equal(modelsFile, fakeLegacyModelsFile);
      return {
        getError: () => undefined,
        async getApiKeyAndHeaders() {
          legacyRequestCalls++;
          return { ok: true, apiKey: 'private-legacy-api-key', headers: privateLegacyHeaders };
        },
      } as never;
    };
    const auth = createPiProviderAuth(fixture.sdk.AuthStorage as never, credentialFile);
    await auth.saveCredential('managed', { type: 'api_key', key: 'managed-captured-api-key' });
    const scope = await auth.getRuntimeCredentialScope!('managed');
    const legacyModel = { ...native, provider: 'legacy-private', name: 'Legacy private request' };
    const managedModel = { ...native, provider: 'managed', name: 'Managed captured request' };
    const snapshot = captureProviderRuntimeProjection({
      config: { version: 1, providers: { managed: { enabled: true, credentialRef: { source: 'saved' } } } },
      configRevision: canonicalRevision('legacy-private-request'),
      legacyModels: [legacyModel, managedModel], builtinModels: [managedModel],
      credentialScopes: { managed: scope },
    })!;
    assert.ok(!snapshot.models.some(row => row.model?.headers));
    assert.ok(!JSON.stringify(snapshot).includes('private-legacy-header'));
    const services = createProviderRuntimeServices(fixture.sdk, snapshot, fixture.legacy, {
      credentialFile, legacyModelsFile: fakeLegacyModelsFile,
    });

    const legacyResult = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'legacy-private', id: 'same' });
    assert.deepEqual(legacyResult, { ok: true, apiKey: 'private-legacy-api-key', headers: privateLegacyHeaders });
    const managedResult = await services.modelRegistry.getApiKeyAndHeaders({ provider: 'managed', id: 'same' });
    assert.deepEqual(managedResult, {
      ok: true, apiKey: 'managed-captured-api-key', headers: { 'native-header': managedModel.baseUrl },
    });
    assert.equal(legacyRequestCalls, 1);
    assert.deepEqual(services.modelRegistry.getAll().map(model => [model.provider, model.id]), [
      ['legacy-private', 'same'], ['managed', 'same'],
    ]);
    assert.deepEqual(services.modelRegistry.getAll().map(model => model.headers), [undefined, undefined]);
    assert.deepEqual(Object.keys(services.authStorage.getAll()), ['managed']);
    const publicRows = JSON.stringify(services.modelRegistry.getAll());
    for (const privateValue of ['private-legacy-header', 'private-legacy-api-key', 'managed-captured-api-key']) {
      assert.equal(publicRows.includes(privateValue), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cold and hot selectors apply live visibility without replacing pinned runtime models', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-selector-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  try {
    const { sdk, legacy } = syntheticSdk();
    const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {
      a: { enabled: true, credentialRef: { source: 'legacy' }, modelPreferences: { same: { visible: false } } },
      b: { enabled: true, credentialRef: { source: 'legacy' } },
    } }, configRevision: canonicalRevision('selector'), legacyModels: ['a', 'b'].map(provider => ({ ...native, provider })) })!;
    const services = await createProviderRuntimeServices(sdk, snapshot, legacy, { credentialFile: join(dir, 'credentials.json') });
    const pinned = services.modelRegistry.find('a', 'same');
    const compare = (expected: string[]) => {
      const current = currentProviderSelectorSnapshot(snapshot);
      const cold = availableProviderRuntimeModels(current, { credentialFile: join(dir, 'credentials.json'), savedCredential: () => undefined,
        legacyHasAuth: () => true, defaultHasAuth: () => false });
      assert.deepEqual(projectProviderRuntimeModels(current, cold).map(model => model.provider), expected);
      assert.deepEqual(projectProviderRuntimeModels(current, services.modelRegistry.getAvailable()).map(model => model.provider), expected);
      assert.equal(services.modelRegistry.find('a', 'same'), pinned);
    };
    compare(['b']);
    await writeFile(join(dir, 'providers.yaml'), 'version: 1\nproviders:\n  a:\n    enabled: false\n    modelPreferences:\n      same: { visible: true }\n  b:\n    enabled: true\n    modelPreferences:\n      same: { visible: false }\n');
    compare(['a']);
    await writeFile(join(dir, 'providers.yaml'), 'version: 1\nproviders: {}\n');
    compare(['a', 'b']);
    assert.equal(snapshot.models[0].visible, false);
  } finally {
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR;
    else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
