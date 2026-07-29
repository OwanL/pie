import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../../../src/webview/panel/composer/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol';
import type { ExtensionInfo, ModelInfo } from '../../../src/shared/protocol';

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
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        availableExtensions: extensions,
        availableModels: models,
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
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
  assert.deepEqual(tabIds, ['chat', 'history', 'appearance']);

  // Chat is active by default and renders its Transcript section without
  // absorbing the independently owned history-compaction controls.
  assert.ok(menu.querySelector('.toolbar-settings-tab[data-tab="chat"].active'), 'Chat tab should be active by default');
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Transcript/);
  assert.doesNotMatch(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /History compaction/);

  // History is a first-class settings category, not a subsection of Chat.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="history"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /History compaction/);
  assert.doesNotMatch(body.textContent!, /Transcript/);

  // Switch to Appearance — its content replaces History's.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="appearance"]')); });
  assert.match(body.textContent!, /Corner radius/);
  assert.doesNotMatch(body.textContent!, /History compaction/);
});

test('Extensions and Providers tabs appear only when their content exists', () => {
  const extensions: ExtensionInfo[] = [{ id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' }];
  const models: ModelInfo[] = [
    { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
  ];
  mount(extensions, models);
  const menu = openMenu();

  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((t) => t.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'history', 'appearance', 'extensions', 'providers']);
});

// Bash settings now live under the Warm Bash extension in the Extensions tab
// (moved out of a dedicated Bash tab). Expanding the warm-bash row reveals the
// warm-pool / fast-path / shell-path controls inline.
test('warm-bash settings render inline under the Warm Bash extension row', () => {
  const extensions: ExtensionInfo[] = [{ id: 'warm-bash', label: 'Warm Bash', description: 'Speeds up bash' }];
  mount(extensions, []);
  const menu = openMenu();

  // Switch to the Extensions tab.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Warm Bash/);
  assert.doesNotMatch(body.textContent!, /Idle target/, 'warm-pool controls should be hidden until expanded');

  // Expand the warm-bash row — the inline settings render.
  act(() => { click(body.querySelector('.toolbar-settings-ext-chevron')); });
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Idle target/);
});

// The ask-user extension exposes a nested "Include for subagents" toggle that
// drives the shared subagentDropTools list. Expanding the row reveals it; the
// toggle stays in sync with the Subagent section's Dropped-tools editor.
test('ask-user settings render inline with an "Include for subagents" toggle', () => {
  const extensions: ExtensionInfo[] = [{ id: 'ask-user', label: 'Ask User', description: 'Ask the user' }];
  const setPrefsCalls: Partial<import('../../../src/shared/protocol').ChatPrefs>[] = [];
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        availableExtensions: extensions,
        availableModels: [],
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: (p) => setPrefsCalls.push(p),
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });
  const menu = openMenu();

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Ask User/);
  assert.doesNotMatch(body.textContent!, /Include for subagents/, 'ask-user toggle should be hidden until expanded');

  // Expand the ask-user row — the inline toggle renders and is checked by
  // default (DEFAULT_CHAT_PREFS.subagentDropTools is empty → ask_user included).
  act(() => { click(body.querySelector('.toolbar-settings-ext-chevron')); });
  const toggle = menu.querySelector('.toolbar-settings-ext-settings .toolbar-settings-item[role="checkbox"]') as HTMLElement;
  assert.ok(toggle, 'include-for-subagents toggle should render');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.match(menu.querySelector('.toolbar-settings-menu-body')!.textContent!, /Include for subagents/);

  // Clicking the toggle disables inclusion → adds ask_user to the drop list.
  act(() => { click(toggle); });
  assert.deepEqual(setPrefsCalls, [{ subagentDropTools: ['ask_user'] }]);
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
    input!.value = 'chat';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // The tab strip is hidden while searching.
  assert.ok(!menu.querySelector('.toolbar-settings-tabs'), 'tab strip should hide while searching');

  const results = menu.querySelectorAll('.toolbar-settings-search-result');
  assert.ok(results.length > 0, 'search should produce results');

  // "chat" matches the Chat category jump and its toggles.
  const jumpResults = menu.querySelectorAll('.toolbar-settings-search-result-jump');
  assert.ok(jumpResults.length >= 1, 'Chat category jump should be a search result');

  // Clearing the query restores the tab strip + Chat body.
  act(() => { click(menu.querySelector('.toolbar-settings-search-clear')); });
  assert.ok(menu.querySelector('.toolbar-settings-tabs'), 'tab strip should restore when search is cleared');
  assert.ok(!menu.querySelector('.toolbar-settings-search-results'), 'results list should disappear when search is cleared');
});

test('search surfaces the subagent busy-provider routing toggle', () => {
  mount([{ id: 'subagent', label: 'Subagent', description: 'Delegates work' }]);
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'saturated providers';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Route around busy providers/);
  assert.ok(body.querySelector('.toolbar-settings-search-result[role="checkbox"]'));
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

// Continuous (non-boolean) settings like font size, corner radius, and other
// appearance settings are surfaced as search jump entries so they're never
// reported as "no matches" — a regression here would reintroduce the original search gap.
test('search finds the initial composer rows setting', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'composer rows';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /Initial composer rows/);
  assert.match(body.textContent!, /Appearance/);
});

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