import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../src/webview/panel/composer/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../src/shared/protocol';
import type { ExtensionInfo, ModelInfo } from '../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
  };
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function mousedown(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
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
        availableExtensions: extensions,
        availableModels: models,
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: (p) => setPrefsCalls.push(p),
        onSetPruningSettings: (s) => setPruningCalls.push(s),
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });
  return { setPruningCalls };
}

// Shared setup: open the settings menu, expand skill-pruner, and open its
// prepass ModelPicker. Returns the portaled dropdown element.
function openPrepassPicker(): HTMLElement {
  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });
  // Skill-pruner lives on the Extensions tab of the tabbed settings menu.
  act(() => { click(container.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  act(() => { click(container.querySelector('.toolbar-settings-ext-chevron')); });
  act(() => { click(container.querySelector('.model-picker-trigger')); });
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
    container.querySelector('.toolbar-settings-menu'),
    'settings menu should stay open after Escape closed only the picker',
  );
  assert.ok(
    !document.querySelector('.model-picker-dropdown'),
    'ModelPicker dropdown should be closed after Escape',
  );
});

// Regression: selecting a model row (a mousedown on the portaled dropdown)
// must not dismiss the settings menu. Previously the menu's outside-click
// guard closed the menu because the portaled dropdown is not a DOM descendant
// of the menu container.
test('selecting a prepass model row keeps the settings menu open', () => {
  const { setPruningCalls } = mount();
  openPrepassPicker();

  const rows = document.querySelectorAll('.model-picker-row');
  assert.ok(rows.length >= 2, 'expected at least two model rows');
  // mousedown on the second row selects it (the row's onMouseDown handler).
  act(() => { mousedown(rows[1]); });

  assert.ok(
    container.querySelector('.toolbar-settings-menu'),
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
