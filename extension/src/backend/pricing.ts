/**
 * Minimal pricing parser / normalizer for the VS Code extension backend.
 *
 * The identical core (types, `parseModelPricing`, `estimateNormalizedCost`)
 * now lives in the shared `../../../shared/pricing-core.ts` module and is
 * re-exported here to preserve this module's public surface. Only the loader
 * (`loadModelPricing`) remains package-local.
 *
 * ## Units & semantics
 *
 * - All costs are in **USD per 1M tokens**.
 * - `0` = genuinely free, local, or included.
 * - Missing `cost` field = unknown pricing (triggers fallback).
 * - Negative or non-finite prices are rejected.
 *
 * ## Normalization (see shared core)
 *
 *   blended = (3 × input + 1 × output) / 4
 *   normalized = 10 × √(blended / 6.00)
 *
 * Baseline ($6.00/1M blended) anchored to claude-sonnet-4.6.
 */

import { parseModelPricing } from '../../../shared/pricing-core.js';
import type { ModelPricingRecord } from '../../../shared/pricing-core.js';
import { parseJsonOrThrow } from '../shared/error-message';

// Re-export the shared core under the original public names so existing
// consumers (subagent-profiles.ts, extension/test/backend/models/pricing.test.ts,
// extension/test/backend/models/backend-pricing-units.test.ts) keep working unchanged.
export { estimateNormalizedCost, parseModelPricing } from '../../../shared/pricing-core.js';
export type { ModelPricingRecord, ModelTokenPricing } from '../../../shared/pricing-core.js';

/**
 * Load pricing records from `models.json`.
 *
 * Returns a Map keyed by model id, with values being arrays of
 * {@link ModelPricingRecord} (one per provider the model appears under).
 * Returns an empty Map when the file is missing or unreadable.
 *
 * Models with missing, invalid, or negative pricing are silently skipped.
 */
export function loadModelPricing(modelsJsonPath: string): Map<string, ModelPricingRecord[]> {
  const map = new Map<string, ModelPricingRecord[]>();

  let raw: string;
  try {
    raw = require('node:fs').readFileSync(modelsJsonPath, 'utf-8');
  } catch {
    return map;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(raw, modelsJsonPath);
  } catch {
    return map;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;

  const cfg = parsed as Record<string, unknown>;
  const providers = cfg.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return map;

  const addRecord = (provider: string, id: string, model: Record<string, unknown>) => {
    if (id.length === 0) return;
    const pricing = parseModelPricing(model.cost);
    if (!pricing) return;

    const record: ModelPricingRecord = { id, provider, pricing };
    const existing = map.get(id);
    if (existing) {
      existing.push(record);
    } else {
      map.set(id, [record]);
    }
  };

  for (const [providerName, providerData] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerData || typeof providerData !== 'object') continue;
    const provider = providerData as Record<string, unknown>;

    const models = provider.models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== 'object') continue;
        const m = model as Record<string, unknown>;
        if (typeof m.id !== 'string') continue;
        addRecord(providerName, m.id, m);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        if (!model || typeof model !== 'object') continue;
        addRecord(providerName, id, model as Record<string, unknown>);
      }
    }
  }

  return map;
}