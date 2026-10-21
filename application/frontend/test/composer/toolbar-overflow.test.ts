import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../helpers/dom';
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
} from '../../../lib/protocol/index.js';
import { ComposerActions } from '../../composer/actions';
import { ComposerToolbar } from '../../composer/toolbar';
import { SkillPrunerSettings } from '../../settings/settings-menu-skill-pruner';
import { allocateComposerOverflow, allocateComposerToolbar } from '../../composer/toolbar-overflow-allocation';

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
let overflowTriggerWidth = 26;
let modelNaturalWidth = 0;
/** Test-only override for the pinned group beyond the legacy long-model value. */
let pinnedNaturalWidth = 0;
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
    if (this.classList.contains('composer-pinned-controls')) return rect(pinnedNaturalWidth || (longModel ? 190 : 132));
    if (this.classList.contains('composer-toolbar-item')) {
      const key = this.getAttribute('data-toolbar-item');
      if (key === 'working-time') {
        const text = this.textContent ?? '';
        return rect(Math.min(140, Math.max(28, 16 + text.length * 6)));
      }
      if (key === 'run-status') return rect(42);
      return rect(24);
    }
    if (this.classList.contains('model-picker')) return rect(modelNaturalWidth);
    if (this.classList.contains('composer-overflow-trigger')) return rect(overflowTriggerWidth);
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
  overflowTriggerWidth = 26;
  modelNaturalWidth = 0;
  pinnedNaturalWidth = 0;
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

async function showModelTooltip(toolbarProps: Parameters<typeof ComposerToolbar>[0]): Promise<string> {
  const pending: Array<() => void> = [];
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  window.setTimeout = ((handler: TimerHandler) => {
    if (typeof handler === 'function') pending.push(handler as () => void);
    return pending.length as unknown as number;
  }) as typeof window.setTimeout;
  window.clearTimeout = (() => {}) as typeof window.clearTimeout;
  try {
    mount(toolbarProps);
    const trigger = container.querySelector<HTMLElement>('.composer-pinned-controls .model-picker > .pie-tooltip-trigger');
    assert.ok(trigger, 'selected model tooltip wrapper should render');
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('mouseenter'));
      pending.splice(0).forEach((callback) => callback());
    });
    const describedBy = container.querySelector<HTMLButtonElement>('.model-picker-trigger')?.getAttribute('aria-describedby');
    return describedBy ? document.getElementById(describedBy)?.textContent ?? '' : '';
  } finally {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
}

function openOverflow(): HTMLElement {
  click(container.querySelector('.composer-controls > .composer-overflow-trigger'));
  const popover = container.querySelector<HTMLElement>('.composer-toolbar-overflow-popover');
  assert.ok(popover, 'overflow dialog should mount when items do not fit');
  assert.equal(popover!.getAttribute('aria-hidden'), 'false');
  return popover!;
}

test('refresh follows browser network access at the end of the toolbar controls', () => {
  rowWidth = 900;
  mount();
  const refresh = container.querySelector('[data-toolbar-item="pruning-refresh"]');
  assert.ok(refresh);
  assert.ok(refresh.closest('.composer-controls'));
  assert.equal(refresh.previousElementSibling?.getAttribute('data-toolbar-item'), 'browser-network');
  assert.equal(refresh.nextElementSibling, null);
  assert.equal(container.querySelector('.composer-pinned-controls .pruning-refresh-trigger'), null);
});

