/** Browser-safe adapter for the canonical provider concurrency contract. */
export type {
  ProviderConcurrencyMap,
  ProviderConcurrencyOverrides,
} from '../../../harness/model-providers/concurrency/provider-concurrency.js';
export {
  PROVIDER_MAX_AFTERBURN_SECONDS,
  PROVIDER_MAX_CONCURRENT_REQUESTS,
  PROVIDER_NETWORK_PHASE_MAX_WAIT_MS,
  PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS,
  PROVIDER_UNLIMITED_CONCURRENCY,
} from '../../../harness/model-providers/concurrency/provider-concurrency.js';
