import { providerReportedCostUsd } from '../../../../../shared/provider-cost.js';
import { providerPrefixOf, qualifyModelId as qualifyBillingModelId, stripProviderPrefix } from '../../../shared/model-id';
import type {
  AssistantUsage,
  CanonicalActivityCounts,
  CanonicalActivityProjectionView,
  CanonicalActivityView,
  CanonicalAnalyticsCoverage,
  CanonicalToolFacetProjectionView,
  ChatMessage,
  ContextWindowUsage,
  ModelInfo,
  PruningDetails,
  SessionSummary,
  ToolCall,
} from '../../../shared/protocol';
import { formatToolResult } from '../../../shared/tool-result-format';
import { getSubagentResultEntries, type RawMessage } from '../../../shared/subagent-result';
import { estimateLiveAssistantOutputTokens } from '../../../shared/token-rate';
import {
  assistantUsageFromSample,
  type SessionUsageSnapshot,
} from '../../../shared/session-usage';
import {
  formatTokens as formatReadableTokens,
  formatCompactTokens,
  formatCost as formatCostUsd,
} from '../utils/format-tokens';

/**
 * Aggregate token usage for a session derived from per-assistant-message usage
 * reported by the backend. Pure summation \u2014 mirrors what we display in the UI
 * and what analytics records.
 */
export interface SessionTokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Sum of provider-reported reasoning tokens (a subset of `outputTokens`). */
  reasoningTokens: number;
  /** Number of invocation rows represented by the summary. */
  reportedTurnCount: number;
  /** Rows whose token channels are unavailable; displayed totals are known subtotals. */
  incompleteInvocationCount: number;
  /** Rows contributing known token-channel values. */
  knownTokenInvocationCount: number;
  /** True when no authoritative ledger snapshot was supplied. */
  accountingUnknown: boolean;
}

export function buildSessionTokenUsage(transcript: ChatMessage[]): SessionTokenUsageSummary {
  return buildSessionTokenUsageFromSnapshot({
    samples: transcript
      .filter((message) => message.role === 'assistant' && message.usage)
      .map((message) => ({
        sourceId: `assistant:${message.durableEntryId ?? message.id}`,
        kind: 'assistant' as const,
        modelId: message.modelId,
        provider: message.provider,
        ...message.usage!,
      })),
  });
}

export function buildSessionTokenUsageFromSnapshot(snapshot: SessionUsageSnapshot): SessionTokenUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let reportedTurnCount = 0;
  let incompleteInvocationCount = 0;
  let knownTokenInvocationCount = 0;

  for (const sample of snapshot.samples) {
    const usage = assistantUsageFromSample(sample);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalTokens += usage.totalTokens;
    reasoningTokens += usage.reasoningTokens ?? 0;
    reportedTurnCount += 1;
    if (!tokenChannelsComplete(sample) || sample.instrumentationGap) {
      incompleteInvocationCount += 1;
    } else {
      knownTokenInvocationCount += 1;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reasoningTokens,
    reportedTurnCount,
    incompleteInvocationCount: Math.max(incompleteInvocationCount, snapshot.incompleteInvocationCount ?? 0),
    knownTokenInvocationCount,
    accountingUnknown: snapshot.authority === 'unknown',
  };
}

export { formatReadableTokens, formatCompactTokens, formatCostUsd };

/** Keep the active-turn chip in step with the gross aggregate cost. The normal
 * session formatter intentionally collapses sub-cent values, but a live turn
 * needs enough precision for successive streaming updates to be visible. */
function formatLiveCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return formatCostUsd(cost);
}

export interface TokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<TokenPricing & { inputTokensAbove: number }>;
}

export type TokenPricingResolver = (modelId: string, provider?: string) => TokenPricing | undefined;

/** Build the provider-qualified pricing lookup shared by session metrics and
 * transcript display. A bare model id is only used when it is unique across
 * providers; an explicit provider always wins. */
