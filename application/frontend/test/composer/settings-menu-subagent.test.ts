import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
import { focusSettingsHelp } from '../helpers/settings-help';
installDom();

import { SubagentModelAssignments as SubagentSection, SubagentSection as SubagentBehaviorSection } from '../../settings/settings-menu-subcomponents';
import { filterEnabledProviders, getModelThinkingLevels, orderModelsForPicker } from '../../composer/model-list';
import { DEFAULT_CHAT_PREFS } from '../../../lib/protocol/index.js';
import type { ChatPrefs, ModelInfo } from '../../../lib/protocol/index.js';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

async function focusedTooltip(container: HTMLElement, label: string): Promise<string> {
  const trigger = container.querySelector(`[aria-label="About ${label}"]`) as HTMLButtonElement | null;
  assert.ok(trigger, `help button for ${label} exists`);
  focusSettingsHelp(trigger);
  const hostId = trigger!.getAttribute('aria-describedby')?.split(' ').at(-1);
  const host = hostId ? document.getElementById(hostId) : null;
  assert.ok(host, `focused ${label} help appears`);
  assert.ok(host.querySelector('.toolbar-settings-help-button') === null, 'help must expose copy directly, not another tooltip trigger');
  return host.textContent ?? '';
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, thinkingLevels: ['off'], inputKinds: ['text'] },
  { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], inputKinds: ['text', 'image'] },
  { id: 'opus', name: 'Opus', provider: 'anthropic', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], inputKinds: ['text', 'image'] },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'], inputKinds: ['text'] },
];

test('SubagentSection renders behavior and nesting controls without model buckets', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({}),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
    }),
  );

  // Inline container + the always-parent-model toggle.
  assert.match(html, /toolbar-settings-ext-settings/);
  assert.match(html, /Always use parent model</);
  assert.match(html, /Route around busy providers</);
  assert.match(html, /Fallback on provider failure</);
  assert.match(html, /aria-checked="true"[\s\S]*?Fallback on provider failure/);

  // Default provider section explains why it has no toggles until buckets are configured.
  assert.match(html, /Default providers</);
  assert.match(html, /No providers configured/);

  assert.doesNotMatch(html, /Low-cost busywork/);
  assert.doesNotMatch(html, /Choose model for Small bucket/);

  // Nesting + throughput controls.
  assert.match(html, /Nesting levels</);
  assert.match(html, /Tree session budget</);
  assert.match(html, /Max active trees</);
  assert.doesNotMatch(html, /Max concurrency</);
  assert.doesNotMatch(html, /Max parallel tasks</);
});

