import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../conversation-state/arch-state';
import type { ArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { SessionServiceState } from '../../../session-actions/state';
import { SessionMessageActions } from '../../../session-actions/message-actions';
import type { Event } from '../../../conversation-state/events';
import type { ModelInfo, ModelSettings, SessionSummary } from '../../../../lib/protocol/index.js';

const SESSION = '/workspace/session.jsonl';
const MODEL: ModelInfo = {
  id: 'model-a', name: 'Model A', provider: 'provider-a', reasoning: true,
  thinkingLevels: ['off', 'low', 'high'], inputKinds: ['text'],
};
const SETTINGS: ModelSettings = {
  defaultModel: MODEL.id, defaultProvider: MODEL.provider, defaultThinkingLevel: 'high',
};
const SUMMARY: SessionSummary = {
  path: SESSION, name: 'Session', cwd: '/workspace', modifiedAt: '2024-01-01T00:00:00.000Z',
  messageCount: 0, modelId: MODEL.id, provider: MODEL.provider, thinkingLevel: 'high',
};

function context(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

function stateWithPath(path = SESSION): ArchState {
  const initial = createInitialArchState();
  return {
    ...initial,
    settings: { ...initial.settings, modelSettings: SETTINGS },
    sessions: {
      ...initial.sessions,
      sessions: [{ ...SUMMARY, path }],
      openTabPaths: [path],
      activeSessionPath: path,
    },
  };
}

function createActions(
  backend: any,
  initialState: ArchState,
  events: Event[] = [],
): { actions: SessionMessageActions; getState: () => ArchState; events: Event[]; serviceState: SessionServiceState; dispatch: (event: Event) => void } {
  let archState = initialState;
  const dispatchArch = (event: Event) => {
    events.push(event);
    archState = reducer(archState, event).state;
  };
  const serviceState = new SessionServiceState(backend, () => undefined, () => archState, dispatchArch, 0);
  const actions = new SessionMessageActions({
    backend,
    scheduleRender: () => undefined,
    state: serviceState,
    createNewSession: () => '',
    getArchState: () => archState,
    dispatchArch,
  });
  return { actions, getState: () => archState, events, serviceState, dispatch: dispatchArch };
}

test('hydrateModelState never requests settings or models for any pending-path variant', async () => {
  const requested: string[] = [];
  const backend = {
    request: async (method: string) => {
      requested.push(method);
      throw new Error(`unexpected request: ${method}`);
    },
  };
  const { actions, events } = createActions(backend, stateWithPath('__pending__:1'));

  for (const pendingPath of [
    '__pending__:1',
    '/workspace/__pending__:2',
    'C:\\workspace\\__pending__:3',
  ]) {
    await actions.hydrateModelState(pendingPath);
  }

  assert.deepEqual(requested, []);
  assert.deepEqual(events, []);
});

test('pending NEW creation hydrates only the path-free creation authority', async () => {
  const path = '__pending__:new';
  const requested: unknown[] = [];
  const backend = { request: async (method: string, params: unknown) => {
    requested.push([method, params]);
    return [MODEL];
  } };
  const initial = reducer(stateWithPath(path), { kind: 'Command', cmd: {
    kind: 'CreateSession', corrId: 'c', operationId: 'new', backendGeneration: 0,
    sessionPath: path, cwd: '/workspace', placeholderSummary: { ...SUMMARY, path }, selectionToken: 's',
  } }).state;
  const { actions, getState } = createActions(backend, initial);
  await actions.hydrateModelState(path);
  assert.deepEqual(requested, [['models.creationPreview', undefined]]);
  assert.deepEqual(getState().settings.availableModelsBySession[path], [MODEL]);
  assert.equal(getState().settings.availableModelsStatusBySession[path], 'provisional');
});

test('settings and catalog hydration settle independently in either failure direction', async () => {
  const cases: Array<{ fail: 'settings' | 'models'; expected: Event['kind'] }> = [
    { fail: 'settings', expected: 'AvailableModelsChanged' },
    { fail: 'models', expected: 'ModelSettingsHydrated' },
  ];

  for (const { fail, expected } of cases) {
    let archState = stateWithPath();
    if (fail === 'models') {
      archState = {
        ...archState,
        settings: {
          ...archState.settings,
          modelSettings: { defaultModel: 'old-model', defaultThinkingLevel: 'low' },
        },
      };
    }
    const events: Event[] = [];
    const backend = {
      request: async (method: string) => {
        if ((fail === 'settings' && method === 'settings.get') || (fail === 'models' && method === 'models.list')) {
          throw new Error(`${fail} unavailable`);
        }
        return method === 'settings.get' ? SETTINGS : [MODEL];
      },
    };
    const dispatchArch = (event: Event) => {
      events.push(event);
      archState = reducer(archState, event).state;
    };
    const serviceState = new SessionServiceState(backend as any, () => undefined, () => archState, dispatchArch, 0);
    const actions = new SessionMessageActions({
      backend: backend as any, scheduleRender: () => undefined,
      state: serviceState, createNewSession: () => '', getArchState: () => archState, dispatchArch,
    });

    await actions.hydrateModelState(SESSION);

    assert.equal(events.some((event) => event.kind === expected), true, `${expected} should settle despite ${fail} failure`);
    assert.equal(events.some((event) => event.kind === (fail === 'settings' ? 'ModelSettingsHydrated' : 'AvailableModelsChanged')), false);
  }
});

test('a joined hydration keeps its request-start revision and coalesces one fresh follow-up', async () => {
  const OTHER = '/workspace/other.jsonl';
  const initial = stateWithPath();
  const state: ArchState = {
    ...initial,
    sessions: {
      ...initial.sessions,
      sessions: [...initial.sessions.sessions, { ...SUMMARY, path: OTHER, name: 'Other' }],
      openTabPaths: [SESSION, OTHER],
    },
  };
  const requests: Array<{ method: string; params?: any; resolve: (value: unknown) => void }> = [];
  const backend = {
    request: (method: string, params?: any) => new Promise<unknown>((resolve) => {
      requests.push({ method, params, resolve });
    }),
  };
  const events: Event[] = [];
  const { actions, getState } = createActions(backend, state, events);

  const a1 = actions.hydrateModelState(SESSION, { hydrationRevision: 1 });
  const b2 = actions.hydrateModelState(OTHER, { hydrationRevision: 2 });
  const a3 = actions.hydrateModelState(SESSION, { hydrationRevision: 3 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 4, 'A/rev3 joins A/rev1 transport instead of relabeling it');

  const settings = requests.filter((request) => request.method === 'settings.get');
  const models = requests.filter((request) => request.method === 'models.list');
  settings[1]!.resolve({ defaultModel: 'from-b2', defaultThinkingLevel: 'high' });
  models.find((request) => request.params?.sessionPath === OTHER)!.resolve([MODEL]);
  await b2;

  settings[0]!.resolve({ defaultModel: 'stale-a1', defaultThinkingLevel: 'low' });
  models.find((request) => request.params?.sessionPath === SESSION)!.resolve([MODEL]);
  await a1;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 6, 'the newest joined revision starts one follow-up read');

  const followUpSettings = requests.filter((request) => request.method === 'settings.get')[2]!;
  const followUpModels = requests.filter(
    (request, index) => request.method === 'models.list'
      && request.params?.sessionPath === SESSION
      && index > 3,
  )[0]!;
  followUpSettings.resolve({ defaultModel: 'from-a3', defaultThinkingLevel: 'high' });
  followUpModels.resolve([MODEL]);
  await a3;

  assert.equal(getState().settings.modelSettings?.defaultModel, 'from-a3');
  assert.equal(events.some((event) => event.kind === 'ModelSettingsHydrated'
    && event.hydrationRevision === 3
    && event.modelSettings.defaultModel === 'stale-a1'), false);
});

test('concurrent hydration deduplicates by backend generation and stable session path', async () => {
  const pending: Array<{ method: string; resolve: (value: unknown) => void }> = [];
  const requested: string[] = [];
  const backend = {
    request: (method: string) => {
      requested.push(method);
      return new Promise<unknown>((resolve) => pending.push({ method, resolve }));
    },
  };
  const { actions, serviceState, getState } = createActions(backend, stateWithPath());

  const first = actions.hydrateModelState(SESSION);
  const joined = actions.hydrateModelState(SESSION);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...requested].sort(), ['models.list', 'settings.get']);

  // A new backend generation is a distinct dedupe domain. The old requests
  // remain in the transport, but cannot publish after resetRuntimeState.
  serviceState.resetRuntimeState();
  const nextGeneration = actions.hydrateModelState(SESSION);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([...requested].sort(), ['models.list', 'models.list', 'settings.get', 'settings.get']);

  for (const request of pending) {
    request.resolve(request.method === 'settings.get' ? SETTINGS : [MODEL]);
  }
  await Promise.all([first, joined, nextGeneration]);

  assert.equal(getState().settings.availableModelsBySession[SESSION]?.[0]?.id, MODEL.id);
  assert.equal(getState().settings.modelBackendGeneration, 1);
});

