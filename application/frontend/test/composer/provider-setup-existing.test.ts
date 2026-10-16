import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import { createProviderManagementState, projectProviderManagementView } from '../../../backend/provider-management/state';
import { isProviderManagementSnapshot } from '../../../../harness/model-providers/management/validation';
import type { ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';
installDom();

// OAuth and saved API keys share the same public credential-presence summary.
for (const source of ['OAuth', 'API key', 'environment'] as const) test(`existing ${source} inventory is informational; managed actions remain usable`, () => {
  const container = document.createElement('div'); document.body.append(container);
  const state = createProviderManagementState();
  state.snapshot = { ...state.snapshot, revision: 1, loaded: true, providers: [
    { id: 'legacy', name: `Legacy ${source}`, origin: 'existing', readOnly: true, configured: true, enabled: true, modelCount: 2, credentials: source === 'environment' ? 'environment' : 'saved', discovery: 'unsupported' },
    { id: 'managed', name: 'Managed', origin: 'managed', readOnly: false, configured: true, enabled: true, modelCount: 1, credentials: 'saved', discovery: 'unsupported' },
  ], definitions: [{ id: 'other', name: 'Other', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['api-key', 'local'], discovery: 'openai' }] };
  const commands: ProviderSetupCommand[] = [];
  assert.equal(isProviderManagementSnapshot(state.snapshot), true);
  try {
    act(() => render(h(ProviderSetupPreview, { view: projectProviderManagementView(state), presentation: 'tab', onCommand: command => commands.push(command) }), container));
    const rows = container.querySelectorAll('li');
    assert.equal(rows[0].querySelector('strong')?.textContent, `Legacy ${source}`);
    assert.equal(rows[0].textContent, `Legacy ${source}2 models`);
    assert.equal(rows[0].querySelectorAll('button, input, select, a').length, 0);
    assert.doesNotMatch(container.innerHTML, /access_token|refresh_token|apiKey|PRIVATE_KEY|Sign in|Not configured/);
    const actions = Array.from(rows[1].querySelectorAll('button'));
    assert.deepEqual(actions.map(button => button.textContent), ['Settings', 'Edit', 'Remove']);
    for (const button of actions) { assert.equal(button.disabled, false); act(() => button.click()); }
    assert.deepEqual(commands, [{ type: 'models', id: 'managed' }, { type: 'edit', id: 'managed' }, { type: 'remove', id: 'managed' }]);
    const add = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Add provider')!;
    assert.equal(add.disabled, false); act(() => add.click());
    assert.deepEqual(commands.at(-1), { type: 'add' });
  } finally { act(() => render(null, container)); container.remove(); }
});

// Capability-based copy: existing/edit-locked rows report only the model count;
// editable rows keep discovery/manual guidance.
test('home rows use capability-based copy for inventory and manual guidance', () => {
  const container = document.createElement('div'); document.body.append(container);
  const state = createProviderManagementState();
  state.snapshot = { ...state.snapshot, revision: 1, loaded: true, protocols: [], providers: [
    { id: 'legacy', name: 'Legacy inventory', origin: 'existing', readOnly: false, configured: true, enabled: true, modelCount: 11, credentials: 'saved', discovery: 'unsupported', capabilities: { settings: true, editConnection: false, remove: true, forgetCredential: false } },
    { id: 'cached', name: 'Cached discovery', origin: 'managed', readOnly: false, configured: true, enabled: true, modelCount: 3, credentials: 'saved', discovery: 'cached', capabilities: { settings: true, editConnection: true, remove: true, forgetCredential: true } },
    { id: 'locked', name: 'Legacy connection', origin: 'existing', readOnly: false, configured: true, enabled: true, modelCount: 5, credentials: 'saved', discovery: 'unsupported', capabilities: { settings: true, editConnection: false, remove: true, forgetCredential: false } },
    { id: 'legacy-guard', name: 'Legacy guard', readOnly: true, configured: true, enabled: true, modelCount: 4, credentials: 'saved', discovery: 'unsupported' },
  ] };
  try {
    act(() => render(h(ProviderSetupPreview, { view: projectProviderManagementView(state), presentation: 'tab', onCommand() {} }), container));
    const rows = container.querySelectorAll('li');
    // Row copy is the label block strong+small pair; action buttons live in a sibling div.
    const info = (row: Element) => row.querySelector('div:first-child')?.textContent;
    assert.equal(info(rows[0]), 'Legacy inventory11 models');
    assert.doesNotMatch(rows[0].textContent || '', /add model IDs manually|cached last known|refreshing|Not configured/);
    assert.equal(info(rows[1]), 'Cached discovery3 models · cached last known');
    assert.equal(info(rows[2]), 'Legacy connection5 models');
    // Absent capabilities retain the legacy readOnly guard.
    assert.equal(info(rows[3]), 'Legacy guard4 models');
    assert.doesNotMatch(container.innerHTML, /refresh failed/);
  } finally { act(() => render(null, container)); container.remove(); }
});

for (const nonempty of [false, true]) test(`inventory failure with ${nonempty ? 'retained' : 'empty'} rows renders host message, not empty success`, () => {
  const container = document.createElement('div'); document.body.append(container);
  const state = createProviderManagementState();
  state.snapshot.error = 'Existing provider connections could not be loaded.';
  if (nonempty) state.snapshot.providers = [{ id: 'legacy', name: 'Legacy', origin: 'existing', readOnly: true, configured: true, enabled: true, modelCount: 0, credentials: 'saved', discovery: 'unsupported' }];
  // Snapshot errors can arrive without an error result/status transition.
  assert.equal(state.status, 'idle');
  try {
    act(() => render(h(ProviderSetupPreview, { view: projectProviderManagementView(state), presentation: 'tab', onCommand() {} }), container));
    assert.equal(container.querySelector('[role=alert]')?.textContent, state.snapshot.error);
    assert.doesNotMatch(container.textContent || '', /No providers yet|Loading providers/);
    assert.equal(container.querySelectorAll('li').length, nonempty ? 1 : 0);
    if (nonempty) assert.match(container.textContent || '', /0 models/);
  } finally { act(() => render(null, container)); container.remove(); }
});
