import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../../../src/webview/panel/composer/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol';

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

// Regression: the settings menu used max-height: calc(100vh - 32px),
// which ignores the toolbar height and lets a tall menu run off the top of the
// screen. It must now be capped to the transcript vertical space (menu bottom →
// viewport top) so it fills the room and its inner body scrolls.
test('settings menu caps its height to the transcript vertical space', () => {
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        availableExtensions: [],
        availableModels: [],
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });

  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });

  const menu = container.querySelector('.toolbar-settings-menu') as HTMLElement;
  assert.ok(menu, 'settings menu should be open');

  menu.getBoundingClientRect = () => ({
    bottom: 600, right: 300, top: 100, left: 0, width: 300, height: 500,
    x: 0, y: 100, toJSON() {},
  }) as DOMRect;

  act(() => { window.dispatchEvent(new Event('resize')); });

  assert.equal(
    menu.style.maxHeight,
    '592px',
    'menu max-height should be the transcript space (menu bottom - pad), not 100vh',
  );
});

// Regression: the menu used to grow/shrink as the user clicked between
// categories (each tab has a different content height), making its top edge
// jump around. It must now keep a fixed height across tab switches; only the
// inner body scrolls.
test('settings menu keeps a fixed height when switching tabs', () => {
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        availableExtensions: [],
        availableModels: [],
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });

  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });

  const menu = container.querySelector('.toolbar-settings-menu') as HTMLElement;
  assert.ok(menu, 'settings menu should be open');

  // Generous available space so the fixed height isn't clamped by the viewport.
  menu.getBoundingClientRect = () => ({
    bottom: 700, right: 600, top: 100, left: 0, width: 600, height: 600,
    x: 0, y: 100, toJSON() {},
  }) as DOMRect;

  act(() => { window.dispatchEvent(new Event('resize')); });

  const fixedHeight = menu.style.height;
  assert.equal(fixedHeight, '500px', 'menu uses the compact stable design height when space allows');
  assert.equal(menu.style.maxHeight, '692px', 'max-height still tracks the viewport cap');

  // Switching tabs must not change the height (the original resize complaint).
  for (const tab of ['appearance', 'chat']) {
    act(() => { click(menu.querySelector(`.toolbar-settings-tab[data-tab="${tab}"]`)); });
    assert.equal(
      menu.style.height,
      fixedHeight,
      `height should not change when switching to the ${tab} tab`,
    );
  }
});
