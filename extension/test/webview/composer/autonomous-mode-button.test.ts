import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  type ChatPrefs,
} from '../../../src/shared/protocol';
import { ComposerToolbar } from '../../../src/webview/panel/composer/toolbar';

function mount(autonomousMode: boolean, onSetPrefs: (prefs: Partial<ChatPrefs>) => void): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(ComposerToolbar, {
      sessionPath: '/session/test.jsonl',
      canCompact: true,
      prefs: { ...DEFAULT_CHAT_PREFS, autonomousMode },
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
      pruningCatalog: { skills: [], tools: [] },
      pruningResult: null,
      toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
      providerGateStats: EMPTY_PROVIDER_GATE_STATS,
      onSetPrefs,
      mcpServers: [],
      mcpPendingApply: false,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabled: () => undefined,
      mcpSessionServers: [],
      mcpSessionPendingApply: false,
      onMcpSetServerEnabledForSession: () => undefined,
      onSetSystemPromptToggles: () => undefined,
      onSetPruningSettings: () => undefined,
      onSetToolResultPruningSettings: () => undefined,
      onSetSessionTitlesSettings: () => undefined,
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
      onModelChange: () => undefined,
      onCompact: () => undefined,
    }), container);
  });
  return container;
}

test('autonomous mode button posts the inverse preference and exposes pressed state', () => {
  const offCalls: Array<Partial<ChatPrefs>> = [];
  const off = mount(false, (prefs) => offCalls.push(prefs));
  const offButton = off.querySelector('.autonomous-mode-trigger') as HTMLButtonElement | null;
  assert.ok(offButton);
  assert.equal(offButton.getAttribute('aria-pressed'), 'false');
  act(() => offButton.click());
  assert.deepEqual(offCalls, [{ autonomousMode: true }]);
  act(() => render(null, off));
  off.remove();

  const onCalls: Array<Partial<ChatPrefs>> = [];
  const on = mount(true, (prefs) => onCalls.push(prefs));
  const onButton = on.querySelector('.autonomous-mode-trigger') as HTMLButtonElement | null;
  assert.ok(onButton);
  assert.equal(onButton.getAttribute('aria-pressed'), 'true');
  assert.ok(onButton.classList.contains('active'));
  act(() => onButton.click());
  assert.deepEqual(onCalls, [{ autonomousMode: false }]);
  act(() => render(null, on));
  on.remove();
});
