import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { SubagentSection } from '../../../src/webview/panel/composer/settings-menu-subcomponents';
import { filterEnabledProviders, orderModelsForPicker } from '../../../src/webview/panel/composer/model-list';
import { DEFAULT_CHAT_PREFS } from '../../../src/shared/protocol';
import type { ChatPrefs, ModelInfo } from '../../../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, inputKinds: ['text'] },
  { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', reasoning: true, inputKinds: ['text', 'image'] },
  { id: 'opus', name: 'Opus', provider: 'anthropic', reasoning: true, inputKinds: ['text', 'image'] },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, inputKinds: ['text'] },
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
        subagentBuckets: { small: ['haiku'], medium: ['gpt-5'], frontier: [] },
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
        subagentBuckets: { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] },
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
  // All buckets populated → no empty-bucket warnings.
  assert.doesNotMatch(html, /falls back to the parent model/);
});

test('SubagentSection add-model selects list only models not already in their bucket', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({
        subagentBuckets: { small: ['haiku'], medium: [], frontier: [] },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // The "small" bucket already has haiku; the medium/frontier buckets are empty
  // so every model is selectable there. At minimum the add-model options exist.
  assert.match(html, /Add model…</);
  // GPT-5 is never selected, so it must appear as an addable option.
  // (The option label is now provider-prefixed: "openai · GPT-5".)
  assert.match(html, /<option[^>]*value="gpt-5"[^>]*>[^<]*GPT-5</);
  // The two empty buckets (medium, frontier) each show an empty-bucket warning;
  // the populated small bucket does not.
  const warnCount = (html.match(/falls back to the parent model/g) ?? []).length;
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
  assert.match(html, /No models — falls back to the parent model/);
});

test('SubagentSection does not warn for a bucket that has models', () => {
  const html = renderToString(
    h(SubagentSection, {
      prefs: prefsWith({ subagentBuckets: { small: ['haiku'], medium: ['sonnet'], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Only the empty frontier bucket warns.
  const warnCount = (html.match(/falls back to the parent model/g) ?? []).length;
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

  // anthropic models (haiku, sonnet, opus) must not be offered as addable options.
  assert.doesNotMatch(html, /<option[^>]*value="haiku"/);
  assert.doesNotMatch(html, /<option[^>]*value="sonnet"/);
  assert.doesNotMatch(html, /<option[^>]*value="opus"/);
  // The openai model (gpt-5) is still addable.
  assert.match(html, /<option[^>]*value="gpt-5"/);
});

test('SubagentSection still labels a selected bucket chip whose provider is disabled (via full availableModels)', () => {
  // haiku's provider (anthropic) is disabled, but it's already in the bucket.
  // The chip should still render its display name (resolved from the full
  // availableModels list), so the user can see and remove it.
  const prefs = prefsWith({
    providerToggles: { anthropic: false },
    subagentBuckets: { small: ['haiku'], medium: [], frontier: [] },
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
