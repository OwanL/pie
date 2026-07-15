import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from '../../../extension/node_modules/yaml/dist/index.js';

import { reconcileCatalogText, toCatalogModel } from '../src/catalog-sync.js';
import {
  isSelectableCopilotModel,
  parseCopilotModelsResponse,
  toDiscoveredCopilotModel,
} from '../src/copilot-models.js';

const gpt56 = {
  id: 'gpt-5.6-terra',
  name: 'GPT-5.6 Terra',
  vendor: 'OpenAI',
  model_picker_enabled: true,
  policy: { state: 'enabled' },
  supported_endpoints: ['/responses', 'ws:/responses'],
  billing: {
    token_prices: {
      default: {
        input_price: 250,
        output_price: 1500,
        cache_price: 25,
        cache_write_price: 312,
        context_max: 272000,
      },
      long_context: {
        input_price: 500,
        output_price: 2250,
        cache_price: 50,
        cache_write_price: 625,
      },
    },
  },
  capabilities: {
    limits: {
      max_context_window_tokens: 1050000,
      max_output_tokens: 128000,
    },
    supports: {
      reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      tool_calls: true,
      vision: true,
    },
  },
};

test('maps newly discovered Responses models and long-context prices', () => {
  const model = toDiscoveredCopilotModel(gpt56);

  assert.deepEqual(model, {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-responses',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
      minimal: 'low',
    },
    input: ['text', 'image'],
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 3.12,
      tiers: [{
        inputTokensAbove: 272000,
        input: 5,
        output: 22.5,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      }],
    },
    contextWindow: 1050000,
    maxTokens: 128000,
  });
});

test('filters picker-disabled, policy-disabled, and tool-less models', () => {
  assert.equal(isSelectableCopilotModel({ ...gpt56, model_picker_enabled: false }), false);
  assert.equal(isSelectableCopilotModel({ ...gpt56, policy: { state: 'disabled' } }), false);
  assert.equal(isSelectableCopilotModel({ ...gpt56, policy: undefined }), true);
  assert.equal(isSelectableCopilotModel({ ...gpt56, capabilities: undefined }), true);
  assert.equal(isSelectableCopilotModel({
    ...gpt56,
    capabilities: { supports: { tool_calls: false } },
  }), false);
});

test('uses Anthropic messages and conservative Copilot compatibility', () => {
  const model = toDiscoveredCopilotModel({
    ...gpt56,
    id: 'claude-next',
    vendor: 'Anthropic',
    supported_endpoints: ['/v1/messages', '/chat/completions'],
  });

  assert.equal(model?.api, 'anthropic-messages');
  assert.deepEqual(model?.compat, {
    supportsEagerToolInputStreaming: false,
    forceAdaptiveThinking: true,
  });
});

test('validates the response envelope and returns selectable models', () => {
  assert.throws(() => parseCopilotModelsResponse({ models: [] }), /Invalid Copilot models response/);
  assert.equal(toDiscoveredCopilotModel({ ...gpt56, id: 56 }), undefined);
  assert.equal(toDiscoveredCopilotModel({ ...gpt56, id: '' }), undefined);
  assert.deepEqual(parseCopilotModelsResponse({ data: [gpt56, { id: 'hidden' }] }).map((model) => model.id), [
    'gpt-5.6-terra',
  ]);
});

test('maps endpoint metadata to a full catalog entry with conservative profile defaults', () => {
  const discovered = toDiscoveredCopilotModel(gpt56)!;
  const entry = toCatalogModel(discovered);

  assert.equal(entry.id, 'gpt-5.6-terra');
  assert.equal(entry.name, 'Copilot: GPT-5.6 Terra');
  assert.equal(entry.overrideOnly, undefined);
  assert.equal(entry.eligible, false);
  assert.match(String(entry.disabledReason), /not yet vetted/);
  assert.deepEqual((entry.pricing as { tiers: unknown[] }).tiers, discovered.cost.tiers);
});