/** Regression (startup model hydration lifecycle): a hydration issued before
 *  backend.ready fails at the real host transport seam ("Backend is not
 *  running", produced by the real BackendClient) and used to be swallowed,
 *  leaving the session loading forever. The failure is deferred and retried on
 *  the next backend ready transition instead. */
test('pre-ready hydration failure at the actual seam defers and succeeds on ready', async () => {
  const { BackendClient } = await import('../../../agent-connection/client');
  // A real client that was never started reproduces the exact pre-ready seam
  // failure; request() throws while no backend stdin exists.
  const unstarted = new BackendClient();
  await assert.rejects((unstarted.request('models.list') as Promise<unknown>), /Backend is not running/);

  let ready = false;
  const backend = {
    request: (method: string, params?: unknown) => ready
      ? (method === 'settings.get'
        ? Promise.resolve(SETTINGS)
        : Promise.resolve([MODEL]))
      // Delegate the pre-ready failure to the real seam: the host sees the
      // literal BackendClient error identity, never a test stub sentinel.
      : (unstarted.request(method as 'models.list', params) as Promise<unknown>),
  };
  const initial = reducer(stateWithPath(), { kind: 'Command', cmd: {
    kind: 'HydrateModel', corrId: 'hydrate', sessionPath: SESSION,
  } }).state;
  const { actions, getState, events, dispatch } = createActions(backend as any, initial);

  await actions.hydrateModelState(SESSION);
  assert.equal(getState().settings.availableModelsStatusBySession[SESSION], 'loading');
  assert.equal(events.length, 0, 'a pre-ready failure must stay silent until ready');

  // Backend publishes readiness (startup/restart path) and the host flushes.
  dispatch({ kind: 'BackendReadyChanged', ready: true });
  assert.equal(getState().settings.backendReady, true);
  ready = true;
  actions.flushDeferredModelHydrations();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(getState().settings.availableModelsStatusBySession[SESSION], 'authoritative');
  assert.deepEqual(getState().settings.availableModelsBySession[SESSION], [MODEL]);
  const changed = events.find((event) => event.kind === 'AvailableModelsChanged') as any;
  assert.ok(changed, 'the retry must publish the catalog');
  assert.equal(changed.hydrationRevision, 1);
  assert.equal(events.some((event) => event.kind === 'AvailableModelsHydrationFailed'), false);
});

