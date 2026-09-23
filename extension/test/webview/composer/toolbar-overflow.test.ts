import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  type ModelInfo,
} from '../../../src/shared/protocol';
import { ComposerActions } from '../../../src/webview/panel/composer/actions';
import { ComposerToolbar } from '../../../src/webview/panel/composer/toolbar';
import { allocateComposerModelWidthBudget, allocateComposerOverflow } from '../../../src/webview/panel/composer/toolbar-overflow-allocation';

const model: ModelInfo = {
  id: 'model-a',
  name: 'Model A',
  provider: 'provider-a',
  reasoning: true,
  thinkingLevels: ['off', 'high'],
  inputKinds: ['text'],
};

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
  takeRecords(): ResizeObserverEntry[] { return []; }
  trigger(): void { this.callback([], this as unknown as ResizeObserver); }
}

let container: HTMLElement;
let rowWidth = 480;
let longModel = false;
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
let originalObserver: unknown;
let gapStyles: HTMLStyleElement;

function rect(width: number): DOMRect {
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 26, width, height: 26, toJSON: () => ({}) } as DOMRect;
}

function installLayout(): void {
  gapStyles = document.createElement('style');
  gapStyles.textContent = '.composer-bottom-bar{gap:4px}.composer-controls{column-gap:2px}.composer-indicators{column-gap:2px}';
  document.head.appendChild(gapStyles);
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this.classList.contains('composer-bottom-bar')) return rect(rowWidth);
    if (this.classList.contains('composer-actions')) return rect(54);
    if (this.classList.contains('composer-pinned-controls')) return rect(longModel ? 190 : 132);
    if (this.classList.contains('composer-toolbar-item')) {
      const key = this.getAttribute('data-toolbar-item');
      if (key === 'working-time') {
        const text = this.textContent ?? '';
        return rect(Math.min(140, Math.max(28, 16 + text.length * 6)));
      }
      if (key === 'run-status') return rect(42);
      return rect(24);
    }
    if (this.classList.contains('composer-overflow-trigger')) return rect(26);
    return originalRect.call(this);
  };
  originalObserver = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
}

function cleanupLayout(): void {
  gapStyles.remove();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = originalObserver;
  TestResizeObserver.instances = [];
}

beforeEach(() => {
  rowWidth = 480;
  longModel = false;
  TestResizeObserver.instances = [];
  installLayout();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  document.querySelectorAll('.browser-server-popover, .composer-toolbar-overflow-popover').forEach((element) => element.remove());
  cleanupLayout();
});

function props(overrides: Partial<Parameters<typeof ComposerToolbar>[0]> = {}): Parameters<typeof ComposerToolbar>[0] {
  return {
    sessionPath: '/session/test.jsonl',
    canCompact: true,
    commandsAvailable: true,
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: () => {},
    mcpServers: [],
    mcpPendingApply: false,
    onMcpListRequested: () => {},
    onMcpSetServerEnabled: () => {},
    mcpSessionServers: [],
    mcpSessionPendingApply: false,
    onMcpSetServerEnabledForSession: () => {},
    onSetBrowserServerLanEnabled: () => {},
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
    onSetSessionTitlesSettings: () => {},
    availableExtensions: [],
    availableModels: [model],
    systemPrompts: [],
    selectedModel: model.id,
    selectedProvider: model.provider,
    selectedLevel: 'high',
    supportsReasoning: true,
    contextIndicator: null,
    contextBreakdown: null,
    sessionCostIndicator: null,
    tokenRateIndicator: { label: '', ariaLabel: '', tooltip: '', state: 'idle', paused: false },
    workingTimeIndicator: { label: '0s', ariaLabel: 'Working time', tooltip: 'Working time' },
    runStatus: { text: 'LIVE', tone: 'open', title: 'Run is live' },
    compacting: false,
    lastCompaction: null,
    onModelChange: () => {},
    onCompact: () => {},
    ...overrides,
  };
}

function actions() {
  return h(ComposerActions, {
    busy: false,
    hasQueuedMessages: false,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: true,
  });
}

function mount(toolbarProps = props()): void {
  act(() => {
    render(
      h('div', { class: 'composer-bottom-bar' },
        h(ComposerToolbar, toolbarProps),
        actions(),
      ),
      container,
    );
  });
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
}

