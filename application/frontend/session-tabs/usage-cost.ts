/** Pure per-record pricing rules, independent of session aggregation and display. */
export interface TokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<TokenPricing & { inputTokensAbove: number }>;
}

export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  tokenChannelsKnown?: boolean;
  tokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
}

export function tokenChannelsComplete(usage: CostUsage): boolean {
  if (usage.tokenChannelsKnown === false) return false;
  if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .every((value) => Number.isFinite(value) && value >= 0)) {
    return false;
  }
  if (!usage.tokenChannelPresence) return true;
  return usage.tokenChannelPresence.input === true
    && usage.tokenChannelPresence.output === true
    && usage.tokenChannelPresence.cacheRead === true
    && usage.tokenChannelPresence.cacheWrite === true;
}

export function effectivePricing(usage: CostUsage, pricing: TokenPricing): TokenPricing {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  let effective = pricing;
  for (const tier of pricing.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove) effective = tier;
  }
  return effective;
}

export function costFromUsage(usage: CostUsage, pricing: TokenPricing, applyLongContextTier = true): number {
  const effective = applyLongContextTier ? effectivePricing(usage, pricing) : pricing;
  return ((usage.inputTokens / 1_000_000) * effective.input)
    + ((usage.outputTokens / 1_000_000) * effective.output)
    + ((usage.cacheReadTokens / 1_000_000) * effective.cacheRead)
    + ((usage.cacheWriteTokens / 1_000_000) * effective.cacheWrite);
}

export function costBreakdownFromUsage(usage: CostUsage, pricing: TokenPricing) {
  const effective = effectivePricing(usage, pricing);
  const input = (usage.inputTokens / 1_000_000) * effective.input;
  const output = (usage.outputTokens / 1_000_000) * effective.output;
  const cacheRead = (usage.cacheReadTokens / 1_000_000) * effective.cacheRead;
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * effective.cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

export interface ResolvedUsageCost {
  cost: number;
  hasKnownCost: boolean;
  unpricedTokens: number;
  catalogBreakdown: ReturnType<typeof costBreakdownFromUsage> | null;
}

export function tokenChannelTotal(usage: CostUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Resolve one usage record without turning an unavailable token split into a
 * known zero. A catalog can price a record only when its four channels account
 * for the reported total; otherwise a stored/provider cost is the only usable
 * total. */
export function resolveUsageCost(
  usage: CostUsage,
  pricing: TokenPricing | undefined,
  reportedCostUsd: number | undefined,
  applyLongContextTier = true,
): ResolvedUsageCost {
  // A genuine provider report, including an explicit zero, remains
  // authoritative even when complete token channels allow catalog pricing.
  const hasUsableReportedCost = typeof reportedCostUsd === 'number'
    && Number.isFinite(reportedCostUsd)
    && reportedCostUsd >= 0;
  if (hasUsableReportedCost) {
    return {
      cost: reportedCostUsd,
      hasKnownCost: true,
      unpricedTokens: 0,
      catalogBreakdown: null,
    };
  }

  const channelTokens = tokenChannelTotal(usage);
  const canUseCatalog = pricing !== undefined
    && tokenChannelsComplete(usage)
    && usage.totalTokens > 0
    && channelTokens === usage.totalTokens;
  if (canUseCatalog) {
    const catalogBreakdown = applyLongContextTier ? costBreakdownFromUsage(usage, pricing!) : null;
    return {
      cost: catalogBreakdown?.total ?? costFromUsage(usage, pricing!, false),
      hasKnownCost: true,
      unpricedTokens: 0,
      catalogBreakdown,
    };
  }

  // Missing token channels and missing provider evidence remain unknown rather
  // than becoming a fabricated zero.
  return {
    cost: 0,
    hasKnownCost: false,
    unpricedTokens: usage.totalTokens,
    catalogBreakdown: null,
  };
}
