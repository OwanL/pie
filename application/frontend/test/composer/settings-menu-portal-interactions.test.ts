import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_SESSION_TITLES_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';
import type { ExtensionInfo, ModelInfo } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  // The settings menu and ModelPicker portal to document.body; remove any
  // stray portaled instance so tests cannot observe a previous test's menu.
  document.querySelectorAll('.toolbar-settings-menu').forEach((el) => el.remove());
  document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function mount() {
  const extensions: ExtensionInfo[] = [
    { id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes skills' },
  ];
  const models: ModelInfo[] = [
    { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
    { id: 'm2', name: 'Model Two', provider: 'test', reasoning: false, inputKinds: ['text'] },
  ];
  const setPrefsCalls: any[] = [];
  const setPruningCalls: any[] = [];
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
        availableExtensions: extensions,
        availableModels: models,
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: (p) => setPrefsCalls.push(p),
        mcpServers: [],
        mcpPendingApply: false,
        onMcpListRequested: () => undefined,
        onMcpSetServerEnabled: () => undefined,
        onSetPruningSettings: (s) => setPruningCalls.push(s),
        onSetToolResultPruningSettings: () => undefined,
        onSetSessionTitlesSettings: () => undefined,
      }),
      container,
    );
  });
  return { setPruningCalls };
}

test('popup geometry recomputes its height on scroll and resize within viewport margins', async () => {
  mount();
  const trigger = container.querySelector('.toolbar-settings-trigger') as HTMLButtonElement;
  let top = 100;
  trigger.getBoundingClientRect = () => ({ left: 20, right: 40, top, bottom: top + 20, width: 20, height: 20, x: 20, y: top, toJSON() {} });
  const originalHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
  try {
    act(() => { click(trigger); });
    const menu = document.querySelector('.toolbar-settings-menu') as HTMLElement;
    const fits = () => {
      const y = Number.parseFloat(menu.style.top);
      const height = Number.parseFloat(menu.style.height);
      assert.ok(y >= 8 && y + height <= window.innerHeight - 8, `popup ${y}+${height} must fit viewport`);
    };
    fits();
    assert.equal(menu.style.top, '126px', 'use below when it has more available space');
    assert.equal(menu.style.height, '166px');
    top = 250;
    window.dispatchEvent(new Event('scroll'));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    fits();
    assert.equal(menu.style.height, '236px');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 150 });
    top = 100;
    window.dispatchEvent(new Event('resize'));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    fits();
    assert.equal(menu.style.height, '86px');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    top = 800;
    window.dispatchEvent(new Event('resize'));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    fits();
    assert.equal(menu.style.top, '294px', 'prefer above when the full height fits');
    assert.equal(menu.style.height, '500px', 'cap roomy viewports to stable category-independent height');
  } finally {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
  }
});

// Shared setup: open the settings menu's Models tab and open the pruning
// prepass ModelPicker. Returns the portaled dropdown element.
function openPrepassPicker(): HTMLElement {
  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });
  const menu = document.body.querySelector('.toolbar-settings-menu');
  assert.ok(menu, 'settings menu should be portaled to the document');
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  act(() => { click(document.querySelector('[aria-label="Pruning prepass model"]')); });
  const dropdown = document.querySelector('.model-picker-dropdown') as HTMLElement | null;
  assert.ok(dropdown, 'prepass ModelPicker dropdown should be portaled to the document');
  return dropdown!;
}

// Regression: pressing Escape while the prepass picker has focus must close
// only the picker, not the whole settings menu. Previously the menu's Escape
// guard gated on menuRef.contains(active), which is false for the portaled
// dropdown, so Escape dismissed both.
test('Escape closes only the ModelPicker, leaving the settings menu open', () => {
  mount();
  const dropdown = openPrepassPicker();

  // Simulate the post-rAF focus that useFocusOnOpen moves into the dropdown.
  act(() => { dropdown.focus(); });
  assert.equal(document.activeElement, dropdown, 'dropdown should hold focus');

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  assert.ok(
    document.body.querySelector('.toolbar-settings-menu'),
    'settings menu should stay open after Escape closed only the picker',
  );
  assert.ok(
    !document.querySelector('.model-picker-dropdown'),
    'ModelPicker dropdown should be closed after Escape',
  );
});

// Regression: selecting a model row in the portaled dropdown
// must not dismiss the settings menu. Previously the menu's outside-click
// guard closed the menu because the portaled dropdown is not a DOM descendant
// of the menu container.
test('selecting a prepass model row keeps the settings menu open', () => {
  const { setPruningCalls } = mount();
  openPrepassPicker();

  const rows = document.querySelectorAll('.model-picker-row');
  assert.ok(rows.length >= 2, 'expected at least two model rows');
  // Activate the second row through its click semantics (also used by AT).
  act(() => { click(rows[1]); });

  assert.ok(
    document.body.querySelector('.toolbar-settings-menu'),
    'settings menu should stay open after selecting a model row',
  );
  assert.ok(
    !document.querySelector('.model-picker-dropdown'),
    'ModelPicker dropdown should be closed after a row is selected',
  );
  assert.ok(
    setPruningCalls.some((s) => s.model === 'm2'),
    'selecting the second row should set the prepass model',
  );
});