test('refresh overflows at narrow widths and toggles only from host state, even while busy', () => {
  rowWidth = 220;
  const pending: boolean[] = [];
  const toolbarProps = props({ busy: true, onSetPruningRefreshPending: (value) => pending.push(value) });
  mount(toolbarProps);
  const popover = openOverflow();
  const button = popover.querySelector<HTMLButtonElement>('[aria-label="Refresh capabilities"]')!;
  assert.ok(button.closest('[data-toolbar-item="pruning-refresh"]'));
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.title, /next idle, nonempty send/);
  click(button);
  click(button);
  assert.deepEqual(pending, [true, true], 'clicks do not change local pending state');
  rerender({ ...toolbarProps, pruningRefreshPending: true });
  const armed = container.querySelector<HTMLButtonElement>('[aria-label="Refresh capabilities"]')!;
  assert.equal(armed.getAttribute('aria-pressed'), 'true');
  assert.ok(armed.classList.contains('active'));
  assert.ok(armed.querySelector('.pruning-refresh-pending'));
  assert.match(armed.title, /Refresh pending/);
  click(armed);
  assert.deepEqual(pending, [true, true, false]);
  assert.equal(container.querySelectorAll('[aria-label="Refresh capabilities"]').length, 1);
});

test('refresh is disabled for unavailable transport, session, or pruning scope', () => {
  const attempts: boolean[] = [];
  const base = props({ onSetPruningRefreshPending: (value) => attempts.push(value) });
  for (const override of [
    { commandsAvailable: false },
    { sessionPath: null },
    { sessionPath: '__pending__:create-test' },
    { pruningSettings: { ...DEFAULT_PRUNING_SETTINGS, mode: 'off' as const } },
    { pruningSettings: { ...DEFAULT_PRUNING_SETTINGS, mainAgentEnabled: false } },
    { prefs: { ...DEFAULT_CHAT_PREFS, extensionToggles: { 'skill-pruner': false } } },
  ]) {
    rerender({ ...base, ...override });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Refresh capabilities"]')!;
    assert.equal(button.disabled, true, JSON.stringify(override));
    click(button);
  }
  assert.deepEqual(attempts, []);
});

test('follow-up re-pruning defaults off and posts a passive settings toggle', () => {
  const changes: unknown[] = [];
  const settings = { ...DEFAULT_PRUNING_SETTINGS, followUpEnabled: undefined };
  act(() => render(h(SkillPrunerSettings, {
    prefs: DEFAULT_CHAT_PREFS, pruningSettings: settings, skillCatalog: [], toolCatalog: [],
    onSetPrefs: () => {}, onSetPruningSettings: (value) => changes.push(value),
  }), container));
  const checkbox = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    .find((element) => element.textContent?.includes('Re-prune on follow-up messages'));
  assert.ok(checkbox);
  assert.equal(checkbox.getAttribute('aria-checked'), 'false');
  click(checkbox);
  assert.deepEqual(changes, [{ followUpEnabled: true }]);
  assert.equal(checkbox.getAttribute('aria-checked'), 'false');
});

const MODEL_LABEL_LADDER = {
  availableWidth: 390,
  pinnedNaturalWidth: 270,
  modelNaturalWidth: 180,
  actionsWidth: 54,
  items: [
    { key: 'mcp', kind: 'control' as const, width: 24 },
    { key: 'working-time', kind: 'indicator' as const, width: 28 },
    { key: 'context-window', kind: 'indicator' as const, width: 60 },
  ],
  sectionGap: 4,
  controlGap: 2,
  indicatorGap: 2,
  overflowTriggerWidth: 26,
} as const;

