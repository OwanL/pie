import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createCoordinatorProviderManagement } from '../provider-management';
import type { ColdCoordinatorSdkModule } from '../../lib/sdk-integration/sdk';
import type { RuntimeSnapshot } from '../../../model-providers/runtime/contracts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pie-coordinator-async-admission-'));
  const previous = process.env.PIE_PROVIDER_CONFIG_DIR;
  process.env.PIE_PROVIDER_CONFIG_DIR = dir;
  const credentialFile = join(dir, 'credentials.json');
  const scope = 'e3d095be-4c86-48b3-82ec-2fb8213e646c';
  const writeScope = (value: string | null) => writeFile(`${credentialFile}.runtime-scopes.json`,
    JSON.stringify({ synthetic: value }));
  await writeScope(scope);
  await writeFile(join(dir, 'providers.yaml'), 'version: 1\nproviders: {}\n');
  const initialized = gate();
  const storage = gate();
  t.after(storage.release);
  const state = { opens: 0, present: true, errors: false };
  const forbidden = () => { throw new Error('synchronous credential access or resolution forbidden'); };
  const manager = await createCoordinatorProviderManagement({
    createProviderManagementAuth: () => ({ definitions: () => [], listSavedCredentialIds: async () => [], getApiKey: forbidden }),
    AuthStorage: {
      create: forbidden,
      createAsync: async () => {
        state.opens++;
        initialized.release();
        await storage.promise;
        const present = state.present;
        return { get: () => present ? { type: 'api_key', key: 'synthetic-private-key' } : undefined,
          drainErrors: () => state.errors ? [new Error('private-storage-details')] : [], getApiKey: forbidden };
      },
      inMemory: () => ({ hasAuth: () => false }),
    },
  } as unknown as ColdCoordinatorSdkModule, () => {});
  t.after(async () => {
    manager.dispose();
    if (previous === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const snapshot: RuntimeSnapshot = { version: 1, generation: 'synthetic-generation', models: ['one', 'two'].map(id => ({
    providerId: 'synthetic', id, enabled: true, visible: true, subagentEligible: true,
    credential: { source: 'saved', provider: 'synthetic', scope },
    model: { id, provider: 'synthetic', name: id, api: 'openai-completions', baseUrl: 'https://synthetic.invalid',
      input: ['text'], reasoning: false, contextWindow: 4096, maxTokens: 512,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  })) };
  return { manager, snapshot, state, storage, initialized, dir, writeScope };
}

test('coordinator admission awaits one fresh store per invocation without blocking timers or resolving keys', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let settled = false;
  const admission = f.manager.admittedRuntimeModels(f.snapshot).finally(() => { settled = true; });
  await f.initialized.promise;
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(f.state.opens, 1);
  f.storage.release();
  assert.deepEqual((await admission).map(model => model.id), ['one', 'two']);
  f.state.present = false;
  assert.deepEqual(await f.manager.admittedRuntimeModels(f.snapshot), []);
  assert.equal(f.state.opens, 2, 'later admissions cannot reuse authoritative credential inventory');
});

for (const invalidation of ['epoch', 'removal', 'dispose'] as const) {
  test(`coordinator admission rechecks ${invalidation} after awaited credential initialization`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const admission = f.manager.admittedRuntimeModels(f.snapshot);
    const checked = invalidation === 'dispose'
      ? assert.rejects(admission, /Provider management is unavailable/)
      : admission.then(models => { assert.deepEqual(models, []); });
    await f.initialized.promise;
    if (invalidation === 'epoch') await f.writeScope(null);
    if (invalidation === 'removal') await writeFile(join(f.dir, 'providers.yaml'), 'version: 1\nproviders:\n  synthetic:\n    enabled: false\n    removed: true\n');
    if (invalidation === 'dispose') f.manager.dispose();
    f.storage.release();
    await checked;
  });
}

test('coordinator admission reports storage errors instead of authoritative empty inventory', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.state.errors = true;
  f.storage.release();
  await assert.rejects(f.manager.admittedRuntimeModels(f.snapshot), error => {
    assert.equal((error as Error).message, 'Provider credential storage failed');
    return true;
  });
});
