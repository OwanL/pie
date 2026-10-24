import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { createInitialArchState, reducer } from '../../../backend/conversation-state/reducer';
import { projectProviderManagementView } from '../../../backend/provider-management/state';
import type { Effect } from '../../../backend/conversation-state/effects/effects';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index';
import type { ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';
installDom();

test('Settings suspension preserves host OAuth/save ownership but clears detached secret inputs', () => {
  const container = document.createElement('div'); document.body.append(container);
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, snapshot: { revision: 0, configRevision: null, loaded: true, protocols: [], providers: [], definitions: [{ id: 'openai', name: 'OpenAI', kind: 'openai', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'oauth'], discovery: 'unsupported' }] } } };
  let serial = 0;
  let lastEffects: Effect[] = [];
  const command = (value: ProviderSetupCommand) => { const next = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', generation: 1, operationId: `op-${++serial}`, corrId: 'test', command: value } }); state = next.state; lastEffects = next.effects; update(); };
  const update = () => act(() => render(h(ComposerSettingsMenu, { prefs: DEFAULT_CHAT_PREFS, pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null, toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, availableExtensions: [], availableModels: [], providerGateStats: EMPTY_PROVIDER_GATE_STATS, mcpServers: [], mcpPendingApply: false, onSetPrefs() {}, onMcpListRequested() {}, onMcpSetServerEnabled() {}, onSetPruningSettings() {}, onSetToolResultPruningSettings() {}, providerManagement: { view: projectProviderManagementView(state.providerManagement), onCommand: command } }), container));
  const click = (selector: string) => act(() => (document.querySelector(selector) as HTMLButtonElement).click());
  const push = (revision: number, operationId: string) => { state = reducer(state, { kind: 'ProviderManagementSnapshotUpdated', generation: 1, snapshot: { ...state.providerManagement.snapshot, revision, auth: { kind: 'input', operationId, promptId: 'prompt', message: 'Code', allowEmpty: false } } }).state; update(); };
  try {
    update(); click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    command({ type: 'add' }); command({ type: 'choose', kind: 'openai' });
    assert.equal(state.providerManagement.flow.navigationOrigin, 'chooser');
    click('[data-tab=chat]'); click('[data-tab=providers]');
    const back = () => act(() => (Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview button')).find(button => button.textContent === 'Back')!).click());
    back(); assert.equal(state.providerManagement.flow.screen, 'choose');
    for (const type of ['edit', 'models'] as const) {
      command({ type, id: 'openai' });
      assert.equal(state.providerManagement.flow.navigationOrigin, 'home');
      click('[data-tab=chat]'); click('[data-tab=providers]');
      back(); assert.equal(state.providerManagement.flow.screen, 'manage');
      assert.equal(state.providerManagement.draft, null);
    }
    command({ type: 'add' }); command({ type: 'choose', kind: 'openai' });
    const key = document.querySelector<HTMLInputElement>('input[type=password]')!; key.value = 'private-key';
    click('[data-tab=chat]'); assert.equal(key.value, '');
    click('[data-tab=providers]');
    state = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagementConnect', generation: 1, operationId: 'login', corrId: 'login', method: 'oauth' } }).state;
    push(1, 'login');
    const input = document.querySelector<HTMLInputElement>('.provider-setup-preview-auth input')!; input.value = 'private-code';
    // X closing Settings follows the surface's same safe close lifecycle even
    // mid-auth: the subflow and unsaved draft reset and the in-flight sign-in
    // is cancelled — secrets are never persisted and no backend configuration
    // is mutated. Tab switching alone still only suspends (below).
    click('.toolbar-settings-close'); assert.equal(input.value, '');
    assert.equal(state.providerManagement.authOperationId, null);
    assert.equal(state.providerManagement.flow.open, false);
    assert.equal(state.providerManagement.draft, null);
    const cancelled = lastEffects.flatMap(effect => effect.kind === 'ProviderManagementRpc' && effect.request.type === 'cancel' ? [effect.request] : []).at(0);
    assert.equal(cancelled?.targetOperationId, 'login');
    push(2, 'login');
    assert.ok(document.querySelector('.provider-setup-preview-auth') === null);
    click('.toolbar-settings-trigger');
    assert.ok(document.querySelector('.provider-setup-preview-home'));
    assert.ok(document.querySelector('.provider-setup-preview-auth input') === null);
    assert.ok(document.activeElement === document.querySelector('.toolbar-settings-search-input'));
    command({ type: 'add' }); command({ type: 'choose', kind: 'openai' });
    state = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagementConnect', generation: 1, operationId: 'login2', corrId: 'login2', method: 'oauth' } }).state;
    push(3, 'login2');
    assert.ok(document.querySelector('.provider-setup-preview-auth input'));
    click('[data-tab=chat]'); click('[data-tab=providers]');
    assert.equal(state.providerManagement.authOperationId, 'login2');
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview button')).find(button => button.textContent === 'Cancel')!;
    act(() => cancel.click());
    assert.equal(state.providerManagement.authOperationId, null);
    assert.equal(state.providerManagement.flow.screen, 'manage');
    command({ type: 'choose', kind: 'openai' });
    push(4, 'login2'); assert.ok(document.querySelector('.provider-setup-preview-auth') === null);
    command({ type: 'manual-model-add', id: 'manual' });
    command({ type: 'model-preference', id: 'manual', field: 'visible', value: 'no' });
    command({ type: 'refresh', id: 'openai' });
    const refreshOwner = state.providerManagement.operationId!;
    const refreshFence = state.providerManagement.refreshFence;
    click('[data-tab=chat]');
    state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence: refreshFence, selectedId: null, requestType: 'refresh', response: { operationId: refreshOwner, status: 'ok', snapshot: { ...state.providerManagement.snapshot, revision: 4 }, draft: { ...state.providerManagement.draft!, models: [] } } }).state;
    update(); click('[data-tab=providers]');
    assert.equal(state.providerManagement.draft?.models[0]?.id, 'manual');
    assert.equal(state.providerManagement.draft?.models[0]?.visible, 'no');
    command({ type: 'save' });
    const owner = state.providerManagement.operationId!;
    const fence = state.providerManagement.refreshFence;
    click('[data-tab=chat]'); click('.toolbar-settings-close');
    state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence, selectedId: null, requestType: 'save', response: { operationId: owner, status: 'ok', snapshot: { ...state.providerManagement.snapshot, revision: 4 } } }).state;
    update(); assert.equal(state.providerManagement.status, 'saved');
    click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    assert.equal(state.providerManagement.status, 'saved');
  } finally { act(() => render(null, container)); container.remove(); }
});