export function createTokenPricingResolver(
  availableModels: readonly ModelInfo[],
): TokenPricingResolver {
  const byProviderAndId = new Map<string, TokenPricing>();
  const uniqueById = new Map<string, TokenPricing>();
  const seenIds = new Set<string>();
  for (const model of availableModels) {
    const pricing = model.subagent?.pricing;
    const bareId = stripProviderPrefix(model.id);
    if (pricing) byProviderAndId.set(`${model.provider}\u0000${bareId}`, pricing);
    if (seenIds.has(bareId)) {
      uniqueById.delete(bareId);
    } else {
      seenIds.add(bareId);
      if (pricing) uniqueById.set(bareId, pricing);
    }
  }

  return (modelId: string, provider?: string) => {
    const bareId = stripProviderPrefix(modelId);
    const resolvedProvider = provider ?? providerPrefixOf(modelId);
    return resolvedProvider
      ? byProviderAndId.get(`${resolvedProvider}\u0000${bareId}`)
      : uniqueById.get(bareId);
  };
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

function tokenChannelsComplete(usage: CostUsage): boolean {
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

export interface LiveSessionCostEstimate extends CostUsage {
  source: 'live-context';
  /**
   * Canonical context footprint reported while the turn is running. The live
   * signal does not classify these tokens as uncached input, cache read, or
   * cache write, so they must not be assigned any of those rates yet.
   */
  unclassifiedContextTokens: number;
}

export interface SessionCostModelBreakdown {
  provider: string;
  model: string;
  cost: number;
  hasKnownCost: boolean;
  unpricedTokens: number;
}

export interface SessionCostProviderBreakdown {
  provider: string;
  cost: number;
  hasKnownCost: boolean;
  unpricedTokens: number;
  models: SessionCostModelBreakdown[];
}

export interface SessionCostSourceBreakdown {
  key: 'conversation' | 'subagents' | 'pruning' | 'retry' | 'history_compaction' | 'branch_summary' | 'session_title' | 'other' | 'live';
  label: string;
  cost: number;
  hasKnownCost: boolean;
  unpricedTokens: number;
  tokens: number;
}

export interface SessionCostBreakdown {
  totalCost: number;
  hasIncompleteCost: boolean;
  unpricedTokens: number;
  reportedTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  providers: SessionCostProviderBreakdown[];
  sources: SessionCostSourceBreakdown[];
}

export interface SessionCostIndicatorState {
  label: string;
  ariaLabel: string;
  tooltip: string;
  /** Durable usage freshness is explicit so stale costs are never presented as fresh. */
  freshness?: SessionUsageSnapshot['freshness'];
  refreshStatus?: SessionUsageSnapshot['refreshStatus'];
  /** Structured whole-branch data for the graph-bearing rich tooltip. */
  breakdown: SessionCostBreakdown;
}

type PruningCostDetails = PruningDetails & {
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  prepassReportedCostUsd?: number;
};

interface ModelCostBreakdown extends CostUsage {
  /** Provider-qualified billing identity when known (`provider/model`). */
  modelId: string;
  cost: number;
  hasKnownCost: boolean;
  /** Usage whose cost cannot yet be included (missing pricing/billing split). */
  unpricedTokens: number;
}

function emptyCostUsage(): CostUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function normalizeModelId(modelId: string | undefined, fallback: string): string {
  const normalized = modelId?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function addModelCost(
  models: Map<string, ModelCostBreakdown>,
  modelId: string,
  usage: CostUsage,
  cost: number,
  hasKnownCost: boolean,
  unpricedTokens = 0,
): void {
  const existing = models.get(modelId) ?? {
    modelId,
    ...emptyCostUsage(),
    cost: 0,
    hasKnownCost: false,
    unpricedTokens: 0,
  };

  existing.inputTokens += usage.inputTokens;
  existing.outputTokens += usage.outputTokens;
  existing.cacheReadTokens += usage.cacheReadTokens;
  existing.cacheWriteTokens += usage.cacheWriteTokens;
  existing.totalTokens += usage.totalTokens;
  existing.cost += cost;
  existing.hasKnownCost ||= hasKnownCost;
  existing.unpricedTokens += unpricedTokens;
  models.set(modelId, existing);
}

function mergeModelCosts(target: Map<string, ModelCostBreakdown>, source: Map<string, ModelCostBreakdown>): void {
  for (const entry of source.values()) {
    const existing = target.get(entry.modelId) ?? {
      modelId: entry.modelId,
      ...emptyCostUsage(),
      cost: 0,
      hasKnownCost: false,
      unpricedTokens: 0,
    };
    existing.inputTokens += entry.inputTokens;
    existing.outputTokens += entry.outputTokens;
    existing.cacheReadTokens += entry.cacheReadTokens;
    existing.cacheWriteTokens += entry.cacheWriteTokens;
    existing.totalTokens += entry.totalTokens;
    existing.cost += entry.cost;
    existing.hasKnownCost ||= entry.hasKnownCost;
    existing.unpricedTokens += entry.unpricedTokens;
    target.set(entry.modelId, existing);
  }
}

interface FormattedProviderModelCosts {
  lines: string[];
  /** Sum of the exact four-decimal amounts rendered in `lines`. */
  displayedKnownCostUnits: number;
}

const COST_DETAIL_SCALE = 10_000;

function costDetailUnits(cost: number): number {
  return Math.round(Math.max(0, cost) * COST_DETAIL_SCALE);
}

function formatCostDetailUnits(units: number): string {
  return `$${(units / COST_DETAIL_SCALE).toFixed(4)}`;
}

function providerModelBreakdown(models: Map<string, ModelCostBreakdown>): SessionCostProviderBreakdown[] {
  const providers = new Map<string, SessionCostProviderBreakdown>();
  for (const entry of models.values()) {
    if (!entry.hasKnownCost && entry.unpricedTokens <= 0) continue;
    const separator = entry.modelId.indexOf('/');
    const provider = separator > 0 ? entry.modelId.slice(0, separator) : 'Unknown provider';
    const model = separator > 0 ? entry.modelId.slice(separator + 1) : entry.modelId;
    const roundedCost = costDetailUnits(entry.cost) / COST_DETAIL_SCALE;
    const existing = providers.get(provider) ?? {
      provider,
      cost: 0,
      hasKnownCost: false,
      unpricedTokens: 0,
      models: [],
    };
    existing.cost += roundedCost;
    existing.hasKnownCost ||= entry.hasKnownCost;
    existing.unpricedTokens += entry.unpricedTokens;
    existing.models.push({
      provider,
      model,
      cost: roundedCost,
      hasKnownCost: entry.hasKnownCost,
      unpricedTokens: entry.unpricedTokens,
    });
    providers.set(provider, existing);
  }
  return [...providers.values()]
    .map((provider) => ({
      ...provider,
      cost: costDetailUnits(provider.cost) / COST_DETAIL_SCALE,
      models: provider.models.sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider));
}

function unpricedTokensIn(models: Map<string, ModelCostBreakdown>): number {
  return [...models.values()].reduce((total, entry) => total + entry.unpricedTokens, 0);
}

function hasKnownCostIn(models: Map<string, ModelCostBreakdown>): boolean {
  return [...models.values()].some((entry) => entry.hasKnownCost);
}

function tokensIn(models: Map<string, ModelCostBreakdown>): number {
  return [...models.values()].reduce((total, entry) => total + entry.totalTokens, 0);
}

function formatProviderModelCosts(models: Map<string, ModelCostBreakdown>): FormattedProviderModelCosts {
  const entries = Array.from(models.values())
    .filter((entry) => entry.hasKnownCost || entry.unpricedTokens > 0)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  if (entries.length === 0) return { lines: [], displayedKnownCostUnits: 0 };

  const lines = [
    'Estimated API-equivalent token cost by provider / model (whole branch):',
    '  Catalog rates only; subscriptions, plan allowances, and invoices are not reconciled.',
  ];
  let displayedKnownCostUnits = 0;
  for (const entry of entries) {
    const separator = entry.modelId.indexOf('/');
    const billingIdentity = separator > 0
      ? `${entry.modelId.slice(0, separator)} / ${entry.modelId.slice(separator + 1)}`
      : `Unknown provider / ${entry.modelId}`;
    const units = costDetailUnits(entry.cost);
    const cost = entry.hasKnownCost ? formatCostDetailUnits(units) : 'unavailable';
    if (entry.hasKnownCost) displayedKnownCostUnits += units;
    const unavailableUsage = !entry.hasKnownCost && entry.unpricedTokens > 0
      ? ` (${formatCostTokens(entry.unpricedTokens)})`
      : '';
    lines.push(`  ${billingIdentity}: ${cost}${unavailableUsage}`);
  }
  return { lines, displayedKnownCostUnits };
}

function formatCostTokens(tokens: number): string {
  return `${formatReadableTokens(tokens)} token${tokens === 1 ? '' : 's'}`;
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

function tokenChannelTotal(usage: CostUsage): number {
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

export function buildLiveSessionCostEstimate(
  transcript: ChatMessage[],
  contextUsage: ContextWindowUsage | null,
  busy: boolean,
  liveOutputTokens?: number,
  suppressedStreamingMessageIds?: readonly string[],
): LiveSessionCostEstimate | null {
  if (!busy) return null;

  const unclassifiedContextTokens = typeof contextUsage?.tokens === 'number' && Number.isFinite(contextUsage.tokens)
    ? Math.max(0, Math.trunc(contextUsage.tokens))
    : 0;

  const suppressed = new Set(suppressedStreamingMessageIds ?? []);
  const currentStreamingMessage = transcript.find((message) => (
    message.role === 'assistant' && message.status === 'streaming'
  ));
  const currentStreamSuppressed = currentStreamingMessage !== undefined
    && suppressed.has(currentStreamingMessage.id);
  // The host sampler owns a per-delta incremental count. Prefer it when it is
  // present; the transcript estimator is only the pre-sampler compatibility
  // path and must not be re-priced on every streaming delta. A settled
  // provisional row suppresses only the matching current stream, leaving a
  // subsequent tool-loop call free to contribute its own live tokens.
  let outputTokens: number;
  if (typeof liveOutputTokens === 'number' && Number.isFinite(liveOutputTokens)) {
    outputTokens = currentStreamSuppressed ? 0 : Math.max(0, Math.trunc(liveOutputTokens));
  } else {
    outputTokens = 0;
    for (const message of transcript) {
      if (message.role !== 'assistant' || message.usage || message.status !== 'streaming'
        || suppressed.has(message.id)) continue;
      outputTokens += estimateLiveAssistantOutputTokens(message);
    }
  }

  const totalTokens = unclassifiedContextTokens + outputTokens;
  if (totalTokens <= 0) return null;

  return {
    source: 'live-context',
    // The canonical context signal has no provider billing-channel split. In
    // particular, treating it as uncached input can overstate live spend by
    // orders of magnitude when cache-read pricing is much lower.
    inputTokens: 0,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    unclassifiedContextTokens,
  };
}

import { isRecord } from '../../../shared/type-guards';


function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nonNegativeTokenValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toolCallsFromMessage(message: ChatMessage): ToolCall[] {
  const ordered = message.parts
    ?.filter((part) => part.kind === 'toolCall')
    .map((part) => part.toolCall) ?? [];
  return ordered.length > 0 ? ordered : (message.toolCalls ?? []);
}

export interface SubagentCostSummary {
  totalCost: number;
  directCost: number;
  nestedCost: number;
  directResultCount: number;
  nestedResultCount: number;
  modelCosts: Map<string, ModelCostBreakdown>;
}

function emptySubagentCostSummary(): SubagentCostSummary {
  return {
    totalCost: 0,
    directCost: 0,
    nestedCost: 0,
    directResultCount: 0,
    nestedResultCount: 0,
    modelCosts: new Map<string, ModelCostBreakdown>(),
  };
}

function usageFromSubagentUsage(rawUsage: unknown): (CostUsage & { cost?: number; reportedCostExplicit?: boolean }) | null {
  if (!isRecord(rawUsage)) return null;
  const input = nonNegativeTokenValue(rawUsage.input);
  const output = nonNegativeTokenValue(rawUsage.output);
  const cacheRead = nonNegativeTokenValue(rawUsage.cacheRead);
  const cacheWrite = nonNegativeTokenValue(rawUsage.cacheWrite);
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  const cacheReadTokens = cacheRead ?? 0;
  const cacheWriteTokens = cacheWrite ?? 0;
  const channelTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedTotal = numberValue(rawUsage.totalTokens);
  const totalTokens = Math.max(channelTokens, reportedTotal);
  const declaredPresence = isRecord(rawUsage.tokenChannelPresence) ? rawUsage.tokenChannelPresence : undefined;
  const declaredIncomplete = rawUsage.tokenChannelsKnown === false;
  const channelPresent = (value: number | undefined, key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): boolean => {
    if (value === undefined) return false;
    if (declaredPresence && typeof declaredPresence[key] === 'boolean') return declaredPresence[key] as boolean;
    return !declaredIncomplete;
  };
  const tokenChannelPresence = {
    input: channelPresent(input, 'input'),
    output: channelPresent(output, 'output'),
    cacheRead: channelPresent(cacheRead, 'cacheRead'),
    cacheWrite: channelPresent(cacheWrite, 'cacheWrite'),
  };
  const tokenChannelsKnown = !declaredIncomplete && Object.values(tokenChannelPresence).every(Boolean);
  // New captures carry explicit provider evidence. Keep a numeric legacy
  // aggregate cost for already-persisted child transcripts only; SDK
  // `usage.cost.total` never reaches this shape from new producers.
  const explicitCost = providerReportedCostUsd(rawUsage);
  const rawCost = rawUsage.cost;
  const cost = explicitCost ?? (typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
    ? rawCost
    : undefined);
  if (cost === undefined && totalTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    tokenChannelsKnown,
    tokenChannelPresence,
    ...(cost !== undefined ? { cost, reportedCostExplicit: explicitCost !== undefined } : {}),
  };
}

function collectRawToolResultMap(messages: RawMessage[]): Map<string, { result: unknown; status: ToolCall['status'] }> {
  const map = new Map<string, { result: unknown; status: ToolCall['status'] }>();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      map.set(String(message.toolCallId), {
        result: formatToolResult(message),
        status: message.isError ? 'failed' : 'completed',
      });
      continue;
    }
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'toolResult' || part.id === undefined) continue;
      map.set(String(part.id), {
        result: part.result,
        status: 'completed',
      });
    }
  }
  return map;
}

function addSubagentToolCallCost(
  summary: SubagentCostSummary,
  toolCall: Pick<ToolCall, 'input' | 'result' | 'status'>,
  depth: number,
  pricingForModel?: TokenPricingResolver,
): void {
  // A failed outer call can still contain child attempts that reached the
  // provider and incurred billable usage. Status must not erase that cost.
  const results = getSubagentResultEntries(toolCall.result);
  if (results.length === 0) return;

  for (const result of results) {
    const rawResult = result as unknown;
    if (!isRecord(rawResult)) continue;

    const resultModelId = typeof rawResult.model === 'string'
      ? rawResult.model
      : (typeof rawResult.selectedModel === 'string' ? rawResult.selectedModel : undefined);
    const resultProvider = typeof rawResult.provider === 'string' ? rawResult.provider : undefined;
    const attemptUsages = Array.isArray(rawResult.attemptRecords)
      ? rawResult.attemptRecords.flatMap((attempt) => {
        if (!isRecord(attempt)) return [];
        const usage = usageFromSubagentUsage(attempt.usage);
        if (!usage) return [];
        return [{
          usage,
          modelId: typeof attempt.model === 'string' ? attempt.model : resultModelId,
          provider: typeof attempt.provider === 'string' ? attempt.provider : resultProvider,
        }];
      })
      : [];
    const resultUsage = usageFromSubagentUsage(rawResult.usage);
    const hasAggregateReportedCost = attemptUsages.length > 0
      && resultUsage?.cost !== undefined && resultUsage.reportedCostExplicit === true;
    const attributedUsages = attemptUsages.length > 0
      ? attemptUsages
      : resultUsage ? [{ usage: resultUsage, modelId: resultModelId, provider: resultProvider }] : [];
    if (attributedUsages.length > 0) {
      let resultCost = 0;
      let attemptReportedCost = 0;
      let attemptReportedCount = 0;
      for (const item of attributedUsages) {
        const modelId = normalizeModelId(
          qualifyBillingModelId(item.modelId, item.provider),
          depth <= 1 ? 'Unknown subagent model' : 'Unknown nested subagent model',
        );
        const estimatedPricing = item.modelId ? pricingForModel?.(item.modelId, item.provider) : undefined;
        const channelTokens = tokenChannelTotal(item.usage);
        const hasReportedCost = item.usage.cost !== undefined;
        if (hasReportedCost) {
          attemptReportedCost += item.usage.cost!;
          attemptReportedCount += 1;
        }
        // An aggregate provider report owns attempts that did not expose
        // independent billing. Do not add catalog estimates on top of it.
        const canUseCatalog = !hasAggregateReportedCost && tokenChannelsComplete(item.usage)
          && estimatedPricing !== undefined
          && item.usage.totalTokens > 0
          && item.usage.totalTokens === channelTokens;
        const attributedCost = hasReportedCost
          ? item.usage.cost!
          : canUseCatalog ? costFromUsage(item.usage, estimatedPricing!) : 0;
        resultCost += attributedCost;
        const hasKnownCost = hasReportedCost || canUseCatalog;
        addModelCost(
          summary.modelCosts,
          modelId,
          item.usage,
          attributedCost,
          hasKnownCost,
          hasKnownCost ? 0 : item.usage.totalTokens,
        );
      }
      if (hasAggregateReportedCost
        && resultUsage
        && (resultUsage.cost! > attemptReportedCost || attemptReportedCount === 0)) {
        const aggregateResidual = Math.max(0, resultUsage.cost! - attemptReportedCost);
        const aggregateModelId = normalizeModelId(
          qualifyBillingModelId(resultModelId, resultProvider),
          depth <= 1 ? 'Unknown subagent model' : 'Unknown nested subagent model',
        );
        const aggregateCostUsage: CostUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        };
        resultCost += aggregateResidual;
        addModelCost(summary.modelCosts, aggregateModelId, aggregateCostUsage, aggregateResidual, true);
      }
      summary.totalCost += resultCost;
      if (depth <= 1) {
        summary.directCost += resultCost;
        summary.directResultCount += 1;
      } else {
        summary.nestedCost += resultCost;
        summary.nestedResultCount += 1;
      }
    }

    if (!Array.isArray(result.messages) || depth >= 6) continue;
    const toolResults = collectRawToolResultMap(result.messages);
    for (const message of result.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall' || part.name !== 'subagent' || !part.id) continue;
        const toolResult = toolResults.get(String(part.id));
        addSubagentToolCallCost(summary, {
          input: part.arguments ?? {},
          result: toolResult?.result ?? part.result,
          status: toolResult?.status ?? 'running',
        }, depth + 1, pricingForModel);
      }
    }
  }
}

