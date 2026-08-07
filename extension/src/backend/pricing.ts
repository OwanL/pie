/**
 * Minimal pricing parser for the VS Code extension backend.
 *
 * The identical core types and `parseModelPricing` implementation live in the
 * shared `../../../shared/pricing-core.ts` module and are
 * re-exported here to preserve this module's public surface. Only the loader
 * (`loadModelPricing`) remains package-local.
 *
 * ## Units & semantics
 *
 * - All costs are in **USD per 1M tokens**.
 * - `0` = genuinely free, local, or included.
 * - Missing `cost` field = unknown pricing (triggers fallback).
 * - Negative or non-finite prices are rejected.
 */

import { parseModelPricing } from '../../../shared/pricing-core.js';
import type { ModelPricingRecord } from '../../../shared/pricing-core.js';
import { parseJsonOrThrow } from '../shared/error-message';

// Re-export the shared core under the original public names so existing
// consumers and tests keep working unchanged.
export { parseModelPricing } from '../../../shared/pricing-core.js';
export type { ModelPricingRecord, ModelTokenPricing } from '../../../shared/pricing-core.js';

/**
 * Load pricing records from `models.json` and, when supplied, the generated
 * historical pricing catalog.
 *
 * Returns a Map keyed by model id, with values being arrays of
 * {@link ModelPricingRecord} (one per provider the model appears under).
 * Returns an empty Map when `models.json` is missing or unreadable. A missing
 * or malformed history file is ignored.
 *
 * Models with missing, invalid, or negative pricing are silently skipped.
 * Active `models.json` records win exact provider/model collisions with history.
 */
export function loadModelPricing(
  modelsJsonPath: string,
  historicalPricingPath?: string,
): Map<string, ModelPricingRecord[]> {
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

  if (!historicalPricingPath) return map;

  let historical: unknown;
  try {
    historical = parseJsonOrThrow<unknown>(
      require('node:fs').readFileSync(historicalPricingPath, 'utf-8'),
      historicalPricingPath,
    );
  } catch {
    return map;
  }
  if (!historical || typeof historical !== 'object' || Array.isArray(historical)) return map;
  const historicalModels = (historical as Record<string, unknown>).models;
  if (!Array.isArray(historicalModels)) return map;

  for (const model of historicalModels) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const record = model as Record<string, unknown>;
    if (typeof record.provider !== 'string' || typeof record.id !== 'string') continue;
    const activeRecords = map.get(record.id);
    if (activeRecords?.some((entry) => entry.provider === record.provider)) continue;
    addRecord(record.provider, record.id, record);
  }

  return map;
}
