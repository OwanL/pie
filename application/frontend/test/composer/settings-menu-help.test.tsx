/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, DEFAULT_SESSION_TITLES_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';

let target: HTMLDivElement;
beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  act(() => {
    render(<ComposerSettingsMenu prefs={DEFAULT_CHAT_PREFS} pruningSettings={DEFAULT_PRUNING_SETTINGS}
      pruningCatalog={{ skills: [], tools: [] }} pruningResult={null} toolResultPruningSettings={DEFAULT_TOOL_RESULT_PRUNING_SETTINGS}
      sessionTitlesSettings={{ ...DEFAULT_SESSION_TITLES_SETTINGS, enabled: true }} availableExtensions={[]} availableModels={[]}
      providerGateStats={EMPTY_PROVIDER_GATE_STATS} mcpServers={[]} mcpPendingApply={false} onSetPrefs={() => undefined}
      onMcpListRequested={() => undefined} onMcpSetServerEnabled={() => undefined} onSetPruningSettings={() => undefined}
      onSetToolResultPruningSettings={() => undefined} />, target);
    target.querySelector<HTMLButtonElement>('.toolbar-settings-trigger')!.click();
  });
});
afterEach(() => {
  act(() => { render(null, target); });
  target.remove();
});
async function showHelp() {
  const help = document.querySelector<HTMLButtonElement>('button[aria-label="About Generate session titles"]');
  assert.ok(help);
  await act(async () => { help.focus(); await new Promise((resolve) => setTimeout(resolve, 180)); });
  const id = help.getAttribute('aria-describedby');
  assert.ok(id);
  const tooltip = document.getElementById(id)!;
  assert.match(tooltip.textContent ?? '', /prompt-snippet/);
  return { help, tooltip };
}
test('settings help is keyboard-accessible without persistent description rows', async () => {
  assert.equal(document.querySelector('[role="tablist"]')?.getAttribute('aria-orientation'), 'horizontal');
  assert.doesNotMatch(document.querySelector('.toolbar-settings-menu-body')!.textContent ?? '', /prompt-snippet/);
  await showHelp();
});
test('first Escape dismisses help and second Escape closes settings', async () => {
  const { help } = await showHelp();
  act(() => { help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.ok(document.querySelector('.toolbar-settings-menu'));
  assert.equal(help.getAttribute('aria-describedby'), null);
  act(() => { help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(document.querySelector('.toolbar-settings-menu'), null);
  assert.equal(document.activeElement, target.querySelector('.toolbar-settings-trigger'));
});
test('interacting with owned help keeps settings open, outside click still dismisses it', async () => {
  const { tooltip } = await showHelp();
  act(() => { tooltip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.ok(document.querySelector('.toolbar-settings-menu'));
  act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.equal(document.querySelector('.toolbar-settings-menu'), null);
});
