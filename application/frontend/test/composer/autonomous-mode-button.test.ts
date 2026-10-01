import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  mergeChatPrefs,
  type ChatPrefs,
} from '../../../lib/protocol/index.js';
import { ComposerToolbar } from '../../composer/toolbar';

function toolbarProps(
  sessionPath: string,
  prefs: ChatPrefs,
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void,
): Parameters<typeof ComposerToolbar>[0] {
  return {
    sessionPath,
    canCompact: true,
    prefs,
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
    onSetBrowserServerLanEnabled: () => undefined,
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
  };
}

function renderToolbar(
  container: HTMLElement,
  sessionPath: string,
  prefs: ChatPrefs,
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void,
): void {
  act(() => render(h(ComposerToolbar, toolbarProps(sessionPath, prefs, onSetPrefs)), container));
}

function mount(
  sessionPath: string,
  prefs: ChatPrefs,
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  renderToolbar(container, sessionPath, prefs, onSetPrefs);
  return container;
}

test('autonomous mode button toggles an independent override for each root session', () => {
  const firstPath = '/session/one.jsonl';
  const secondPath = '/session/two.jsonl';
  let prefs: ChatPrefs = {
    ...DEFAULT_CHAT_PREFS,
    autonomousMode: false,
    autonomousModeBySession: { [firstPath]: true },
  };
  const writes: Array<Partial<ChatPrefs>> = [];
  const onSetPrefs = (update: Partial<ChatPrefs>) => {
    writes.push(update);
    prefs = mergeChatPrefs(prefs, update);
  };
  const first = mount(firstPath, prefs, onSetPrefs);
  const second = mount(secondPath, prefs, onSetPrefs);
  const button = (container: HTMLElement) => container.querySelector('.autonomous-mode-trigger') as HTMLButtonElement | null;

  assert.equal(button(first)?.getAttribute('aria-pressed'), 'true', 'the first session uses its explicit override');
  assert.ok(button(first)?.classList.contains('active'));
  assert.equal(button(second)?.getAttribute('aria-pressed'), 'false', 'the second session inherits the shared default');
  assert.equal(button(second)?.classList.contains('active'), false);
  act(() => button(second)!.click());
  assert.deepEqual(writes, [{ autonomousModeBySession: { [secondPath]: true } }]);
  assert.equal(prefs.autonomousMode, false, 'a session toggle leaves the shared default unchanged');
  assert.deepEqual(prefs.autonomousModeBySession, { [firstPath]: true, [secondPath]: true });

  renderToolbar(first, firstPath, prefs, onSetPrefs);
  renderToolbar(second, secondPath, prefs, onSetPrefs);
  assert.equal(button(first)?.getAttribute('aria-pressed'), 'true', 'changing the second session leaves the first on');
  assert.equal(button(second)?.getAttribute('aria-pressed'), 'true');

  act(() => button(first)!.click());
  assert.deepEqual(writes, [
    { autonomousModeBySession: { [secondPath]: true } },
    { autonomousModeBySession: { [firstPath]: false } },
  ]);
  assert.equal(prefs.autonomousMode, false);
  assert.deepEqual(prefs.autonomousModeBySession, { [firstPath]: false, [secondPath]: true });

  renderToolbar(first, firstPath, prefs, onSetPrefs);
  renderToolbar(second, secondPath, prefs, onSetPrefs);
  assert.equal(button(first)?.getAttribute('aria-pressed'), 'false');
  assert.equal(button(second)?.getAttribute('aria-pressed'), 'true', 'changing the first session leaves the second on');
  act(() => render(null, first));
  act(() => render(null, second));
  first.remove();
  second.remove();
});
