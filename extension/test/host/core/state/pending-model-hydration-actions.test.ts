import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionMessageActions } from '../../../../src/host/session-service/message-actions';
import type { Event } from '../../../../src/host/core/events';
import type { ModelInfo, ModelSettings, SessionSummary } from '../../../../src/shared/protocol';

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
): { actions: SessionMessageActions; getState: () => ArchState; events: Event[]; serviceState: SessionServiceState } {
  let archState = initialState;
  const dispatchArch = (event: Event) => {
    events.push(event);
    archState = reducer(archState, event).state;
  };
  const serviceState = new SessionServiceState(context(), backend, () => undefined, () => archState, dispatchArch, 0);
  const actions = new SessionMessageActions({
    context: context(),
    backend,
    scheduleRender: () => undefined,
    state: serviceState,
    createNewSession: () => '',
    getArchState: () => archState,
    dispatchArch,
  });
  return { actions, getState: () => archState, events, serviceState };
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
    const serviceState = new SessionServiceState(context(), backend as any, () => undefined, () => archState, dispatchArch, 0);
    const actions = new SessionMessageActions({
      context: context(), backend: backend as any, scheduleRender: () => undefined,
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
