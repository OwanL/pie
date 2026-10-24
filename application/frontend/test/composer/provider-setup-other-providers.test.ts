import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import type { ProviderSetupCommand, ProviderSetupPreviewProps, ProviderSetupPreviewView } from '../../../lib/protocol/provider-setup-preview';
import type { ProviderDefinition } from '../../../../harness/model-providers/management/contracts';
installDom();

// DOM component integration only: deterministic public host views, real controls,
// private callback boundary. No backend, credential store, browser auth or network.
const definitions: ProviderDefinition[] = [
  { id: 'openai', name: 'OpenAI API', kind: 'openai', authMethods: ['api-key'], api: 'openai-responses', baseUrl: '', discovery: 'openai' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', authMethods: ['oauth', 'api-key'], api: 'anthropic-messages', baseUrl: '', discovery: 'unsupported' },
  { id: 'github-copilot', name: 'GitHub Copilot', kind: 'copilot', authMethods: ['oauth'], api: '', baseUrl: '', discovery: 'copilot' },
  { id: 'custom', name: 'Other provider', kind: 'custom', authMethods: ['local', 'api-key'], api: '', baseUrl: '', discovery: 'unsupported' },
];
function fixture(id: string, run: (host: ReturnType<typeof mount>) => void) {
  const host = mount(id);
  try { run(host); } finally { host.dispose(); }
}
function mount(id: string) {
  const definition = definitions.find(item => item.id === id)!;
  const container = document.createElement('div'); document.body.appendChild(container);
  let view: ProviderSetupPreviewView = {
    mode: 'management', loaded: true, providers: [], definitions, protocols: ['openai-completions', 'anthropic-messages'], status: 'idle',
    flow: { open: true, screen: 'connect', kind: definition.kind, definitionId: id, connectionMethod: definition.authMethods[0] },
    draft: { originalId: null, id, enabled: true, api: definition.api, baseUrl: '', credentialSource: 'default', environmentName: '', models: [] },
  };
  const commands: ProviderSetupCommand[] = [];
  const connections: Parameters<NonNullable<ProviderSetupPreviewProps['onConnect']>>[0][] = [];
  const responses: Parameters<NonNullable<ProviderSetupPreviewProps['onAuthResponse']>>[0][] = [];
  const draw = () => act(() => render(h(ProviderSetupPreview, { view, onCommand: command => commands.push(command), onConnect: request => connections.push(request), onAuthResponse: response => responses.push(response) }), container));
  draw();
  return {
    commands, connections, responses,
    reply(patch: Partial<ProviderSetupPreviewView>) { view = { ...view, ...patch }; draw(); },
    view: () => view,
    click(label: string) { const node = Array.from(document.querySelectorAll('button')).find(item => item.textContent === label); assert.ok(node, label); act(() => node.click()); },
    input(selector: string, value: string, event = 'input') { const node = document.querySelector<HTMLInputElement>(selector); assert.ok(node, selector); act(() => { node.value = value; node.dispatchEvent(new Event(event, { bubbles: true })); }); },
    labeledInput(label: string, value: string) { const node = Array.from(document.querySelectorAll('label')).find(item => item.textContent?.trim() === label)?.querySelector<HTMLInputElement>('input'); assert.ok(node, `Missing ${label} input`); act(() => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }); },
    dispose() { act(() => render(null, container)); container.remove(); },
  };
}

for (const id of ['openai', 'anthropic']) test(`${id}: API key private submit, host failure/retry, saved reopen/back`, () => fixture(id, host => {
  host.reply({ flow: { ...host.view().flow!, connectionMethod: 'api-key' } });
  const secret = 'synthetic-not-a-credential';
  host.input('input[type=password]', secret); host.click('Connect');
  assert.deepEqual(host.connections, [{ method: 'api-key', apiKey: secret }]);
  assert.equal(document.querySelector<HTMLInputElement>('input[type=password]')!.value, '');
  assert.ok(!JSON.stringify(host.commands).includes(secret)); assert.ok(!JSON.stringify(host.view()).includes(secret));
  host.reply({ status: 'error', message: 'Connection failed. Try again.' });
  assert.match(document.querySelector('[role=alert]')!.textContent!, /Connection failed/);
  host.click('Reload'); assert.deepEqual(host.commands.at(-1), { type: 'reload' });
  host.reply({ status: 'idle' }); host.input('input[type=password]', secret); host.click('Connect');
  assert.equal(host.connections.length, 2);
  host.reply({ status: 'saved', flow: { ...host.view().flow!, screen: 'done' }, draft: { ...host.view().draft!, credentialSource: 'saved' } });
  assert.match(document.body.textContent!, /provider settings have been saved/); host.click('Close');
  host.reply({ flow: { ...host.view().flow!, open: false } }); assert.ok(document.querySelector('dialog') === null);
  host.reply({ flow: { ...host.view().flow!, open: true, screen: 'connect' } });
  assert.equal(document.querySelector<HTMLInputElement>('input[type=password]')!.value, '');
  host.click('Save existing'); assert.deepEqual(host.commands.at(-1), { type: 'save' });
  host.click('Back'); assert.deepEqual(host.commands.at(-1), { type: 'back' });
}));

