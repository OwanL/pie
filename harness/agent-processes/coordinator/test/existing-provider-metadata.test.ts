import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureExistingProviderConnections, forgetExistingProviderCredential } from '../provider-management';

test('legacy inventory uses metadata only, including stored identities absent from catalog and environment/custom auth', async () => {
  const forbidden = () => { throw new Error('Credential resolution forbidden'); };
  const authority = {
    auth: { reloadAsync: async () => {}, reload: forbidden, setAsync: forbidden, removeAsync: forbidden,
      list: () => ['oauth', 'apikey'], get: forbidden, getAll: forbidden, getApiKey: forbidden,
      getAuthStatus: (id: string) => ({ configured: ['oauth', 'apikey'].includes(id), source: id === 'env' ? 'environment' : ['oauth', 'apikey'].includes(id) ? 'stored' : undefined }),
      hasAuth: (id: string) => id === 'env', drainErrors: () => [] },
    models: { getAll: () => [
      { provider: 'env', id: 'one', name: 'Environment model', input: ['text'], reasoning: true,
        contextWindow: 8192, maxTokens: 1024, headers: { Authorization: 'Bearer secret' }, apiKey: 'secret', customMetadata: 'secret' },
      { provider: 'custom', id: 'two' }, { provider: 'unused', id: 'three' },
    ], getAvailable: forbidden, find: forbidden, getApiKeyForProvider: forbidden,
      hasConfiguredAuth: (model: { provider: string }) => model.provider === 'custom' },
  };
  const rows = await captureExistingProviderConnections(authority);
  assert.deepEqual(rows, [
    { id: 'oauth', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'saved' },
    { id: 'apikey', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'saved' },
    { id: 'env', models: { one: { name: 'Environment model', input: ['text'], reasoning: true,
      contextWindow: 8192, maxTokens: 1024, pricing: undefined } }, canForgetCredential: false, modelCount: 1, credentials: 'environment' },
    { id: 'custom', models: { two: { name: 'two', input: undefined, reasoning: undefined,
      contextWindow: undefined, maxTokens: undefined, pricing: undefined } }, canForgetCredential: false, modelCount: 1, credentials: 'default' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /Authorization|Bearer secret|apiKey|customMetadata/u);
  const ownerManaged = await captureExistingProviderConnections({ ...authority, canForgetCredential: true,
    auth: { ...authority.auth, removeAsync: async () => {}, get: (id: string) => id === 'apikey' ? { type: 'api_key' as const, key: 'secret' } : undefined } });
  assert.equal(ownerManaged.find(row => row.id === 'apikey')?.canForgetCredential, true);
  assert.equal(ownerManaged.find(row => row.id === 'oauth')?.canForgetCredential, false);
  await assert.rejects(captureExistingProviderConnections({ ...authority, auth: { ...authority.auth, drainErrors: () => [new Error('private')] } }), /Existing metadata unavailable/);
});

test('legacy inventory and forgetting await native storage and never fall back to synchronous locking', { timeout: 15_000 }, async () => {
  const forbidden = () => { throw new Error('synchronous credential storage forbidden'); };
  let releaseReload!: () => void;
  let releaseRemove!: () => void;
  let reads = 0;
  let removed = '';
  const reload = new Promise<void>(resolve => { releaseReload = resolve; });
  const remove = new Promise<void>(resolve => { releaseRemove = resolve; });
  const authority = { canForgetCredential: true, models: { getAll: () => [], getAvailable: forbidden, find: forbidden }, auth: {
    reload: forbidden, remove: forbidden, setAsync: forbidden,
    reloadAsync: async () => { await reload; },
    removeAsync: async (id: string) => { await remove; removed = id; },
    list: () => { reads++; return ['synthetic']; },
    get: () => ({ type: 'api_key' as const, key: 'synthetic' }),
    getAuthStatus: (id: string) => ({ configured: id === 'synthetic', source: 'stored' }),
  } };
  const capture = captureExistingProviderConnections(authority);
  let forgotten = false;
  const forgetting = forgetExistingProviderCredential(authority, 'synthetic').then(() => { forgotten = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(forgotten, false);
  releaseReload();
  assert.equal((await capture).find(row => row.id === 'synthetic')?.canForgetCredential, true);
  assert.equal(forgotten, false);
  releaseRemove();
  await forgetting;
  assert.equal(removed, 'synthetic');
  await assert.rejects(captureExistingProviderConnections({ ...authority, auth: { ...authority.auth, reloadAsync: undefined! } }), /Existing metadata unavailable/);
  await assert.rejects(forgetExistingProviderCredential({ ...authority, auth: { ...authority.auth, removeAsync: undefined! } }, 'synthetic'), /Existing credential removal is unavailable/);
});
