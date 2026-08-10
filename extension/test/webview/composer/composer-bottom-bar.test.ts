import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  EMPTY_TRANSCRIPT_WINDOW,
  type ModelInfo,
  type SystemPromptEntry,
} from '../../../src/shared/protocol';
import { ComposerActions } from '../../../src/webview/panel/composer/actions';
import { ComposerToolbar } from '../../../src/webview/panel/composer/toolbar';
import { Composer } from '../../../src/webview/panel/ui';

const model: ModelInfo = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'test-provider',
  reasoning: true,
  inputKinds: ['text'],
};

const prompt: SystemPromptEntry = {
  id: 'harness',
  source: 'harness',
  title: 'Harness',
  text: 'Harness prompt',
  summary: 'Harness instructions',
  availability: 'available',
};

function assertOrdered(html: string, labels: string[]): void {
  let previous = -1;
  for (const label of labels) {
    const index = html.indexOf(label);
    assert.ok(index > previous, `expected ${label} after the previous bottom-bar control`);
    previous = index;
  }
}

test('composer controls render in the agreed bottom-bar order', () => {
  const prefs = {
    ...DEFAULT_CHAT_PREFS,
    subagentBuckets: {
      small: [{ model: 'test-provider/test-model', thinkingLevel: 'high' as const }],
      medium: [],
      frontier: [],
    },
  };
  const html = renderToString(h(ComposerToolbar, {
    sessionPath: '/session/test.jsonl',
    busy: false,
    prefs,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: () => {},
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
    availableExtensions: [],
    availableModels: [model],
    systemPrompts: [prompt],
    selectedModel: model.id,
    selectedProvider: model.provider,
    selectedLevel: 'high',
    supportsReasoning: true,
    contextIndicator: null,
    contextBreakdown: null,
    sessionCostIndicator: { label: '$0.01', ariaLabel: 'Session cost', tooltip: 'Session cost' },
    tokenRateIndicator: {
      label: '12 tok/s',
      ariaLabel: 'Token rate',
      tooltip: 'Token rate',
      state: 'generating',
      paused: false,
    },
    runStatus: { text: 'LIVE', tone: 'open', title: 'Run is live' },
    compacting: false,
    lastCompaction: null,
    onModelChange: () => {},
    onCompact: () => {},
  }));

  assertOrdered(html, [
    'aria-label="Settings"',
    'aria-label="Model"',
    'aria-label="Reasoning level"',
    'aria-label="Subagent providers:',
    'aria-label="Toggle system prompts"',
    'aria-label="Compact context',
    'aria-label="Enable autonomous mode',
    'class="composer-indicators"',
  ]);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /autonomous-mode-trigger/);
});

test('composer uses the configured initial textarea rows and defaults to one', () => {
  const renderComposer = (composerInitialRows: number) => renderToString(h(Composer, {
    busy: false,
    retryStatus: null,
    sessionPath: null,
    draftText: '',
    modelSettings: null,
    availableModels: [],
    availableExtensions: [],
    contextUsage: null,
    prefs: { ...DEFAULT_CHAT_PREFS, composerInitialRows },
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    systemPrompts: [],
    transcript: [],
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    pendingComposerInputs: [],
    tokenRateBySession: {},
    compacting: false,
    lastCompaction: null,
    postMessage: () => {},
    onSend: () => {},
    onRetrySend: () => {},
    onInterrupt: () => {},
    onAddInput: () => {},
    onRemoveInput: () => {},
    onModelChange: () => {},
    onSetPrefs: () => {},
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
  }));

  assert.match(renderComposer(1), /<textarea[^>]*rows="1"/);
  assert.match(renderComposer(4), /<textarea[^>]*rows="4"/);
  assert.doesNotMatch(renderComposer(1), /composer-input-textarea[^>]*min-h-10/);
});

test('composer actions use compact icons in clear, stop, and queue order', () => {
  const html = renderToString(h(ComposerActions, {
    busy: true,
    hasQueuedMessages: true,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: true,
  }));

  assertOrdered(html, [
    'data-action="clear-queue"',
    'data-action="stop"',
    'data-action="queue"',
  ]);
  assert.equal((html.match(/<svg/g) ?? []).length, 3);
  assert.doesNotMatch(html, />\s*(?:Clear queued|Stop|Queue|Send)\s*</);
  assert.doesNotMatch(html, /Attach file|paperclip/i);
});

test('composer submit icon exposes send and waiting states accessibly', () => {
  const idleHtml = renderToString(h(ComposerActions, {
    busy: false,
    hasQueuedMessages: false,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: true,
  }));
  assert.match(idleHtml, /aria-label="Send message"/);
  assert.match(idleHtml, /data-action="send"/);
  assert.match(idleHtml, /<svg/);

  const waitingHtml = renderToString(h(ComposerActions, {
    busy: true,
    interrupting: true,
    hasQueuedMessages: false,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: true,
  }));
  assert.match(waitingHtml, /aria-label="Stopping response"[^>]*aria-busy="true"/);
  assert.match(waitingHtml, /disabled aria-label="Waiting for stop"/);
});

test('composer bottom-bar CSS keeps compact hitboxes distinct and wraps at narrow widths', async () => {
  const css = await readFile(
    new URL('../../../src/webview/panel/styles/composer.css', import.meta.url),
    'utf8',
  );

  assert.match(css, /\.composer-controls,[\s\S]*?gap: 2px;/);
  assert.match(css, /\.composer-bottom-bar :is\([\s\S]*?background: transparent;/);
  assert.match(css, /\.composer-bottom-bar \.panel-chip-toolbar:hover,[\s\S]*?background: var\(--panel-control-hover\);/);
  assert.match(css, /overlapping[\s\S]*?inset: -1px;/);
  assert.match(css, /@container composer-shell \(max-width: 380px\)[\s\S]*?flex-wrap: wrap;/);
  assert.match(css, /@container composer-shell \(max-width: 240px\)[\s\S]*?flex-wrap: wrap;/);
  assert.match(css, /\.subagent-provider-trigger\.has-disabled \{[\s\S]*?color: var\(--panel-muted\);/);
});
