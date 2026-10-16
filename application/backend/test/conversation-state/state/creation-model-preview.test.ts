import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import type { Event } from '../../../conversation-state/events';

const path = '__pending__:preview';
function pending() {
  return reducer(createInitialArchState(), { kind: 'Command', cmd: {
    kind: 'CreateSession', corrId: 'c', operationId: 'create-preview', backendGeneration: 3,
    sessionPath: path, cwd: '/workspace', selectionToken: 's',
    placeholderSummary: { path, name: 'Loading...', cwd: '/workspace', modifiedAt: '', messageCount: 0 },
  } }).state;
}
function preview(overrides = {}): Event {
  return { kind: 'AvailableModelsChanged', sessionPath: path, models: [
    { provider: 'creation', id: 'new', name: 'New', reasoning: false, inputKinds: ['text'] },
  ], backendGeneration: 3, hydrationRevision: 1, modelWriteFence: 0,
  creationPreview: { operationId: 'create-preview', attempt: 1 }, ...overrides } as Event;
}
test('creation authority preview is provisional and durable empty replaces it', () => {
  const state = reducer(pending(), preview()).state;
  assert.equal(state.settings.availableModelsBySession[path][0].provider, 'creation');
  assert.equal(state.settings.availableModelsStatusBySession[path], 'provisional');
  const durable = reducer(state, preview({ models: [], creationPreview: undefined, hydrationRevision: 2 })).state;
  assert.deepEqual(durable.settings.availableModelsBySession[path], []);
  assert.equal(durable.settings.availableModelsStatusBySession[path], 'authoritative');
  assert.equal(reducer(durable, preview({ hydrationRevision: 3 })).state, durable);
});
test('preview rejects stale creation, generation and configuration ownership', () => {
  const state = pending();
  for (const override of [
    { backendGeneration: 2 },
    { creationPreview: { operationId: 'other', attempt: 1 } },
    { creationPreview: { operationId: 'create-preview', attempt: 2 } },
    { modelWriteFence: -1 },
  ]) assert.equal(reducer(state, preview(override)).state, state);
  const closed = { ...state, sessions: { ...state.sessions, openTabPaths: [] } };
  assert.equal(reducer(closed, preview()).state, closed);
});
