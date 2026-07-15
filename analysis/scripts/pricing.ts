/**
 * Token-pricing loader for the analysis package.
 *
 * The identical core (`parseModelPricing`, `ModelTokenPricing`, and
 * `estimateNormalizedCost`) now lives in the shared `../../shared/pricing-core.ts`
 * module and is re-exported here. The package-local pieces that differ by
 * consumer policy remain here:
 *
 * - `loadModelPricingMap` — provider/model keys plus legacy first-provider bare-id
 *   keys in a `Map<string, ModelTokenPricing>`, env-aware (delegates file IO to
 *   `./load-models.ts`).
 * - `computeTokenCostUsd` / `estimateRunCostUsd` — analysis-only token-math
 *   (kept local, NOT in the shared core).
 * - `resolveModelsJsonPath` re-export (lives in `./load-models.ts`).
 *
 * ## Units
 * - All rates are **USD per 1,000,000 tokens**.
 * - `0` = genuinely free / local / included.
 * - Missing `cost` block = unknown pricing (cost falls back to `null`).
 *
 * `models.json` is read from the repo root by default (`../../models.json`
 * relative to this module). Override with the `PIE_MODELS_JSON` env var or the
 * explicit `modelsJsonPath` argument (used by tests).
 */
import { loadHistoricalModelRecords, loadModelsJsonProviders } from './load-models.ts';

import { parseModelPricing } from '../../shared/pricing-core.js';
import type { ModelTokenPricing } from '../../shared/pricing-core.js';

// Re-export the shared core under the original public names so existing
// consumers (analysis/scripts/prepare.ts, analysis/test/pricing.test.ts) keep
// working unchanged. estimateNormalizedCost is the shared normalization helper,
// re-exported for downstream reuse within the analysis package.
export { estimateNormalizedCost, parseModelPricing } from '../../shared/pricing-core.js';
export type { ModelTokenPricing } from '../../shared/pricing-core.js';

// Re-exported so existing imports of `resolveModelsJsonPath` from `./pricing.ts`
// (e.g. tests) keep working now that it lives in `./load-models.ts`.
export { resolveModelsJsonPath } from './load-models.ts';

const TOKENS_PER_MILLION = 1_000_000;

export interface TokenUsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function addRecord(
  map: Map<string, ModelTokenPricing>,
  provider: string,
  id: string,
  model: Record<string, unknown>,
): void {
  if (!id) return;
  const pricing = parseModelPricing(model.cost);
  if (!pricing) return;
  map.set(`${provider}/${id}`, pricing);
  // Retain the historical bare-id fallback for snapshots without provider.
  if (!map.has(id)) map.set(id, pricing);
}

/**
 * Load a model-id → pricing map from `models.json`.
 *
 * Returns an empty map (never throws) if the file is missing or malformed, so
 * that cost derivation degrades gracefully to `null` rather than breaking the
 * analytics pipeline.
 */
export function loadModelPricingMap(modelsJsonPath?: string, historyPath?: string): Map<string, ModelTokenPricing> {
  const map = new Map<string, ModelTokenPricing>();
  const providers = loadModelsJsonProviders(modelsJsonPath);

  for (const [providerName, providerData] of Object.entries(providers ?? {})) {
    if (!providerData || typeof providerData !== 'object') {
      continue;
    }
    const provider = providerData as Record<string, unknown>;

    const models = provider.models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== 'object') {
          continue;
        }
        const m = model as Record<string, unknown>;
        if (typeof m.id !== 'string') {
          continue;
        }
        addRecord(map, providerName, m.id, m);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') {
          continue;
        }
        addRecord(map, providerName, id, model as Record<string, unknown>);
      }
    }
  }

  // Explicit models.json test fixtures remain isolated unless they also pass
  // an explicit history path. Active entries win every collision.
  const historical = modelsJsonPath === undefined || historyPath !== undefined
    ? loadHistoricalModelRecords(historyPath)
    : [];
  for (const model of historical) {
    const pricing = parseModelPricing(model.cost);
    if (!pricing) continue;
    const providerKey = `${model.provider}/${model.id}`;
    if (!map.has(providerKey)) map.set(providerKey, pricing);
    if (!map.has(model.id)) map.set(model.id, pricing);
  }

  return map;
}

/** Compute USD cost for a token usage given a pricing record. */
export function computeTokenCostUsd(usage: TokenUsageForCost, pricing: ModelTokenPricing): number {
  const cost =
    (usage.inputTokens / TOKENS_PER_MILLION) * pricing.input +
    (usage.outputTokens / TOKENS_PER_MILLION) * pricing.output +
    (usage.cacheReadTokens / TOKENS_PER_MILLION) * pricing.cacheRead +
    (usage.cacheWriteTokens / TOKENS_PER_MILLION) * pricing.cacheWrite;
  return Math.round(cost * 1_000_000) / 1_000_000; // round to 1 micro-dollar
}

/**
 * Estimate the USD cost of a run. Returns `null` when pricing is unknown for the
 * model (e.g. a local/free model with no `cost` block, or an unrecognized id).
 */
export function estimateRunCostUsd(
  modelId: string | null | undefined,
  usage: TokenUsageForCost,
  pricingMap: Map<string, ModelTokenPricing>,
  provider?: string | null,
): number | null {
  if (!modelId) {
    return null;
  }
  const pricing = provider ? pricingMap.get(`${provider}/${modelId}`) : pricingMap.get(modelId);
  if (!pricing) {
    return null;
  }
  const cost = computeTokenCostUsd(usage, pricing);
  // A zero cost is meaningful (free/local model) — keep 0, only null when unknown.
  return cost;
}