test('catalog mapper preserves review policy and handles capability/cost defaults', () => {
  const discovered = toDiscoveredCopilotModel(gpt56)!;
  const existing = {
    id: discovered.id,
    eligible: true,
    thinking: ['high'],
    disabledReason: null,
    costRank: 17,
    reasoning: true,
    compat: { supportsStore: true },
    thinkingLevelMap: { high: 'high' },
  };
  const preserved = toCatalogModel({ ...discovered, compat: undefined, thinkingLevelMap: undefined }, existing);
  assert.equal(preserved.eligible, true);
  assert.deepEqual(preserved.thinking, ['high']);
  assert.equal(preserved.disabledReason, null);
  assert.equal(preserved.costRank, 17);
  assert.equal(preserved.reasoning, true);
  assert.deepEqual(preserved.compat, { supportsStore: true });
  assert.deepEqual(preserved.thinkingLevelMap, { high: 'high' });

  const noReasoning = { ...discovered, reasoning: false, thinkingLevelMap: undefined, cost: { ...discovered.cost, tiers: undefined } };
  assert.deepEqual(toCatalogModel(noReasoning).thinking, ['minimal']);
  assert.equal(toCatalogModel({ ...noReasoning, cost: { ...noReasoning.cost, input: 0.1 } }).costRank, 3);
  assert.equal(toCatalogModel({ ...noReasoning, cost: { ...noReasoning.cost, input: 1 } }).costRank, 6);
  assert.equal(toCatalogModel({ ...noReasoning, cost: { ...noReasoning.cost, input: 2.5 } }).costRank, 10);
  assert.equal(toCatalogModel({ ...noReasoning, cost: { ...noReasoning.cost, input: 5 } }).costRank, 25);
  assert.deepEqual(
    toCatalogModel({ ...noReasoning, thinkingLevelMap: { low: null } }).thinking,
    ['minimal'],
  );
});

test('reconciles the authoritative catalog, pruning stale models and transferring overrides', () => {
  const terra = toDiscoveredCopilotModel(gpt56)!;
  const novel = { ...terra, id: 'new-copilot-model', name: 'New Copilot Model' };
  const conflict = { ...terra, id: 'shared-full-model', name: 'Shared Full Model' };
  const input = `# catalog header
profileOrder:
  - stale-copilot
  - gpt-5.6-terra
  - shared-full-model
  - other-model
providers:
  github-copilot:
    apiKey: copilot
    models:
      - id: stale-copilot
        name: Stale
        pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
        eligible: true
        thinking: [minimal]
        disabledReason: null
        costRank: 1
  openai-codex:
    apiKey: oauth
    models:
      - id: gpt-5.6-terra
        name: Existing override
        overrideOnly: true
  custom: # keep provider comment
    apiKey: custom
    models:
      - id: shared-full-model
        name: Shared
  other:
    apiKey: other
    models:
      - id: other-model
        name: Other
`;

  const result = reconcileCatalogText(input, [terra, novel, conflict]);
  const source = parse(result.text) as {
    profileOrder: string[];
    providers: Record<string, { models: Array<{ id: string }> }>;
  };

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['stale-copilot']);
  assert.deepEqual(result.transferred, ['gpt-5.6-terra']);
  assert.deepEqual(result.skippedConflicts, ['shared-full-model']);
  assert.deepEqual(source.providers['github-copilot'].models.map((model) => model.id), [
    'gpt-5.6-terra', 'new-copilot-model',
  ]);
  assert.deepEqual(source.providers['openai-codex'].models, []);
  assert.deepEqual(source.profileOrder, ['new-copilot-model', 'gpt-5.6-terra', 'shared-full-model', 'other-model']);
  assert.match(result.text, /^# catalog header/m);
  assert.match(result.text, /# keep provider comment/);

  const idempotent = reconcileCatalogText(result.text, [terra, novel, conflict]);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.text, result.text);
});

test('catalog reconciliation rejects malformed or incomplete source YAML', () => {
  const model = toDiscoveredCopilotModel(gpt56)!;
  assert.throws(() => reconcileCatalogText('providers: [', [model]), /Invalid models.yaml/);
  assert.throws(() => reconcileCatalogText('profileOrder: []\nproviders: {}\n', [model]), /missing github-copilot/);
});
