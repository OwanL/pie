import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createPiProviderAuth, type NativeAuthStorage, type NativeOAuthProvider } from '../harness/model-providers/management/pi-auth';
import type { ProviderOAuthCallbacks, StagedProviderCredential } from '../harness/model-providers/management/auth-port';

type Model = { provider: string; baseUrl: string; nativeMetadata: string };
const token: StagedProviderCredential = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 0, enterprise: true };
function fixture() {
  const stores: FakeStorage[] = [];
  const registry: NativeOAuthProvider<Model>[] = ['openai-codex', 'anthropic', 'github-copilot', 'registered-extra']
    .map(id => ({ id, name: id }));
  let creates = 0;
  let path: string | undefined;
  let failWrite = false;
  const persisted: Record<string, StagedProviderCredential> = {};
  class FakeStorage implements NativeAuthStorage<Model> {
    data: Record<string, StagedProviderCredential>;
    constructor(data: Record<string, StagedProviderCredential> = {}) { this.data = data; stores.push(this); }
    errors: Error[] = [];
    get failWrite() { return failWrite; }
    set failWrite(value: boolean) { failWrite = value; }
    keyCalls = 0;
    callbacks?: ProviderOAuthCallbacks;
    getOAuthProviders() { return registry; }
    get(id: string) { return this.data[id]; }
    set(id: string, credential: StagedProviderCredential) {
      if (this.failWrite) this.errors.push(new Error('disk failed'));
      else this.data[id] = credential;
    }
    drainErrors() { const errors = this.errors; this.errors = []; return errors; }
    async login(id: string, callbacks: ProviderOAuthCallbacks) { this.callbacks = callbacks; this.set(id, token); }
    async getApiKey(id: string, options: { includeFallback: false }) {
      assert.deepEqual(options, { includeFallback: false }); this.keyCalls++;
      const credential = this.data[id];
      return credential?.type === 'api_key' ? credential.key : 'refreshed';
    }
    list() { return Object.keys(this.data); }
    async setAsync(id: string, credential: StagedProviderCredential, options?: { signal?: AbortSignal }) { options?.signal?.throwIfAborted(); this.set(id, credential); }
    async removeAsync(id: string) { delete this.data[id]; }
    // SDK-free adapter: creation does not acquire any native credential lock.
    static async createAsync(file: string) { return this.create(file); }
    static inMemory() { return new FakeStorage(); }
    static create(file: string) { creates++; path = file; return new FakeStorage(persisted); }
  }
  const file = resolve(tmpdir(), 'pie-auth-fake-only.json');
  return { FakeStorage, stores, registry, file, creates: () => creates, path: () => path };
}
const callbacks: ProviderOAuthCallbacks = {
  onAuth() {}, onDeviceCode() {}, async onPrompt() { return ''; }, async onSelect() { return undefined; },
};

test('definitions use the registry without touching file storage; custom id is stable', () => {
  const f = fixture();
  f.registry.splice(0, 1);
  const auth = createPiProviderAuth(f.FakeStorage, f.file);
  const definitions = auth.definitions();
  assert.equal(f.creates(), 0);
  assert.equal(definitions.some(d => d.id === 'openai-codex'), false);
  assert.deepEqual(definitions.find(d => d.id === 'anthropic')?.authMethods, ['oauth', 'api-key']);
  assert.deepEqual(definitions.find(d => d.id === 'openai')?.authMethods, ['api-key']);
  assert.deepEqual(definitions.find(d => d.id === 'registered-extra')?.authMethods, ['oauth']);
  const ollama = definitions.find(d => d.id === 'ollama')!;
  assert.deepEqual(ollama.authMethods, ['local']);
  assert.equal(ollama.discovery, 'ollama');
  const other = definitions.find(d => d.id === 'other')!;
  assert.deepEqual(other.authMethods, ['api-key', 'local']);
  assert.equal(other.id, 'other');
  assert.equal(other.name, 'Other provider');
  assert.equal(other.api, 'openai-completions');
  assert.equal(auth.definitions().at(-1)?.id, other.id);
  assert.throws(() => createPiProviderAuth(f.FakeStorage, 'relative.json'));
});

test('login is isolated until save and forwards cancellation callbacks', async () => {
  const f = fixture(); const auth = createPiProviderAuth(f.FakeStorage, f.file);
  const signal = new AbortController().signal;
  const supplied = { ...callbacks, signal };
  const staged = await auth.stageOAuthLogin('anthropic', supplied);
  assert.equal(f.creates(), 0);
  assert.equal(f.stores.at(-1)?.callbacks, supplied);
  assert.deepEqual(staged, token);
  assert.equal((await auth.listSavedCredentialIds()).includes('anthropic'), false);
  assert.equal(f.path(), f.file);
  await auth.saveCredential('anthropic', staged);
  assert.equal((await auth.listSavedCredentialIds()).includes('anthropic'), true);
  await assert.rejects(auth.stageOAuthLogin('invented', supplied));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(auth.stageOAuthLogin('anthropic', { ...callbacks, signal: controller.signal }));
});

