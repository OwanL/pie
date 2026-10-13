import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../service';
import type { ProviderManagementAuthPort, StagedProviderCredential } from '../auth-port';
import type { ProviderDefinition } from '../contracts';
import { availableProviderRuntimeModels } from '../../runtime/services';
import type { NativeRuntimeModel } from '../../runtime/contracts';

const secret = 'synthetic-provider-secret-not-real';
const definitions: ProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI', kind: 'openai', api: 'openai-responses', baseUrl: 'https://openai.invalid/v1', authMethods: ['api-key'], discovery: 'openai' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://anthropic.invalid', authMethods: ['api-key'], discovery: 'unsupported' },
  { id: 'github-copilot', name: 'Copilot', kind: 'copilot', api: 'openai-completions', baseUrl: 'https://copilot.invalid', authMethods: ['oauth'], discovery: 'copilot' },
  { id: 'custom-test', name: 'Custom', kind: 'custom', api: 'openai-completions', baseUrl: 'https://custom.invalid/v1', authMethods: ['api-key'], discovery: 'openai' },
];

for (const definition of definitions) test(`${definition.id}: service setup, persisted reopen, discovery/manual metadata and offline admission`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-backend-flows-'));
  const configFile = join(dir, 'providers.yaml'), credentialFile = join(dir, 'auth.json');
  const saved: Record<string, StagedProviderCredential> = {};
  const publicValues: unknown[] = [];
  let requests = 0, failing = false;
  const auth: ProviderManagementAuthPort = {
    // Custom connection deliberately exercises the unregistered compatible-provider path.
    definitions: () => definitions.filter(d => d.kind !== 'custom'),
    hasSavedCredential: id => !!saved[id],
    stageOAuthLogin: async (_, callbacks) => {
      callbacks.onDeviceCode({ userCode: 'PUBLIC-CODE', verificationUri: 'https://login.invalid' });
      callbacks.onProgress?.(secret);
      return { type: 'oauth', access: secret, refresh: secret, expires: 0 };
    },
    saveCredential: async (id, value) => { saved[id] = value; await writeFile(`${credentialFile}.runtime-scopes.json`, JSON.stringify({ [id]: 'epoch' })); },
    getApiKey: async id => { assert.ok(saved[id]); return secret; },
    getRuntimeCredentialScope: async id => saved[id] ? 'epoch' : undefined,
    discoveryBaseUrl: async (_, url) => definition.id === 'github-copilot' ? 'https://account.invalid' : url,
  };
  const options = { configFile, modelCacheDir: join(dir, 'cache'), auth, onSnapshot: (value: unknown) => publicValues.push(value),
    fetch: async (url: any, init?: RequestInit) => {
      requests++;
      assert.equal(String(url), `${definition.id === 'github-copilot' ? 'https://account.invalid' : definition.baseUrl}/models`);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
      if (definition.id === 'github-copilot') assert.equal(new Headers(init?.headers).get('Copilot-Integration-Id'), 'vscode-chat');
      if (failing) return new Response(secret, { status: 401 });
      // Empty Copilot account listing is authoritative; manual models remain explicit user configuration.
      return Response.json({ data: definition.id === 'github-copilot' ? [] : [{ id: 'listed' }] });
    } };
  let service = createProviderManagementService(options);
  try {
    const detail = await service.request({ type: 'read-provider', operationId: 'initial', id: definition.id });
    const draft = { ...detail.draft!, api: definition.api, baseUrl: definition.baseUrl, enabled: true, manualModelIds: ['manual'] };
    const rejected = await service.request({ type: 'connect', operationId: 'unsupported-auth', expectedRevision: null,
      draft, method: definition.id === 'github-copilot' ? 'api-key' : 'oauth', apiKey: secret });
    assert.equal(rejected.status, 'error'); publicValues.push(rejected);
    if (definition.id !== 'github-copilot') {
      const empty = await service.request({ type: 'connect', operationId: 'empty-key', expectedRevision: null, draft, method: 'api-key', apiKey: ' ' });
      assert.equal(empty.status, 'error'); publicValues.push(empty);
    }
    await assert.rejects(readFile(configFile));
    const native: NativeRuntimeModel = { provider: definition.id, id: 'manual', name: 'Manual', api: definition.api, baseUrl: definition.baseUrl,
      input: ['text'], reasoning: false, contextWindow: 4096, maxTokens: 512, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const missing = await service.request({ type: 'save', operationId: 'missing', expectedRevision: null, draft: { ...draft, credentialSource: 'saved' } });
    assert.equal(missing.status, 'ok');
    const before = (await service.captureRuntimeProjection([native], [native]))!;
    const admission = (snapshot: typeof before) => availableProviderRuntimeModels(snapshot, { credentialFile, savedCredential: id => saved[id], legacyHasAuth: () => false, defaultHasAuth: () => false });
    assert.deepEqual(admission(before), []);
    const connected = await service.request({ type: 'connect', operationId: 'connect', expectedRevision: missing.snapshot.configRevision,
      draft: { ...draft, originalId: definition.id }, method: definition.id === 'github-copilot' ? 'oauth' : 'api-key', apiKey: secret });
    assert.equal(connected.status, 'ok'); publicValues.push(connected);
    const refresh = await service.request({ type: 'refresh', operationId: 'refresh', id: definition.id });
    assert.equal(refresh.status, 'ok');
    assert.equal(refresh.draft!.models.find(m => m.id === 'manual')?.pricing.kind, 'unknown');
    if (definition.discovery === 'unsupported') assert.equal(requests, 0);
    else {
      assert.ok(requests > 0);
      if (definition.id !== 'github-copilot') assert.ok(refresh.draft!.models.some(m => m.id === 'listed'));
      failing = true;
      const failure = await service.request({ type: 'refresh', operationId: 'unauthorized', id: definition.id });
      assert.equal(failure.status, 'error'); publicValues.push(failure);
      failing = false;
    }
    const captured = (await service.captureRuntimeProjection([native], [native]))!;
    assert.equal(admission(captured).length, 1);
    delete saved[definition.id]; assert.deepEqual(admission(captured), []);
    saved[definition.id] = { type: 'api_key', key: secret };
    await writeFile(`${credentialFile}.runtime-scopes.json`, JSON.stringify({ [definition.id]: 'replacement' }));
    assert.deepEqual(admission(captured), []);
    service.dispose(); service = createProviderManagementService(options);
    const reopened = await service.request({ type: 'read-provider', operationId: 'reopen', id: definition.id });
    assert.equal(reopened.draft?.credentialSource, 'saved');
    assert.ok(reopened.draft?.models.some(m => m.id === 'manual'));
    publicValues.push(reopened);
    assert.equal(JSON.stringify(publicValues).includes(secret), false);
    assert.equal((await readFile(configFile, 'utf8')).includes(secret), false);
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});

for (const outcome of ['failure', 'cancel'] as const) test(`Copilot OAuth ${outcome}: no credentials/config commit or secret publication`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-copilot-auth-'));
  let ready!: () => void, finish!: () => void, writes = 0;
  const started = new Promise<void>(r => { ready = r; });
  const values: unknown[] = [];
  const auth: ProviderManagementAuthPort = { definitions: () => definitions, hasSavedCredential: () => false,
    stageOAuthLogin: async (_, cb) => {
      cb.onDeviceCode({ userCode: 'PUBLIC', verificationUri: 'https://login.invalid' }); ready();
      await new Promise<void>(r => { finish = r; });
      if (outcome === 'failure') throw new Error(secret);
      return { type: 'oauth', access: secret, refresh: secret, expires: 0 };
    }, saveCredential: async () => { writes++; }, getApiKey: async () => undefined, discoveryBaseUrl: async (_, url) => url };
  const configFile = join(dir, 'providers.yaml');
  const service = createProviderManagementService({ configFile, modelCacheDir: join(dir, 'cache'), auth, onSnapshot: v => values.push(v), fetch: async () => { throw new Error('Network forbidden'); } });
  try {
    const read = await service.request({ type: 'read-provider', operationId: 'read', id: 'github-copilot' });
    const pending = service.request({ type: 'connect', operationId: 'oauth', expectedRevision: null, draft: { ...read.draft!, enabled: true }, method: 'oauth' });
    await started;
    if (outcome === 'cancel') await service.request({ type: 'cancel', operationId: 'cancel', targetOperationId: 'oauth' });
    finish();
    const result = await pending; values.push(result);
    assert.equal(result.status, outcome === 'cancel' ? 'cancelled' : 'error');
    assert.equal(result.snapshot.auth, undefined); assert.equal(result.snapshot.authBrowser, undefined);
    assert.equal(writes, 0); await assert.rejects(readFile(configFile));
    assert.equal(JSON.stringify(values).includes(secret), false);
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
