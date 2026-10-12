import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../service';
import type { ProviderManagementAuthPort, ProviderOAuthCallbacks } from '../auth-port';
import { discoverModels, parseOpenAIModels, loadDiscoveryCache, saveDiscoveryCache } from '../discovery';
import { createPiProviderAuth } from '../pi-auth';
const draft = { originalId: null, id: 'local', enabled: false, api: 'openai-completions', baseUrl: 'http://localhost:1234/v1', credentialSource: 'default' as const, environmentName: '', models: [], manualModelIds: ['manual'] };
async function fixture(authChanges: Partial<ProviderManagementAuthPort> = {}, fetcher?: typeof fetch, onSnapshot?: Parameters<typeof createProviderManagementService>[0]['onSnapshot'],
  invalidateCache?: Parameters<typeof createProviderManagementService>[0]['invalidateCache']) {
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-core-'));
  const auth: ProviderManagementAuthPort = { definitions: () => [], hasSavedCredential: () => false,
    stageOAuthLogin: async () => ({ type: 'oauth', access: 'private', refresh: 'private', expires: 1 }), saveCredential: async () => {},
    getApiKey: async () => undefined, discoveryBaseUrl: async (_, url) => url, ...authChanges };
  const configFile = join(dir, 'providers.yaml');
  const modelCacheDir = join(dir, 'cache');
  const service = createProviderManagementService({ configFile, modelCacheDir, auth,
    onSnapshot, invalidateCache, fetch: fetcher ?? (async () => { throw new Error('No network expected'); }) });
  return { service, configFile, modelCacheDir, close: async () => { service.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
test('environment discovery does not inherit stored OAuth account routing', async () => {
  let savedLookups = 0, endpointLookups = 0, requestedUrl = '';
  const f = await fixture({ definitions: () => [{ id: 'github-copilot', name: 'Copilot', kind: 'copilot',
    api: 'openai-completions', baseUrl: 'https://default.invalid', authMethods: ['oauth'], discovery: 'copilot' }],
    hasSavedCredential: () => true,
    getApiKey: async () => { savedLookups++; return 'unused-stored-account-key'; },
    discoveryBaseUrl: async () => { endpointLookups++; return 'https://stored-account.invalid'; }
  }, async url => { requestedUrl = String(url); return new Response(JSON.stringify({ data: [] })); });
  try {
    const saved = await f.service.request({ type: 'save', operationId: 'save-env', expectedRevision: null,
      draft: { ...draft, id: 'github-copilot', enabled: true, baseUrl: 'https://explicit.invalid/v1',
        credentialSource: 'environment', environmentName: 'SYNTHETIC_COPILOT_KEY' } });
    assert.equal(saved.status, 'ok');
    const refreshed = await f.service.request({ type: 'refresh', operationId: 'refresh-env', id: 'github-copilot' });
    assert.equal(refreshed.status, 'ok');
    assert.equal(requestedUrl, 'https://explicit.invalid/v1/models');
    assert.equal(savedLookups, 0); assert.equal(endpointLookups, 0);
  } finally { await f.close(); }
});

test('missing/read/create/manual models/noop/full document conflict', async () => {
  const f = await fixture(); try {
    const read = await f.service.request({ type: 'read', operationId: 'read' });
    assert.equal(read.snapshot.loaded, true); assert.equal(read.snapshot.configRevision, null);
    const saved = await f.service.request({ type: 'save', operationId: 'save', expectedRevision: null, draft });
    assert.equal(saved.status, 'ok');
    const detail = await f.service.request({ type: 'read-provider', operationId: 'detail', id: 'local' });
    assert.equal(detail.draft?.models[0].pricing.kind, 'unknown');
    const text = await readFile(f.configFile, 'utf8');
    const noop = await f.service.request({ type: 'save', operationId: 'noop', expectedRevision: saved.snapshot.configRevision, draft: detail.draft! });
    assert.equal(noop.status, 'ok'); assert.equal(await readFile(f.configFile, 'utf8'), text);
    await writeFile(f.configFile, '# external comment\n' + text);
    const conflict = await f.service.request({ type: 'save', operationId: 'conflict', expectedRevision: saved.snapshot.configRevision, draft: detail.draft! });
    assert.equal(conflict.status, 'conflict');
  } finally { await f.close(); }
});
test('staged native login cancellation suppresses late credential commit', async () => {
  let callbacks: ProviderOAuthCallbacks | undefined, finish!: (value: any) => void, writes = 0;
  const f = await fixture({ definitions: () => [{ id: 'local', name: 'Test', kind: 'custom', api: draft.api, baseUrl: draft.baseUrl, authMethods: ['oauth'], discovery: 'unsupported' }], stageOAuthLogin: async (_, cb) => { callbacks = cb; return new Promise(r => { finish = r; }); }, saveCredential: async () => { writes++; } });
  try {
    const pending = f.service.request({ type: 'connect', operationId: 'login', expectedRevision: null, draft, method: 'oauth' });
    while (!callbacks) await new Promise(r => setTimeout(r, 1));
    const prompt = callbacks.onPrompt({ message: 'Code' });
    const state = await f.service.request({ type: 'read', operationId: 'during' });
    assert.equal(state.snapshot.auth?.kind, 'input');
    const rejected = assert.rejects(prompt);
    await f.service.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'login' }); await rejected;
    finish({ type: 'oauth', access: 'SECRET', refresh: 'SECRET', expires: 1 });
    assert.equal((await pending).status, 'cancelled'); assert.equal(writes, 0);
    await assert.rejects(readFile(f.configFile));
  } finally { await f.close(); }
});
test('OAuth callback snapshots whitelist SDK fields before publishing', async () => {
  let callbacks!: ProviderOAuthCallbacks;
  const f = await fixture({ definitions: () => [{ id: 'local', name: 'Test', kind: 'custom', api: draft.api, baseUrl: draft.baseUrl, authMethods: ['oauth'], discovery: 'unsupported' }],
    stageOAuthLogin: async (_, value) => { callbacks = value; return new Promise(() => {}); } });
  try {
    const pending = f.service.request({ type: 'connect', operationId: 'oauth', expectedRevision: null, draft, method: 'oauth' });
    while (!callbacks) await new Promise(r => setTimeout(r, 1));
    (callbacks.onAuth as any)({ url: 'https://login.invalid', instructions: 'Continue', token: 'SECRET', extra: 'PRIVATE' });
    const browser = await f.service.request({ type: 'read', operationId: 'browser-prompt' });
    assert.deepEqual(browser.snapshot.auth, { kind: 'browser', operationId: 'oauth', url: 'https://login.invalid', instructions: 'Continue' });
    const input = callbacks.onPrompt({ message: 'Code', placeholder: '1234', allowEmpty: false } as any);
    const inputSnapshot = await f.service.request({ type: 'read', operationId: 'input-prompt' });
    assert.deepEqual(inputSnapshot.snapshot.auth, { kind: 'input', operationId: 'oauth', promptId: 'oauth:1', message: 'Code', placeholder: '1234', allowEmpty: false });
    const select = callbacks.onSelect({ message: 'Choose', options: [{ id: 'one', label: 'One', token: 'SECRET' }], extra: 'PRIVATE' } as any);
    const selectSnapshot = await f.service.request({ type: 'read', operationId: 'select-prompt' });
    assert.deepEqual(selectSnapshot.snapshot.auth, { kind: 'select', operationId: 'oauth', promptId: 'oauth:2', message: 'Choose', options: [{ id: 'one', label: 'One' }] });
    assert.equal(JSON.stringify([browser.snapshot.auth, inputSnapshot.snapshot.auth, selectSnapshot.snapshot.auth]).includes('SECRET'), false);
    await f.service.request({ type: 'cancel', operationId: 'cancel-oauth', targetOperationId: 'oauth' });
    await Promise.all([assert.rejects(input), assert.rejects(select)]);
    assert.equal((await pending).status, 'cancelled');
  } finally { await f.close(); }
});
test('credential storage failure explicitly reports partial write and never exposes key', async () => {
  const f = await fixture({ saveCredential: async () => { throw new Error('SECRET'); } });
  try {
    const request = { type: 'connect' as const, operationId: 'key', expectedRevision: null, draft, method: 'api-key' as const, apiKey: 'SECRET' };
    const response = await f.service.request(request);
    assert.equal(response.status, 'error'); assert.match(response.snapshot.error!, /Configuration was saved/);
    assert.equal(JSON.stringify(response).includes('SECRET'), false); assert.equal((await readFile(f.configFile, 'utf8')).includes('SECRET'), false);
    assert.equal(await f.service.request(request), response);
    assert.equal((await f.service.request({ ...request, apiKey: 'changed' })).status, 'conflict');
  } finally { await f.close(); }
});
test('cache validates provenance and preserves unpriced observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-cache-'));
  try {
    const observation = { kind: 'account' as const, complete: true, freshness: 'fresh' as const, models: parseOpenAIModels({ data: [{ id: 'a' }] }) };
    await saveDiscoveryCache(dir, 'local', 'config-a', observation, 1);
    assert.equal((await loadDiscoveryCache(dir, 'local', 'config-a'))?.freshness, 'stale');
    assert.equal((await loadDiscoveryCache(dir, 'local', 'config-a'))?.models.a.pricing, 'unknown');
    assert.equal(await loadDiscoveryCache(dir, 'local', 'config-b'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('fresh refresh returns selected models; failed refresh and later reads preserve last known catalog', async () => {
  let fail = false;
  const f = await fixture({}, async (url) => {
    assert.equal(String(url), 'http://localhost:1234/v1/models');
    if (fail) throw new Error('private network failure');
    return new Response(JSON.stringify({ data: [{ id: 'discovered' }] }));
  });
  try {
    await f.service.request({ type: 'save', operationId: 'seed', expectedRevision: null, draft: { ...draft, enabled: true } });
    const fresh = await f.service.request({ type: 'refresh', operationId: 'fresh', id: 'local' });
    assert.equal(fresh.status, 'ok'); assert.equal(fresh.snapshot.providers[0].discovery, 'fresh');
    assert.ok(fresh.draft?.models.some(m => m.id === 'discovered'));
    fail = true;
    const failed = await f.service.request({ type: 'refresh', operationId: 'failed', id: 'local' });
    assert.equal(failed.status, 'error'); assert.ok(failed.draft?.models.some(m => m.id === 'discovered'));
    const reread = await f.service.request({ type: 'read-provider', operationId: 'reread', id: 'local' });
    assert.ok(reread.draft?.models.some(m => m.id === 'discovered'));
    const preferenceSave = await f.service.request({ type: 'save', operationId: 'preferences', expectedRevision: reread.snapshot.configRevision,
      draft: { ...reread.draft!, enabled: false, manualModelIds: ['manual', 'preference-only'] } });
    assert.equal(preferenceSave.status, 'ok');
    const afterPreferences = await f.service.request({ type: 'read-provider', operationId: 'after-preferences', id: 'local' });
    assert.ok(afterPreferences.draft?.models.some(m => m.id === 'discovered'));
  } finally { await f.close(); }
});
test('default/local discovery never resolves an unrelated saved credential', async () => {
  let keyReads = 0;
  const f = await fixture({ hasSavedCredential: () => true, getApiKey: async () => { keyReads++; return 'OLD-SECRET'; } }, async (_, init) => {
    assert.equal((init?.headers as Record<string, string>)?.Authorization, undefined);
    return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  try {
    await f.service.request({ type: 'save', operationId: 'seed-local', expectedRevision: null, draft: { ...draft, enabled: true } });
    const refreshed = await f.service.request({ type: 'refresh', operationId: 'refresh-local', id: 'local' });
    assert.equal(refreshed.status, 'ok'); assert.equal(keyReads, 0);
  } finally { await f.close(); }
});
test('configured rows only and registered auth method validation', async () => {
  let logins = 0;
  const f = await fixture({ definitions: () => [{ id: 'builtin', name: 'Builtin', kind: 'chatgpt', api: 'openai-responses', baseUrl: '', authMethods: ['oauth'], discovery: 'unsupported' }], stageOAuthLogin: async () => { logins++; throw new Error('unexpected'); } });
  try {
    assert.deepEqual((await f.service.request({ type: 'read', operationId: 'read' })).snapshot.providers, []);
    assert.equal((await f.service.request({ type: 'connect', operationId: 'wrong-key', expectedRevision: null, draft: { ...draft, id: 'builtin' }, method: 'api-key', apiKey: 'SECRET' })).status, 'error');
    assert.equal((await f.service.request({ type: 'connect', operationId: 'custom-oauth', expectedRevision: null, draft, method: 'oauth' })).status, 'error');
    assert.equal(logins, 0);
  } finally { await f.close(); }
});
test('parallel DAO mutations fence the current revision and reads never overwrite a confirmed save', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all(['a', 'b'].map(id => f.service.request({ type: 'save', operationId: id, expectedRevision: null, draft: { ...draft, id } })));
    assert.deepEqual([a.status, b.status].sort(), ['conflict', 'ok']);
    const winner = a.status === 'ok' ? 'a' : 'b';
    const reads = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.request({ type: 'read-provider', operationId: `read-${i}`, id: winner })));
    assert.ok(reads.every(r => r.snapshot.providers.length === 1 && r.snapshot.providers[0].id === winner));
  } finally { await f.close(); }
});
test('malformed cache differs from absent cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-cache-invalid-'));
  try {
    assert.equal(await loadDiscoveryCache(dir, 'local', 'p'), undefined);
    await saveDiscoveryCache(dir, 'local', 'p', { kind: 'account', complete: true, freshness: 'fresh', models: { bad: { name: 42 as any } } }, 1);
    await assert.rejects(loadDiscoveryCache(dir, 'local', 'p'), /could not be loaded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('refresh concurrency is bounded and cancellation releases queued work', async () => {
  let active = 0, peak = 0;
  const f = await fixture({}, async (_, init) => {
    active++; peak = Math.max(peak, active);
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true }));
  });
  try {
    await f.service.request({ type: 'save', operationId: 'seed', expectedRevision: null, draft: { ...draft, enabled: true } });
    const work = Array.from({ length: 6 }, (_, i) => f.service.request({ type: 'refresh', operationId: `refresh-${i}`, id: 'local' }));
    while (active < 3) await new Promise(r => setTimeout(r, 1));
    assert.equal(peak, 3);
    await Promise.all(Array.from({ length: 6 }, (_, i) => f.service.request({ type: 'cancel', operationId: `cancel-${i}`, targetOperationId: `refresh-${i}` })));
    assert.ok((await Promise.all(work)).every(r => r.status === 'cancelled')); assert.equal(active, 0); assert.equal(peak, 3);
  } finally { await f.close(); }
});
test('dispose during credential commit reports a safe partial snapshot', async () => {
  let finish!: () => void, started = false;
  const f = await fixture({ saveCredential: async () => { started = true; await new Promise<void>(r => { finish = r; }); } });
  try {
    const pending = f.service.request({ type: 'connect', operationId: 'commit', expectedRevision: null, draft, method: 'api-key', apiKey: 'SECRET' });
    while (!started) await new Promise(r => setTimeout(r, 1));
    f.service.dispose(); finish();
    const response = await pending;
    assert.equal(response.status, 'cancelled'); assert.match(response.snapshot.error!, /Configuration was saved/);
    assert.equal(response.snapshot.providers[0].id, 'local'); assert.equal(JSON.stringify(response).includes('SECRET'), false);
  } finally { await f.close(); }
});
test('saving point publishes and explicit cancellation cannot abort commit', async () => {
  let finish!: () => void, started = false;
  const phases: unknown[] = [];
  const f = await fixture({ saveCredential: async () => { started = true; await new Promise<void>(r => { finish = r; }); } }, undefined, snapshot => { phases.push(snapshot.mutation); });
  try {
    const pending = f.service.request({ type: 'connect', operationId: 'commit', expectedRevision: null, draft, method: 'api-key', apiKey: 'SECRET' });
    while (!started) await new Promise(r => setTimeout(r, 1));
    const cancel = await f.service.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'commit' });
    assert.equal(cancel.status, 'conflict');
    assert.deepEqual(cancel.snapshot.mutation, { operationId: 'commit', phase: 'saving' });
    finish();
    const response = await pending;
    assert.equal(response.status, 'ok');
    assert.equal(response.snapshot.mutation, undefined);
    assert.equal(phases.at(-1), undefined);
    assert.ok(phases.some(value => value !== undefined));
    assert.equal(JSON.stringify(phases).includes('SECRET'), false);
  } finally { await f.close(); }
});
test('hung synthetic discovery times out without publishing its late result', async () => {
  const f = await fixture({}, async () => new Promise<Response>(() => {}));
  try {
    await f.service.request({ type: 'save', operationId: 'seed', expectedRevision: null, draft: { ...draft, enabled: true } });
    const response = await f.service.request({ type: 'refresh', operationId: 'timeout', id: 'local' });
    assert.equal(response.status, 'cancelled'); assert.equal(response.snapshot.providers[0].discovery, 'error');
  } finally { await f.close(); }
});
test('Copilot discovery parses account metadata and does not duplicate v1', async () => {
  const snapshot = await discoverModels({ kind: 'copilot', baseUrl: 'https://copilot.invalid/v1/', signal: new AbortController().signal,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://copilot.invalid/v1/models');
      assert.ok((init?.headers as Record<string, string>)['Copilot-Integration-Id']);
      return new Response(JSON.stringify({ data: [{ id: 'account-model', name: 'Account Model', vendor: 'OpenAI', model_picker_enabled: true,
        supported_endpoints: ['/responses'], policy: { state: 'enabled' }, capabilities: { supports: { tool_calls: true, streaming: true, vision: true }, limits: { max_context_window_tokens: 128000, max_output_tokens: 8192 } },
        billing: { token_prices: { default: { input_price: 100, output_price: 200 } } } }] }));
    } });
  assert.equal(snapshot.models['account-model'].name, 'Account Model');
  assert.equal(snapshot.models['account-model'].api, 'openai-responses');
  assert.equal(snapshot.models['account-model'].contextWindow, 128000);
});
test('OpenAI discovery validates shape and never invents pricing', () => {
  assert.deepEqual({ ...parseOpenAIModels({ data: [{ id: 'a', name: 'A' }] }).a }, { name: 'A', pricing: 'unknown' });
  assert.throws(() => parseOpenAIModels({ data: [{ id: 1 }] }));
});
test('custom schema protocols accept API-key/local setup with unsupported manual fallback and no fetch', async () => {
  let fetches = 0;
  const f = await fixture({ definitions: () => [{ id: 'other', name: 'Other provider', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'local'], discovery: 'openai' }] }, async () => {
    fetches++; throw new Error('unsupported discovery must not fetch');
  });
  try {
    const anthropic = { ...draft, id: 'anthropic-custom', api: 'anthropic-messages', baseUrl: 'https://anthropic.invalid', manualModelIds: ['manual'] };
    const connected = await f.service.request({ type: 'connect', operationId: 'custom-anthropic', expectedRevision: null, draft: anthropic, method: 'api-key', apiKey: 'synthetic-key' });
    assert.equal(connected.status, 'ok');
    const anthropicRow = connected.snapshot.providers.find(provider => provider.id === 'anthropic-custom');
    assert.equal(anthropicRow?.discovery, 'unsupported');
    const detail = await f.service.request({ type: 'read-provider', operationId: 'anthropic-detail', id: 'anthropic-custom' });
    assert.deepEqual(detail.draft?.models.map(model => model.id), ['manual']);
    const local = await f.service.request({ type: 'connect', operationId: 'custom-local', expectedRevision: connected.snapshot.configRevision,
      draft: { ...draft, id: 'local-google', api: 'google-generative-ai', baseUrl: 'http://localhost:8000/v1', enabled: true }, method: 'local' });
    assert.equal(local.status, 'ok');
    assert.equal(local.snapshot.providers.find(provider => provider.id === 'local-google')?.discovery, 'unsupported');
    assert.equal(fetches, 0);
    assert.equal((await f.service.request({ type: 'connect', operationId: 'custom-oauth', expectedRevision: local.snapshot.configRevision,
      draft: { ...draft, id: 'custom-oauth', api: 'anthropic-messages' }, method: 'oauth' })).status, 'error');
  } finally { await f.close(); }
});
test('local connect persists explicit no-credential intent through reload and preference save without inherited auth', async () => {
  let savedKey = 'old-secret', apiKeyLookups = 0, endpointLookups = 0, credentialWrites = 0;
  const f = await fixture({ definitions: () => [{ id: 'local', name: 'Local', kind: 'custom', api: 'openai-completions',
    baseUrl: 'http://localhost:1234/v1', authMethods: ['api-key', 'local'], discovery: 'openai' }],
    hasSavedCredential: () => true,
    getApiKey: async () => { apiKeyLookups++; return savedKey; },
    discoveryBaseUrl: async (_, url) => { endpointLookups++; return 'https://credential-routed.invalid'; },
    saveCredential: async (_, value) => { credentialWrites++; if (value.type === 'api_key') savedKey = value.key; },
  }, async url => {
    assert.equal(String(url), 'http://localhost:1234/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  try {
    const initial = await f.service.request({ type: 'connect', operationId: 'seed-saved-key', expectedRevision: null,
      draft: { ...draft, enabled: false }, method: 'api-key', apiKey: 'old-secret' });
    assert.equal(initial.status, 'ok');
    const existing = await f.service.request({ type: 'read-provider', operationId: 'local-read', id: 'local' });
    assert.equal(existing.draft?.credentialSource, 'saved');
    const connected = await f.service.request({ type: 'connect', operationId: 'local-connect', expectedRevision: initial.snapshot.configRevision,
      draft: { ...existing.draft!, enabled: true }, method: 'local' });
    assert.equal(connected.status, 'ok');
    assert.equal(credentialWrites, 1);
    assert.equal(savedKey, 'old-secret');
    const reread = await f.service.request({ type: 'read-provider', operationId: 'local-reread', id: 'local' });
    assert.equal(reread.draft?.credentialSource, 'none');
    const refreshed = await f.service.request({ type: 'refresh', operationId: 'local-refresh', id: 'local' });
    assert.equal(refreshed.status, 'ok');
    assert.equal(apiKeyLookups, 0);
    assert.equal(endpointLookups, 0);
    const saved = await f.service.request({ type: 'save', operationId: 'save-preferences', expectedRevision: refreshed.snapshot.configRevision,
      draft: { ...reread.draft!, models: [{ id: 'local-model', name: 'local-model', visible: 'no', subagentEligible: 'unset',
        pricing: { kind: 'unknown', tiered: false } }] } });
    assert.equal(saved.status, 'ok');
    const finalDraft = await f.service.request({ type: 'read-provider', operationId: 'final-reread', id: 'local' });
    assert.equal(finalDraft.draft?.credentialSource, 'none');
    assert.equal(finalDraft.draft?.models[0]?.visible, 'no');
    const persisted = await readFile(f.configFile, 'utf8');
    assert.match(persisted, /credentialRef:\s*\{\s*source: none\s*\}/);
    assert.equal(savedKey, 'old-secret');
  } finally { await f.close(); }
});

test('generic Other row uses configured endpoint host and port', async () => {
  const f = await fixture({ definitions: () => [{ id: 'other', name: 'Other provider', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'local'], discovery: 'openai' }] });
  try {
    const response = await f.service.request({ type: 'save', operationId: 'other', expectedRevision: null,
      draft: { ...draft, id: 'other', baseUrl: 'https://models.example:8443/v1' } });
    assert.equal(response.status, 'ok');
    assert.equal(response.snapshot.providers[0].name, 'models.example:8443');
  } finally { await f.close(); }
});
test('unknown native OAuth integrations do not guess a protocol or endpoint', () => {
  const native = { getOAuthProviders: () => [{ id: 'future-provider', name: 'Future Provider' }] };
  const auth = createPiProviderAuth({ inMemory: () => native, create: () => native } as any, join(tmpdir(), 'synthetic-provider-auth.json'));
  const definition = auth.definitions().find(provider => provider.id === 'future-provider');
  assert.deepEqual({ api: definition?.api, baseUrl: definition?.baseUrl, discovery: definition?.discovery },
    { api: '', baseUrl: '', discovery: 'unsupported' });
});
test('cache invalidation failure drains stale discovery and leaves old credentials/cache intact', async () => {
  let savedKey = 'old-key', writes = 0, fetches = 0, invalidationFails = false, aborted = false;
  const f = await fixture({ hasSavedCredential: () => true, getApiKey: async () => savedKey,
    saveCredential: async (_, credential) => { writes++; savedKey = credential.type === 'api_key' ? credential.key : savedKey; } }, async (_, init) => {
      fetches++;
      if (fetches === 1) return new Response(JSON.stringify({ data: [{ id: 'old-account-model' }] }));
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    }, undefined, async () => { if (invalidationFails) throw new Error('synthetic cache failure'); });
  try {
    const created = await f.service.request({ type: 'save', operationId: 'cache-seed', expectedRevision: null, draft });
    const initial = await f.service.request({ type: 'read-provider', operationId: 'initial-detail', id: 'local' });
    const credential = await f.service.request({ type: 'connect', operationId: 'old-credential', expectedRevision: created.snapshot.configRevision,
      draft: initial.draft!, method: 'api-key', apiKey: 'old-key' });
    const enabled = await f.service.request({ type: 'read-provider', operationId: 'enable-detail', id: 'local' });
    await f.service.request({ type: 'save', operationId: 'enable-provider', expectedRevision: credential.snapshot.configRevision,
      draft: { ...enabled.draft!, enabled: true } });
    const populated = await f.service.request({ type: 'refresh', operationId: 'populate-old-cache', id: 'local' });
    assert.ok(populated.draft?.models.some(model => model.id === 'old-account-model'));
    const staleRefresh = f.service.request({ type: 'refresh', operationId: 'stale-refresh', id: 'local' });
    while (fetches < 2) await new Promise(r => setTimeout(r, 1));
    invalidationFails = true;
    const current = await f.service.request({ type: 'read-provider', operationId: 'replacement-detail', id: 'local' });
    const replacement = await f.service.request({ type: 'connect', operationId: 'replacement', expectedRevision: current.snapshot.configRevision,
      draft: current.draft!, method: 'api-key', apiKey: 'new-key' });
    assert.equal(replacement.status, 'error');
    assert.equal(replacement.snapshot.error, 'Configuration saved, but new credentials were not saved because the previous model cache could not be cleared. Check cache access and reconnect.');
    assert.equal(writes, 1); assert.equal(savedKey, 'old-key');
    assert.equal((await staleRefresh).status, 'cancelled'); assert.equal(aborted, true);
    const restarted = createProviderManagementService({ configFile: f.configFile, modelCacheDir: f.modelCacheDir,
      auth: { definitions: () => [], hasSavedCredential: () => true, stageOAuthLogin: async () => ({ type: 'oauth', access: '', refresh: '', expires: 1 }),
        saveCredential: async () => { throw new Error('restart must not save'); }, getApiKey: async () => savedKey,
        discoveryBaseUrl: async (_, url) => url }, fetch: async () => { throw new Error('No network expected'); } });
    try {
      const afterRestart = await restarted.request({ type: 'read', operationId: 'restart-read' });
      assert.equal(afterRestart.snapshot.providers[0].credentials, 'saved');
      assert.equal(afterRestart.snapshot.providers[0].discovery, 'cached');
      const cached = await restarted.request({ type: 'read-provider', operationId: 'restart-detail', id: 'local' });
      assert.ok(cached.draft?.models.some(model => model.id === 'old-account-model'));
      assert.equal(savedKey, 'old-key');
    } finally { restarted.dispose(); }
  } finally { await f.close(); }
});
test('credential replacement clears account cache before failed refresh, preserving manual models and preferences', async () => {
  let fail = false;
  const f = await fixture({}, async () => {
    if (fail) throw new Error('synthetic refresh failure');
    return new Response(JSON.stringify({ data: [{ id: 'old-account-model' }] }));
  });
  try {
    const created = await f.service.request({ type: 'save', operationId: 'credential-seed', expectedRevision: null,
      draft: { ...draft, enabled: true, manualModelIds: ['manual'] } });
    assert.equal(created.status, 'ok');
    await f.service.request({ type: 'connect', operationId: 'first-credential', expectedRevision: created.snapshot.configRevision,
      draft: { ...draft, enabled: true, manualModelIds: ['manual'] }, method: 'api-key', apiKey: 'first-synthetic-key' });
    const refreshed = await f.service.request({ type: 'refresh', operationId: 'populate-cache', id: 'local' });
    assert.ok(refreshed.draft?.models.some(model => model.id === 'old-account-model'));
    const preferences = await f.service.request({ type: 'read-provider', operationId: 'preference-read', id: 'local' });
    const savedPrefs = await f.service.request({ type: 'save', operationId: 'save-preferences', expectedRevision: preferences.snapshot.configRevision,
      draft: { ...preferences.draft!, manualModelIds: ['manual', 'preference-only'], models: preferences.draft!.models.map(model =>
        model.id === 'old-account-model' ? { ...model, visible: 'no' as const } : model) } });
    assert.equal(savedPrefs.status, 'ok');
    fail = true;
    const replaced = await f.service.request({ type: 'connect', operationId: 'replace-credential', expectedRevision: savedPrefs.snapshot.configRevision,
      draft: { ...preferences.draft!, manualModelIds: ['manual', 'preference-only'], models: preferences.draft!.models.map(model =>
        model.id === 'old-account-model' ? { ...model, visible: 'no' as const } : model) }, method: 'api-key', apiKey: 'second-synthetic-key' });
    assert.equal(replaced.status, 'ok');
    const cache = await loadDiscoveryCache(f.modelCacheDir, 'local', JSON.stringify({ api: draft.api, baseUrl: draft.baseUrl,
      credentialRef: { source: 'saved' }, integration: 'openai' }));
    assert.equal(cache, undefined);
    const failedRefresh = await f.service.request({ type: 'refresh', operationId: 'failed-after-reconnect', id: 'local' });
    assert.equal(failedRefresh.status, 'error');
    assert.equal(failedRefresh.snapshot.providers.find(provider => provider.id === 'local')?.discovery, 'error');
    const after = await f.service.request({ type: 'read-provider', operationId: 'after-reconnect', id: 'local' });
    assert.deepEqual(after.draft?.manualModelIds, ['manual', 'preference-only']);
    const savedConfig = await readFile(f.configFile, 'utf8');
    assert.match(savedConfig, /old-account-model:\s*\{\s*visible: false/);
  } finally { await f.close(); }
});
