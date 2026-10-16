import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import { createInitialArchState, reducer } from '../../../backend/conversation-state/reducer';
import { projectProviderManagementView } from '../../../backend/provider-management/state';
import type { ProviderManagementEffect } from '../../../backend/provider-management/state';
import type { ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';
installDom();
test('rendered capability actions and host removal cancel, lock, retry, success and remount', () => {
  const container = document.createElement('div'); document.body.append(container);
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, snapshot: { revision: 0, configRevision: null, loaded: true, protocols: [], definitions: [], providers: [
    { id: 'existing', name: 'Existing', configured: true, enabled: true, modelCount: 1, credentials: 'saved', discovery: 'unsupported', readOnly: true, capabilities: { settings: true, editConnection: false, remove: true, forgetCredential: true } },
    { id: 'managed', name: 'Managed', configured: true, enabled: true, modelCount: 1, credentials: 'saved', discovery: 'unsupported' },
  ] } } };
  let serial = 0;
  const requests: Extract<ProviderManagementEffect, { kind: 'ProviderManagementRpc' }>[] = [];
  const command = (value: ProviderSetupCommand) => { const next = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', generation: 1, operationId: `op-${++serial}`, corrId: 'test', command: value } }); state = next.state; requests.push(...next.effects.filter(e => e.kind === 'ProviderManagementRpc')); update(); };
  const update = () => act(() => render(h(ProviderSetupPreview, { presentation: 'tab', view: projectProviderManagementView(state.providerManagement), onCommand: command }), container));
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  const click = (text: string) => act(() => { const button = buttons().find(b => b.textContent === text); assert.ok(button, text); button.click(); });
  const settle = (status: 'ok' | 'error') => { state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence: state.providerManagement.refreshFence, selectedId: 'existing', requestType: 'remove', response: { operationId: state.providerManagement.operationId!, status, snapshot: { ...state.providerManagement.snapshot, revision: state.providerManagement.snapshot.revision + 1, ...(status === 'ok' ? { providers: state.providerManagement.snapshot.providers.filter(p => p.id !== 'existing') } : {}) } } }).state; update(); };
  try {
    update();
    const rows = container.querySelectorAll('li');
    assert.deepEqual(Array.from(rows[0]!.querySelectorAll('button')).map(b => b.textContent), ['Settings', 'Remove']);
    assert.deepEqual(Array.from(rows[1]!.querySelectorAll('button')).map(b => b.textContent), ['Settings', 'Edit', 'Remove']);
    click('Settings');
    assert.equal(requests.at(-1)?.request.type, 'read-provider');
    state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence: state.providerManagement.refreshFence, selectedId: 'existing', requestType: 'read-provider', response: { operationId: state.providerManagement.operationId!, status: 'ok', snapshot: state.providerManagement.snapshot, draft: { originalId: 'existing', id: 'existing', enabled: true, api: '', baseUrl: '', credentialSource: 'saved', environmentName: '', models: [] } } }).state;
    update(); assert.match(container.textContent!, /Connection settings can’t be changed for this provider/);
    act(() => container.querySelector<HTMLButtonElement>('button[role=checkbox]')!.click());
    assert.equal(state.providerManagement.draft?.enabled, false);
    click('Back'); requests.length = 0;
    click('Remove'); assert.match(container.textContent!, /forgets saved Pie credentials/);
    assert.equal(buttons().some(button => button.textContent === 'Back'), false);
    const actions = container.querySelector('.provider-setup-preview-action-group')!;
    assert.deepEqual(Array.from(actions.querySelectorAll('button')).map(button => button.textContent), ['Cancel', 'Remove provider']);
    assert.ok(actions.querySelector('.provider-setup-preview-danger-confirm'));
    click('Cancel'); assert.equal(state.providerManagement.flow.screen, 'manage');
    click('Remove'); act(() => render(null, container)); update(); assert.ok(container.contains(document.activeElement));
    click('Remove provider'); assert.equal(requests.length, 1); assert.equal(requests[0].request.type, 'remove');
    click('Remove provider'); click('Cancel'); assert.equal(requests.length, 1); assert.equal(state.providerManagement.status, 'saving');
    settle('error'); assert.match(container.textContent!, /Provider operation failed/); click('Retry removal'); assert.equal(requests.length, 2); assert.notEqual(requests[1].request.operationId, requests[0].request.operationId);
    settle('ok'); assert.equal(state.providerManagement.flow.screen, 'manage'); assert.equal(state.providerManagement.draft, null); assert.equal(state.providerManagement.selectedId, null); assert.doesNotMatch(container.textContent!, /Existing/);
  } finally { act(() => render(null, container)); container.remove(); }
});