test('model label compacts to the reserved floor before useful metrics hide', () => {
  // required-without-model 268 (no trigger while nothing is hidden); the
  // compact reserve 96 fits at 390, so every item stays while the label accepts
  // a budget below its natural 180px — retained indicators are already part of
  // the same required-width arithmetic, so the mixed row cannot overflow.
  assert.deepEqual(allocateComposerToolbar(MODEL_LABEL_LADDER), {
    visibleItemKeys: ['mcp', 'working-time', 'context-window'],
    modelWidthBudget: 122,
  }, 'useful metrics stay while the label compacts below its natural width');

  // Narrowing yields in removal-priority order — the control, then the
  // lower-priority duration metric — while the label keeps at least its
  // reserved floor for the widest-retained indicator.
  assert.deepEqual(allocateComposerToolbar({ ...MODEL_LABEL_LADDER, availableWidth: 340 }), {
    visibleItemKeys: ['context-window'],
    modelWidthBudget: 100,
  });

  // When even the reserve cannot save a candidate, removal continues in the
  // built-in priority and the label only yields below 96px once no secondary
  // item remains.
  assert.deepEqual(allocateComposerToolbar({ ...MODEL_LABEL_LADDER, availableWidth: 300 }), {
    visibleItemKeys: [],
    modelWidthBudget: 124,
  }, 'an empty row may still yield the label below the compact reserve');
  assert.deepEqual(allocateComposerToolbar({ ...MODEL_LABEL_LADDER, availableWidth: 170 }), {
    visibleItemKeys: [],
    modelWidthBudget: 0,
  }, 'a pathological row narrower than the pinned group keeps the overflow affordance');

  // Item-only semantics are unchanged; the historical control-before-indicator
  // order is covered by the removal-priority tests below.
});

const DASH_ALLOCATION = {
  availableWidth: 297,
  pinnedNaturalWidth: 240,
  modelNaturalWidth: 180,
  actionsWidth: 54,
  items: [
    { key: 'mcp', kind: 'control' as const, width: 24 },
    { key: 'session-cost', kind: 'indicator' as const, width: 24 },
    { key: 'working-time', kind: 'indicator' as const, width: 28 },
  ],
  sectionGap: 4,
  controlGap: 2,
  indicatorGap: 2,
  overflowTriggerWidth: 26,
} as const;

test('a bare unknown-cost chip yields before any control; a valued cost chip keeps its built-in priority', () => {
  // required-without-model with the dash present: 202 + reserve 96 does not fit
  // at 297, and the override drops the dash first (the hidden state then charges
  // the trigger, so the control also yields) while the duration metric remains.
  assert.deepEqual(allocateComposerToolbar({
    ...DASH_ALLOCATION,
    items: [
      { key: 'mcp', kind: 'control' as const, width: 24 },
      { key: 'session-cost', kind: 'indicator' as const, width: 24, removalPriority: 0 },
      { key: 'working-time', kind: 'indicator' as const, width: 28 },
    ],
  }), {
    visibleItemKeys: ['working-time'],
    modelWidthBudget: 119,
  }, 'the bare dash joins the overflow panel ahead of the built-in order');
  // Same widths without the override: the control and duration yield and the
  // valued cost chip keeps its row slot, exactly as before this change.
  assert.deepEqual(allocateComposerToolbar(DASH_ALLOCATION), {
    visibleItemKeys: ['session-cost'],
    modelWidthBudget: 123,
  }, 'a valued cost chip keeps its built-in priority');
  // The override reorders removal purely by priority, independent of the model
  // stage: with no model reservation the chip is considered before every
  // control.
  const tight = {
    availableWidth: 90,
    pinnedNaturalWidth: 10,
    actionsWidth: 10,
    items: [
      DASH_ALLOCATION.items[0],
      { ...DASH_ALLOCATION.items[1], removalPriority: 0 as const },
      DASH_ALLOCATION.items[2],
    ],
    sectionGap: 0,
    controlGap: 0,
    indicatorGap: 0,
    overflowTriggerWidth: 5,
  };
  assert.deepEqual(allocateComposerOverflow(tight), ['mcp', 'working-time']);
  assert.deepEqual(allocateComposerOverflow({ ...tight, items: DASH_ALLOCATION.items }), [
    'session-cost', 'working-time',
  ], 'without the override the control yields first, as before');
});

// The unknown-cost fixture below exercises the chip from its real source state:
// unavailable accounting renders a bare em dash (never a zero) with a
// descriptive aria label and the full tooltip.
function unknownSessionCost(): NonNullable<Parameters<typeof ComposerToolbar>[0]['sessionCostIndicator']> {
  return {
    label: '—',
    ariaLabel: 'Session cost unavailable; cumulative usage coverage is unknown.',
    tooltip: 'Session cost by provider / model (whole branch):\n  Unknown · authoritative ledger unavailable',
    breakdown: {
      totalCost: 0,
      hasIncompleteCost: true,
      unpricedTokens: 0,
      reportedTurnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      providers: [],
      sources: [],
    },
  };
}

