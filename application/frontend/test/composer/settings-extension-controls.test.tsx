import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../lib/protocol/index.js';
import { BashSection, BASH_SETTING_LABELS } from '../../settings/settings-menu-bash';
import { AskUserSettings } from '../../settings/settings-menu-ask-user';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

function prefs(overrides: Partial<ChatPrefs> = {}): ChatPrefs {
  return {
    ...DEFAULT_CHAT_PREFS,
    bashFastPath: true,
    bashWarmPoolSize: 2,
    bashShellPath: '',
    bashWarmupTimeoutMs: 10_000,
    subagentDropTools: ['other_tool'],
    ...overrides,
  };
}

test('extension controls expose keyboard-accessible contextual help', async () => {
  const current = prefs();
  act(() => render(h(BashSection, { prefs: current, onSetPrefs: () => {} }), container));
  const bashHelp = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-settings-help-button')];
  assert.equal(bashHelp.length, 4);
  const shellHelp = bashHelp.find((button) => button.getAttribute('aria-label') === 'About Shell path')!;
  shellHelp.focus();
  assert.ok(document.activeElement === shellHelp);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  const shellTooltip = document.getElementById(shellHelp.getAttribute('aria-describedby') ?? '');
  assert.match(shellTooltip?.textContent ?? '', /both the warm pool and the fallback/);

  act(() => render(h(AskUserSettings, { prefs: current, onSetPrefs: () => {} }), container));
  const askHelp = container.querySelector<HTMLButtonElement>('.toolbar-settings-help-button');
  assert.ok(askHelp);
  askHelp.focus();
  assert.ok(document.activeElement === askHelp);
  assert.equal(askHelp.getAttribute('aria-label'), 'About Include for subagents');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  const askTooltip = document.getElementById(askHelp.getAttribute('aria-describedby') ?? '');
  assert.match(askTooltip?.textContent ?? '', /shared dropped-tools list/);
  assert.match(container.textContent ?? '', /Include for subagents/);
  assert.doesNotMatch(container.textContent ?? '', /Mirrored to the subagent runner/);
});

test('shell path keeps edits local until blur or Enter and preserves blank auto-detect', () => {
  const current = prefs();
  const patches: Partial<ChatPrefs>[] = [];
  act(() => render(h(BashSection, { prefs: current, onSetPrefs: (patch) => { patches.push(patch); } }), container));
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Explicit bash shell path"]')!;
  assert.equal(input.placeholder, 'Auto-detect');
  assert.equal(patches.length, 0);

  act(() => {
    input.value = 'C:/tools/bash.exe';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(patches.length, 0);
  act(() => { input.focus(); input.blur(); });
  assert.deepEqual([...patches], [{ bashShellPath: 'C:/tools/bash.exe' }]);

  act(() => render(h(BashSection, { prefs: prefs({ bashShellPath: 'C:/tools/bash.exe' }), onSetPrefs: (patch) => { patches.push(patch); } }), container));
  const updated = container.querySelector<HTMLInputElement>('input[aria-label="Explicit bash shell path"]')!;
  act(() => {
    updated.value = '';
    updated.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(patches.length, 1);
  act(() => {
    updated.focus();
    updated.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.deepEqual(patches[1], { bashShellPath: '' });
});

test('AskUser toggle edits only ask_user membership in dropped tools', () => {
  const current = prefs({ subagentDropTools: ['other_tool', 'ask_user'] });
  let patch: Partial<ChatPrefs> | undefined;
  act(() => render(h(AskUserSettings, { prefs: current, onSetPrefs: (next) => { patch = next; } }), container));
  const toggle = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  act(() => toggle.click());
  assert.deepEqual(patch, { subagentDropTools: ['other_tool'] });

  act(() => render(h(AskUserSettings, { prefs: prefs({ subagentDropTools: ['other_tool'] }), onSetPrefs: (next) => { patch = next; } }), container));
  act(() => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  assert.deepEqual(patch, { subagentDropTools: ['other_tool', 'ask_user'] });
});

test('fast path keeps its search label in aria while showing a short visible label', () => {
  const current = prefs();
  act(() => render(h(BashSection, { prefs: current, onSetPrefs: () => {} }), container));
  const toggle = container.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label]')!;
  assert.equal(toggle.textContent?.trim(), 'Fast path');
  assert.equal(toggle.getAttribute('aria-label'), 'Fast path (no shell for simple commands)');
  assert.equal(BASH_SETTING_LABELS.includes(toggle.getAttribute('aria-label') as typeof BASH_SETTING_LABELS[number]), true);
});