export function extractSubagentCostSummary(
  transcript: ChatMessage[],
  pricingForModel?: TokenPricingResolver,
): SubagentCostSummary {
  const summary = emptySubagentCostSummary();
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of toolCallsFromMessage(message)) {
      if (typeof toolCall.name !== 'string') continue;
      if (toolCall.name.trim().toLowerCase() !== 'subagent') continue;
      addSubagentToolCallCost(summary, toolCall, 1, pricingForModel);
    }
  }
  return summary;
}

export function extractSubagentDirectCost(transcript: ChatMessage[]): number {
  return extractSubagentCostSummary(transcript).directCost;
}

function buildPruningPrepassSummary(
  details: PruningCostDetails | undefined,
  pricingForModel?: TokenPricingResolver,
): { cost: number; usage: CostUsage; modelId?: string; hasUsage: boolean; hasKnownCost: boolean; unpricedTokens: number } {
  const empty = { cost: 0, usage: emptyCostUsage(), hasUsage: false, hasKnownCost: false, unpricedTokens: 0 };
  if (!details?.prepassModel) return empty;
  const billingModelId = qualifyBillingModelId(details.prepassModel, details.prepassProvider);
  // Resolve the prepass model's OWN pricing — do NOT fall back to the
  // selected model's pricing. The prepass model is usually a different
  // (often cheaper/local) model; pricing it at the selected model's rate
  // would silently over-state the prepass cost.
  const prepassPricing = pricingForModel?.(details.prepassModel, details.prepassProvider);
  const rawChannels = [
    details.prepassInputTokens,
    details.prepassOutputTokens,
    details.prepassCacheReadTokens,
    details.prepassCacheWriteTokens,
  ];
  const hasAnyTokenChannelValue = rawChannels.some((value) => value !== undefined);
  const hasExplicitCoverageMetadata = details.prepassTokenChannelsKnown !== undefined
    || details.prepassTokenChannelPresence !== undefined;
  const hasInvalidChannelValue = rawChannels.some((value) => value !== undefined
    && nonNegativeTokenValue(value) === undefined);
  const declaredPresence = details.prepassTokenChannelPresence;
  const inferredPresence = (value: unknown): boolean => details.prepassTokenChannelsKnown === false
    ? false : hasAnyTokenChannelValue ? nonNegativeTokenValue(value) !== undefined : true;
  const tokenChannelPresence = {
    input: typeof declaredPresence?.input === 'boolean'
      ? declaredPresence.input && nonNegativeTokenValue(details.prepassInputTokens) !== undefined
      : inferredPresence(details.prepassInputTokens),
    output: typeof declaredPresence?.output === 'boolean'
      ? declaredPresence.output && nonNegativeTokenValue(details.prepassOutputTokens) !== undefined
      : inferredPresence(details.prepassOutputTokens),
    cacheRead: typeof declaredPresence?.cacheRead === 'boolean'
      ? declaredPresence.cacheRead && nonNegativeTokenValue(details.prepassCacheReadTokens) !== undefined
      : inferredPresence(details.prepassCacheReadTokens),
    cacheWrite: typeof declaredPresence?.cacheWrite === 'boolean'
      ? declaredPresence.cacheWrite && nonNegativeTokenValue(details.prepassCacheWriteTokens) !== undefined
      : inferredPresence(details.prepassCacheWriteTokens),
  };
  // Pre-metadata pruning details used optional cache aliases and treated an
  // omitted alias as legacy zero. Preserve that wire compatibility; once the
  // producer supplies presence metadata (or an invalid value is observed),
  // the conservative completeness contract applies.
  const tokenChannelsKnown = hasExplicitCoverageMetadata || hasInvalidChannelValue
    ? details.prepassTokenChannelsKnown !== false && Object.values(tokenChannelPresence).every(Boolean)
    : true;
  const usage: CostUsage = {
    inputTokens: nonNegativeTokenValue(details.prepassInputTokens) ?? 0,
    outputTokens: nonNegativeTokenValue(details.prepassOutputTokens) ?? 0,
    cacheReadTokens: nonNegativeTokenValue(details.prepassCacheReadTokens) ?? 0,
    cacheWriteTokens: nonNegativeTokenValue(details.prepassCacheWriteTokens) ?? 0,
    totalTokens: 0,
    ...(hasExplicitCoverageMetadata || hasInvalidChannelValue ? {
      tokenChannelsKnown,
    } : {}),
    ...((hasExplicitCoverageMetadata || hasInvalidChannelValue) && (!tokenChannelsKnown || details.prepassTokenChannelPresence) ? {
      tokenChannelPresence,
    } : {}),
  };
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const hasUsage = usage.totalTokens > 0;
  const reportedCost = typeof details.prepassReportedCostUsd === 'number'
    && Number.isFinite(details.prepassReportedCostUsd) && details.prepassReportedCostUsd >= 0
    ? details.prepassReportedCostUsd
    : undefined;
  const resolved = resolveUsageCost(usage, prepassPricing, reportedCost);

  return {
    cost: resolved.cost,
    usage,
    modelId: billingModelId,
    hasUsage,
    hasKnownCost: resolved.hasKnownCost,
    unpricedTokens: resolved.unpricedTokens,
  };
}

