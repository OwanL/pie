import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
installDom();

import { SessionTitlesSection } from '../../../src/webview/panel/composer/settings-menu-session-titles';
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
    inputKinds: ['text'],
  },
}];

test('session-title settings expose an enable toggle and provider-qualified model picker', () => {
  const container = document.createElement('div');
  const calls: unknown[] = [];
  act(() => {
    render(h(SessionTitlesSection, {
      settings: { enabled: true, provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud', thinkingLevel: 'off', timeoutSec: 15 },
      modelEntries: entries,
      availableModels: entries.map((entry) => entry.model),
      onSetSessionTitlesSettings: (settings) => calls.push(settings),
    }), container);
  });
  assert.match(container.textContent ?? '', /Generate session titles/);
  assert.match(container.textContent ?? '', /Title model/);
  assert.match(container.textContent ?? '', /Title thinking/);
  assert.match(container.textContent ?? '', /Title timeout/);
  assert.match(container.textContent ?? '', /DeepSeek V4 Flash/);
  assert.equal((container.querySelector('[aria-label="Session title thinking level"]') as HTMLSelectElement).value, 'off');
  assert.equal((container.querySelector('[aria-label="Session title timeout"]') as HTMLInputElement).value, '15');

  const toggle = container.querySelector('[role="checkbox"]');
  assert.ok(toggle);
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.deepEqual(calls, [{ enabled: false }]);
  render(null, container);
});