test('SubagentSection groups common controls under accessible content headings', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(SubagentBehaviorSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [],
          frontier: [],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
    }), container));

    const groups = [...container.querySelectorAll('.toolbar-settings-content-group')];
    const names = ['Model selection & routing', 'Tools', 'Delegation', 'Limits'];
    assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), names);
    for (const [index, group] of groups.entries()) {
      assert.equal(group.getAttribute('role'), 'group');
      assert.equal(group.querySelector('h3.toolbar-settings-content-group-title')?.textContent, names[index]);
    }
    const expectedCheckboxes = [
      ['Always use parent model', 'Route around busy providers', 'Fallback on provider failure', 'anthropic'],
      [],
      ['Allow Frontier', 'Allow Medium', 'Allow Small', 'Allow Frontier subagents to delegate', 'Allow Medium subagents to delegate', 'Allow Small subagents to delegate'],
      [],
    ];
    const expectedControlCounts = [4, 1, 6, 3];
    for (const [index, group] of groups.entries()) {
      assert.deepEqual([...group.querySelectorAll('[role="checkbox"]')].map((control) => control.textContent?.trim()), expectedCheckboxes[index]);
      const controls = [...group.querySelectorAll('[role="checkbox"], input[type="text"], input[type="range"]')];
      assert.equal(controls.length, expectedControlCounts[index], `${names[index]} control count`);
      for (const control of controls) {
        assert.ok(control.closest('.toolbar-settings-content-group') === group, `${control.getAttribute('aria-label') ?? control.textContent?.trim()} belongs to ${names[index]}`);
      }
    }
    assert.ok(groups[0].textContent?.includes('Default providers'));
    assert.ok(groups[1].querySelector('[aria-label="Add a tool name to drop for subagents"]'));
    assert.deepEqual([...groups[2].querySelectorAll('h4')].map((heading) => heading.textContent), ['Nested bucket allowlist', 'Delegation by bucket']);
    assert.deepEqual([...groups[3].querySelectorAll('input[type="range"]')].map((control) => control.getAttribute('aria-label')), [
      'Subagent nesting levels', 'Max subagent sessions across the nested tree', 'Max concurrent root subagent trees',
    ]);
    assert.ok(container.querySelector('details, [aria-expanded]') === null, 'common controls are not hidden in an accordion');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('Subagent explanations are available in keyboard-focused help tooltips', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentBuckets: { small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }], medium: [], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      providerGateStats: {
        enabled: true,
        providers: [],
        subagentConcurrency: {
          scope: 'worker-process',
          configured: { value: 6, source: 'environment-override' },
          workerCount: 3,
          pendingWorkers: 2,
        },
      },
    }), container));

    assert.match(await focusedTooltip(container, 'Route around busy providers'), /immediate ProviderGate slot; if none is available, use normal selection and queue/);
    assert.match(await focusedTooltip(container, 'Fallback on provider failure'), /before visible output or tool execution\. Work is never replayed/);
    assert.match(await focusedTooltip(container, 'Default providers'), /per-chat changes override it.*live model list is stale.*Add models to the buckets/);
    assert.match(await focusedTooltip(container, 'Nested bucket allowlist'), /disallowed requests downgrade to the highest allowed tier/);
    assert.match(await focusedTooltip(container, 'Delegation by bucket'), /disabled tiers become leaves and subagent-tool calls return an error/);
    assert.match(await focusedTooltip(container, 'Drop tools for subagents'), /explicit tools: lists and unrestricted agents/);
    assert.match(await focusedTooltip(container, 'Nesting levels'), /0 disables subagents/);
    assert.match(await focusedTooltip(container, 'Tree session budget'), /Caps the cost of deeper delegation/);
    const throughputHelp = await focusedTooltip(container, 'Throughput');
    assert.match(throughputHelp, /Sibling subagent calls run concurrently/);
    assert.match(throughputHelp, /Preference: 8 · Configured default/);
    assert.match(throughputHelp, /Runtime configured: 6 · Environment override/);
    assert.match(throughputHelp, /Applied: awaiting sync \(2 pending\)/);
    assert.match(throughputHelp, /Worker-process scope · 3 workers.*shared by sessions in that process/);
    assert.match(await focusedTooltip(container, 'Max active trees'), /not across all sessions or processes/);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.pie-tooltip-host').forEach((element) => element.remove());
  }
});

test('Subagent model bucket explanations are available through focused help', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));
    assert.match(await focusedTooltip(container, 'Small bucket models'), /Low-cost busywork.*Empty buckets use the parent model and its reasoning level/);
    assert.match(await focusedTooltip(container, 'Subagent model buckets'), /balanced random cycle.*Empty buckets fall back to the parent's active model/);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.pie-tooltip-host').forEach((element) => element.remove());
  }
});

test('SubagentSection distinguishes saved tree preference from pending worker-process acknowledgement', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentMaxInflight: 8, subagentMaxInflightSource: 'saved-preference' }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      providerGateStats: {
        enabled: true,
        providers: [],
        subagentConcurrency: {
          scope: 'worker-process',
          configured: { value: 6, source: 'environment-override' },
          effective: { value: 4, source: 'saved-preference' },
          workerCount: 3,
          pendingWorkers: 2,
        },
      },
    }),
  );

  assert.match(html, /toolbar-settings-runtime-status">Applied: 4 · Saved preference · 2 workers pending sync/);
  assert.match(html, /max="16"/);
});

test('SubagentSection reports unavailable runtime acknowledgement when metrics are absent', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentMaxInflight: 8 }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
    }),
  );

  assert.match(html, /toolbar-settings-runtime-status">Runtime unavailable</);
});

test('SubagentSection renders the nested-bucket allowlist toggles reflecting prefs', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
    }),
  );

  // The help trigger is present beside the subheading; explanation is tested through focusedTooltip.
  assert.match(html, /Nested bucket allowlist</);
  assert.match(html, /About Nested bucket allowlist/);
  // All three tier toggles render, highest tier first.
  assert.match(html, /Allow Frontier/);
  assert.match(html, /Allow Medium/);
  assert.match(html, /Allow Small/);
});