for (const id of ['anthropic', 'github-copilot']) test(`${id}: OAuth browser/device context coexists with manual prompt; failure and cancel`, () => fixture(id, host => {
  host.click('Sign in'); assert.deepEqual(host.connections, [{ method: 'signin' }]);
  host.reply({ status: 'connecting', auth: { kind: 'device', operationId: 'op', url: 'https://example.test/device', code: 'DEMO-CODE' } });
  assert.match(document.body.textContent!, /DEMO-CODE/);
  host.reply({ authBrowser: { operationId: 'op', url: 'https://example.test/device', code: 'DEMO-CODE', instructions: 'Complete browser sign-in' }, auth: { kind: 'input', operationId: 'op', promptId: 'manual', message: 'Paste callback' } });
  const link = document.querySelector<HTMLAnchorElement>('a')!;
  assert.equal(link.href, 'https://example.test/device'); assert.equal(link.target, '_blank'); assert.match(link.rel, /noopener/);
  assert.match(document.body.textContent!, /DEMO-CODE/); assert.match(document.body.textContent!, /Paste callback/);
  host.input('.provider-setup-preview-auth input', 'synthetic-callback'); host.click('Continue');
  assert.deepEqual(host.responses, [{ operationId: 'op', promptId: 'manual', value: 'synthetic-callback' }]);
  assert.equal(document.querySelector<HTMLInputElement>('.provider-setup-preview-auth input')!.value, '');
  host.click('Cancel'); assert.deepEqual(host.commands.at(-1), { type: 'cancel' });
  host.reply({ status: 'error', auth: undefined, authBrowser: undefined, message: 'Sign-in failed.' });
  assert.match(document.querySelector('[role=alert]')!.textContent!, /Sign-in failed/); assert.ok(document.querySelector('a') === null);
  host.reply({ status: 'connecting', auth: { kind: 'progress', operationId: 'new', message: 'Waiting' }, authBrowser: { operationId: 'old', url: 'https://example.test/stale' } });
  assert.ok(document.querySelector('a') === null);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.deepEqual(host.commands.at(-1), { type: 'cancel' });
}));

test('custom: URL/protocol/environment metadata, method transition, manual models and saved metadata', () => fixture('custom', host => {
  host.input('input[type=url]', 'https://example.test/v1');
  assert.deepEqual(host.commands.at(-1), { type: 'change', field: 'baseUrl', value: 'https://example.test/v1' });
  host.reply({ draft: { ...host.view().draft!, baseUrl: 'https://example.test/v1' } });
  host.input('details select', 'openai-completions', 'change');
  assert.deepEqual(host.commands.at(-1), { type: 'change', field: 'api', value: 'openai-completions' });
  host.input('details label:nth-of-type(2) select', 'environment', 'change');
  assert.deepEqual(host.commands.at(-1), { type: 'credential', value: 'environment' });
  host.reply({ draft: { ...host.view().draft!, credentialSource: 'environment' } });
  host.labeledInput('Variable name', 'DEMO_PROVIDER_KEY'); assert.deepEqual(host.commands.at(-1), { type: 'change', field: 'environmentName', value: 'DEMO_PROVIDER_KEY' });
  host.click('Connect'); assert.deepEqual(host.connections.at(-1), { method: 'local' });
  host.input('form > label > select', 'api-key', 'change'); assert.deepEqual(host.commands.at(-1), { type: 'auth-method', method: 'api-key' });
  host.reply({ flow: { ...host.view().flow!, connectionMethod: 'api-key' } }); assert.ok(document.querySelector('input[type=password]'));
  host.reply({ flow: { ...host.view().flow!, screen: 'models' } });
  host.labeledInput('Exact model ID', 'exact-demo-model'); host.click('Add model'); assert.deepEqual(host.commands.at(-1), { type: 'manual-model-add', id: 'exact-demo-model' });
  host.reply({ draft: { ...host.view().draft!, models: [{ id: 'exact-demo-model', name: 'Demo model', visible: 'unset', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } }] } });
  assert.match(document.body.textContent!, /Price unknown/);
  host.input('select[aria-label^=Visibility]', 'no', 'change'); assert.deepEqual(host.commands.at(-1), { type: 'model-preference', id: 'exact-demo-model', field: 'visible', value: 'no' });
  host.click('Save settings'); assert.deepEqual(host.commands.at(-1), { type: 'save' });
  host.reply({ status: 'saved', draft: { ...host.view().draft!, models: host.view().draft!.models.map(model => ({ ...model, visible: 'no' })) } });
  assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label^=Visibility]')!.value, 'no');
}));
