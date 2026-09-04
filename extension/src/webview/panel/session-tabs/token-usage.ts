import { qualifyModelId as qualifyBillingModelId } from '../../../shared/model-id';
import type { AssistantUsage, ChatMessage, ContextWindowUsage, PruningDetails, ToolCall } from '../../../shared/protocol';
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
  /** Usage from the most recent assistant turn that reported it. */
  lastTurn: AssistantUsage | null;
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
  let lastTurn: AssistantUsage | null = null;

  for (const sample of snapshot.samples) {
    const usage = assistantUsageFromSample(sample);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalTokens += usage.totalTokens;
    reasoningTokens += usage.reasoningTokens ?? 0;
    reportedTurnCount += 1;
    if (sample.tokenChannelsKnown === false || sample.instrumentationGap) {
      incompleteInvocationCount += 1;
    } else {
      knownTokenInvocationCount += 1;
      lastTurn = usage;
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
    lastTurn,
  };
}

export { formatReadableTokens, formatCompactTokens, formatCostUsd };

export interface SessionTokenIndicatorState {
  /** Compact token counts \u2014 e.g. "\u2191 12.3k \u2193 4.5k". */
  label: string;
  ariaLabel: string;
  /** Multi-line tooltip with totals + last turn + cache breakdown. */
  tooltip: string;
}

export function buildSessionTokenIndicator(
  summary: SessionTokenUsageSummary,
): SessionTokenIndicatorState {
  // Always show token indicator, even when no usage reported
  const hasKnownTokens = summary.knownTokenInvocationCount > 0
    || (summary.incompleteInvocationCount === 0 && summary.reportedTurnCount > 0);
  const compactIn = hasKnownTokens ? formatCompactTokens(summary.inputTokens) : '\u2014';
  const compactOut = hasKnownTokens ? formatCompactTokens(summary.outputTokens) : '\u2014';

  // Token counts label (always present). An asterisk marks a known subtotal.
  const label = `\u2191 ${compactIn} \u2193 ${compactOut}${summary.incompleteInvocationCount > 0 ? '*' : ''}`;

  const tooltipLines: string[] = [
    `Session tokens (${summary.reportedTurnCount} assistant turn${summary.reportedTurnCount === 1 ? '' : 's'})`,
    `  Input:  ${formatReadableTokens(summary.inputTokens)}`,
    `  Output: ${formatReadableTokens(summary.outputTokens)}`,
  ];
  if (summary.reasoningTokens > 0) {
    tooltipLines.push(`  Reasoning (included in output): ${formatReadableTokens(summary.reasoningTokens)}`);
  }
  if (summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0) {
    tooltipLines.push(
      `  Cache read:  ${formatReadableTokens(summary.cacheReadTokens)}`,
      `  Cache write: ${formatReadableTokens(summary.cacheWriteTokens)}`,
    );
  }
  tooltipLines.push(`  Total: ${formatReadableTokens(summary.totalTokens)}`);
  if (summary.incompleteInvocationCount > 0) {
    tooltipLines.push(`  Known subtotal · ${summary.incompleteInvocationCount} invocation(s) have incomplete token usage`);
  }
  if (summary.lastTurn) {
    tooltipLines.push(
      '',
      'Last turn:',
      `  \u2191 ${formatReadableTokens(summary.lastTurn.inputTokens)}  \u2193 ${formatReadableTokens(summary.lastTurn.outputTokens)}`,
    );
  }

  const ariaLabel =
    `Session token usage: input ${formatReadableTokens(summary.inputTokens)}, `
    + `output ${formatReadableTokens(summary.outputTokens)}`
    + (summary.incompleteInvocationCount > 0
      ? `; known subtotal with ${summary.incompleteInvocationCount} incomplete invocation(s).`
      : '.');

  return {
    label,
    ariaLabel,
    tooltip: tooltipLines.join('\n'),
  };
}

export interface TokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<TokenPricing & { inputTokensAbove: number }>;
}

export type TokenPricingResolver = (modelId: string, provider?: string) => TokenPricing | undefined;

interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
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
    const partial = entry.unpricedTokens > 0 ? '*' : '';
    const unavailableUsage = !entry.hasKnownCost && entry.unpricedTokens > 0
      ? ` (${formatCostTokens(entry.unpricedTokens)})`
      : '';
    lines.push(`  ${billingIdentity}: ${cost}${partial}${unavailableUsage}`);
  }
  return { lines, displayedKnownCostUnits };
}

function formatCostTokens(tokens: number): string {
  return `${formatReadableTokens(tokens)} token${tokens === 1 ? '' : 's'}`;
}

function effectivePricing(usage: CostUsage, pricing: TokenPricing): TokenPricing {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  let effective = pricing;
  for (const tier of pricing.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove) effective = tier;
  }
  return effective;
}

function costFromUsage(usage: CostUsage, pricing: TokenPricing, applyLongContextTier = true): number {
  const effective = applyLongContextTier ? effectivePricing(usage, pricing) : pricing;
  return ((usage.inputTokens / 1_000_000) * effective.input)
    + ((usage.outputTokens / 1_000_000) * effective.output)
    + ((usage.cacheReadTokens / 1_000_000) * effective.cacheRead)
    + ((usage.cacheWriteTokens / 1_000_000) * effective.cacheWrite);
}

