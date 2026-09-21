/** Shared provider-concurrency policy bounds.
 *
 * `maxConcurrentRequests = 0` is the explicit Unlimited sentinel. It is
 * deliberately distinct from an omitted value: omitted settings preserve the
 * models.yaml/provider default, while zero disables only concurrency and
 * afterburn capacity throttling. Provider circuit and network-phase deadlines
 * remain active.
 */
export const PROVIDER_UNLIMITED_CONCURRENCY = 0;
export const PROVIDER_MAX_CONCURRENT_REQUESTS = 128;

/** Afterburn is capacity retention, not a network deadline. Keep it finite and
 * within the same five-minute operational envelope as provider phases. */
export const PROVIDER_MAX_AFTERBURN_SECONDS = 300;

/** Queue, response-header, and response-body idle phases are each capped at
 * five minutes. Zero queue wait retains its existing safety-max meaning. */
export const PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS = 300;
export const PROVIDER_NETWORK_PHASE_MAX_WAIT_MS = PROVIDER_NETWORK_PHASE_MAX_WAIT_SECONDS * 1000;