test('stored presence and literal keys never invoke fallback or command resolution', async () => {
  const f = fixture(); const auth = createPiProviderAuth(f.FakeStorage, f.file);
  assert.equal((await auth.listSavedCredentialIds()).includes('openai'), false);
  assert.equal(await auth.getApiKey('openai'), undefined);
  for (const key of ['!do-not-execute', 'OPENAI_API_KEY', 'literal']) {
    await auth.saveCredential('openai', { type: 'api_key', key });
    assert.equal(await auth.getApiKey('openai'), key);
  }
  assert.equal(f.stores.at(-1)?.keyCalls, 1);
  await auth.saveCredential('anthropic', token);
  assert.equal(await auth.getApiKey('anthropic'), 'refreshed');
  assert.equal(f.stores.at(-1)?.keyCalls, 1);
  f.stores.at(-1)!.failWrite = true;
  await assert.rejects(auth.saveCredential('openai', { type: 'api_key', key: 'new' }), /storage failed/);
});

test('native auth resolves literal references for management and scoped runtime callers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-native-auth-resolution-'));
  try {
    const file = join(dir, 'auth.json');
    const credentials: Record<string, StagedProviderCredential> = {};
    let calls = 0;
    let finishRefresh: ((key: string | undefined) => void) | undefined;
    let pauseRefresh = false;
    const createStorage = (): NativeAuthStorage<Model> => ({
      getOAuthProviders: () => [],
      get: id => credentials[id],
      list: () => Object.keys(credentials),
      setAsync: async (id, credential) => { credentials[id] = credential; },
      removeAsync: async id => { delete credentials[id]; },
      drainErrors: () => [],
      login: async () => {},
      getApiKey: async id => {
        calls++;
        assert.equal(credentials[id]?.type, 'api_key');
        if (pauseRefresh) return await new Promise(resolve => { finishRefresh = resolve; });
        // This is the SDK's resolution result; the literal stored reference is never
        // interpreted by the test as an environment-variable lookup.
        return credentials[id]?.type === 'api_key' && credentials[id].key === '${TEST_TOKEN}'
          ? 'native-resolved-token' : undefined;
      },
    });
    const auth = createPiProviderAuth({ createAsync: async () => createStorage(), inMemory: createStorage }, file);
    await auth.saveCredential('referenced', { type: 'api_key', key: '${TEST_TOKEN}' });
    assert.deepEqual(await auth.getApiKey('referenced'), 'native-resolved-token');
    const scope = (await auth.getRuntimeCredentialScope!('referenced'))!;
    assert.equal(await auth.getRuntimeApiKey!('referenced', scope), 'native-resolved-token');
    assert.equal(JSON.parse(await readFile(`${file}.runtime-scopes.json`, 'utf8')).referenced, scope);

    const beforeUnavailable = calls;
    assert.equal(await auth.getRuntimeCredentialScope!('unavailable'), undefined);
    await assert.rejects(auth.getRuntimeApiKey!('unavailable', 'missing'));
    await assert.rejects(auth.getRuntimeApiKey!('referenced', ''));
    assert.equal(calls, beforeUnavailable);

    pauseRefresh = true;
    const pending = auth.getRuntimeApiKey!('referenced', scope);
    while (!finishRefresh) await new Promise(resolve => setImmediate(resolve));
    await writeFile(`${file}.runtime-scopes.json`, JSON.stringify({ referenced: 'changed-scope' }));
    finishRefresh('native-resolved-token');
    await assert.rejects(pending, /Provider credential storage failed/);
    assert.equal(JSON.parse(await readFile(`${file}.runtime-scopes.json`, 'utf8')).referenced, 'changed-scope');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('management credential reads surface native storage failures rather than reporting missing credentials', async () => {
  const f = fixture();
  let keyCalls = 0;
  const auth = createPiProviderAuth({
    inMemory: () => new f.FakeStorage(),
    createAsync: async () => ({
      getOAuthProviders: () => f.registry,
      get: () => undefined,
      list: () => [], async setAsync() {}, async removeAsync() {}, async login() {},
      drainErrors: () => [new Error('private native read failure')],
      async getApiKey() { keyCalls++; return undefined; },
    }),
  }, f.file);
  await assert.rejects(auth.listSavedCredentialIds(), /^Error: Provider credential storage failed$/);
  await assert.rejects(auth.getApiKey('openai'), /^Error: Provider credential storage failed$/);
  await assert.rejects(auth.discoveryBaseUrl('github-copilot', ''), /^Error: Provider credential storage failed$/);
  assert.equal(keyCalls, 0);
});

test('Copilot modifies actual native models and rejects unavailable/invalid metadata', async () => {
  const f = fixture();
  const models: Model[] = [{ provider: 'github-copilot', baseUrl: 'https://default.invalid', nativeMetadata: 'real' }];
  const provider = f.registry.find(p => p.id === 'github-copilot')!;
  provider.modifyModels = (input, credential) => {
    assert.equal(input, models); assert.equal(credential.enterprise, true);
    return input.map(model => ({ ...model, baseUrl: 'https://enterprise.invalid/api' }));
  };
  const auth = createPiProviderAuth(f.FakeStorage, f.file, id => { assert.equal(id, 'github-copilot'); return models; });
  await auth.saveCredential('github-copilot', token);
  assert.equal(await auth.discoveryBaseUrl('github-copilot', 'https://ignored.invalid'), 'https://enterprise.invalid/api');
  assert.equal(await auth.discoveryBaseUrl('custom-any', 'http://localhost:1234/v1'), 'http://localhost:1234/v1');
  provider.modifyModels = () => [];
  await assert.rejects(auth.discoveryBaseUrl('github-copilot', ''), /unavailable/);
  provider.modifyModels = () => [{ ...models[0], baseUrl: 'file:///unsafe' }];
  await assert.rejects(auth.discoveryBaseUrl('github-copilot', ''), /unsupported/);
  const unsupported = createPiProviderAuth(f.FakeStorage, f.file);
  await unsupported.saveCredential('github-copilot', token);
  await assert.rejects(unsupported.discoveryBaseUrl('github-copilot', ''), /unsupported/);
});

test('async mutation lane spans broker instances; tombstones precede canonical waits and captures cannot revive them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-auth-lane-'));
  try {
    const file = join(dir, 'auth.json');
    let credential: StagedProviderCredential | undefined = { type: 'api_key', key: 'old' };
    let releaseOpen!: () => void;
    let blockOpen = false;
    let opened = false;
    let releaseWrite!: () => void;
    let writing = false;
    const events: string[] = [];
    const native = () => ({
      getOAuthProviders: () => [], list: () => credential ? ['p'] : [], get: () => credential,
      drainErrors: () => [], login: async () => {}, getApiKey: async () => 'key',
      setAsync: async (_id: string, value: StagedProviderCredential) => {
        events.push('write'); writing = true;
        await new Promise<void>(resolve => { releaseWrite = resolve; }); credential = value;
      },
      removeAsync: async () => { events.push('remove'); credential = undefined; },
    });
    const ctor = { inMemory: native, createAsync: async () => {
      if (blockOpen) { opened = true; await new Promise<void>(resolve => { releaseOpen = resolve; }); }
      return native();
    } };
    const a = createPiProviderAuth(ctor, file), b = createPiProviderAuth(ctor, file);
    blockOpen = true;
    const capture = a.getRuntimeCredentialScope!('p');
    while (!opened) await new Promise(resolve => setImmediate(resolve));
    blockOpen = false;
    const save = a.saveCredential('p', { type: 'api_key', key: 'new' });
    while (!writing) await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(await readFile(`${file}.runtime-scopes.json`, 'utf8')).p, null);
    releaseOpen();
    assert.equal(await capture, undefined);
    const remove = b.removeCredential('p');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['write']);
    releaseWrite(); await save; await remove;
    assert.deepEqual(events, ['write', 'remove']);
    assert.equal(await a.getRuntimeCredentialScope!('p'), undefined);
    assert.equal(JSON.parse(await readFile(`${file}.runtime-scopes.json`, 'utf8')).p, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing asynchronous native capabilities fail generically without sync fallback', async () => {
  const f = fixture();
  let syncCalls = 0;
  const ctor = { inMemory: () => new f.FakeStorage(), create: () => { syncCalls++; throw new Error('sync'); } };
  const auth = createPiProviderAuth(ctor as never, f.file);
  await assert.rejects(auth.listSavedCredentialIds(), /^Error: Provider credential storage failed$/);
  assert.equal(syncCalls, 0);
  const missing = createPiProviderAuth({ ...ctor, createAsync: async () => ({ get: () => undefined }) } as never, f.file);
  await assert.rejects(missing.listSavedCredentialIds(), /^Error: Provider credential storage failed$/);
});

test('cancelled save passes the signal and retains invalidation', async () => {
  const f = fixture(), auth = createPiProviderAuth(f.FakeStorage, f.file);
  await auth.saveCredential('openai', { type: 'api_key', key: 'old' });
  const scope = await auth.getRuntimeCredentialScope!('openai');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(auth.saveCredential('openai', { type: 'api_key', key: 'new' }, controller.signal), /storage failed/);
  assert.equal(await auth.getRuntimeCredentialScope!('openai'), undefined);
  await assert.rejects(auth.getRuntimeApiKey!('openai', scope!), /storage failed/);
});