test('coarse-pointer allocation reserves the measured 44px trigger in item and model budgets', () => {
  const input = {
    availableWidth: 320,
    pinnedNaturalWidth: 190,
    actionsWidth: 54,
    items: [
      { key: 'secondary', kind: 'control' as const, width: 100 },
      { key: 'context-window', kind: 'indicator' as const, width: 40 },
    ],
    sectionGap: 4,
    controlGap: 2,
    indicatorGap: 2,
  };
  assert.deepEqual(allocateComposerOverflow({ ...input, overflowTriggerWidth: 26 }), ['context-window']);
  assert.deepEqual(allocateComposerOverflow({ ...input, overflowTriggerWidth: 44 }), []);
  // The model budget is now part of one calculation with the retained items:
  // at this width the context indicator can stay while the label compacts, and
  // the retained indicator reduces the budget so the mixed row cannot overflow.
  assert.deepEqual(allocateComposerToolbar({
    ...input,
    pinnedNaturalWidth: 314,
    modelNaturalWidth: 240,
    overflowTriggerWidth: 44,
  }), { visibleItemKeys: ['context-window'], modelWidthBudget: 98 }, 'a retained indicator reduces the model budget');
  assert.deepEqual(allocateComposerToolbar({
    ...input,
    pinnedNaturalWidth: 314,
    modelNaturalWidth: 240,
    availableWidth: 220,
    overflowTriggerWidth: 44,
  }), { visibleItemKeys: [], modelWidthBudget: 42 }, 'below the reserve band the label yields to whatever remains');
});

test('measures the trigger before overflow exists and observes CSS width changes for both budgets', () => {
  overflowTriggerWidth = 44;
  modelNaturalWidth = 120;
  longModel = true;
  rowWidth = 900;
  mount();
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null);
  const probe = container.querySelector<HTMLElement>('[data-composer-overflow-measurement]');
  assert.ok(probe, 'the absent trigger has an offscreen measurement probe');
  assert.equal(probe.getAttribute('aria-hidden'), 'true');
  assert.equal(probe.tabIndex, -1);
  assert.ok(TestResizeObserver.instances.some((observer) => observer.targets.has(probe)), 'CSS trigger sizing is observed even before overflow');

  rowWidth = 320;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.ok(container.querySelector('.composer-controls > .composer-overflow-trigger'));
  assert.ok(
    container.querySelector('.composer-indicators [data-toolbar-item="working-time"]'),
    'the compact model label reserve keeps the duration metric in the row',
  );
  const compressedPinned = container.querySelector<HTMLElement>('.composer-pinned-controls');
  assert.equal(
    compressedPinned?.style.getPropertyValue('--composer-model-picker-max-width'),
    '114px',
    'the 44px trigger leaves a compact bounded label budget (with the retained indicator charged)',
  );

  rowWidth = 220;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  const pinned = container.querySelector<HTMLElement>('.composer-pinned-controls');
  assert.equal(pinned?.style.getPropertyValue('--composer-model-picker-max-width'), '46px', 'the model yields enough room for the actual 44px trigger');
  overflowTriggerWidth = 26;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(pinned?.style.getPropertyValue('--composer-model-picker-max-width'), '64px', 'desktop CSS restores the 26px width budget');
  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null, 'wide layout still shows every item without a live More button');
});

test('selected model tooltip identifies the provider-qualified model and display label', async () => {
  const longModel = { ...model, id: 'gpt-6-astral-preview', name: 'GPT-6 Astra Extended' };
  const tooltip = await showModelTooltip(props({
    availableModels: [longModel],
    selectedModel: longModel.id,
    selectedProvider: longModel.provider,
  }));
  assert.match(tooltip, /provider-a\/gpt-6-astral-preview/);
  assert.match(tooltip, /GPT-6 Astra Extended/);
  assert.doesNotMatch(tooltip, /Select model/);
});

