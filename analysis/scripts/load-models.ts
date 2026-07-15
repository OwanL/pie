/**
 * Shared `models.json` loader for the analysis package.
 *
 * `pricing.ts` and `model-family.ts` both build a model-id → record map from the same
 * `models.json`. The read → parse → shape-validate → extract-`providers` boilerplate
 * (including graceful error swallowing so the analytics pipeline degrades to an empty map
 * rather than throwing) was duplicated verbatim in both. It now lives here so the two
 * lookups stay in lockstep.
 *
 * Path resolution (`resolveModelsJsonPath`) is co-located here for the same reason: it is a
 * `models.json` concern, not a pricing one. `pricing.ts` re-exports it to preserve its
 * existing public surface (tests import it from there).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonOrThrow } from '../../shared/error-message.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS_JSON_PATH = path.resolve(SCRIPT_DIR, '../../models.json');
const DEFAULT_MODEL_PRICING_HISTORY_PATH = path.resolve(SCRIPT_DIR, '../model-pricing-history.json');

export interface HistoricalModelRecord {
  provider: string;
  id: string;
  name: string;
  family?: string;
  cost: unknown;
}

/** Resolve the models.json path: explicit arg > env var > repo-root default. */
export function resolveModelsJsonPath(modelsJsonPath?: string): string {
  if (modelsJsonPath) {
    return modelsJsonPath;
  }
  const fromEnv = process.env.PIE_MODELS_JSON;
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_MODELS_JSON_PATH;
}

/**
 * Read, parse, and shape-validate `models.json`, returning its `providers` object.
 *
 * Returns `null` (never throws) when the file is missing or malformed, or when the parsed
 * shape lacks a valid `providers` object, so callers can degrade gracefully (e.g. return an
 * empty map) rather than breaking the analytics pipeline. Callers then iterate `providers`
 * themselves — the per-record mapping differs between pricing and model-family resolution.
 */
export function loadHistoricalModelRecords(historyPath?: string): HistoricalModelRecord[] {
  const resolvedPath = historyPath ?? DEFAULT_MODEL_PRICING_HISTORY_PATH;
  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(fs.readFileSync(resolvedPath, 'utf8'), resolvedPath);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.filter((entry): entry is HistoricalModelRecord => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.provider === 'string'
      && typeof record.id === 'string'
      && typeof record.name === 'string'
      && 'cost' in record;
  });
}

export function loadModelsJsonProviders(modelsJsonPath?: string): Record<string, unknown> | null {
  const resolvedPath = resolveModelsJsonPath(modelsJsonPath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(raw, resolvedPath);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const providers = (parsed as Record<string, unknown>).providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return null;
  }
  return providers as Record<string, unknown>;
}
