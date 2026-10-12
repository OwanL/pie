/** Shared offline new-chat capture. Missing config returns undefined (legacy).
 * Callers validate configuration before capture; malformed marker/artifact throws,
 * never falls back to legacy. Pass an absolute artifact directory outside Git.
 * Consumers must enforce enabled/visible/subagentEligible separately on every
 * lookup; rejected rows retain identity/policy but have no dispatchable model.
 * Credential references carry private opaque epochs, never credentials. Runtime services
 * resolve auth through the private managed broker and verified native SDK engine.
 */
export * from './contracts';
export { captureProviderRuntimeProjection, runtimeProtocols } from './projection';
export { saveProviderRuntimeProjection, readProviderRuntimeProjection,
  appendProviderRuntimeReference, readProviderRuntimeReference } from './store';
export { createProviderRuntimeServices, assertProviderRuntimeModel } from './services';
export type { ProviderRuntimeServices, ProviderRuntimeAuthStorage, ProviderRuntimeModelRegistry,
  RuntimeRequestAuth, RuntimeAuthStatus } from './services';
export { buildProviderRuntimePricingFacts } from './pricing-facts';
