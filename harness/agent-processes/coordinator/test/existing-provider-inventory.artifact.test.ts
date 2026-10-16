import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSdk } from '../../lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../lib/sdk-integration/test/source-fixture.js';
import { createCoordinatorProviderManagement } from '../provider-management';

test('native keyless models.json identities allow Settings/Remove but deny connection edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-keyless-inventory-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  let service: Awaited<ReturnType<typeof createCoordinatorProviderManagement>> | undefined;
  const forbidden = () => { throw new Error('forbidden credential read/write'); };
  const beforeEnv = { ...process.env };
  try {
    const modelsFile = join(dir, 'models.json');
    const credentialsFile = join(dir, 'credentials.json');
    const modelsText = JSON.stringify({ providers: { local: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', models: [{ id: 'local-model' }] } } });
    const credentialsText = JSON.stringify({ fake: { type: 'api_key', key: 'fixture-only' } });
    await writeFile(modelsFile, modelsText);
    await writeFile(credentialsFile, credentialsText);
    const sdk = await loadSdk(sourceDescriptor.sdkPath, { ...sourceLoadMode, surface: 'cold' });
    const auth = { getOAuthProviders: () => [], list: () => ['fake'], hasAuth: (id: string) => id === 'fake',
      getAuthStatus: (id: string) => ({ configured: id === 'fake', source: id === 'fake' ? 'stored' : undefined }),
      get: forbidden, getAll: forbidden, getApiKey: forbidden };
    const models = sdk.ModelRegistry.create(auth, modelsFile);
    assert.deepEqual(models.getConfiguredProviderIds!(), ['local']);
    const detached = models.getConfiguredProviderIds!();
    detached.push('not-configured');
    assert.deepEqual(models.getConfiguredProviderIds!(), ['local']);
    // Override-only dynamic identities participate without requiring credentials.
    (models as unknown as { registerProvider(id: string, config: { baseUrl: string }): void }).registerProvider('dynamic', { baseUrl: 'https://synthetic.invalid' });
    assert.deepEqual(models.getConfiguredProviderIds!(), ['local', 'dynamic']);
    (models as unknown as { unregisterProvider(id: string): void }).unregisterProvider('dynamic');
    assert.deepEqual(models.getConfiguredProviderIds!(), ['local']);
    service = await createCoordinatorProviderManagement({ ...sdk, createProviderManagementAuth: () => ({
      definitions: () => [], hasSavedCredential: () => false, getApiKey: forbidden,
      saveCredential: forbidden, discoveryBaseUrl: forbidden,
    }) }, () => {}, () => ({ auth, models }));
    const read = await service.request({ type: 'read', operationId: 'read' });
    const row = read.snapshot.providers.find(row => row.id === 'local');
    assert.equal(row?.origin, 'existing');
    assert.equal(row?.readOnly, false);
    assert.deepEqual(row?.capabilities, { settings: true, editConnection: false, remove: true, forgetCredential: false });
    assert.equal(row?.credentials, 'none');
    assert.equal(row?.modelCount, 1);
    const settings = await service.request({ type: 'read-provider', operationId: 'edit', id: 'local' });
    assert.equal(settings.status, 'ok');
    assert.ok(settings.draft);
    const draft = { originalId: null, id: 'local', enabled: true, api: 'openai-completions', baseUrl: 'https://synthetic.invalid', credentialSource: 'default' as const, environmentName: '', models: [] };
    assert.equal((await service.request({ type: 'save', operationId: 'duplicate-add', expectedRevision: null, draft })).status, 'conflict');
    assert.equal((await service.request({ type: 'save', operationId: 'edit-save', expectedRevision: null, draft: { ...draft, originalId: 'local' } })).status, 'conflict');
    assert.equal(await readFile(modelsFile, 'utf8'), modelsText);
    assert.equal(await readFile(credentialsFile, 'utf8'), credentialsText);
    assert.equal((await service.request({ type: 'connect', operationId: 'connect-denied', expectedRevision: read.snapshot.configRevision,
      draft: { ...draft, originalId: 'local' }, method: 'api-key', apiKey: 'synthetic' })).status, 'conflict');
    const saved = await service.request({ type: 'save', operationId: 'settings-save', expectedRevision: settings.snapshot.configRevision,
      draft: { ...settings.draft, models: settings.draft.models.map(model => ({ ...model, visible: 'no' })) } });
    assert.equal(saved.status, 'ok');
    const removed = await service.request({ type: 'remove', operationId: 'remove', expectedRevision: saved.snapshot.configRevision, id: 'local' });
    assert.equal(removed.status, 'ok');
    assert.equal(removed.snapshot.providers.some(provider => provider.id === 'local'), false);
    assert.match(await readFile(join(dir, 'providers.yaml'), 'utf8'), /removed: true/);
    assert.equal(await readFile(modelsFile, 'utf8'), modelsText);
    assert.equal(await readFile(credentialsFile, 'utf8'), credentialsText);
    assert.deepEqual({ ...process.env }, beforeEnv);
    await writeFile(modelsFile, '{invalid');
    models.refresh!();
    assert.deepEqual(models.getConfiguredProviderIds!(), []);
    assert.ok(models.getError!());
    await writeFile(modelsFile, modelsText);
    models.refresh!();
    assert.deepEqual(models.getConfiguredProviderIds!(), ['local']);
    assert.equal(models.getError!(), undefined);
  } finally {
    service?.dispose();
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
