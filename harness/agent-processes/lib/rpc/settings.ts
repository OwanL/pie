import type { HistoryCompactionSettings } from '../../../session-storage/settings/history-compaction.js';
import type { ProviderConcurrencyMap } from '../../../model-providers/concurrency/provider-concurrency.js';
import type { ThinkingLevel } from '../../../model-providers/catalog/thinking-level.js';
export type SettingsPersistenceScope = 'session' | 'global';

/** Optional discriminator for the model/reasoning settings.set request.
 *  Omission preserves the existing shared-default behavior. */
export interface SettingsSetPersistenceParams {
  persistenceScope?: SettingsPersistenceScope;
}

export type {
  HistoryCompactionModelProfile,
  HistoryCompactionModelSelector,
  HistoryCompactionSettings,
  HistoryCompactionSummaryThinkingLevel,
  HistoryCompactionThresholdMode,
} from '../../../session-storage/settings/history-compaction.js';

/** One provider-qualified model/reasoning assignment used by subagent routing. */
export interface SubagentBucketAssignment {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface SubagentBuckets {
  small: SubagentBucketAssignment[];
  medium: SubagentBucketAssignment[];
  frontier: SubagentBucketAssignment[];
}

export const EMPTY_SUBAGENT_BUCKETS: SubagentBuckets = { small: [], medium: [], frontier: [] };

export interface NestedAllowedBuckets {
  small: boolean;
  medium: boolean;
  frontier: boolean;
}

export const ALL_NESTED_BUCKETS_ALLOWED: NestedAllowedBuckets = {
  small: true,
  medium: true,
  frontier: true,
};

export interface SubagentBucketCanSpawn {
  small: boolean;
  medium: boolean;
  frontier: boolean;
}

export const ALL_SUBAGENT_BUCKETS_CAN_SPAWN: SubagentBucketCanSpawn = {
  small: true,
  medium: true,
  frontier: true,
};

export const PROVIDER_TOGGLES_ENV = 'PIE_PROVIDER_TOGGLES_JSON';
export const SUBAGENT_PROVIDER_DEFAULTS_ENV = 'PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON';
export const SUBAGENT_PROVIDER_TOGGLES_ENV = 'PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON';
export const AUTONOMOUS_MODE_BY_SESSION_ENV = 'PIE_AUTONOMOUS_MODE_BY_SESSION_JSON';
export const SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV = 'PIE_SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS';
export const SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV = 'PIE_SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE';
export const EXTENSION_TOGGLES_ENV = 'PIE_EXTENSION_TOGGLES_JSON';
export const SUBAGENT_BUCKETS_ENV = 'PIE_SUBAGENT_BUCKETS_JSON';
export const NESTED_ALLOWED_BUCKETS_ENV = 'PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON';
export const SUBAGENT_BUCKET_CAN_SPAWN_ENV = 'PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON';

/** Canonical host-to-backend payload for runtime preference updates. */
export interface RuntimePrefsSetParams {
  providerToggles: Record<string, boolean>;
  autonomousMode?: boolean;
  /** Per-root-session autonomous overrides. Missing paths use autonomousMode. */
  autonomousModeBySession?: Record<string, boolean>;
  mcpEnabled?: boolean;
  subagentProviderDefaults?: Record<string, boolean>;
  subagentProviderTogglesBySession?: Record<string, Record<string, boolean>>;
  extensionToggles: Record<string, boolean>;
  subagentAlwaysParentModel?: boolean;
  subagentRouteAroundSaturatedProviders?: boolean;
  subagentFallbackOnProviderFailure?: boolean;
  subagentMaxDepth?: number;
  subagentMaxTreeSessions?: number;
  subagentMaxInflight?: number;
  bashWarmPoolSize?: number;
  bashFastPath?: boolean;
  bashShellPath?: string;
  bashWarmupTimeoutMs?: number;
  bashAcquireTimeoutMs?: number;
  bashDefaultTimeout?: number;
  subagentBuckets?: SubagentBuckets;
  subagentNestedAllowedBuckets?: NestedAllowedBuckets;
  subagentBucketCanSpawn?: SubagentBucketCanSpawn;
  subagentDropTools?: string[];
  providerConcurrency?: ProviderConcurrencyMap;
  historyCompaction?: HistoryCompactionSettings;
}
