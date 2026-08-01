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
