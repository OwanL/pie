import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithTransientRetry } from '../../../lib/temporary-files/atomic-write';
import { COPILOT_HEADERS, parseCopilotModelsResponse } from '../model-discovery/copilot-models';
import type { ProviderCatalogSnapshot, ProviderModelMetadata } from '../catalog/provider-model-resolution';

export function parseOpenAIModels(value: unknown): Record<string, ProviderModelMetadata> {
  const data = (value as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Invalid model listing');
  const models: Record<string, ProviderModelMetadata> = Object.create(null);
  for (const item of data) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || (item.name !== undefined && typeof item.name !== 'string')) throw new Error('Invalid model listing');
    models[item.id] = { ...(item.name ? { name: item.name } : {}), pricing: 'unknown' };
  }
  return models;
}
export async function discoverModels(options: { kind: 'openai' | 'copilot' | 'ollama'; baseUrl: string; key?: string; fetch: typeof globalThis.fetch; signal: AbortSignal }): Promise<ProviderCatalogSnapshot> {
  if (options.kind === 'ollama') return discoverOllamaModels(options);
  const response = await options.fetch(`${options.baseUrl.replace(/\/$/, '')}/models`, { signal: options.signal,
    headers: { ...(options.kind === 'copilot' ? COPILOT_HEADERS : {}), ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}) } });
  if (!response.ok) throw new Error('Model listing failed');
  const json: unknown = await response.json();
  const models: Record<string, ProviderModelMetadata> = Object.create(null);
  if (options.kind === 'openai') Object.assign(models, parseOpenAIModels(json));
  else for (const model of parseCopilotModelsResponse(json)) models[model.id] = { name: model.name, api: model.api, reasoning: model.reasoning,
    input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, pricing: 'unknown' };
  return { kind: 'account', complete: true, freshness: 'fresh', models };
}
/** Ollama's OpenAI bridge is /v1; discovery stays on the same daemon origin. */
export function normalizeOllamaBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('Invalid Ollama endpoint');
  url.pathname = '/v1';
  return url.href;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const remote = (value: Record<string, unknown>) => Object.hasOwn(value, 'remote_model') || Object.hasOwn(value, 'remote_host');
