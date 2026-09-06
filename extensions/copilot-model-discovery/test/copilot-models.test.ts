import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../../../extension/node_modules/yaml/dist/index.js';

import { withCatalogLock } from '../src/catalog-lock.js';
import { CopilotCatalogRefreshCoordinator } from '../src/catalog-refresh.js';
import { FileCatalogRefreshTiming } from '../src/catalog-ttl.js';
import { reconcileCatalogText, toCatalogModel } from '../src/catalog-sync.js';
import {
  isSelectableCopilotModel,
  parseCopilotModelsResponse,
  toDiscoveredCopilotModel,
} from '../src/copilot-models.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface SyncModule {
  loadSource: (root?: string) => unknown;
}

async function loadSyncModule(): Promise<SyncModule> {
  const script = path.join(repoRoot, 'scripts', 'sync-models.mjs');
  return (await import(pathToFileURL(script).href)) as SyncModule;
}

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
        cache_read_price: 25,
        cache_write_price: 312,
        max_prompt_tokens: 272000,
      },
      long_context: {
        input_price: 500,
        output_price: 2250,
        cache_read_price: 50,
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

test('maps newly discovered Responses models to the default context tier and preserves long-context prices', () => {
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
    contextWindow: 272000,
    maxTokens: 128000,
  });
});

test('supports legacy Copilot default-limit and cache-price field names', () => {
  const tokenPrices = structuredClone(gpt56.billing.token_prices) as {
    default: Record<string, unknown>;
    long_context: Record<string, unknown>;
  };
  tokenPrices.default.context_max = tokenPrices.default.max_prompt_tokens;
  tokenPrices.default.cache_price = tokenPrices.default.cache_read_price;
  tokenPrices.long_context.cache_price = tokenPrices.long_context.cache_read_price;
  delete tokenPrices.default.max_prompt_tokens;
  delete tokenPrices.default.cache_read_price;
  delete tokenPrices.long_context.cache_read_price;

  const model = toDiscoveredCopilotModel({ ...gpt56, billing: { token_prices: tokenPrices } });
  assert.equal(model?.contextWindow, 272000);
  assert.equal(model?.cost.cacheRead, 0.25);
  assert.equal(model?.cost.tiers?.[0].cacheRead, 0.5);
});

test('rejects an extended tier without a valid default context limit', () => {
  for (const contextMax of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 272000.5, '272000']) {
    const tokenPrices = structuredClone(gpt56.billing.token_prices) as {
      default: Record<string, unknown>;
    };
    if (contextMax === undefined) delete tokenPrices.default.max_prompt_tokens;
    else tokenPrices.default.max_prompt_tokens = contextMax;

    assert.throws(
      () => toDiscoveredCopilotModel({ ...gpt56, billing: { token_prices: tokenPrices } }),
      /extended context tier without a valid default context limit/,
    );
  }
});

test('uses the full capability for a single-tier model with no published default limit', () => {
  const model = toDiscoveredCopilotModel({
    ...gpt56,
    billing: { token_prices: { default: { input_price: 250, output_price: 1500 } } },
  });

  assert.equal(model?.contextWindow, 1050000);
  assert.equal(model?.cost.tiers, undefined);
});

test('uses a conservative context fallback when a single-tier model publishes no valid limit', () => {
  const model = toDiscoveredCopilotModel({
    ...gpt56,
    billing: { token_prices: { default: { input_price: 250, output_price: 1500 } } },
    capabilities: {
      ...gpt56.capabilities,
      limits: { ...gpt56.capabilities.limits, max_context_window_tokens: -1 },
    },
  });

  assert.equal(model?.contextWindow, 128000);
});

test('clamps a malformed default limit to the advertised capability maximum', () => {
  const model = toDiscoveredCopilotModel({
    ...gpt56,
    billing: {
      token_prices: {
        ...gpt56.billing.token_prices,
        default: { ...gpt56.billing.token_prices.default, max_prompt_tokens: 2000000 },
      },
    },
  });

  assert.equal(model?.contextWindow, 1050000);
  assert.equal(model?.cost.tiers?.[0].inputTokensAbove, 1050000);
});