test('disabled selected model tooltip keeps the provider warning beside model identity', async () => {
  const disabledModel = { ...model, id: 'gpt-6-astral-preview', name: 'GPT-6 Astra Extended' };
  const tooltip = await showModelTooltip(props({
    prefs: {
      ...DEFAULT_CHAT_PREFS,
      providerToggles: { ...DEFAULT_CHAT_PREFS.providerToggles, [disabledModel.provider]: false },
    },
    availableModels: [disabledModel],
    selectedModel: disabledModel.id,
    selectedProvider: disabledModel.provider,
  }));
  assert.match(tooltip, /provider-a\/gpt-6-astral-preview/);
  assert.match(tooltip, /GPT-6 Astra Extended/);
  assert.match(tooltip, /Selected provider is disabled — select another model/);
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
    pinnedNaturalWidth: 100,
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
    pinnedNaturalWidth: 50,
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
    'subagent-providers', 'system-prompts', 'mcp', 'compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network', 'pruning-refresh',
    'run-status',
  ]);
  assert.equal(container.querySelectorAll('[data-toolbar-item="autonomous-mode"]').length, 1, 'moved controls are mounted once');
});

test('ResizeObserver moves controls back when room returns and reallocates for dynamic indicator labels', () => {
  mount();
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null, 'the initial labels fit at the starting row width');
  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null, 'the overflow trigger disappears when every item fits');
  assert.equal(container.querySelector('.composer-toolbar-overflow-popover'), null);
  assert.equal(container.querySelectorAll('.composer-indicators [data-toolbar-item]').length, 2);

  rowWidth = 480;
  const longTime = 'A very long live duration label that changes its measured width';
  rerender(props({ workingTimeIndicator: { label: longTime, ariaLabel: 'Working time', tooltip: 'Working time' } }));
  assert.ok(container.querySelector('.composer-controls > .composer-overflow-trigger'), 'the longer dynamic indicator creates overflow at the same row width');
  const popover = openOverflow();
  assert.deepEqual(
    Array.from(popover.querySelectorAll<HTMLElement>('[data-toolbar-item]')).map((element) => element.dataset.toolbarItem),
    ['mcp', 'compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network', 'pruning-refresh'],
  );

  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  rowWidth = 480;
  longModel = true;
  rerender(props({
    availableModels: [{ ...model, name: 'A model label long enough to consume the remaining composer width' }],
  }));
  assert.ok(container.querySelector('.composer-controls > .composer-overflow-trigger'), 'a long selected-model label reduces the measured space available to secondary items');
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
  assert.deepEqual(preferenceWrites, [{ autonomousModeBySession: { '/session/test.jsonl': true } }]);

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
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null, 'growing the row moves children out and removes the trigger');
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
  const trigger = container.querySelector<HTMLButtonElement>('.composer-controls > .composer-overflow-trigger');
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


test('keyboard opening focuses the first control and Escape restores More', () => {
  rowWidth = 265;
  mount();
  const trigger = container.querySelector<HTMLButtonElement>('.composer-controls > .composer-overflow-trigger')!;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  const popover = container.querySelector<HTMLElement>('.composer-toolbar-overflow-popover')!;
  assert.equal(document.activeElement, popover.querySelector('button:not(:disabled)'));
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  assert.equal(document.activeElement, trigger);
  click(trigger);
  assert.equal(document.activeElement, trigger, 'pointer opening does not move focus');
});

