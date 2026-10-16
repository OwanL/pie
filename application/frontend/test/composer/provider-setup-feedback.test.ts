import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import { createProviderManagementState, projectProviderManagementView } from '../../../backend/provider-management/state';
installDom();

for (const screen of ['models', 'connect'] as const) test(`${screen} read-provider loading does not claim empty inventory`, () => {
  const state = createProviderManagementState();
  state.snapshot.loaded = true;
  state.flow = { open: true, screen, navigationOrigin: 'home' };
  state.status = 'loading';
  const container = document.createElement('div'); document.body.append(container);
  try {
    act(() => render(h(ProviderSetupPreview, { view: projectProviderManagementView(state), presentation: 'tab', onCommand() {} }), container));
    assert.match(container.querySelector('[role=status]')?.textContent || '', /Loading/);
    assert.doesNotMatch(container.textContent || '', /0 models|No models available|Other provider|Server URL/);
  } finally { act(() => render(null, container)); container.remove(); }
});

test('successful Save existing acknowledges completion on connect screen', () => {
  const state = createProviderManagementState();
  state.snapshot.loaded = true;
  state.flow = { open: true, screen: 'connect', kind: 'custom' };
  state.status = 'saved';
  state.draft = { originalId: 'custom', id: 'custom', enabled: true, api: '', baseUrl: '', credentialSource: 'saved', environmentName: '', models: [] };
  const container = document.createElement('div'); document.body.append(container);
  try {
    act(() => render(h(ProviderSetupPreview, { view: projectProviderManagementView(state), presentation: 'tab', onCommand() {} }), container));
    assert.equal(container.querySelector('[role=status]')?.textContent, 'Settings saved.');
  } finally { act(() => render(null, container)); container.remove(); }
});
