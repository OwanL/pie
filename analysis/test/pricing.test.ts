import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeTokenCostUsd,
  estimateRunCostUsd,
  loadModelPricingMap,
  parseModelPricing,
  resolveModelsJsonPath,
  type ModelTokenPricing,
  type TokenUsageForCost,
} from '../scripts/pricing.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FREE_PRICING: ModelTokenPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PRICED: ModelTokenPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ~${expected}, got ${actual}`);
}

/** Create a temp models.json file with `contents`, run `fn(path)` synchronously, then clean up. */
function withTempModelsJson(contents: string, fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-pricing-test-'));
  const filePath = path.join(dir, 'models.json');
  try {
    fs.writeFileSync(filePath, contents, 'utf8');
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// parseModelPricing
// ---------------------------------------------------------------------------

test('parseModelPricing returns all four rate fields for a valid cost block', () => {
  assert.deepEqual(
    parseModelPricing({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  );
});

test('parseModelPricing defaults missing rate fields to 0 (free tier)', () => {
  // A cost block that only specifies input/output treats cache read/write as free.
  assert.deepEqual(
    parseModelPricing({ input: 0.25, output: 1.25 }),
    { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 },
  );
});

test('parseModelPricing rejects negative rates as invalid (whole record undefined)', () => {
  assert.equal(parseModelPricing({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test('parseModelPricing rejects non-number rate values', () => {
  assert.equal(
    parseModelPricing({ input: '3', output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
    undefined,
  );
});

test('parseModelPricing rejects NaN and Infinity rates', () => {
  assert.equal(parseModelPricing({ input: NaN, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), undefined);
  assert.equal(parseModelPricing({ input: Infinity, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), undefined);
});

test('parseModelPricing returns undefined for non-object inputs', () => {
  assert.equal(parseModelPricing(null), undefined);
  assert.equal(parseModelPricing(undefined), undefined);
  assert.equal(parseModelPricing([1, 2, 3, 4]), undefined);
  assert.equal(parseModelPricing('not-an-object'), undefined);
});

// ---------------------------------------------------------------------------
// computeTokenCostUsd
// ---------------------------------------------------------------------------

test('computeTokenCostUsd: 1M input tokens at $3/1M = $3 (rate unit is USD per 1M tokens)', () => {
  const usage: TokenUsageForCost = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  approx(computeTokenCostUsd(usage, PRICED), 3);
});

test('computeTokenCostUsd: 1M output tokens at $15/1M = $15', () => {
  const usage: TokenUsageForCost = { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  approx(computeTokenCostUsd(usage, PRICED), 15);
});

test('computeTokenCostUsd: weighted sum across all four token streams', () => {
  // input=1M@3 + output=2M@15 + cacheRead=4M@0.3 + cacheWrite=1M@3.75 = 3 + 30 + 1.2 + 3.75 = 37.95
  const usage: TokenUsageForCost = {
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheReadTokens: 4_000_000,
    cacheWriteTokens: 1_000_000,
  };
  approx(computeTokenCostUsd(usage, PRICED), 37.95);
});

test('computeTokenCostUsd selects long-context tiers from the full prompt footprint', () => {
  const pricing: ModelTokenPricing = {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 1,
    tiers: [{ inputTokensAbove: 200_000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 }],
  };
  const below = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 };
  const above = { ...below, cacheReadTokens: 100_001 };
  approx(computeTokenCostUsd(below, pricing), 0.13);
  approx(computeTokenCostUsd(above, pricing), 0.25);
});

test('computeTokenCostUsd: zero tokens = $0 even with positive rates', () => {
  const usage: TokenUsageForCost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(computeTokenCostUsd(usage, PRICED), 0);
});

test('computeTokenCostUsd: free model (all rates 0) always costs $0', () => {
  const usage: TokenUsageForCost = {
    inputTokens: 5_000_000,
    outputTokens: 5_000_000,
    cacheReadTokens: 5_000_000,
    cacheWriteTokens: 5_000_000,
  };
  assert.equal(computeTokenCostUsd(usage, FREE_PRICING), 0);
});

test('computeTokenCostUsd rounds sub-micro-dollar costs to the nearest micro-dollar', () => {
  // 1 cache-read token at $0.3/1M = 3e-7 USD = 0.3 micro-dollars → rounds down to 0.
  const subHalf: TokenUsageForCost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 };
  assert.equal(computeTokenCostUsd(subHalf, { input: 0, output: 0, cacheRead: 0.3, cacheWrite: 0 }), 0);
  // 2 cache-read tokens at $0.3/1M = 6e-7 USD = 0.6 micro-dollars → rounds up to 1 micro-dollar (1e-6).
  const aboveHalf: TokenUsageForCost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 };
  approx(computeTokenCostUsd(aboveHalf, { input: 0, output: 0, cacheRead: 0.3, cacheWrite: 0 }), 1e-6);
});

// ---------------------------------------------------------------------------
// estimateRunCostUsd
// ---------------------------------------------------------------------------

test('estimateRunCostUsd returns null for a null/undefined/empty model id', () => {
  const map = new Map([['m1', PRICED]]);
  const usage: TokenUsageForCost = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateRunCostUsd(null, usage, map), null);
  assert.equal(estimateRunCostUsd(undefined, usage, map), null);
  assert.equal(estimateRunCostUsd('', usage, map), null);
});

test('estimateRunCostUsd returns null when the model has no pricing entry (missing rate → graceful)', () => {
  const map = new Map<string, ModelTokenPricing>();
  const usage: TokenUsageForCost = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateRunCostUsd('unknown-model', usage, map), null);
});

test('estimateRunCostUsd returns a meaningful 0 (not null) for a free model with usage', () => {
  // A known model priced at $0 everywhere must report $0 — distinct from unknown pricing (null).
  const map = new Map([['free-local', FREE_PRICING]]);
  const usage: TokenUsageForCost = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };
  assert.equal(estimateRunCostUsd('free-local', usage, map), 0);
});

test('estimateRunCostUsd returns $0 for a known priced model with zero usage', () => {
  const map = new Map([['m1', PRICED]]);
  const usage: TokenUsageForCost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateRunCostUsd('m1', usage, map), 0);
});

test('estimateRunCostUsd computes the known cost for a priced model', () => {
  const map = new Map([['m1', PRICED]]);
  const usage: TokenUsageForCost = { inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // 1M@3 + 2M@15 = 3 + 30 = 33
  approx(estimateRunCostUsd('m1', usage, map)!, 33);
});

test('default pricing includes retired models without restoring them to the active catalog', () => {
  const map = loadModelPricingMap();
  const retired = map.get('github-copilot/gpt-5.4');
  assert.equal(retired?.input, 2.5);
  assert.equal(retired?.output, 15);
  assert.equal(retired?.cacheRead, 0.25);
  assert.equal(retired?.cacheWrite, 0);
  assert.equal(map.get('gpt-5.4'), undefined, 'same-id provider collisions must not create a bare fallback');
});

test('active pricing takes precedence over an explicit historical collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-pricing-history-test-'));
  const modelsPath = path.join(dir, 'models.json');
  const historyPath = path.join(dir, 'history.json');
  try {
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { active: { models: [{ id: 'shared', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } }] } },
    }));
    fs.writeFileSync(historyPath, JSON.stringify({
      models: [{ provider: 'active', id: 'shared', name: 'retired', cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } }],
    }));
    const map = loadModelPricingMap(modelsPath, historyPath);
    assert.deepEqual(map.get('active/shared'), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
    assert.deepEqual(map.get('shared'), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateRunCostUsd does not borrow same-id pricing from another provider', () => {
  const githubPricing = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };
  const map = new Map([
    ['gpt-5.6-sol', githubPricing],
    ['github-copilot/gpt-5.6-sol', githubPricing],
  ]);
  const usage: TokenUsageForCost = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateRunCostUsd('gpt-5.6-sol', usage, map, 'openai-codex'), null);
  assert.equal(estimateRunCostUsd('gpt-5.6-sol', usage, map, 'github-copilot'), 5);
});

// ---------------------------------------------------------------------------
// resolveModelsJsonPath
// ---------------------------------------------------------------------------

test('resolveModelsJsonPath prefers explicit arg over the PIE_MODELS_JSON env var', () => {
  const prev = process.env.PIE_MODELS_JSON;
  process.env.PIE_MODELS_JSON = '/from/env/models.json';
  try {
    assert.equal(resolveModelsJsonPath('/explicit/path.json'), '/explicit/path.json');
    assert.equal(resolveModelsJsonPath(), '/from/env/models.json');
  } finally {
    if (prev === undefined) delete process.env.PIE_MODELS_JSON;
    else process.env.PIE_MODELS_JSON = prev;
  }
});

// ---------------------------------------------------------------------------
// loadModelPricingMap (exercises the private addRecord accumulation path)
// ---------------------------------------------------------------------------

test('loadModelPricingMap accumulates models from providers.models arrays', () => {
  const json = JSON.stringify({
    providers: {
      anthropic: {
        models: [
          { id: 'opus', cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
          { id: 'haiku', cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 } },
        ],
      },
    },
  });
  withTempModelsJson(json, (filePath) => {
    const map = loadModelPricingMap(filePath);
    assert.equal(map.size, 4);
    assert.deepEqual(map.get('opus'), { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 });
    assert.deepEqual(map.get('haiku'), { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 });
  });
});

test('loadModelPricingMap also accumulates provider.modelOverrides entries', () => {
  const json = JSON.stringify({
    providers: {
      anthropic: {
        models: [{ id: 'opus', cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } }],
        modelOverrides: {
          'opus-discount': { cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
        },
      },
    },
  });
  withTempModelsJson(json, (filePath) => {
    const map = loadModelPricingMap(filePath);
    assert.equal(map.size, 4);
    assert.deepEqual(map.get('opus-discount'), { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
  });
});

test('loadModelPricingMap removes the bare fallback for same-id provider collisions', () => {
  // 'dupe' appears in two providers; provider/model keys retain both prices.
  const json = JSON.stringify({
    providers: {
      anthropic: { models: [{ id: 'dupe', cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }] },
      openai: { models: [{ id: 'dupe', cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }] },
    },
  });
  withTempModelsJson(json, (filePath) => {
    const map = loadModelPricingMap(filePath);
    assert.equal(map.size, 2);
    assert.equal(map.get('dupe'), undefined);
    assert.deepEqual(map.get('anthropic/dupe'), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    assert.deepEqual(map.get('openai/dupe'), { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
  });
});

test('loadModelPricingMap skips models without a valid cost block or string id', () => {
  const json = JSON.stringify({
    providers: {
      anthropic: {
        models: [
          { id: 'priced', cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
          { id: 'no-cost' }, // no cost block → skipped
          { id: 'bad-cost', cost: { input: -1, output: 2, cacheRead: 3, cacheWrite: 4 } }, // negative → invalid
          { id: 123, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, // non-string id → skipped
        ],
      },
    },
  });
  withTempModelsJson(json, (filePath) => {
    const map = loadModelPricingMap(filePath);
    assert.equal(map.size, 2);
    assert.ok(map.has('priced'));
    assert.ok(!map.has('no-cost'));
    assert.ok(!map.has('bad-cost'));
  });
});

test('loadModelPricingMap returns an empty map for a missing file (never throws)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-pricing-test-'));
  try {
    const missing = path.join(dir, 'does-not-exist.json');
    assert.equal(loadModelPricingMap(missing).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadModelPricingMap returns an empty map for malformed JSON', () => {
  withTempModelsJson('{not valid json', (filePath) => {
    assert.equal(loadModelPricingMap(filePath).size, 0);
  });
});

test('loadModelPricingMap returns an empty map when providers is absent or malformed', () => {
  withTempModelsJson(JSON.stringify({}), (filePath) => {
    assert.equal(loadModelPricingMap(filePath).size, 0);
  });
  withTempModelsJson(JSON.stringify({ providers: [] }), (filePath) => {
    assert.equal(loadModelPricingMap(filePath).size, 0);
  });
  withTempModelsJson(JSON.stringify({ providers: 'nope' }), (filePath) => {
    assert.equal(loadModelPricingMap(filePath).size, 0);
  });
});
