import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModelPricing } from '../../../src/backend/pricing';

test('loadModelPricing reads array models and Copilot modelOverrides', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-pricing-'));
  try {
    const file = path.join(dir, 'models.json');
    writeFileSync(file, JSON.stringify({
      providers: {
        ollama: {
          models: [
            { id: 'local-model', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          ],
        },
        'github-copilot': {
          modelOverrides: {
            'gpt-5.5': { cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
          },
        },
      },
    }));

    const pricing = loadModelPricing(file);

    assert.deepEqual(pricing.get('local-model')?.[0]?.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(pricing.get('gpt-5.5')?.[0]?.pricing, { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
    assert.equal(pricing.get('gpt-5.5')?.[0]?.provider, 'github-copilot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadModelPricing merges retired cloud-model pricing without overriding active records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-pricing-history-'));
  try {
    const modelsFile = path.join(dir, 'models.json');
    const historyFile = path.join(dir, 'model-pricing-history.json');
    writeFileSync(modelsFile, JSON.stringify({
      providers: {
        ollama: {
          models: [
            { id: 'still-active:cloud', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
          ],
        },
      },
    }));
    writeFileSync(historyFile, JSON.stringify({
      models: [
        { provider: 'ollama', id: 'retired:cloud', cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 } },
        { provider: 'ollama', id: 'still-active:cloud', cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } },
      ],
    }));

    const pricing = loadModelPricing(modelsFile, historyFile);

    assert.deepEqual(pricing.get('retired:cloud'), [{
      id: 'retired:cloud',
      provider: 'ollama',
      pricing: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 },
    }]);
    assert.deepEqual(pricing.get('still-active:cloud')?.[0]?.pricing, {
      input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0,
    });
    assert.equal(pricing.get('still-active:cloud')?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
