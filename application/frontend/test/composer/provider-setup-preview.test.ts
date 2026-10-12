import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import type { ProviderSetupPreviewView, ProviderSetupCommand, ProviderSetupPreviewProps } from '../../../lib/protocol/provider-setup-preview.js';
installDom();
function fixture(): ProviderSetupPreviewView {
  return { mode: 'preview', providers: [{ id: 'openai', configured: true, enabled: true, modelCount: 1 }], protocols: ['test-protocol'], status: 'idle', draft: { originalId: null, id: 'openai', enabled: true, api: '', baseUrl: '', credentialSource: 'default', environmentName: '', models: [{ id: 'technical-id', name: 'Friendly model', visible: 'unset', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } }] } };
}
function mount(view = fixture(), extra: Partial<ProviderSetupPreviewProps> = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const commands: ProviderSetupCommand[] = [];
  const update = () => act(() => render(h(ProviderSetupPreview, { view, onCommand: value => commands.push(value), ...extra }), container));
  update();
  return { view, commands, update, cleanup: () => { act(() => render(null, container)); container.remove(); } };
}
function button(text: string) { const node = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.replace('→', '').trim() === text); assert.ok(node, text); return node; }
function click(text: string) { act(() => button(text).click()); }
test('closed by default; caller controls all stages and dialog restores focus', () => {
  const ui = mount();
  try {
    assert.equal(document.querySelector('dialog'), null);
    button('Manage providers').focus(); click('Manage providers');
    assert.deepEqual(ui.commands, [{ type: 'open' }]); assert.equal(document.querySelector('dialog'), null);
    ui.view.flow = { open: true, screen: 'manage' }; ui.update();
    assert.ok(document.querySelector('dialog[open]')); assert.match(document.body.textContent!, /OpenAI API.*1 models/s);
    click('Add provider'); assert.equal(ui.commands.at(-1)?.type, 'add');
    ui.view.flow.screen = 'choose'; ui.update(); click('ChatGPT');
    assert.deepEqual(ui.commands.at(-1), { type: 'choose', kind: 'chatgpt' });
    click('Back'); assert.equal(ui.commands.at(-1)?.type, 'back');
    act(() => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    assert.equal(ui.commands.at(-1)?.type, 'close'); assert.ok(document.querySelector('dialog'));
    ui.view.flow.open = false; ui.update(); assert.equal(document.activeElement, button('Manage providers'));
  } finally { ui.cleanup(); }
});
test('document Escape stays owned across done, choose, and connect transitions', () => {
  const view = fixture(); view.flow = { open: true, screen: 'done' };
  const ui = mount(view);
  let parentEscapes = 0;
  const parentMenuEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') parentEscapes++; };
  document.addEventListener('keydown', parentMenuEscape);
  try {
    const addAnother = button('Add another provider'); addAnother.focus(); click('Add another provider');
    view.flow.screen = 'choose'; ui.update();
    assert.equal(addAnother.isConnected, false);
    assert.ok(document.querySelector('dialog')!.contains(document.activeElement));
    const choose = button('ChatGPT'); choose.focus(); click('ChatGPT');
    view.flow.screen = 'connect'; view.flow.kind = 'chatgpt'; ui.update();
    assert.notEqual(document.activeElement, choose);
    assert.ok(document.querySelector('dialog')!.contains(document.activeElement));
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(parentEscapes, 0);
    assert.deepEqual(ui.commands, [{ type: 'add' }, { type: 'choose', kind: 'chatgpt' }, { type: 'close' }]);
  } finally { document.removeEventListener('keydown', parentMenuEscape); ui.cleanup(); }
});
test('captured Escape is consumed while saving without issuing close; native cancel is also consumed', () => {
  const view = fixture(); view.flow = { open: true, screen: 'done' }; view.status = 'saving';
  const ui = mount(view);
  try {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(ui.commands, []);
    const cancel = new Event('cancel', { cancelable: true });
    document.querySelector('dialog')!.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.deepEqual(ui.commands, []);
  } finally { ui.cleanup(); }
});
test('keyless local intent stays visible without becoming an editable credential command', () => {
  const view = fixture(); view.flow = { open: true, screen: 'connect', kind: 'custom', connectionMethod: 'local' };
  view.draft!.credentialSource = 'none';
  const ui = mount(view);
  try {
    const select = Array.from(document.querySelectorAll<HTMLSelectElement>('select')).find(node => node.value === 'none');
    assert.ok(select);
    assert.equal(select.selectedOptions[0]?.textContent, 'No credential (local server)');
    assert.equal(select.selectedOptions[0]?.disabled, true);
    assert.deepEqual(ui.commands, []);
  } finally { ui.cleanup(); }
});
test('API secret uses only private callback, clears input, never shows technical clutter or error payloads', () => {
  const view = fixture(); view.flow = { open: true, screen: 'connect', kind: 'openai' };
  const requests: unknown[] = []; const ui = mount(view, { onConnect: request => { requests.push(request); } });
  try {
    const input = document.querySelector<HTMLInputElement>('input[type=password]')!; input.value = 'synthetic-secret';
    act(() => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(requests, [{ method: 'api-key', apiKey: 'synthetic-secret' }]); assert.equal(input.value, ''); assert.deepEqual(ui.commands, []);
    assert.doesNotMatch(document.body.textContent!, /technical-id|Pricing|Subagent|Protocol|Visibility|synthetic-secret/);
    view.status = 'error'; view.message = 'synthetic-secret'; view.issues = [{ path: 'key', message: 'synthetic-secret' }]; ui.update();
    assert.doesNotMatch(document.body.textContent!, /synthetic-secret/);
  } finally { ui.cleanup(); }
});
test('connection actions require callback; sign in is mocked and done only closes', () => {
  const view = fixture(); view.flow = { open: true, screen: 'connect', kind: 'copilot' }; const extra: Partial<ProviderSetupPreviewProps> = {}; const ui = mount(view, extra);
  try {
    assert.equal(button('Sign in').disabled, true); assert.equal(document.querySelector('input[type=password]'), null);
    const requests: unknown[] = []; extra.onConnect = request => { requests.push(request); }; ui.update();
    act(() => { document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.deepEqual(requests, [{ method: 'signin' }]);
    view.flow.screen = 'done'; ui.update(); assert.match(document.body.textContent!, /Provider added/); click('Close'); assert.deepEqual(ui.commands, [{ type: 'close' }]);
  } finally { ui.cleanup(); }
});
test('real provider setup waits for definitions, validates custom URLs, and exposes only safe management errors', () => {
  const view = fixture(); view.mode = 'management'; view.loaded = false; view.providers = []; view.definitions = [];
  const ui = mount(view, { presentation: 'tab' });
  try {
    assert.match(document.body.textContent!, /Loading providers…/); assert.doesNotMatch(document.body.textContent!, /No providers yet/);
    assert.equal(button('Add provider').disabled, true);
    view.loaded = true; view.providers = [{ id: 'constructor', configured: true, enabled: true, modelCount: 1 }]; view.definitions = [{ id: 'constructor', name: 'constructor', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['local'], discovery: 'openai' }]; ui.update();
    assert.match(document.body.textContent!, /constructor/); assert.doesNotMatch(document.body.textContent!, /function/);
    assert.equal(button('Add provider').disabled, false);
    view.providers[0]!.discovery = 'error'; ui.update(); assert.match(document.body.textContent!, /refresh failed; add model IDs manually/);
    view.providers[0]!.discovery = 'unsupported'; ui.update(); assert.match(document.body.textContent!, /add model IDs manually/);
    view.flow = { open: true, screen: 'connect', kind: 'custom', definitionId: 'constructor' }; view.draft = { ...fixture().draft!, id: 'constructor' }; ui.update();
    const url = document.querySelector<HTMLInputElement>('input[type=url]')!; assert.equal(url.required, true);
    view.status = 'error'; view.message = 'Provider setup failed safely.'; ui.update();
    assert.match(document.body.textContent!, /Provider setup failed safely/); assert.doesNotMatch(document.body.textContent!, /function Object/);
  } finally { ui.cleanup(); }
});
test('custom advanced references are collapsed and URL edits remain controlled', () => {
  const view = fixture(); view.flow = { open: true, screen: 'connect', kind: 'custom' }; const requests: unknown[] = []; const ui = mount(view, { onConnect: request => { requests.push(request); } });
  try {
    assert.equal(document.querySelector('details')!.open, false);
    const input = document.querySelector<HTMLInputElement>('input[type=url]')!;
    act(() => { input.value = 'http://localhost:8080'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.deepEqual(ui.commands, [{ type: 'change', field: 'baseUrl', value: 'http://localhost:8080' }]); assert.equal(view.draft!.baseUrl, '');
    act(() => { document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.deepEqual(requests, [{ method: 'local' }]);
  } finally { ui.cleanup(); }
});
test('dynamic management capabilities, saved credentials and private auth responses', () => {
  const view = fixture(); view.mode = 'management';
  view.definitions = [{ id: 'dynamic', name: 'Dynamic provider', kind: 'custom', api: 'test-protocol', baseUrl: 'https://example.test', authMethods: ['oauth', 'api-key'], discovery: 'unsupported' }]; view.loaded = true;
  view.flow = { open: true, screen: 'choose' };
  const responses: unknown[] = []; const connections: unknown[] = [];
  const ui = mount(view, { onConnect: request => connections.push(request), onAuthResponse: request => responses.push(request) });
  try {
    click('Dynamic provider'); assert.deepEqual(ui.commands.at(-1), { type: 'choose', kind: 'custom', definitionId: 'dynamic' });
    assert.doesNotMatch(document.querySelector('dialog')!.textContent!, /Demo|ChatGPT/);
    view.flow = { open: true, screen: 'connect', kind: 'custom', definitionId: 'dynamic', connectionMethod: 'oauth' }; ui.update();
    assert.equal(document.querySelector('input[type=password]'), null); assert.equal(document.querySelector('input[type=url]'), null);
    act(() => { document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.deepEqual(connections, [{ method: 'signin' }]);
    view.flow.connectionMethod = 'api-key'; view.draft!.credentialSource = 'saved'; ui.update(); click('Save existing'); assert.equal(ui.commands.at(-1)?.type, 'save');
    view.status = 'connecting'; view.auth = { kind: 'input', operationId: 'operation', promptId: 'prompt', message: 'Verification code' }; ui.update();
    const input = document.querySelector<HTMLInputElement>('.provider-setup-preview-auth input')!; input.value = 'private-code';
    act(() => { input.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.deepEqual(responses, [{ operationId: 'operation', promptId: 'prompt', value: 'private-code' }]); assert.equal(input.value, ''); assert.doesNotMatch(JSON.stringify(ui.commands), /private-code/);
    view.auth = { kind: 'device', operationId: 'operation', url: 'javascript:alert(1)', code: 'DEVICE' }; ui.update(); assert.equal(document.querySelector('.provider-setup-preview-auth a'), null); assert.match(document.body.textContent!, /DEVICE/);
    view.auth = { kind: 'browser', operationId: 'operation', url: 'https://example.test' }; ui.update(); assert.equal(document.querySelector('a')!.getAttribute('href'), 'https://example.test');
    view.status = 'saved'; view.auth = undefined; view.flow.screen = 'done'; ui.update(); assert.match(document.body.textContent!, /Provider saved/); assert.doesNotMatch(document.body.textContent!, /ready.*chat|Demo/i); click('Add another provider'); assert.equal(ui.commands.at(-1)?.type, 'add');
  } finally { ui.cleanup(); }
});
test('models are separate, inherit remains unset, save is controlled and saving gates all actions', () => {
  const view = fixture(); view.mode = 'management'; view.flow = { open: true, screen: 'models' }; const ui = mount(view);
  try {
    assert.match(document.body.textContent!, /Friendly model/); assert.doesNotMatch(document.body.textContent!, /technical-id|Pricing/);
    assert.equal(document.querySelector('details')!.open, false);
    const manual = document.querySelector<HTMLInputElement>('input')!; manual.value = 'exact/vendor-id';
    act(() => { manual.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.deepEqual(ui.commands.pop(), { type: 'manual-model-add', id: 'exact/vendor-id' }); assert.equal(manual.value, '');
    click('Refresh models'); assert.deepEqual(ui.commands.pop(), { type: 'refresh', id: 'openai' });
    const select = document.querySelector('select')!; assert.equal(select.value, 'unset');
    act(() => { select.value = 'yes'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(view.draft!.models[0].visible, 'unset'); click('Save model visibility preferences');
    assert.deepEqual(ui.commands, [{ type: 'model-preference', id: 'technical-id', field: 'visible', value: 'yes' }, { type: 'save' }]);
    assert.match(document.body.textContent!, /Save model visibility preferences/); assert.match(document.body.textContent!, /apply to new chats only/);
    view.status = 'saving'; ui.update(); assert.ok(Array.from(document.querySelectorAll('button, select')).every(node => (node as HTMLButtonElement).disabled));
    act(() => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    assert.equal(ui.commands.length, 2);
  } finally { ui.cleanup(); }
});
