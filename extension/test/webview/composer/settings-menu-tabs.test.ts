import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../../../src/webview/panel/composer/settings-menu';
import { orderModelsForPicker } from '../../../src/webview/panel/composer/model-list';
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

function mount(
  extensions: ExtensionInfo[] = [],
  models: ModelInfo[] = [],
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: import('../../../src/shared/protocol').ThinkingLevel) => void = () => undefined,
) {
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
        selectedModel: models[0]?.id ?? '',
        selectedProvider: models[0]?.provider,
        selectedLevel: 'low',
        chatModelEntries: orderModelsForPicker(models, { useSubagentEligibility: false }),
        onModelChange,
        onSetPrefs: () => undefined,
        mcpServers: [],
        mcpPendingApply: false,
        onMcpListRequested: () => undefined,
        onMcpSetServerEnabled: () => undefined,
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
  // Models and Context are always present; Extensions and Subagents depend on
  // available extensions, while MCP remains unconditional.
  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((t) => t.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'models', 'context', 'appearance', 'mcp']);

  // Chat is active by default. Transcript behavior, completion notifications,
  // and diagnostics stay here; status/usage visibility moved to Appearance.
  assert.ok(menu.querySelector('.toolbar-settings-tab[data-tab="chat"].active'), 'Chat tab should be active by default');
  const chatText = menu.querySelector('.toolbar-settings-menu-body')!.textContent!;
  assert.match(chatText, /Transcript/);
  assert.match(chatText, /Completion notifications/);
  assert.match(chatText, /Sound volume/);
  assert.match(chatText, /Diagnostics/);
  assert.doesNotMatch(chatText, /Hide bottom usage strip/);
  assert.doesNotMatch(chatText, /History compaction/);

  // Context owns history-compaction behavior, not its model assignment.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="context"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /History compaction/);
  assert.doesNotMatch(body.textContent!, /Summary model/);
  assert.doesNotMatch(body.textContent!, /Transcript/);

  // Models owns all baseline assignments and the provider section.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  assert.match(body.textContent!, /Model assignments/);
  assert.match(body.textContent!, /Chat default/);
  assert.match(body.textContent!, /Title model/);
  assert.match(body.textContent!, /Summary model/);
  assert.match(body.textContent!, /Providers/);

  // Switch to Appearance — layout, theme, and status/usage visibility now live
  // together under semantic groups.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="appearance"]')); });
  assert.match(body.textContent!, /Theme & colors/);
  assert.match(body.textContent!, /Corner radius/);
  assert.match(body.textContent!, /Status & usage/);
  assert.match(body.textContent!, /Hide bottom usage strip/);
  assert.doesNotMatch(body.textContent!, /History compaction/);
});

