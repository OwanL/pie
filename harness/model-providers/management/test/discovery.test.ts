import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels } from '../discovery';
import { resolveProviderModelList } from '../../catalog/provider-model-resolution';

test('Ollama optional show failures retain complete identities and offline metadata', async () => {
  let active = 0, peak = 0;
  const snapshot = await discoverModels({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1', signal: new AbortController().signal,
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: ['gone', 'slow', 'offline', 'good', 'good'].map(name => ({ name })) });
      active++; peak = Math.max(peak, active);
      const model = JSON.parse(String(init?.body)).model;
      try {
        if (model === 'gone') return new Response(null, { status: 404 });
        if (model === 'offline') throw new TypeError('Network failure');
        if (model === 'slow') return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('Timeout')), { once: true }));
        return Response.json({ capabilities: ['completion'], parameters: 'num_ctx 8192' });
      } finally { active--; }
    } });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(Object.keys(snapshot.models), ['gone', 'slow', 'offline', 'good']);
  assert.ok(peak <= 4);
  for (const id of ['gone', 'slow', 'offline']) {
    assert.equal(snapshot.models[id].input, undefined);
    assert.equal(snapshot.models[id].pricing, undefined);
  }
  const resolved = resolveProviderModelList({ config: { version: 1, providers: { ollama: { enabled: true, modelOverrides: { gone: { maxTokens: 123 } } } } },
    shipped: { ollama: { models: { gone: { contextWindow: 8192, input: ['text'] } } } }, discovered: { ollama: snapshot } });
  assert.equal(resolved.providers.ollama.models.gone.metadata.contextWindow, 8192);
  assert.equal(resolved.providers.ollama.models.gone.metadata.maxTokens, 123);
  assert.equal(snapshot.models.gone.contextWindow, undefined);
});

test('Ollama user cancellation rejects despite abort-ignoring show; tags failures stay fatal', async () => {
  const controller = new AbortController();
  await assert.rejects(discoverModels({ kind: 'ollama', baseUrl: 'http://localhost:11434', signal: controller.signal,
    fetch: async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'slow' }] });
      controller.abort();
      return new Promise<Response>(() => {});
    } }));
  for (const fetch of [async () => new Response(null, { status: 500 }), async () => { throw new TypeError('Network failure'); }, async () => Response.json({ models: [{}] })])
    await assert.rejects(discoverModels({ kind: 'ollama', baseUrl: 'http://localhost:11434', signal: new AbortController().signal, fetch }));
});

test('Ollama caps enrichment at 64 identities without truncating authoritative tags', async () => {
  let shows = 0;
  const snapshot = await discoverModels({ kind: 'ollama', baseUrl: 'http://localhost:11434', signal: new AbortController().signal,
    fetch: async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: Array.from({ length: 70 }, (_, i) => ({ name: `model-${i}` })) });
      shows++; return Response.json({ capabilities: ['completion'] });
    } });
  assert.equal(shows, 64);
  assert.equal(Object.keys(snapshot.models).length, 70);
  assert.equal(snapshot.models['model-69'].input, undefined);
});

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
