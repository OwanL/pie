import { capturedModelFact } from '../../../analytics/usage-accounting/model-identity-facts.js';
import type { InvocationPricingResolver } from '../../../analytics/contracts/invocation-pricing-resolver.js';
import type {
  ModelTokenPricing,
  PricingIntervalEvidence,
} from '../../../analytics/contracts/model-pricing-facts.js';
import { pricingForPromptTokens, resolveApplicablePricing } from './pricing-core.js';

/** Resolve an invocation's estimate only from the captured provider facts and
 *  producer usage/timestamp evidence supplied by the caller. */
export const resolveCapturedInvocationPricing: InvocationPricingResolver = ({
  facts,
  modelId,
  provider,
  usage,
}) => {
  if (!modelId || !facts) return undefined;
  const key = capturedModelFact(modelId, facts.map)?.factKey;
  const records = key ? facts.map.get(key) : undefined;
  // A matching provider wins; a unique record is unambiguous only when the
  // provider dimension is absent. An explicitly named provider without a
  // matching record stays unknown — never another provider's rate.
  const pricing = provider
    ? records?.find((record) => record.provider === provider)?.pricing
    : records?.length === 1 ? records[0]?.pricing : undefined;
  if (!pricing) return undefined;
  // Preserve shared applicability semantics: scheduled pricing needs valid
  // observed endpoints within one band, and unsupported cache-read usage
  // remains unpriced.
  const band = resolveApplicablePricing(pricing, {
    interval: evidenceInterval(usage.startedAt, usage.endedAt),
    cacheReadTokens: usage.cacheReadTokens,
  });
  if (!band) return undefined;
  const effective = pricingForPromptTokens(
    band,
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  );
  return {
    catalogVersion: facts.catalogVersion,
    calculatedCostUsd: calculatedCost(usage, effective),
    rateSnapshot: {
      inputTokensUsdPerMillion: effective.input,
      outputTokensUsdPerMillion: effective.output,
      cacheReadTokensUsdPerMillion: effective.cacheRead,
      cacheWriteTokensUsdPerMillion: effective.cacheWrite,
    },
  };
};

/** Evidence interval for pricing applicability, only when both observed
 *  endpoints are valid timestamps. Missing or invalid times stay missing —
 *  they are never repaired into synthesized timing evidence. */
function evidenceInterval(
  startedAt: string | undefined,
  endedAt: string | undefined,
): PricingIntervalEvidence | undefined {
  if (!startedAt || !endedAt) return undefined;
  const startedAtMs = Date.parse(startedAt);
  const endedAtMs = Date.parse(endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
    || startedAtMs < 0 || endedAtMs < 0) {
    return undefined;
  }
  return { startedAtMs, endedAtMs };
}

function calculatedCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  pricing: ModelTokenPricing,
): number {
  return (usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * pricing.cacheRead
    + usage.cacheWriteTokens * pricing.cacheWrite) / 1_000_000;
}
