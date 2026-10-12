// Pure offline catalog projection; completeness is not dispatch or authentication eligibility.
import type { ProviderApi, ProviderConfig, ProviderModelOverride, ProviderPricing } from './provider-config';

export type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
/** Discovery may know only some rates; missing rates are never filled with zero. */
export type ProviderModelMetadata = DeepReadonly<Omit<ProviderModelOverride, 'pricing'> & {
  api?: ProviderApi;
  baseUrl?: string;
  pricing?: 'unknown' | Partial<Exclude<ProviderPricing, 'unknown'>>;
}>;
export interface ShippedProviderDefinition {
  readonly api?: ProviderApi;
  readonly baseUrl?: string;
  readonly models?: Readonly<Record<string, ProviderModelMetadata>>;
}
export interface ProviderCatalogSnapshot {
  readonly kind: 'account' | 'public';
  readonly complete: boolean;
  readonly freshness: 'fresh' | 'stale';
  readonly models: Readonly<Record<string, ProviderModelMetadata>>;
}
export interface ResolvedModel {
  readonly providerId: string;
  readonly id: string;
  readonly label: string;
  readonly metadata: ProviderModelMetadata;
  readonly preferences: { readonly visible?: boolean; readonly subagentEligible?: boolean };
  readonly manuallyDeclared: boolean;
  readonly accountListing: 'listed-at-observation' | 'not-listed-at-observation' | 'unknown';
  readonly discoveryFreshness: 'fresh' | 'stale' | 'none';
  readonly missingRequestMetadata: readonly string[];
}
export interface ResolvedProvider {
  readonly id: string;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly models: Readonly<Record<string, ResolvedModel>>;
}
export interface ProviderModelList {
  readonly providers: Readonly<Record<string, ResolvedProvider>>;
}
export interface ProviderModelListInput {
  readonly config: DeepReadonly<ProviderConfig>;
  readonly shipped?: Readonly<Record<string, ShippedProviderDefinition>>;
  readonly discovered?: Readonly<Record<string, ProviderCatalogSnapshot>>;
}

const metadataFields = ['name', 'input', 'reasoning', 'contextWindow', 'maxTokens', 'api', 'baseUrl'] as const;
const pricingFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'tiers'] as const;
const protocols: readonly ProviderApi[] = ['openai-completions', 'mistral-conversations', 'openai-responses',
  'azure-openai-responses', 'openai-codex-responses', 'anthropic-messages', 'bedrock-converse-stream',
  'google-generative-ai', 'google-vertex'];

type Dictionary = Record<string, unknown>;
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}
function keys(...records: (object | undefined)[]): string[] {
  return [...new Set(records.flatMap(record => record ? Object.keys(record) : []))].sort();
}

/** Clone JSON-domain values before freezing: no input reference is retained or frozen. */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const result = dictionary<unknown>();
    for (const key of Object.keys(value).sort()) result[key] = clone((value as Dictionary)[key]);
    return result;
  }
  return value;
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function mergeMetadata(target: Dictionary, source: object | undefined): void {
  if (!source) return;
  const fields = source as Dictionary;
  for (const field of metadataFields) {
    if (Object.hasOwn(fields, field) && fields[field] !== undefined) target[field] = clone(fields[field]);
  }
  if (!Object.hasOwn(fields, 'pricing') || fields.pricing === undefined) return;
  if (fields.pricing === 'unknown') {
    target.pricing = 'unknown';
    return;
  }
  const previous = target.pricing;
  const rates = previous && typeof previous === 'object' ? previous as Dictionary : dictionary<unknown>();
  const supplied = fields.pricing as Dictionary;
  for (const field of pricingFields) {
    if (Object.hasOwn(supplied, field) && supplied[field] !== undefined) rates[field] = clone(supplied[field]);
  }
  target.pricing = rates;
}
function missingMetadata(metadata: ProviderModelMetadata): string[] {
  const missing: string[] = [];
  if (!protocols.includes(metadata.api as ProviderApi)) missing.push('api');
  let validUrl = false;
  if (typeof metadata.baseUrl === 'string' && metadata.baseUrl.trim()) {
    try {
      const url = new URL(metadata.baseUrl);
      validUrl = url.protocol === 'http:' || url.protocol === 'https:';
    } catch { /* Unresolved endpoint. */ }
  }
  if (!validUrl) missing.push('baseUrl');
  if (!Array.isArray(metadata.input) || !metadata.input.length
    || !metadata.input.every(input => input === 'text' || input === 'image')) missing.push('input');
  if (typeof metadata.reasoning !== 'boolean') missing.push('reasoning');
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    if (!Number.isInteger(metadata[field]) || !(metadata[field]! > 0)) missing.push(field);
  }
  return missing;
}

/** Resolve stable provider/model identities without routing, auth, I/O or policy defaults. */
export function resolveProviderModelList({ config, shipped = {}, discovered = {} }: ProviderModelListInput): ProviderModelList {
  const providers = dictionary<ResolvedProvider>();
  for (const providerId of keys(shipped, discovered, config.providers)) {
    const entry = own(config.providers, providerId);
    const definition = own(shipped, providerId);
    const snapshot = own(discovered, providerId);
    const manual = new Set(entry?.manualModels ?? []);
    const models = dictionary<ResolvedModel>();
    const modelIds = [...new Set([...keys(definition?.models, snapshot?.models,
      entry?.modelOverrides, entry?.modelPreferences), ...manual])].sort();
    for (const id of modelIds) {
      const metadata = dictionary<unknown>();
      // Provider defaults supply only transport fields, never arbitrary vendor fields.
      mergeMetadata(metadata, definition ? { api: definition.api, baseUrl: definition.baseUrl } : undefined);
      mergeMetadata(metadata, own(definition?.models, id));
      mergeMetadata(metadata, own(snapshot?.models, id));
      mergeMetadata(metadata, own(entry?.modelOverrides, id));
      mergeMetadata(metadata, entry ? { api: entry.api, baseUrl: entry.baseUrl } : undefined);
      const resolvedMetadata = metadata as ProviderModelMetadata;
      const preferences = dictionary<boolean>();
      const suppliedPreferences = own(entry?.modelPreferences, id);
      for (const flag of ['visible', 'subagentEligible'] as const) {
        if (suppliedPreferences && Object.hasOwn(suppliedPreferences, flag)
          && suppliedPreferences[flag] !== undefined) preferences[flag] = suppliedPreferences[flag];
      }
      const observed = !!snapshot && Object.hasOwn(snapshot.models, id);
      const accountListing = snapshot?.kind !== 'account' ? 'unknown'
        : observed ? 'listed-at-observation'
          : snapshot.freshness === 'fresh' && snapshot.complete ? 'not-listed-at-observation' : 'unknown';
      models[id] = {
        providerId, id,
        label: typeof resolvedMetadata.name === 'string' && resolvedMetadata.name.trim() ? resolvedMetadata.name : id,
        metadata: resolvedMetadata, preferences, manuallyDeclared: manual.has(id), accountListing,
        discoveryFreshness: snapshot?.freshness ?? 'none',
        missingRequestMetadata: missingMetadata(resolvedMetadata),
      };
    }
    providers[providerId] = { id: providerId, configured: entry !== undefined, enabled: entry?.enabled === true, models };
  }
  return freeze({ providers });
}
