import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('umans models mirror their ollama-cloud twin API pricing (opportunity-cost display)', () => {
  // Regression guard for the session cost indicator: umans is a $0/token
  // subscription, but its `cost` block must hold the underlying model's public
  // API rate (consistent with every other model) so the indicator shows an
  // opportunity cost instead of a misleading $0.00. Umans entries with an
  // Ollama Cloud twin mirror that twin's OpenRouter rate; proprietary umans
  // models with no public twin stay $0. See
  // docs/internal/model-token-pricing-sources.md § Umans Models.
  const modelsJsonPath = fileURLToPath(new URL('../../../../models.json', import.meta.url));
  const pricing = loadModelPricing(modelsJsonPath);

  const twins: Array<[string, string]> = [
    ['umans-glm-5.1', 'glm-5.1:cloud'],
    ['umans-glm-5.2', 'glm-5.2:cloud'],
    ['umans-kimi-k2.6', 'kimi-k2.6:cloud'],
    ['umans-kimi-k2.7', 'kimi-k2.7-code:cloud'],
  ];

  for (const [umansId, twinId] of twins) {
    const umansPricing = pricing.get(umansId)?.[0]?.pricing;
    const twinPricing = pricing.get(twinId)?.[0]?.pricing;
    assert.ok(umansPricing, `${umansId} missing from models.json`);
    assert.ok(twinPricing, `${twinId} missing from models.json`);
    assert.deepEqual(umansPricing, twinPricing, `${umansId} should mirror ${twinId} API pricing`);
  }

  // Proprietary umans models with no public API twin remain $0.
  for (const id of ['umans-coder', 'umans-flash', 'umans-qwen3.6-35b-a3b']) {
    const p = pricing.get(id)?.[0]?.pricing;
    assert.ok(p, `${id} missing from models.json`);
    assert.deepEqual(
      p,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      `${id} should remain $0 (no public API twin)`,
    );
  }
});
