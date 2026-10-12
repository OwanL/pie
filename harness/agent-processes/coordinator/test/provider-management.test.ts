import assert from 'node:assert/strict';
import test from 'node:test';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler';
import { isCoordinatorOperationAllowed } from '../coordinator-operations';
import { BackendError } from '../server-io';

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
