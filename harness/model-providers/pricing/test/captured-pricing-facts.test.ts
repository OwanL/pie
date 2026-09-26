import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CapturedPricingFactsLoader } from '../captured-pricing-facts.js';

const CATALOG = {
  providers: {
    'provider-a': {
      models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
    },
  },
};

function fixtureAgentDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-captured-pricing-facts-'));
}

test('loader captures rates from the relocated generated historical pricing catalog', () => {
  const agentDir = fixtureAgentDir();
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(CATALOG));
    // The generated history catalog moved with the tracked analysis
    // workspace (B6); the retired top-level analysis path must not be read.
    const historyPath = path.join(agentDir, 'analytics', 'analysis', 'model-pricing-history.json');
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, JSON.stringify({
      models: [{ provider: 'provider-a', id: 'retired-model', cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } }],
    }));

    const loader = new CapturedPricingFactsLoader({ getAgentDir: () => agentDir });
    const facts = loader.get();
    assert.ok(facts);
    // The active catalog still wins its own model; the retired history-only
    // model is priced from the relocated catalog.
    assert.ok(facts.map.has('model-a'));
    assert.ok(facts.map.has('retired-model'));
    assert.match(facts.catalogVersion, /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('loader returns undefined without an agent dir or active catalog and caches by stat signature', () => {
  const agentDir = fixtureAgentDir();
  try {
    assert.equal(new CapturedPricingFactsLoader({ getAgentDir: () => null }).get(), undefined);
    assert.equal(new CapturedPricingFactsLoader({ getAgentDir: () => agentDir }).get(), undefined);

    const modelsPath = path.join(agentDir, 'models.json');
    writeFileSync(modelsPath, JSON.stringify(CATALOG));
    const loader = new CapturedPricingFactsLoader({ getAgentDir: () => agentDir });
    const first = loader.get();
    assert.ok(first);
    assert.equal(loader.get(), first, 'unchanged catalog stat reuses the cached facts');

    // A catalog rewrite invalidates the cached facts.
    utimesSync(modelsPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
        },
      },
    }));
    const second = loader.get();
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.map.get('model-a')?.[0]?.pricing.input, 1);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('loader ignores a malformed or missing relocated history catalog', () => {
  const agentDir = fixtureAgentDir();
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(CATALOG));
    const historyPath = path.join(agentDir, 'analytics', 'analysis', 'model-pricing-history.json');
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, 'not json');

    const loader = new CapturedPricingFactsLoader({ getAgentDir: () => agentDir });
    const facts = loader.get();
    assert.ok(facts);
    assert.ok(facts.map.has('model-a'));
    assert.ok(!facts.map.has('retired-model'));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});