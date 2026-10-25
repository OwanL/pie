import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
import { focusSettingsHelp } from '../helpers/settings-help';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu, type ComposerSettingsMenuProps } from '../../settings/settings-menu';
import { orderModelsForPicker } from '../../composer/model-list';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_SESSION_TITLES_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS, resolveHistoryCompactionSettings } from '../../../lib/protocol/index.js';
import type { ExtensionInfo, ModelInfo } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  // The settings menu portals to document.body; remove any stray portaled
  // instance so tests cannot observe a previous test's menu.
  document.querySelectorAll('.toolbar-settings-menu').forEach((el) => el.remove());
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function mount(
  extensions: ExtensionInfo[] = [],
  models: ModelInfo[] = [],
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: import('../../../lib/protocol/index.js').ThinkingLevel) => void = () => undefined,
  overrides: Partial<ComposerSettingsMenuProps> = {},
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
        ...overrides,
      }),
      container,
    );
  });
}

test('closed snapshots do not traverse settings catalogs, model ordering, or search index', () => {
  const calls = { skills: 0, tools: 0, models: 0, search: 0 };
  function traced<T>(values: T[], key: keyof typeof calls): T[] {
    return new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator || property === 'map' || property === 'filter') calls[key]++;
        return Reflect.get(target, property, receiver);
      },
    });
  }
  function snapshot() {
    mount(traced([{ id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' }], 'search'), [], undefined, {
      availableModels: traced(Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, provider: `p${i % 5}`, reasoning: false, inputKinds: ['text'] as ['text'] })), 'models'),
      pruningCatalog: { skills: traced(Array.from({ length: 100 }, (_, i) => `skill-${i}`), 'skills'), tools: traced(['read', 'write', 'bash'], 'tools') },
      prefs: structuredClone(DEFAULT_CHAT_PREFS),
    });
  }
  snapshot();
  snapshot();
  snapshot();
  assert.deepEqual(calls, { skills: 0, tools: 0, models: 0, search: 0 });
  openMenu();
  assert.ok(Object.values(calls).every((count) => count > 0), 'opening derives the latest snapshot');
  act(() => { click(document.querySelector('.toolbar-settings-close')); });
  const afterClose = { ...calls };
  snapshot();
  assert.deepEqual(calls, afterClose, 'closed updates must not rebuild derived settings data');
});