export interface CompletedCostSummary extends CostUsage {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  pricedTurnCount: number;
  modelIds: Set<string>;
  modelCosts: Map<string, ModelCostBreakdown>;
}

function emptyCompletedCostSummary(): CompletedCostSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    pricedTurnCount: 0,
    modelIds: new Set<string>(),
    modelCosts: new Map<string, ModelCostBreakdown>(),
  };
}

function addCompletedUsageCost(
  summary: CompletedCostSummary,
  usage: AssistantUsage,
  pricing: TokenPricing | undefined,
  modelId: string | undefined,
  provider?: string,
  calculatedCostUsd?: number,
): void {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.cacheReadTokens += usage.cacheReadTokens;
  summary.cacheWriteTokens += usage.cacheWriteTokens;
  summary.totalTokens += usage.totalTokens;
  const billingModelId = qualifyBillingModelId(modelId, provider);
  if (billingModelId) summary.modelIds.add(billingModelId);
  const resolved = resolveUsageCost(
    usage,
    pricing,
    usage.reportedCostUsd ?? calculatedCostUsd,
  );
  if (resolved.catalogBreakdown) {
    summary.inputCost += resolved.catalogBreakdown.input;
    summary.outputCost += resolved.catalogBreakdown.output;
    summary.cacheReadCost += resolved.catalogBreakdown.cacheRead;
    summary.cacheWriteCost += resolved.catalogBreakdown.cacheWrite;
  }
  if (resolved.hasKnownCost) {
    summary.totalCost += resolved.cost;
    summary.pricedTurnCount += 1;
  }
  addModelCost(
    summary.modelCosts,
    normalizeModelId(billingModelId, 'Selected model'),
    usage,
    resolved.cost,
    resolved.hasKnownCost,
    resolved.unpricedTokens,
  );
}

export function buildCompletedCostSummaryFromSnapshot(
  snapshot: SessionUsageSnapshot,
  fallbackPricing: TokenPricing | undefined,
  pricingForModel: TokenPricingResolver | undefined,
): CompletedCostSummary {
  const completed = emptyCompletedCostSummary();
  for (const sample of snapshot.samples) {
    if (sample.kind !== 'assistant' && sample.kind !== 'conversation') continue;
    const pricing = sample.provenance !== undefined
      ? undefined
      : sample.modelId
        ? pricingForModel ? pricingForModel(sample.modelId, sample.provider) : fallbackPricing
        : fallbackPricing;
    addCompletedUsageCost(
      completed,
      assistantUsageFromSample(sample),
      pricing,
      sample.modelId,
      sample.provider,
      sample.calculatedCostUsd,
    );
  }
  return completed;
}

export function extractSubagentCostSummaryFromSnapshot(
  snapshot: SessionUsageSnapshot,
  pricingForModel?: TokenPricingResolver,
): SubagentCostSummary {
  const summary = emptySubagentCostSummary();
  const samples = snapshot.samples.filter((sample) => sample.kind === 'subagent');
  const grouped = new Map<string, typeof samples>();
  for (const sample of samples) {
    const groupId = sample.groupId ?? sample.sourceId;
    const group = grouped.get(groupId);
    if (group) group.push(sample);
    else grouped.set(groupId, [sample]);
  }
  const catalogPricedGroups = new Set<string>();
  for (const [groupId, group] of grouped) {
    const tokenBearing = group.filter((sample) => sample.totalTokens > 0);
    if (tokenBearing.length > 0 && tokenBearing.every((sample) => {
      const usage = assistantUsageFromSample(sample);
      const channelTokens = tokenChannelTotal(usage);
      return sample.provenance === undefined
        && tokenChannelsComplete(usage)
        && !!sample.modelId
        && usage.totalTokens === channelTokens
        && pricingForModel?.(sample.modelId, sample.provider) !== undefined;
    })) {
      catalogPricedGroups.add(groupId);
    }
  }

  for (const sample of samples) {
    const pricing = sample.provenance !== undefined
      ? undefined
      : sample.modelId ? pricingForModel?.(sample.modelId, sample.provider) : undefined;
    const usage = assistantUsageFromSample(sample);
    const useCatalog = catalogPricedGroups.has(sample.groupId ?? sample.sourceId);
    // A result-level exact cost may be represented as a tokenless residual
    // beside token-bearing attempts. In catalog mode those attempts replace
    // the whole stale aggregate, so the residual must not be added again.
    const resolved = useCatalog
      ? resolveUsageCost(usage, pricing, undefined, false)
      : resolveUsageCost(usage, pricing, sample.reportedCostUsd ?? sample.calculatedCostUsd);
    const cost = resolved.cost;
    const hasKnownCost = resolved.hasKnownCost;
    summary.totalCost += cost;
    summary.directCost += cost;
    summary.directResultCount += 1;
    const modelId = normalizeModelId(
      qualifyBillingModelId(sample.modelId, sample.provider),
      'Unknown subagent model',
    );
    addModelCost(summary.modelCosts, modelId, usage, cost, hasKnownCost, resolved.unpricedTokens);
  }
  return summary;
}

