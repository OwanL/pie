import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, reducer } from '../../conversation-state/reducer.js';
import type { ArchState } from '../../conversation-state/arch-state.js';
import type { Event } from '../../conversation-state/events.js';
import type { ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview.js';
import type { ProviderManagementSnapshot, ProviderManagementRequest } from '../../../../harness/model-providers/management/contracts.js';
import { projectProviderManagementView } from '../../provider-management/state.js';
import { providerConfigRevision } from '../../../../harness/model-providers/catalog/provider-config.js';
import { createProviderSecretTicket, consumeProviderSecretTicket } from '../../provider-management/secret-tickets.js';
import { EffectRunner } from '../../conversation-state/effects/effect-runner.js';
import { makeEffectRunnerDeps } from '../helpers/effect-runner-deps.js';
const snapshot = (revision: number): ProviderManagementSnapshot => ({ revision, configRevision: providerConfigRevision(`# snapshot ${revision}\n`), loaded: true, providers: [], definitions: [{ id: 'other', name: 'Other', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'local'], discovery: 'openai' }], protocols: [] });
function fresh(): ArchState { const s = createInitialArchState(); return { ...s, settings: { ...s.settings, backendReady: true }, providerManagement: { ...s.providerManagement, snapshot: snapshot(0), generation: 1 } }; }
function command(state: ArchState, c: ProviderSetupCommand, operationId = 'op') { return reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', command: c, operationId, corrId: operationId, generation: 1 } }); }
for (const edit of [{ type: 'change', field: 'baseUrl', value: 'http://localhost' }, { type: 'enabled', value: false }, { type: 'credential', value: 'environment' }, { type: 'manual-model-add', id: 'new-model' }, { type: 'model-preference', id: 'model', field: 'visible', value: 'no' }] as const) test(`draft edit ${edit.type} retires saved acknowledgement`, () => {
  const s = command(fresh(), { type: 'choose', kind: 'custom' }).state;
  s.providerManagement.status = 'saved';
  assert.equal(command(s, edit).state.providerManagement.status, 'idle');
});

test('live saving mutation locks cancellation and late phases cannot override settlement', () => {
  let s = command(fresh(), { type: 'choose', kind: 'custom' }).state;
  s = { ...s, providerManagement: { ...s.providerManagement, status: 'connecting', operationId: 'connect', authOperationId: 'connect' } };
  const push = (state: ArchState, revision: number, operationId: string, generation = 1) => reducer(state, { kind: 'ProviderManagementSnapshotUpdated', generation, snapshot: { ...snapshot(revision), mutation: { operationId, phase: 'saving' } } }).state;
  assert.equal(push(s, 1, 'other').providerManagement.status, 'connecting');
  assert.equal(push(s, 1, 'connect', 0), s);
  const saving = push(s, 2, 'connect');
  assert.equal(saving.providerManagement.status, 'saving');
  for (const type of ['close', 'cancel'] as const) assert.deepEqual(command(saving, { type }).state.providerManagement.flow, saving.providerManagement.flow);
  const finish = (state: ArchState, fence = state.providerManagement.refreshFence) => reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence, selectedId: null, requestType: 'connect', response: { operationId: 'connect', status: 'ok', snapshot: snapshot(1) } }).state;
  assert.equal(finish(saving, saving.providerManagement.refreshFence - 1), saving);
  for (const settled of [finish(saving), push(finish(s), 2, 'connect')]) {
    assert.equal(settled.providerManagement.status, 'saved');
    assert.equal(settled.providerManagement.snapshot.mutation, undefined);
    assert.equal(push(settled, 3, 'connect').providerManagement.status, 'saved');
  }
});
test('fresh state and management projection are isolated; startup read is asynchronous', () => {
  const a = createInitialArchState(), b = createInitialArchState();
  assert.notEqual(a.providerManagement, b.providerManagement);
  assert.equal(projectProviderManagementView(a.providerManagement).mode, 'management');
  assert.equal(a.providerManagement.snapshot.loaded, false);
  assert.deepEqual(a.providerManagement.snapshot.providers, []);
  assert.deepEqual(a.providerManagement.snapshot.definitions, []);
  const ready = reducer(a, { kind: 'BackendReadyChanged', ready: true, backendGeneration: 7 });
  assert.equal(ready.state.settings.backendReady, true);
  assert.equal(ready.state.providerManagement.generation, 7);
  assert.ok(ready.effects.some(e => e.kind === 'ProviderManagementRpc' && e.request.type === 'read'));
});
test('late generations, revisions, and selected-provider ownership cannot replace a wizard', () => {
  const first = command(fresh(), { type: 'edit', id: 'first' }, 'first');
  const next = command(first.state, { type: 'choose', kind: 'custom' }, 'choose');
  const effect = first.effects.find(e => e.kind === 'ProviderManagementRpc'); assert.ok(effect?.kind === 'ProviderManagementRpc');
  const result: Event = { kind: 'ProviderManagementResult', response: { snapshot: snapshot(10), operationId: 'first', status: 'ok', draft: { ...next.state.providerManagement.draft!, id: 'first' } }, generation: 1, fence: effect.fence, selectedId: 'first', requestType: 'read-provider' };
  assert.equal(reducer(next.state, result).state, next.state);
  const pushed = reducer(next.state, { kind: 'ProviderManagementSnapshotUpdated', snapshot: snapshot(4), generation: 1 }).state;
  assert.equal(reducer(pushed, { kind: 'ProviderManagementSnapshotUpdated', snapshot: snapshot(3), generation: 1 }).state.providerManagement.snapshot.revision, 4);
  assert.equal(reducer(pushed, { kind: 'ProviderManagementSnapshotUpdated', snapshot: snapshot(9), generation: 0 }).state, pushed);
  assert.equal(pushed.providerManagement.draft?.id, 'other');
});
test('draft preferences, manual models, full-document save fence and conflict survive', () => {
  let s = reducer(fresh(), { kind: 'ProviderManagementSnapshotUpdated', snapshot: snapshot(5), generation: 1 }).state;
  s = command(s, { type: 'choose', kind: 'custom' }).state;
  s = reducer(s, { kind: 'ProviderManagementSnapshotUpdated', snapshot: snapshot(6), generation: 1 }).state;
  s = command(s, { type: 'manual-model-add', id: 'manual' }).state;
  s = command(s, { type: 'model-preference', id: 'manual', field: 'visible', value: 'no' }).state;
  const saved = command(s, { type: 'save' }, 'save');
  const effect = saved.effects.find(e => e.kind === 'ProviderManagementRpc'); assert.ok(effect?.kind === 'ProviderManagementRpc' && effect.request.type === 'save');
  assert.equal(effect.request.expectedRevision, snapshot(5).configRevision);
  assert.deepEqual(command(saved.state, { type: 'close' }).state.providerManagement.flow, saved.state.providerManagement.flow);
  const failed = reducer(saved.state, { kind: 'ProviderManagementResult', response: { snapshot: snapshot(6), operationId: 'save', status: 'conflict' }, generation: 1, fence: effect.fence, selectedId: null, requestType: 'save' });
  assert.equal(failed.state.providerManagement.status, 'conflict');
  assert.deepEqual(failed.state.providerManagement.draft, s.providerManagement.draft);
});
test('opaque tickets consume once, wrong owner discards, never enter events or state', async () => {
  const secret = 'PRIVATE-KEY-NOT-IN-STATE';
  const wrong = createProviderSecretTicket(secret, 1, 'one');
  assert.equal(consumeProviderSecretTicket(wrong, 2, 'one'), undefined);
  assert.equal(consumeProviderSecretTicket(wrong, 1, 'one'), undefined);
  let state = command(fresh(), { type: 'choose', kind: 'custom' }).state;
  const ticket = createProviderSecretTicket(secret, 1, 'connect');
  const event: Event = { kind: 'Command', cmd: { kind: 'ProviderManagementConnect', operationId: 'connect', corrId: 'connect', generation: 1, method: 'api-key', ticket } };
  const result = reducer(state, event); state = result.state;
  assert.ok(!JSON.stringify({ event, result }).includes(secret));
  const requests: ProviderManagementRequest[] = [];
  const { deps } = makeEffectRunnerDeps({ serviceOverrides: { getBackendGeneration: () => 1, providerManagement: async request => { requests.push(request); return { snapshot: snapshot(1), operationId: request.operationId, status: 'ok' }; } }, dispatchEvent: e => { state = reducer(state, e).state; } });
  deps.getProviderManagementState = () => state.providerManagement;
  const runner = new EffectRunner(deps);
  for (const effect of result.effects) runner.run(effect);
  await new Promise<void>(r => setImmediate(r));
  assert.equal(requests[0].type, 'connect');
  assert.equal(requests[0].type === 'connect' ? requests[0].apiKey : undefined, secret);
  assert.equal(consumeProviderSecretTicket(ticket, 1, 'connect'), undefined);
  assert.ok(!JSON.stringify(state).includes(secret));
});
test('cancel targets server auth operation and stale auth replies discard their ticket', () => {
  let s = command(fresh(), { type: 'choose', kind: 'custom' }).state;
  s = { ...s, providerManagement: { ...s.providerManagement, status: 'connecting', operationId: 'server-auth', authOperationId: 'server-auth', snapshot: { ...snapshot(2), auth: { kind: 'input', operationId: 'server-auth', promptId: 'prompt', message: 'Code' } } } };
  const cancelled = command(s, { type: 'close' }, 'close');
  assert.ok(cancelled.effects.some(e => e.kind === 'ProviderManagementRpc' && e.request.type === 'cancel' && e.request.targetOperationId === 'server-auth'));
  const ticket = createProviderSecretTicket('PRIVATE-CODE', 1, 'reply');
  const stale = reducer(cancelled.state, { kind: 'Command', cmd: { kind: 'ProviderManagementAuthResponse', corrId: 'reply', operationId: 'reply', generation: 1, targetOperationId: 'server-auth', promptId: 'prompt', ticket } });
  assert.deepEqual(stale.effects, [{ kind: 'ProviderManagementDiscardTicket', ticket }]);
  const { deps } = makeEffectRunnerDeps(); const runner = new EffectRunner(deps); for (const effect of stale.effects) runner.run(effect);
  assert.equal(consumeProviderSecretTicket(ticket, 1, 'reply'), undefined);
});
test('edit connects, models manages models, and native choices reuse their registered identity', () => {
  const s = fresh();
  s.providerManagement.snapshot.definitions.push({ id: 'native', name: 'Native', kind: 'custom', api: '', baseUrl: '', authMethods: ['oauth'], discovery: 'unsupported' });
  s.providerManagement.snapshot.providers.push({ id: 'native', name: 'Native', configured: true, enabled: true, modelCount: 0, credentials: 'saved', discovery: 'unsupported' });
  const edit = command(s, { type: 'edit', id: 'native' });
  assert.equal(edit.state.providerManagement.flow.screen, 'connect');
  assert.equal(edit.state.providerManagement.flow.connectionMethod, 'oauth');
  assert.equal(edit.state.providerManagement.flow.navigationOrigin, 'home');
  assert.equal(command(edit.state, { type: 'back' }).state.providerManagement.flow.screen, 'manage');
  const models = command(s, { type: 'models', id: 'native' }).state;
  assert.equal(models.providerManagement.flow.screen, 'models');
  assert.equal(models.providerManagement.flow.navigationOrigin, 'home');
  assert.equal(command(models, { type: 'back' }).state.providerManagement.flow.screen, 'manage');
  const chosen = command(s, { type: 'choose', kind: 'custom', definitionId: 'native' });
  assert.equal(chosen.state.providerManagement.selectedId, 'native');
  assert.equal(projectProviderManagementView(chosen.state.providerManagement).flow?.navigationOrigin, 'chooser');
  assert.equal(command(chosen.state, { type: 'back' }).state.providerManagement.flow.screen, 'choose');
  assert.ok(chosen.effects.some(e => e.kind === 'ProviderManagementRpc' && e.request.type === 'read-provider' && e.request.id === 'native'));
});
test('unknown capabilities cannot choose and partial commit errors remain visible without losing drafts', () => {
  const unknown = fresh(); unknown.providerManagement.snapshot = { ...snapshot(0), loaded: false, definitions: [] };
  const choose = command(command(unknown, { type: 'add' }).state, { type: 'choose', kind: 'chatgpt' });
  assert.equal(choose.state.providerManagement.draft, null);
  assert.equal(projectProviderManagementView(choose.state.providerManagement).status, 'loading');
  const s = command(fresh(), { type: 'choose', kind: 'custom' }).state;
  const saving = command(s, { type: 'save' }, 'save');
  const effect = saving.effects.find(e => e.kind === 'ProviderManagementRpc'); assert.ok(effect?.kind === 'ProviderManagementRpc');
  const failed = reducer(saving.state, { kind: 'ProviderManagementResult', response: { snapshot: { ...snapshot(2), error: 'Configuration saved; credential update failed.' }, operationId: 'save', status: 'error' }, generation: 1, fence: effect.fence, selectedId: null, requestType: 'save' }).state;
  assert.equal(projectProviderManagementView(failed.providerManagement).message, 'Configuration saved; credential update failed.');
  assert.deepEqual(failed.providerManagement.draft, s.providerManagement.draft);
});
