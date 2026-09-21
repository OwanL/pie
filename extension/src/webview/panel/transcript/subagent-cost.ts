import { providerReportedCostUsd } from '../../../../../shared/provider-cost.js';
import {
  getSubagentBillingEntries,
} from '../../../shared/subagent-result';
import type {
  SubagentBillingAttempt,
  SubagentBillingEntry,
  SubagentBillingUsage,
} from '../../../shared/live-pipeline-protocol';
import {
  resolveUsageCost,
  type CostUsage,
  type TokenPricingResolver,
} from '../session-tabs/token-usage';

/** Cost shown on a subagent transcript card. Calculated values are deliberately
 * marked so the UI does not present a catalog projection as provider billing. */
export interface SubagentDisplayCost {
  cost: number;
  estimated: boolean;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reportedCost(usage: SubagentBillingUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return providerReportedCostUsd(usage)
    ?? finiteNonNegative(usage.cost);
}

function toCostUsage(usage: SubagentBillingUsage): CostUsage {
  const inputTokens = finiteNonNegative(usage.input) ?? 0;
  const outputTokens = finiteNonNegative(usage.output) ?? 0;
  const cacheReadTokens = finiteNonNegative(usage.cacheRead) ?? 0;
  const cacheWriteTokens = finiteNonNegative(usage.cacheWrite) ?? 0;
  const channelTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const declaredTotal = finiteNonNegative(usage.totalTokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: Math.max(channelTokens, declaredTotal),
    tokenChannelsKnown: usage.tokenChannelsKnown,
    tokenChannelPresence: usage.tokenChannelPresence,
  };
}

function usageDisplayCost(
  usage: SubagentBillingUsage | undefined,
  modelId: string | undefined,
  provider: string | undefined,
  pricingForModel: TokenPricingResolver | undefined,
): SubagentDisplayCost | undefined {
  if (!usage) return undefined;
  const exact = reportedCost(usage);
  const pricing = modelId ? pricingForModel?.(modelId, provider) : undefined;
  const resolved = resolveUsageCost(toCostUsage(usage), pricing, exact);
  if (!resolved.hasKnownCost) return undefined;
  return { cost: resolved.cost, estimated: exact === undefined };
}

function usageListDisplayCost(
  usages: readonly SubagentBillingAttempt[],
  entry: SubagentBillingEntry,
  pricingForModel: TokenPricingResolver | undefined,
): SubagentDisplayCost | undefined {
  if (usages.length === 0) return undefined;
  let cost = 0;
  let estimated = false;
  for (const item of usages) {
    if ((item.usage?.turns ?? 1) > 1 && reportedCost(item.usage) === undefined) return undefined;
    const display = usageDisplayCost(
      item.usage,
      item.model ?? entry.model ?? entry.selectedModel,
      item.provider ?? entry.provider,
      pricingForModel,
    );
    // Do not show a known subtotal when one provider invocation is still
    // missing pricing or token channels. The session metrics engine likewise
    // keeps incomplete totals out of the known-cost path.
    if (!display) return undefined;
    cost += display.cost;
    estimated ||= display.estimated;
  }
  return { cost, estimated };
}

/** Resolve the display cost for one direct child result. `providerInvocations`
 * are preferred because catalog tiers apply independently to each provider
 * response; aggregate usage is only an exact fallback when no per-invocation
 * evidence is available. */
export function subagentDisplayCostForEntry(
  entry: SubagentBillingEntry | undefined,
  pricingForModel?: TokenPricingResolver,
): SubagentDisplayCost | undefined {
  if (!entry) return undefined;

  if (entry.omittedInvocationCount && entry.omittedInvocationCount > 0) return undefined;

  if (entry.invocations && entry.invocations.length > 0) {
    return usageListDisplayCost(entry.invocations, entry, pricingForModel);
  }

  // A producer-supplied aggregate report is exact evidence for the whole
  // child only when no per-invocation records are available. It preserves an
  // explicit zero for legacy single-record results.
  const aggregateReported = reportedCost(entry.usage);
  if (aggregateReported !== undefined) {
    return { cost: aggregateReported, estimated: false };
  }

  // Retry attempts are a compatibility fallback for records written before
  // providerInvocations was added. Only use them when each attempt carries a
  // single-turn usage record; otherwise repricing would aggregate tiers across
  // turns.
  if (entry.attempts && entry.attempts.length > 0) {
    // An attempt without an explicit turn count is not safe to reprice: it may
    // be a cumulative retry record. Exact provider reports remain usable.
    if (entry.attempts.some((attempt) => (
      reportedCost(attempt.usage) === undefined && attempt.usage?.turns !== 1
    ))) return undefined;
    return usageListDisplayCost(entry.attempts, entry, pricingForModel);
  }

  if ((entry.usage?.turns ?? 1) > 1) return undefined;
  return usageDisplayCost(
    entry.usage,
    entry.model ?? entry.selectedModel,
    entry.provider,
    pricingForModel,
  );
}

/** Resolve direct child costs in render order. The billing extractor also
 * contains recursive descendants, so exact path matching prevents a nested
 * child from being mistaken for its parent card. */
export function subagentDisplayCosts(
  rawResult: unknown,
  resultCount: number,
  pricingForModel?: TokenPricingResolver,
): Array<SubagentDisplayCost | undefined> {
  const entries = getSubagentBillingEntries(rawResult);
  return Array.from({ length: resultCount }, (_, index) => subagentDisplayCostForEntry(
    entries.find((entry) => entry.path === String(index)),
    pricingForModel,
  ));
}