export function buildCompletedCostSummary(
  usageSummary: SessionTokenUsageSummary,
  transcript: ChatMessage[],
  fallbackPricing: TokenPricing | undefined,
  pricingForModel: TokenPricingResolver | undefined,
): CompletedCostSummary {
  const completed = emptyCompletedCostSummary();
  let sawTranscriptUsage = false;

  for (const message of transcript) {
    if (message.role !== 'assistant' || !message.usage) continue;
    sawTranscriptUsage = true;
    // A model id alone is not a billing identity: Codex and Copilot can expose
    // the same id at different rates. When a resolver exists, let it reject an
    // ambiguous provider-less id rather than silently applying the currently
    // selected provider's fallback pricing to a historical turn.
    const messagePricing = message.modelId
      ? pricingForModel ? pricingForModel(message.modelId, message.provider) : fallbackPricing
      : fallbackPricing;
    addCompletedUsageCost(completed, message.usage, messagePricing, message.modelId, message.provider);
  }

  if (sawTranscriptUsage || usageSummary.reportedTurnCount === 0) {
    return completed;
  }

  addCompletedUsageCost(completed, usageSummary, fallbackPricing, undefined);
  return completed;
}

export function buildSessionCostIndicator(
  summary: SessionTokenUsageSummary,
  pricing: TokenPricing | undefined,
  modelName: string | undefined,
  completed: CompletedCostSummary,
  subagentCostOrSummary: number | SubagentCostSummary,
  pruningDetails: PruningCostDetails | undefined,
  pricingForModel?: TokenPricingResolver,
  liveEstimate?: LiveSessionCostEstimate | null,
  selectedModelId?: string,
  selectedProvider?: string,
  sessionUsage?: SessionUsageSnapshot,
): SessionCostIndicatorState | null {
  const labelModel = modelName ?? 'Selected model';
  // Key the in-flight live-turn estimate by the selected model's *id* (not its
  // display name) so it merges with completed turns for the same provider/model.
  const numericSubagentCost = typeof subagentCostOrSummary === 'number';
  const subagents = numericSubagentCost
    ? { ...emptySubagentCostSummary(), totalCost: subagentCostOrSummary, directCost: subagentCostOrSummary }
    : subagentCostOrSummary;
  const prepass = buildPruningPrepassSummary(pruningDetails, pricingForModel);
  const prepassModelCosts = new Map<string, ModelCostBreakdown>();
  let prepassCost = prepass.cost;
  let prepassHasUsage = prepass.hasUsage;
  let prepassHasKnownCost = prepass.hasKnownCost;
  if (sessionUsage) {
    prepassCost = 0;
    prepassHasUsage = false;
    prepassHasKnownCost = false;
    for (const sample of sessionUsage.samples) {
      if (sample.kind !== 'skill_pruning_prepass') continue;
      const samplePricing = sample.provenance !== undefined
        ? undefined
        : sample.modelId ? pricingForModel?.(sample.modelId, sample.provider) : undefined;
      const usage = assistantUsageFromSample(sample);
      const resolved = resolveUsageCost(
        usage,
        samplePricing,
        sample.reportedCostUsd ?? sample.calculatedCostUsd,
      );
      const modelId = normalizeModelId(
        qualifyBillingModelId(sample.modelId, sample.provider),
        'Unknown pruning prepass model',
      );
      prepassCost += resolved.cost;
      prepassHasUsage ||= usage.totalTokens > 0;
      prepassHasKnownCost ||= resolved.hasKnownCost;
      addModelCost(prepassModelCosts, modelId, usage, resolved.cost, resolved.hasKnownCost, resolved.unpricedTokens);
    }
  }
  const auxiliaryKinds = [
    ['retry', 'Provider retry attempts'],
    ['history_compaction', 'History compaction'],
    ['branch_summary', 'Branch summaries'],
    ['session_title', 'Session titles'],
    ['other', 'Other automation'],
  ] as const;
  const auxiliarySources = auxiliaryKinds.map(([kind, label]) => {
    const models = new Map<string, ModelCostBreakdown>();
    let cost = 0;
    for (const sample of sessionUsage?.samples ?? []) {
      if (sample.kind !== kind) continue;
      const usage = assistantUsageFromSample(sample);
      const samplePricing = sample.provenance !== undefined
        ? undefined
        : sample.modelId ? pricingForModel?.(sample.modelId, sample.provider) : undefined;
      const resolved = resolveUsageCost(
        usage,
        samplePricing,
        sample.reportedCostUsd ?? sample.calculatedCostUsd,
      );
      cost += resolved.cost;
      addModelCost(
        models,
        normalizeModelId(qualifyBillingModelId(sample.modelId, sample.provider), `Unknown ${label.toLowerCase()} model`),
        usage,
        resolved.cost,
        resolved.hasKnownCost,
        resolved.unpricedTokens,
      );
    }
    return { kind, label, cost, models };
  });
  const auxiliaryCost = auxiliarySources.reduce((total, source) => total + source.cost, 0);
  const liveCost = pricing && liveEstimate ? costFromUsage(liveEstimate, pricing) : 0;
  const mainCost = completed.totalCost;
  const totalCost = mainCost + auxiliaryCost + liveCost + subagents.totalCost + prepassCost;
  const subagentsHaveUsage = tokensIn(subagents.modelCosts) > 0 || unpricedTokensIn(subagents.modelCosts) > 0;
  const usageIsStale = sessionUsage?.freshness === 'stale';
  const usageRefreshFailed = sessionUsage?.refreshStatus === 'error';
  const usageNeedsStatusIndicator = usageIsStale || usageRefreshFailed;

  if (!summary.accountingUnknown
    && summary.reportedTurnCount === 0 && !liveEstimate && totalCost <= 0
    && !prepassHasUsage && !prepassHasKnownCost && !subagentsHaveUsage
    && !usageNeedsStatusIndicator) return null;

  const modelCosts = new Map<string, ModelCostBreakdown>();
  mergeModelCosts(modelCosts, completed.modelCosts);
  mergeModelCosts(modelCosts, subagents.modelCosts);
  mergeModelCosts(modelCosts, prepassModelCosts);
  for (const source of auxiliarySources) mergeModelCosts(modelCosts, source.models);
  if (numericSubagentCost && subagents.totalCost > 0) {
    addModelCost(
      modelCosts,
      'Unknown provider/Unknown subagent model',
      emptyCostUsage(),
      subagents.totalCost,
      true,
    );
  }
  if (liveEstimate) {
    const liveBillingModelId = qualifyBillingModelId(selectedModelId, selectedProvider);
    const hasKnownLiveCost = pricing !== undefined;
    addModelCost(
      modelCosts,
      normalizeModelId(liveBillingModelId, labelModel),
      liveEstimate,
      liveCost,
      hasKnownLiveCost,
      hasKnownLiveCost ? liveEstimate.unclassifiedContextTokens : liveEstimate.totalTokens,
    );
  }
  if (!sessionUsage && prepass.modelId && (prepass.hasUsage || prepass.hasKnownCost)) {
    addModelCost(
      modelCosts,
      prepass.modelId,
      prepass.usage,
      prepass.cost,
      prepass.hasKnownCost,
      prepass.unpricedTokens,
    );
  }

  const formattedModelCosts = formatProviderModelCosts(modelCosts);
  const tooltipLines = formattedModelCosts.lines;
  const unpricedTokens = unpricedTokensIn(modelCosts);
  const provenanceIncomplete = summary.accountingUnknown
    || (sessionUsage?.incompleteInvocationCount ?? 0) > 0;
  const provenanceUnpriced = (sessionUsage?.unpricedInvocationCount ?? 0) > 0;
  const hasIncompleteCost = unpricedTokens > 0 || provenanceIncomplete || provenanceUnpriced;
  const hasAnyKnownCost = hasKnownCostIn(modelCosts);

  const prepassSourceModels = sessionUsage ? prepassModelCosts : new Map<string, ModelCostBreakdown>();
  if (!sessionUsage && prepass.modelId && (prepass.hasUsage || prepass.hasKnownCost)) {
    addModelCost(
      prepassSourceModels,
      prepass.modelId,
      prepass.usage,
      prepass.cost,
      prepass.hasKnownCost,
      prepass.unpricedTokens,
    );
  }
  const sources = ([
    {
      key: 'conversation',
      label: 'Main conversation',
      cost: mainCost,
      hasKnownCost: hasKnownCostIn(completed.modelCosts),
      unpricedTokens: unpricedTokensIn(completed.modelCosts),
      tokens: completed.totalTokens,
    },
    {
      key: 'subagents',
      label: 'Subagents',
      cost: subagents.totalCost,
      hasKnownCost: numericSubagentCost ? subagents.totalCost > 0 : hasKnownCostIn(subagents.modelCosts),
      unpricedTokens: unpricedTokensIn(subagents.modelCosts),
      tokens: tokensIn(subagents.modelCosts),
    },
    {
      key: 'pruning',
      label: 'Skill pruning prepasses',
      cost: prepassCost,
      hasKnownCost: prepassHasKnownCost,
      unpricedTokens: unpricedTokensIn(prepassSourceModels),
      tokens: tokensIn(prepassSourceModels),
    },
    ...auxiliarySources.map((source) => ({
      key: source.kind,
      label: source.label,
      cost: source.cost,
      hasKnownCost: hasKnownCostIn(source.models),
      unpricedTokens: unpricedTokensIn(source.models),
      tokens: tokensIn(source.models),
    })),
    {
      key: 'live',
      label: 'Current turn estimate',
      cost: liveCost,
      hasKnownCost: pricing !== undefined && liveEstimate !== null && liveEstimate !== undefined,
      unpricedTokens: liveEstimate
        ? pricing ? liveEstimate.unclassifiedContextTokens : liveEstimate.totalTokens
        : 0,
      tokens: liveEstimate?.totalTokens ?? 0,
    },
  ] satisfies SessionCostSourceBreakdown[]).filter(
    (source) => source.cost > 0 || source.tokens > 0 || source.unpricedTokens > 0 || source.hasKnownCost,
  );

  if (tooltipLines.length === 0) {
    tooltipLines.push(
      'Session cost by provider / model (whole branch):',
      summary.accountingUnknown ? '  Unknown · authoritative ledger unavailable' : '  No priced usage',
    );
  }
  if (hasIncompleteCost) {
    const incompleteInvocations = sessionUsage?.incompleteInvocationCount ?? 0;
    const unpricedInvocations = sessionUsage?.unpricedInvocationCount ?? 0;
    tooltipLines.push(
      '',
      `Excludes ${formatCostTokens(unpricedTokens)} pending billing details or pricing`,
      `  Provenance: ${incompleteInvocations} unknown and ${unpricedInvocations} unpriced invocation(s).`,
    );
  }
  if (usageRefreshFailed) {
    tooltipLines.push('', 'Usage refresh failed · showing the last completed snapshot.');
  } else if (usageIsStale) {
    tooltipLines.push('', 'Usage refresh in progress · showing the last completed snapshot.');
  }
  // Make the displayed subtotal reconcile with the independently rounded rows.
  // Full-precision totalCost remains authoritative for the compact label.
  const displayedTotal = formatCostDetailUnits(formattedModelCosts.displayedKnownCostUnits);
  tooltipLines.push(
    hasIncompleteCost
      ? hasAnyKnownCost
        ? `Known subtotal: ${displayedTotal}`
        : 'Total: unavailable'
      : `Total: ${displayedTotal}`,
  );

  const displayCost = liveEstimate ? formatLiveCostUsd(totalCost) : formatCostUsd(totalCost);
  // Keep the visible label clean: a stale (refresh in progress) snapshot and
  // an unpriced/known-subtotal spend are unmarked here — the tooltip and the
  // accessible description carry that detail explicitly. Only a failed usage
  // refresh keeps its `!` marker. Missing cost is an explicit em dash, never
  // a fabricated zero.
  const refreshErrorMarker = usageRefreshFailed ? '!' : '';
  const label = hasIncompleteCost
    ? hasAnyKnownCost ? `${displayCost}${refreshErrorMarker}` : `—${refreshErrorMarker}`
    : usageNeedsStatusIndicator && !hasAnyKnownCost ? `—${refreshErrorMarker}` : `${displayCost}${refreshErrorMarker}`;
  const freshnessAria = usageRefreshFailed
    ? ' Usage refresh failed; showing the last completed snapshot.'
    : usageIsStale
      ? ' Usage refresh in progress; showing the last completed snapshot.'
      : '';
  const ariaLabel = hasIncompleteCost
    ? hasAnyKnownCost
      ? `Known estimated session cost ${displayCost}; some provider/model usage is not yet priced.${freshnessAria}`
      : `Estimated session cost unavailable because provider/model usage is not yet priced.${freshnessAria}`
    : `Estimated session cost ${displayCost}.${freshnessAria}`;

  return {
    label,
    ariaLabel,
    tooltip: tooltipLines.join('\n'),
    ...(sessionUsage?.freshness === undefined ? {} : { freshness: sessionUsage.freshness }),
    ...(sessionUsage?.refreshStatus === undefined ? {} : { refreshStatus: sessionUsage.refreshStatus }),
    breakdown: {
      totalCost,
      hasIncompleteCost,
      unpricedTokens,
      reportedTurnCount: summary.reportedTurnCount,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      providers: providerModelBreakdown(modelCosts),
      sources,
    },
  };
}

