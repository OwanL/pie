import type { ConcurrencyLimitSource, ResolvedConcurrencyLimit } from '../../../lib/concurrency-config.js';

/** Safety cap used only when neither a saved preference nor catalog default is valid. */
export const PROVIDER_SAFETY_FALLBACK_MAX_CONCURRENT_REQUESTS = 1;

/** Provider concurrency values are bounded at the shared config/RPC seam. */
export function isProviderMaxConcurrentRequests(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= PROVIDER_UNLIMITED_CONCURRENCY
    && Number(value) <= PROVIDER_MAX_CONCURRENT_REQUESTS;
}

/** Resolve a provider max from its saved preference, catalog default, or the
 * existing fail-closed safety fallback. 0 is a valid Unlimited setting. */
export function resolveProviderMaxConcurrentRequests(
  savedPreference: unknown,
  configuredDefault: unknown,
  safetyFallback = PROVIDER_SAFETY_FALLBACK_MAX_CONCURRENT_REQUESTS,
): ResolvedConcurrencyLimit {
  if (isProviderMaxConcurrentRequests(savedPreference)) {
    return { value: savedPreference, source: 'saved-preference' };
  }
  if (isProviderMaxConcurrentRequests(configuredDefault)) {
    return { value: configuredDefault, source: 'configured-default' };
  }
  return {
    value: isProviderMaxConcurrentRequests(safetyFallback)
      ? safetyFallback
      : PROVIDER_SAFETY_FALLBACK_MAX_CONCURRENT_REQUESTS,
    source: 'safety-fallback',
  };
}

export type { ConcurrencyLimitSource };

/** Per-provider concurrency overrides, user-configurable in runtime settings.
 * Each field is optional: `undefined` means use the provider catalog default. */
export interface ProviderConcurrencyOverrides {
  /** Max concurrent in-flight LLM requests to this provider. 0 = Unlimited. */
  maxConcurrentRequests?: number;
  /** Per-session sticky-slot window in seconds (0 = disabled). */
  afterburnSeconds?: number;
  /** Max seconds a queued request waits for a slot before failing. 0 = safety maximum. */
  queueWaitSeconds?: number;
  /** Max seconds to wait for upstream response headers before aborting. 0 = gate default. */
  headerWaitSeconds?: number;
}

/** Per-provider concurrency overrides keyed by provider name. */
export type ProviderConcurrencyMap = Record<string, ProviderConcurrencyOverrides>;

/** Provider-gate wire/config bounds shared with RPC validation and the runtime. */
export const PROVIDER_UNLIMITED_CONCURRENCY = 0;
export const PROVIDER_MAX_CONCURRENT_REQUESTS = 128;
export const PROVIDER_MAX_AFTERBURN_SECONDS = 300;
export const PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS = 300;
export const PROVIDER_NETWORK_PHASE_MAX_WAIT_MS = PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS * 1000;
