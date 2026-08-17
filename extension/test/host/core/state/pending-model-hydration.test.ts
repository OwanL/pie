import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ModelInfo, SessionSummary } from '../../../../src/shared/protocol';

const SOURCE = '/workspace/source.jsonl';
const PENDING = '__pending__:1';
const TARGET = '/workspace/target.jsonl';

const SOURCE_MODEL: ModelInfo = {
  id: 'reasoning-model',
  name: 'Reasoning model',
  provider: 'provider-a',
  reasoning: true,
  thinkingLevels: ['off', 'low', 'high'],
  inputKinds: ['text'],
};
const OTHER_MODEL: ModelInfo = {
  id: 'other-model',
  name: 'Other model',
  provider: 'provider-a',
  reasoning: false,
  inputKinds: ['text'],
};

function summary(path: string, modelId?: string): SessionSummary {
  return {
    path,
    name: path,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    ...(modelId ? { modelId, provider: 'provider-a', thinkingLevel: 'high' as const } : {}),
  };
}

function createState(): ReturnType<typeof createInitialArchState> {
  const state = createInitialArchState();
  return {
    ...state,
    settings: {
      ...state.settings,
      modelSettings: {
        defaultModel: SOURCE_MODEL.id,
        defaultProvider: SOURCE_MODEL.provider,
        defaultThinkingLevel: 'high',
      },
      availableModelsBySession: { [SOURCE]: [SOURCE_MODEL, OTHER_MODEL] },
    },
    sessions: {
      ...state.sessions,
      sessions: [summary(SOURCE, SOURCE_MODEL.id)],
      openTabPaths: [SOURCE],
      activeSessionPath: SOURCE,
    },
  };
}

function createCommand(kind: 'CreateSession' | 'DuplicateSession'): Event {
  return {
    kind: 'Command',
    cmd: kind === 'CreateSession'
      ? {
          kind,
          corrId: 'create-1',
          sessionPath: PENDING,
          cwd: '/workspace',
          placeholderSummary: summary(PENDING, SOURCE_MODEL.id),
          selectionToken: 'selection-1',
        }
      : {
          kind,
          corrId: 'duplicate-1',
          sessionPath: PENDING,
          sourceSessionPath: SOURCE,
          placeholderSummary: summary(PENDING, SOURCE_MODEL.id),
          selectionToken: 'selection-1',
        },
  } as Event;
}

test('pending create and duplicate seed the picker from a predecessor catalog and preserve reasoning levels', () => {
  for (const kind of ['CreateSession', 'DuplicateSession'] as const) {
    const state = createState();
    const next = reducer(state, createCommand(kind)).state;
    assert.deepEqual(next.settings.availableModelsBySession[PENDING], [SOURCE_MODEL, OTHER_MODEL]);
    assert.equal(next.settings.availableModelsStatusBySession[PENDING], 'provisional');
    assert.deepEqual(
      next.settings.availableModelsBySession[PENDING]?.find((model) => model.id === SOURCE_MODEL.id)?.thinkingLevels,
      ['off', 'low', 'high'],
    );
  }
});

test('PendingPathReplaced transfers provisional catalog and status to the durable path', () => {
  const state = reducer(createState(), createCommand('CreateSession')).state;
  const next = reducer(state, {
    kind: 'PendingPathReplaced',
    oldPendingPath: PENDING,
    newSessionPath: TARGET,
  });

  assert.deepEqual(next.state.settings.availableModelsBySession[TARGET], [SOURCE_MODEL, OTHER_MODEL]);
  assert.equal(next.state.settings.availableModelsStatusBySession[TARGET], 'provisional');
  assert.equal(PENDING in next.state.settings.availableModelsBySession, false);
  assert.equal(PENDING in next.state.settings.availableModelsStatusBySession, false);
});