function rerender(toolbarProps: Parameters<typeof ComposerToolbar>[0]): void {
  act(() => {
    render(
      h('div', { class: 'composer-bottom-bar' },
        h(ComposerToolbar, toolbarProps),
        actions(),
      ),
      container,
    );
  });
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
}

function click(element: Element | null): void {
  assert.ok(element, 'expected a rendered target');
  act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function openOverflow(): HTMLElement {
  click(container.querySelector('.composer-overflow-trigger'));
  const popover = container.querySelector<HTMLElement>('.composer-toolbar-overflow-popover');
  assert.ok(popover, 'overflow dialog should mount when items do not fit');
  assert.equal(popover!.getAttribute('aria-hidden'), 'false');
  return popover!;
}

test('model width stays natural until secondary items are all overflowed, then uses only remaining row budget', () => {
  const input = {
    availableWidth: 400,
    pinnedNaturalWidth: 160,
    modelNaturalWidth: 86,
    actionsWidth: 58,
    sectionGap: 4,
    controlGap: 2,
    overflowTriggerWidth: 26,
  } as const;
  assert.equal(allocateComposerModelWidthBudget({ ...input, hasOverflow: false }), 86);
  assert.equal(allocateComposerModelWidthBudget({ ...input, hasOverflow: true }), 86, 'the model keeps its natural width when the remaining budget is sufficient');
  assert.equal(allocateComposerModelWidthBudget({ ...input, availableWidth: 220, hasOverflow: true }), 56, 'the model alone yields room for settings, reasoning, actions, and the overflow trigger');
});

test('overflow removes secondary controls, then speed, duration, cost, and context regardless of presentation order', () => {
  const items = [
    { key: 'system-prompts', kind: 'control' as const, width: 10 },
    { key: 'browser-network', kind: 'control' as const, width: 10 },
    { key: 'session-cost', kind: 'indicator' as const, width: 10 },
    { key: 'token-rate', kind: 'indicator' as const, width: 10 },
    { key: 'working-time', kind: 'indicator' as const, width: 10 },
    { key: 'run-status', kind: 'indicator' as const, width: 10 },
    { key: 'context-window', kind: 'indicator' as const, width: 10 },
  ] as const;
  const input = {
    availableWidth: 190,
    pinnedWidth: 100,
    actionsWidth: 20,
    items,
    controlGap: 0,
    indicatorGap: 0,
    sectionGap: 0,
    overflowTriggerWidth: 5,
  } as const;
  const allocate = (availableWidth: number) => allocateComposerOverflow({ ...input, availableWidth });
  assert.deepEqual(allocate(190), items.map(({ key }) => key), 'all items fit before the trigger is needed');
  assert.deepEqual(allocate(189), [
    'system-prompts', 'session-cost', 'token-rate', 'working-time', 'run-status', 'context-window',
  ], 'the last secondary control is removed first, with the trigger width charged');
  assert.deepEqual(allocate(184), [
    'session-cost', 'token-rate', 'working-time', 'run-status', 'context-window',
  ], 'all secondary controls leave before any indicator');
  assert.deepEqual(allocate(174), ['session-cost', 'token-rate', 'working-time', 'context-window'], 'transient run status yields before metrics');
  assert.deepEqual(allocate(164), ['session-cost', 'working-time', 'context-window'], 'speed yields before duration, cost, and context');
  assert.deepEqual(allocate(154), ['session-cost', 'context-window'], 'duration yields before cost and context');
  assert.deepEqual(allocate(144), ['context-window'], 'cost yields before context');
  assert.deepEqual(allocate(134), [], 'context is the last indicator removed');
});

test('overflow priority skips absent indicators and uses each present item width', () => {
  const input = {
    availableWidth: 150,
    pinnedWidth: 50,
    actionsWidth: 10,
    items: [
      { key: 'mcp', kind: 'control' as const, width: 10 },
      { key: 'compact-context', kind: 'control' as const, width: 20 },
      { key: 'context-window', kind: 'indicator' as const, width: 40 },
      { key: 'session-cost', kind: 'indicator' as const, width: 20 },
    ],
    controlGap: 0,
    indicatorGap: 0,
    sectionGap: 0,
    overflowTriggerWidth: 5,
  } as const;
  assert.deepEqual(allocateComposerOverflow(input), ['mcp', 'compact-context', 'context-window', 'session-cost']);
  assert.deepEqual(
    allocateComposerOverflow({ ...input, availableWidth: 115 }),
    ['context-window'],
    'both controls and cost yield while the wider context indicator remains',
  );
  assert.deepEqual(
    allocateComposerOverflow({ ...input, availableWidth: 104 }),
    [],
    'context yields only after the present cost indicator and controls',
  );
});

test('overflow keeps pinned controls visible and places hidden controls and indicators in original order', () => {
  rowWidth = 265;
  mount();
  const pinned = container.querySelector('.composer-pinned-controls');
  assert.ok(pinned?.querySelector('[aria-label="Settings"]'), container.innerHTML);
  assert.ok(pinned?.querySelector('[aria-label="Model"]'));
  assert.ok(pinned?.querySelector('[aria-label="Reasoning level"]'));

  const popover = openOverflow();
  const hiddenKeys = Array.from(popover.querySelectorAll<HTMLElement>('[data-toolbar-item]'))
    .map((element) => element.dataset.toolbarItem);
  assert.deepEqual(hiddenKeys, [
    'subagent-providers', 'system-prompts', 'mcp', 'compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network',
    'run-status',
  ]);
  assert.equal(container.querySelectorAll('[data-toolbar-item="autonomous-mode"]').length, 1, 'moved controls are mounted once');
});

test('ResizeObserver moves controls back when room returns and reallocates for dynamic indicator labels', () => {
  mount();
  assert.equal(container.querySelector('.composer-overflow-trigger'), null, 'the initial labels fit at the starting row width');
  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(container.querySelector('.composer-overflow-trigger'), null, 'the overflow trigger disappears when every item fits');
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover'), null);
  assert.equal(container.querySelectorAll('.composer-indicators [data-toolbar-item]').length, 2);

  rowWidth = 480;
  const longTime = 'A very long live duration label that changes its measured width';
  rerender(props({ workingTimeIndicator: { label: longTime, ariaLabel: 'Working time', tooltip: 'Working time' } }));
  assert.ok(container.querySelector('.composer-overflow-trigger'), 'the longer dynamic indicator creates overflow at the same row width');
  const popover = openOverflow();
  assert.deepEqual(
    Array.from(popover.querySelectorAll<HTMLElement>('[data-toolbar-item]')).map((element) => element.dataset.toolbarItem),
    ['mcp', 'compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network'],
  );

  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  rowWidth = 480;
  longModel = true;
  rerender(props({
    availableModels: [{ ...model, name: 'A model label long enough to consume the remaining composer width' }],
  }));
  assert.ok(container.querySelector('.composer-overflow-trigger'), 'a long selected-model label reduces the measured space available to secondary items');
});

test('overflowed callbacks are reused and nested browser popovers stay open until their own Escape', () => {
  rowWidth = 265;
  const preferenceWrites: unknown[] = [];
  const lanWrites: boolean[] = [];
  let toolbarProps = props({
    onSetPrefs: (update) => preferenceWrites.push(update),
    onSetBrowserServerLanEnabled: (enabled) => lanWrites.push(enabled),
  });
  mount(toolbarProps);
  const popover = openOverflow();
  click(popover.querySelector('[aria-label^="Enable autonomous mode"]'));
  assert.deepEqual(preferenceWrites, [{ autonomousMode: true }]);

  click(popover.querySelector('[aria-label="Browser network access"]'));
  const browserPopover = document.body.querySelector<HTMLElement>('.browser-server-popover');
  assert.ok(browserPopover, 'the existing browser-server portal is opened from overflow');
  const lanSwitch = browserPopover!.querySelector<HTMLElement>('[aria-label="Allow trusted LAN access"]');
  assert.ok(lanSwitch);
  act(() => { lanSwitch!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  click(lanSwitch);
  assert.deepEqual(lanWrites, [true]);
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'false', 'interaction in the nested portal does not dismiss overflow');

  act(() => {
    browserPopover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.equal(document.body.querySelector('.browser-server-popover'), null, 'Escape first dismisses the nested portal');
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'false', 'the parent overflow remains open after nested Escape');
  act(() => {
    popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'true');

  const outsideFocusTarget = document.createElement('button');
  document.body.appendChild(outsideFocusTarget);
  openOverflow();
  act(() => { outsideFocusTarget.focus(); });
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'true', 'moving focus outside dismisses the overflow panel');
  openOverflow();
  act(() => { outsideFocusTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'true', 'an outside pointer dismisses the overflow panel');
  outsideFocusTarget.remove();

  const resizingPopover = openOverflow();
  click(resizingPopover.querySelector('[aria-label="Browser network access"]'));
  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(container.querySelector('.composer-overflow-trigger'), null, 'growing the row moves children out and removes the trigger');
  assert.equal(document.body.querySelector('.browser-server-popover'), null, 'a remounted child cleans up its nested portal');

  // Reopen and prove the portaled switch honors host disconnection even though
  // it is outside the disabled fieldset in the DOM.
  rowWidth = 265;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  openOverflow();
  click(container.querySelector('[aria-label="Browser network access"]'));
  toolbarProps = { ...toolbarProps, commandsAvailable: false };
  rerender(toolbarProps);
  const disconnectedPopover = document.body.querySelector<HTMLElement>('.browser-server-popover');
  const disconnectedSwitch = disconnectedPopover?.querySelector<HTMLButtonElement>('[aria-label="Allow trusted LAN access"]');
  assert.equal(disconnectedSwitch?.disabled, true);
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-pinned-controls .model-picker-trigger')?.disabled, true);
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-pinned-controls [aria-label="Reasoning level"]')?.disabled, true);
  assert.ok(container.querySelector('.composer-indicators [data-toolbar-item="working-time"]'), 'duration remains visible ahead of lower-priority status indicators');
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover')?.getAttribute('aria-hidden'), 'false');
  assert.match(container.querySelector('.composer-toolbar-overflow-popover')?.textContent ?? '', /LIVE/, 'overflowed status indicators remain visible while controls are disabled');
});

test('disconnected toolbar leaves the overflow trigger and status indicators outside disabled control fieldsets', () => {
  rowWidth = 265;
  mount(props({ commandsAvailable: false }));
  const trigger = container.querySelector<HTMLButtonElement>('.composer-overflow-trigger');
  assert.ok(trigger);
  assert.equal(trigger!.disabled, false, 'the overflow trigger stays enabled when commands are unavailable');

  const popover = openOverflow();
  const disabledControl = popover.querySelector<HTMLFieldSetElement>('[data-toolbar-item-kind="control"]');
  assert.equal(disabledControl?.disabled, true, 'overflowed commands remain grouped under native disabled fieldsets');
  const indicator = popover.querySelector<HTMLElement>('[data-toolbar-item-kind="indicator"] [role="status"], [data-toolbar-item-kind="indicator"] [role="img"]');
  assert.ok(indicator, 'an overflowed status indicator remains present');
  assert.equal(indicator?.closest('fieldset:disabled'), null, 'status indicators are not disabled with commands');
});

test('disconnection closes a portaled model picker and disables pinned menu triggers', () => {
  rowWidth = 265;
  const toolbarProps = props();
  mount(toolbarProps);
  click(container.querySelector('.composer-pinned-controls [aria-label="Settings"]'));
  assert.ok(document.body.querySelector('.toolbar-settings-menu'), 'settings render in their existing portal');
  rerender({ ...toolbarProps, commandsAvailable: false });
  assert.equal(document.body.querySelector('.toolbar-settings-menu'), null, 'the settings portal closes before it can bypass fieldset disabled state');

  rerender(toolbarProps);
  click(container.querySelector('.composer-pinned-controls .model-picker-trigger'));
  assert.ok(document.body.querySelector('.model-picker-dropdown'), 'model options open in their existing portal');
  rerender({ ...toolbarProps, commandsAvailable: false });
  assert.equal(document.body.querySelector('.model-picker-dropdown'), null, 'a portaled model chooser cannot remain interactive outside the disabled fieldset');
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-pinned-controls .model-picker-trigger')?.disabled, true);
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-pinned-controls [aria-label="Reasoning level"]')?.disabled, true);
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-pinned-controls [aria-label="Settings"]')?.disabled, true);
});