test('Extensions remains conditional while providers are integrated into Models', () => {
  const extensions: ExtensionInfo[] = [{ id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' }];
  const models: ModelInfo[] = [
    { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
  ];
  mount(extensions, models);
  const trigger = container.querySelector('.toolbar-settings-trigger');
  assert.equal(trigger?.getAttribute('aria-label'), 'Settings');
  const menu = openMenu();

  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((t) => t.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'models', 'context', 'appearance', 'extensions', 'mcp']);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  assert.equal(
    Array.from(menu.querySelectorAll('.toolbar-settings-section-label')).some((label) => label.textContent === 'Extensions'),
    false,
    'the active Extensions tab should not repeat its own label in the body',
  );
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  assert.equal(
    Array.from(menu.querySelectorAll('.toolbar-settings-section-label')).some((label) => label.textContent === 'Providers'),
    true,
    'Providers should render as a section inside Models',
  );
});

test('Chat default uses the toolbar model entries and normalizes thinking through onModelChange', () => {
  const models: ModelInfo[] = [
    { id: 'reasoning', name: 'Reasoning', provider: 'test', reasoning: true, thinkingLevels: ['off', 'low'], inputKinds: ['text'] },
    { id: 'plain', name: 'Plain', provider: 'test', reasoning: false, thinkingLevels: ['off'], inputKinds: ['text'] },
  ];
  const calls: Array<[string, string | undefined, import('../../../src/shared/protocol').ThinkingLevel]> = [];
  mount([], models, (...args) => calls.push(args));
  const menu = openMenu();
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  const trigger = menu.querySelector('[aria-label="Chat default model"]');
  assert.ok(trigger);
  assert.match(trigger.textContent ?? '', /Reasoning/);

  act(() => { click(trigger); });
  const plainRow = [...document.querySelectorAll('.model-picker-row')]
    .find((row) => row.textContent?.includes('Plain'));
  assert.ok(plainRow);
  act(() => { click(plainRow!); });
  assert.deepEqual(calls, [['plain', 'test', 'off']]);
});

test('extension-backed settings route to Models, Context, and Subagents', () => {
  const extensions: ExtensionInfo[] = [
    { id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' },
    { id: 'subagent', label: 'Subagent', description: 'Delegates' },
    { id: 'tool-result-pruner', label: 'Tool Result Pruner', description: 'Prunes results' },
  ];
  const models: ModelInfo[] = [
    { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
  ];
  mount(extensions, models);
  const menu = openMenu();
  const tabIds = Array.from(menu.querySelectorAll('.toolbar-settings-tab')).map((tab) => tab.getAttribute('data-tab'));
  assert.deepEqual(tabIds, ['chat', 'models', 'context', 'subagents', 'appearance', 'extensions', 'mcp']);
  const body = menu.querySelector('.toolbar-settings-menu-body')!;

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  assert.match(body.textContent!, /Prepass model/);
  assert.match(body.textContent!, /Low-cost busywork/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="context"]')); });
  assert.match(body.textContent!, /Skill pruning/);
  assert.match(body.textContent!, /Tool-result pruning/);
  assert.doesNotMatch(body.textContent!, /Prepass model/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="subagents"]')); });
  assert.match(body.textContent!, /Always use parent model/);
  assert.match(body.textContent!, /Nesting levels/);
  assert.doesNotMatch(body.textContent!, /Low-cost busywork/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  const chevrons = body.querySelectorAll('.toolbar-settings-ext-chevron');
  act(() => { click(chevrons[0]); });
  assert.match(body.textContent!, /Settings moved to the Context and Models tabs/);
  act(() => { click(chevrons[1]); });
  assert.match(body.textContent!, /Settings moved to the Subagents and Models tabs/);
});

// The MCP tab is unconditional and carries the global on/off toggle; toggling
// it emits the mcpEnabled pref patch.
test('MCP tab renders the global toggle and emits mcpEnabled patches', () => {
  const setPrefsCalls: Partial<import('../../../src/shared/protocol').ChatPrefs>[] = [];
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
        onSetPrefs: (p) => setPrefsCalls.push(p),
        mcpServers: [],
        mcpPendingApply: false,
        onMcpListRequested: () => undefined,
        onMcpSetServerEnabled: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });
  const menu = openMenu();

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="mcp"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /MCP enabled/);
  assert.match(body.textContent!, /mcp\.json/);

  const toggle = body.querySelector('.toolbar-settings-item[role="checkbox"]') as HTMLElement;
  assert.ok(toggle, 'MCP toggle should render');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  act(() => { click(toggle); });
  assert.deepEqual(setPrefsCalls, [{ mcpEnabled: false }]);
});

// Search surfaces the MCP toggle from any tab.
test('search surfaces the MCP enabled toggle', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'mcp';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /MCP enabled/);
  assert.ok(body.querySelector('.toolbar-settings-search-result[role="checkbox"]'));
});

test('two rapid Escape presses clear search then close settings', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'provider';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(input.value, 'provider');

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  assert.equal(container.querySelector('.toolbar-settings-menu'), null);
  assert.equal(document.activeElement, container.querySelector('.toolbar-settings-trigger'));
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
        mcpServers: [],
        mcpPendingApply: false,
        onMcpListRequested: () => undefined,
        onMcpSetServerEnabled: () => undefined,
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

test('search routes moved settings to their new tabs', () => {
  mount([
    { id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' },
    { id: 'subagent', label: 'Subagent', description: 'Delegates' },
  ]);
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  act(() => {
    input.value = 'prepass model';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const prepass = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')]
    .find((result) => result.textContent?.includes('Prepass model'));
  assert.ok(prepass);
  assert.match(prepass!.textContent ?? '', /Models/);
  act(() => { click(prepass!); });
  assert.ok(menu.querySelector('.toolbar-settings-tab[data-tab="models"].active'));

  act(() => {
    input.value = 'tree session budget';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const budget = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')]
    .find((result) => result.textContent?.includes('Tree session budget'));
  assert.ok(budget);
  assert.match(budget!.textContent ?? '', /Subagents/);
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

test('search routes display prefs and the visible Mono font label to Appearance', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;

  for (const query of ['hide session cost', 'mono font']) {
    act(() => {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const jump = menu.querySelector('.toolbar-settings-search-result-jump');
    assert.ok(jump, `${query} should produce a jump result`);
    assert.match(jump!.textContent ?? '', /Appearance/);
  }
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
