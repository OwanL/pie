import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type { NativeRuntimeModel } from '../../runtime/contracts';
import { createProviderRuntimeServices } from '../../runtime/services';
import { loadSdk, type SourceArtifactSdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture.js';
import { createCoordinatorProviderManagement } from '../../../agent-processes/coordinator/provider-management';

test('native existing Settings/Remove preserve transport policy and isolate private credential persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-management-overlay-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  const fetch = globalThis.fetch;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  globalThis.fetch = (() => { throw new Error('unexpected network'); }) as typeof globalThis.fetch;
  let service: Awaited<ReturnType<typeof createCoordinatorProviderManagement>> | undefined;
  try {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
    const modelsFile = join(dir, 'models.json');
    const authFile = join(dir, 'native-auth.json');
    const modelsText = JSON.stringify({ providers: {
      fixture: { api: 'openai-completions', baseUrl: 'https://native.invalid/v1', models: [{ id: 'plain', contextWindow: 12345, maxTokens: 777 }] },
      guarded: { api: 'openai-completions', baseUrl: 'https://guarded.invalid/v1', headers: { 'X-Private': 'synthetic-header' }, models: [{ id: 'guarded-model', headers: { 'X-Private': 'synthetic-header' } }] },
    } });
    await writeFile(modelsFile, modelsText);
    const auth = sdk.AuthStorage.create(authFile);
    auth.set('fixture', { type: 'api_key', key: 'synthetic-fixture-key' });
    auth.set('unrelated', { type: 'api_key', key: 'synthetic-unrelated-key' });
    const models = sdk.ModelRegistry.create(auth, modelsFile);
    const nativeModels = models.getAll().filter(model => ['fixture', 'guarded'].includes(model.provider)) as unknown as NativeRuntimeModel[];
    assert.equal(nativeModels.length, 2);
    service = await createCoordinatorProviderManagement(sdk as unknown as Parameters<typeof createCoordinatorProviderManagement>[0], () => {}, () => ({ auth, models, canForgetCredential: true }) as unknown as ReturnType<NonNullable<Parameters<typeof createCoordinatorProviderManagement>[2]>>);
    const detail = await service.request({ type: 'read-provider', operationId: 'settings', id: 'fixture' });
    assert.equal(detail.status, 'ok');
    assert.ok(detail.draft);
    assert.equal(detail.draft.credentialSource, 'legacy');
    assert.equal(detail.draft.baseUrl, '');
    assert.equal(detail.draft.api, '');
    const saved = await service.request({ type: 'save', operationId: 'save-settings', expectedRevision: detail.snapshot.configRevision,
      draft: { ...detail.draft, models: detail.draft.models.map(model => ({ ...model, visible: 'no', subagentEligible: 'no' })) } });
    assert.equal(saved.status, 'ok');
    const projection = await service.previewRuntimeProjection(nativeModels);
    assert.ok(projection);
    const plain = projection.models.find(row => row.providerId === 'fixture');
    assert.ok(plain);
    assert.equal(plain.visible, false);
    assert.equal(plain.subagentEligible, false);
    assert.deepEqual(plain.credential, { source: 'legacy' });
    assert.equal(plain.model?.baseUrl, 'https://native.invalid/v1');
    assert.equal(plain.model?.api, 'openai-completions');
    const guarded = projection.models.find(row => row.providerId === 'guarded');
    assert.ok(!JSON.stringify(projection).includes('synthetic-header'));
    const yaml = await readFile(join(dir, 'providers.yaml'), 'utf8');
    assert.ok(!yaml.includes('baseUrl'));
    assert.ok(!yaml.includes('api:'));
    assert.ok(!yaml.includes('synthetic-fixture-key'));
    assert.deepEqual(sdk.AuthStorage.create(authFile).get?.('fixture'), { type: 'api_key', key: 'synthetic-fixture-key' });
    const removed = await service.request({ type: 'remove', operationId: 'remove', expectedRevision: saved.snapshot.configRevision, id: 'fixture' });
    assert.equal(removed.status, 'ok');
    assert.equal(removed.snapshot.providers.some(row => row.id === 'fixture'), false);
    assert.equal((await service.previewRuntimeProjection(nativeModels))?.models.some(row => row.providerId === 'fixture'), false);
    const reopened = sdk.AuthStorage.create(authFile);
    assert.equal(reopened.get?.('fixture'), undefined);
    assert.deepEqual(reopened.get?.('unrelated'), { type: 'api_key', key: 'synthetic-unrelated-key' });
    assert.equal(await readFile(modelsFile, 'utf8'), modelsText);
    assert.match(await readFile(join(dir, 'providers.yaml'), 'utf8'), /removed: true/);
    // Native registry keeps request headers privately rather than on getAll() rows.
    // Prove final native request composition, not absence of private headers on catalog rows.
    const nativeGuarded = models.find('guarded', 'guarded-model');
    assert.ok(nativeGuarded);
    const nativeHeaders = await models.getApiKeyAndHeaders(nativeGuarded);
    assert.equal(nativeHeaders.ok && nativeHeaders.headers?.['X-Private'], 'synthetic-header');
    assert.ok(guarded?.model);
    assert.equal(guarded.rejection, undefined);
    const runtime = createProviderRuntimeServices(sdk, projection, auth, {
      credentialFile: join(dir, 'unused-managed-auth.json'), legacyModelsFile: modelsFile,
    });
    const selected = runtime.modelRegistry.find('guarded', 'guarded-model');
    assert.ok(selected);
    const requestAuth = await runtime.modelRegistry.getApiKeyAndHeaders(selected);
    assert.equal(requestAuth.ok, true);
    assert.equal(requestAuth.headers?.['X-Private'], 'synthetic-header');
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      const request = new Request(input, init);
      assert.equal(request.url, 'https://guarded.invalid/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('X-Private'), 'synthetic-header');
      assert.equal(((await request.json()) as { model: string }).model, 'guarded-model');
      return new Response(JSON.stringify({ error: { message: 'synthetic unauthorized' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const response = await stream(selected as any, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, {
      apiKey: requestAuth.apiKey ?? 'unused', headers: requestAuth.headers,
    }).result();
    assert.equal(requests, 1);
    assert.equal(response.stopReason, 'error');
    assert.match(response.errorMessage ?? '', /401|synthetic unauthorized/);
    assert.ok(!JSON.stringify(saved.snapshot).includes('synthetic-header'));
    assert.ok(!yaml.includes('synthetic-header'));
  } finally {
    service?.dispose();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