// Realistic narrow-row ladder measured from the pinned group (270 = the 180px
// model cap plus 90px of Settings/Reasoning): the label compacting to its
// reserved floor keeps useful metrics in the row far longer, and only a row
// with nothing left squeezes the label below the floor.
test('narrow rows compact the model label, then yield items, and only an empty row yields below the reserve', () => {
  modelNaturalWidth = 180;
  pinnedNaturalWidth = 270;
  rowWidth = 540;
  mount();
  const pinned = container.querySelector<HTMLElement>('.composer-pinned-controls')!;
  assert.equal(
    pinned.style.getPropertyValue('--composer-model-picker-max-width'),
    '108px',
    'even a row with no overflow charges the compact label with the retained indicators',
  );
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null);

  rowWidth = 430;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(pinned.style.getPropertyValue('--composer-model-picker-max-width'), '100px', 'the label compacts past its natural width before any item hides');
  assert.deepEqual(
    Array.from(container.querySelectorAll<HTMLElement>('.composer-toolbar-overflow-popover [data-toolbar-item]'))
      .map((element) => element.dataset.toolbarItem),
    ['compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network', 'pruning-refresh'],
    'five controls hide while the duration metric stays visible',
  );
  assert.ok(container.querySelector('.composer-indicators [data-toolbar-item="working-time"]'), 'the duration metric is retained, not hidden behind the model label');

  rowWidth = 340;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(pinned.style.getPropertyValue('--composer-model-picker-max-width'), '132px', 'the label holds at least its reserved floor while a useful metric remains');
  assert.ok(container.querySelector('.composer-indicators [data-toolbar-item="working-time"]'));
  assert.ok(container.querySelector('.composer-toolbar-overflow-popover [data-toolbar-item="run-status"]'), 'the transient run status yields before the duration metric');

  rowWidth = 240;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.equal(pinned.style.getPropertyValue('--composer-model-picker-max-width'), '64px', 'only a row with no secondary item left yields the label below its reserve');
  assert.equal(container.querySelector('.composer-indicators'), null);
  assert.ok(container.querySelector('.composer-toolbar-overflow-popover [data-toolbar-item="working-time"]'));
});

test('repeated measurement converges instead of oscillating between allocations', () => {
  modelNaturalWidth = 180;
  pinnedNaturalWidth = 270;
  rowWidth = 430;
  mount();
  const pinned = container.querySelector<HTMLElement>('.composer-pinned-controls')!;
  const snapshot = () => ({
    budget: pinned.style.getPropertyValue('--composer-model-picker-max-width'),
    rowKeys: Array.from(container.querySelectorAll<HTMLElement>('.composer-controls > [data-toolbar-item], .composer-indicators [data-toolbar-item]')).map((element) => element.dataset.toolbarItem),
    hiddenKeys: Array.from(container.querySelectorAll<HTMLElement>('.composer-toolbar-overflow-popover [data-toolbar-item]')).map((element) => element.dataset.toolbarItem),
  });
  const stable = snapshot();
  for (let pass = 0; pass < 5; pass += 1) {
    act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
    assert.deepEqual(snapshot(), stable, `allocation stays identical after re-measure pass ${pass}`);
  }

  // Deterministic across width round-trips: returning to a width reproduces
  // the exact allocation that width had before.
  const at340 = () => {
    rowWidth = 340;
    act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
    return snapshot();
  };
  const narrow = at340();
  rowWidth = 900;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  rowWidth = 430;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.deepEqual(snapshot(), { ...stable, budget: '100px', rowKeys: stable.rowKeys, hiddenKeys: stable.hiddenKeys });
  assert.deepEqual(at340(), narrow);
  rowWidth = 540;
  act(() => { TestResizeObserver.instances.forEach((observer) => observer.trigger()); });
  assert.ok(container.querySelector('.composer-indicators [data-toolbar-item="run-status"]'), 'growing the row returns every item');
  assert.equal(container.querySelector('.composer-controls > .composer-overflow-trigger'), null);
});