test('honors a published default limit even when no extended price tier exists', () => {
  const model = toDiscoveredCopilotModel({
    ...gpt56,
    billing: { token_prices: { default: gpt56.billing.token_prices.default } },
  });

  assert.equal(model?.contextWindow, 272000);
  assert.equal(model?.cost.tiers, undefined);
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
  assert.equal(entry.contextWindow, 272000);
  assert.match(String(entry.disabledReason), /not yet vetted/);
  assert.deepEqual((entry.pricing as { tiers: unknown[] }).tiers, discovered.cost.tiers);
});

test('catalog mapper preserves review policy and capability defaults', () => {
  const discovered = toDiscoveredCopilotModel(gpt56)!;
  const existing = {
    id: discovered.id,
    eligible: true,
    thinking: ['high'],
    disabledReason: null,
    reasoning: true,
    compat: { supportsStore: true },
    thinkingLevelMap: { high: 'high' },
  };
  const preserved = toCatalogModel({ ...discovered, compat: undefined, thinkingLevelMap: undefined }, existing);
  assert.equal(preserved.eligible, true);
  assert.deepEqual(preserved.thinking, ['high']);
  assert.equal(preserved.disabledReason, null);
  assert.equal(preserved.reasoning, true);
  assert.deepEqual(preserved.compat, { supportsStore: true });
  assert.deepEqual(preserved.thinkingLevelMap, { high: 'high' });

  const noReasoning = { ...discovered, reasoning: false, thinkingLevelMap: undefined, cost: { ...discovered.cost, tiers: undefined } };
  assert.deepEqual(toCatalogModel(noReasoning).thinking, ['minimal']);
  assert.deepEqual(
    toCatalogModel({ ...noReasoning, thinkingLevelMap: { low: null } }).thinking,
    ['minimal'],
  );
});

test('catalog mapper preserves an existing maxImagesPerRequest for image-capable models', () => {
  const discovered = toDiscoveredCopilotModel(gpt56)!;
  const existing = {
    id: discovered.id,
    eligible: true,
    thinking: ['high'],
    disabledReason: null,
    maxImagesPerRequest: 7,
  };
  const preserved = toCatalogModel(discovered, existing);
  assert.equal(preserved.input, discovered.input);
  assert.equal(preserved.maxImagesPerRequest, 7, 'an existing explicit maximum is preserved across reconciliation');
});

test('catalog mapper defaults maxImagesPerRequest to one for newly discovered image-capable models', () => {
  const discovered = toDiscoveredCopilotModel(gpt56)!;
  const entry = toCatalogModel(discovered);
  assert.equal(entry.maxImagesPerRequest, 1, 'new image-capable models get the conservative fail-safe of one');
  assert.deepEqual(entry.input, ['text', 'image']);
});

test('catalog mapper omits maxImagesPerRequest for text-only discovered models', () => {
  const textOnly = toDiscoveredCopilotModel({
    ...gpt56,
    capabilities: { ...gpt56.capabilities, supports: { ...gpt56.capabilities.supports, vision: false } },
  })!;
  assert.deepEqual(textOnly.input, ['text']);
  const entry = toCatalogModel(textOnly, { id: textOnly.id, maxImagesPerRequest: 4 });
  assert.equal(entry.maxImagesPerRequest, undefined, 'a text-only model must not declare a positive image maximum');
});

test('reconciliation preserves maxImagesPerRequest and stays idempotent', () => {
  const terra = toDiscoveredCopilotModel(gpt56)!;
  const input = `profileOrder:
  - gpt-5.6-terra
providers:
  github-copilot:
    apiKey: copilot
    models:
      - id: gpt-5.6-terra
        name: "Copilot: GPT-5.6 Terra"
        api: openai-responses
        reasoning: true
        input: [text, image]
        maxImagesPerRequest: 6
        contextWindow: 1050000
        maxTokens: 128000
        pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.12 }
        eligible: true
        thinking: [low, medium, high]
        disabledReason: null
`;
  const result = reconcileCatalogText(input, [terra]);
  const source = parse(result.text) as {
    providers: Record<string, { models: Array<{ id: string; maxImagesPerRequest?: number }> }>;
  };
  assert.equal(source.providers['github-copilot'].models[0].maxImagesPerRequest, 6, 'reconciliation preserves the explicit maximum');
  const idempotent = reconcileCatalogText(result.text, [terra]);
  assert.equal(idempotent.changed, false, 'a catalog with a preserved maximum is idempotent');
  assert.equal(idempotent.text, result.text);
});