// ── Canonical root-session activity/facets (P4 consumer) ────────────────────
//
// A passive consumer of the host's optional `canonicalActivityBySession`
// cache read. It owns NO calculation: it renders the host-qualified canonical
// projection for the active session only, keeps unknown/suppressed/truncated
// states explicit, and never presents root-session totals as a selected-branch
// claim (the host owns branch/epoch freshness).

/** One per-activity-kind row of the canonical session activity summary. */
export interface CanonicalActivityKindSummary {
  kind: string;
  spanCount: number;
  measuredTotalMs: number;
}

export interface CanonicalActivitySectionSummary {
  totalSpans: number;
  /** Additive measured work over known spans — NOT a wall-clock union. */
  measuredTotalMs: number;
  observedCount: number;
  estimatedCount: number;
  unknownCount: number;
  measuredKnownCount: number;
  measuredUnknownCount: number;
  kinds: CanonicalActivityKindSummary[];
  /** Explicit incompleteness notes from host coverage/truncation metadata. */
  notes: string[];
}

export interface CanonicalToolFacetSectionSummary {
  facetCount: number;
  /** Facets with at least one known attempted-change line count. */
  attemptedChangeCount: number;
/** Per-channel exact sums over KNOWN values only: `null` = no known values in
 *  the channel (rendered '?', never a zero-filled subtotal); a safe-integer
 *  `number` while the exact sum fits, otherwise the exact decimal `string` of
 *  the bigint sum. */
  attemptedAddedLines: number | string | null;
  attemptedRemovedLines: number | string | null;
  /** Facets whose attempted line counts are unknown or unsafe to sum. */
  withoutLineCounts: number;
  verifiedCount: number;
  unverifiedCount: number;
  /** Facets whose verification is null, `not_applicable`, or `unknown`. */
  otherVerificationCount: number;
  notes: string[];
}

export interface CanonicalSessionActivitySummary {
  /** Explicit scope note — root-session scope, never a selected-branch claim. */
  scopeNote: string;
  /** True when the bounded visible-session address set omitted paths and the
   *  active session had no canonical entry. Claimed only under a valid stable
   *  root identity — the same gate `bindCanonicalEntry` applies — so an
   *  unavailable identity never asserts an address-set omission. */
  omitted: boolean;
  /** True when the active session has no canonical entry at all. */
  missing: boolean;
  /** null = the independently qualified read is unknown/suppressed/invalidated. */
  activity: CanonicalActivitySectionSummary | null;
  /** null = the independently qualified read is unknown/suppressed/invalidated. */
  toolFacets: CanonicalToolFacetSectionSummary | null;
}

/** Explicit scope label: root-session scope never claims selected-branch
 *  ownership; selected-branch totals are separately unsupported, not shown. */
export const CANONICAL_SCOPE_NOTE = 'Root session (all branches) · selected-branch totals not shown';

/** Discrete count fields the summary reads; every one must be a nonnegative
 *  safe integer (matching the host validator's rule exactly). */
const ACTIVITY_COUNT_FIELDS = [
  'spanCount', 'observedCount', 'estimatedCount', 'unknownCount',
  'measuredKnownCount', 'measuredUnknownCount',
] as const;

