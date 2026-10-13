import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import type { ProviderSetupPreviewView, ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';
installDom();
test('inline direct edit/models return home; add connection returns chooser', () => {
  const container = document.createElement('div'); document.body.append(container);
  const view: ProviderSetupPreviewView = { mode: 'management', loaded: true, providers: [{ id: 'openai', configured: true, enabled: true, modelCount: 0 }], definitions: [{ id: 'openai', name: 'OpenAI API', kind: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', authMethods: ['api-key'], discovery: 'unsupported' }], protocols: [], draft: null, status: 'idle' };
  const commands: ProviderSetupCommand[] = [];
  const update = () => act(() => render(h(ProviderSetupPreview, { view, presentation: 'tab', onCommand: value => commands.push(value) }), container));
  const click = (name: string) => act(() => { const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.replace('→', '').trim() === name)!; button.focus(); button.click(); });
  try {
    for (const [action, screen] of [['Edit', 'connect'], ['Models', 'models']] as const) {
      view.flow = { open: false, screen: 'manage' }; update(); click(action);
      view.flow = { open: true, screen, kind: 'openai' }; update(); click('Back');
      assert.equal(commands.at(-1)?.type, 'close');
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(commands.at(-1)?.type, 'close');
    }
    view.flow = { open: false, screen: 'manage' }; update(); click('Add provider');
    view.flow = { open: true, screen: 'choose' }; update(); click('OpenAI API');
    view.flow = { open: true, screen: 'connect', kind: 'openai', navigationOrigin: 'chooser' }; update(); click('Back');
    assert.equal(commands.at(-1)?.type, 'back');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(commands.at(-1)?.type, 'back');
  } finally { act(() => render(null, container)); container.remove(); }
});
test('inline subpages stay in owner and scope Escape; home focus returns', () => {
  const container = document.createElement('div'); document.body.append(container);
  const outside = document.createElement('button'); document.body.append(outside);
  const view: ProviderSetupPreviewView = { mode: 'preview', providers: [], protocols: [], draft: null, status: 'idle', flow: { open: false, screen: 'manage' } };
  const commands: ProviderSetupCommand[] = [];
  const update = () => act(() => render(h(ProviderSetupPreview, { view, presentation: 'tab', onCommand: value => commands.push(value) }), container));
  let escapes = 0;
  const parent = () => { escapes++; };
  document.addEventListener('keydown', parent);
  const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  try {
    update();
    const add = container.querySelector('button')!; add.focus(); act(() => add.click());
    view.flow = { open: true, screen: 'choose' }; update();
    assert.equal(document.querySelector('dialog'), null);
    assert.ok(container.querySelector('.provider-setup-preview-inline')?.contains(document.activeElement));
    assert.equal(Array.from(container.querySelectorAll('button')).some(node => node.textContent === 'Close'), false);
    escape(); assert.equal(commands.at(-1)?.type, 'back'); assert.equal(escapes, 0);
    outside.focus(); escape(); assert.equal(escapes, 1);
    view.flow.screen = 'manage'; update();
    assert.equal(document.activeElement, container.querySelector('button'));
    escape(); assert.equal(escapes, 2);
    for (const screen of ['connect', 'models', 'done'] as const) {
      view.flow = { open: true, screen, kind: 'openai' }; update();
      assert.equal(document.querySelector('dialog'), null);
      assert.ok(container.querySelector('.provider-setup-preview-inline'));
    }
  } finally { document.removeEventListener('keydown', parent); act(() => render(null, container)); container.remove(); outside.remove(); }
});