test('Settings X closing a models screen resets unsaved preferences like Back; no save is issued', () => {
  const container = document.createElement('div'); document.body.append(container);
  let state = createInitialArchState();
  state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, snapshot: { revision: 0, configRevision: 'cfg-1', loaded: true, protocols: [], providers: [
    { id: 'openai', name: 'OpenAI', origin: 'managed', readOnly: false, configured: true, enabled: true, modelCount: 2, credentials: 'default', discovery: 'unsupported', capabilities: { settings: true, editConnection: true, remove: true, forgetCredential: false } },
  ], definitions: [{ id: 'openai', name: 'OpenAI', kind: 'openai', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'oauth'], discovery: 'unsupported' }] } } };
  let serial = 0;
  let lastEffects: Effect[] = [];
  const command = (value: ProviderSetupCommand) => { const next = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', generation: 1, operationId: `op-${++serial}`, corrId: 'test', command: value } }); state = next.state; lastEffects = next.effects; update(); };
  const update = () => act(() => render(h(ComposerSettingsMenu, { prefs: DEFAULT_CHAT_PREFS, pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null, toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, availableExtensions: [], availableModels: [], providerGateStats: EMPTY_PROVIDER_GATE_STATS, mcpServers: [], mcpPendingApply: false, onSetPrefs() {}, onMcpListRequested() {}, onMcpSetServerEnabled() {}, onSetPruningSettings() {}, onSetToolResultPruningSettings() {}, providerManagement: { view: projectProviderManagementView(state.providerManagement), onCommand: command } }), container));
  const click = (selector: string) => act(() => (document.querySelector(selector) as HTMLButtonElement).click());
  const openModels = () => { command({ type: 'models', id: 'openai' }); state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence: state.providerManagement.refreshFence, selectedId: 'openai', requestType: 'read-provider', response: { operationId: state.providerManagement.operationId!, status: 'ok', snapshot: { ...state.providerManagement.snapshot, revision: state.providerManagement.snapshot.revision + 1 }, draft: { originalId: 'openai', id: 'openai', enabled: true, api: 'openai-completions', baseUrl: '', credentialSource: 'default', environmentName: '', models: [{ id: 'm1', name: 'Model', visible: 'unset', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } }] } } }).state; update(); };
  const prefer = (value: string) => act(() => { const select = document.querySelector<HTMLSelectElement>('select[aria-label="Visibility for Model"]')!; assert.equal(select.value, 'unset'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
  try {
    update(); click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    // Settings X close is the same draft reset as Back/back-cancellation.
    openModels(); prefer('no');
    assert.equal(state.providerManagement.draft?.models[0]?.visible, 'no');
    click('.toolbar-settings-close');
    assert.equal(state.providerManagement.draft, null);
    assert.equal(state.providerManagement.flow.open, false);
    assert.equal(state.providerManagement.status, 'idle');
    click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    assert.ok(document.querySelector('.provider-setup-preview-home'));
    assert.ok(document.querySelector('.provider-setup-preview-models-page') === null);
    // Back from the models screen resets identically, and neither path saves.
    openModels(); prefer('no');
    const edited = () => state.providerManagement.draft;
    assert.ok(edited());
    assert.equal(edited()?.models[0]?.visible, 'no');
    lastEffects = [];
    const back = Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview button')).find(button => button.textContent === 'Back')!;
    act(() => back.click());
    assert.equal(state.providerManagement.draft, null);
    assert.equal(state.providerManagement.flow.screen, 'manage');
    assert.ok(lastEffects.every(effect => !(effect.kind === 'ProviderManagementRpc' && effect.request.type === 'save')));
  } finally { act(() => render(null, container)); container.remove(); }
});