// The fixture state matches the real unavailable-cost source: a bare em dash
// label (never a fabricated zero), a descriptive aria label, and the full
// tooltip that must survive the move into the panel.
test('the bare unknown-cost dash moves into More at a width where a valued cost chip stays in the row', () => {
  modelNaturalWidth = 180;
  pinnedNaturalWidth = 270;
  rowWidth = 420;
  const unknownProps = props({ sessionCostIndicator: unknownSessionCost() });
  mount(unknownProps);
  const pinned = container.querySelector<HTMLElement>('.composer-pinned-controls')!;
  assert.equal(pinned.style.getPropertyValue('--composer-model-picker-max-width'), '116px');
  const popover = openOverflow();
  assert.deepEqual(
    Array.from(popover.querySelectorAll<HTMLElement>('[data-toolbar-item]')).map((element) => element.dataset.toolbarItem),
    ['mcp', 'compact-context', 'autonomous-mode', 'privacy-mode', 'browser-network', 'pruning-refresh', 'session-cost'],
    'the bare dash yields ahead of the built-in control order',
  );
  const costChip = popover.querySelector<HTMLElement>('[data-toolbar-item="session-cost"] [role="img"]')!;
  assert.equal(costChip!.textContent, '—', 'unavailable cost keeps its bare dash, never a fabricated zero');
  assert.equal(costChip!.getAttribute('aria-label'), 'Session cost unavailable; cumulative usage coverage is unknown.');
  assert.ok(costChip!.closest('.pie-tooltip-trigger'), 'the overflowed dash keeps its tooltip wrapper');

  rerender({ ...unknownProps, sessionCostIndicator: { ...unknownSessionCost(), label: '$3.42', ariaLabel: 'Estimated session cost $3.42.' } });
  const rowChip = container.querySelector('.composer-indicators [data-toolbar-item="session-cost"] [role="img"]');
  assert.ok(rowChip, 'a valued cost chip keeps its built-in priority and stays in the row');
  assert.match(rowChip!.textContent ?? '', /3\.42/);
  assert.equal(
    container.querySelector<HTMLElement>('.composer-pinned-controls')!.style.getPropertyValue('--composer-model-picker-max-width'),
    '116px',
  );
});

test('overflowed controls show short action names beside their icons while the row stays icon-only', () => {
  rowWidth = 265;
  mount();
  const rowControls = container.querySelectorAll<HTMLElement>('.composer-controls > [data-toolbar-item-kind="control"] .composer-toolbar-item-label');
  assert.equal(rowControls.length, 0, 'the row keeps icon-only triggers');

  const popover = openOverflow();
  const labelsByItem: Record<string, string | undefined> = {};
  popover.querySelectorAll<HTMLElement>('[data-toolbar-item-kind="control"]').forEach((item) => {
    const label = item.querySelector<HTMLElement>('.composer-toolbar-item-label');
    labelsByItem[item.dataset.toolbarItem ?? ''] = label?.textContent;
    assert.equal(label?.getAttribute('aria-hidden'), 'true', `${item.dataset.toolbarItem} keeps a single accessible name`);
  });
  assert.deepEqual(labelsByItem, {
    'subagent-providers': 'Subagents',
    'system-prompts': 'Prompts',
    mcp: 'MCP',
    'compact-context': 'Compact',
    'autonomous-mode': 'Autonomous',
    'privacy-mode': 'Privacy',
    'browser-network': 'Browser',
    'pruning-refresh': 'Refresh',
  });
  assert.ok(popover.querySelector('[data-toolbar-item-kind="indicator"]'), 'this width also overflows an indicator');
  assert.equal(
    popover.querySelector<HTMLElement>('[data-toolbar-item-kind="indicator"] .composer-toolbar-item-label'),
    null,
    'indicators already carry their own text label',
  );
  assert.equal(
    popover.querySelector<HTMLButtonElement>('[data-toolbar-item="pruning-refresh"] button')?.getAttribute('aria-label'),
    'Refresh capabilities',
    'trigger accessible names are unchanged',
  );
  assert.equal(container.querySelectorAll('[data-toolbar-item="mcp"]').length, 1, 'labeled rows are not a second mounting of the item');
});
