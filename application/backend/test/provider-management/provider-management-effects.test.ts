import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, reducer } from '../../conversation-state/reducer.js';
import { EffectRunner } from '../../conversation-state/effects/effect-runner.js';
import { makeEffectRunnerDeps } from '../helpers/effect-runner-deps.js';
import type { ProviderManagementResponse } from '../../../../harness/model-providers/management/contracts.js';
import type { ProviderManagementEffect } from '../../provider-management/state.js';
const snapshot = { revision: 1, configRevision: 'r1', loaded: true, providers: [], definitions: [], protocols: [] };
const read: ProviderManagementEffect = { kind: 'ProviderManagementRpc', request: { type: 'read', operationId: 'read' }, generation: 1, fence: 1, selectedId: null };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('optional service fallback is safe, fixed, and completes loading', async () => {
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, refreshFence: 1, operationId: 'read', status: 'loading' } };
  const { deps } = makeEffectRunnerDeps({ dispatchEvent: event => { state = reducer(state, event).state; } });
  new EffectRunner(deps).run(read); await settle();
  assert.equal(state.providerManagement.status, 'error');
  assert.equal(state.providerManagement.snapshot.loaded, false);
  assert.deepEqual(state.providerManagement.snapshot.definitions, []);
  assert.equal(state.providerManagement.snapshot.error, 'Provider management is unavailable.');
  assert.equal(state.providerManagement.message, 'Provider operation failed.');
});
test('a fresh RPC waits for real server cancellation, not an aborted host waiter', async () => {
  let release!: (response: ProviderManagementResponse) => void;
  const calls: string[] = [];
  const { deps } = makeEffectRunnerDeps({ serviceOverrides: { getBackendGeneration: () => 1,
    providerManagement: async request => {
      calls.push(request.type);
      if (request.type === 'cancel') return new Promise<ProviderManagementResponse>(resolve => { release = resolve; });
      return { operationId: request.operationId, snapshot, status: 'ok' };
    } } });
  const runner = new EffectRunner(deps);
  runner.run({ ...read, request: { type: 'cancel', operationId: 'cancel', targetOperationId: 'auth-owner' } });
  runner.run(read);
  assert.deepEqual(calls, ['cancel']);
  release({ operationId: 'cancel', snapshot, status: 'cancelled' });
  await settle();
  assert.deepEqual(calls, ['cancel', 'read']);
});
test('refresh merges discovery but retains current fields, preferences and manual models', () => {
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, selectedId: 'provider', draft: {
    originalId: 'provider', id: 'provider', enabled: false, api: 'openai-completions', baseUrl: 'https://typed.test/v1', credentialSource: 'environment', environmentName: 'MY_KEY', manualModelIds: ['manual'],
    models: [{ id: 'known', name: 'Old', visible: 'no', subagentEligible: 'yes', pricing: { kind: 'unknown', tiered: false } }, { id: 'manual', name: 'Manual', visible: 'yes', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } }],
  } } };
  const next = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', corrId: 'refresh', operationId: 'refresh', generation: 1, command: { type: 'refresh', id: 'provider' } } });
  const draft = { ...state.providerManagement.draft!, baseUrl: 'https://obsolete.test', models: [{ ...state.providerManagement.draft!.models[0], name: 'Discovered', visible: 'unset' as const, subagentEligible: 'unset' as const }] };
  const result = reducer(next.state, { kind: 'ProviderManagementResult', response: { operationId: 'refresh', snapshot, draft, status: 'ok' }, generation: 1, fence: next.state.providerManagement.refreshFence, selectedId: 'provider', requestType: 'refresh' });
  assert.equal(result.state.providerManagement.draft?.baseUrl, 'https://typed.test/v1');
  assert.equal(result.state.providerManagement.draft?.models[0].visible, 'no');
  assert.equal(result.state.providerManagement.draft?.models[1].id, 'manual');
});

test('response-first and event-first snapshot publication converge', () => {
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, refreshFence: 1, operationId: 'read', status: 'loading' } };
  const result = { kind: 'ProviderManagementResult' as const, response: { operationId: 'read', snapshot, status: 'ok' as const }, generation: 1, fence: 1, selectedId: null, requestType: 'read' as const };
  const event = { kind: 'ProviderManagementSnapshotUpdated' as const, snapshot, generation: 1 };
  const a = reducer(reducer(state, result).state, event).state;
  const b = reducer(reducer(state, event).state, result).state;
  assert.deepEqual(a.providerManagement, b.providerManagement);
});