function costBreakdownFromUsage(usage: CostUsage, pricing: TokenPricing) {
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

interface ResolvedUsageCost {
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
function resolveUsageCost(
  usage: CostUsage,
  pricing: TokenPricing | undefined,
  reportedCostUsd: number | undefined,
  applyLongContextTier = true,
): ResolvedUsageCost {
  const channelTokens = tokenChannelTotal(usage);
  const canUseCatalog = pricing !== undefined && usage.totalTokens > 0 && channelTokens === usage.totalTokens;
  if (canUseCatalog) {
    const catalogBreakdown = applyLongContextTier ? costBreakdownFromUsage(usage, pricing!) : null;
    return {
      cost: catalogBreakdown?.total ?? costFromUsage(usage, pricing!, false),
      hasKnownCost: true,
      unpricedTokens: 0,
      catalogBreakdown,
    };
  }

  // A reported cost, including an explicit zero, remains authoritative when
  // channel pricing cannot be reconstructed. An absent report is unpriced,
  // rather than a known zero.
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
): LiveSessionCostEstimate | null {
  if (!busy) return null;

  const unclassifiedContextTokens = typeof contextUsage?.tokens === 'number' && Number.isFinite(contextUsage.tokens)
    ? Math.max(0, Math.trunc(contextUsage.tokens))
    : 0;

  let outputTokens = 0;
  for (const message of transcript) {
    if (message.role !== 'assistant' || message.usage || message.status !== 'streaming') continue;
    outputTokens += estimateLiveAssistantOutputTokens(message);
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

function usageFromSubagentUsage(rawUsage: unknown): (CostUsage & { cost?: number }) | null {
  if (!isRecord(rawUsage)) return null;
  const inputTokens = numberValue(rawUsage.input);
  const outputTokens = numberValue(rawUsage.output);
  const cacheReadTokens = numberValue(rawUsage.cacheRead);
  const cacheWriteTokens = numberValue(rawUsage.cacheWrite);
  const channelTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedTotal = numberValue(rawUsage.totalTokens);
  const totalTokens = Math.max(channelTokens, reportedTotal);
  const rawCost = rawUsage.cost;
  const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
    ? rawCost
    : undefined;
  if (cost === undefined && totalTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(cost !== undefined ? { cost } : {}),
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
    const attributedUsages = attemptUsages.length > 0
      ? attemptUsages
      : resultUsage ? [{ usage: resultUsage, modelId: resultModelId, provider: resultProvider }] : [];
    if (attributedUsages.length > 0) {
      let resultCost = 0;
      for (const item of attributedUsages) {
        const modelId = normalizeModelId(
          qualifyBillingModelId(item.modelId, item.provider),
          depth <= 1 ? 'Unknown subagent model' : 'Unknown nested subagent model',
        );
        const estimatedPricing = item.modelId ? pricingForModel?.(item.modelId, item.provider) : undefined;
        const channelTokens = tokenChannelTotal(item.usage);
        const canUseCatalog = estimatedPricing !== undefined
          && item.usage.totalTokens > 0
          && item.usage.totalTokens === channelTokens;
        const hasReportedCost = item.usage.cost !== undefined;
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
  const usage = {
    inputTokens: numberValue(details.prepassInputTokens),
    outputTokens: numberValue(details.prepassOutputTokens),
    cacheReadTokens: numberValue(details.prepassCacheReadTokens),
    cacheWriteTokens: numberValue(details.prepassCacheWriteTokens),
    totalTokens: 0,
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
): void {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.cacheReadTokens += usage.cacheReadTokens;
  summary.cacheWriteTokens += usage.cacheWriteTokens;
  summary.totalTokens += usage.totalTokens;
  const billingModelId = qualifyBillingModelId(modelId, provider);
  if (billingModelId) summary.modelIds.add(billingModelId);
  const resolved = resolveUsageCost(usage, pricing, usage.reportedCostUsd);
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

  if (summary.reportedTurnCount === 0 && !liveEstimate && totalCost <= 0 && !prepassHasUsage && !prepassHasKnownCost && !subagentsHaveUsage) return null;

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
  const provenanceIncomplete = (sessionUsage?.incompleteInvocationCount ?? 0) > 0;
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
    tooltipLines.push('Session cost by provider / model (whole branch):', '  No priced usage');
  }
  if (hasIncompleteCost) {
    const incompleteInvocations = sessionUsage?.incompleteInvocationCount ?? 0;
    const unpricedInvocations = sessionUsage?.unpricedInvocationCount ?? 0;
    tooltipLines.push(
      '',
      `* Excludes ${formatCostTokens(unpricedTokens)} pending billing details or pricing.`,
      `  Provenance: ${incompleteInvocations} unknown and ${unpricedInvocations} unpriced invocation(s).`,
    );
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

  const label = hasIncompleteCost
    ? hasAnyKnownCost ? `${formatCostUsd(totalCost)}*` : '—*'
    : formatCostUsd(totalCost);
  const ariaLabel = hasIncompleteCost
    ? hasAnyKnownCost
      ? `Known estimated session cost ${formatCostUsd(totalCost)}; some provider/model usage is not yet priced.`
      : 'Estimated session cost unavailable because provider/model usage is not yet priced.'
    : `Estimated session cost ${formatCostUsd(totalCost)}.`;

  return {
    label,
    ariaLabel,
    tooltip: tooltipLines.join('\n'),
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
