import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
installDom();

import { SubagentProviderMenu } from '../../../src/webview/panel/composer/subagent-provider-menu';
import { DEFAULT_CHAT_PREFS } from '../../../src/shared/protocol';
import type { ChatPrefs, ModelInfo } from '../../../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

const SESSION_PATH = '/sessions/root.jsonl';

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, thinkingLevels: ['off'], inputKinds: ['text'] },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, thinkingLevels: ['off'], inputKinds: ['text'] },
];

function openMenu(container: HTMLDivElement): void {
  const trigger = container.querySelector('.subagent-provider-trigger') as HTMLButtonElement | null;
  assert.ok(trigger, 'provider menu trigger rendered');
  act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function providerButton(container: HTMLDivElement, provider: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('.subagent-provider-dropdown .toolbar-settings-item')]
    .find((item) => item.textContent?.trim() === provider) as HTMLButtonElement | null;
}

test('SubagentProviderMenu allows unchecking the last enabled provider', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentProviderMenu, {
      sessionPath: SESSION_PATH,
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [],
          frontier: [],
        },
      }),
      availableModels: AVAILABLE_MODELS,
      onSetPrefs: (patch) => calls.push(patch),
    }), container));

    openMenu(container);
    const anthropic = providerButton(container, 'anthropic');
    assert.ok(anthropic, 'anthropic row rendered');
    assert.equal(anthropic!.getAttribute('aria-checked'), 'true');
    assert.equal(anthropic!.disabled, false, 'the last enabled provider must stay uncheckable-free');

    // Unchecking the only enabled provider is accepted: the effective
    // all-unchecked policy removes the subagent tool from the session.
    act(() => { anthropic!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(
      calls.at(-1)?.subagentProviderTogglesBySession?.[SESSION_PATH],
      { anthropic: false },
    );
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('SubagentProviderMenu reflects the all-unchecked state and re-enables', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentProviderMenu, {
      sessionPath: SESSION_PATH,
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [{ model: 'openai/gpt-5', thinkingLevel: 'off' }],
          frontier: [],
        },
        subagentProviderDefaults: { anthropic: false, openai: false },
      }),
      availableModels: AVAILABLE_MODELS,
      onSetPrefs: (patch) => calls.push(patch),
    }), container));

    // Trigger summary reflects the all-unchecked surface (0/2 enabled).
    const trigger = container.querySelector('.subagent-provider-trigger') as HTMLButtonElement | null;
    assert.match(trigger!.getAttribute('aria-label') ?? '', /0\/2 subagent providers enabled/);

    openMenu(container);
    const openai = providerButton(container, 'openai');
    assert.ok(openai);
    assert.equal(openai!.disabled, false, 'every unchecked provider stays re-checkable');

    act(() => { openai!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(
      calls.at(-1)?.subagentProviderTogglesBySession?.[SESSION_PATH],
      { openai: true },
    );
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});