import test from 'node:test';
import assert from 'node:assert/strict';

import { filterEnabledProviders, orderModelsForPicker } from '../../../src/webview/panel/composer/model-list';
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

test('orderModelsForPicker sorts by normalized cost descending and pushes ineligible models to the bottom', () => {
  const models: ModelInfo[] = [
    model('cheap-eligible', { subagent: { eligible: true, aggregate: 8, normalizedCost: 2 } }),
    model('ineligible-top', { subagent: { eligible: false, aggregate: 20, disabledReason: 'incompatible', normalizedCost: 0.5 } }),
    model('pricey-eligible', { subagent: { eligible: true, aggregate: 18, normalizedCost: 8 } }),
    model('ineligible-mid', { subagent: { eligible: false, aggregate: 12, normalizedCost: 3 } }),
    model('unrated', {}),
    model('mid-eligible', { subagent: { eligible: true, aggregate: 14, normalizedCost: 4 } }),
  ];

  // Eligible: most expensive first (cost 8, 4, 2, then 0 for unrated)
  // Ineligible: most expensive first (3, then 0.5)
  const ordered = orderModelsForPicker(models).map((e) => e.model.id);
  assert.deepEqual(ordered, ['pricey-eligible', 'mid-eligible', 'cheap-eligible', 'unrated', 'ineligible-mid', 'ineligible-top']);
});

test('orderModelsForPicker decorates ineligible options with a warning prefix and reason in the tooltip', () => {
  const ordered = orderModelsForPicker([
    model('bad', { name: 'Bad Model', subagent: { eligible: false, aggregate: 4, disabledReason: 'broken' } }),
    model('good', { name: 'Good Model', subagent: { eligible: true, aggregate: 16 } }),
  ]);
  const bad = ordered.find((e) => e.model.id === 'bad');
  const good = ordered.find((e) => e.model.id === 'good');
  assert.ok(bad && good);
  assert.equal(bad!.ineligible, true);
  assert.match(bad!.label, /^⚠ /);
  assert.equal(bad!.selectedLabel, '⚠ Bad Model');
  assert.match(bad!.title, /rating 4\/20/);
  assert.match(bad!.title, /Disabled for subagent use: broken/);
  assert.equal(good!.ineligible, false);
  assert.equal(good!.label, 'test · Good Model');
  assert.equal(good!.selectedLabel, 'Good Model');
  assert.match(good!.title, /rating 16\/20/);
});

test('orderModelsForPicker does not treat subagent ineligibility as a parent-chat recommendation', () => {
  const ordered = orderModelsForPicker([
    model('shared', {
      provider: 'github-copilot',
      name: 'Copilot Model',
      subagent: { eligible: false, aggregate: 0, disabledReason: 'not vetted', normalizedCost: 20 },
    }),
    model('shared', {
      provider: 'openai-codex',
      name: 'Codex Model',
      subagent: { eligible: true, aggregate: 20, normalizedCost: 10 },
    }),
  ], { useSubagentEligibility: false });

  assert.deepEqual(ordered.map((entry) => entry.model.provider), ['github-copilot', 'openai-codex']);
  assert.ok(ordered.every((entry) => !entry.ineligible));
  assert.ok(ordered.every((entry) => !entry.label.startsWith('⚠')));
  assert.ok(ordered.every((entry) => !entry.title.includes('Disabled for subagent use')));
});

test('orderModelsForPicker strips provider text only from the compact selected label', () => {
  const [entry] = orderModelsForPicker([
    model('deepseek', { name: 'Ollama Cloud: Deepseek V4 pro', subagent: { eligible: true, aggregate: 12 } }),
  ]);
  assert.equal(entry.label, 'test · Ollama Cloud: Deepseek V4 pro');
  assert.equal(entry.selectedLabel, 'Deepseek V4 pro');
});

test('orderModelsForPicker keeps deterministic name-based tiebreak when costs match', () => {
  const ordered = orderModelsForPicker([
    model('b', { name: 'Beta', subagent: { eligible: true, aggregate: 8, normalizedCost: 5 } }),
    model('a', { name: 'Alpha', subagent: { eligible: true, aggregate: 10, normalizedCost: 5 } }),
  ]).map((e) => e.model.id);
  // Same cost, so sort by aggregate desc: a (10) before b (8)
  assert.deepEqual(ordered, ['a', 'b']);
});

test('orderModelsForPicker includes pricing and image support in entries', () => {
  const ordered = orderModelsForPicker([
    model('priced', {
      name: 'Priced Model',
      inputKinds: ['text', 'image'],
      subagent: { eligible: true, aggregate: 10, normalizedCost: 5, pricing: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 } },
    }),
    model('free', {
      name: 'Free Model',
      inputKinds: ['text'],
      subagent: { eligible: true, aggregate: 8, normalizedCost: 0 },
    }),
  ]);

  // Priced (cost 5) sorts before free (cost 0) with descending cost order
  assert.equal(ordered[0].model.id, 'priced');
  assert.equal(ordered[1].model.id, 'free');

  const priced = ordered.find((e) => e.model.id === 'priced');
  const free = ordered.find((e) => e.model.id === 'free');
  assert.ok(priced && free);

  assert.equal(priced!.tokenInPrice, '$2.50');
  assert.equal(priced!.tokenOutPrice, '$10.00');
  assert.equal(priced!.supportsImages, true);

  assert.equal(free!.tokenInPrice, '');
  assert.equal(free!.tokenOutPrice, '');
  assert.equal(free!.supportsImages, false);
});

test('filterEnabledProviders drops models whose provider is toggled off', () => {
  const models: ModelInfo[] = [
    model('a', { provider: 'openai' }),
    model('b', { provider: 'anthropic' }),
    model('c', { provider: 'google' }),
  ];

  assert.deepEqual(
    filterEnabledProviders(models, { anthropic: false }).map((m) => m.id),
    ['a', 'c'],
  );
  // Absent or true → enabled (nothing dropped).
  assert.deepEqual(filterEnabledProviders(models, {}).map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(
    filterEnabledProviders(models, { openai: true, anthropic: true, google: true }).map((m) => m.id),
    ['a', 'b', 'c'],
  );
  // All disabled → empty.
  assert.deepEqual(filterEnabledProviders(models, { openai: false, anthropic: false, google: false }), []);
});
