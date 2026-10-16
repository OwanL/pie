import { createHash } from 'node:crypto';
import { parseModelPricing } from '../pricing/pricing-core';
import { resolveProviderModelList, type ShippedProviderDefinition } from '../catalog/provider-model-resolution';
import type { CaptureProviderRuntimeInput, NativeRuntimeModel, RuntimeSnapshot, RuntimeModelProjection } from './contracts';

export const runtimeProtocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
/** Digest only compiled, public static definitions; caller headers are never hashed or stored. */
export function builtinHeaderDigest(model: NativeRuntimeModel): string | undefined {
  const headers = model.headers;
  if (!headers || !Object.keys(headers).length || Object.values(headers).some(value => typeof value !== 'string')) return undefined;
  return createHash('sha256').update(JSON.stringify([model.provider, model.id,
    Object.keys(headers).sort().map(key => [key, headers[key]])])).digest('hex');
}
const rateChannels = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
function flatCost(value: unknown): value is NativeRuntimeModel['cost'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rates = value as Record<string, unknown>;
  // Native SDK merges can materialize the optional tiers field as undefined.
  // That is not tiered pricing; actual tiers (including []) still fail closed.
  return Object.keys(rates).every(key => rateChannels.includes(key as typeof rateChannels[number])
      || (key === 'tiers' && rates[key] === undefined))
    && rateChannels.every(key => typeof rates[key] === 'number' && Number.isFinite(rates[key]) && Number(rates[key]) >= 0);
}
const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
export function validNativeModel(value: unknown): value is NativeRuntimeModel {
  const m = value as NativeRuntimeModel;
  if (!m || typeof m !== 'object' || !['provider', 'id', 'name', 'api', 'baseUrl'].every(k => typeof (m as unknown as Record<string, unknown>)[k] === 'string')) return false;
  if (!m.api || !m.provider || !m.id || !m.name) return false;
  if (m.compat !== undefined && (!m.compat || typeof m.compat !== 'object' || Array.isArray(m.compat))) return false;
  if (m.thinkingLevelMap !== undefined && (!m.thinkingLevelMap || typeof m.thinkingLevelMap !== 'object'
    || Array.isArray(m.thinkingLevelMap) || Object.values(m.thinkingLevelMap).some(value => value !== null && value !== undefined && typeof value !== 'string'))) return false;
  try { const url = new URL(m.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false; } catch { return false; }
  return Array.isArray(m.input) && m.input.length > 0 && m.input.every(x => x === 'text' || x === 'image')
    && typeof m.reasoning === 'boolean' && positive(m.contextWindow) && positive(m.maxTokens)
    && !!m.cost && Object.keys(m.cost).every(k => ['input', 'output', 'cacheRead', 'cacheWrite'].includes(k))
    && ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => {
      const rate = (m.cost as unknown as Record<string, unknown>)[k];
      return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
    });
}
/** Pure offline capture. No credentials, discovery, registry mutation or SDK dependency. */
export function captureProviderRuntimeProjection(input: CaptureProviderRuntimeInput): RuntimeSnapshot | undefined {
  if (input.config === undefined) return undefined;
  if (input.config.version !== 1 || !input.config.providers || typeof input.configRevision !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(input.configRevision)) throw new Error('Invalid runtime configuration');
  const shipped: Record<string, ShippedProviderDefinition> = Object.create(null);
  const provedBaseline = (model: NativeRuntimeModel) => {
    const builtin = input.builtinModels?.find(candidate => candidate.provider === model.provider && candidate.id === model.id);
    return flatCost(model.cost) && !!builtin && flatCost(builtin.cost)
      && rateChannels.every(key => model.cost[key] === builtin.cost[key]);
  };
  for (const model of input.legacyModels) {
    const definition = shipped[model.provider] ??= { models: Object.create(null) };
    const models = definition.models as Record<string, unknown>;
    if (Object.hasOwn(models, model.id)) throw new Error('Duplicate runtime model identity');
    models[model.id] = { name: model.name, api: model.api, baseUrl: model.baseUrl, input: [...model.input], reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      ...(!Object.hasOwn(input.config.providers, model.provider) || provedBaseline(model) ? { pricing: Object.fromEntries(Object.entries(model.cost).filter(([key, value]) => key !== 'tiers' || value !== undefined)) } : {}) };
  }
  // Approved shipped facts replace registry-derived metadata for exact identities.
  for (const [provider, definition] of Object.entries(input.shippedCatalog ?? {})) {
    const baseline = shipped[provider];
    const models = { ...baseline?.models };
    for (const [id, metadata] of Object.entries(definition.models ?? {})) {
      models[id] = { ...models[id], ...metadata };
    }
    shipped[provider] = { ...baseline, ...definition, models };
  }
  // Only runtime capture suppresses unknown listing prices backed by compiled rates.
  // Management's canonical merger deliberately keeps the listing's unknown price.
  const discovered = Object.fromEntries(Object.entries(input.discovered ?? {}).map(([provider, snapshot]) => [provider, {
    ...snapshot, models: Object.fromEntries(Object.entries(snapshot.models).map(([id, metadata]) => {
      const native = input.legacyModels.find(model => model.provider === provider && model.id === id);
      if (metadata.pricing !== 'unknown' || !native || !provedBaseline(native)) return [id, metadata];
      const { pricing: _pricing, ...rest } = metadata;
      return [id, rest];
    })),
  }]));
  const resolved = resolveProviderModelList({ config: input.config, shipped, discovered });
  const models: RuntimeModelProjection[] = [];
  for (const provider of Object.values(resolved.providers)) {
    const entry = input.config.providers[provider.id];
    if (entry?.removed) continue;
    const legacyOverlay = entry?.credentialRef?.source === 'legacy';
    for (const item of Object.values(provider.models)) {
      // Managed Ollama tags are the installed/remote-alias inventory, not a
      // vendor catalog. A last-known complete listing remains authoritative
      // offline; without one, retain the known-model fallback. This only affects
      // new captures, never an already persisted session pin.
      const inventory = input.discovered?.[provider.id];
      if (provider.id === 'ollama' && entry && !legacyOverlay && inventory?.kind === 'account' && inventory.complete
        && !Object.hasOwn(inventory.models, item.id)) continue;
      const native = input.legacyModels.find(model => model.provider === provider.id && model.id === item.id);
      // Legacy entries are policy overlays only. Native/custom registry definitions
      // remain authoritative, including identities absent from the approved catalog.
      if (legacyOverlay && !native) continue;
      const metadata = legacyOverlay ? { ...native!, pricing: Object.fromEntries(
        Object.entries(native!.cost).filter(([key, value]) => key !== 'tiers' || value !== undefined)) } : item.metadata;
      const pricing = metadata.pricing;
      const nativeProtocol = input.legacyModels.some(model => model.provider === provider.id && model.api === metadata.api);
      const completePricing = pricing === 'unknown' ? undefined : parseModelPricing(pricing);
      const candidate = { ...(native?.compat ? { compat: native.compat } : {}),
        ...(native?.thinkingLevelMap ? { thinkingLevelMap: native.thinkingLevelMap } : {}),
        provider: provider.id, id: item.id, name: legacyOverlay ? native!.name : item.label, api: metadata.api, baseUrl: metadata.baseUrl,
        input: metadata.input, reasoning: metadata.reasoning, contextWindow: metadata.contextWindow, maxTokens: metadata.maxTokens,
        cost: completePricing ? Object.fromEntries(rateChannels.map(key => [key, completePricing[key]])) : undefined };
      // Header-bearing baselines may contain credential material. This DTO does not
      // serialize it, and must not silently dispatch a headerless approximation.
      const nativeHeaders = native && (native as NativeRuntimeModel & { headers?: Record<string, string> }).headers;
      const builtin = input.builtinModels?.find(model => model.provider === provider.id && model.id === item.id);
      const digest = builtin && builtinHeaderDigest(builtin);
      const trustedHeaders = !!digest && !!nativeHeaders && !!builtin?.headers
        && Object.keys(nativeHeaders).length === Object.keys(builtin.headers).length
        && Object.keys(nativeHeaders).every(key => Object.hasOwn(builtin.headers!, key) && nativeHeaders[key] === builtin.headers![key]);
      const explicitPricing = [entry?.modelOverrides?.[item.id]?.pricing, input.discovered?.[provider.id]?.models[item.id]?.pricing]
        .some(value => !!parseModelPricing(value) && typeof value === 'object'
          && rateChannels.every(key => typeof value[key] === 'number'));
      const pricingProved = (legacyOverlay && !!native && flatCost(native.cost)) || explicitPricing || !entry || !!input.shippedCatalog?.[provider.id]?.models?.[item.id] || (!!native && provedBaseline(native))
        || flatCost(entry.modelOverrides?.[item.id]?.pricing)
        || flatCost(input.discovered?.[provider.id]?.models[item.id]?.pricing);
      const supported = pricingProved && validNativeModel(candidate) && (!(nativeHeaders && Object.keys(nativeHeaders).length) || trustedHeaders)
        && (runtimeProtocols.includes(candidate.api as typeof runtimeProtocols[number]) || nativeProtocol)
        && !!completePricing
        && (legacyOverlay ? !!native && flatCost(native.cost)
          : ((!pricing || pricing === 'unknown' || pricing.tiers === undefined) || !!input.shippedCatalog?.[provider.id]?.models?.[item.id] || explicitPricing));
      const row: RuntimeModelProjection = { providerId: provider.id, id: item.id,
        enabled: !provider.configured || provider.enabled, visible: item.preferences.visible !== false,
        subagentEligible: item.preferences.subagentEligible !== false,
        credential: !entry ? { source: 'legacy' }
          : entry.credentialRef?.source === 'saved'
            ? { source: 'saved', ...(input.credentialScopes?.[provider.id] ? { scope: input.credentialScopes[provider.id] } : {}) }
            : entry.credentialRef ? { ...entry.credentialRef } : { source: 'default' } };
      if (supported) {
        row.model = JSON.parse(JSON.stringify(candidate)) as NativeRuntimeModel;
        row.pricingFacts = completePricing;
        if (trustedHeaders) row.builtinHeaders = { provider: provider.id, id: item.id, sha256: digest! };
      }
      else row.rejection = 'unsupported-or-incomplete-runtime-model';
      models.push(row);
    }
  }
  return immutable({ version: 1, configRevision: input.configRevision, models });
}
