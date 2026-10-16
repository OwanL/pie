import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, reducer } from '../../conversation-state/reducer.js';
import { providerConfigRevision } from '../../../../harness/model-providers/catalog/provider-config.js';

test('provider refresh fences an in-flight pending creation preview', () => {
  let state = reducer(createInitialArchState(), { kind: 'Command', cmd: {
    kind: 'CreateSession', corrId: 'create', operationId: 'create', backendGeneration: 1,
    sessionPath: '__pending__:preview', cwd: '/workspace', selectionToken: 's',
    placeholderSummary: { path: '__pending__:preview', name: 'Loading', cwd: '/workspace', modifiedAt: '', messageCount: 0 },
  } }).state;
  state = { ...state, settings: { ...state.settings, backendReady: true },
    providerManagement: { ...state.providerManagement, generation: 1 } };
  const oldRevision = state.settings.modelHydrationRevision;
  const refreshed = reducer(state, { kind: 'ProviderManagementSnapshotUpdated', generation: 1,
    snapshot: { ...state.providerManagement.snapshot, loaded: true, revision: 1, configRevision: providerConfigRevision('new') } });
  assert.ok(refreshed.effects.some(e => e.kind === 'HydrateModel' && e.sessionPath === '__pending__:preview'));
  const result = reducer(refreshed.state, { kind: 'AvailableModelsChanged', sessionPath: '__pending__:preview', models: [],
    backendGeneration: 1, hydrationRevision: oldRevision, modelWriteFence: 0,
    creationPreview: { operationId: 'create', attempt: 1 } });
  assert.equal(result.state, refreshed.state);
});

for (const eventFirst of [true, false]) test(`provider catalog refresh converges (${eventFirst ? 'event' : 'response'} first)`, () => {
  const state = createInitialArchState();
  state.settings.backendReady = true;
  state.providerManagement.generation = 1;
  state.providerManagement.operationId = 'save';
  state.sessions.openTabPaths = ['/a', '/b'];
  const snapshot = { ...state.providerManagement.snapshot, revision: 1, loaded: true, configRevision: providerConfigRevision('new') };
  const event = { kind: 'ProviderManagementSnapshotUpdated' as const, generation: 1, snapshot };
  const response = { kind: 'ProviderManagementResult' as const, generation: 1, fence: 0, selectedId: null, requestType: 'save' as const, response: { operationId: 'save', status: 'ok' as const, snapshot } };
  const first = reducer(state, eventFirst ? event : response);
  assert.deepEqual(first.effects.filter(e => e.kind === 'HydrateModel').map(e => e.sessionPath), ['/a', '/b']);
  assert.equal(first.state.settings.modelHydrationRevisionBySession['/a'], 1);
  const second = reducer(first.state, eventFirst ? response : event);
  assert.equal(second.effects.filter(e => e.kind === 'HydrateModel').length, 0);
  const stale = reducer(second.state, { kind: 'AvailableModelsChanged', sessionPath: '/a', models: [], backendGeneration: 1, hydrationRevision: 0, modelWriteFence: 0 });
  assert.equal(stale.state, second.state);
});
