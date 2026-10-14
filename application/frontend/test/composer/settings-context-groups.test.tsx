import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
installDom();

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_HISTORY_COMPACTION_SETTINGS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
} from '../../../lib/protocol/index.js';
import { convertMode, HistoryCompactionSection } from '../../settings/settings-menu-history-compaction';
import {
  SKILL_PRUNER_BEHAVIOR_SETTING_LABELS,
  SkillPrunerSettings,
} from '../../settings/settings-menu-skill-pruner';
import { ToolResultPrunerSettings } from '../../settings/settings-menu-tool-result-pruner';

function contentGroups(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.toolbar-settings-content-group')];
}

function assertUnit(input: HTMLInputElement | null, expected: string): void {
  assert.ok(input);
  const descriptionId = input.getAttribute('aria-describedby');
  assert.ok(descriptionId);
  const description = document.getElementById(descriptionId);
  assert.equal(description?.textContent, expected);
  assert.equal(description?.classList.contains('toolbar-settings-number-unit'), true);
}

test('history compaction groups retain their existing controls', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(HistoryCompactionSection, {
      settings: DEFAULT_CHAT_PREFS.historyCompaction,
      contextWindow: 100_000,
      availableModels: [],
      onSetPrefs: () => undefined,
    }), container));

    const groups = contentGroups(container);
    assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), [
      'Triggers & retention', 'Summary instructions',
    ]);
    assert.equal(groups[0].getAttribute('role'), 'group');
    assert.ok(groups[0].querySelector('[aria-label="About Triggers & retention"]'));
    assert.deepEqual([...groups[0].querySelectorAll('.toolbar-settings-item-label')].map((label) => label.textContent?.trim()), [
      'Proactive automatic compaction', 'Threshold type', 'Soft trigger', 'Hard trigger', 'Recent retention',
    ]);
    assert.ok(groups[0].querySelector('[role="checkbox"]')?.textContent?.includes('Proactive automatic compaction'));
    assert.ok(groups[0].querySelector('[aria-label="Soft compaction trigger%"]'));
    const softTrigger = groups[0].querySelector<HTMLInputElement>('[aria-label="Soft compaction trigger%"]');
    const hardTrigger = groups[0].querySelector<HTMLInputElement>('[aria-label="Hard compaction trigger%"]');
    assert.equal(groups[0].querySelector<HTMLSelectElement>('[aria-label="History compaction threshold type"]')?.value, 'percentage');
    assert.equal(softTrigger?.value, String(DEFAULT_CHAT_PREFS.historyCompaction.softThreshold));
    assert.equal(hardTrigger?.value, String(DEFAULT_CHAT_PREFS.historyCompaction.hardThreshold));
    assert.ok(groups[0].querySelector('[aria-label="Recent token retention"]'));
    assert.ok(!groups[0].textContent?.includes('Effective soft threshold: about'));
    assert.ok(!groups[0].textContent?.includes('Effective hard threshold: about'));
    assert.ok(!groups[0].textContent?.includes('Compact after the current run settles'));
    assert.ok(groups[1].querySelector('textarea[aria-label="Summary instructions"]'));
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('history compaction units track threshold mode and describe their visible units', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(HistoryCompactionSection, {
      settings: DEFAULT_HISTORY_COMPACTION_SETTINGS,
      contextWindow: 200_000,
      availableModels: [],
      onSetPrefs: () => undefined,
    }), container));

    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Soft compaction trigger%"]'), '%');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Hard compaction trigger%"]'), '%');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Recent token retention"]'), 'tokens');

    const tokenSettings = convertMode(DEFAULT_HISTORY_COMPACTION_SETTINGS, 'tokens', 200_000);
    tokenSettings.modelProfiles['test/m1'] = {
      softThreshold: 120_000,
      hardThreshold: 150_000,
      keepRecentTokens: 20_000,
    };
    act(() => render(h(HistoryCompactionSection, {
      settings: tokenSettings,
      contextWindow: 200_000,
      availableModels: [{ id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] }],
      activeModel: { provider: 'test', id: 'm1' },
      onSetPrefs: () => undefined,
    }), container));

    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Soft compaction trigger tokens"]'), 'tokens');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Hard compaction trigger tokens"]'), 'tokens');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Recent token retention"]'), 'tokens');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Active model soft threshold"]'), 'tokens');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Active model hard threshold"]'), 'tokens');
    assertUnit(container.querySelector<HTMLInputElement>('[aria-label="Active model recent retention"]'), 'tokens');
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Soft compaction trigger tokens"]')?.value, '140000');
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Hard compaction trigger tokens"]')?.value, '170000');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('skill pruning groups keep scope, limits, and always-keep controls', () => {
  const patches: Array<Partial<typeof DEFAULT_PRUNING_SETTINGS>> = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(SkillPrunerSettings, {
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
      skillCatalog: ['skill-a'],
      toolCatalog: ['tool-a'],
      onSetPrefs: () => undefined,
      onSetPruningSettings: (patch) => { patches.push(patch); },
    }), container));

    const groups = contentGroups(container);
    assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), ['Scope & limits', 'Always keep']);
    assert.deepEqual([...groups[0].querySelectorAll('[role="checkbox"]')].map((control) => control.textContent?.trim()), ['Main agents', 'Subagents', 'Re-prune on follow-up messages', 'Refresh tool/skill pruning after history compaction']);
    const refresh = [...groups[0].querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
      .find((control) => control.textContent?.trim() === 'Refresh tool/skill pruning after history compaction');
    assert.ok(refresh);
    assert.equal(refresh.getAttribute('aria-checked'), 'true');
    act(() => refresh.click());
    assert.deepEqual(patches, [{ refreshAfterCompaction: false }]);
    assert.ok(groups[0].querySelector('[aria-label="Pruning mode"]'));
    assert.ok(groups[0].querySelector('[aria-label="About Scope & limits"]'));
    assert.ok(groups[0].textContent?.includes('Skill limit'));
    assert.ok(groups[0].textContent?.includes('Tool limit'));
    assert.ok(groups[1].querySelector('[aria-label="About Always keep"]'));
    assert.ok(!groups[1].textContent?.includes('excluded from pruning'));
    assert.ok(groups[1].textContent?.includes('Omitted skills (never pruned)'));
    assert.ok(groups[1].textContent?.includes('Omitted tools (never pruned)'));
    assert.ok(SKILL_PRUNER_BEHAVIOR_SETTING_LABELS.includes('Main agents'));
    assert.ok(SKILL_PRUNER_BEHAVIOR_SETTING_LABELS.includes('Subagents'));
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('tool-result pruning groups retain target, cleanup, and rewrite controls', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(ToolResultPrunerSettings, {
      settings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      onSetToolResultPruningSettings: () => undefined,
    }), container));

    const groups = contentGroups(container);
    assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), [
      'Target tools & profile', 'Text cleanup', 'Command rewrites',
    ]);
    assert.ok(container.querySelector('[role="checkbox"]')?.textContent?.includes('Enabled'));
    assert.ok(groups[0].querySelector('[aria-label="Tool-result pruning profile"]'));
    assert.ok(groups[0].querySelector('[aria-label="Tool-result pruning tools allowlist (comma-separated)"]'));
    assert.ok(groups[1].querySelector('[aria-label="About Text cleanup"]'));
    assert.ok(!groups[1].textContent?.includes('Remove ANSI escape sequences'));
    assert.deepEqual([...groups[1].querySelectorAll('[role="checkbox"]')].map((control) => control.textContent?.trim()), [
      'ANSI strip', 'Trim whitespace', 'Collapse blank runs', 'Minify JSON',
    ]);
    assert.ok(groups[2].querySelector('[aria-label="About Command rewrites"]'));
    assert.match(groups[2].querySelector('[role="note"]')?.textContent ?? '', /can discard details/);
    assert.deepEqual([...groups[2].querySelectorAll('[role="checkbox"]')].map((control) => control.textContent?.trim()), [
      'ls -l → names', 'git log → oneline', 'grep/rg → group by path',
    ]);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('history compaction equivalents are available in focused help without patching preferences', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let preferencePatches = 0;
  try {
    act(() => render(h(HistoryCompactionSection, {
      settings: DEFAULT_CHAT_PREFS.historyCompaction,
      contextWindow: 200_000,
      availableModels: [],
      onSetPrefs: () => { preferencePatches += 1; },
    }), container));

    const help = container.querySelector<HTMLButtonElement>('[aria-label="About Triggers & retention"]');
    assert.ok(help);
    await act(async () => {
      help.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const tooltipId = help.getAttribute('aria-describedby');
    assert.ok(tooltipId);
    const tooltip = document.getElementById(tooltipId);
    assert.equal(tooltip?.getAttribute('role'), 'tooltip');
    assert.ok(tooltip?.textContent?.includes('Effective soft threshold: about 140k tokens for this model.'));
    assert.ok(tooltip?.textContent?.includes('Effective hard threshold: about 170k tokens for this model.'));
    assert.ok(!container.querySelector('[role="group"]')?.textContent?.includes('about 140k tokens'));
    assert.ok(!container.querySelector('[role="group"]')?.textContent?.includes('about 170k tokens'));
    assert.equal(preferencePatches, 0);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('group help is keyboard-accessible and exposes its explanation as a tooltip', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(ToolResultPrunerSettings, {
      settings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      onSetToolResultPruningSettings: () => undefined,
    }), container));
    const help = container.querySelector<HTMLButtonElement>('[aria-label="About Text cleanup"]');
    assert.ok(help);
    assert.equal(help.type, 'button');
    assert.equal(help.closest('[role="group"]')?.getAttribute('aria-label'), 'Text cleanup');
    await act(async () => {
      help.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const tooltipId = help.getAttribute('aria-describedby');
    assert.ok(tooltipId);
    const tooltip = document.getElementById(tooltipId);
    assert.equal(tooltip?.getAttribute('role'), 'tooltip');
    assert.ok(tooltip?.textContent?.includes('Remove ANSI escape sequences'));
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