async function discoverOllamaModels(options: { baseUrl: string; fetch: typeof globalThis.fetch; signal: AbortSignal }): Promise<ProviderCatalogSnapshot> {
  const origin = new URL(normalizeOllamaBaseUrl(options.baseUrl)).origin;
  const listing = await options.fetch(`${origin}/api/tags`, { signal: options.signal, redirect: 'error' });
  if (!listing.ok) throw new Error('Model listing failed');
  const json: unknown = await listing.json();
  if (!object(json) || !Array.isArray(json.models) || json.models.length > 1000) throw new Error('Invalid model listing');
  const models: Record<string, ProviderModelMetadata> = Object.create(null);
  const listedTags = json.models;
  // Validate the authoritative listing before optional metadata-only enrichment.
  for (const tag of json.models) {
    if (!object(tag) || typeof tag.name !== 'string' || !tag.name.trim() || tag.name.length > 2048) throw new Error('Invalid model listing');
    // Native daemons can list the same identity more than once. Retain any remote evidence.
    models[tag.name] = { ...models[tag.name], name: tag.name, ...(remote(tag) ? { execution: 'remote' as const } : {}) };
  }
  const tags = Object.keys(models).map(name => listedTags.find(tag => tag.name === name));
  let next = 0;
  const enrich = async () => {
  while (next < Math.min(tags.length, 64)) {
    options.signal.throwIfAborted();
    const tag = tags[next++];
    let metadata: ProviderModelMetadata = models[tag.name];
    {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal.addEventListener('abort', cancel, { once: true });
      // Four workers, at most 64 probes, 500ms including body parsing per probe:
      // enrichment is bounded to eight seconds, below the service's ten-second TTL refresh deadline.
      const timer = setTimeout(cancel, 500);
      let rejectAbort: (() => void) | undefined;
      try {
        const show: unknown = await Promise.race([
          (async () => {
            const response = await options.fetch(`${origin}/api/show`, { method: 'POST', signal: controller.signal,
              redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: tag.name }) });
            return response.ok ? response.json() : undefined;
          })(),
          new Promise<never>((_, reject) => {
            rejectAbort = () => reject(new Error('Metadata probe cancelled'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            if (controller.signal.aborted) rejectAbort();
          }),
        ]);
        if (show !== undefined) {
          if (object(show)) {
            const capabilities = show.capabilities;
            const supported = Array.isArray(capabilities) && capabilities.every(c => typeof c === 'string') && capabilities.includes('completion');
            const limits: { contextWindow?: number; maxTokens?: number } = {};
            // GGUF context_length is an architectural ceiling, not a serving limit.
            // Only explicit positive Modelfile serving parameters supply request limits.
            if (typeof show.parameters === 'string' && show.parameters.length < 65536) {
              for (const [parameter, field] of [['num_ctx', 'contextWindow'], ['num_predict', 'maxTokens']] as const) {
                const matches = [...show.parameters.matchAll(new RegExp(`^${parameter}\\s+(\\d+)\\s*$`, 'gm'))];
                if (matches.length === 1) {
                  const n = Number(matches[0][1]); if (Number.isSafeInteger(n) && n > 0) limits[field] = n;
                }
              }
            }
            const local = metadata.execution !== 'remote' && !remote(tag) && !remote(show) && !tag.name.endsWith('-cloud') && !tag.name.endsWith(':cloud')
              && object(tag.details) && tag.details.format === 'gguf'
              && object(show.model_info) && typeof show.model_info['general.architecture'] === 'string';
            metadata = { ...metadata, ...limits,
              ...(remote(show) ? { execution: 'remote' as const } : {}),
              ...(supported ? { input: capabilities.includes('vision') ? ['text', 'image'] as const : ['text'] as const,
                reasoning: capabilities.includes('thinking') } : {}),
              ...(local ? { pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}) };
          }
        }
      } catch { options.signal.throwIfAborted(); /* Optional metadata remains absent; shipped metadata and explicit overrides still apply. */ }
      finally {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', cancel);
        if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      }
    }
    options.signal.throwIfAborted();
    models[tag.name] = metadata;
  }
  };
  await Promise.all(Array.from({ length: Math.min(4, json.models.length) }, enrich));
  options.signal.throwIfAborted();
  return { kind: 'account', complete: true, freshness: 'fresh', models };
}
const filename = (directory: string, id: string) => join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
export async function loadDiscoveryCache(directory: string, id: string, provenance: string): Promise<ProviderCatalogSnapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(filename(directory, id), 'utf8'));
    if (value.id === id && value.provenance !== provenance) return;
    // Older observations did not retain remote alias evidence; refresh rather than trust them.
    if (value.version === 1) return;
    if (value.version !== 2 || value.id !== id || (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0)
      || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) throw new Error('Invalid model cache');
    for (const [key, model] of Object.entries(value.models)) {
      if (!key.trim() || !model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Invalid model cache');
      const m = model as ProviderModelMetadata;
      if (Object.keys(m).some(field => !['name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'api', 'baseUrl', 'pricing', 'execution'].includes(field))) throw new Error('Invalid model cache');
      if (m.execution !== undefined && m.execution !== 'remote') throw new Error('Invalid model cache');
      if (m.api !== undefined && !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(m.api)) throw new Error('Invalid model cache');
      if (m.baseUrl !== undefined) {
        const endpoint = new URL(m.baseUrl);
        if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid model cache');
      }
      if (m.name !== undefined && typeof m.name !== 'string') throw new Error('Invalid model cache');
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') throw new Error('Invalid model cache');
      if (m.input !== undefined && (!Array.isArray(m.input) || !m.input.every(v => v === 'text' || v === 'image'))) throw new Error('Invalid model cache');
      for (const field of ['contextWindow', 'maxTokens'] as const) if (m[field] !== undefined && (!Number.isInteger(m[field]) || m[field]! <= 0)) throw new Error('Invalid model cache');
      if (m.pricing !== undefined && m.pricing !== 'unknown') {
        if (!m.pricing || typeof m.pricing !== 'object' || !Number.isFinite(m.pricing.input) || !Number.isFinite(m.pricing.output)) throw new Error('Invalid model cache');
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (m.pricing[field] !== undefined && (!Number.isFinite(m.pricing[field]) || m.pricing[field]! < 0)) throw new Error('Invalid model cache');
        if (m.pricing.tiers !== undefined && (!Array.isArray(m.pricing.tiers) || m.pricing.tiers.some(t => !t || !Number.isFinite(t.inputTokensAbove) || !['input', 'output', 'cacheRead', 'cacheWrite'].every(f => Number.isFinite(t[f as keyof typeof t]) && t[f as keyof typeof t] >= 0)))) throw new Error('Invalid model cache');
      }
    }
    return { kind: 'account', complete: true, freshness: 'stale', models: value.models };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Model cache could not be loaded'); }
}
export async function invalidateDiscoveryCache(directory: string, id: string): Promise<void> {
  try { await unlink(filename(directory, id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Model cache could not be invalidated'); }
}
export async function saveDiscoveryCache(directory: string, id: string, provenance: string, snapshot: ProviderCatalogSnapshot, observedAt: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.discovery-'));
  try {
    const stagedFile = join(staging, 'cache.json');
    await writeFile(stagedFile, JSON.stringify({ version: 2, id, provenance, observedAt, models: snapshot.models }), 'utf8');
    await renameWithTransientRetry(stagedFile, filename(directory, id));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
