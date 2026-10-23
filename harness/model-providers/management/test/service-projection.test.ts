import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProviderManagementService } from '../service';
import type { ProviderManagementAuthPort, ProviderOAuthCallbacks } from '../auth-port';
import type { ProviderManagementSnapshot } from '../contracts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Expected causal boundary was not reached');
    await delay(5);
  }
}
const template = { originalId: null, id: 'local', enabled: false, api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1',
  credentialSource: 'default' as const, environmentName: '', models: [], manualModelIds: ['model'] };
async function fixture(inherited = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pie-service-projection-'));
  const snapshots: ProviderManagementSnapshot[] = [];
  const delivered: number[] = [];
  let batches = 0;
  let presence: () => Promise<readonly string[]> = async () => [];
  const auth: ProviderManagementAuthPort = {
    definitions: () => [{ id: 'local', name: 'Local', kind: 'custom', api: template.api, baseUrl: template.baseUrl,
      authMethods: ['oauth', 'api-key'], discovery: 'unsupported' }],
    listSavedCredentialIds: () => { batches++; return presence(); },
    stageOAuthLogin: async () => { throw new Error('Unexpected OAuth'); },
    saveCredential: async () => {}, removeCredential: async () => {},
    getApiKey: async () => { throw new Error('Unexpected key'); }, discoveryBaseUrl: async (_, url) => url,
  };
  const configFile = join(directory, 'providers.yaml');
  const service = createProviderManagementService({ configFile, modelCacheDir: join(directory, 'cache'), auth,
    existingConnections: async () => inherited ? [{ id: 'local', modelCount: 1, credentials: 'default', models: { model: { name: 'Native model' } } }] : [],
    onSnapshot: view => { snapshots.push(view); delivered.push(view.revision); }, fetch: async () => { throw new Error('Unexpected network'); } });
  return { service, auth, configFile, modelCacheDir: join(directory, 'cache'), snapshots, delivered, batches: () => batches,
    setPresence: (value: typeof presence) => { presence = value; },
    gatePresence(skip = 0) {
      const entered = deferred(), release = deferred<readonly string[]>();
      presence = async () => {
        if (skip-- > 0) return [];
        presence = async () => [];
        entered.resolve(); return release.promise;
      };
      return { entered: entered.promise, release: () => release.resolve([]) };
    },
    close: async () => { service.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

for (const route of ['managed', 'inherited', 'new-definition', 'removed-provider', 'refresh'] as const) {
  test(`gated ${route} response creates its draft and config revision together after a competing edit`, { timeout: 15_000 }, async () => {
    const f = await fixture(route === 'inherited');
    let gate: ReturnType<typeof f.gatePresence> | undefined;
    try {
      if (route === 'managed' || route === 'refresh') {
        assert.equal((await f.service.request({ type: 'save', operationId: 'seed', expectedRevision: null, draft: template })).status, 'ok');
      }
      if (route === 'removed-provider') await writeFile(f.configFile, 'version: 1\nproviders:\n  local: { enabled: false, removed: true }\n');
      const initial = await f.service.request({ type: 'read-provider', operationId: 'initial', id: 'local' });
      // load publishes first; stop the response's own batch, after the draft route
      // has been selected and the DAO released, not merely an earlier load event.
      gate = f.gatePresence(1);
      const older = f.service.request({ type: route === 'refresh' ? 'refresh' : 'read-provider', operationId: 'older', id: 'local' });
      await gate.entered;
      const edited = { ...initial.draft!, enabled: true,
        manualModelIds: route === 'inherited' ? initial.draft!.manualModelIds : ['model'],
        models: [{ id: 'model', name: 'Model', visible: 'no' as const, subagentEligible: 'no' as const, pricing: { kind: 'unknown' as const, tiered: false } }] };
      const competing = route === 'removed-provider' || route === 'new-definition'
        ? f.service.request({ type: 'connect', operationId: 'newer', expectedRevision: initial.snapshot.configRevision, draft: edited, method: 'api-key', apiKey: 'synthetic' })
        : f.service.request({ type: 'save', operationId: 'newer', expectedRevision: initial.snapshot.configRevision, draft: edited });
      await until(async () => /visible: false/.test(await readFile(f.configFile, 'utf8').catch(() => '')));
      // The write completed while projection was blocked: projection must not hold the DAO.
      gate.release();
      const [late, saved] = await Promise.all([older, competing]);
      assert.equal(saved.status, 'ok'); assert.equal(late.status, 'ok');
      assert.equal(late.snapshot.configRevision, saved.snapshot.configRevision);
      assert.equal(late.draft!.models.find(model => model.id === 'model')!.visible, 'no');
      assert.equal(late.draft!.enabled, true);
      assert.equal(late.draft!.originalId, 'local');
      if (route === 'inherited') assert.equal(late.draft!.credentialSource, 'legacy');
      // Re-saving the older response with its newly attached revision cannot undo the newer edit.
      const replay = await f.service.request({ type: 'save', operationId: 'replay', expectedRevision: late.snapshot.configRevision, draft: late.draft! });
      assert.equal(replay.status, 'ok'); assert.match(await readFile(f.configFile, 'utf8'), /visible: false/);
    } finally { gate?.release(); await f.close(); }
  });
}

test('one fresh batch supplies credential labels and capabilities, failures remain explicit and recover', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const seed = await f.service.request({ type: 'save', operationId: 'seed', expectedRevision: null, draft: template });
    await f.service.request({ type: 'save', operationId: 'other-row', expectedRevision: seed.snapshot.configRevision, draft: { ...template, id: 'other' } });
    f.setPresence(async () => ['local']);
    const before = f.batches();
    const present = await f.service.request({ type: 'read-provider', operationId: 'present', id: 'local' });
    assert.equal(f.batches() - before, 2, 'Exactly one batch per load event and response, never per row/field');
    assert.equal(present.snapshot.providers[0].credentials, 'saved');
    assert.equal(present.snapshot.providers[0].capabilities!.forgetCredential, true);
    f.setPresence(async () => { throw new Error('PRIVATE storage path'); });
    const beforeFailure = f.batches();
    const failed = await f.service.request({ type: 'read-provider', operationId: 'failure', id: 'local' });
    assert.equal(failed.status, 'error'); assert.equal(failed.snapshot.loaded, false);
    assert.deepEqual(failed.snapshot.providers.map(row => row.id), ['local', 'other']);
    assert.equal(f.batches() - beforeFailure, 2, 'Failure must not recursively retry projection');
    assert.match(failed.snapshot.error!, /credential presence could not be loaded/);
    assert.equal(JSON.stringify(failed).includes('PRIVATE'), false); assert.equal(failed.draft, undefined);
    f.setPresence(async () => []);
    const recovered = await f.service.request({ type: 'read-provider', operationId: 'recovery', id: 'local' });
    assert.equal(recovered.status, 'ok'); assert.equal(recovered.snapshot.loaded, true); assert.equal(recovered.snapshot.error, undefined);
    assert.equal(recovered.snapshot.providers[0].credentials, 'default');
    assert.equal(recovered.snapshot.providers[0].capabilities!.forgetCredential, false);
  } finally { await f.close(); }
});

test('blocked prompt projection cannot delay cancellation or resurrect auth; events and responses stay ordered', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const started = deferred<ProviderOAuthCallbacks>();
  const gate = f.gatePresence();
  try {
    f.auth.stageOAuthLogin = async (_, callbacks) => {
      callbacks.onAuth({ url: 'https://login.invalid' });
      const prompt = callbacks.onPrompt({ message: 'Code' });
      started.resolve(callbacks); await prompt;
      throw new Error('Cancelled');
    };
    const login = f.service.request({ type: 'connect', operationId: 'login', expectedRevision: null, draft: template, method: 'oauth' })
      .then(response => { f.delivered.push(response.snapshot.revision); return response; });
    const callbacks = await started.promise;
    await gate.entered;
    const cancelled = f.service.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'login' })
      .then(response => { f.delivered.push(response.snapshot.revision); return response; });
    await until(() => callbacks.signal!.aborted);
    callbacks.onAuth({ url: 'https://late.invalid' });
    gate.release();
    const cancelResponse = await cancelled;
    const terminal = await login;
    assert.equal(cancelResponse.status, 'ok'); assert.equal(terminal.status, 'cancelled');
    const views = [...f.snapshots, cancelResponse.snapshot, terminal.snapshot];
    assert.ok(views.every(view => !view.auth && !view.authBrowser));
    assert.equal(new Set(views.map(view => view.revision)).size, views.length);
    assert.ok(f.delivered.every((revision, index) => index === 0 || revision > f.delivered[index - 1]), 'Events and response observers receive strictly ordered revisions');
  } finally { gate.release(); await f.close(); }
});

