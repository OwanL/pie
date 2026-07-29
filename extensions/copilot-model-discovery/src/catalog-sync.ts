import { parseDocument } from '../../../extension/node_modules/yaml/dist/index.js';

import type { DiscoveredCopilotModel } from './copilot-models.js';

const PROVIDER = 'github-copilot';
const AUTO_DISABLED_REASON = 'Auto-discovered from GitHub Copilot; not yet vetted for subagents';

type SourceModel = Record<string, unknown> & { id: string };
type SourceProvider = { models?: SourceModel[] } & Record<string, unknown>;
type ModelRef = string | { provider: string; id: string };
type SourceCatalog = {
  profileOrder: ModelRef[];
  providers: Record<string, SourceProvider>;
};

type ModelIdentity = { provider: string; id: string };

function identityKey(identity: ModelIdentity): string {
  return JSON.stringify([identity.provider, identity.id]);
}

function providersById(providers: Record<string, SourceProvider>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [providerName, provider] of Object.entries(providers)) {
    for (const model of provider.models ?? []) {
      const owners = result.get(model.id) ?? [];
      owners.push(providerName);
      result.set(model.id, owners);
    }
  }
  return result;
}

function resolveProfileRef(ref: ModelRef, ownersById: Map<string, string[]>): ModelIdentity {
  if (typeof ref !== 'string') return ref;
  const owners = ownersById.get(ref) ?? [];
  if (owners.length !== 1) {
    throw new Error(`profileOrder model id '${ref}' is ${owners.length === 0 ? 'unknown' : 'ambiguous'}`);
  }
  return { provider: owners[0], id: ref };
}

function profileRef(identity: ModelIdentity, ownersById: Map<string, string[]>): ModelRef {
  return (ownersById.get(identity.id)?.length ?? 0) > 1 ? identity : identity.id;
}

export interface CatalogReconciliation {
  text: string;
  changed: boolean;
  added: string[];
  removed: string[];
}

function thinkingLevels(model: DiscoveredCopilotModel): string[] {
  const map = model.thinkingLevelMap;
  if (!map) return ['minimal'];
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    .filter((level) => map[level] !== null && map[level] !== undefined);
  return levels.length > 0 ? levels : ['minimal'];
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

function imageMaxForCatalog(
  model: DiscoveredCopilotModel,
  existing: SourceModel | undefined,
): number | undefined {
  // The discovered endpoint `input` is the source of truth for image
  // capability. The per-request image maximum is pie-owned (the Copilot
  // endpoint does not report one), so it is preserved from the existing entry
  // and defaults to the conservative fail-safe of one for newly discovered
  // image-capable models. Text-only models must not declare a maximum (their
  // effective image budget is zero) — see
  // extensions/image-context-guard/README.md.
  if (!model.input.includes('image')) return undefined;
  const preserved = existing?.maxImagesPerRequest;
  return typeof preserved === 'number' && Number.isInteger(preserved) && preserved >= 1
    ? preserved
    : 1;
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
  const maxImagesPerRequest = imageMaxForCatalog(model, existing);
  return {
    id: model.id,
    name: `Copilot: ${model.name}`,
    api: model.api,
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    ...(reasoning ? { reasoning: true } : {}),
    input: model.input,
    ...(maxImagesPerRequest !== undefined ? { maxImagesPerRequest } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(thinkingLevelMap && typeof thinkingLevelMap === 'object' ? { thinkingLevelMap } : {}),
    pricing: pricing(model),
    eligible: existing?.eligible ?? false,
    thinking: existing?.thinking ?? thinkingLevels(model),
    disabledReason: existing ? (existing.disabledReason ?? null) : AUTO_DISABLED_REASON,
  };
}

/** Reconcile account-visible Copilot models into the authoritative YAML catalog.
 *
 * Existing Copilot profile policy is retained, while endpoint-owned protocol,
 * capability and pricing fields are refreshed. Other providers are never
 * modified: model identity is the (provider, id) pair, and profile references
 * are qualified automatically when discovery introduces a duplicate bare ID.
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
  const originalProfileOrder = source.profileOrder;
  const oldById = new Map(oldModels.map((model) => [model.id, model]));
  const remoteIds = new Set(remoteModels.map((model) => model.id));
  const removed = oldModels.filter((model) => !remoteIds.has(model.id)).map((model) => model.id);
  const added: string[] = [];

  // Resolve profile references before changing the provider catalog. This
  // preserves provider identity when a newly discovered Copilot model shares
  // an ID with another provider (for example openai-codex/gpt-*).
  const oldOwnersById = providersById(source.providers);
  const oldOrder = source.profileOrder.map((ref, index) => ({
    identity: resolveProfileRef(ref, oldOwnersById),
    index,
  }));

  // Reconciliation owns only the Copilot provider. Duplicate model IDs across
  // providers are valid because catalog identity is the (provider, id) pair;
  // never delete or suppress another provider's independently configured model.
  const nextModels = remoteModels.map((model) => {
    if (!oldById.has(model.id)) added.push(model.id);
    return toCatalogModel(model, oldById.get(model.id));
  });
  copilot.models = nextModels;

  const activeIdentities = new Set<string>();
  for (const [providerName, provider] of Object.entries(source.providers)) {
    for (const model of provider.models ?? []) {
      activeIdentities.add(identityKey({ provider: providerName, id: model.id }));
    }
  }

  const firstCopilotIndex = oldOrder.findIndex(({ identity }) => identity.provider === PROVIDER);
  const retained = oldOrder.filter(({ identity }) => activeIdentities.has(identityKey(identity)));
  const retainedKeys = new Set(retained.map(({ identity }) => identityKey(identity)));
  const missing = nextModels
    .map((model) => ({ provider: PROVIDER, id: model.id }))
    .filter((identity) => !retainedKeys.has(identityKey(identity)));
  const insertionIndex = firstCopilotIndex < 0
    ? retained.length
    : retained.filter(({ index }) => index < firstCopilotIndex).length;
  const nextOrderIdentities = retained.map(({ identity }) => identity);
  nextOrderIdentities.splice(insertionIndex, 0, ...missing);

  // Bare IDs are retained only while globally unambiguous. If discovery adds a
  // same-ID model under Copilot, qualify both profile references automatically.
  const nextOwnersById = providersById(source.providers);
  const nextProfileOrder = nextOrderIdentities.map((identity) => profileRef(identity, nextOwnersById));
  source.profileOrder = nextProfileOrder;

  const changed = added.length > 0 || removed.length > 0 ||
    nextModels.some((model, index) => JSON.stringify(model) !== JSON.stringify(oldModels[index])) ||
    JSON.stringify(nextProfileOrder) !== JSON.stringify(originalProfileOrder);
  if (!changed) {
    return { text: yamlText, changed: false, added, removed };
  }

  document.setIn(['providers', PROVIDER, 'models'], nextModels);
  document.set('profileOrder', nextProfileOrder);
  return {
    text: document.toString({ lineWidth: 0 }),
    changed: true,
    added,
    removed,
  };
}
