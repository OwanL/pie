import assert from 'node:assert/strict';
import test from 'node:test';
import { captureExistingProviderConnections } from '../provider-management';
import type { SdkModelRegistry } from '../../lib/sdk-integration/sdk';

test('explicit keyless configuration is inventoried without secret-bearing model or credential reads', async () => {
  const forbidden = () => { throw new Error('forbidden secret read'); };
  const rows = await captureExistingProviderConnections({
    auth: { reloadAsync: async () => {}, reload: forbidden, setAsync: forbidden, removeAsync: forbidden, list: () => ['saved'], getOAuthProviders: () => [{ id: 'registered', name: 'Registered' }],
      getAuthStatus: id => ({ configured: id !== 'local', source: id === 'saved' ? 'stored' : undefined }),
      hasAuth: id => id !== 'local', get: forbidden, getAll: forbidden, getApiKey: forbidden },
    models: { getConfiguredProviderIds: () => ['local'], getAvailable: forbidden,
      getAll: () => [{ id: 'local-model', provider: 'local', name: 'Local model', input: ['text'], reasoning: true,
        contextWindow: 4096, maxTokens: 512, baseUrl: 'must-not-be-read', headers: { Authorization: 'Bearer secret' },
        apiKey: 'secret', customMetadata: 'must-not-be-read' }], find: forbidden } as SdkModelRegistry,
  });
  assert.deepEqual(rows.find(row => row.id === 'registered'), {
    id: 'registered', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'default',
  });
  assert.deepEqual(rows.find(row => row.id === 'saved'), {
    id: 'saved', models: {}, canForgetCredential: false, modelCount: 0, credentials: 'saved',
  });
  assert.deepEqual(rows.find(row => row.id === 'local'), {
    id: 'local', models: { 'local-model': { name: 'Local model', input: ['text'], reasoning: true,
      contextWindow: 4096, maxTokens: 512, pricing: undefined } },
    canForgetCredential: false, modelCount: 1, credentials: 'none',
  });
  assert.doesNotMatch(JSON.stringify(rows), /Authorization|Bearer secret|apiKey|customMetadata|must-not-be-read/u);
});
