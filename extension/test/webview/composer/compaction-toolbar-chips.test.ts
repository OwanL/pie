import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
} from '../../../src/shared/protocol';
import { ComposerToolbar } from '../../../src/webview/panel/composer/toolbar';

function renderToolbar(overrides: Partial<Parameters<typeof ComposerToolbar>[0]> = {}): string {
  return renderToString(h(ComposerToolbar, {
    sessionPath: '/session/test.jsonl',
    canCompact: true,
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
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
    onSetSessionTitlesSettings: () => {},
    availableExtensions: [],
    availableModels: [],
    systemPrompts: [],
    selectedModel: '',
    selectedLevel: 'off',
    supportsReasoning: false,
    contextIndicator: null,
    contextBreakdown: null,
    sessionCostIndicator: null,
    tokenRateIndicator: { label: '', ariaLabel: '', tooltip: '', state: 'idle', paused: false },
    workingTimeIndicator: { label: '0s', ariaLabel: 'Total agent working time: 0 seconds', tooltip: 'Total agent working time' },
    runStatus: null,
    compacting: false,
    lastCompaction: null,
    onModelChange: () => {},
    onCompact: () => {},
    ...overrides,
  }));
}

test('toolbar keeps a provisional model picker usable without additive loading copy', () => {
  const html = renderToolbar({
    availableModelsStatus: 'loading',
    availableModels: [{
      id: 'model-a', name: 'Model A', provider: 'p', reasoning: true,
      thinkingLevels: ['off', 'high'], inputKinds: ['text'],
    }],
    selectedModel: 'model-a',
    selectedProvider: 'p',
    selectedLevel: 'high',
    supportsReasoning: true,
  });

  assert.match(html, /aria-label="Model"/);
  assert.match(html, /aria-label="Reasoning level"/);
  assert.doesNotMatch(html, /Models (?:loading|updating)…/);
});

test('toolbar identifies a retained model whose provider was disabled', () => {
  const html = renderToolbar({
    prefs: { ...DEFAULT_CHAT_PREFS, providerToggles: { p: false } },
    availableModels: [{
      id: 'model-a', name: 'Model A', provider: 'p', reasoning: true,
      thinkingLevels: ['off', 'high'], inputKinds: ['text'],
    }],
    selectedModel: 'model-a',
    selectedProvider: 'p',
    selectedLevel: 'high',
    supportsReasoning: true,
  });

  assert.match(html, /Model A \(disabled\)/);
});

test('toolbar shows a live Compacting chip while compaction runs', () => {
  const html = renderToolbar({ compacting: true });
  assert.match(html, /Compacting…/);
  assert.match(html, /compaction-chip-spinner/);
  assert.match(html, /aria-label="Compacting conversation history"/);
  // The compaction trigger swaps to its spinner state.
  assert.match(html, /compaction-trigger compacting/);
  assert.match(html, /aria-label="Compacting conversation history…"/);
});

test('toolbar shows a Compacted chip with freed tokens after compaction', () => {
  const html = renderToolbar({
    lastCompaction: {
      at: 1_700_000_000_000,
      tokensBefore: 120_000,
      estimatedTokensAfter: 30_000,
    },
  });
  assert.match(html, /Compacted · freed 90k tokens/);
  assert.match(html, /aria-label="Conversation compacted, freed 90k tokens"/);
});

test('toolbar shows a plain Compacted chip when token metrics are absent', () => {
  const html = renderToolbar({ lastCompaction: { at: 1_700_000_000_000 } });
  assert.match(html, /Compacted/);
  assert.doesNotMatch(html, /freed/);
});

test('toolbar has no success chip when a compaction has no successful summary', () => {
  const html = renderToolbar({ compacting: false, lastCompaction: null });
  assert.doesNotMatch(html, /Compacted/);
});

test('toolbar hides compaction chips when hideRunStatus is set', () => {
  const html = renderToolbar({
    compacting: true,
    lastCompaction: { at: 1_700_000_000_000, tokensBefore: 120_000, estimatedTokensAfter: 30_000 },
    prefs: { ...DEFAULT_CHAT_PREFS, hideRunStatus: true },
  });
  assert.doesNotMatch(html, /Compacting…/);
  assert.doesNotMatch(html, /freed/);
});
