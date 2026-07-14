import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS } from '../../../src/shared/protocol';
import { SkillPrunerSettings } from '../../../src/webview/panel/composer/settings-menu-skill-pruner';

function renderAutoSkip(autoSkipBelowTokens: number | null): string {
  return renderToString(h(SkillPrunerSettings, {
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: { ...DEFAULT_PRUNING_SETTINGS, autoSkipBelowTokens },
    modelEntries: [],
    availableModels: [],
    skillCatalog: [],
    toolCatalog: [],
    onSetPrefs: () => undefined,
    onSetPruningSettings: () => undefined,
  }));
}

test('SkillPrunerSettings exposes the small-prepass auto-skip threshold', () => {
  const html = renderAutoSkip(1200);

  assert.match(html, /Skip small prepasses/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /Skip below tokens/);
  assert.match(html, />1200</);
});

test('SkillPrunerSettings hides the threshold when small-prepass skipping is disabled', () => {
  const html = renderAutoSkip(null);

  assert.match(html, /Skip small prepasses/);
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /Skip below tokens/);
});