test('reconciliation seeds the conservative default for a newly discovered image-capable model', () => {
  const terra = toDiscoveredCopilotModel(gpt56)!;
  const input = `profileOrder: []
providers:
  github-copilot:
    apiKey: copilot
    models: []
`;
  const result = reconcileCatalogText(input, [terra]);
  const source = parse(result.text) as {
    providers: Record<string, { models: Array<{ id: string; maxImagesPerRequest?: number }> }> };
  assert.equal(source.providers['github-copilot'].models[0].maxImagesPerRequest, 1);
});

test('reconciles Copilot without deleting same-id models owned by other providers', () => {
  const terra = toDiscoveredCopilotModel(gpt56)!;
  const novel = { ...terra, id: 'new-copilot-model', name: 'New Copilot Model' };
  const shared = { ...terra, id: 'shared-full-model', name: 'Shared Full Model' };
  const input = `# catalog header
profileOrder:
  - stale-copilot
  - provider: openai-codex
    id: gpt-5.6-terra
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

  const result = reconcileCatalogText(input, [terra, novel, shared]);
  const source = parse(result.text) as {
    profileOrder: Array<string | { provider: string; id: string }>;
    providers: Record<string, { models: Array<{ id: string }> }>;
  };

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['stale-copilot']);
  assert.deepEqual(source.providers['github-copilot'].models.map((model) => model.id), [
    'gpt-5.6-terra', 'new-copilot-model', 'shared-full-model',
  ]);
  assert.deepEqual(source.providers['openai-codex'].models.map((model) => model.id), ['gpt-5.6-terra']);
  assert.deepEqual(source.providers.custom.models.map((model) => model.id), ['shared-full-model']);
  assert.deepEqual(source.profileOrder, [
    { provider: 'github-copilot', id: 'gpt-5.6-terra' },
    'new-copilot-model',
    { provider: 'github-copilot', id: 'shared-full-model' },
    { provider: 'openai-codex', id: 'gpt-5.6-terra' },
    { provider: 'custom', id: 'shared-full-model' },
    'other-model',
  ]);
  assert.match(result.text, /^# catalog header/m);
  assert.match(result.text, /# keep provider comment/);

  const idempotent = reconcileCatalogText(result.text, [terra, novel, shared]);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.text, result.text);
});

test('reactivating a retired Copilot model removes only its matching historical identity', async () => {
  const reactivated = {
    ...toDiscoveredCopilotModel(gpt56)!,
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    cost: {
      input: 1.25,
      output: 6.25,
      cacheRead: 0.125,
      cacheWrite: 1.5625,
    },
  };
  const input = `defaults: { model: existing-model, provider: custom, thinkingLevel: minimal }
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 1
  provider: { maxRetries: 1, maxRetryDelayMs: 1 }
pruning: { model: existing-model, provider: custom, thinkingLevel: minimal }
sessionTitles: { enabled: false, model: existing-model, provider: custom, thinkingLevel: minimal, timeoutSec: 15 }
profileOrder:
  - existing-model
providers:
  github-copilot:
    apiKey: copilot
    models: []
  custom:
    apiKey: custom
    models:
      - id: existing-model
        name: Existing
        pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
        eligible: true
        thinking: [minimal]
        disabledReason: null
historicalModels:
  - provider: github-copilot
    id: claude-haiku-4.5
    name: "Copilot: Claude Haiku 4.5"
    family: claude-haiku
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
  - provider: custom
    id: claude-haiku-4.5
    name: "Custom: Claude Haiku 4.5"
    pricing: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 }
  - provider: github-copilot
    id: still-retired
    name: "Copilot: Still Retired"
    pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }
`;

  const result = reconcileCatalogText(input, [reactivated]);
  const source = parse(result.text) as {
    profileOrder: Array<string | { provider: string; id: string }>;
    providers: Record<string, { models: Array<{ id: string; pricing: Record<string, number> }> }>;
    historicalModels: Array<{ provider: string; id: string; pricing: Record<string, number> }>;
  };

  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ['claude-haiku-4.5']);
  assert.deepEqual(source.providers['github-copilot'].models.map((model) => model.id), ['claude-haiku-4.5']);
  assert.deepEqual(source.providers['github-copilot'].models[0].pricing, reactivated.cost);
  assert.deepEqual(
    source.historicalModels.map(({ provider, id }) => ({ provider, id })),
    [
      { provider: 'custom', id: 'claude-haiku-4.5' },
      { provider: 'github-copilot', id: 'still-retired' },
    ],
    'only the reactivated provider-qualified identity leaves historicalModels',
  );
  assert.deepEqual(source.historicalModels[0].pricing, {
    input: 9,
    output: 9,
    cacheRead: 0,
    cacheWrite: 0,
  }, 'unrelated historical pricing remains intact');

  const directory = await mkdtemp(path.join(tmpdir(), 'pie-copilot-reactivation-'));
  try {
    await copyFile(path.join(repoRoot, 'models.schema.json'), path.join(directory, 'models.schema.json'));
    await writeFile(path.join(directory, 'models.yaml'), result.text, 'utf8');
    const sync = await loadSyncModule();
    assert.doesNotThrow(
      () => sync.loadSource(directory),
      'the reconciled source must satisfy sync-models schema and identity invariants',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const idempotent = reconcileCatalogText(result.text, [reactivated]);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.text, result.text);
});

test('coalesces concurrent startup refreshes and refreshes every live registry', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const coordinator = new CopilotCatalogRefreshCoordinator(async () => {
    runs += 1;
    await blocked;
  });
  const refreshes: string[] = [];
  const first = { refresh: () => refreshes.push('first') };
  const second = { refresh: () => refreshes.push('second') };

  const firstRefresh = coordinator.refresh(first);
  const secondRefresh = coordinator.refresh(second);
  assert.equal(runs, 1);

  release();
  await Promise.all([firstRefresh, secondRefresh]);
  assert.deepEqual(refreshes, ['first', 'second']);
});

test('serializes catalog writes from independent refresh coordinators', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pie-copilot-lock-'));
  const lockPath = path.join(directory, 'catalog.lock');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];

  try {
    const first = withCatalogLock(lockPath, async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    }, { retryDelayMs: 5 });
    while (!events.includes('first:start')) await new Promise((resolve) => setTimeout(resolve, 1));

    const second = withCatalogLock(lockPath, async () => {
      events.push('second:start');
      events.push('second:end');
    }, { retryDelayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['first:start']);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries discovery after a failed startup refresh', async () => {
  let attempts = 0;
  const coordinator = new CopilotCatalogRefreshCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary failure');
  });
  const registry = { refresh: () => undefined };

  await assert.rejects(() => coordinator.refresh(registry), /temporary failure/);
  await coordinator.refresh(registry);
  assert.equal(attempts, 2);
});

test('catalog reconciliation rejects malformed or incomplete source YAML', () => {
  const model = toDiscoveredCopilotModel(gpt56)!;
  assert.throws(() => reconcileCatalogText('providers: [', [model]), /Invalid models.yaml/);
  assert.throws(() => reconcileCatalogText('profileOrder: []\nproviders: {}\n', [model]), /missing github-copilot/);
});

test('TTL marker treats missing, corrupt, or non-numeric markers as stale', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pie-copilot-ttl-'));
  const markerPath = path.join(directory, 'sync.json');
  const timing = new FileCatalogRefreshTiming(markerPath, 1000);
  try {
    assert.equal(await timing.isFresh(), false, 'a missing marker is stale');

    await writeFile(markerPath, 'not json', 'utf8');
    assert.equal(await timing.isFresh(), false, 'an unparseable marker is stale');

    await writeFile(markerPath, JSON.stringify({ lastRefreshMs: 'oops' }), 'utf8');
    assert.equal(await timing.isFresh(), false, 'a non-numeric marker is stale');

    // 1e309 parses to Infinity: a number that is not finite.
    await writeFile(markerPath, '{"lastRefreshMs":1e309}', 'utf8');
    assert.equal(await timing.isFresh(), false, 'a non-finite marker is stale');

    await writeFile(markerPath, JSON.stringify({ lastRefreshMs: Date.now() + 60_000 }), 'utf8');
    assert.equal(await timing.isFresh(), false, 'a future marker is stale');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TTL marker is fresh within the window and stale once it elapses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pie-copilot-ttl-'));
  const markerPath = path.join(directory, 'sync.json');
  const timing = new FileCatalogRefreshTiming(markerPath, 1000);
  try {
    await timing.markRefreshed();
    assert.equal(await timing.isFresh(), true, 'a just-recorded marker is fresh');

    await writeFile(markerPath, JSON.stringify({ lastRefreshMs: Date.now() - 2000 }), 'utf8');
    assert.equal(await timing.isFresh(), false, 'a marker older than the TTL is stale');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
