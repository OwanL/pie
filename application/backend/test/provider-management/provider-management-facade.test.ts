import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../../session-actions/service';
import type { ProviderManagementRequest, ProviderManagementResponse } from '../../../../harness/model-providers/management/contracts';

function facade(
  request: (method: string, params: unknown, options: { timeoutMs: number }) => Promise<unknown>,
  getGeneration: () => number = () => 7,
): SessionService {
  const service = Object.create(SessionService.prototype) as SessionService & { backend: unknown };
  service.backend = { request, getGeneration };
  return service;
}

const connect = {
  type: 'connect',
  operationId: 'provider-connect-op',
  expectedRevision: null,
  draft: {
    originalId: null,
    id: 'local',
    enabled: true,
    api: 'openai-completions',
    baseUrl: 'https://provider.invalid/v1',
    credentialSource: 'default',
    environmentName: '',
    models: [],
  },
  method: 'api-key',
  apiKey: 'must-not-be-copied-to-cancel',
} as const satisfies ProviderManagementRequest;

test('failed connect best-effort cancels its original operation in the same generation', async () => {
  const originalFailure = new Error('connect transport failed');
  const calls: { method: string; params: unknown; options: { timeoutMs: number } }[] = [];
  const service = facade(async (method, params, options) => {
    calls.push({ method, params, options });
    if (calls.length === 1) throw originalFailure;
    return {};
  });

  await assert.rejects(service.providerManagement(connect), (error) => error === originalFailure);
  assert.deepEqual(calls, [
    { method: 'providers.manage', params: connect, options: { timeoutMs: 10 * 60_000 } },
    {
      method: 'providers.manage',
      params: { type: 'cancel', operationId: 'provider-connect-op:cancel', targetOperationId: 'provider-connect-op' },
      options: { timeoutMs: 20_000 },
    },
  ]);
  assert.equal(JSON.stringify(calls[1].params).includes(connect.apiKey), false);
});

test('failed connect does not cancel a replacement backend generation', async () => {
  let generation = 7;
  const calls: unknown[] = [];
  const service = facade(async (_method, params) => {
    calls.push(params);
    generation = 8;
    throw new Error('original failure');
  }, () => generation);

  await assert.rejects(service.providerManagement(connect), /original failure/);
  assert.deepEqual(calls, [connect]);
});

test('cancel failure does not replace connect failure; other provider operations stay unchanged', async () => {
  const connectFailure = new Error('connect failed');
  const calls: unknown[] = [];
  const service = facade(async (_method, params) => {
    calls.push(params);
    if (calls.length === 1) throw connectFailure;
    throw new Error('cancel failed');
  });
  await assert.rejects(service.providerManagement(connect), (error) => error === connectFailure);

  const response = { operationId: 'read-op', status: 'ok' } as ProviderManagementResponse;
  const otherCalls: { method: string; params: unknown; options: { timeoutMs: number } }[] = [];
  const otherService = facade(async (method, params, options) => {
    otherCalls.push({ method, params, options });
    return response;
  });
  const requests: ProviderManagementRequest[] = [
    { type: 'read', operationId: 'read-op' },
    { type: 'save', operationId: 'save-op', expectedRevision: null, draft: connect.draft },
    { type: 'refresh', operationId: 'refresh-op', id: 'local' },
  ];
  for (const request of requests) assert.equal(await otherService.providerManagement(request), response);
  assert.deepEqual(otherCalls, requests.map((request) => ({
    method: 'providers.manage', params: request, options: { timeoutMs: 20_000 },
  })));
});
