import { parseDocument } from '../../../extension/node_modules/yaml/dist/index.js';

import type { DiscoveredCopilotModel } from './copilot-models.js';

const PROVIDER = 'github-copilot';
const AUTO_DISABLED_REASON = 'Auto-discovered from GitHub Copilot; not yet vetted for subagents';

type SourceModel = Record<string, unknown> & { id: string };
type SourceProvider = { models?: SourceModel[] } & Record<string, unknown>;
type SourceCatalog = {
  profileOrder: string[];
  providers: Record<string, SourceProvider>;
};

export interface CatalogReconciliation {
  text: string;
  changed: boolean;
  added: string[];
  removed: string[];
  transferred: string[];
  skippedConflicts: string[];
}

function thinkingLevels(model: DiscoveredCopilotModel): string[] {
  const map = model.thinkingLevelMap;
  if (!map) return ['minimal'];
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    .filter((level) => map[level] !== null && map[level] !== undefined);
  return levels.length > 0 ? levels : ['minimal'];
}

function defaultCostRank(model: DiscoveredCopilotModel): number {
  if (model.cost.input <= 0.5) return 3;
  if (model.cost.input <= 2) return 6;
  if (model.cost.input <= 3) return 10;
  return 25;
}

function pricing(model: DiscoveredCopilotModel): Record<string, unknown> {
  return {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
    ...(model.cost.tiers ? { tiers: model.cost.tiers } : {}),
  };
}

export function toCatalogModel(
  model: DiscoveredCopilotModel,
  existing?: SourceModel,
): SourceModel {
  const compat = {
    ...(existing?.compat && typeof existing.compat === 'object' ? existing.compat : {}),
    ...(model.compat ?? {}),
  };
  const thinkingLevelMap = model.thinkingLevelMap ?? existing?.thinkingLevelMap;
  const reasoning = model.reasoning || existing?.reasoning === true;
  return {
    id: model.id,
    name: `Copilot: ${model.name}`,
    api: model.api,
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    ...(reasoning ? { reasoning: true } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(thinkingLevelMap && typeof thinkingLevelMap === 'object' ? { thinkingLevelMap } : {}),
    pricing: pricing(model),
    eligible: existing?.eligible ?? false,
    thinking: existing?.thinking ?? thinkingLevels(model),
    disabledReason: existing ? (existing.disabledReason ?? null) : AUTO_DISABLED_REASON,
    costRank: existing?.costRank ?? defaultCostRank(model),
  };
}

/** Reconcile account-visible Copilot models into the authoritative YAML catalog.
 *
 * Existing Copilot profile policy is retained, while endpoint-owned protocol,
 * capability and pricing fields are refreshed. An override-only entry under a
 * different provider is removed when Copilot claims the same ID; this transfers
 * catalog ownership without hiding the other provider's SDK-built-in model.
 * Full custom-model conflicts are skipped rather than destroyed.
 */
export function reconcileCatalogText(
  yamlText: string,
  remoteModels: DiscoveredCopilotModel[],
): CatalogReconciliation {
  const document = parseDocument(yamlText);
  if (document.errors.length > 0) throw new Error(`Invalid models.yaml: ${document.errors[0].message}`);
  const source = document.toJS() as SourceCatalog;
  const copilot = source.providers?.[PROVIDER];
  if (!copilot || !Array.isArray(copilot.models) || !Array.isArray(source.profileOrder)) {
    throw new Error('models.yaml is missing github-copilot models or profileOrder');
  }

  const oldModels = copilot.models;
  const oldById = new Map(oldModels.map((model) => [model.id, model]));
  const remoteIds = new Set(remoteModels.map((model) => model.id));
  const removed = oldModels.filter((model) => !remoteIds.has(model.id)).map((model) => model.id);
  const added: string[] = [];
  const transferred: string[] = [];
  const skippedConflicts: string[] = [];

  const conflictingFullIds = new Set<string>();
  const changedOtherProviders = new Set<string>();
  for (const [providerName, provider] of Object.entries(source.providers)) {
    if (providerName === PROVIDER || !Array.isArray(provider.models)) continue;
    provider.models = provider.models.filter((model) => {
      if (!remoteIds.has(model.id)) return true;
      if (model.overrideOnly === true) {
        transferred.push(model.id);
        changedOtherProviders.add(providerName);
        return false;
      }
      conflictingFullIds.add(model.id);
      skippedConflicts.push(model.id);
      return true;
    });
  }

  const nextModels = remoteModels
    .filter((model) => !conflictingFullIds.has(model.id))
    .map((model) => {
      if (!oldById.has(model.id)) added.push(model.id);
      return toCatalogModel(model, oldById.get(model.id));
    });
  copilot.models = nextModels;

  const allNextIds = new Set<string>();
  for (const provider of Object.values(source.providers)) {
    for (const model of provider.models ?? []) allNextIds.add(model.id);
  }

  const oldCopilotIds = new Set(oldModels.map((model) => model.id));
  const firstCopilotIndex = source.profileOrder.findIndex((id) => oldCopilotIds.has(id));
  const retainedOrder = source.profileOrder.filter((id) => allNextIds.has(id));
  const missing = nextModels.map((model) => model.id).filter((id) => !retainedOrder.includes(id));
  const insertionIndex = firstCopilotIndex < 0 ? retainedOrder.length : Math.min(firstCopilotIndex, retainedOrder.length);
  retainedOrder.splice(insertionIndex, 0, ...missing);
  source.profileOrder = retainedOrder;

  const changed = added.length > 0 || removed.length > 0 || transferred.length > 0 ||
    nextModels.some((model, index) => JSON.stringify(model) !== JSON.stringify(oldModels[index]));
  if (!changed) {
    return { text: yamlText, changed: false, added, removed, transferred, skippedConflicts };
  }

  document.setIn(['providers', PROVIDER, 'models'], nextModels);
  for (const providerName of changedOtherProviders) {
    document.setIn(['providers', providerName, 'models'], source.providers[providerName].models ?? []);
  }
  document.set('profileOrder', retainedOrder);
  return {
    text: document.toString({ lineWidth: 0 }),
    changed: true,
    added,
    removed,
    transferred,
    skippedConflicts,
  };
}
