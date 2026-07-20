/**
 * Canonical model-family resolver for the analysis package.
 *
 * The same underlying model is often offered by multiple providers under different ids — e.g.
 * `umans-glm-5.2` (Umans) and `glm-5.2:cloud` (Ollama Cloud) are both GLM 5.2. Without
 * normalization the analytics leaderboard would rank them as two separate models, which is
 * misleading: they are the same model behind different provider facades.
 *
 * `models.json` may declare an optional `family` on each model entry to group these together.
 * Entries without `family` default to their own `id` (kept distinct), so only models that are
 * explicitly declared as siblings collapse. This module builds a modelId → family lookup so
 * downstream analytics can collapse provider-specific ids into one canonical family while the
 * backend keeps storing each provider-specific `modelId` distinctly — leaving the door open to
 * investigate provider differences later (e.g. via the `providers` breakdown on leaderboard rows
 * or the `model_family` column in DuckDB).
 *
 * Mirrors the structure of `pricing.ts` (both delegate `models.json` loading to
 * `./load-models.ts`) so the two lookups stay in lockstep.
 */
import { loadHistoricalModelRecords, loadModelsJsonProviders } from './load-models.ts';

export interface ModelFamilyEntry {
  /** Canonical, provider-agnostic family id (e.g. 'glm-5.2'). Falls back to the model id when no `family` is declared. */
  family: string;
  /**
   * Provider name from `models.json` (e.g. 'umans', 'ollama', 'github-copilot'); null when the
   * entry could not be attributed to a provider. Surfaced so analytics can break a family down
   * by provider when investigating provider-specific differences.
   */
  provider: string | null;
}

function entryFor(id: string, model: Record<string, unknown> | null | undefined, provider: string): ModelFamilyEntry | null {
  if (!id) return null;
  const declaredFamily = typeof model?.family === 'string' ? model.family.trim() : '';
  return { family: declaredFamily || id, provider };
}

/**
 * Load a model-id → family map from `models.json`.
 *
 * Returns an empty map (never throws) if the file is missing or malformed, so that family
 * resolution degrades gracefully to "every model is its own family" rather than breaking the
 * analytics pipeline.
 */
export function loadModelFamilyMap(modelsJsonPath?: string, historyPath?: string): Map<string, ModelFamilyEntry> {
  const map = new Map<string, ModelFamilyEntry>();
  const bareOwners = new Map<string, string | null>();
  const addEntry = (id: string, model: Record<string, unknown> | null | undefined, provider: string): void => {
    const entry = entryFor(id, model, provider);
    if (!entry) return;
    map.set(`${provider}/${id}`, entry);
    const owner = bareOwners.get(id);
    if (owner === undefined) {
      bareOwners.set(id, provider);
      map.set(id, entry);
    } else if (owner === provider) {
      map.set(id, entry);
    } else if (owner !== null) {
      bareOwners.set(id, null);
      map.delete(id);
    }
  };
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
        addEntry(m.id, m, providerName);
      }
    }

    const modelOverrides = provider.modelOverrides;
    if (modelOverrides && typeof modelOverrides === 'object' && !Array.isArray(modelOverrides)) {
      for (const [id, model] of Object.entries(modelOverrides as Record<string, unknown>)) {
        addEntry(id, model && typeof model === 'object' ? (model as Record<string, unknown>) : null, providerName);
      }
    }
  }

  const historical = modelsJsonPath === undefined || historyPath !== undefined
    ? loadHistoricalModelRecords(historyPath)
    : [];
  for (const model of historical) {
    if (!map.has(`${model.provider}/${model.id}`)) {
      addEntry(model.id, { family: model.family }, model.provider);
    }
  }

  return map;
}

/**
 * Resolve the canonical family for a model id. Returns the declared family, or the model id
 * itself when the model is not in the registry (preserving distinctness for unknown models).
 * Returns `null` when `modelId` is null/blank so callers can mirror their null-model handling.
 *
 * Unknown path-prefixed ids (e.g. `umans/umans-glm-5.2`) try registry resolution of the suffix
 * after the last `/` so provider-prefixed variants collapse into their declared family when the
 * suffix is a known model id. Unknown slash ids whose suffix is not in the registry remain
 * distinct (the full id is returned, no spurious collapse).
 */
export function resolveModelFamily(
  modelId: string | null | undefined,
  familyMap: Map<string, ModelFamilyEntry>,
): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const direct = familyMap.get(trimmed);
  if (direct) return direct.family;
  const slashIndex = trimmed.lastIndexOf('/');
  if (slashIndex >= 0) {
    const suffix = trimmed.slice(slashIndex + 1);
    const suffixEntry = familyMap.get(suffix);
    if (suffixEntry) return suffixEntry.family;
  }
  return trimmed;
}

/**
 * Resolve the provider for a model id from the family map (e.g. 'anthropic',
 * 'openai', 'umans', 'ollama'). Returns `null` when `modelId` is null/blank or
 * when the model is not in the registry (provider unattributable). Mirrors
 * {@link resolveModelFamily} so the two lookups stay in lockstep: `modelFamily`
 * collapses provider-specific ids into one canonical family, while `provider`
 * retains the per-provider dimension for cost-rollup analytics. Path-prefixed
 * ids try suffix resolution just like {@link resolveModelFamily}.
 */
export function resolveModelProvider(
  modelId: string | null | undefined,
  familyMap: Map<string, ModelFamilyEntry>,
): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const direct = familyMap.get(trimmed);
  if (direct) return direct.provider;
  const slashIndex = trimmed.lastIndexOf('/');
  if (slashIndex >= 0) {
    const suffix = trimmed.slice(slashIndex + 1);
    const suffixEntry = familyMap.get(suffix);
    if (suffixEntry) return suffixEntry.provider;
  }
  return null;
}
