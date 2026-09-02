import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
installDom();

import { SessionTitlesModelAssignment, SessionTitlesSection } from '../../../src/webview/panel/composer/settings-menu-subcomponents';
import type { ModelPickerEntry } from '../../../src/webview/panel/composer/model-list';

const entries: ModelPickerEntry[] = [{
  label: 'DeepSeek V4 Flash',
  selectedLabel: 'DeepSeek V4 Flash',
  ineligible: false,
  title: 'DeepSeek V4 Flash',
  tokenInPrice: '$0.00',
  tokenOutPrice: '$0.00',
  supportsImages: false,
  model: {
    id: 'deepseek-v4-flash:0731-cloud',
    name: 'DeepSeek V4 Flash',
    provider: 'ollama',
    reasoning: true,
    thinkingLevels: ['off', 'low'],
    inputKinds: ['text'],
  },
}];

const settings = {
  enabled: true,
  provider: 'ollama',
  model: 'deepseek-v4-flash:0731-cloud',
  thinkingLevel: 'off' as const,
  timeoutSec: 15,
};

test('session-title behavior exposes only the enable toggle and timeout', () => {
  const container = document.createElement('div');
  const calls: unknown[] = [];
  act(() => {
    render(h(SessionTitlesSection, {
      settings,
      onSetSessionTitlesSettings: (patch) => calls.push(patch),
    }), container);
  });

  assert.match(container.textContent ?? '', /Generate session titles/);
  assert.match(container.textContent ?? '', /Title timeout/);
  assert.doesNotMatch(container.textContent ?? '', /Title model/);
  assert.equal((container.querySelector('[aria-label="Session title timeout"]') as HTMLInputElement).value, '15');

  const toggle = container.querySelector('[role="checkbox"]');
  assert.ok(toggle);
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, [{ enabled: false }]);
  render(null, container);
});

test('session-title model assignment exposes provider-qualified model and thinking controls', () => {
  const container = document.createElement('div');
  act(() => {
    render(h(SessionTitlesModelAssignment, {
      settings,
      modelEntries: entries,
      availableModels: entries.map((entry) => entry.model),
      onSetSessionTitlesSettings: () => undefined,
    }), container);
  });

  assert.match(container.textContent ?? '', /Title model/);
  assert.match(container.textContent ?? '', /Title thinking/);
  assert.match(container.textContent ?? '', /DeepSeek V4 Flash/);
  assert.doesNotMatch(container.textContent ?? '', /Title timeout/);
  const thinkingSelect = container.querySelector('[aria-label="Session title thinking level"]') as HTMLSelectElement;
  assert.equal(thinkingSelect.value, 'off');
  assert.ok(thinkingSelect.querySelector('option[value="low"]'));
  assert.equal(thinkingSelect.querySelector('option[value="high"]'), null);
  render(null, container);
});

test('session-title model assignment is disabled with a hint when titles are off', () => {
  const htmlContainer = document.createElement('div');
  act(() => {
    render(h(SessionTitlesModelAssignment, {
      settings: { ...settings, enabled: false },
      modelEntries: entries,
      availableModels: entries.map((entry) => entry.model),
      onSetSessionTitlesSettings: () => undefined,
    }), htmlContainer);
  });
  assert.ok((htmlContainer.querySelector('[aria-label="Session title model"]') as HTMLButtonElement).disabled);
  assert.match(htmlContainer.textContent ?? '', /Enable session titles in Chat/);
  render(null, htmlContainer);
});
