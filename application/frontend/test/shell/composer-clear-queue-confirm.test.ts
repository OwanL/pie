/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render, type ComponentProps } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  EMPTY_TRANSCRIPT_WINDOW,
  type ChatMessage,
  type WebviewToHostMessage,
} from '../../../lib/protocol/index.js';
import { Composer } from '../../shell/ui';

let container: HTMLElement;
let posted: WebviewToHostMessage[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  posted = [];
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const queuedMessage: ChatMessage = {
  id: 'msg-1',
  role: 'user',
  createdAt: new Date().toISOString(),
  markdown: 'queued while busy',
  status: 'queued',
};

function makeProps(sessionPath: string | null): ComponentProps<typeof Composer> {
  return {
    busy: true,
    commandsAvailable: true,
    retryStatus: null,
    sessionPath,
    draftText: '',
    modelSettings: null,
    availableModels: [],
    availableExtensions: [],
    contextUsage: null,
    initialContextEstimate: null,
    prefs: { ...DEFAULT_CHAT_PREFS },
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    systemPrompts: [],
    transcript: [queuedMessage],
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    pendingComposerInputs: [],
    tokenRateBySession: {},
    workingTimeBySession: {},
    compacting: false,
    lastCompaction: null,
    postMessage: (msg: WebviewToHostMessage) => { posted.push(msg); },
    onSend: () => {},
    onRetrySend: () => {},
    onInterrupt: () => {},
    onAddInput: () => {},
    onRemoveInput: () => {},
    onModelChange: () => {},
    onSetPrefs: () => {},
    mcpServers: [],
    mcpPendingApply: false,
    mcpSessionServers: [],
    mcpSessionPendingApply: false,
    onMcpListRequested: () => {},
    onMcpSetServerEnabled: () => {},
    onMcpSetServerEnabledForSession: () => {},
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
    onSetSessionTitlesSettings: () => {},
  };
}

test('one click clears queued messages directly for the explicit session path without a dialog', () => {
  act(() => { render(h(Composer, makeProps('/sessions/current.jsonl')), container); });

  const clearButton = container.querySelector<HTMLButtonElement>('[data-action="clear-queue"]');
  assert.ok(clearButton, 'queued messages expose the clear affordance');
  act(() => { clearButton.click(); });

  assert.deepEqual(posted, [{ type: 'clearQueue', sessionPath: '/sessions/current.jsonl' }]);
  assert.equal(container.querySelector('[role="dialog"]'), null, 'clearing does not require confirmation');
});
