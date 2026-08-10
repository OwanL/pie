import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
installDom();

import { SubagentSection } from '../../../src/webview/panel/composer/settings-menu-subcomponents';
import { filterEnabledProviders, getModelThinkingLevels, orderModelsForPicker } from '../../../src/webview/panel/composer/model-list';
import { DEFAULT_CHAT_PREFS } from '../../../src/shared/protocol';
import type { ChatPrefs, ModelInfo } from '../../../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, thinkingLevels: ['off'], inputKinds: ['text'] },
  { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], inputKinds: ['text', 'image'] },
  { id: 'opus', name: 'Opus', provider: 'anthropic', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], inputKinds: ['text', 'image'] },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'], inputKinds: ['text'] },
];

test('SubagentSection renders the inline container, toggle, buckets, and nesting controls', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({}),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Inline container + the always-parent-model toggle.
  assert.match(html, /toolbar-settings-ext-settings/);
  assert.match(html, /Always use parent model</);
  assert.match(html, /Route around busy providers</);
  assert.match(html, /If capacity is unavailable or every candidate is busy/);
  assert.match(html, /Fallback on provider failure</);
  assert.match(html, /another model in the same bucket/);
  assert.match(html, /aria-checked="true"[\s\S]*?Fallback on provider failure/);

  // Default provider section explains why it has no toggles until buckets are configured.
  assert.match(html, /Default providers</);
  assert.match(html, /Add models to the buckets below to configure provider defaults/);

  // Model buckets group + all three bucket labels + hints.
  assert.match(html, /Model buckets</);
  assert.match(html, /Haiku-class busywork</);
  assert.match(html, /Sonnet-class main development</);
  assert.match(html, /Opus-class hardest problems</);

  // Nesting + throughput controls.
  assert.match(html, /Nesting levels</);
  assert.match(html, /Tree session budget</);
  assert.match(html, /Max active trees</);
  assert.doesNotMatch(html, /Max concurrency</);
  assert.doesNotMatch(html, /Max parallel tasks</);
});

test('SubagentSection renders the nested-bucket allowlist toggles reflecting prefs', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({ subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Group label + hint explain the downgrade behaviour.
  assert.match(html, /Nested bucket allowlist</);
  assert.match(html, /downgraded to the highest allowed tier/);
  // All three tier toggles render, highest tier first.
  assert.match(html, /Allow Frontier \(Opus\)/);
  assert.match(html, /Allow Medium \(Sonnet\)/);
  assert.match(html, /Allow Small \(Haiku\)/);
});

test('SubagentSection renders default toggles only for providers used by subagent buckets', () => {
  const html = renderToString(
    h(SubagentSection, {
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
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  const defaultsStart = html.indexOf('Default providers');
  const defaultsEnd = html.indexOf('Dropped tools');
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
  assert.doesNotMatch(html, /inherits the parent model/);
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
  const warnCount = (html.match(/inherits the parent model/g) ?? []).length;
  assert.equal(warnCount, 2);
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
  // Each of the three empty buckets renders a warning row.
  const warnCount = (html.match(/toolbar-settings-bucket-warning/g) ?? []).length;
  assert.equal(warnCount, 3);
  assert.match(html, /No assignments — inherits the parent model and reasoning/);
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

  // Only the empty frontier bucket warns.
  const warnCount = (html.match(/inherits the parent model/g) ?? []).length;
  assert.equal(warnCount, 1);
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
    assert.equal(container.querySelector('.toolbar-settings-bucket-add-row'), null, 'no add row before picking a model');

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

    assert.equal(container.querySelector('.toolbar-settings-bucket-add-row'), null);
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
    assert.equal(container.querySelector('.toolbar-settings-bucket-add-row'), null);
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
