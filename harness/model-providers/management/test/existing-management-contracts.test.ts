import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPiProviderAuth, isRuntimeCredentialScopeCurrent } from '../pi-auth';
import assert from 'node:assert/strict';
import { parseProviderConfig } from '../../catalog/provider-config';
import { isProviderManagementRequest, isProviderManagementSnapshot } from '../validation';
import { forgetExistingProviderCredential } from '../../../agent-processes/coordinator/provider-management';
import type { SdkAuthStorage } from '../../../agent-processes/lib/sdk-integration/sdk';
import type { StagedProviderCredential } from '../auth-port';

test('managed native removal targets explicit store and revokes old runtime scope', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-provider-remove-'));
  const file = path.join(dir, 'credentials.json');
  const entries = new Map([['old', { type: 'api_key' as const, key: 'synthetic' }]]);
  const opened: string[] = [];
  const native = { getOAuthProviders: () => [], get: (id: string) => entries.get(id), list: () => [...entries.keys()],
    setAsync: async () => {}, removeAsync: async (id: string) => { entries.delete(id); }, drainErrors: () => [],
    login: async () => {}, getApiKey: async () => 'synthetic' };
  try {
    const auth = createPiProviderAuth({ createAsync: async p => { opened.push(p); return native; }, inMemory: () => native }, file);
    const scope = await auth.getRuntimeCredentialScope!('old');
    assert.equal(isRuntimeCredentialScopeCurrent(file, 'old', scope), true);
    await auth.removeCredential!('old');
    assert.equal(entries.has('old'), false);
    assert.equal(isRuntimeCredentialScopeCurrent(file, 'old', scope), false);
    assert.ok(opened.every(p => p === file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy overlays and disabled removal tombstones are schema validated', () => {
  assert.equal(parseProviderConfig('version: 1\nproviders:\n  old:\n    enabled: true\n    credentialRef: { source: legacy }\n').status, 'valid');
  for (const enabled of [true, false]) {
    assert.equal(parseProviderConfig(`version: 1\nproviders:\n  old:\n    enabled: ${enabled}\n    removed: true\n`).status, enabled ? 'invalid' : 'valid');
  }
  assert.equal(parseProviderConfig('version: 1\nproviders:\n  old: { enabled: false, removed: false }\n').status, 'invalid');
});
test('snapshot tombstones are optional but validated as explicit provider identities', () => {
  const snapshot = { revision: 0, configRevision: null, loaded: true, providers: [], definitions: [], protocols: [] };
  assert.equal(isProviderManagementSnapshot(snapshot), true);
  assert.equal(isProviderManagementSnapshot({ ...snapshot, removedProviderIds: ['old'] }), true);
  for (const removedProviderIds of [null, 'old', [''], [3], {}]) {
    assert.equal(isProviderManagementSnapshot({ ...snapshot, removedProviderIds }), false);
  }
});

test('private remove requires exact operation, revision and provider identity', () => {
  const remove = { type: 'remove', operationId: 'op', expectedRevision: null, id: 'old' };
  assert.equal(isProviderManagementRequest(remove), true);
  for (const bad of [{ ...remove, expectedRevision: undefined }, { ...remove, id: '' }, { ...remove, apiKey: 'secret' }, { ...remove, forgetCredential: false }]) assert.equal(isProviderManagementRequest(bad), false);
});
test('legacy forgetting fails closed outside proved authority and removes only named saved entry', async () => {
  const removed: string[] = [];
  let reloads = 0;
  const entries = new Map<string, StagedProviderCredential>([
    ['old', { type: 'api_key', key: 'synthetic-old' }],
    ['other', { type: 'api_key', key: 'synthetic-other' }],
  ]);
  const auth: SdkAuthStorage = {
    get: id => entries.get(id), list: () => [...entries.keys()],
    reloadAsync: async () => { reloads++; },
    setAsync: async (id, credential, options) => { options?.signal?.throwIfAborted(); entries.set(id, structuredClone(credential)); },
    removeAsync: async (id, options) => { options?.signal?.throwIfAborted(); entries.delete(id); removed.push(id); },
  };
  const authority = { auth, models: { getAvailable: () => [], find: () => undefined } };
  await assert.rejects(forgetExistingProviderCredential(authority, 'old'));
  assert.deepEqual(removed, []); assert.equal(reloads, 0);
  await forgetExistingProviderCredential({ ...authority, canForgetCredential: true }, 'old');
  assert.deepEqual(removed, ['old']); assert.deepEqual(auth.list(), ['other']);
  await assert.rejects(forgetExistingProviderCredential({ ...authority, canForgetCredential: true, auth: { ...authority.auth, drainErrors: () => [new Error('synthetic')] } }, 'other'));
  assert.deepEqual(removed, ['old']); assert.equal(reloads, 2);
  assert.deepEqual(auth.get?.('other'), { type: 'api_key', key: 'synthetic-other' });
});
