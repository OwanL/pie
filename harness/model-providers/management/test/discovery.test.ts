import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels } from '../discovery';

test('Copilot listings never publish normalized costs as USD pricing', async () => {
  const snapshot = await discoverModels({ kind: 'copilot', baseUrl: 'https://example.invalid',
    signal: new AbortController().signal,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'listed', name: 'Listed',
      model_picker_enabled: true, capabilities: { limits: { max_context_window_tokens: 1000, max_output_tokens: 100 } },
      billing: { token_prices: { default: { input_price: 0, output_price: 0 } } },
    }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(snapshot.models.listed.pricing, 'unknown');
  assert.equal(snapshot.models.listed.contextWindow, 1000);
});