test('close and reopen retain category and search and restore trigger focus', () => {
  mount();
  let menu = openMenu();
  act(() => { click(menu.querySelector('[data-tab="context"]')); });
  const search = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  act(() => {
    search.value = 'compaction';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { click(menu.querySelector('.toolbar-settings-close')); });
  assert.ok(document.activeElement === container.querySelector('.toolbar-settings-trigger'));
  menu = openMenu();
  assert.equal(menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!.value, 'compaction');
  assert.ok(menu.querySelector('[data-tab="context"].active'));
  assert.ok(document.activeElement === menu.querySelector('.toolbar-settings-search-input'));
});

function openMenu() {
  act(() => { click(container.querySelector('.toolbar-settings-trigger')); });
  const menu = document.body.querySelector('.toolbar-settings-menu');
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
  assert.match(chatText, /Notification sounds/);
  assert.match(chatText, /Sound volume/);
  assert.match(chatText, /Diagnostics/);
  assert.doesNotMatch(chatText, /Hide global costs/);
  assert.doesNotMatch(chatText, /History compaction/);

  // Context owns history-compaction behavior, not its model assignment.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="context"]')); });
  const body = menu.querySelector('.toolbar-settings-menu-body')!;
  assert.match(body.textContent!, /History compaction/);
  assert.doesNotMatch(body.textContent!, /Summary model/);
  assert.doesNotMatch(body.textContent!, /Transcript/);

  // Models owns all baseline assignments and the provider section.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="models"]')); });
  const assignments = body.querySelectorAll('.toolbar-settings-assignment-group');
  assert.deepEqual(Array.from(assignments).map((group) => group.getAttribute('aria-label')), ['Chat default', 'Session titles', 'Compaction summary']);
  for (const group of assignments) {
    assert.deepEqual(Array.from(group.querySelectorAll('.toolbar-settings-item-label')).map((label) => label.textContent), ['Model', 'Thinking']);
  }
  assert.ok(body.querySelector('[aria-label="Session title model"]'));
  assert.ok(body.querySelector('[aria-label="Summary model"]'));
  assert.match(body.textContent!, /Providers/);

  // Switch to Appearance — layout, theme, and status/usage visibility now live
  // together under semantic groups.
  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="appearance"]')); });
  assert.match(body.textContent!, /Theme & colors/);
  assert.match(body.textContent!, /Corner radius/);
  assert.match(body.textContent!, /Status & usage/);
  assert.match(body.textContent!, /Hide global costs/);
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
  const calls: Array<[string, string | undefined, import('../../../lib/protocol/index.js').ThinkingLevel]> = [];
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

test('extension-backed settings route to Models, Context, and Subagents', async () => {
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
  assert.ok(body.querySelector('[role="group"][aria-label="Pruning prepass"] [aria-label="Pruning prepass model"]'));
  assert.ok(body.querySelector('button[aria-label="About Small bucket models"]'));
  assert.doesNotMatch(body.textContent!, /Low-cost busywork/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="context"]')); });
  assert.match(body.textContent!, /Skill pruning/);
  assert.match(body.textContent!, /Tool-result pruning/);
  assert.doesNotMatch(body.textContent!, /Prepass model/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="subagents"]')); });
  assert.match(body.textContent!, /Always use parent model/);
  assert.match(body.textContent!, /Nesting levels/);
  assert.doesNotMatch(body.textContent!, /Low-cost busywork/);

  act(() => { click(menu.querySelector('.toolbar-settings-tab[data-tab="extensions"]')); });
  assert.equal(body.querySelectorAll('.toolbar-settings-ext-chevron').length, 0, 'relocated settings do not have empty expanders');
  assert.doesNotMatch(body.textContent!, /Settings moved/);
  for (const [label, message] of [
    ['Skill Pruner', /Settings moved to the Context and Models tabs/],
    ['Subagent', /Settings moved to the Subagents and Models tabs/],
  ] as const) {
    const help = body.querySelector<HTMLButtonElement>(`[aria-label="About ${label}"]`);
    assert.ok(help);
    focusSettingsHelp(help);
    const id = help.getAttribute('aria-describedby');
    assert.ok(id);
    assert.match(document.getElementById(id)?.textContent ?? '', message);
  }
});

// The MCP tab is unconditional and carries the global on/off toggle; toggling
// it emits the mcpEnabled pref patch.
test('MCP tab renders the global toggle and emits mcpEnabled patches', () => {
  const setPrefsCalls: Partial<import('../../../lib/protocol/index.js').ChatPrefs>[] = [];
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
  assert.ok(body.querySelector('button[aria-label="About Server config"]'));
  assert.doesNotMatch(body.textContent!, /mcp\.json/);

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

  assert.ok(document.body.querySelector('.toolbar-settings-menu') === null);
  assert.ok(document.activeElement === container.querySelector('.toolbar-settings-trigger'));
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
  const setPrefsCalls: Partial<import('../../../lib/protocol/index.js').ChatPrefs>[] = [];
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

// Search keeps navigation available and groups matching settings by category.
test('search keeps category navigation and groups results across categories', () => {
  mount();
  const menu = openMenu();

  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement | null;
  assert.ok(input, 'search input should render');

  act(() => {
    input!.value = 'chat';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });

  assert.ok(menu.querySelector('.toolbar-settings-tabs'), 'category navigation should persist while searching');
  assert.ok(menu.querySelector('[role="tab"][data-tab="models"]'));
  assert.ok(menu.querySelector('select[aria-label="Settings category"]') === null);
  const region = menu.querySelector('[role="region"][aria-label="Settings search results"]');
  assert.ok(region, 'search is a named region, not an unlabelled tabpanel');
  assert.equal(region.getAttribute('aria-labelledby'), null);
  assert.ok(region.querySelector('.toolbar-settings-search-group-title'));
  assert.match(region.querySelector('.toolbar-settings-search-summary')?.textContent ?? '', /\d+ results/);

  const results = menu.querySelectorAll('.toolbar-settings-search-result');
  assert.ok(results.length > 0, 'search should produce results');

  // "chat" matches actual settings, not redundant category jump rows.
  const jumpResults = menu.querySelectorAll('.toolbar-settings-search-result-jump');
  assert.ok(jumpResults.length >= 1, 'Chat settings should be searchable');
  assert.ok([...jumpResults].every((row) => row.querySelector('.toolbar-settings-search-result-label')?.textContent !== 'Chat'));

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
  assert.equal(prepass!.closest('.toolbar-settings-search-group')?.querySelector('h3')?.textContent, 'Models');
  assert.equal(prepass!.getAttribute('title'), 'Open Prepass model in Models · pruning prepass');
  act(() => { click(prepass!); });
  assert.ok(menu.querySelector('.toolbar-settings-tab[data-tab="models"].active'));

  act(() => {
    input.value = 'tree session budget';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const budget = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')]
    .find((result) => result.textContent?.includes('Tree session budget'));
  assert.ok(budget);
  assert.equal(budget!.closest('.toolbar-settings-search-group')?.querySelector('h3')?.textContent, 'Subagents');
});

test('clearing search restores focus after the clear button unmounts', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  act(() => {
    input.value = 'radius';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const clear = menu.querySelector('.toolbar-settings-search-clear') as HTMLButtonElement;
  clear.focus();
  act(() => { click(clear); });
  assert.ok(document.activeElement === input);
});

test('search jumps focus the exact destination after commit and deduplicates same-category toggles', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  act(() => {
    input.value = 'radius';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const result = menu.querySelector('.toolbar-settings-search-result-jump') as HTMLButtonElement;
  assert.ok(result.querySelector('.toolbar-settings-search-result-context') === null, 'do not repeat the category as source context');
  result.focus();
  act(() => { click(result); });
  assert.ok(document.activeElement === menu.querySelector('input[aria-label="Corner radius"]'));
  assert.equal(menu.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), 'Appearance');
  assert.ok(menu.querySelector('.toolbar-settings-category-heading') === null, 'do not repeat navigation as a content heading');

  act(() => {
    input.value = 'proactive automatic compaction';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const matches = menu.querySelectorAll('.toolbar-settings-search-result');
  assert.equal(matches.length, 1, 'same-tab toggle and jump must not duplicate the setting');
  assert.equal(matches[0].getAttribute('role'), 'checkbox');
  assert.equal(matches[0].closest('.toolbar-settings-search-group')?.querySelector('h3')?.textContent, 'Context');
});

test('jumps to disabled title settings restore focus to search', () => {
  mount([], [], undefined, {
    sessionTitlesSettings: { ...DEFAULT_SESSION_TITLES_SETTINGS, enabled: false },
  });
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  for (const label of ['Title timeout', 'Title model', 'Title thinking']) {
    act(() => {
      input.value = label;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = [...menu.querySelectorAll<HTMLButtonElement>('.toolbar-settings-search-result-jump')]
      .find((row) => row.querySelector('.toolbar-settings-search-result-label')?.textContent === label);
    assert.ok(result, `expected ${label}`);
    act(() => { result.focus(); result.click(); });
    assert.equal(input.value, '');
    assert.ok(document.activeElement === input, `${label} should not leave focus on a disabled control`);
  }
});

test('Thinking jumps distinguish sources and focus only their own current model assignment', () => {
  const mutations: string[] = [];
  mount([
    { id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' },
    { id: 'subagent', label: 'Subagent', description: 'Delegates' },
  ], [{ id: 'reasoning', name: 'Reasoning', provider: 'test', reasoning: true, thinkingLevels: ['off', 'low', 'high'], inputKinds: ['text'] }], () => mutations.push('chat default'), {
    prefs: { ...DEFAULT_CHAT_PREFS, historyCompaction: { ...resolveHistoryCompactionSettings(DEFAULT_CHAT_PREFS.historyCompaction), summaryModel: { id: 'reasoning', provider: 'test' } } },
    pruningSettings: { ...DEFAULT_PRUNING_SETTINGS, model: 'reasoning', provider: 'test' },
    sessionTitlesSettings: { ...DEFAULT_SESSION_TITLES_SETTINGS, enabled: true, model: 'reasoning', provider: 'test' },
    onSetPrefs: () => mutations.push('compaction summary'),
    onSetPruningSettings: () => mutations.push('pruning prepass'),
    onSetSessionTitlesSettings: () => mutations.push('session titles'),
  });
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  const targets = [
    ['chat default', 'Chat default thinking level'],
    ['compaction summary', 'Summary thinking level'],
    ['pruning prepass', 'Pruning thinking level'],
    ['session titles', 'Session title thinking level'],
  ];
  for (const [section, target] of targets) {
    act(() => {
      input.value = 'thinking';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const results = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')];
    const genericThinking = results.filter((row) => row.querySelector('.toolbar-settings-search-result-label')?.textContent === 'Thinking');
    assert.deepEqual(genericThinking.map((row) => row.querySelector('.toolbar-settings-search-result-context')?.textContent),
      ['chat default', 'compaction summary', 'pruning prepass']);
    const result = results.find((row) => row.querySelector('.toolbar-settings-search-result-context')?.textContent === section);
    assert.ok(result);
    assert.match(result.getAttribute('title') ?? '', new RegExp(section));
    assert.equal(result.closest('.toolbar-settings-search-group')?.querySelector('h3')?.textContent, 'Models');
    act(() => { click(result); });
    const destination = document.activeElement as HTMLSelectElement;
    assert.equal(destination.getAttribute('aria-label'), target);
    assert.equal(destination.closest('[data-settings-section]')?.getAttribute('data-settings-section'), section);
    assert.ok(destination.isConnected, 'focus must use the newly mounted assignment');
    assert.deepEqual([...menu.querySelectorAll('.toolbar-settings-assignment-title')].map((heading) => heading.textContent),
      ['Chat default', 'Session titles', 'Compaction summary', 'Pruning prepass', 'Subagent model buckets']);
    assert.equal(mutations.length, 0, 'jumping must not mutate preferences');
    act(() => {
      destination.value = 'high';
      destination.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(mutations, [section], 'only the focused source assignment may change');
    mutations.length = 0;
  }
});

test('a jump whose source disappears restores search focus instead of another Thinking assignment', () => {
  mount([{ id: 'skill-pruner', label: 'Skill Pruner', description: 'Prunes' }]);
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  act(() => {
    input.value = 'thinking';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const prepass = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')]
    .find((row) => row.querySelector('.toolbar-settings-search-result-context')?.textContent === 'pruning prepass');
  assert.ok(prepass);
  act(() => {
    click(prepass);
    mount([]);
  });
  assert.ok(menu.querySelector('[data-settings-section="pruning prepass"]') === null);
  assert.ok(document.activeElement === input);
});

test('visible category tabs and arrow navigation leave search', async () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector('.toolbar-settings-search-input') as HTMLInputElement;
  assert.ok(menu.querySelector('.toolbar-settings-category-select') === null);
  assert.deepEqual(Array.from(menu.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute('data-tab')), ['chat', 'models', 'context', 'appearance', 'mcp']);
  act(() => {
    input.value = 'radius';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { click(menu.querySelector('[data-tab="context"]')); });
  assert.equal(input.value, '');
  assert.equal(menu.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), 'Context');
  assert.equal(menu.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'), 'toolbar-settings-tab-context');
  const contextTab = menu.querySelector('[data-tab="context"]') as HTMLButtonElement;
  contextTab.focus();
  act(() => {
    contextTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
  assert.ok(document.activeElement === menu.querySelector('[data-tab="appearance"]'));
  assert.equal(menu.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab'), 'appearance');
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

  for (const query of ['mono font']) {
    act(() => {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const jump = menu.querySelector('.toolbar-settings-search-result-jump');
    assert.ok(jump, `${query} should produce a jump result`);
    assert.equal(jump!.closest('.toolbar-settings-search-group')?.querySelector('h3')?.textContent, 'Appearance');
  }
});

test('search arrow keys move native result focus and Enter retains button activation', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  act(() => {
    input.value = 'compaction';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const results = Array.from(menu.querySelectorAll<HTMLElement>('.toolbar-settings-search-result'));
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
  assert.ok(document.activeElement === results[0]);
  assert.ok(results[0].matches('button'), 'real focus announces the native result name');
  act(() => { results[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
  assert.ok(document.activeElement === results.at(-1));
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => { input.focus(); input.dispatchEvent(tab); });
  assert.equal(tab.defaultPrevented, false, 'search does not intercept ordinary Tab');
});

test('category click clears search without stealing category focus and Server config is not actionable', () => {
  mount();
  const menu = openMenu();
  const input = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  act(() => {
    input.value = 'server config';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(menu.querySelectorAll('.toolbar-settings-search-result').length, 0);
  const category = menu.querySelector<HTMLElement>('[data-tab="models"]')!;
  act(() => { category.focus(); click(category); });
  assert.equal(input.value, '');
  assert.ok(document.activeElement === category);
});

test('compound labels focus keep pickers, bucket add controls, defaults and drop tools', () => {
  const models: ModelInfo[] = [{ id: 'm', name: 'M', provider: 'test', reasoning: false, inputKinds: ['text'] }];
  mount([
    { id: 'skill-pruner', label: 'Skill Pruner', description: '' },
    { id: 'subagent', label: 'Subagent', description: '' },
  ], [...models, { ...models[0], id: 'm2', name: 'M2' }], undefined, { pruningCatalog: { skills: ['test-skill'], tools: ['read'] }, prefs: { ...DEFAULT_CHAT_PREFS, subagentBuckets: { small: [{ model: 'test/m', thinkingLevel: 'low' }], medium: [], frontier: [] } } });
  const menu = openMenu();
  const input = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  for (const label of ['Omitted skills (never pruned)', 'Omitted tools (never pruned)', 'Small bucket models', 'Medium bucket models', 'Frontier bucket models', 'Default providers', 'Drop tools for subagents']) {
    act(() => {
      input.value = label;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = menu.querySelector('.toolbar-settings-search-result-jump');
    assert.ok(result, label);
    act(() => click(result));
    assert.ok(document.activeElement !== input, label);
    if (label.startsWith('Omitted')) assert.equal(document.activeElement?.getAttribute('aria-label'), label);
    if (label.endsWith('bucket models')) assert.ok(document.activeElement?.closest('.toolbar-settings-keep-picker-wrap'), label);
    if (label === 'Drop tools for subagents') assert.equal(document.activeElement?.getAttribute('aria-label'), 'Add a tool name to drop for subagents');
    if (label === 'Default providers') assert.equal(document.activeElement?.getAttribute('role'), 'checkbox');
  }
});

test('provider limits search matches keyword tokens and jumps to the selected provider', () => {
  const models: ModelInfo[] = [
    { id: 'm1', name: 'M1', provider: 'alpha', reasoning: false, inputKinds: ['text'] },
    { id: 'm2', name: 'M2', provider: 'beta', reasoning: false, inputKinds: ['text'] },
  ];
  mount([], models, undefined, {
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { alpha: { maxConcurrentRequests: 3 }, beta: { maxConcurrentRequests: 5 } } },
  });
  const menu = openMenu();
  const input = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  act(() => {
    input.value = 'provider limits';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const results = [...menu.querySelectorAll('.toolbar-settings-search-result-jump')];
  assert.equal(results.length, 8, 'each provider exposes the four concurrency controls');
  assert.deepEqual([...new Set(results.map((result) => result.querySelector('.toolbar-settings-search-result-context')?.textContent))].sort(), ['alpha', 'beta']);
  const betaResult = results.find((result) => result.querySelector('.toolbar-settings-search-result-context')?.textContent === 'beta');
  assert.ok(betaResult);
  act(() => { click(betaResult!); });
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Max concurrent requests for beta');
  assert.equal(menu.querySelector('[data-settings-provider="beta"] [aria-expanded]')?.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.querySelector('[data-settings-provider="alpha"] [aria-expanded]')?.getAttribute('aria-expanded'), 'false');
});

test('provider search expands the identified provider before focusing its control', () => {
  mount([], [{ id: 'm', name: 'M', provider: 'test', reasoning: false, inputKinds: ['text'] }], undefined, {
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { test: { maxConcurrentRequests: 3 } } },
  });
  const menu = openMenu();
  const input = menu.querySelector<HTMLInputElement>('.toolbar-settings-search-input')!;
  act(() => {
    input.value = 'afterburn';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const result = menu.querySelector('.toolbar-settings-search-result-jump');
  assert.match(result?.textContent ?? '', /test/);
  act(() => click(result));
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Afterburn sticky-slot window for test');
  assert.equal(menu.querySelector('[data-settings-provider="test"] [aria-expanded]')?.getAttribute('aria-expanded'), 'true');
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
  // Category appears once as the result group's heading.
  assert.match(body.textContent!, /Appearance/);
  assert.ok(!/No settings match/.test(body.textContent!), 'radius should match, not show the empty state');
});
