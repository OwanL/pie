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
  };
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// Regression: opening the UI submenu used to surface a stray scrollbar in the
// settings menu while the flyout never appeared. Root cause was overflow-y:auto
// on .toolbar-settings-menu itself — per the CSS spec a non-visible overflow-y
// forces overflow-x to compute to auto, clipping the absolutely-positioned
// flyout that sits just past the menu's right edge. The fix keeps vertical
// scrolling on an inner .toolbar-settings-menu-body wrapper so the menu stays
// overflow:visible and the flyout can escape sideways. This test pins the
// structural invariant that prevents the regression from returning.
test('UI flyout is a direct child of the settings menu, not inside the scrollable body', () => {
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

  // Open the settings menu via the gear trigger.
  act(() => {
    click(container.querySelector('.toolbar-settings-trigger'));
  });

  const menu = container.querySelector('.toolbar-settings-menu');
  assert.ok(menu, 'settings menu should open on trigger click');

  const body = menu!.querySelector('.toolbar-settings-menu-body');
  assert.ok(body, 'scrollable menu body wrapper should render');
  assert.equal(
    body!.parentElement,
    menu,
    'menu body should be a direct child of .toolbar-settings-menu',
  );

  // Open the UI flyout via the UI submenu trigger.
  act(() => {
    click(menu!.querySelector('.toolbar-settings-ui-trigger'));
  });

  const flyout = container.querySelector('.toolbar-settings-ui-flyout');
  assert.ok(flyout, 'UI flyout should render when the UI submenu trigger is clicked');

  // The flyout MUST be a sibling of the scrollable body — a direct child of the
  // menu — so it is never clipped by the body's overflow. This guards the
  // re-nesting path (flyout moved inside .toolbar-settings-menu-body, which
  // would re-clip it). It cannot catch a CSS-only regression that re-adds
  // overflow to the menu itself, since happy-dom applies no stylesheets here;
  // the CSS comment on .toolbar-settings-menu documents that constraint.
  assert.equal(
    flyout!.parentElement,
    menu,
    'flyout must be a direct child of .toolbar-settings-menu so it escapes the scroll container',
  );
  assert.ok(
    !body!.contains(flyout),
    'flyout must not be nested inside the scrollable .toolbar-settings-menu-body',
  );
});
