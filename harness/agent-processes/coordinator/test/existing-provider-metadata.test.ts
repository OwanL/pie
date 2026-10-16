import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureExistingProviderConnections } from '../provider-management';

test('legacy inventory uses metadata only, including stored identities absent from catalog and environment/custom auth', () => {
  const forbidden = () => { throw new Error('Credential resolution forbidden'); };
  const authority = {
    auth: { list: () => ['oauth', 'apikey'], get: forbidden, getAll: forbidden, getApiKey: forbidden,
      getAuthStatus: (id: string) => ({ configured: ['oauth', 'apikey'].includes(id), source: id === 'env' ? 'environment' : ['oauth', 'apikey'].includes(id) ? 'stored' : undefined }),
      hasAuth: (id: string) => id === 'env', drainErrors: () => [] },
    models: { getAll: () => [
      { provider: 'env', id: 'one', name: 'Environment model', input: ['text'], reasoning: true,
        contextWindow: 8192, maxTokens: 1024, headers: { Authorization: 'Bearer secret' }, apiKey: 'secret', customMetadata: 'secret' },
      { provider: 'custom', id: 'two' }, { provider: 'unused', id: 'three' },
    ], getAvailable: forbidden, find: forbidden, getApiKeyForProvider: forbidden,
      hasConfiguredAuth: (model: { provider: string }) => model.provider === 'custom' },
  };
  const rows = captureExistingProviderConnections(authority);
  assert.deepEqual(rows, [
    { id: 'oauth', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'saved' },
    { id: 'apikey', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'saved' },
    { id: 'env', models: { one: { name: 'Environment model', input: ['text'], reasoning: true,
      contextWindow: 8192, maxTokens: 1024, pricing: undefined } }, canForgetCredential: false, modelCount: 1, credentials: 'environment' },
    { id: 'custom', models: { two: { name: 'two', input: undefined, reasoning: undefined,
      contextWindow: undefined, maxTokens: undefined, pricing: undefined } }, canForgetCredential: false, modelCount: 1, credentials: 'default' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /Authorization|Bearer secret|apiKey|customMetadata/u);
  const ownerManaged = captureExistingProviderConnections({ ...authority, canForgetCredential: true,
    auth: { ...authority.auth, remove: () => {}, get: (id: string) => id === 'apikey' ? { type: 'api_key', key: 'secret' } : undefined } });
  assert.equal(ownerManaged.find(row => row.id === 'apikey')?.canForgetCredential, true);
  assert.equal(ownerManaged.find(row => row.id === 'oauth')?.canForgetCredential, false);
  assert.throws(() => captureExistingProviderConnections({ ...authority, auth: { ...authority.auth, drainErrors: () => [new Error('private')] } }), /Existing metadata unavailable/);
});