test('SubagentSection renders per-bucket delegation toggles reflecting prefs', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentBucketCanSpawn: { small: false, medium: false, frontier: true } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
    }),
  );

  assert.match(html, /Delegation by bucket</);
  assert.match(html, /About Delegation by bucket/);
  assert.match(html, /Allow Frontier subagents to delegate/);
  assert.match(html, /Allow Medium subagents to delegate/);
  assert.match(html, /Allow Small subagents to delegate/);
});

test('SubagentSection allows unchecking every default provider (no last-enabled lock)', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentBehaviorSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [],
          frontier: [],
        },
        subagentProviderDefaults: {},
      }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
    }), container));

    // The only enabled provider renders enabled AND clickable: the effective
    // all-unchecked policy is allowed (it removes the subagent tool).
    const toggle = [...container.querySelectorAll('.toolbar-settings-item')]
      .find((item) => item.textContent?.trim() === 'anthropic') as HTMLButtonElement | null;
    assert.ok(toggle, 'anthropic default toggle rendered');
    assert.equal(toggle!.disabled, false, 'the last enabled provider stays uncheckable-free');
    assert.equal(toggle!.title, '', 'no last-enabled guard hint');
    assert.doesNotMatch(document.body.innerHTML, /At least one subagent provider/);

    act(() => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentProviderDefaults, { anthropic: false });
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('SubagentSection renders default toggles only for providers used by subagent buckets', () => {
  const html = renderToString(
    h(SubagentBehaviorSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [{ model: 'openai/gpt-5', thinkingLevel: 'medium' }],
          frontier: [],
        },
        subagentProviderDefaults: { anthropic: false },
      }),
      onSetPrefs: () => undefined,
      availableModels: [
        ...AVAILABLE_MODELS,
        { id: 'gemini', name: 'Gemini', provider: 'google', reasoning: true, inputKinds: ['text'] },
      ],
    }),
  );

  const defaultsStart = html.indexOf('Default providers');
  const defaultsEnd = html.indexOf('aria-label="Tools"');
  const defaultsHtml = html.slice(defaultsStart, defaultsEnd);
  assert.match(defaultsHtml, />anthropic</);
  assert.match(defaultsHtml, />openai</);
  assert.doesNotMatch(defaultsHtml, />google</);
  assert.match(defaultsHtml, /aria-checked="false"/);
});

test('SubagentSection renders selected bucket models as chips labelled with model names', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'high' }],
          frontier: [{ model: 'anthropic/opus', thinkingLevel: 'max' }],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Each selected model renders as a chip labelled with its display name.
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Haiku</);
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Sonnet</);
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Opus</);
  // Each selected assignment exposes its current reasoning level.
  assert.match(html, /aria-label="Reasoning for anthropic · Sonnet in Medium"/);
  assert.match(html, /aria-label="Reasoning for anthropic · Opus in Frontier"/);
  assert.match(html, /X-High/);
  assert.match(html, /Max/);
  // All buckets populated → no empty-bucket warnings.
  assert.doesNotMatch(html, /Uses parent model/);
});

test('SubagentSection only offers reasoning levels supported by each model', () => {
  assert.deepEqual(getModelThinkingLevels(AVAILABLE_MODELS[0]), ['off']);
  assert.deepEqual(getModelThinkingLevels(AVAILABLE_MODELS[1]), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(getModelThinkingLevels(AVAILABLE_MODELS[2]), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(getModelThinkingLevels(AVAILABLE_MODELS[3]), ['off', 'minimal', 'low', 'medium', 'high', 'max']);
});

test('SubagentSection add-model selects list only models not already in their bucket', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [],
          frontier: [],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // The "small" bucket already has haiku; the medium/frontier buckets are empty
  // so every model is selectable there. At minimum the add-model options exist.
  assert.match(html, /Add model…/);
  // Every bucket uses the shared searchable model picker.
  assert.match(html, /aria-label="Choose model for Small bucket"/);
  // The two empty buckets (medium, frontier) each show an empty-bucket warning;
  // the populated small bucket does not.
  const inheritCount = (html.match(/Uses parent model/g) ?? []).length;
  assert.equal(inheritCount, 2);
});

test('SubagentSection renders an empty-bucket warning per empty bucket', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // No chips when nothing is selected, but each bucket still offers "Add model…".
  const addCount = (html.match(/Add model…/g) ?? []).length;
  assert.equal(addCount, 3);
  assert.doesNotMatch(html, /toolbar-settings-keep-chips/);
  // Each empty bucket has a concise inheritance state; the full explanation is in focused help.
  const inheritCount = (html.match(/toolbar-settings-bucket-inherit/g) ?? []).length;
  assert.equal(inheritCount, 3);
  assert.match(html, /Uses parent model/);
  assert.doesNotMatch(html, /No assignments/);
});

