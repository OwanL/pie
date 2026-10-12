import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiProviderAuth, type NativeAuthStorage } from '../../management/pi-auth';
import type { StagedProviderCredential } from '../../management/auth-port';

test('saved epochs invalidate replacement and in-flight refresh without fallback; fresh native storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-auth-scopes-'));
  try {
    let credential: StagedProviderCredential | undefined;
    let finish: (() => void) | undefined;
    let calls = 0;
    let creations = 0;
    const create = (): NativeAuthStorage<{ provider: string; baseUrl: string }> => {
      creations++;
      const snapshot = credential;
      return {
        getOAuthProviders: () => [{ id: 'oauth', name: 'OAuth', modifyModels: models => models.map(model => ({ ...model, baseUrl: 'https://native.example' })) }],
        get: () => snapshot,
        set: (_id, value) => { credential = value; },
        drainErrors: () => [], login: async () => {},
        getApiKey: async (_id, options) => {
          assert.deepEqual(options, { includeFallback: false }); calls++;
          if (snapshot?.type === 'api_key') return snapshot.key;
          await new Promise<void>(resolve => { finish = resolve; });
          credential = { type: 'oauth', access: 'refreshed', refresh: 'private', expires: 100 };
          return 'refreshed';
        },
      };
    };
    const file = join(dir, 'auth.json');
    const auth = createPiProviderAuth({ create, inMemory: create }, file);
    assert.equal(await auth.getRuntimeCredentialScope!('oauth'), undefined);
    await assert.rejects(auth.getRuntimeApiKey!('oauth', 'missing'));
    assert.equal(calls, 0);
    credential = { type: 'oauth', access: 'old', refresh: 'private', expires: 0 };
    const scope = (await auth.getRuntimeCredentialScope!('oauth'))!;
    assert.match(scope, /^[0-9a-f-]{36}$/);
    const pending = auth.getRuntimeApiKey!('oauth', scope);
    finish!();
    assert.equal(await pending, 'refreshed');
    assert.equal(await auth.getRuntimeCredentialScope!('oauth'), scope);
    assert.equal(JSON.parse(await readFile(`${file}.runtime-scopes.json`, 'utf8')).oauth, scope);
    assert.deepEqual(await auth.runtimeModels!('oauth', [{ provider: 'oauth', baseUrl: 'https://original.example' }]), [{ provider: 'oauth', baseUrl: 'https://native.example' }]);
    const stale = auth.getRuntimeApiKey!('oauth', scope);
    await auth.saveCredential('oauth', { type: 'api_key', key: 'replacement' });
    finish!();
    await assert.rejects(stale, error => error instanceof Error && error.message === 'Provider credential storage failed' && !('cause' in error));
    const next = (await auth.getRuntimeCredentialScope!('oauth'))!;
    assert.notEqual(next, scope);
    await assert.rejects(auth.getRuntimeApiKey!('oauth', scope));
    credential = { type: 'api_key', key: 'fresh' };
    assert.equal(await auth.getApiKey('oauth'), 'fresh');
    assert.equal(await auth.getRuntimeApiKey!('oauth', next), 'fresh');
    assert.ok(creations > 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sidecar failure prevents native credential write; native failure keeps invalidation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-auth-scopes-'));
  try {
    const file = join(dir, 'auth.json');
    let writes = 0;
    let fail = false;
    const create = (): NativeAuthStorage<{ provider: string; baseUrl: string }> => ({
      getOAuthProviders: () => [], get: () => ({ type: 'api_key', key: 'private' }),
      set: () => { writes++; if (fail) throw new Error('private-secret'); },
      drainErrors: () => [], login: async () => {}, getApiKey: async () => 'ambient-secret',
    });
    const auth = createPiProviderAuth({ create, inMemory: create }, file);
    const old = await auth.getRuntimeCredentialScope!('api');
    fail = true;
    await assert.rejects(auth.saveCredential('api', { type: 'api_key', key: 'replacement' }), /Provider credential storage failed/);
    assert.equal(writes, 1);
    assert.notEqual(await auth.getRuntimeCredentialScope!('api'), old);
    await rm(`${file}.runtime-scopes.json`);
    await mkdir(`${file}.runtime-scopes.json`);
    await assert.rejects(auth.saveCredential('api', { type: 'api_key', key: 'replacement' }));
    assert.equal(writes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
