import type { BillableInvocationRecord } from '../usage-accounting/billable-invocation.js';
import type { SessionUsageSample } from '../usage-accounting/session-usage.js';
import type { CapturedPricingFacts } from './model-pricing-facts.js';

/** The usage evidence needed to calculate one invocation's captured catalog
 *  estimate. Timestamp strings are producer evidence; missing or invalid
 *  endpoints are not synthesized for scheduled pricing. */
export type InvocationPricingUsage = Pick<
  SessionUsageSample,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'startedAt' | 'endedAt'
>;

/** Pricing resolver input crossing the analytics/provider boundary. The facts
 *  are supplied by the provider pricing owner; an absent snapshot remains
 *  unpriced and never triggers a catalog lookup. */
export interface InvocationPricingInput {
  readonly facts: CapturedPricingFacts | undefined;
  readonly modelId: string | undefined;
  readonly provider: string | undefined;
  readonly usage: InvocationPricingUsage;
}

/** Provider-owned implementation of captured pricing selection and cost
 *  calculation, injected into analytics settlement. */
export type InvocationPricingResolver = (
  input: InvocationPricingInput,
) => BillableInvocationRecord['pricing'];
