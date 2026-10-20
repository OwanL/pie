import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
installDom();
import renderToString from 'preact-render-to-string';
import { ComposerToolbar } from '../../composer/toolbar';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_SESSION_TITLES_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';

function catalog(status: 'loading' | 'provisional' | 'authoritative' | 'error', selectedModel = '', overrides: Partial<Parameters<typeof ComposerToolbar>[0]> = {}) {
  return h(ComposerToolbar, {
    sessionPath: '__pending__:1', canCompact: false, prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS, pruningCatalog: { skills: [], tools: [] }, pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS, onSetPrefs: () => {},
    mcpServers: [], mcpPendingApply: false, onMcpListRequested: () => {}, onMcpSetServerEnabled: () => {},
    mcpSessionServers: [], mcpSessionPendingApply: false, onMcpSetServerEnabledForSession: () => {},
    onSetSystemPromptToggles: () => {}, onSetPruningSettings: () => {}, onSetToolResultPruningSettings: () => {}, onSetSessionTitlesSettings: () => {},
    availableExtensions: [], availableModels: [], availableModelsStatus: status, systemPrompts: [],
    selectedModel, selectedProvider: 'draft-provider', selectedLevel: 'high', supportsReasoning: false,
    contextIndicator: null, contextBreakdown: null, sessionCostIndicator: null, tokenRateIndicator: { label: '', ariaLabel: '', tooltip: '', state: 'idle', paused: false },
    workingTimeIndicator: { label: '', ariaLabel: '', tooltip: '' }, runStatus: { text: '', tone: 'open', title: '' }, compacting: false, lastCompaction: null,
    onModelChange: () => {}, onCompact: () => {}, ...overrides,
  });
}

function renderCatalog(...args: Parameters<typeof catalog>) {
  return renderToString(catalog(...args));
}

test('empty current-session discovery shows loading and offers no model selector', () => {
  for (const status of ['loading', 'provisional'] as const) {
    const html = renderCatalog(status, 'draft-model');
    assert.match(html, /Loading models/);
    assert.match(html, />draft-model</);
    assert.doesNotMatch(html, /draft-model — Loading/);
    assert.doesNotMatch(html, /aria-label="Model"/);
  }
});

test('authoritative empty catalog shows no models rather than loading or choices', () => {
  const html = renderCatalog('authoritative');
  assert.match(html, /No models available/);
  assert.doesNotMatch(html, /Loading models|aria-label="Model"/);
});

test('removed selected provider is explicitly unavailable with empty and remaining catalogs', () => {
  const removedManagement = {
    view: { mode: 'management' as const, providers: [], protocols: [], draft: null, status: 'idle' as const, removedProviderIds: ['draft-provider'] },
    onCommand: () => {},
  };
  const catalogs: NonNullable<Parameters<typeof ComposerToolbar>[0]['availableModels']>[] = [
    [],
    [{ id: 'available', name: 'Available', provider: 'other-provider', reasoning: false, inputKinds: ['text'] }],
  ];
  for (const availableModels of catalogs) {
    const html = renderCatalog('authoritative', 'astra', {
      availableModels,
      providerManagement: removedManagement,
      selectedProvider: 'draft-provider',
    });
    assert.match(html, /Unavailable \(removed provider\)/);
    assert.doesNotMatch(html, /aria-label="Retry loading the model catalog"/);
    if (availableModels.length > 0) {
      assert.match(html, /aria-label="Model"/);
      assert.doesNotMatch(html, /GPT-6 Astra/);
    } else {
      assert.doesNotMatch(html, /aria-label="Model"/);
    }
  }
});

test('failed catalog discovery renders an interactive retry affordance, not loading or choices', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    let retries = 0;
    act(() => render(catalog('error', '', {
      onRetryModelCatalog: () => { retries += 1; },
    }), container));
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry loading the model catalog"]');
    assert.ok(retry, 'the failed catalog must offer a retry affordance');
    assert.match(retry.textContent ?? '', /Models unavailable — Retry/u);
    assert.equal(container.querySelector('[aria-label="Model"]'), null);
    act(() => retry!.click());
    assert.equal(retries, 1);

    // A last good catalog keeps the working picker; failure never clears it.
    act(() => render(catalog('error', 'astra', {
      availableModels: models, onRetryModelCatalog: () => { retries += 1; },
    }), container));
    assert.ok(container.querySelector('[aria-label="Model"]'));
    assert.equal(container.querySelector('[aria-label="Retry loading the model catalog"]'), null);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

const models = [
  { id: 'astra', name: 'Provider: GPT-6 Astra', provider: 'draft-provider', reasoning: false, inputKinds: ['text'] },
  { id: 'other', name: 'Other', provider: 'draft-provider', reasoning: false, inputKinds: ['text'] },
] as Parameters<typeof ComposerToolbar>[0]['availableModels'];

test('loading existing catalog keeps concise label and selectable models, with mutation guards intact', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const changes: string[] = [];
  try {
    for (const status of ['authoritative', 'loading', 'provisional'] as const) {
      act(() => render(catalog(status, 'astra', {
        availableModels: models, onModelChange: (id) => changes.push(id),
      }), container));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
      assert.equal(trigger.textContent, 'GPT-6 Astra');
      assert.equal(trigger.disabled, false);
      act(() => trigger.click());
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.getAttribute('aria-disabled') !== 'true'));
      act(() => rows.find(row => row.textContent?.includes('Other'))!.click());
    }
    assert.deepEqual(changes, ['other', 'other', 'other']);
    act(() => render(catalog('loading', 'astra', { availableModels: models, commandsAvailable: false }), container));
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.disabled, true);
    assert.equal(document.querySelector('[role="listbox"]'), null);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('empty loading catalog retains only the matching concise label, never stale choices', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(catalog('authoritative', 'astra', { availableModels: models }), container));
    act(() => render(catalog('loading', 'astra'), container));
    assert.equal(container.querySelector('.panel-chip-label')!.textContent, 'GPT-6 Astra');
    assert.equal(container.querySelector('[aria-label="Model"]'), null);
    act(() => render(catalog('loading', 'astra', { selectedProvider: 'different-provider' }), container));
    assert.equal(container.querySelector('.panel-chip-label')!.textContent, 'astra');
    act(() => render(catalog('loading'), container));
    assert.equal(container.querySelector('.panel-chip-label')!.textContent, 'Loading models…');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('empty loading catalog does not retain a label across sessions with the same bare model id', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(catalog('authoritative', 'astra', {
      sessionPath: '/sessions/first.jsonl', availableModels: models,
    }), container));
    assert.equal(container.querySelector('[aria-label="Model"]')!.textContent, 'GPT-6 Astra');
    act(() => render(catalog('loading', 'astra', { sessionPath: '/sessions/second.jsonl' }), container));
    assert.equal(container.querySelector('.panel-chip-label')!.textContent, 'astra');
    assert.equal(container.querySelector('[aria-label="Model"]'), null);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('empty loading catalog retains label for the provider resolved from the selected model entry', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(catalog('authoritative', 'astra', {
      sessionPath: '/sessions/implicit-provider.jsonl',
      selectedProvider: undefined,
      availableModels: models,
    }), container));
    assert.equal(container.querySelector('[aria-label="Model"]')!.textContent, 'GPT-6 Astra');
    act(() => render(catalog('loading', 'astra', {
      sessionPath: '/sessions/implicit-provider.jsonl',
      selectedProvider: undefined,
    }), container));
    assert.equal(container.querySelector('.panel-chip-label')!.textContent, 'GPT-6 Astra');
    assert.equal(container.querySelector('[aria-label="Model"]'), null);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