test('removal commits behind a blocked response without a late row or draft resurrection', { timeout: 15_000 }, async () => {
  const f = await fixture(true);
  let gate: ReturnType<typeof f.gatePresence> | undefined;
  try {
    const initial = await f.service.request({ type: 'read-provider', operationId: 'initial', id: 'local' });
    const published = f.snapshots.length;
    gate = f.gatePresence(1);
    const older = f.service.request({ type: 'read-provider', operationId: 'older', id: 'local' });
    await gate.entered;
    const removed = deferred();
    f.auth.removeCredential = async () => { removed.resolve(); };
    const removal = f.service.request({ type: 'remove', operationId: 'remove', id: 'local', expectedRevision: initial.snapshot.configRevision });
    await removed.promise;
    assert.match(await readFile(f.configFile, 'utf8'), /removed: true/);
    gate.release();
    const [late, complete] = await Promise.all([older, removal]);
    assert.equal(complete.status, 'ok'); assert.deepEqual(late.snapshot.providers, []);
    assert.equal(late.snapshot.configRevision, complete.snapshot.configRevision);
    assert.equal(late.draft!.originalId, null); assert.equal(late.draft!.credentialSource, 'default');
    assert.ok(f.snapshots.slice(published + 1).every(view => view.providers.length === 0));
    const replay = await f.service.request({ type: 'save', operationId: 'replay', expectedRevision: late.snapshot.configRevision, draft: late.draft! });
    assert.equal(replay.status, 'conflict', 'Only explicit Add may clear a removal tombstone');
  } finally { gate?.release(); await f.close(); }
});

