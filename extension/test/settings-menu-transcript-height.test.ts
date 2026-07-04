import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../src/webview/panel/composer/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_PROXY_SETTINGS } from '../src/shared/protocol';

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

// Regression: the UI flyout used to be top-aligned with the menu and clamped to
// window.innerHeight, so it extended down past the toolbar / off the bottom of
// the screen. It must now be bottom-aligned with the menu (≈ toolbar top) and
// capped to the transcript's vertical space (menu bottom → viewport top), so it
// fills the available room and scrolls instead of overflowing. This test mocks
// the menu's rect to simulate a real layout and asserts the cap math.
test('UI flyout caps its height to the transcript vertical space, not the viewport', () => {
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        proxySettings: DEFAULT_PROXY_SETTINGS,
        availableExtensions: [],
        availableModels: [],
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetProxySettings: () => undefined,
      }),
      container,
    );
  });

  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });
  act(() => { click(container.querySelector('.toolbar-settings-ui-trigger')); });

  const menu = container.querySelector('.toolbar-settings-menu') as HTMLElement;
  const flyout = container.querySelector('.toolbar-settings-ui-flyout') as HTMLElement;
  assert.ok(menu, 'settings menu should be open');
  assert.ok(flyout, 'UI flyout should be open');

  // Simulate a realistic layout: the menu's bottom sits 600px down the viewport
  // (≈ toolbar top), so the transcript's vertical space is 600 - pad(8) = 592px.
  menu.getBoundingClientRect = () => ({
    bottom: 600, right: 300, top: 100, left: 0, width: 300, height: 500,
    x: 0, y: 100, toJSON() {},
  }) as DOMRect;

  // The effect binds fit() to window resize; re-trigger it with the mocked rect.
  act(() => { window.dispatchEvent(new Event('resize')); });

  assert.equal(
    flyout.style.maxHeight,
    '592px',
    'flyout max-height should be the transcript space (menu bottom - pad), not the viewport height',
  );
});

// Regression: the settings menu itself used max-height: calc(100vh - 32px),
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
        proxySettings: DEFAULT_PROXY_SETTINGS,
        availableExtensions: [],
        availableModels: [],
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetProxySettings: () => undefined,
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