/** Regression: a post-ready catalog exception must terminate visibly. It
 *  records an `error` status only when nothing renderable exists, keeps any
 *  last good catalog visible, and never claims an authoritative empty catalog. */
test('post-ready catalog failure is terminal, keeps the last good catalog, and never claims empty', async () => {
  const failingBackend = () => ({
    request: async (method: string) => {
      if (method === 'settings.get') return SETTINGS;
      throw new Error('catalog discovery exploded');
    },
  });

  for (const prior of [undefined, [MODEL]] as const) {
    let initial = reducer(stateWithPath(), { kind: 'Command', cmd: {
      kind: 'HydrateModel', corrId: 'hydrate', sessionPath: SESSION,
    } }).state;
    if (prior) {
      initial = reducer(initial, { kind: 'AvailableModelsChanged', sessionPath: SESSION,
        models: [...prior], backendGeneration: 0, hydrationRevision: 1, modelWriteFence: 0 } as Event).state;
      // A fresh refresh command reissues hydration without relabeling the
      // usable catalog (revision 2, catalog stays authoritative).
      initial = reducer(initial, { kind: 'Command', cmd: {
        kind: 'HydrateModel', corrId: 'hydrate-2', sessionPath: SESSION,
      } }).state;
    }
    const events: Event[] = [];
    // The host carries the effect's request-start fences; use the state's
    // current revision so the terminal failure is never stale.
    const requestMetadata = { hydrationRevision: initial.settings.modelHydrationRevision, modelWriteFence: initial.settings.modelWriteFence };
    const backend = failingBackend();
    const dispatchArch = (event: Event) => { events.push(event); initial = reducer(initial, event).state; };
    const serviceState = new SessionServiceState(backend as any, () => undefined, () => initial, dispatchArch, 0);
    const actions = new SessionMessageActions({
      backend: backend as any, scheduleRender: () => undefined,
      state: serviceState, createNewSession: () => '', getArchState: () => initial, dispatchArch,
    });

    await actions.hydrateModelState(SESSION, requestMetadata);

    assert.equal(events.some((event) => event.kind === 'AvailableModelsHydrationFailed'), true,
      'the failure must be terminal and observed');
    assert.equal(events.some((event) => event.kind === 'AvailableModelsChanged'), false,
      'must not claim authoritative empty');
    if (prior) {
      assert.deepEqual(initial.settings.availableModelsBySession[SESSION], prior,
        'the last good catalog must stay visible');
      assert.equal(initial.settings.availableModelsStatusBySession[SESSION], 'authoritative');
    } else {
      assert.equal(initial.settings.availableModelsStatusBySession[SESSION], 'error',
        'a catalog-less session must surface the retry affordance');
    }
  }
});

/** A post-ready "Backend is not running" (backend loss between ready and the
 *  read) is transport unavailability, not a catalog error: defer and retry on
 *  the next ready transition rather than marking the catalog failed. */
test('post-ready backend-unavailable failure defers instead of terminalizing the catalog', async () => {
  let ready = false;
  const backend = {
    request: async (method: string) => {
      if (!ready) throw new Error('Backend is not running');
      return method === 'settings.get' ? SETTINGS : [MODEL];
    },
  };
  const { actions, getState, events, dispatch } = createActions(backend as any, stateWithPath());

  await actions.hydrateModelState(SESSION);
  assert.equal(events.some((event) => event.kind === 'AvailableModelsHydrationFailed'), false,
    'unavailability must not terminalize the catalog');

  dispatch({ kind: 'BackendReadyChanged', ready: true });
  ready = true;
  actions.flushDeferredModelHydrations();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(getState().settings.availableModelsStatusBySession[SESSION], 'authoritative');
});