test('disposal reaches credential initialization signal and prevents a late canonical write', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const entered = deferred<AbortSignal>(), release = deferred();
  let writes = 0;
  try {
    f.auth.saveCredential = async (_, __, signal) => {
      assert.ok(signal); entered.resolve(signal); await release.promise;
      signal.throwIfAborted(); writes++;
    };
    const pending = f.service.request({ type: 'connect', operationId: 'connect', expectedRevision: null, draft: template, method: 'api-key', apiKey: 'synthetic' });
    const signal = await entered.promise;
    f.service.dispose(); assert.equal(signal.aborted, true); release.resolve();
    const response = await pending;
    assert.equal(response.status, 'cancelled'); assert.equal(writes, 0);
    assert.match(response.snapshot.error!, /Configuration was saved/);
  } finally { release.resolve(); await f.close(); }
});

for (const action of ['cancel', 'dispose'] as const) for (const boundary of ['key', 'endpoint'] as const) test(`${action} during ${boundary} resolution cannot start the next discovery effect`, { timeout: 15_000 }, async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  let endpoints = 0, listings = 0;
  try {
    f.auth.definitions = () => []; // definitions are captured at construction, so use an unknown managed id below.
    f.auth.getApiKey = async () => { if (boundary === 'key') { entered.resolve(); await release.promise; } return 'synthetic'; };
    f.auth.discoveryBaseUrl = async (_, url) => { endpoints++; if (boundary === 'endpoint') { entered.resolve(); await release.promise; } return url; };
    // Separate service uses a discoverable custom id and the same private auth fixture.
    const discovery = createProviderManagementService({ configFile: f.configFile, modelCacheDir: f.modelCacheDir, auth: f.auth,
      fetch: async () => { listings++; return Response.json({ data: [] }); } });
    try {
      await writeFile(f.configFile, JSON.stringify({ version: 1, providers: { custom: { enabled: true, api: template.api, baseUrl: template.baseUrl, credentialRef: { source: 'saved' } } } }));
      const refresh = discovery.request({ type: 'refresh', operationId: 'refresh', id: 'custom' });
      await entered.promise;
      if (action === 'cancel') {
        const cancel = await discovery.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'refresh' });
        assert.equal(cancel.status, 'ok');
      } else discovery.dispose();
      assert.equal((await refresh).status, 'cancelled');
      release.resolve();
      // Drain the awaited resolver's continuation without depending on a short elapsed-time threshold.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(endpoints, boundary === 'key' ? 0 : 1); assert.equal(listings, 0);
    } finally { discovery.dispose(); }
  } finally { release.resolve(); await f.close(); }
});