function countsSignature(counts: CanonicalActivityCounts): string {
  return [
    counts.spanCount, counts.observedCount, counts.estimatedCount, counts.unknownCount,
    counts.measuredKnownCount, counts.measuredUnknownCount, counts.measuredTotalMs,
  ].join(':');
}

function scopeSignature(scope: CanonicalActivityView['scope'] | undefined): string {
  if (!scope || typeof scope !== 'object') return '?';
  return scope.kind === 'global' ? 'global' : `session:${scope.rootSessionId}`;
}

function coverageSignature(coverage: CanonicalAnalyticsCoverage | null): string {
  if (!coverage) return '-';
  const pending = coverage.pendingDetailCoverage;
  return [
    String(coverage.databaseSchemaVersion),
    String(coverage.projectionRevision),
    String(coverage.snapshotWatermark),
    String(coverage.generationIds.length),
    coverage.generationIdsTruncated ? 'g' : '',
    pending.deliveryHistoryCoverage,
    coverage.truncation.rowLimit ? 'r' : '',
    coverage.truncation.byteLimit ? 'b' : '',
    coverage.truncation.cellLimit ? 'c' : '',
  ].join(':');
}

/** Bounded content signature for the memo-gated canonical summary. Signs every
 *  display-affecting input — the active session's path, the expected stable
 *  root identity it binds to, entry/read/projection scope, revisions, counts,
 *  facet qualifications, and coverage metadata — so equal-content structured
 *  clones keep the previous reference while any address/root/scope/coverage
 *  change requalifies the summary. Unbound entries (absent or identity-)
 *  mismatched) get a stable marker that still depends on the identity inputs. */
export function canonicalActivitySignature(
  sessionPath: string | null,
  expectedRootSessionId: string | null,
  bySession: Record<string, CanonicalActivityView> | undefined,
  bySessionTruncated: boolean | undefined,
): string {
  if (!bySession) return 'legacy';
  const raw = sessionPath !== null ? (bySession as Record<string, unknown>)[sessionPath] : undefined;
  const entry = raw === undefined || raw === null
    ? null
    : bindCanonicalEntry(raw, sessionPath as string, expectedRootSessionId);
  if (!entry) {
    return [
      'unbound',
      sessionPath ?? '',
      expectedRootSessionId ?? '',
      raw === undefined || raw === null ? 'absent' : 'unbound-entry',
      bySessionTruncated === true ? 't' : 'f',
    ].join('|');
  }
  return [
    sessionPath,
    expectedRootSessionId ?? '',
    entry.revision === null || entry.revision === undefined ? '' : String(entry.revision),
    scopeSignature(entry.scope),
    canonicalReadSignature(entry.activity, entry.scope, 'kinds'),
    canonicalReadSignature(entry.toolFacets, entry.scope, 'facets'),
    bySessionTruncated === true ? 't' : 'f',
  ].join('|');
}

/** Signature for one qualified canonical read. Usable reads sign every
 *  display-affecting field; unusable reads get a stable reason marker so a
 *  later repair requalifies the memo. */
function canonicalReadSignature(
  read: unknown,
  entryScope: CanonicalActivityView['scope'],
  rowField: 'kinds' | 'facets',
): string {
  const qualified = qualifyCanonicalRead<CanonicalActivityProjectionView | CanonicalToolFacetProjectionView>(
    read,
    entryScope,
    rowField,
  );
  if (!qualified.qualified) return `unknown:${qualified.token}`;
  const readRecord = read as CanonicalActivityView['activity'];
  const projection = qualified.projection;
  const parts = [
    'canonical',
    scopeSignature(readRecord.scope),
    scopeSignature(projection.scope),
    String(readRecord.truncated),
    String(projection.revision),
    projection.truncated ? 't' : 'f',
    coverageSignature(projection.coverage),
  ];
  if (rowField === 'kinds') {
    const activity = projection as CanonicalActivityProjectionView;
    parts.push(
      countsSignature(activity.totals),
      activity.kinds
        .map((kind) => `${typeof kind.activityKind === 'string' ? kind.activityKind : ''}=${countsSignature(kind)}`)
        .join(','),
    );
  } else {
    const facetProjection = projection as CanonicalToolFacetProjectionView;
    parts.push(
      String(facetProjection.facets.length),
      facetProjection.facets
        .map((facet) => `${String(facet.attemptedAddedLines)}|${String(facet.attemptedRemovedLines)}|${facet.verification ?? ''}`)
        .join(','),
    );
  }
  return parts.join(':');
}

/** The ONE crash-safe qualified-read normalization for the canonical consumer.
 *  It owns every optional/malformed gate BEFORE any dereference — absent read,
 *  non-canonical authority, scope mismatch against the entry, missing or
 *  malformed projection, non-object rows, nonnegative safe-integer count
 *  violations, and missing/malformed coverage metadata (including the bounded
 *  generation list). Any violation fails the whole read closed to an explicit
 *  unknown with a stable reason token; the host validator's diagnostics are
 *  never trusted to have run. Both the signature and the summary builder call
 *  this single normalizer, so they cannot drift apart. */
type CanonicalReadQualification<TProjection> =
  | { qualified: true; projection: TProjection }
  | { qualified: false; token: 'absent' | 'unknown-authority' | 'scope-mismatch' | 'malformed' };

function qualifyCanonicalRead<TProjection>(
  read: unknown,
  entryScope: CanonicalActivityView['scope'],
  rowField: 'kinds' | 'facets',
): CanonicalReadQualification<TProjection> {
  if (!isRecord(read)) return { qualified: false, token: 'absent' };
  if (read.authority !== 'canonical') return { qualified: false, token: 'unknown-authority' };
  if (!readScopeMatches(entryScope, read.scope)) return { qualified: false, token: 'scope-mismatch' };
  const projection = read.projection;
  if (!isRecord(projection)) return { qualified: false, token: 'malformed' };
  if (!readScopeMatches(entryScope, projection.scope)) return { qualified: false, token: 'scope-mismatch' };
  if (typeof read.truncated !== 'boolean' || typeof projection.truncated !== 'boolean') {
    return { qualified: false, token: 'malformed' };
  }
  const rows = projection[rowField];
  if (!Array.isArray(rows) || !rows.every(isRecord)) return { qualified: false, token: 'malformed' };
  if (rowField === 'kinds') {
    if (!usableActivityCounts(projection.totals)) return { qualified: false, token: 'malformed' };
    for (const row of rows) {
      if (!usableActivityCounts(row)) return { qualified: false, token: 'malformed' };
    }
  }
  if (!usableCanonicalCoverage(projection.coverage)) return { qualified: false, token: 'malformed' };
  return { qualified: true, projection: projection as TProjection };
}

/** Activity counts the summary consumes: six discrete nonnegative safe-integer
 *  counts plus a nonnegative finite measured-work total (the host stores it as
 *  a REAL duration — fractional milliseconds display, negative ones cannot). */
