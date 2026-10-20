import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';
import type { ProviderSetupPreviewView, ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';

test('model and concurrency settings use explicit tombstones over stale catalogs and saved provider preferences', () => {
  const container = document.createElement('div'); document.body.append(container);
  const view: ProviderSetupPreviewView = { mode: 'management', providers: [], protocols: [], loaded: true, draft: null, status: 'idle', removedProviderIds: ['removed-provider'] };
  const prefs = { ...DEFAULT_CHAT_PREFS, providerToggles: { 'removed-provider': true }, providerConcurrency: { 'removed-provider': { maxConcurrentRequests: 3 } } };
  const update = () => act(() => render(h(ComposerSettingsMenu, { prefs, pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null, toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, availableExtensions: [], availableModels: [{ provider: 'removed-provider', id: 'old', name: 'Old', reasoning: false, inputKinds: ['text'] }], providerGateStats: EMPTY_PROVIDER_GATE_STATS, mcpServers: [], mcpPendingApply: false, onSetPrefs() { assert.fail('removal must not delete preferences'); }, onMcpListRequested() {}, onMcpSetServerEnabled() {}, onSetPruningSettings() {}, onSetToolResultPruningSettings() {}, providerManagement: { view, onCommand() {} } }), container));
  const click = (selector: string) => act(() => (document.querySelector(selector) as HTMLButtonElement).click());
  try {
    update(); click('.toolbar-settings-trigger'); click('[data-tab=models]');
    assert.doesNotMatch(document.querySelector('[role=tabpanel]')!.textContent!, /removed-provider/);
    view.removedProviderIds = []; update();
    assert.match(document.querySelector('[role=tabpanel]')!.textContent!, /removed-provider/);
    assert.equal(prefs.providerToggles['removed-provider'], true);
  } finally { act(() => render(null, container)); container.remove(); }
});

test('management tab integrates inline navigation, Escape, tab switching and Settings closing', () => {
  const container = document.createElement('div'); document.body.append(container);
  const commands: ProviderSetupCommand[] = [];
  const view: ProviderSetupPreviewView = { mode: 'management', providers: [{ id: 'opaque', name: 'Friendly provider', configured: true, enabled: false, modelCount: 2, discovery: 'unsupported' }], protocols: [], definitions: [{ id: 'opaque', name: 'Friendly provider', kind: 'custom', api: 'test', baseUrl: '', authMethods: ['local'], discovery: 'unsupported' }], loaded: true, draft: null, status: 'idle' };
  const update = () => act(() => render(h(ComposerSettingsMenu, { prefs: DEFAULT_CHAT_PREFS, pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null, toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, availableExtensions: [], availableModels: [], providerGateStats: EMPTY_PROVIDER_GATE_STATS, mcpServers: [], mcpPendingApply: false, onSetPrefs() {}, onMcpListRequested() {}, onMcpSetServerEnabled() {}, onSetPruningSettings() {}, onSetToolResultPruningSettings() {}, providerManagement: { view, onCommand: command => commands.push(command) } }), container));
  const click = (selector: string) => act(() => (document.querySelector(selector) as HTMLButtonElement).click());
  try {
    update(); click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    assert.match(document.querySelector('[role=tabpanel]')!.textContent!, /Friendly provider/);
    assert.match(document.querySelector('[role=tabpanel]')!.textContent!, /2 models · add model IDs manually/);
    assert.match(document.querySelector('[role=tabpanel]')!.textContent!, /Disabled/);
    assert.equal(document.querySelector('dialog'), null);
    for (const label of ['Edit', 'Settings', 'Remove', 'Add provider']) act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview-home button')).find(button => button.textContent === label)!.click());
    assert.deepEqual(commands.map(command => command.type), ['edit', 'models', 'remove', 'add']);
    view.flow = { open: true, screen: 'choose' }; update();
    const page = document.querySelector('.provider-setup-preview-inline')!;
    assert.equal(document.querySelector('dialog'), null);
    assert.ok(document.querySelector('[role=tabpanel]')!.contains(page));
    act(() => { page.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    assert.ok(document.querySelector('.toolbar-settings-menu'));
    assert.doesNotMatch(page.textContent!, /Demo/);
    const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    escape();
    assert.equal(commands.at(-1)?.type, 'back');
    assert.ok(document.querySelector('.toolbar-settings-menu'));
    view.status = 'connecting'; update();
    escape();
    assert.equal(commands.at(-1)?.type, 'cancel');
    assert.ok(document.querySelector('.toolbar-settings-menu'));

    // Switching tabs unmounts the subpage without dismissing Settings or
    // leaving its capture-phase Escape listener behind.
    const count = commands.length;
    click('[data-tab=chat]');
    assert.equal(document.querySelector('.provider-setup-preview-inline'), null);
    assert.ok(document.querySelector('.toolbar-settings-menu'));
    assert.equal(commands.length, count);
    click('[data-tab=providers]');
    assert.ok(document.querySelector('.provider-setup-preview-inline'));
    click('.toolbar-settings-close');
    assert.equal(document.querySelector('.toolbar-settings-menu'), null);
    // Closing Settings now follows the surface's safe close lifecycle: the
    // active subflow is closed, so its unsaved draft is reset (no secrets).
    assert.equal(commands.at(-1)?.type, 'close');
    escape();
    assert.equal(commands.length, count + 1);

    view.status = 'idle'; view.flow = { open: false, screen: 'manage' }; update();
    click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    const edit = Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview-home button')).find(button => button.textContent === 'Edit')!;
    act(() => { edit.focus(); edit.click(); });
    view.flow = { open: true, screen: 'connect' }; update();
    escape();
    assert.equal(commands.at(-1)?.type, 'close');
    assert.ok(document.querySelector('.toolbar-settings-menu'));
    view.flow = { open: false, screen: 'manage' }; update();
    assert.equal(document.activeElement?.textContent, 'Edit');
    escape();
    assert.equal(document.querySelector('.toolbar-settings-menu'), null);
  } finally { act(() => render(null, container)); container.remove(); }
});
