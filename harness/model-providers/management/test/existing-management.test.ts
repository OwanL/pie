import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../service';
import type { ProviderManagementAuthPort, ProviderOAuthCallbacks } from '../auth-port';
import type { NativeRuntimeModel } from '../../runtime/contracts';
import { isProviderManagementSnapshot } from '../validation';

const native: NativeRuntimeModel = { provider: 'openai', id: 'native-custom', name: 'Native custom', api: 'openai-completions',
  baseUrl: 'https://native.invalid/account', input: ['text'], reasoning: true, contextWindow: 12345, maxTokens: 777,
  cost: { input: 3, output: 7, cacheRead: 1, cacheWrite: 2 }, compat: { supportsStore: false } };
const freshDraft = { originalId: null, id: 'openai', enabled: true, api: 'openai-responses', baseUrl: 'https://new.invalid/v1',
  credentialSource: 'default' as const, environmentName: '', models: [] };
async function fixture(changes: Partial<Parameters<typeof createProviderManagementService>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pie-existing-management-'));
  const configFile = join(dir, 'providers.yaml');
  const auth: ProviderManagementAuthPort = { definitions: () => [{ id: 'openai', name: 'OpenAI', kind: 'openai',
    api: 'openai-responses', baseUrl: 'https://template.invalid/v1', authMethods: ['api-key', 'oauth'], discovery: 'unsupported' }],
    hasSavedCredential: () => false, stageOAuthLogin: async () => { throw new Error('Unexpected login'); }, saveCredential: async () => {},
    removeCredential: async () => {}, getApiKey: async () => { throw new Error('Unexpected key lookup'); }, discoveryBaseUrl: async (_, url) => url };
  const service = createProviderManagementService({ configFile, modelCacheDir: join(dir, 'cache'), auth,
    existingConnections: () => [{ id: 'openai', modelCount: 1, credentials: 'saved', canForgetCredential: true,
      models: { [native.id]: { name: native.name, input: native.input, reasoning: native.reasoning,
        contextWindow: native.contextWindow, maxTokens: native.maxTokens, pricing: { input: 3, output: 7, cacheRead: 1, cacheWrite: 2 } } } }],
    forgetExistingCredential: async () => {}, fetch: async () => { throw new Error('Unexpected network'); }, ...changes });
  return { service, auth, configFile, close: async () => { service.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test('existing settings round trip writes policy only, preserves native models and never seeds template endpoints/auth', async () => {
  const f = await fixture();
  try {
    const read = await f.service.request({ type: 'read-provider', operationId: 'detail', id: 'openai' });
    assert.equal(read.status, 'ok');
    assert.equal(isProviderManagementSnapshot(read.snapshot), true);
    assert.deepEqual(read.snapshot.providers[0].capabilities, { settings: true, editConnection: false, remove: true, forgetCredential: true });
    assert.equal(read.draft!.originalId, 'openai');
    assert.equal(read.draft!.enabled, true);
    assert.equal(read.draft!.api, ''); assert.equal(read.draft!.baseUrl, ''); assert.equal(read.draft!.credentialSource, 'legacy');
    assert.equal(read.draft!.models[0].name, 'Native custom');
    const saved = await f.service.request({ type: 'save', operationId: 'policy', expectedRevision: null,
      draft: { ...read.draft!, models: read.draft!.models.map(model => ({ ...model, visible: 'no', subagentEligible: 'no' })) } });
    assert.equal(saved.status, 'ok');
    const text = await readFile(f.configFile, 'utf8');
    assert.ok(!text.includes('baseUrl')); assert.ok(!text.includes('api:')); assert.ok(!text.includes('native.invalid'));
    assert.match(text, /source: legacy/);
    const runtime = await f.service.captureRuntimeProjection([native]);
    assert.deepEqual(runtime!.models[0].model, native);
    assert.deepEqual(runtime!.models[0].credential, { source: 'legacy' });
    assert.equal(runtime!.models[0].visible, false); assert.equal(runtime!.models[0].subagentEligible, false);
    const reread = await f.service.request({ type: 'read-provider', operationId: 'reread', id: 'openai' });
    assert.equal(reread.draft!.models[0].visible, 'no');
    const disabled = await f.service.request({ type: 'save', operationId: 'disable', expectedRevision: saved.snapshot.configRevision,
      draft: { ...reread.draft!, enabled: false } });
    assert.equal(disabled.status, 'ok'); assert.equal(disabled.snapshot.providers[0].enabled, false);
    assert.equal((await f.service.captureRuntimeProjection([native]))!.models[0].enabled, false);
    const forbidden = await f.service.request({ type: 'save', operationId: 'transport-edit', expectedRevision: disabled.snapshot.configRevision,
      draft: { ...reread.draft!, baseUrl: 'https://replacement.invalid' } });
    assert.equal(forbidden.status, 'conflict');
  } finally { await f.close(); }
});

test('native Ollama settings remain legacy policy rather than managed daemon setup', async () => {
  const f = await fixture({ existingConnections: () => [{ id: 'ollama', modelCount: 1, credentials: 'none', models: { installed: { name: 'Installed' } } }] });
  try {
    const read = await f.service.request({ type: 'read-provider', operationId: 'detail', id: 'ollama' });
    const saved = await f.service.request({ type: 'save', operationId: 'disable', expectedRevision: null, draft: { ...read.draft!, enabled: false } });
    assert.equal(saved.status, 'ok');
    const text = await readFile(f.configFile, 'utf8');
    assert.match(text, /source: legacy/); assert.ok(!text.includes('baseUrl')); assert.ok(!text.includes('api:'));
    const snapshot = await f.service.captureRuntimeProjection([{ ...native, provider: 'ollama', id: 'installed' }]);
    assert.equal(snapshot!.models[0].enabled, false); assert.equal(snapshot!.models[0].model!.baseUrl, native.baseUrl);
  } finally { await f.close(); }
});

test('unavailable safe metadata is precisely read-only but still removable', async () => {
  const f = await fixture({ existingConnections: () => [{ id: 'openai', modelCount: 2, credentials: 'environment' }] });
  try {
    const read = await f.service.request({ type: 'read-provider', operationId: 'read', id: 'openai' });
    assert.equal(read.status, 'conflict'); assert.match(read.snapshot.error!, /metadata.*safe settings round trip/);
    assert.equal(read.snapshot.providers[0].readOnly, true); assert.equal(read.snapshot.providers[0].capabilities!.remove, true);
    const removed = await f.service.request({ type: 'remove', operationId: 'remove', expectedRevision: null, id: 'openai' });
    assert.equal(removed.status, 'ok'); assert.deepEqual(removed.snapshot.providers, []);
    assert.deepEqual((await f.service.captureRuntimeProjection([native]))!.models, []);
  } finally { await f.close(); }
});

test('removal tombstone fences stale writes, suppresses legacy fallback and survives inventory reappearance', async () => {
  let forgot = 0, revoked = 0;
  const f = await fixture({ forgetExistingCredential: async () => { assert.equal(revoked, 1); forgot++; } });
  f.auth.removeCredential = async () => { revoked++; };
  try {
    const detail = await f.service.request({ type: 'read-provider', operationId: 'detail', id: 'openai' });
    const request = { type: 'remove' as const, operationId: 'remove', expectedRevision: null, id: 'openai' };
    const removed = await f.service.request(request);
    assert.equal(removed.status, 'ok'); assert.equal(removed.snapshot.mutation, undefined);
    assert.deepEqual(removed.snapshot.providers, []); assert.equal(forgot, 1);
    assert.equal(await f.service.request(request), removed); assert.equal(revoked, 1);
    assert.equal((await f.service.request({ ...request, id: 'different' })).status, 'conflict');
    assert.equal((await f.service.request({ type: 'save', operationId: 'stale-save', expectedRevision: null, draft: detail.draft! })).status, 'conflict');
    assert.equal((await f.service.request({ type: 'connect', operationId: 'stale-connect', expectedRevision: null, draft: freshDraft, method: 'api-key', apiKey: 'synthetic' })).status, 'conflict');
    const read = await f.service.request({ type: 'read', operationId: 'inventory-reappeared' });
    assert.deepEqual(read.snapshot.providers, []);
    assert.deepEqual((await f.service.captureRuntimeProjection([native]))!.models, []);
    assert.match(await readFile(f.configFile, 'utf8'), /removed: true/);
    const failedSave = await f.service.request({ type: 'save', operationId: 'not-add', expectedRevision: removed.snapshot.configRevision, draft: freshDraft });
    assert.equal(failedSave.status, 'conflict');
    const add = await f.service.request({ type: 'read-provider', operationId: 'add-draft', id: 'openai' });
    assert.equal(add.draft!.originalId, null); assert.equal(add.draft!.credentialSource, 'default');
    const reconnected = await f.service.request({ type: 'connect', operationId: 'explicit-add', expectedRevision: removed.snapshot.configRevision,
      draft: freshDraft, method: 'api-key', apiKey: 'synthetic' });
    assert.equal(reconnected.status, 'ok'); assert.equal(reconnected.snapshot.providers[0].origin, 'managed');
    assert.ok(!(await readFile(f.configFile, 'utf8')).includes('removed:'));
  } finally { await f.close(); }
});

test('failure after tombstone remains hidden and retryable, managed revocation precedes native forget', async () => {
  let fail = true, calls = 0, forgot = 0;
  const f = await fixture({ forgetExistingCredential: async () => { forgot++; } });
  f.auth.removeCredential = async () => { calls++; if (fail) throw new Error('PRIVATE'); };
  try {
    const failed = await f.service.request({ type: 'remove', operationId: 'first', expectedRevision: null, id: 'openai' });
    assert.equal(failed.status, 'error'); assert.deepEqual(failed.snapshot.providers, []); assert.equal(forgot, 0);
    assert.match(failed.snapshot.error!, /removed from new chats.*incomplete.*Retry removal/);
    assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
    assert.deepEqual((await f.service.captureRuntimeProjection([native]))!.models, []);
    fail = false;
    const retry = await f.service.request({ type: 'remove', operationId: 'retry', expectedRevision: failed.snapshot.configRevision, id: 'openai' });
    assert.equal(retry.status, 'ok'); assert.equal(retry.snapshot.configRevision, failed.snapshot.configRevision);
    assert.equal(calls, 2); assert.equal(forgot, 1); assert.equal(retry.snapshot.error, undefined);
  } finally { await f.close(); }
});

test('removal aborts live OAuth and suppresses late prompts and credential commits', async () => {
  let callbacks!: ProviderOAuthCallbacks, finish!: (value: any) => void, writes = 0;
  const f = await fixture({ existingConnections: () => [] });
  f.auth.stageOAuthLogin = async (_, value) => { callbacks = value; return new Promise(resolve => { finish = resolve; }); };
  f.auth.saveCredential = async () => { writes++; };
  try {
    const login = f.service.request({ type: 'connect', operationId: 'login', expectedRevision: null, draft: freshDraft, method: 'oauth' });
    while (!callbacks) await new Promise(resolve => setTimeout(resolve, 1));
    const prompt = callbacks.onPrompt({ message: 'Code' }); const rejected = assert.rejects(prompt);
    const removed = await f.service.request({ type: 'remove', operationId: 'remove', expectedRevision: null, id: 'openai' });
    await rejected;
    callbacks.onAuth({ url: 'https://late.invalid' }); callbacks.onProgress?.('PRIVATE');
    finish({ type: 'oauth', access: 'PRIVATE', refresh: 'PRIVATE', expires: 0 });
    assert.equal((await login).status, 'cancelled'); assert.equal(writes, 0); assert.equal(callbacks.signal!.aborted, true);
    assert.equal(removed.snapshot.auth, undefined); assert.equal(removed.snapshot.authBrowser, undefined);
    const read = await f.service.request({ type: 'read', operationId: 'read' });
    assert.deepEqual(read.snapshot.providers, []); assert.equal(read.snapshot.auth, undefined);
  } finally { await f.close(); }
});

test('removal aborts pending discovery and ignores a late native listing', async () => {
  let signal!: AbortSignal, finish!: (response: Response) => void;
  const f = await fixture({ existingConnections: () => [], fetch: async (_, init) => {
    signal = init!.signal!; return new Promise(resolve => { finish = resolve; });
  } });
  try {
    await writeFile(f.configFile, JSON.stringify({ version: 1, providers: { custom: { enabled: true, api: 'openai-completions',
      baseUrl: 'https://custom.invalid/v1', credentialRef: { source: 'none' }, manualModels: ['kept'] } } }));
    const refresh = f.service.request({ type: 'refresh', operationId: 'refresh', id: 'custom' });
    while (!signal) await new Promise(resolve => setTimeout(resolve, 1));
    const detail = await f.service.request({ type: 'read-provider', operationId: 'detail', id: 'custom' });
    const removed = await f.service.request({ type: 'remove', operationId: 'remove', expectedRevision: detail.snapshot.configRevision, id: 'custom' });
    assert.equal(removed.status, 'ok'); assert.equal(signal.aborted, true); assert.deepEqual(removed.snapshot.providers, []);
    finish(Response.json({ data: [{ id: 'late' }] }));
    assert.equal((await refresh).status, 'cancelled');
    const read = await f.service.request({ type: 'read', operationId: 'read' });
    assert.deepEqual(read.snapshot.providers, []);
    assert.deepEqual((await f.service.captureRuntimeProjection([{ ...native, provider: 'custom' }]))!.models, []);
  } finally { await f.close(); }
});

test('removal preserves environment and an unrelated disabled provider remains visible', async () => {
  const key = 'PIE_SYNTHETIC_REMOVAL_ENV'; const previous = process.env[key]; process.env[key] = 'synthetic';
  let forgot = 0;
  const f = await fixture({ existingConnections: () => [{ id: 'openai', modelCount: 1, credentials: 'environment', models: {} }],
    forgetExistingCredential: async () => { forgot++; } });
  try {
    await writeFile(f.configFile, JSON.stringify({ version: 1, providers: { disabled: { enabled: false }, openai: { enabled: true, credentialRef: { source: 'environment', name: key } } } }));
    const before = await f.service.request({ type: 'read', operationId: 'before' });
    const removed = await f.service.request({ type: 'remove', operationId: 'remove', expectedRevision: before.snapshot.configRevision, id: 'openai' });
    assert.equal(removed.status, 'ok'); assert.equal(process.env[key], 'synthetic'); assert.equal(forgot, 0);
    assert.deepEqual(removed.snapshot.providers.map(row => [row.id, row.enabled]), [['disabled', false]]);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; await f.close(); }
});

test('external revision conflict does not revoke credentials or write a tombstone', async () => {
  let revoked = 0;
  const f = await fixture(); f.auth.removeCredential = async () => { revoked++; };
  try {
    await writeFile(f.configFile, 'version: 1\nproviders: {}\n');
    const stale = await f.service.request({ type: 'remove', operationId: 'stale', expectedRevision: null, id: 'openai' });
    assert.equal(stale.status, 'conflict'); assert.equal(revoked, 0);
    assert.ok(!(await readFile(f.configFile, 'utf8')).includes('removed:'));
  } finally { await f.close(); }
});