function usableActivityCounts(counts: unknown): boolean {
  if (!isRecord(counts)) return false;
  for (const field of ACTIVITY_COUNT_FIELDS) {
    const value = counts[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
  }
  const measured = counts.measuredTotalMs;
  return typeof measured === 'number' && Number.isFinite(measured) && measured >= 0;
}

/** Coverage metadata the notes/signature consume: the bounded generation list
 *  plus its flag, the pending-detail coverage label, and the three truncation
 *  flags. A missing or malformed field fails the read closed instead of
 *  crashing a later dereference. */
function usableCanonicalCoverage(coverage: unknown): boolean {
  if (!isRecord(coverage)) return false;
  if (!Array.isArray(coverage.generationIds)) return false;
  if (typeof coverage.generationIdsTruncated !== 'boolean') return false;
  const truncation = coverage.truncation;
  if (!isRecord(truncation)
    || typeof truncation.rowLimit !== 'boolean'
    || typeof truncation.byteLimit !== 'boolean'
    || typeof truncation.cellLimit !== 'boolean') {
    return false;
  }
  const pending = coverage.pendingDetailCoverage;
  if (!isRecord(pending)
    || (pending.deliveryHistoryCoverage !== 'complete'
      && pending.deliveryHistoryCoverage !== 'retained_only')) {
    return false;
  }
  return true;
}

/** A nested read (and its projection) must carry the SAME scope as its entry:
 *  a session entry can never host a global-labelled projection, and the
 *  root-session id must match. Mismatching reads fail closed to unknown. */
function readScopeMatches(
  entryScope: CanonicalActivityView['scope'] | undefined,
  readScope: unknown,
): boolean {
  if (!isRecord(readScope) || !isRecord(entryScope)) return false;
  if (entryScope.kind === 'global') return readScope.kind === 'global';
  return readScope.kind === 'session' && readScope.rootSessionId === entryScope.rootSessionId;
}

function activityCoverageNotes(coverage: CanonicalAnalyticsCoverage | null): string[] {
  const notes: string[] = [];
  if (!coverage) return notes;
  const limits = [
    coverage.truncation.rowLimit ? 'row' : null,
    coverage.truncation.byteLimit ? 'byte' : null,
    coverage.truncation.cellLimit ? 'cell' : null,
  ].filter((limit): limit is string => limit !== null);
  if (limits.length > 0) notes.push(`Bounded read: ${limits.join(' + ')} limit(s) reached`);
  if (coverage.generationIdsTruncated) notes.push('Generation list truncated');
  if (coverage.pendingDetailCoverage.deliveryHistoryCoverage === 'retained_only') {
    notes.push('Delivery-history detail: retained rows only');
  }
  return notes;
}

function summarizeActivity(
  projection: CanonicalActivityProjectionView,
): CanonicalActivitySectionSummary {
  return {
    totalSpans: projection.totals.spanCount,
    measuredTotalMs: projection.totals.measuredTotalMs,
    observedCount: projection.totals.observedCount,
    estimatedCount: projection.totals.estimatedCount,
    unknownCount: projection.totals.unknownCount,
    measuredKnownCount: projection.totals.measuredKnownCount,
    measuredUnknownCount: projection.totals.measuredUnknownCount,
    kinds: projection.kinds.map((kind) => ({
      kind: typeof kind.activityKind === 'string' ? kind.activityKind : 'unknown',
      spanCount: kind.spanCount,
      measuredTotalMs: kind.measuredTotalMs,
    })),
    notes: [
      projection.truncated ? 'Kind rows truncated (bounded read)' : '',
      ...activityCoverageNotes(projection.coverage),
    ].filter((note) => note !== ''),
  };
}

/** One attempted-change channel. `null` stays unknown (never summed as 0);
 *  nonnegative safe integers and arbitrary-length decimal strings (the host's
 *  exact int64 serialization — no digit-count cap) are known values; negative,
 *  fractional, or malformed values stay unknown rather than being truncated,
 *  wrapped, or zero-filled. */
function attemptedLineValue(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Exact accumulated count in its display value: a safe-integer number while
 *  it fits, otherwise the exact decimal string of the bigint sum. Sums never
 *  overflow into an unknown — every known value stays representable exactly. */
function exactCountValue(total: bigint): number | string {
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
}

function summarizeToolFacets(
  projection: CanonicalToolFacetProjectionView,
): CanonicalToolFacetSectionSummary {
  let attemptedChangeCount = 0;
  let addedSum: bigint | null = null;
  let removedSum: bigint | null = null;
  let withoutLineCounts = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  let otherVerificationCount = 0;
  for (const facet of projection.facets) {
    const added = attemptedLineValue(facet.attemptedAddedLines);
    const removed = attemptedLineValue(facet.attemptedRemovedLines);
    if (added === null && removed === null) {
      withoutLineCounts += 1;
    } else {
      attemptedChangeCount += 1;
    }
    // Exact bigint addition: no safe-range cap, no wrap, no unknown fallback.
    if (added !== null) addedSum = (addedSum ?? 0n) + added;
    if (removed !== null) removedSum = (removedSum ?? 0n) + removed;
    if (facet.verification === 'verified') verifiedCount += 1;
    else if (facet.verification === 'unverified') unverifiedCount += 1;
    else otherVerificationCount += 1;
  }
  return {
    facetCount: projection.facets.length,
    attemptedChangeCount,
    attemptedAddedLines: addedSum === null ? null : exactCountValue(addedSum),
    attemptedRemovedLines: removedSum === null ? null : exactCountValue(removedSum),
    withoutLineCounts,
    verifiedCount,
    unverifiedCount,
    otherVerificationCount,
    notes: [
      projection.truncated ? 'Facet rows truncated (bounded read)' : '',
      ...activityCoverageNotes(projection.coverage),
    ].filter((note) => note !== ''),
  };
}

/** The active session's stable root identity from CURRENT view session
 *  metadata — the host-owned `SessionSummary.sessionId` (the same stable header
 *  id the host derives analytics root identities from). Returns null when the
 *  identity is unavailable or a path-hash fallback: the webview must never
 *  infer a root identity from the visible pathname, so identity-fallback
 *  sessions fail closed instead of binding. */
export function activeCanonicalRootSessionId(
  activeSession: Pick<SessionSummary, 'sessionId' | 'identityFallback'> | null | undefined,
): string | null {
  if (!activeSession || activeSession.identityFallback === true) return null;
  const sessionId = activeSession.sessionId?.trim();
  return sessionId ? sessionId : null;
}

/** Bind the active session's canonical entry: the record must be an object
 *  addressed at the active session's visible path AND carry the expected
 *  stable root identity in an explicit session scope. A path-matched entry
 *  describing a different root — or any binding with an unavailable identity —
 *  never binds, so root-B data can never render for root-A. */
function bindCanonicalEntry(
  entry: unknown,
  sessionPath: string,
  expectedRootSessionId: string | null,
): CanonicalActivityView | null {
  const record = entry as unknown as CanonicalActivityView | null;
  if (!isRecord(entry) || record?.sessionPath !== sessionPath) return null;
  if (expectedRootSessionId === null) return null;
  const scope = record?.scope;
  if (!isRecord(scope) || scope.kind !== 'session' || scope.rootSessionId !== expectedRootSessionId) {
    return null;
  }
  return record;
}

/** Build the display summary for the active session's canonical activity/facet
 *  read. Returns null when the host omitted the canonical fields (legacy
 *  analytics authority) — nothing canonical is rendered and no legacy UI
 *  changes. The entry is bound to the active session's stable root identity
 *  before anything renders; the global entry is deliberately never substituted
 *  for a session. */
export function buildCanonicalSessionActivitySummary(
  sessionPath: string | null,
  expectedRootSessionId: string | null,
  bySession: Record<string, CanonicalActivityView> | undefined,
  bySessionTruncated: boolean | undefined,
): CanonicalSessionActivitySummary | null {
  if (!bySession || sessionPath === null) return null;
  const raw = (bySession as Record<string, unknown>)[sessionPath];
  if (raw === undefined || raw === null) {
    // Omission is claimed only when the active session's stable root identity
    // is available — the same gate `bindCanonicalEntry` applies. With an
    // unavailable identity the read fails closed and no address-set omission
    // is claimed: a truncation flag alone cannot bind the missing entry.
    return {
      scopeNote: CANONICAL_SCOPE_NOTE,
      omitted: bySessionTruncated === true && expectedRootSessionId !== null,
      missing: true,
      activity: null,
      toolFacets: null,
    };
  }
  if (!bindCanonicalEntry(raw, sessionPath, expectedRootSessionId)) {
    // Present but unbindable (address mismatch, or the active session's stable
    // root identity is unavailable/mismatched): fail closed to an explicit
    // unavailable read. The entry itself exists, so no address-set omission is
    // claimed — but another root's data is never rendered.
    return {
      scopeNote: CANONICAL_SCOPE_NOTE,
      omitted: false,
      missing: true,
      activity: null,
      toolFacets: null,
    };
  }
  const entry = raw as unknown as CanonicalActivityView;
  const activity = qualifyCanonicalRead<CanonicalActivityProjectionView>(entry.activity, entry.scope, 'kinds');
  const toolFacets = qualifyCanonicalRead<CanonicalToolFacetProjectionView>(entry.toolFacets, entry.scope, 'facets');
  return {
    scopeNote: CANONICAL_SCOPE_NOTE,
    omitted: false,
    missing: false,
    activity: activity.qualified ? summarizeActivity(activity.projection) : null,
    toolFacets: toolFacets.qualified ? summarizeToolFacets(toolFacets.projection) : null,
  };
}

/** Compact duration: `45s` / `1.2m` / `2.3h` (`0` → `0s`). */
export function formatMeasuredDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${trimMeasured(min)}m`;
  return `${trimMeasured(min / 60)}h`;
}

function trimMeasured(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
