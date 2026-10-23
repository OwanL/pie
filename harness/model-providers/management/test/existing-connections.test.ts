import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../service';
import { isProviderManagementSnapshot } from '../validation';

test('empty management configuration lists existing connections offline and refuses implicit migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-existing-'));
  const configFile = join(dir, 'providers.yaml');
  let inventoryError = false;
  const forbidden = () => { throw new Error('Forbidden credential/network access'); };
  const service = createProviderManagementService({ configFile, modelCacheDir: join(dir, 'cache'),
    auth: { definitions: () => [], listSavedCredentialIds: async () => [], getApiKey: forbidden,
      discoveryBaseUrl: forbidden, stageOAuthLogin: forbidden, saveCredential: forbidden }, fetch: forbidden,
    existingConnections: async () => {
      if (inventoryError) throw new Error('private auth failure');
      return ['oauth', 'apikey', 'env', 'custom'].map(id => ({ id, modelCount: 2, credentials: id === 'env' ? 'environment' as const : 'saved' as const }));
    } });
  try {
    const read = await service.request({ type: 'read', operationId: 'read' });
    assert.equal(read.snapshot.providers.length, 4);
    assert.equal(isProviderManagementSnapshot(read.snapshot), true);
    assert.ok(read.snapshot.providers.every(row => row.origin === 'existing' && row.readOnly));
    for (const type of ['read-provider', 'refresh'] as const) {
      assert.equal((await service.request({ type, operationId: type, id: 'oauth' })).status, 'conflict');
    }
    const draft = { originalId: null, id: 'oauth', enabled: true, api: 'openai-completions', baseUrl: 'https://example.com', credentialSource: 'default' as const, environmentName: '', models: [] };
    assert.equal((await service.request({ type: 'save', operationId: 'save', expectedRevision: null, draft })).status, 'conflict');
    await assert.rejects(stat(configFile), { code: 'ENOENT' });
    await writeFile(configFile, JSON.stringify({ version: 1, providers: { oauth: { enabled: false, manualModels: ['managed'] } } }));
    const collision = await service.request({ type: 'read', operationId: 'collision' });
    assert.equal(collision.snapshot.providers.filter(row => row.id === 'oauth').length, 1);
    assert.equal(collision.snapshot.providers.find(row => row.id === 'oauth')?.origin, 'managed');
    inventoryError = true;
    const failed = await service.request({ type: 'read', operationId: 'failure' });
    assert.equal(failed.status, 'error');
    assert.equal(failed.snapshot.loaded, false);
    assert.match(failed.snapshot.error ?? '', /Existing provider connections could not be loaded/);
    assert.ok(!JSON.stringify(failed).includes('private auth failure'));
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
