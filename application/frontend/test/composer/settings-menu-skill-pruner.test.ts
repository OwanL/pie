import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, type PruningSettings } from '../../../lib/protocol/index.js';
import { SkillPrunerModelAssignment, SkillPrunerSettings } from '../../settings/settings-menu-skill-pruner';

test('SkillPrunerSettings omits retired token-skip controls and retains pruning controls', () => {
  const html = renderToString(h(SkillPrunerSettings, {
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    skillCatalog: [],
    toolCatalog: [],
    onSetPrefs: () => undefined,
    onSetPruningSettings: () => undefined,
  }));

  assert.doesNotMatch(html, /Skip small prepasses/);
  assert.doesNotMatch(html, /Skip below tokens/);
  assert.match(html, /Skill limit/);
  assert.match(html, /Tool limit/);
  assert.match(html, /Omitted skills \(never pruned\)/);
  assert.match(html, /Omitted tools \(never pruned\)/);
});

test('SkillPrunerSettings exposes independent main-agent and subagent switches', () => {
  const pruningSettings: PruningSettings = {
    ...DEFAULT_PRUNING_SETTINGS,
    mode: 'off',
    mainAgentEnabled: false,
    subagentEnabled: true,
  };
  const html = renderToString(h(SkillPrunerSettings, {
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings,
    skillCatalog: [],
    toolCatalog: [],
    onSetPrefs: () => undefined,
    onSetPruningSettings: () => undefined,
  }));
  const checkedValues = [...html.matchAll(/aria-checked="(true|false)"/gu)].map((match) => match[1]);

  assert.match(html, /Main agents/);
  assert.match(html, /Subagents/);
  assert.deepEqual(checkedValues.slice(1, 3), ['false', 'true']);
  assert.match(html, /selected value="off"/);
});

test('SkillPrunerModelAssignment owns the prepass model and thinking controls', () => {
  const html = renderToString(h(SkillPrunerModelAssignment, {
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    modelEntries: [],
    availableModels: [],
    onSetPruningSettings: () => undefined,
  }));

  assert.match(html, /Prepass model/);
  assert.match(html, /Pruning thinking level/);
});
