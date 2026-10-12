/**
 * PROOF ONLY — offline tests for the provider-management compatibility proof.
 *
 * Covers the adapted upstream Pi 1.1.0 (abe508e1b89912adde45528136c3221eb69acdd7)
 * management semantics bridged to the current local pi-ai interfaces:
 * auth resolution with one in-memory credential per provider and explicit
 * missing-auth rejection (no silent ambient fallback), shared request
 * preparation with documented header/env/baseUrl precedence and old option
 * retention, summary preparation in the exact old compaction-auth shape, and
 * per-provider catalog refresh with generation/cancellation fencing behind
 * immutable last-known-good snapshots.
 *
 * Deterministic: deferred promises instead of timers; no network, filesystem,
 * or ambient credential access; transports and catalog fetchers are fakes.
 * Nothing here is a production claim; see proof/provider-management.ts for the
 * upstream MIT attribution.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  InMemoryCredentialStore,
  ManagedProviderAuthError,
  ManagedProviderManager,
  type ManagedCatalogProvider,
  type ManagedCatalogRefreshContext,
  type ManagedCatalogSnapshot,
  type ManagedCredentialStore,
  type SimpleTransport,
  prepareManagedRequest,
  prepareManagedSummaryRequest,
  resolveManagedAuth,
} from '../proof/provider-management.js';

function makeModel(overrides: Partial<Model<Api>> = {}, provider = 'test-provider'): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider,
    baseUrl: 'https://default.example/api',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  };
}

function makeContext(): Context {
  return { systemPrompt: 'system', messages: [] };
}

class RecordingTransport implements SimpleTransport {
  readonly calls: Array<{ model: Model<Api>; context: Context; options?: SimpleStreamOptions }> = [];

  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    this.calls.push({ model, context, options });
    return createAssistantMessageEventStream();
  }

  get dispatchCount(): number {
    return this.calls.length;
  }
}

function makeProvider(providerId: string, overrides: Partial<ManagedCatalogProvider> = {}): ManagedCatalogProvider {
  return {
    id: providerId,
    name: providerId,
    auth: {},
    transport: new RecordingTransport(),
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Fixture {
  store: InMemoryCredentialStore;
  transport: RecordingTransport;
  provider: ManagedCatalogProvider;
  manager: ManagedProviderManager;
}

function makeFixture(providerOverrides: Partial<ManagedCatalogProvider> = {}, providerId = 'test-provider'): Fixture {
  const store = new InMemoryCredentialStore();
  const transport = new RecordingTransport();
  const provider = makeProvider(providerId, {
    auth: { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'] } },
    transport,
    ...providerOverrides,
  });
  const manager = new ManagedProviderManager({ providers: [provider], credentials: store });
  return { store, transport: provider.transport as RecordingTransport, provider, manager };
}

// ---------------------------------------------------------------------------
// Auth resolution precedence and explicit missing-auth rejection
// ---------------------------------------------------------------------------

test('an explicit request key selects a request-scoped credential without stored account env', () => {
  const credentials = new InMemoryCredentialStore();
  credentials.write('provider', {
    type: 'api_key', key: 'stored-key', env: { REGION: 'stored', STORED_ACCOUNT: 'stored-account' },
  });

  const overridden = resolveManagedAuth(
    'provider',
    { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], ambientEnv: () => 'ambient-key' } },
    { credentials },
    { apiKey: 'request-key', env: { REGION: 'request' } },
  );
  // Match both current and upstream resolveProviderAuth: a new explicit key
  // must not inherit another credential's stored account/environment fields.
  assert.deepEqual(overridden, {
    apiKey: 'request-key',
    env: { REGION: 'request' },
    source: 'request',
    baseUrl: undefined,
  });
});

test('auth resolution uses the stored credential and merges env with request overrides winning per name', () => {
  const credentials = new InMemoryCredentialStore();
  credentials.write('provider', {
    type: 'api_key',
    key: 'stored-key',
    env: { REGION: 'stored', ACCOUNT: 'account' },
  });

  const resolved = resolveManagedAuth(
    'provider',
    { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], ambientEnv: () => 'ambient-key' } },
    { credentials },
    { env: { REGION: 'request' } },
  );

  assert.deepEqual(resolved, {
    apiKey: 'stored-key',
    env: { REGION: 'request', ACCOUNT: 'account' },
    source: 'stored',
    baseUrl: undefined,
  });
});

test('ambient sources are consulted only when nothing is stored, with the request env overlay first', () => {
  const credentials = new InMemoryCredentialStore();
  const method = { apiKeyEnvNames: ['MISSING_NAME', 'TEST_API_KEY'], ambientEnv: () => 'ambient-key' };

  const byInjectedAmbient = resolveManagedAuth('provider', { apiKey: method }, { credentials });
  assert.equal(byInjectedAmbient?.apiKey, 'ambient-key');
  assert.equal(byInjectedAmbient?.source, 'ambient');

  // The request env overlay participates in ambient discovery before the
  // injected ambient lookup, even for names earlier in the list.
  const byOverlay = resolveManagedAuth(
    'provider',
    { apiKey: method },
    { credentials },
    { env: { MISSING_NAME: 'overlay-key' } },
  );
  assert.equal(byOverlay?.apiKey, 'overlay-key');
  assert.equal(byOverlay?.source, 'ambient');

  // A stored credential owns the provider: ambient is never consulted.
  credentials.write('provider', { type: 'api_key', key: 'stored-key' });
  assert.equal(resolveManagedAuth('provider', { apiKey: method }, { credentials })?.source, 'stored');
});

test('stored unsupported or failed credentials do not fall back to ambient sources', () => {
  const credentials = new InMemoryCredentialStore();
  const ambientMethod = { apiKeyEnvNames: ['TEST_API_KEY'], ambientEnv: () => 'ambient-key' };

  credentials.write('provider', { type: 'oauth' });
  assert.equal(
    resolveManagedAuth('provider', { apiKey: ambientMethod }, { credentials }),
    undefined,
    'a stored credential without a matching handler must resolve to nothing, not ambient',
  );

  credentials.write('provider', { type: 'api_key', key: '' });
  assert.equal(
    resolveManagedAuth('provider', { apiKey: ambientMethod }, { credentials }),
    undefined,
    'a stored-but-failed api-key credential must resolve to nothing, not ambient',
  );

  credentials.write('provider', { type: 'oauth' });
  assert.equal(
    resolveManagedAuth('provider', { apiKey: ambientMethod }, { credentials }, { env: { TEST_API_KEY: 'ambient-key' } }),
    undefined,
    'the env overlay must not resurrect an unsupported stored credential',
  );
});

// ---------------------------------------------------------------------------
// Missing/rejected auth rejects before any dispatch
// ---------------------------------------------------------------------------

test('dispatch rejects missing auth before any transport dispatch', () => {
  const { manager, transport } = makeFixture();

  assert.throws(() => manager.dispatchSimple(makeModel(), makeContext()), ManagedProviderAuthError);
  assert.throws(() => manager.prepareSummaryRequest(makeModel()), ManagedProviderAuthError);
  assert.equal(transport.dispatchCount, 0, 'missing auth must reject before ANY dispatch');
});

test('stored failed and unsupported credentials reject dispatch without ambient fallback', () => {
  const failedKey = makeFixture();
  failedKey.store.write('test-provider', { type: 'api_key', key: '' });
  assert.throws(() => failedKey.manager.dispatchSimple(makeModel(), makeContext()), ManagedProviderAuthError);
  assert.equal(failedKey.transport.dispatchCount, 0);

  const unsupported = makeFixture();
  unsupported.store.write('test-provider', { type: 'oauth' });
  assert.throws(() => unsupported.manager.dispatchSimple(makeModel(), makeContext()), ManagedProviderAuthError);
  assert.throws(() => unsupported.manager.prepareSummaryRequest(makeModel()), ManagedProviderAuthError);
  assert.equal(unsupported.transport.dispatchCount, 0);
});

test('logout clears the credential so dispatch rejects again', () => {
  const { manager, store, transport } = makeFixture();
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });
  manager.dispatchSimple(makeModel(), makeContext());
  assert.equal(transport.dispatchCount, 1);

  manager.setCredential('test-provider', undefined);
  assert.throws(() => manager.dispatchSimple(makeModel(), makeContext()), /Provider is not configured/);
  assert.equal(transport.dispatchCount, 1);
});

// ---------------------------------------------------------------------------
// Shared preparation: ordinary and summary parity, precedence, old options
// ---------------------------------------------------------------------------

test('ordinary dispatch and summary preparation agree on auth fields, env, headers, and endpoint', () => {
  const { manager, transport, store } = makeFixture({
    headers: { 'X-Provider-Header': 'from-provider' },
    auth: { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], baseUrl: 'https://account.example/api' } },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key', env: { REGION: 'stored-region' } });

  const model = makeModel({ headers: { 'X-Model-Header': 'from-model' } });
  const context = makeContext();
  const options = { headers: { 'X-Request-Header': 'from-request' }, env: { REGION: 'request-region' } };

  manager.dispatchSimple(model, context, options);
  assert.equal(transport.dispatchCount, 1);
  const dispatched = transport.calls[0];

  const summary = manager.prepareSummaryRequest(model, options);
  assert.deepEqual(summary.auth, {
    apiKey: 'stored-key',
    headers: {
      'X-Model-Header': 'from-model',
      'X-Provider-Header': 'from-provider',
      'X-Request-Header': 'from-request',
    },
    env: { REGION: 'request-region' },
  });
  assert.deepEqual(dispatched.options?.apiKey, summary.auth.apiKey);
  assert.deepEqual(dispatched.options?.env, summary.auth.env);
  assert.deepEqual(dispatched.options?.headers, summary.auth.headers);
  assert.deepEqual(dispatched.model, summary.model);
  assert.equal(dispatched.model.baseUrl, 'https://account.example/api');
});

test('summary preparation exposes the exact old compaction-auth key shape', () => {
  const { manager, store } = makeFixture();
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const summary = manager.prepareSummaryRequest(makeModel(), {});
  assert.deepEqual(Object.keys(summary.auth).sort(), ['apiKey', 'env', 'headers']);
  assert.equal(summary.auth.apiKey, 'stored-key');
  assert.equal(summary.model.provider, 'test-provider');
});

test('headers merge with case-insensitive precedence: request > provider > model', () => {
  const credentials = new InMemoryCredentialStore();
  credentials.write('p', { type: 'api_key', key: 'k' });
  const provider = {
    id: 'p',
    headers: { 'X-Shared': 'provider', 'X-Provider-Only': 'provider' },
    auth: { apiKey: {} },
  };
  const model = makeModel({ headers: { 'x-shared': 'model', 'X-Model-Only': 'model' } }, 'p');

  const prepared = prepareManagedRequest(provider, model, { headers: { 'X-SHARED': 'request' } }, { credentials });
  assert.deepEqual(prepared.requestOptions.headers, {
    'X-SHARED': 'request',
    'X-Provider-Only': 'provider',
    'X-Model-Only': 'model',
  });
});

test('environment merges per name with request overrides winning over the stored credential env', () => {
  const credentials = new InMemoryCredentialStore();
  credentials.write('p', { type: 'api_key', key: 'k', env: { SHARED: 'stored', STORED_ONLY: 'v' } });
  const provider = { id: 'p', auth: { apiKey: {} } };

  const withoutRequestEnv = prepareManagedRequest(provider, makeModel({}, 'p'), {}, { credentials });
  assert.deepEqual(withoutRequestEnv.requestOptions.env, { SHARED: 'stored', STORED_ONLY: 'v' });

  const withRequestEnv = prepareManagedRequest(
    provider,
    makeModel({}, 'p'),
    { env: { SHARED: 'request', REQUEST_ONLY: 'v' } },
    { credentials },
  );
  assert.deepEqual(withRequestEnv.requestOptions.env, {
    SHARED: 'request',
    STORED_ONLY: 'v',
    REQUEST_ONLY: 'v',
  });
});

test('old request callbacks and options are preserved untouched on the prepared request', () => {
  const { manager, transport, store } = makeFixture();
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const onPayload = () => undefined;
  const onResponse = () => undefined;
  const signal = new AbortController().signal;
  const options = {
    temperature: 0.5,
    maxTokens: 42,
    signal,
    transport: 'websocket' as const,
    cacheRetention: 'long' as const,
    sessionId: 'session-1',
    onPayload,
    onResponse,
    timeoutMs: 1234,
    maxRetries: 2,
    maxRetryDelayMs: 500,
    metadata: { user_id: 'user' },
    reasoning: 'high' as const,
    thinkingBudgets: { medium: 4_000 },
  } satisfies SimpleStreamOptions;

  manager.dispatchSimple(makeModel(), makeContext(), options);
  const dispatchedOptions = transport.calls[0].options!;
  assert.equal(dispatchedOptions.apiKey, 'stored-key');
  assert.equal(dispatchedOptions.onPayload, onPayload);
  assert.equal(dispatchedOptions.onResponse, onResponse);
  assert.equal(dispatchedOptions.signal, signal);
  assert.equal(dispatchedOptions.transport, 'websocket');
  assert.equal(dispatchedOptions.cacheRetention, 'long');
  assert.equal(dispatchedOptions.sessionId, 'session-1');
  assert.equal(dispatchedOptions.timeoutMs, 1234);
  assert.equal(dispatchedOptions.maxRetries, 2);
  assert.equal(dispatchedOptions.maxRetryDelayMs, 500);
  assert.deepEqual(dispatchedOptions.metadata, { user_id: 'user' });
  assert.equal(dispatchedOptions.reasoning, 'high');
  assert.deepEqual(dispatchedOptions.thinkingBudgets, { medium: 4_000 });
  assert.equal(dispatchedOptions.temperature, 0.5);
  assert.equal(dispatchedOptions.maxTokens, 42);
});

// ---------------------------------------------------------------------------
// No mutation of caller state; effective baseUrl cloning
// ---------------------------------------------------------------------------

test('preparation never mutates frozen caller model, context, or options', () => {
  const { manager, store, transport } = makeFixture({
    auth: { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], baseUrl: 'https://account.example/api' } },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key', env: { REGION: 'stored' } });

  const model = deepFreeze(makeModel({ headers: { 'X-Model-Header': 'from-model' } }));
  const context = deepFreeze(makeContext());
  const options = deepFreeze({ headers: { 'X-Request-Header': 'from-request' }, env: { REGION: 'request' } });
  const modelBefore = structuredClone(model);
  const contextBefore = structuredClone(context);
  const optionsBefore = structuredClone({ ...options, headers: { ...options.headers }, env: { ...options.env } });

  manager.dispatchSimple(model, context, options);

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(options), true);
  assert.deepEqual(model, modelBefore);
  assert.deepEqual(context, contextBefore);
  assert.deepEqual(options, optionsBefore);

  const dispatchedModel = transport.calls[0].model;
  assert.notEqual(dispatchedModel, model, 'an auth baseUrl override must dispatch a cloned model');
  assert.equal(dispatchedModel.baseUrl, 'https://account.example/api');
  assert.equal(model.baseUrl, 'https://default.example/api', 'the original model baseUrl stays intact');
  assert.equal(Object.isFrozen(dispatchedModel), false, 'cloning must not freeze the provider-owned copy');
});

test('preparation reuses the model record when auth supplies no baseUrl override', () => {
  const credentials = new InMemoryCredentialStore();
  credentials.write('test-provider', { type: 'api_key', key: 'stored-key' });
  const model = makeModel();

  const prepared = prepareManagedRequest({ id: 'test-provider', auth: { apiKey: {} } }, model, {}, { credentials });
  assert.equal(prepared.requestModel, model);
  assert.equal(prepared.requestModel.baseUrl, 'https://default.example/api');
});

// ---------------------------------------------------------------------------
// Catalog refresh: publication fencing, supersession, credential invalidation
// ---------------------------------------------------------------------------

test('refresh publishes an awaited, frozen last-known-good snapshot', async () => {
  const { manager, store } = makeFixture({
    refreshCatalog: async (context: ManagedCatalogRefreshContext) => {
      assert.equal(context.auth.apiKey, 'stored-key');
      assert.equal(context.signal.aborted, false);
      return [makeModel({ id: 'fresh-a' }), makeModel({ id: 'fresh-b' })];
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const result = await manager.refresh();
  assert.equal(result.aborted, false);
  assert.equal(result.errors.size, 0);
  assert.deepEqual(result.outcomes.get('test-provider'), { generation: 1, status: 'published' });

  const snapshot = manager.getSnapshot('test-provider')!;
  assert.equal(snapshot.providerId, 'test-provider');
  assert.equal(snapshot.generation, 1);
  assert.deepEqual(snapshot.models.map((model) => model.id), ['fresh-a', 'fresh-b']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.models), true);
});

test('a pending refresh keeps the old snapshot until its result is awaited and published', async () => {
  const pending = deferred<readonly Model<Api>[]>();
  let observedSignal: AbortSignal | undefined;
  let calls = 0;
  const { manager, store } = makeFixture({
    refreshCatalog: async (context) => {
      observedSignal = context.signal;
      calls += 1;
      if (calls === 1) return [makeModel({ id: 'first' })];
      return pending.promise;
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const firstResult = await manager.refresh();
  assert.equal(firstResult.outcomes.get('test-provider')?.status, 'published');
  const oldSnapshot: ManagedCatalogSnapshot = manager.getSnapshot('test-provider')!;
  assert.deepEqual(oldSnapshot.models.map((model) => model.id), ['first']);

  const secondRefresh = manager.refresh();
  assert.equal(observedSignal?.aborted, false);
  assert.equal(manager.getSnapshot('test-provider'), oldSnapshot, 'a pending refresh must not publish anything');

  pending.resolve([makeModel({ id: 'deferred' })]);
  const secondResult = await secondRefresh;
  assert.equal(secondResult.outcomes.get('test-provider')?.status, 'published');
  const newSnapshot = manager.getSnapshot('test-provider')!;
  assert.notEqual(newSnapshot, oldSnapshot, 'publication must replace the snapshot object immutably');
  assert.deepEqual(newSnapshot.models.map((model) => model.id), ['deferred']);
  assert.equal(newSnapshot.generation, oldSnapshot.generation + 1);
});

test('a failed refresh preserves the last-known-good snapshot and reports the error', async () => {
  let calls = 0;
  const { manager, store } = makeFixture({
    refreshCatalog: async () => {
      if (++calls === 1) return [makeModel({ id: 'good' })];
      throw new Error('catalog endpoint unavailable');
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });
  await manager.refresh();
  const oldSnapshot = manager.getSnapshot('test-provider')!;

  assert.ok(oldSnapshot);
  assert.equal(oldSnapshot.models[0].id, 'good');
  const failing = await manager.refresh();
  assert.equal(failing.outcomes.get('test-provider')?.status, 'failed');
  assert.equal(failing.errors.get('test-provider')?.message, 'catalog endpoint unavailable');
  assert.equal(manager.getSnapshot('test-provider'), oldSnapshot, 'failures must preserve the old snapshot');
  assert.equal(oldSnapshot.models[0].id, 'good');
});

test('a refresh aborted mid-flight is discarded without failing the snapshot', async () => {
  const pending = deferred<readonly Model<Api>[]>();
  let observedSignal: AbortSignal | undefined;
  let calls = 0;
  const { manager, store } = makeFixture({
    refreshCatalog: async (context) => {
      observedSignal = context.signal;
      calls += 1;
      if (calls === 1) return [makeModel({ id: 'first' })];
      return pending.promise;
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });
  await manager.refresh();
  const oldSnapshot = manager.getSnapshot('test-provider')!;

  const callerAbort = new AbortController();
  const inFlight = manager.refresh({ signal: callerAbort.signal });
  assert.equal(observedSignal?.aborted, false);

  // Deterministic mid-flight abort while the fetch result is still pending;
  // a completion resolved afterward must be swallowed by the race.
  callerAbort.abort();
  const result = await inFlight;
  assert.equal(result.aborted, true);
  assert.equal(result.outcomes.get('test-provider')?.status, 'superseded');
  assert.equal(result.errors.size, 0);
  assert.equal(manager.getSnapshot('test-provider'), oldSnapshot);

  // A completion resolved afterward must be swallowed by the race, not
  // published and not surfaced as an unhandled rejection.
  pending.resolve([makeModel({ id: 'aborted-new' })]);
  assert.equal(manager.getSnapshot('test-provider'), oldSnapshot);
});

test('a superseded refresh result is ignored and the newer snapshot wins', async () => {
  const stale = deferred<readonly Model<Api>[]>();
  let calls = 0;
  const { manager, store } = makeFixture({
    refreshCatalog: async () => {
      calls += 1;
      if (calls === 1) return stale.promise;
      return [makeModel({ id: 'newer' })];
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const olderRefresh = manager.refresh();
  const newerRefresh = manager.refresh();
  await newerRefresh;
  assert.deepEqual(manager.getSnapshot('test-provider')!.models.map((model) => model.id), ['newer']);

  // The older refresh resolves late; its result must never overwrite the
  // newer state.
  stale.resolve([makeModel({ id: 'stale' })]);
  const older = await olderRefresh;
  assert.equal(older.outcomes.get('test-provider')?.status, 'superseded');
  assert.equal(older.errors.size, 0);
  assert.deepEqual(manager.getSnapshot('test-provider')!.models.map((model) => model.id), ['newer']);
});

test('credential changes supersede the in-flight refresh and invalidate its stale result', async () => {
  const stale = deferred<readonly Model<Api>[]>();
  const observed: Array<{ apiKey: string | undefined; signal: AbortSignal }> = [];
  let calls = 0;
  const { manager, store, transport } = makeFixture({
    refreshCatalog: async (context) => {
      calls += 1;
      observed.push({ apiKey: context.auth.apiKey, signal: context.signal });
      if (calls === 2) return stale.promise;
      return [makeModel({ id: `published-${calls}` })];
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'old-key' });
  await manager.refresh();
  assert.deepEqual(observed[0]?.apiKey, 'old-key');
  assert.equal(observed[0]?.signal.aborted, false);
  const published = manager.getSnapshot('test-provider')!;

  const staleRefresh = manager.refresh();
  assert.deepEqual(observed[1]?.apiKey, 'old-key');
  assert.equal(observed[1]?.signal.aborted, false);

  // A credential change supersedes the pending refresh (controller aborts).
  manager.setCredential('test-provider', { type: 'api_key', key: 'new-key' });
  assert.equal(
    observed[1]?.signal.aborted,
    true,
    'the superseded refresh controller must be aborted',
  );

  stale.resolve([makeModel({ id: 'stale-after-change' })]);
  const staleResult = await staleRefresh;
  assert.equal(staleResult.outcomes.get('test-provider')?.status, 'superseded');
  assert.equal(manager.getSnapshot('test-provider'), published, 'a stale refresh must not overwrite newer credential state');

  // The next refresh resolves auth from the new credential; dispatch too.
  await manager.refresh();
  assert.deepEqual(observed[2]?.apiKey, 'new-key');
  assert.equal(observed[2]?.signal.aborted, false);
  manager.dispatchSimple(makeModel(), makeContext(), {});
  assert.equal(transport.calls[0].options?.apiKey, 'new-key');
});

test('a refresh without usable auth skips publication without failing', () => {
  let fetcherCalls = 0;
  const { manager } = makeFixture({
    refreshCatalog: async () => {
      fetcherCalls += 1;
      return [makeModel()];
    },
  });

  return manager.refresh().then((result) => {
    assert.equal(result.outcomes.get('test-provider')?.status, 'skipped-unconfigured');
    assert.equal(result.errors.size, 0);
    assert.equal(fetcherCalls, 0);
    assert.equal(manager.getSnapshot('test-provider'), undefined);
  });
});

test('refresh honors an already-aborted caller signal and an explicitly empty selection', async () => {
  let fetcherCalls = 0;
  const { manager, store } = makeFixture({
    refreshCatalog: async () => {
      fetcherCalls += 1;
      return [makeModel()];
    },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  const abortedEarly = new AbortController();
  abortedEarly.abort();
  const earlyResult = await manager.refresh({ signal: abortedEarly.signal });
  assert.equal(earlyResult.aborted, true);
  assert.equal(earlyResult.outcomes.size, 0);
  assert.equal(fetcherCalls, 0);

  await manager.refresh({ providers: [] });
  assert.equal(fetcherCalls, 0, 'an explicitly empty provider selection refreshes nothing');
});

// ---------------------------------------------------------------------------
// Multi-provider isolation
// ---------------------------------------------------------------------------

test('refresh isolates providers: one failure preserves the other last-known-good state', async () => {
  const store = new InMemoryCredentialStore();
  const failingTransport = new RecordingTransport();
  const healthyTransport = new RecordingTransport();
  const failing = makeProvider('failing-provider', {
    auth: { apiKey: {} },
    transport: failingTransport,
    refreshCatalog: async () => {
      throw new Error('failing provider endpoint');
    },
  });
  const healthy = makeProvider('healthy-provider', {
    auth: { apiKey: {} },
    transport: healthyTransport,
    refreshCatalog: async () => [makeModel({ id: 'healthy' })],
  });
  const manager = new ManagedProviderManager({ providers: [failing, healthy], credentials: store });
  store.write('failing-provider', { type: 'api_key', key: 'k1' });
  store.write('healthy-provider', { type: 'api_key', key: 'k2' });

  const result = await manager.refresh();
  assert.equal(result.outcomes.get('failing-provider')?.status, 'failed');
  assert.equal(result.outcomes.get('healthy-provider')?.status, 'published');
  assert.deepEqual([...result.errors.keys()], ['failing-provider'], 'per-provider failures are isolated in the error map');
  assert.deepEqual(manager.getSnapshot('healthy-provider')!.models.map((model) => model.id), ['healthy']);
  assert.equal(manager.getSnapshot('failing-provider'), undefined);

  // Dispatch isolation: each provider uses its own transport only.
  manager.dispatchSimple(makeModel({}, 'healthy-provider'), makeContext(), {});
  assert.equal(healthyTransport.dispatchCount, 1);
  assert.equal(failingTransport.dispatchCount, 0, 'a broken provider must not observe healthy-provider dispatches');
});

test('refresh selection restricts to the requested providers and ignores unknown ids', async () => {
  const store = new InMemoryCredentialStore();
  const calls: string[] = [];
  const first = makeProvider('first-provider', {
    auth: { apiKey: {} },
    refreshCatalog: async () => {
      calls.push('first');
      return [makeModel({ id: 'first' })];
    },
  });
  const second = makeProvider('second-provider', {
    auth: { apiKey: {} },
    refreshCatalog: async () => {
      calls.push('second');
      return [makeModel({ id: 'second' })];
    },
  });
  const manager = new ManagedProviderManager({ providers: [first, second], credentials: store });
  store.write('first-provider', { type: 'api_key', key: 'k1' });
  store.write('second-provider', { type: 'api_key', key: 'k2' });

  const result = await manager.refresh({ providers: ['first-provider', 'unknown-provider'] });
  assert.deepEqual(calls, ['first']);
  assert.deepEqual([...result.outcomes.keys()], ['first-provider']);
});

// ---------------------------------------------------------------------------
// Small contract details
// ---------------------------------------------------------------------------

test('explicit empty request key rejects ordinary and summary requests despite stored and ambient auth', () => {
  const { manager, store, transport } = makeFixture({
    auth: { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], ambientEnv: () => 'ambient-key' } },
  });
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });
  assert.throws(() => manager.dispatchSimple(makeModel(), makeContext(), { apiKey: '' }), ManagedProviderAuthError);
  assert.throws(() => manager.prepareSummaryRequest(makeModel(), { apiKey: '' }), ManagedProviderAuthError);
  assert.equal(transport.dispatchCount, 0);
});

test('summary rejects null suppression while ordinary dispatch forwards it', () => {
  const { manager, store, transport } = makeFixture({ headers: { 'X-Default': 'default' } });
  store.write('test-provider', { type: 'api_key', key: 'key' });
  const options = { headers: { 'x-default': null } };
  manager.dispatchSimple(makeModel(), makeContext(), options);
  assert.deepEqual(transport.calls[0].options?.headers, { 'x-default': null });
  assert.throws(() => manager.prepareSummaryRequest(makeModel(), options), /cannot represent header suppression/);
  assert.equal(transport.dispatchCount, 1);
});

test('publication clones and deeply freezes fetched records and preserves prior publications', async () => {
  const model = makeModel({ headers: { 'X-Test': 'original' } });
  const fetched = [model];
  const expected = structuredClone(fetched);
  const { manager, store } = makeFixture({ refreshCatalog: async () => fetched });
  store.write('test-provider', { type: 'api_key', key: 'key' });
  await manager.refresh();
  const first = manager.getSnapshot('test-provider')!;
  fetched.push(makeModel({ id: 'added' }));
  model.name = 'changed';
  model.headers!['X-Test'] = 'changed';
  model.cost.input = 99;
  model.input.push('image');
  assert.deepEqual(first.models, expected);
  const published = first.models[0];
  for (const value of [first.models, published, published.headers, published.cost, published.input]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(published, 'name', 'external'), false);
  assert.equal(Reflect.set(published.headers!, 'X-Test', 'external'), false);
  assert.equal(Reflect.set(published.cost, 'input', 88), false);
  assert.throws(() => { published.input.push('image'); }, TypeError);
  assert.throws(() => { (first.models as Model<Api>[]).push(makeModel()); }, TypeError);
  await manager.refresh();
  assert.notEqual(manager.getSnapshot('test-provider'), first);
  assert.deepEqual(first.models, expected);
  assert.equal(manager.getSnapshot('test-provider')!.models[0].name, 'changed');
});

test('refresh records non-Error failures as Error objects', async () => {
  const { manager, store } = makeFixture({ refreshCatalog: async () => { throw 'catalog failure'; } });
  store.write('test-provider', { type: 'api_key', key: 'key' });
  const result = await manager.refresh();
  assert.equal(result.outcomes.get('test-provider')?.status, 'failed');
  assert.ok(result.errors.get('test-provider') instanceof Error);
  assert.equal(result.errors.get('test-provider')?.message, 'catalog failure');
});

test('credential write and read copies prevent external mutation of manager auth', () => {
  const { manager, store, transport } = makeFixture();
  const credential = { type: 'api_key' as const, key: 'original', env: { REGION: 'original' } };
  manager.setCredential('test-provider', credential);
  credential.key = 'write-mutation';
  credential.env.REGION = 'write-mutation';
  const read = store.read('test-provider');
  assert.ok(read?.type === 'api_key');
  read.key = 'read-mutation';
  read.env!.REGION = 'read-mutation';
  manager.dispatchSimple(makeModel(), makeContext());
  assert.equal(transport.calls[0].options?.apiKey, 'original');
  assert.deepEqual(transport.calls[0].options?.env, { REGION: 'original' });
});

test('dispatch of an unknown provider fails without consulting any credential store', () => {
  const manager = new ManagedProviderManager({ providers: [] });
  assert.throws(() => manager.dispatchSimple(makeModel({}, 'unknown'), makeContext()), /Unknown provider: unknown/);
});

test('request override apiKey wins per request without touching stored state', () => {
  const { manager, store, transport } = makeFixture();
  store.write('test-provider', { type: 'api_key', key: 'stored-key' });

  manager.dispatchSimple(makeModel(), makeContext(), { apiKey: 'request-key' });
  assert.equal(transport.calls[0].options?.apiKey, 'request-key');
  assert.deepEqual(store.read('test-provider'), { type: 'api_key', key: 'stored-key' });
});

test('ambient-only providers dispatch through the injected ambient lookup with no stored credential', () => {
  const { manager, transport } = makeFixture({
    auth: { apiKey: { apiKeyEnvNames: ['TEST_API_KEY'], ambientEnv: () => 'ambient-key' } },
  });

  manager.dispatchSimple(makeModel(), makeContext(), {});
  assert.equal(transport.calls[0].options?.apiKey, 'ambient-key');
});

test('ordinary and summary preparation share the same ambient resolution and endpoint', () => {
  const credentials: ManagedCredentialStore = new InMemoryCredentialStore();
  const provider = {
    id: 'ambient-provider',
    auth: {
      apiKey: {
        apiKeyEnvNames: ['OVERLAY_KEY'],
        ambientEnv: () => 'ambient-key',
        baseUrl: 'https://ambient.example/api',
      },
    },
  };

  const ordinary = prepareManagedRequest(
    provider,
    makeModel({}, 'ambient-provider'),
    { env: { OVERLAY_KEY: 'overlay-key' } },
    { credentials },
  );
  const summary = prepareManagedSummaryRequest(
    provider,
    makeModel({}, 'ambient-provider'),
    { env: { OVERLAY_KEY: 'overlay-key' } },
    { credentials },
  );
  assert.equal(ordinary.resolvedAuth.source, 'ambient');
  assert.equal(summary.auth.apiKey, 'overlay-key');
  assert.equal(summary.model.baseUrl, ordinary.requestModel.baseUrl);
  assert.equal(summary.model.baseUrl, 'https://ambient.example/api');
});