import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
export async function discoverModels(options: { kind: 'openai' | 'copilot'; baseUrl: string; key?: string; fetch: typeof globalThis.fetch; signal: AbortSignal }): Promise<ProviderCatalogSnapshot> {
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
const filename = (directory: string, id: string) => join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
export async function loadDiscoveryCache(directory: string, id: string, provenance: string): Promise<ProviderCatalogSnapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(filename(directory, id), 'utf8'));
    if (value.id === id && value.provenance !== provenance) return;
    if (value.version !== 1 || value.id !== id || !Number.isFinite(value.observedAt)
      || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) throw new Error('Invalid model cache');
    for (const [key, model] of Object.entries(value.models)) {
      if (!key.trim() || !model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Invalid model cache');
      const m = model as ProviderModelMetadata;
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
  await writeFile(filename(directory, id), JSON.stringify({ version: 1, id, provenance, observedAt, models: snapshot.models }), 'utf8');
}
