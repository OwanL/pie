import type { ModelTokenPricing } from '../../../analytics/contracts/model-pricing-facts';
import type { DeepReadonly, ProviderCatalogSnapshot, ShippedProviderDefinition } from '../catalog/provider-model-resolution';
import type { ProviderConfig } from '../catalog/provider-config';

/** SDK-free DTO: pass registry models, never registry/auth objects. */
export interface NativeRuntimeModel {
  provider: string; id: string; name: string; api: string; baseUrl: string;
  input: ('text' | 'image')[]; reasoning: boolean; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown };
  /** Native protocol behavior, copied only from the captured native baseline. */
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}
export type CredentialSource = { source: 'legacy' | 'none' | 'default' }
  | { source: 'saved'; scope?: string }
  | { source: 'environment'; name: string };
export interface RuntimeModelProjection {
  providerId: string; id: string; enabled: boolean; visible: boolean; subagentEligible: boolean;
  credential: CredentialSource;
  pricingFacts?: ModelTokenPricing;
  builtinHeaders?: { provider: string; id: string; sha256: string };
  model?: NativeRuntimeModel;
  rejection?: 'unsupported-or-incomplete-runtime-model';
}
export interface ProviderRuntimeProjection {
  version: 1; configRevision: string; models: RuntimeModelProjection[];
}
export type RuntimeSnapshot = DeepReadonly<ProviderRuntimeProjection>;
/** Read-only approved SDK builtin baseline resolver used by read-time recovery.
 *  Returns the public DTO definition for an exact provider/id only, resolved
 *  from the loaded verified SDK's own generated catalog (never user models,
 *  registry/auth objects or live state). */
export type BuiltinRuntimeModelResolver = (provider: string, id: string) => NativeRuntimeModel | undefined;
export interface CaptureProviderRuntimeInput {
  /** undefined means missing configuration / legacy mode. Invalid configuration must not be passed. */
  config?: ProviderConfig; configRevision?: string;
  legacyModels: readonly NativeRuntimeModel[];
  /** Verified compiled SDK definitions only; never user registry models. */
  builtinModels?: readonly NativeRuntimeModel[];
  /** Approved deployed shipped catalog, not arbitrary registry definitions. Exact provider/id only. */
  shippedCatalog?: Readonly<Record<string, ShippedProviderDefinition>>;
  discovered?: Readonly<Record<string, ProviderCatalogSnapshot>>;
  /** Private opaque UUID epochs, obtained only for credentials actually saved. */
  credentialScopes?: Readonly<Record<string, string | undefined>>;
}
export interface ProviderRuntimeReference { version: 1; sha256: string }
export interface RuntimeEntryManager {
  getEntries(): readonly { type: string; customType?: string; data?: unknown }[];
  appendCustomEntry(customType: string, data: unknown): unknown;
}
