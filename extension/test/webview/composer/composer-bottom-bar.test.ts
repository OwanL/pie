import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  EMPTY_TRANSCRIPT_WINDOW,
  type ModelInfo,
  type SystemPromptEntry,
} from '../../../src/shared/protocol';
import { ComposerActions } from '../../../src/webview/panel/composer/actions';
import { ComposerToolbar } from '../../../src/webview/panel/composer/toolbar';
import { Composer } from '../../../src/webview/panel/ui';
import { formatWorkingTime } from '../../../src/webview/panel/composer/use-working-time';
import { WorkingTimeTooltip } from '../../../src/webview/panel/composer/working-time-tooltip';

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
    canCompact: true,
    prefs,
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
    availableModels: [model],
    systemPrompts: [prompt],
    selectedModel: model.id,
    selectedProvider: model.provider,
    selectedLevel: 'high',
    supportsReasoning: true,
    contextIndicator: null,
    contextBreakdown: null,
    sessionCostIndicator: {
      label: '$0.01',
      ariaLabel: 'Session cost',
      tooltip: 'Session cost',
      breakdown: {
        totalCost: 0.01,
        hasIncompleteCost: false,
        unpricedTokens: 0,
        reportedTurnCount: 1,
        inputTokens: 1_000,
        outputTokens: 100,
        providers: [{
          provider: 'test-provider',
          cost: 0.01,
          hasKnownCost: true,
          unpricedTokens: 0,
          models: [{ provider: 'test-provider', model: 'test-model', cost: 0.01, hasKnownCost: true, unpricedTokens: 0 }],
        }],
        sources: [{ key: 'conversation', label: 'Main conversation', cost: 0.01, hasKnownCost: true, unpricedTokens: 0, tokens: 1_100 }],
      },
    },
    tokenRateIndicator: {
      label: '12 tok/s',
      ariaLabel: 'Token rate',
      tooltip: 'Token rate',
      state: 'generating',
      paused: false,
    },
    workingTimeIndicator: {
      label: '1m 23s',
      ariaLabel: 'Total agent working time: 1 minute, 23 seconds',
      tooltip: 'Total agent working time',
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
  assertOrdered(html, ['12 tok/s', '1m 23s', 'LIVE']);
});

test('working-time indicator formats session totals compactly', () => {
  assert.equal(formatWorkingTime(0), '0s');
  assert.equal(formatWorkingTime(83_900), '1m 23s');
  assert.equal(formatWorkingTime(3_723_000), '1h 2m');
  assert.equal(formatWorkingTime(93_600_000), '1d 2h');
});

test('working-time tooltip breaks total time down by phase and tool', () => {
  const html = renderToString(h(WorkingTimeTooltip, {
    elapsedMs: 12_000,
    state: {
      accumulatedMs: 12_000,
      activeSince: null,
      breakdown: {
        generationMs: 4_000,
        toolExecutionMs: 3_000,
        estimatedToolExecutionMs: 0,
        retryWaitMs: 1_000,
        estimatedRetryWaitMs: 1_000,
        auxiliaryGenerationMs: 500,
        subagentDurationMs: 9_500,
        estimatedSubagentDurationMs: 1_000,
        subagentAttemptCount: 3,
        unknownSubagentDurationCount: 1,
        toolDurationMsByName: { subagent: 4_000, bash: 4_000, read: 2_000 },
        toolCallCountByName: { subagent: 2, bash: 2, read: 3 },
      },
    },
  }));

  assert.match(html, /Agent working time/);
  assert.match(html, /Generation[\s\S]*4s/);
  assert.match(html, /Tool execution[\s\S]*3s/);
  assert.match(html, /Retry wait[\s\S]*≈1s/);
  assert.match(html, /Auxiliary model calls[\s\S]*&lt;1s/);
  assert.match(html, /Other work[\s\S]*3s/);
  assert.match(html, /Tools by call time/);
  assert.match(html, /bash[\s\S]*2×[\s\S]*4s/);
  assert.match(html, /read[\s\S]*3×[\s\S]*2s/);
  assert.doesNotMatch(html, />subagent<\/span>/);
  assert.match(html, /Subagents[\s\S]*3 attempts/);
  assert.match(html, /Cumulative agent time[\s\S]*≈9s/);
  assert.match(html, /1 additional duration unavailable/);
  assert.match(html, /parallel, nested, and retry attempts independently/);
});

