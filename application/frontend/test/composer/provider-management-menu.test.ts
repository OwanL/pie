import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';
import type { ProviderSetupPreviewView, ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';

test('management tab is always available with props; actions and native cancellation keep parent settings open', () => {
  const container = document.createElement('div'); document.body.append(container);
  const commands: ProviderSetupCommand[] = [];
  const view: ProviderSetupPreviewView = { mode: 'management', providers: [{ id: 'opaque', name: 'Friendly provider', configured: true, enabled: true, modelCount: 2 }], protocols: [], definitions: [{ id: 'opaque', name: 'Friendly provider', kind: 'custom', api: 'test', baseUrl: '', authMethods: ['local'], discovery: 'unsupported' }], loaded: true, draft: null, status: 'idle' };
  const update = () => act(() => render(h(ComposerSettingsMenu, { prefs: DEFAULT_CHAT_PREFS, pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null, toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, availableExtensions: [], availableModels: [], providerGateStats: EMPTY_PROVIDER_GATE_STATS, mcpServers: [], mcpPendingApply: false, onSetPrefs() {}, onMcpListRequested() {}, onMcpSetServerEnabled() {}, onSetPruningSettings() {}, onSetToolResultPruningSettings() {}, providerManagement: { view, onCommand: command => commands.push(command) } }), container));
  const click = (selector: string) => act(() => (document.querySelector(selector) as HTMLButtonElement).click());
  try {
    update(); click('.toolbar-settings-trigger'); click('[data-tab=providers]');
    assert.match(document.querySelector('[role=tabpanel]')!.textContent!, /Friendly provider/);
    assert.equal(document.querySelector('dialog'), null);
    for (const label of ['Edit', 'Models', 'Refresh', 'Add provider']) act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-setup-preview-home button')).find(button => button.textContent === label)!.click());
    assert.deepEqual(commands.map(command => command.type), ['edit', 'models', 'refresh', 'add']);
    view.flow = { open: true, screen: 'choose' }; update();
    const modal = document.querySelector('dialog')!;
    act(() => { modal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    act(() => { modal.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true })); });
    assert.equal(commands.at(-1)?.type, 'close');
    assert.ok(document.querySelector('.toolbar-settings-menu'));
    assert.doesNotMatch(modal.textContent!, /Demo/);
    view.status = 'connecting'; update();
    act(() => { modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(commands.at(-1)?.type, 'cancel');
    assert.ok(document.querySelector('.toolbar-settings-menu'));
  } finally { act(() => render(null, container)); container.remove(); }
});
