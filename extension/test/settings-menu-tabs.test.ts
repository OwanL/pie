import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../src/webview/panel/composer/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_PROXY_SETTINGS } from '../src/shared/protocol';
import type { ExtensionInfo, ModelInfo } from '../src/shared/protocol';

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

function mount(extensions: ExtensionInfo[] = [], models: ModelInfo[] = []) {
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        proxySettings: DEFAULT_PROXY_SETTINGS,
        availableExtensions: extensions,
        availableModels: models,
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetProxySettings: () => undefined,
      }),
      container,
    );
  });
}

function openMenu() {
  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });
  const menu = container.querySelector('.toolbar-settings-menu');
  assert.ok(menu, 'settings menu should open on trigger click');
  return menu!;
}

// Structural invariant for the tabbed redesign: the menu shows one category at
// a time behind a tab strip, and switching tabs swaps the body content. This
// guards against a regression that re-flattens the menu into a single long
// scrolling list (the original bloat problem).
test('the menu is tabbed and defaults to Chat; switching tabs swaps content', () => {
  mount();
  const menu = openMenu();

  const tabs = menu.querySelectorAll('.toolbar-settings-tab');
  // Tab strip present with the always-on categories (Extensions/Providers are
  // hidden because no extensions/models were passed).
  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((t) => t.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'appearance', 'bash', 'proxy']);

  // Chat is active by default and renders its Transcript section.
  assert.ok(menu.querySelector('.toolbar-settings-tab[data-tab="chat"].active'), 'Chat tab should be active by default');
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Transcript/);
  assert.doesNotMatch(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Corner radius/);

  // Switch to Appearance — its content renders, Chat's disappears.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="appearance"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Corner radius/);
  assert.doesNotMatch(body.textContent!, /Transcript/);

  // Switch to Bash — warm-pool content renders.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="bash"]')); });
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Warm pool size/);
});

test('Extensions and Providers tabs appear only when their content exists', () => {
  const extensions: ExtensionInfo[] = [{ id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' }];
  const models: ModelInfo[] = [
    { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
  ];
  mount(extensions, models);
  const menu = openMenu();

  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((t) => t.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'appearance', 'bash', 'extensions', 'providers', 'proxy']);
});

// Search replaces the tab strip + body with a flat filtered result list that
// spans every category, so a setting can be found and toggled without hunting
// through tabs.
test('search replaces the tab body with a flat filtered result list across categories', () => {
  mount();
  const menu = openMenu();

  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement | null;
  assert.ok(input, 'search input should render');

  act(() => {
    input!.value = 'proxy';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // The tab strip is hidden while searching.
  assert.ok(!menu.querySelector('.toolbar-settings-tabs'), 'tab strip should hide while searching');

  const results = menu.querySelectorAll('.toolbar-settings-search-result');
  assert.ok(results.length > 0, 'search should produce results');

  // "proxy" matches the Proxy category jump and the two proxy toggles.
  const jumpResults = menu.querySelectorAll('.toolbar-settings-search-result-jump');
  assert.ok(jumpResults.length >= 1, 'Proxy category jump should be a search result');
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Retry after header/);
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Drop unknown params/);

  // Clearing the query restores the tab strip + Chat body.
  act(() => { click(menu.querySelector('.toolbar-settings-search-clear')); });
  assert.ok(menu.querySelector('.toolbar-settings-tabs'), 'tab strip should restore when search is cleared');
  assert.ok(!menu.querySelector('.toolbar-settings-search-results'), 'results list should disappear when search is cleared');
});

test('a search with no matches shows an empty-state message', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'zzzznope';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /No settings match/);
  assert.equal(menu.querySelectorAll('.toolbar-settings-search-result').length, 0);
});

// Continuous (non-boolean) settings like font size, corner radius, and proxy
// timeout are surfaced as search jump entries so they're never reported as
// "no matches" — a regression here would reintroduce the original search gap.
test('search finds continuous settings by name and offers a jump to their tab', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'radius';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Corner radius/);
  // The jump result shows the target category (Appearance) as its meta label.
  assert.match(body.textContent!, /Appearance/);
  assert.ok(!/No settings match/.test(body.textContent!), 'radius should match, not show the empty state');
});