test('global settings hydration rejects an older revision from a different session while catalogs stay path-scoped', () => {
  const first = reducer(createState(), {
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'hydrate-source', sessionPath: SOURCE },
  });
  const second = reducer(first.state, {
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'hydrate-target', sessionPath: TARGET },
  });

  const newerSettings = reducer(second.state, {
    kind: 'ModelSettingsHydrated',
    sessionPath: TARGET,
    modelSettings: { defaultModel: OTHER_MODEL.id, defaultProvider: OTHER_MODEL.provider, defaultThinkingLevel: 'off' },
    backendGeneration: 0,
    hydrationRevision: 2,
    modelWriteFence: 0,
  });
  const lateOlderSettings = reducer(newerSettings.state, {
    kind: 'ModelSettingsHydrated',
    sessionPath: SOURCE,
    modelSettings: { defaultModel: SOURCE_MODEL.id, defaultProvider: SOURCE_MODEL.provider, defaultThinkingLevel: 'high' },
    backendGeneration: 0,
    hydrationRevision: 1,
    modelWriteFence: 0,
  });
  assert.equal(lateOlderSettings.state.settings.modelSettings?.defaultModel, OTHER_MODEL.id);

  const sourceCatalog = reducer(lateOlderSettings.state, {
    kind: 'AvailableModelsChanged',
    sessionPath: SOURCE,
    models: [OTHER_MODEL],
    backendGeneration: 0,
    hydrationRevision: 1,
    modelWriteFence: 0,
  });
  assert.deepEqual(sourceCatalog.state.settings.availableModelsBySession[SOURCE], [OTHER_MODEL]);
});

test('a provider-qualified pending selection never borrows same-id capabilities from another provider', () => {
  const sharedWrongProvider: ModelInfo = {
    ...SOURCE_MODEL,
    id: 'shared-id',
    provider: 'provider-a',
    name: 'Wrong provider model',
  };
  const activeModel: ModelInfo = { ...OTHER_MODEL, id: 'active-model' };
  const initial = createState();
  const state = {
    ...initial,
    settings: {
      ...initial.settings,
      availableModelsBySession: {
        [SOURCE]: [activeModel],
        '/workspace/other.jsonl': [sharedWrongProvider],
      },
    },
    sessions: {
      ...initial.sessions,
      sessions: [summary(SOURCE, activeModel.id)],
      openTabPaths: [SOURCE],
      activeSessionPath: SOURCE,
    },
  };
  const pending = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'CreateSession',
      corrId: 'create-provider',
      sessionPath: PENDING,
      cwd: '/workspace',
      placeholderSummary: { ...summary(PENDING, 'shared-id'), provider: 'provider-b' },
      selectionToken: 'selection-provider',
    },
  }).state;
  assert.deepEqual(pending.settings.availableModelsBySession[PENDING], [activeModel]);
});

test('a stale hydration result cannot overwrite a SetModel fence, while a newer refresh may replace the catalog', () => {
  const started = reducer(createState(), {
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'hydrate-1', sessionPath: SOURCE },
  });
  assert.equal(started.effects[0]?.kind, 'HydrateModel');
  assert.equal(started.effects[0]?.kind === 'HydrateModel' ? started.effects[0].modelWriteFence : undefined, 0);

  const selected = reducer(started.state, {
    kind: 'Command',
    cmd: {
      kind: 'SetModel',
      corrId: 'set-1',
      sessionPath: SOURCE,
      modelSettings: {
        defaultModel: OTHER_MODEL.id,
        defaultProvider: OTHER_MODEL.provider,
        defaultThinkingLevel: 'off',
      },
    },
  }).state;
  assert.equal(selected.settings.modelWriteFence, 1);

  const stale = reducer(selected, {
    kind: 'ModelSettingsHydrated',
    sessionPath: SOURCE,
    modelSettings: { defaultModel: SOURCE_MODEL.id, defaultProvider: SOURCE_MODEL.provider, defaultThinkingLevel: 'high' },
    backendGeneration: 0,
    hydrationRevision: 1,
    modelWriteFence: 0,
  });
  const staleCatalog = reducer(stale.state, {
    kind: 'AvailableModelsChanged',
    sessionPath: SOURCE,
    models: [SOURCE_MODEL],
    backendGeneration: 0,
    hydrationRevision: 1,
    modelWriteFence: 0,
  });
  assert.equal(staleCatalog.state.settings.modelSettings?.defaultModel, OTHER_MODEL.id);
  assert.deepEqual(staleCatalog.state.settings.availableModelsBySession[SOURCE], [SOURCE_MODEL, OTHER_MODEL]);
  assert.equal(staleCatalog.state.sessions.sessions[0]?.modelId, OTHER_MODEL.id);

  const refresh = reducer(staleCatalog.state, {
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'hydrate-2', sessionPath: SOURCE },
  });
  const refreshed = reducer(refresh.state, {
    kind: 'AvailableModelsChanged',
    sessionPath: SOURCE,
    models: [OTHER_MODEL],
    backendGeneration: 0,
    hydrationRevision: 2,
    modelWriteFence: 1,
  });
  assert.deepEqual(refreshed.state.settings.availableModelsBySession[SOURCE], [OTHER_MODEL]);
  assert.equal(refreshed.state.sessions.sessions[0]?.modelId, OTHER_MODEL.id);
});