test('working-time tooltip preserves mocked phase totals instead of zeroing later categories', () => {
  const html = renderToString(h(WorkingTimeTooltip, {
    elapsedMs: 5_000,
    state: {
      accumulatedMs: 5_000,
      activeSince: null,
      breakdown: {
        generationMs: 4_000,
        toolExecutionMs: 3_000,
        estimatedToolExecutionMs: 0,
        retryWaitMs: 2_000,
        estimatedRetryWaitMs: 0,
        auxiliaryGenerationMs: 1_000,
        toolDurationMsByName: { mcp: 3_000 },
        toolCallCountByName: { mcp: 1 },
      },
    },
  }));

  assert.match(html, /Generation[\s\S]*4s/);
  assert.match(html, /Tool execution[\s\S]*3s/);
  assert.match(html, /Retry wait[\s\S]*2s/);
  assert.match(html, /Auxiliary model calls[\s\S]*1s/);
  assert.match(html, /Other work[\s\S]*0s/);
  assert.match(html, /overlapping phase totals may exceed working time/);
});

test('working-time tooltip attributes a mocked active MCP call to tools', () => {
  const html = renderToString(h(WorkingTimeTooltip, {
    elapsedMs: 15_000,
    state: {
      accumulatedMs: 5_000,
      activeSince: 10_000,
      activeToolSince: 12_000,
      activeTools: [{ id: 'mcp-live', name: 'mcp', startedAt: 12_000 }],
      breakdown: {
        generationMs: 3_000,
        toolExecutionMs: 2_000,
        estimatedToolExecutionMs: 0,
        retryWaitMs: 0,
        estimatedRetryWaitMs: 0,
        auxiliaryGenerationMs: 1_000,
        toolDurationMsByName: { mcp: 2_000 },
        toolCallCountByName: { mcp: 1 },
      },
    },
  }));

  assert.match(html, /Tool execution[\s\S]*10s/);
  assert.match(html, /Other work[\s\S]*1s/);
  assert.match(html, /mcp[\s\S]*2×[\s\S]*10s/);
});

test('working-time tooltip moves legacy subagent tool timing into its own section', () => {
  const html = renderToString(h(WorkingTimeTooltip, {
    elapsedMs: 5_000,
    state: {
      accumulatedMs: 5_000,
      activeSince: null,
      breakdown: {
        generationMs: 0,
        toolExecutionMs: 4_000,
        estimatedToolExecutionMs: 0,
        retryWaitMs: 0,
        estimatedRetryWaitMs: 0,
        auxiliaryGenerationMs: 0,
        toolDurationMsByName: { subagent: 4_000 },
        toolCallCountByName: { subagent: 2 },
      },
    },
  }));

  assert.match(html, /Subagents[\s\S]*2 calls/);
  assert.match(html, /Cumulative agent time[\s\S]*≈4s/);
  assert.match(html, /Legacy total from top-level subagent tool calls/);
  assert.doesNotMatch(html, /Tools by call time/);
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
    initialContextEstimate: null,
    prefs: { ...DEFAULT_CHAT_PREFS, composerInitialRows },
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    systemPrompts: [],
    transcript: [],
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    pendingComposerInputs: [],
    tokenRateBySession: {},
    workingTimeBySession: {},
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

test('composer stop eligibility follows projected capabilities instead of legacy busy alone', () => {
  const html = renderToString(h(ComposerActions, {
    busy: true,
    canInterrupt: false,
    hasQueuedMessages: false,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: false,
  }));
  assert.doesNotMatch(html, /data-action="stop"/);
  assert.match(html, /data-action="queue"/);
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

test('disconnected browser state disables queued, stop, and submit mutations', () => {
  const html = renderToString(h(ComposerActions, {
    busy: true,
    commandsAvailable: false,
    hasQueuedMessages: true,
    onInterrupt: () => {},
    onClearQueue: () => {},
    sendCurrentText: () => {},
    canSend: true,
  }));

  assert.equal((html.match(/disabled/g) ?? []).length, 3);
  assert.match(html, /data-action="clear-queue"/);
  assert.match(html, /data-action="stop"/);
  assert.match(html, /data-action="queue"/);
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
  assert.match(css, /@container composer-shell \(max-width: 380px\)[\s\S]*?\.composer-controls \{[\s\S]*?flex: 1 1 100%;[\s\S]*?flex-wrap: wrap;/);
  assert.match(css, /@container composer-shell \(max-width: 240px\)[\s\S]*?flex-wrap: wrap;/);
  assert.match(css, /\.subagent-provider-trigger\.has-disabled \{[\s\S]*?color: var\(--panel-muted\);/);
  assert.match(css, /\.mcp-toggle-trigger\.active \{[\s\S]*?background: var\(--panel-control-surface\);[\s\S]*?color: var\(--panel-foreground\);/);
  assert.match(css, /\.mcp-toggle-trigger\.active:focus-visible \{[\s\S]*?background: var\(--panel-control-hover\);[\s\S]*?color: var\(--panel-foreground\);/);
  assert.match(css, /\.toolbar-settings-menu \{[\s\S]*?box-sizing: border-box;/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.toolbar-settings-tabs \{[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: thin;/);
});
