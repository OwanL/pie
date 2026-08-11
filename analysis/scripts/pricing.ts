/**
 * Token-pricing loader for the analysis package.
 *
 * The identical core (`parseModelPricing` and `ModelTokenPricing`) lives in the
 * shared `../../shared/pricing-core.ts`
 * module and is re-exported here. The package-local pieces that differ by
 * consumer policy remain here:
 *
 * - `loadModelPricingMap` — provider/model keys plus unambiguous legacy bare-id
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

import { parseModelPricing, pricingForPromptTokens } from '../../shared/pricing-core.js';
import type { ModelTokenPricing } from '../../shared/pricing-core.js';

// Re-export the shared core under the original public names so existing
// consumers (analysis/scripts/prepare.ts, analysis/test/pricing.test.ts) keep
// working unchanged.
export { parseModelPricing, pricingForPromptTokens } from '../../shared/pricing-core.js';
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
  bareOwners: Map<string, string | null>,
  provider: string,
  id: string,
  model: Record<string, unknown>,
): void {
  if (!id) return;
  const pricing = parseModelPricing(model.cost);
  if (!pricing) return;
  map.set(`${provider}/${id}`, pricing);
  // Legacy provider-less snapshots may use a bare id only while it identifies
  // exactly one provider. On the first collision delete the fallback forever;
  // insertion order must never decide whether Codex or Copilot owns the cost.
  const owner = bareOwners.get(id);
  if (owner === undefined) {
    bareOwners.set(id, provider);
    map.set(id, pricing);
  } else if (owner === provider) {
    map.set(id, pricing);
  } else if (owner !== null) {
    bareOwners.set(id, null);
    map.delete(id);
  }
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
  const bareOwners = new Map<string, string | null>();
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
        addRecord(map, bareOwners, providerName, m.id, m);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') {
          continue;
        }
        addRecord(map, bareOwners, providerName, id, model as Record<string, unknown>);
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
    if (!map.has(providerKey)) {
      addRecord(map, bareOwners, model.provider, model.id, { cost: model.cost });
    }
  }

  return map;
}

/** Compute USD cost for a token usage given a pricing record. */
export function computeTokenCostUsd(usage: TokenUsageForCost, pricing: ModelTokenPricing): number {
  const effective = pricingForPromptTokens(
    pricing,
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  );
  const cost =
    (usage.inputTokens / TOKENS_PER_MILLION) * effective.input +
    (usage.outputTokens / TOKENS_PER_MILLION) * effective.output +
    (usage.cacheReadTokens / TOKENS_PER_MILLION) * effective.cacheRead +
    (usage.cacheWriteTokens / TOKENS_PER_MILLION) * effective.cacheWrite;
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
  // Subagent/child usage records provider-qualified ids (`ollama/glm-5.2:cloud`)
  // that are already valid catalog keys; only prefix a bare id.
  const key = provider
    ? modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`
    : modelId;
  const pricing = pricingMap.get(key);
  if (!pricing) {
    return null;
  }
  const cost = computeTokenCostUsd(usage, pricing);
  // A zero cost is meaningful (free/local model) — keep 0, only null when unknown.
  return cost;
}