test('SubagentSection does not warn for a bucket that has models', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
          medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
          frontier: [],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Only the empty frontier bucket shows inheritance state.
  const inheritCount = (html.match(/toolbar-settings-bucket-inherit/g) ?? []).length;
  assert.equal(inheritCount, 1);
});

test('SubagentSection add-model options exclude disabled-provider models (ComposerSettingsMenu composition)', () => {
  // Mirror what ComposerSettingsMenu does: filter availableModels by enabled
  // providers, then order for the picker. The full availableModels list is still
  // passed for chip label resolution.
  const prefs = prefsWith({ providerToggles: { anthropic: false } });
  const enabledEntries = orderModelsForPicker(filterEnabledProviders(AVAILABLE_MODELS, prefs.providerToggles));
  const html = renderToString(
    h(SubagentSection, {
      prefs,
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: enabledEntries,
    }),
  );

  // The filtered entry list still leaves the shared picker enabled for GPT-5.
  assert.match(html, /aria-label="Choose model for Small bucket"/);
  assert.doesNotMatch(html, /aria-label="Choose model for Small bucket"[^>]*disabled/);
  assert.doesNotMatch(html, /toolbar-settings-bucket-add-row/);
});

test('SubagentSection selects a default reasoning level and adds with one click', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel);
    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null, 'no add row before picking a model');

    act(() => { chooseModel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Sonnet'));
    assert.ok(modelRow, 'Sonnet should be available in the model step');
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // The add row appears with reasoning pills pre-selected to the default.
    const addRow = container.querySelector('.toolbar-settings-bucket-add-row');
    assert.ok(addRow, 'add row should appear after picking a model');
    const selectedLevel = addRow!.querySelector('.toolbar-settings-bucket-level.selected') as HTMLButtonElement | null;
    assert.ok(selectedLevel, 'a default reasoning level should be pre-selected');
    assert.equal(selectedLevel!.textContent?.trim(), 'Medium');

    const add = [...addRow!.querySelectorAll('button')].find((button) => button.textContent?.includes('Add')) as HTMLButtonElement | undefined;
    assert.ok(add);
    assert.equal(add!.disabled, false, 'pre-selected reasoning enables the add button');

    // The user can change to a different reasoning level before adding.
    const xhigh = [...addRow!.querySelectorAll('.toolbar-settings-bucket-level')]
      .find((button) => button.textContent?.trim() === 'X-High') as HTMLButtonElement | undefined;
    assert.ok(xhigh);
    act(() => { xhigh!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(addRow!.querySelector('.toolbar-settings-bucket-level.selected')?.textContent?.trim(), 'X-High');

    act(() => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.small, [{ model: 'anthropic/sonnet', thinkingLevel: 'xhigh' }]);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

function withPendingBucket(run: (ui: {
  container: HTMLDivElement;
  calls: Partial<ChatPrefs>[];
  rerender: (prefs: ChatPrefs, models?: ModelInfo[], entries?: ReturnType<typeof orderModelsForPicker>) => void;
  pick: (name: string) => void;
}) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  const rerender = (prefs: ChatPrefs, models = AVAILABLE_MODELS, entries?: ReturnType<typeof orderModelsForPicker>) => {
    render(h(SubagentSection, { prefs, availableModels: models, modelEntries: entries, onSetPrefs: (patch) => calls.push(patch) }), container);
  };
  const pick = (name: string) => {
    act(() => { (container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement).click(); });
    const row = [...document.querySelectorAll('.model-picker-row')].find((entry) =>
      entry.textContent?.includes(name) || entry.getAttribute('aria-label')?.includes(name));
    assert.ok(row);
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  try {
    act(() => rerender(prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } })));
    run({ container, calls, rerender, pick });
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
}

const emptyBucketPrefs = () => prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } });

