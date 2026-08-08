import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addProviderQualifiedModelSpec,
  filterEnabledProviders,
  isModelSelectedBySpec,
  orderModelsForPicker,
} from '../../../src/webview/panel/composer/model-list';
import type { ModelInfo } from '../../../src/shared/protocol';

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: overrides.name ?? id,
    provider: overrides.provider ?? 'test',
    reasoning: overrides.reasoning ?? false,
    inputKinds: overrides.inputKinds ?? ['text'],
    ...overrides,
  };
}

test('orderModelsForPicker sorts every model alphabetically while retaining eligibility warnings', () => {
  const models: ModelInfo[] = [
    model('beta', { name: 'Beta', subagent: { eligible: true } }),
    model('ineligible-zulu', { name: 'Zulu', subagent: { eligible: false, disabledReason: 'incompatible' } }),
    model('alpha', { name: 'Alpha', subagent: { eligible: true } }),
    model('unprofiled', { name: 'Charlie' }),
    model('ineligible-aaron', { name: 'Aaron', subagent: { eligible: false } }),
  ];

  const ordered = orderModelsForPicker(models).map((entry) => entry.model.id);
  assert.deepEqual(ordered, ['ineligible-aaron', 'alpha', 'beta', 'unprofiled', 'ineligible-zulu']);
});

test('orderModelsForPicker decorates ineligible options with a warning prefix and reason in the tooltip', () => {
  const ordered = orderModelsForPicker([
    model('bad', { name: 'Bad Model', subagent: { eligible: false, disabledReason: 'broken' } }),
    model('good', { name: 'Good Model', subagent: { eligible: true } }),
  ]);
  const bad = ordered.find((entry) => entry.model.id === 'bad');
  const good = ordered.find((entry) => entry.model.id === 'good');
  assert.ok(bad && good);
  assert.equal(bad.ineligible, true);
  assert.match(bad.label, /^⚠ /);
  assert.equal(bad.selectedLabel, '⚠ Bad Model');
  assert.match(bad.title, /^Bad Model/);
  assert.match(bad.title, /Subagent eligibility warning: broken/);
  assert.equal(good.ineligible, false);
  assert.equal(good.label, 'test · Good Model');
  assert.equal(good.selectedLabel, 'Good Model');
  assert.equal(good.title, 'Good Model');
});

test('orderModelsForPicker does not treat subagent ineligibility as a parent-chat recommendation', () => {
  const ordered = orderModelsForPicker([
    model('shared', {
      provider: 'github-copilot',
      name: 'Copilot Model',
      subagent: { eligible: false, disabledReason: 'not vetted' },
    }),
    model('shared', {
      provider: 'openai-codex',
      name: 'Codex Model',
      subagent: { eligible: true },
    }),
  ], { useSubagentEligibility: false });

  assert.deepEqual(ordered.map((entry) => entry.model.provider), ['openai-codex', 'github-copilot']);
  assert.ok(ordered.every((entry) => !entry.ineligible));
  assert.ok(ordered.every((entry) => !entry.label.startsWith('⚠')));
  assert.ok(ordered.every((entry) => !entry.title.includes('Subagent eligibility warning')));
});

test('orderModelsForPicker avoids repeating provider branding in row and selected labels', () => {
  const [entry] = orderModelsForPicker([
    model('deepseek', { name: 'Ollama Cloud: Deepseek V4 pro', subagent: { eligible: true } }),
  ]);
  assert.equal(entry.label, 'test · Deepseek V4 pro');
  assert.equal(entry.selectedLabel, 'Deepseek V4 pro');
  assert.equal(entry.title, 'Ollama Cloud: Deepseek V4 pro');
});

test('orderModelsForPicker uses model id as deterministic tiebreak when names match', () => {
  const ordered = orderModelsForPicker([
    model('b', { name: 'Same', subagent: { eligible: true } }),
    model('a', { name: 'Same', subagent: { eligible: true } }),
  ]).map((entry) => entry.model.id);
  assert.deepEqual(ordered, ['a', 'b']);
});

test('orderModelsForPicker includes pricing and image support in entries', () => {
  const ordered = orderModelsForPicker([
    model('priced', {
      name: 'Priced Model',
      inputKinds: ['text', 'image'],
      subagent: { eligible: true, pricing: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 } },
    }),
    model('free', {
      name: 'Free Model',
      inputKinds: ['text'],
      subagent: { eligible: true },
    }),
  ]);

  const priced = ordered.find((entry) => entry.model.id === 'priced');
  const free = ordered.find((entry) => entry.model.id === 'free');
  assert.ok(priced && free);
  assert.equal(priced.tokenInPrice, '$2.50');
  assert.equal(priced.tokenOutPrice, '$10.00');
  assert.equal(priced.supportsImages, true);
  assert.equal(free.tokenInPrice, '');
  assert.equal(free.tokenOutPrice, '');
  assert.equal(free.supportsImages, false);
});

test('legacy bare selections keep duplicate provider-qualified choices available for upgrade', () => {
  const catalog = [
    model('shared', { provider: 'github-copilot' }),
    model('shared', { provider: 'openai-codex' }),
    model('unique', { provider: 'ollama' }),
  ];

  assert.equal(isModelSelectedBySpec(catalog[0], ['shared'], catalog), false);
  assert.equal(isModelSelectedBySpec(catalog[1], ['shared'], catalog), false);
  assert.equal(isModelSelectedBySpec(catalog[2], ['unique'], catalog), true);
  assert.equal(
    isModelSelectedBySpec(catalog[0], ['github-copilot/shared'], catalog),
    true,
  );
  assert.equal(
    isModelSelectedBySpec(catalog[1], ['github-copilot/shared'], catalog),
    false,
  );
});

test('provider-qualified choices replace the matching legacy bare selection', () => {
  assert.deepEqual(
    addProviderQualifiedModelSpec(
      ['other', 'shared'],
      'github-copilot/shared',
    ),
    ['other', 'github-copilot/shared'],
  );
  assert.deepEqual(
    addProviderQualifiedModelSpec(
      ['github-copilot/shared'],
      'github-copilot/shared',
    ),
    ['github-copilot/shared'],
  );
});

test('filterEnabledProviders drops models whose provider is toggled off', () => {
  const models: ModelInfo[] = [
    model('a', { provider: 'openai' }),
    model('b', { provider: 'anthropic' }),
    model('c', { provider: 'google' }),
  ];

  assert.deepEqual(
    filterEnabledProviders(models, { anthropic: false }).map((entry) => entry.id),
    ['a', 'c'],
  );
  assert.deepEqual(filterEnabledProviders(models, {}).map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(
    filterEnabledProviders(models, { openai: true, anthropic: true, google: true }).map((entry) => entry.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(filterEnabledProviders(models, { openai: false, anthropic: false, google: false }), []);
});
