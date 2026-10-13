import assert from 'node:assert/strict';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { ComposerToolbar } from '../../composer/toolbar';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_SESSION_TITLES_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';

function renderCatalog(status: 'loading' | 'provisional' | 'authoritative', selectedModel = '') {
  return renderToString(h(ComposerToolbar, {
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
    onModelChange: () => {}, onCompact: () => {},
  }));
}

test('empty current-session discovery shows loading and offers no model selector', () => {
  for (const status of ['loading', 'provisional'] as const) {
    const html = renderCatalog(status, 'draft-model');
    assert.match(html, /Loading models/);
    assert.match(html, /draft-model/);
    assert.doesNotMatch(html, /aria-label="Model"/);
  }
});

test('authoritative empty catalog shows no models rather than loading or choices', () => {
  const html = renderCatalog('authoritative');
  assert.match(html, /No models available/);
  assert.doesNotMatch(html, /Loading models|aria-label="Model"/);
});