test('pending bucket add cancels when its provider is disabled and restores only usable picker focus', () => {
  withPendingBucket(({ container, calls, rerender, pick }) => {
    pick('Sonnet');
    act(() => {
      rerender({ ...emptyBucketPrefs(), providerToggles: { anthropic: false } });
      // Confirm before passive reconciliation runs, bypassing the disabled
      // button's native click suppression to exercise the handler guard too.
      container.querySelector('.toolbar-settings-bucket-add-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(calls.length, 0);
    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null);
    const trigger = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement;
    assert.ok(document.activeElement === trigger);
    pick('GPT-5');
    act(() => rerender({ ...emptyBucketPrefs(), providerToggles: { anthropic: false, openai: false } }));
    const disabledTrigger = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement;
    assert.equal(disabledTrigger.disabled, true);
    assert.ok(document.activeElement !== disabledTrigger);
    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null);
    assert.equal(calls.length, 0);
  });
});

test('pending bucket add uses current picker capability metadata and preserves supported user choice', () => {
  withPendingBucket(({ container, calls, rerender, pick }) => {
    pick('Sonnet');
    const high = [...container.querySelectorAll('.toolbar-settings-bucket-level')].find((pill) => pill.textContent === 'High') as HTMLButtonElement;
    act(() => high.click());
    act(() => rerender({ ...emptyBucketPrefs(), subagentMaxDepth: 3 }, [...AVAILABLE_MODELS], orderModelsForPicker([...AVAILABLE_MODELS])));
    assert.equal(container.querySelector('.toolbar-settings-bucket-level.selected')?.textContent, 'High');
    // The picker snapshot is authoritative, even if the full label catalog is stale.
    const updated = AVAILABLE_MODELS.map((model) => model.id === 'sonnet' ? { ...model, thinkingLevels: ['low'] as ModelInfo['thinkingLevels'] } : model);
    act(() => {
      rerender(emptyBucketPrefs(), AVAILABLE_MODELS, orderModelsForPicker(updated));
      container.querySelector('.toolbar-settings-bucket-add-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      container.querySelector('.toolbar-settings-bucket-add-row')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(calls.length, 0, 'removed reasoning level cannot be assigned before effects run');
    assert.equal(container.querySelector('.toolbar-settings-bucket-level.selected')?.textContent, 'Low');
    act(() => { (container.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement).click(); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.small, [{ model: 'anthropic/sonnet', thinkingLevel: 'low' }]);
  });
});

for (const spec of ['sonnet', 'anthropic/sonnet']) {
  test(`pending bucket cancels newly selected duplicate ${spec} using catalog identity semantics`, () => {
    withPendingBucket(({ container, calls, rerender, pick }) => {
      pick('Sonnet');
      act(() => {
        rerender(prefsWith({ subagentBuckets: { small: [{ model: spec, thinkingLevel: 'high' }], medium: [], frontier: [] } }));
        container.querySelector('.toolbar-settings-bucket-add-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      assert.equal(calls.length, 0);
      assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null);
    });
  });
}

test('pending bucket preserves provider-disambiguated choice beside an ambiguous legacy id', () => {
  withPendingBucket(({ container, calls, rerender, pick }) => {
    const models = [...AVAILABLE_MODELS, { ...AVAILABLE_MODELS[1], provider: 'other', name: 'Other Sonnet' }];
    act(() => rerender(emptyBucketPrefs(), models));
    pick('anthropic/sonnet');
    act(() => rerender(prefsWith({ subagentBuckets: { small: [{ model: 'sonnet', thinkingLevel: 'high' }], medium: [], frontier: [] } }), models));
    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row'));
    act(() => { (container.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement).click(); });
    assert.ok(calls.at(-1)?.subagentBuckets?.small?.some((entry) => entry.model === 'anthropic/sonnet' && entry.thinkingLevel === 'medium'));
  });
});

test('SubagentSection can cancel the pending model with the cancel button', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel);
    act(() => { chooseModel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Haiku'));
    assert.ok(modelRow);
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const cancel = container.querySelector('[aria-label="Cancel adding model"]') as HTMLButtonElement | null;
    assert.ok(cancel);
    act(() => { cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null);
    assert.equal(calls.length, 0, 'cancelling should not emit a pref change');
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

test('SubagentSection preselects Off as the default for non-reasoning models', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel);
    act(() => { chooseModel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Haiku'));
    assert.ok(modelRow);
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const addRow = container.querySelector('.toolbar-settings-bucket-add-row');
    assert.ok(addRow);
    assert.equal(addRow!.querySelector('.toolbar-settings-bucket-level.selected')?.textContent?.trim(), 'Off');

    const add = [...addRow!.querySelectorAll('button')].find((button) => button.textContent?.includes('Add')) as HTMLButtonElement | undefined;
    assert.ok(add);
    act(() => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.small, [{ model: 'anthropic/haiku', thinkingLevel: 'off' }]);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

test('SubagentSection keeps same-id models from different providers as distinct bucket chips', () => {
  const duplicateModels: ModelInfo[] = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 SOL', provider: 'github-copilot', reasoning: true, inputKinds: ['text'] },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 SOL', provider: 'openai-codex', reasoning: true, inputKinds: ['text'] },
  ];
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [],
          medium: [
            { model: 'github-copilot/gpt-5.6-sol', thinkingLevel: 'high' },
            { model: 'openai-codex/gpt-5.6-sol', thinkingLevel: 'high' },
          ],
          frontier: [],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: duplicateModels,
      modelEntries: orderModelsForPicker(duplicateModels),
    }),
  );

  assert.match(html, /github-copilot · GPT-5\.6 SOL/);
  assert.match(html, /openai-codex · GPT-5\.6 SOL/);
  assert.match(html, /Remove github-copilot · GPT-5\.6 SOL from Medium/);
  assert.match(html, /Remove openai-codex · GPT-5\.6 SOL from Medium/);
});

test('SubagentSection labels provider-qualified assignments with their provider', () => {
  const duplicateModels: ModelInfo[] = [
    { id: 'shared', name: 'Copilot Shared', provider: 'github-copilot', reasoning: true, inputKinds: ['text'] },
    { id: 'shared', name: 'Codex Shared', provider: 'openai-codex', reasoning: true, inputKinds: ['text'] },
  ];
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [],
          medium: [],
          frontier: [{ model: 'github-copilot/shared', thinkingLevel: 'high' }],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: duplicateModels,
      modelEntries: orderModelsForPicker(duplicateModels),
    }),
  );

  assert.match(html, /github-copilot · Copilot Shared/);
  assert.doesNotMatch(html, /Any enabled provider · shared \(legacy\)/);
  assert.doesNotMatch(html, /openai-codex · Codex Shared/);
});

test('SubagentSection still labels a selected bucket chip whose provider is disabled (via full availableModels)', () => {
  // haiku's provider (anthropic) is disabled, but it's already in the bucket.
  // The chip should still render its display name (resolved from the full
  // availableModels list), so the user can see and remove it.
  const prefs = prefsWith({
    providerToggles: { anthropic: false },
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    },
  });
  const enabledEntries = orderModelsForPicker(filterEnabledProviders(AVAILABLE_MODELS, prefs.providerToggles));
  const html = renderToString(
    h(SubagentSection, {
      prefs,
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: enabledEntries,
    }),
  );

  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Haiku</);
  // And it is no longer offered as an addable option.
  assert.doesNotMatch(html, /<option[^>]*value="haiku"/);
});

test('explicit removal hides persisted default toggles and keeps bucket selections visibly unavailable', () => {
  const prefs = prefsWith({
    subagentBuckets: { small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }], medium: [], frontier: [] },
    subagentProviderDefaults: { anthropic: true },
  });
  const props = { prefs, availableModels: AVAILABLE_MODELS, removedProviderIds: ['anthropic'], onSetPrefs: () => assert.fail('render must not rewrite saved preferences') };
  const buckets = renderToString(h(SubagentSection, props));
  assert.match(buckets, /anthropic\/haiku · Unavailable \(removed provider\)/);
  assert.doesNotMatch(buckets, /aria-label="Reasoning for anthropic\/haiku/);
  const defaults = renderToString(h(SubagentBehaviorSection, props));
  assert.doesNotMatch(defaults, /anthropic/);
  assert.equal(prefs.subagentProviderDefaults.anthropic, true);
});

test('SubagentSection can remove and edit reasoning on existing bucket assignments', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [],
          medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
          frontier: [],
        },
      }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    // Change the reasoning level on the existing chip.
    const reasoningSelect = container.querySelector('select[aria-label="Reasoning for anthropic · Sonnet in Medium"]') as HTMLSelectElement | null;
    assert.ok(reasoningSelect);
    act(() => {
      reasoningSelect!.value = 'low';
      reasoningSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.medium, [{ model: 'anthropic/sonnet', thinkingLevel: 'low' }]);

    // Remove the assignment.
    const removeBtn = container.querySelector('[aria-label="Remove anthropic · Sonnet from Medium"]') as HTMLButtonElement | null;
    assert.ok(removeBtn);
    act(() => { removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.medium, []);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

test('SubagentSection preserves persisted reasoning levels for models no longer in the catalog', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: {
          small: [{ model: 'anthropic/retired', thinkingLevel: 'high' }],
          medium: [],
          frontier: [],
        },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // The chip label falls back to the raw spec, but the persisted reasoning
  // level is still offered in the chip's select.
  assert.match(html, /anthropic\/retired/);
  assert.match(html, /value="high"/);
  assert.match(html, /High/);
});

test('SubagentSection handles keyboard focus and Enter/Escape in the add row', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel);
    act(() => { chooseModel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Sonnet'));
    assert.ok(modelRow);
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Focus moves to the Add button once a model is selected.
    const addBtn = container.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement | null;
    assert.ok(addBtn);
    assert.ok(document.activeElement === addBtn, 'Add button should receive focus after picking a model');

    // In a real browser, pressing Enter on the focused Add button fires its
    // click handler. jsdom does not synthesize that click, so dispatch both
    // events to verify the button is ready to confirm the assignment.
    act(() => { addBtn!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    act(() => { addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.small, [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }]);

    // Re-open the picker and select a model again to test Escape.
    const chooseModel2 = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel2);
    act(() => { chooseModel2!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow2 = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Haiku'));
    assert.ok(modelRow2);
    act(() => { modelRow2!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Escape on the add row cancels without emitting a pref change.
    const beforeCount = calls.length;
    const addRow = container.querySelector('.toolbar-settings-bucket-add-row');
    assert.ok(addRow);
    act(() => { addRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(calls.length, beforeCount, 'Escape should not emit a pref change');
    assert.ok(container.querySelector('.toolbar-settings-bucket-add-row') === null);
    // Focus returns to the picker trigger.
    const trigger = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(document.activeElement === trigger, 'focus should return to the picker trigger after cancel');
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

test('SubagentSection Enter on reasoning pill selects that level instead of adding', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement | null;
    assert.ok(chooseModel);
    act(() => { chooseModel!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Sonnet'));
    assert.ok(modelRow);
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Focus a reasoning pill and click it: it should select that level, not add.
    const addRow = container.querySelector('.toolbar-settings-bucket-add-row');
    assert.ok(addRow);
    const xhigh = [...addRow!.querySelectorAll('.toolbar-settings-bucket-level')]
      .find((button) => button.textContent?.trim() === 'X-High') as HTMLButtonElement | undefined;
    assert.ok(xhigh);
    act(() => { xhigh!.focus(); });
    act(() => { xhigh!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(addRow!.querySelector('.toolbar-settings-bucket-level.selected')?.textContent?.trim(), 'X-High');
    assert.equal(calls.length, 0, 'clicking a reasoning pill should not add the model');

    // Pressing Enter on the wrapper background (non-interactive target) now adds.
    act(() => { addRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    assert.deepEqual(calls.at(-1)?.subagentBuckets?.small, [{ model: 'anthropic/sonnet', thinkingLevel: 'xhigh' }]);
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});

test('DropToolsEditor accumulates rapid edits as intents instead of stale host selections', () => {
  // The host echo round-trips through snapshots; the editor must read the
  // previous intent, not the stale `selected` prop, when a burst of edits
  // lands before any echo. Echoes here follow the host's monotonic in-order
  // contract only.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  const renderPrefs = (dropTools: string[]) => {
    act(() => render(h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentDropTools: dropTools }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
    }), container));
  };
  const typeTool = (name: string) => {
    act(() => {
      const input = container.querySelector<HTMLInputElement>('[aria-label="Add a tool name to drop for subagents"]')!;
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector<HTMLInputElement>('[aria-label="Add a tool name to drop for subagents"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  };
  const removeTool = (name: string) => {
    act(() => {
      const button = [...container.querySelectorAll('.toolbar-settings-keep-chip-remove')]
        .find((candidate) => (candidate as HTMLElement).getAttribute('aria-label') === `Stop dropping ${name}`);
      assert.ok(button, `remove chip for ${name} exists`);
      (button as HTMLElement).click();
    });
  };
  const chips = () => [...container.querySelectorAll('.toolbar-settings-keep-chip > span')].map((chip) => chip.textContent);
  try {
    renderPrefs([]);
    typeTool('ask_user');
    typeTool('mcp');
    assert.deepEqual(calls, [
      { subagentDropTools: ['ask_user'] },
      { subagentDropTools: ['ask_user', 'mcp'] },
    ], 'the second rapid add keeps the first intent');

    // Delayed in-order echo of the first commit: the newer intent still leads.
    renderPrefs(['ask_user']);
    assert.deepEqual(chips(), ['ask_user', 'mcp']);

    removeTool('ask_user');
    assert.deepEqual(calls.at(-1)?.subagentDropTools, ['mcp']);
    assert.deepEqual(chips(), ['mcp']);

    // Converge on the echoed results in order.
    renderPrefs(['ask_user', 'mcp']);
    assert.deepEqual(chips(), ['mcp']);
    renderPrefs(['mcp']);
    assert.deepEqual(chips(), ['mcp']);

    // Duplicates are guarded against the optimistic selection.
    typeTool('mcp');
    assert.equal(calls.length, 3, 'no duplicate emit');
    assert.deepEqual(chips(), ['mcp']);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('DropToolsEditor projects an external echo that matches no local edit', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  const renderPrefs = (dropTools: string[]) => {
    act(() => render(h(SubagentBehaviorSection, {
      prefs: prefsWith({ subagentDropTools: dropTools }),
      onSetPrefs: (patch) => calls.push(patch),
      availableModels: AVAILABLE_MODELS,
    }), container));
  };
  try {
    renderPrefs([]);
    act(() => {
      const input = container.querySelector<HTMLInputElement>('[aria-label="Add a tool name to drop for subagents"]')!;
      input.value = 'ask_user';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector<HTMLInputElement>('[aria-label="Add a tool name to drop for subagents"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(calls, [{ subagentDropTools: ['ask_user'] }]);

    // Authoritative external (or rejected) value: matches no local commit.
    renderPrefs(['other_tool']);
    const chips = [...container.querySelectorAll('.toolbar-settings-keep-chip > span')].map((chip) => chip.textContent);
    assert.deepEqual(chips, ['other_tool'], 'host truth is projected');
    renderPrefs(['other_tool']);
    assert.deepEqual(
      [...container.querySelectorAll('.toolbar-settings-keep-chip > span')].map((chip) => chip.textContent),
      ['other_tool'],
      'stable after projecting',
    );
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('reasoning pill changes keep focus after the one-time add-row handoff', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }), container));

    const chooseModel = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement;
    act(() => { chooseModel.click(); });
    const modelRow = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Sonnet'));
    act(() => { modelRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Initial handoff: the Add button receives focus once the add row appears.
    const addBtn = container.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement;
    assert.ok(document.activeElement === addBtn, 'Add button is focused on initial model selection');

    // Clicking reasoning pills must not re-steal focus each change.
    const high = [...container.querySelectorAll('.toolbar-settings-bucket-level')]
      .find((button) => button.textContent?.trim() === 'High') as HTMLButtonElement;
    act(() => { high.focus(); high.click(); });
    assert.equal(container.querySelector('.toolbar-settings-bucket-level.selected')?.textContent?.trim(), 'High');
    assert.ok(document.activeElement === high, 'reasoning focus stays on the pill');
    const xhigh = [...container.querySelectorAll('.toolbar-settings-bucket-level')]
      .find((button) => button.textContent?.trim() === 'X-High') as HTMLButtonElement;
    act(() => { xhigh.click(); });
    assert.equal(container.querySelector('.toolbar-settings-bucket-level.selected')?.textContent?.trim(), 'X-High');
    assert.ok(document.activeElement === high, 'focus is not stolen per change');

    // Handoff is one-shot per pending model: reselecting a model re-fires it.
    const cancel = container.querySelector('[aria-label="Cancel adding model"]') as HTMLButtonElement;
    act(() => { cancel.click(); });
    const chooseModel2 = container.querySelector('[aria-label="Choose model for Small bucket"]') as HTMLButtonElement;
    act(() => { chooseModel2.click(); });
    const modelRow2 = [...document.querySelectorAll('.model-picker-row')]
      .find((row) => row.textContent?.includes('Haiku'));
    act(() => { modelRow2!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const addBtn2 = container.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement;
    assert.ok(document.activeElement === addBtn2, 'handoff re-fires for the next pending model');
  } finally {
    act(() => render(null, container));
    container.remove();
    document.querySelectorAll('.model-picker-dropdown').forEach((element) => element.remove());
  }
});
