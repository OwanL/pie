import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { WorkerRuntimeHost, type WorkerRuntimePromotionPayload } from '../worker-runtime-host';
import { loadSdk, type SdkModule } from '../../lib/sdk-integration/sdk';
import { verifyPiRuntimeArtifact, type GenerationPiRuntimeDescriptor, type PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection';
import { saveProviderRuntimeProjection, type RuntimeSnapshot } from '../../../model-providers/runtime/index';
import type { ProviderRuntimeAuthStorage, ProviderRuntimeModelRegistry } from '../../../model-providers/runtime/services';

const revision = `sha256:${createHash('sha256').update('integration').digest('hex')}`;
const snapshot: RuntimeSnapshot = { version: 1, configRevision: revision, models: [{
  providerId: 'local', id: 'm', enabled: true, visible: true, subagentEligible: true,
  credential: { source: 'none' }, model: { provider: 'local', id: 'm', name: 'Captured',
    api: 'openai-completions', baseUrl: 'https://invalid.example', input: ['text'], reasoning: false,
    contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
}] };
class FakeSdkAuthStorage implements ProviderRuntimeAuthStorage {
  constructor(readonly secret = false) {}
  reload() {}
  get() { return undefined; }
  getAll() { return {}; }
  getProviderEnv() { return undefined; }
  getOAuthProviders() { return []; }
  async getApiKey() { return this.secret ? 'old-secret' : undefined; }
  hasAuth() { return this.secret; }
  getAuthStatus() { return { configured: this.secret }; }
  drainErrors() { return []; }
}
function fixture(dir: string, sessionPath: string, nativeSessionManager?: SdkModule['SessionManager']) {
  const sdkPath = join(dir, 'synthetic-sdk');
  const sdkRuntime = createSyntheticSourceTestSdkRuntime(sdkPath);
  const rootAuth = new FakeSdkAuthStorage(true);
  let globalModel = structuredClone(snapshot.models[0].model!);
  const calls: Array<Record<string, unknown>> = [];
  let factoryCalls = 0;
  let factory: (args: any) => Promise<any>;
  let currentServices: any;
  const manager = (file: string) => ({ getSessionFile: () => file, getCwd: () => dir,
    getSessionId: () => 'fake', getBranch: () => [], getEntries: () => [],
    buildSessionContext: () => ({ messages: [] }), setPieWriteLease() {}, revokePieWriteLease() {} });
  const registry = (authStorage: ProviderRuntimeAuthStorage) => ({ authStorage,
    find: () => globalModel, getAll: () => [globalModel], getAvailable: () => [globalModel],
    refresh() {}, getError: () => undefined,
    async getApiKeyAndHeaders(model: { provider: string }) {
      return { ok: true, apiKey: await authStorage.getApiKey(model.provider) };
    },
  });
  const session = (m: ReturnType<typeof manager>) => ({ sessionManager: m, sessionFile: m.getSessionFile(),
    messages: [], isStreaming: false, getActiveToolNames: () => [], getAllTools: () => [],
    setActiveTools() {}, bindExtensions: async () => {}, subscribe: () => () => {},
    getContextUsage: () => undefined, getSystemPrompt: () => '', clearQueue() {},
  });
  let rebind: (s: any) => Promise<void>;
  const sdk = {
    AuthStorage: { create: (file: string) => { assert.equal(file, join(dir, 'auth.json')); return rootAuth; },
      inMemory: () => new FakeSdkAuthStorage() },
    ModelRegistry: { inMemory: registry }, SessionManager: nativeSessionManager ?? { open: manager },
    createAgentSessionServices: async (options: Record<string, unknown>) => {
      calls.push(options);
      return { ...options, modelRegistry: options.modelRegistry ?? registry(rootAuth) };
    },
    createAgentSessionFromServices: async () => ({}),
    createAgentSessionRuntime: async (callback: typeof factory, args: any) => {
      factoryCalls++; factory = callback; currentServices = (await factory(args)).services;
      return { session: session(args.sessionManager), get services() { return currentServices; }, setRebindSession: (cb: typeof rebind) => { rebind = cb; },
        newSession: async () => ({}), fork: async () => ({}), switchSession: async () => ({}), dispose: async () => {} };
    },
  } as unknown as SdkModule;
  const loader = (async (selected: string) => { assert.equal(selected, sdkPath); return sdk; }) as typeof loadSdk;
  const host = new WorkerRuntimeHost({ sdkLoader: loader, sdkRuntime, owner: {} as any,
    server: { onDetailDrain: () => () => {}, sendFrame() {}, sendEventFrame() {}, sendRuntimeReportFrame() {} } as any });
  // Prompt/transcript assembly is unrelated to provider service selection and would load SDK internals.
  const internal = host as any;
  internal.getSystemPromptModule = async () => ({ buildSystemPrompt: () => '' });
  internal.buildOpenedPayload = async () => ({ session: { sessionId: 'fake' } });
  host.applySync('auth', 1, { authPath: join(dir, 'auth.json'), fingerprint: 'startup-unavailable' });
  const payload: WorkerRuntimePromotionPayload = { sdkPath, sdkRuntime, agentDir: dir, startupCwd: dir,
    sessionDir: dir, sessionPath, creationReason: 'new',
    writeLease: { canonicalSessionPath: sessionPath }, openedPayload: {}, modelSettings: {} };
  return { host, payload, calls, rootAuth, factoryCalls: () => factoryCalls,
    async replace() {
      globalModel = { ...globalModel, name: 'Mutated global', cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } };
      const m = manager(sessionPath);
      currentServices = (await factory({ cwd: dir, agentDir: dir, sessionManager: m })).services;
      await rebind(session(m));
    } };
}

const artifactRoot = process.env.PIE_PROVIDER_RUNTIME_ARTIFACT;
const target: PiRuntimeTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
function descriptorFor(verified: Awaited<ReturnType<typeof verifyPiRuntimeArtifact>>): GenerationPiRuntimeDescriptor {
  return { schemaVersion: 1, artifactDir: verified.artifactDir, sdkPath: verified.sdkPath,
    cliPath: join(verified.sdkPath, 'dist/cli.js'), identity: verified.identity, manifest: verified.manifest };
}

test('real host promotion and replacement retain captured services; ordinary promotion retains root auth', {
  skip: !artifactRoot && 'requires PIE_PROVIDER_RUNTIME_ARTIFACT=<absolute verified runtime root>',
}, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('unexpected network request in headless artifact fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.ok(artifactRoot && isAbsolute(artifactRoot));
  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target });
  const sdk = await loadSdk(verified.sdkPath, { mode: 'source-artifact', descriptor: descriptorFor(verified), backendTarget: target, surface: 'cold' });
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-host-'));
  try {
    const cwd = join(dir, 'workspace');
    const sessionDir = join(dir, 'sessions');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
    const nativeManager = sdk.SessionManager.create(cwd, sessionDir);
    const sessionPath = nativeManager.getSessionFile();
    assert.ok(sessionPath);
    const reference = await saveProviderRuntimeProjection(dir, snapshot);
    const f = fixture(dir, sessionPath, sdk.SessionManager);
    f.payload.providerRuntime = { artifactDir: dir, reference, credentialFile: join(dir, 'never-open-credentials.json') };
    try {
      await f.host.promote(f.payload);
      await f.replace();
      for (const call of f.calls) {
        assert.notEqual(call.authStorage, f.rootAuth);
        const auth = call.authStorage as ProviderRuntimeAuthStorage;
        const models = call.modelRegistry as ProviderRuntimeModelRegistry;
        assert.equal(await auth.getApiKey('local'), 'unused');
        assert.deepEqual(models.find('local', 'm'), snapshot.models[0].model);
      }
      assert.equal(f.calls.length, 2);
    } finally { await f.host.dispose(); }
    const legacy = fixture(dir, sessionPath, sdk.SessionManager);
    try { await legacy.host.promote(legacy.payload); assert.equal(legacy.calls[0].authStorage, legacy.rootAuth);
      assert.equal(Object.hasOwn(legacy.calls[0], 'modelRegistry'), false);
    } finally { await legacy.host.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt captured artifact fails before SDK factory invocation', {
  skip: !artifactRoot && 'requires PIE_PROVIDER_RUNTIME_ARTIFACT=<absolute verified runtime root>',
}, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('unexpected network request in headless artifact fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.ok(artifactRoot && isAbsolute(artifactRoot));
  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target });
  const sdk = await loadSdk(verified.sdkPath, { mode: 'source-artifact', descriptor: descriptorFor(verified), backendTarget: target, surface: 'cold' });
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-corrupt-'));
  try {
    const cwd = join(dir, 'workspace');
    const sessionDir = join(dir, 'sessions');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
    const nativeManager = sdk.SessionManager.create(cwd, sessionDir);
    const sessionPath = nativeManager.getSessionFile();
    assert.ok(sessionPath);
    const reference = await saveProviderRuntimeProjection(dir, snapshot);
    await writeFile(join(dir, `${reference.sha256}.json`), '{}');
    const f = fixture(dir, sessionPath, sdk.SessionManager);
    f.payload.providerRuntime = { artifactDir: dir, reference, credentialFile: join(dir, 'never-open-credentials.json') };
    try { await assert.rejects(f.host.promote(f.payload), /Invalid provider runtime/); assert.equal(f.factoryCalls(), 0); }
    finally { await f.host.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
