// Bounded offline adapter. Callers own paths, revisions and persistence.
import { isDeepStrictEqual } from 'node:util';
import { validateProviderConfig, type ProviderConfig, type ProviderConfigDiagnostic } from '../catalog/provider-config';
import type { ProviderConfigEdit } from '../catalog/provider-config-writer';
import type { ProviderModelList } from '../catalog/provider-model-resolution';
import type { ProviderSetupDraft, ProviderSetupModel, ProviderSetupPreference } from './contracts';

const own = <T>(record: Record<string, T> | Readonly<Record<string, T>> | undefined, id: string): T | undefined =>
  record && Object.hasOwn(record, id) ? record[id] : undefined;
const preference = (value: boolean | undefined): ProviderSetupPreference => value === undefined ? 'unset' : value ? 'yes' : 'no';
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
  }
  return value;
}

export function createProviderSetupDraft(config: ProviderConfig, resolvedList: ProviderModelList, id?: string): ProviderSetupDraft {
  const entry = id === undefined ? undefined : own(config.providers, id);
  const resolved = id === undefined ? undefined : own(resolvedList.providers, id);
  const models: ProviderSetupModel[] = Object.values(resolved?.models ?? {}).map(model => {
    const rates = model.metadata.pricing;
    const pricing: ProviderSetupModel['pricing'] = { kind: 'unknown', tiered: false };
    if (rates && rates !== 'unknown') {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (typeof rates[field] === 'number') pricing[field] = rates[field];
      }
      const rateCount = ['input', 'output', 'cacheRead', 'cacheWrite'].filter(field => pricing[field as keyof typeof pricing] !== undefined).length;
      pricing.kind = rateCount === 4 ? 'known' : rateCount > 0 ? 'partial' : 'unknown';
      pricing.tiered = !!rates.tiers?.length;
    }
    const prefs = own(entry?.modelPreferences, model.id);
    return { id: model.id, name: model.label, visible: preference(prefs?.visible),
      subagentEligible: preference(prefs?.subagentEligible), pricing };
  });
  return { originalId: entry ? id! : null, id: id ?? '', enabled: entry?.enabled ?? false,
    api: entry?.api ?? '', baseUrl: entry?.baseUrl ?? '', credentialSource: entry?.credentialRef?.source ?? 'default',
    environmentName: entry?.credentialRef?.source === 'environment' ? entry.credentialRef.name : '', models,
    ...(entry?.manualModels === undefined ? {} : { manualModelIds: [...entry.manualModels] }) };
}

export type PreparedProviderSetupSave = { status: 'valid'; config: ProviderConfig; edits: ProviderConfigEdit[] }
  | { status: 'invalid'; diagnostic: ProviderConfigDiagnostic };
/** Existing settings never manufacture a replacement transport or credential policy. */
export function createExistingProviderSetupDraft(config: ProviderConfig, resolvedList: ProviderModelList, id: string): ProviderSetupDraft {
  const draft = createProviderSetupDraft(config, resolvedList, id);
  return { ...draft, originalId: id, enabled: own(config.providers, id)?.enabled ?? true,
    api: '', baseUrl: '', credentialSource: 'legacy', environmentName: '' };
}

export function prepareProviderSetupSave(config: ProviderConfig, draft: ProviderSetupDraft,
  options: { existingConnection?: boolean } = {}): PreparedProviderSetupSave {
  const invalid = (path: string, message: string): PreparedProviderSetupSave => ({ status: 'invalid', diagnostic: {
    code: 'schema-invalid', message: 'Provider configuration edit is invalid.', issues: [{ path, message }],
  } });
  if (draft.originalId !== null && (draft.id !== draft.originalId || (!own(config.providers, draft.originalId) && !options.existingConnection))) {
    return invalid('/providers', 'Existing provider identities cannot be renamed or replaced.');
  }
  if (draft.originalId === null && own(config.providers, draft.id)) return invalid('/providers', 'Provider identity is already configured.');
  const next = clone(config);
  const existing = own(config.providers, draft.id);
  if (!existing) next.providers[draft.id] = Object.create(null);
  const edits: ProviderConfigEdit[] = [];
  const change = (suffix: string[], value: unknown): void => {
    let target = next.providers[draft.id] as unknown as Record<string, unknown>;
    for (const key of suffix.slice(0, -1)) {
      if (!own(target, key)) target[key] = Object.create(null);
      target = target[key] as Record<string, unknown>;
    }
    const key = suffix.at(-1)!;
    if (value === undefined) {
      if (Object.hasOwn(target, key)) { delete target[key]; edits.push({ op: 'delete', path: ['providers', draft.id, ...suffix] }); }
    } else if (!Object.hasOwn(target, key) || !isDeepStrictEqual(target[key], clone(value))) {
      target[key] = value;
      edits.push({ op: 'set', path: ['providers', draft.id, ...suffix], value });
    }
  };
  change(['enabled'], draft.enabled);
  if (options.existingConnection) {
    change(['credentialRef'], { source: 'legacy' });
  } else {
    change(['api'], draft.api === '' ? undefined : draft.api);
    change(['baseUrl'], draft.baseUrl === '' ? undefined : draft.baseUrl);
    change(['credentialRef'], draft.credentialSource === 'default' ? undefined
      : draft.credentialSource === 'saved' ? { source: 'saved' }
        : draft.credentialSource === 'legacy' ? { source: 'legacy' }
          : draft.credentialSource === 'none' ? { source: 'none' } : { source: 'environment', name: draft.environmentName });
  }
  for (const model of draft.models) {
    for (const flag of ['visible', 'subagentEligible'] as const) {
      const value = model[flag];
      // Unset must not manufacture empty preference containers.
      if (value === 'unset' && own(own(existing?.modelPreferences, model.id) ?? {}, flag) === undefined) continue;
      change(['modelPreferences', model.id, flag], value === 'unset' ? undefined
        : value === 'yes' ? true : value === 'no' ? false : value);
    }
  }
  if (!options.existingConnection && draft.manualModelIds !== undefined) change(['manualModels'], draft.manualModelIds);
  const validated = validateProviderConfig(next);
  return validated.status === 'valid' ? { ...validated, edits } : validated;
}
