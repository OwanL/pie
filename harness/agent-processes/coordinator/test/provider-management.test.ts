import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler';
import { isCoordinatorOperationAllowed } from '../coordinator-operations';
import { BackendError } from '../server-io';

test('coordinator injects public native models without resolving OAuth credentials', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createCoordinatorProviderManagement } = await import('../provider-management');
  const dir = await mkdtemp(join(tmpdir(), 'pie-coordinator-shipped-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  let service: Awaited<ReturnType<typeof createCoordinatorProviderManagement>> | undefined;
  const providers: string[] = [];
  try {
    await writeFile(join(dir, 'providers.yaml'), JSON.stringify({ version: 1, providers: {
      'openai-codex': { enabled: true, credentialRef: { source: 'saved' } }
    } }));
    service = await createCoordinatorProviderManagement({
      createProviderManagementAuth: () => ({
        definitions: () => [{ id: 'openai-codex', name: 'Codex', kind: 'native', api: 'openai-codex-responses',
          baseUrl: 'https://example.com', authMethods: ['oauth'], discovery: 'unsupported' }],
        hasSavedCredential: () => true,
        getApiKey: async () => { throw new Error('must not resolve credentials'); },
        discoveryBaseUrl: async () => { throw new Error('must not resolve account endpoint'); }
      }),
      getProviderManagementModels: (provider: string) => {
        providers.push(provider);
        return [{ provider, id: 'public', name: 'Public Native', api: 'openai-codex-responses',
          baseUrl: 'https://example.com', input: ['text'], reasoning: true, contextWindow: 1000, maxTokens: 100,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }];
      }
    } as unknown as import('../../lib/sdk-integration/sdk').ColdCoordinatorSdkModule, () => {});
    const read = await service.request({ type: 'read', operationId: 'read' });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.snapshot.providers.map(p => [p.id, p.modelCount]), [['openai-codex', 1]]);
    const detail = await service.request({ type: 'read-provider', operationId: 'detail', id: 'openai-codex' });
    assert.equal(detail.draft!.models[0].name, 'Public Native');
    assert.ok(providers.every(id => id === 'openai-codex'));
  } finally {
    service?.dispose();
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

function privateDeps() {
  let validated = 0;
  let calls = 0;
  const deps = {
    onRequestValidated: () => { validated++; },
    providerManagement: { request: async () => { calls++; return { private: true }; } },
    getSessionContext: () => { throw new Error('must not activate a session'); },
  } as unknown as BackendRequestHandlerDeps;
  return { deps, counts: () => ({ validated, calls }) };
}

test('providers.manage is a runtime-free coordinator operation', () => {
  assert.equal(isCoordinatorOperationAllowed('providers.manage', undefined), true);
});

test('providers.manage rejects invalid params before private initialization', async () => {
  const harness = privateDeps();
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'invalid', method: 'providers.manage', params: { type: 'read', unexpected: 'secret' },
  }), (error: unknown) => error instanceof BackendError && error.message === 'Invalid provider management request.');
  assert.deepEqual(harness.counts(), { validated: 0, calls: 0 });
});

test('providers.manage settles validation and does not consult a runtime', async () => {
  const harness = privateDeps();
  assert.deepEqual(await handleBackendRequest(harness.deps, {
    id: 'private', method: 'providers.manage', params: { type: 'read', operationId: 'load-private' },
  }), { private: true });
  assert.deepEqual(harness.counts(), { validated: 1, calls: 1 });
});

test('providers.manage unwired and private failures are opaque', async () => {
  for (const wired of [false, true]) {
    const harness = privateDeps();
    harness.deps.providerManagement = wired ? { request: async () => { throw new Error('private credential contents'); } } : undefined;
    await assert.rejects(handleBackendRequest(harness.deps, {
      id: 'unavailable', method: 'providers.manage', params: { type: 'read', operationId: 'load-private' },
    }), (error: unknown) => error instanceof BackendError && error.message === 'Provider management is unavailable.');
    assert.equal(harness.counts().validated, 1);
  }
});
