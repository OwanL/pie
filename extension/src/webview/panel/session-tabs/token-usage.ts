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
  /** Number of assistant turns that contributed usage data. */
  reportedTurnCount: number;
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
  let lastTurn: AssistantUsage | null = null;

  for (const sample of snapshot.samples) {
    if (sample.kind !== 'assistant') continue;
    const usage = assistantUsageFromSample(sample);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalTokens += usage.totalTokens;
    reasoningTokens += usage.reasoningTokens ?? 0;
    reportedTurnCount += 1;
    lastTurn = usage;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reasoningTokens,
    reportedTurnCount,
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
  const compactIn = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.inputTokens) : '\u2014';
  const compactOut = summary.reportedTurnCount > 0 ? formatCompactTokens(summary.outputTokens) : '\u2014';

  // Token counts label (always present)
  const label = `\u2191 ${compactIn} \u2193 ${compactOut}`;

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
  if (summary.lastTurn) {
    tooltipLines.push(
      '',
      'Last turn:',
      `  \u2191 ${formatReadableTokens(summary.lastTurn.inputTokens)}  \u2193 ${formatReadableTokens(summary.lastTurn.outputTokens)}`,
    );
  }

  const ariaLabel =
    `Session token usage: input ${formatReadableTokens(summary.inputTokens)}, `
    + `output ${formatReadableTokens(summary.outputTokens)}.`;

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

export interface SessionCostIndicatorState {
  label: string;
  ariaLabel: string;
  tooltip: string;
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

function formatProviderModelCosts(models: Map<string, ModelCostBreakdown>): string[] {
  const entries = Array.from(models.values())
    .filter((entry) => entry.hasKnownCost || entry.unpricedTokens > 0)
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  if (entries.length === 0) return [];

  const lines = ['Session cost by provider / model:'];
  for (const entry of entries) {
    const separator = entry.modelId.indexOf('/');
    const billingIdentity = separator > 0
      ? `${entry.modelId.slice(0, separator)} / ${entry.modelId.slice(separator + 1)}`
      : `Unknown provider / ${entry.modelId}`;
    const cost = entry.hasKnownCost ? formatCostDetail(entry.cost) : 'unavailable';
    const partial = entry.unpricedTokens > 0 ? '*' : '';
    const unavailableUsage = !entry.hasKnownCost && entry.unpricedTokens > 0
      ? ` (${formatCostTokens(entry.unpricedTokens)})`
      : '';
    lines.push(`  ${billingIdentity}: ${cost}${partial}${unavailableUsage}`);
  }
  return lines;
}

function formatCostDetail(cost: number): string {
  return `$${Math.max(0, cost).toFixed(4)}`;
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

function costFromUsage(usage: CostUsage, pricing: TokenPricing): number {
  const effective = effectivePricing(usage, pricing);
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
  if (message.toolCalls?.length) return message.toolCalls;
  return message.parts
    ?.filter((part) => part.kind === 'toolCall')
    .map((part) => part.toolCall) ?? [];
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

function usageFromSubagentUsage(rawUsage: unknown): (CostUsage & { cost: number }) | null {
  if (!isRecord(rawUsage)) return null;
  const inputTokens = numberValue(rawUsage.input);
  const outputTokens = numberValue(rawUsage.output);
  const cacheReadTokens = numberValue(rawUsage.cacheRead);
  const cacheWriteTokens = numberValue(rawUsage.cacheWrite);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const cost = numberValue(rawUsage.cost);
  if (cost <= 0 && totalTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost,
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
  if (toolCall.status === 'failed') return;
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
          item.modelId && item.provider && !item.modelId.startsWith(`${item.provider}/`)
            ? `${item.provider}/${item.modelId}`
            : item.modelId,
          depth <= 1 ? 'Unknown subagent model' : 'Unknown nested subagent model',
        );
        const estimatedPricing = item.modelId ? pricingForModel?.(item.modelId, item.provider) : undefined;
        const attributedCost = item.usage.cost > 0
          ? item.usage.cost
          : estimatedPricing ? costFromUsage(item.usage, estimatedPricing) : 0;
        resultCost += attributedCost;
        const hasKnownCost = item.usage.cost > 0 || estimatedPricing !== undefined;
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
): { cost: number; usage: CostUsage; modelId?: string; hasUsage: boolean; hasKnownCost: boolean } {
  const empty = { cost: 0, usage: emptyCostUsage(), hasUsage: false, hasKnownCost: false };
  if (!details?.prepassModel) return empty;
  const billingModelId = details.prepassProvider
    ? `${details.prepassProvider}/${details.prepassModel}`
    : details.prepassModel;
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
  const hasKnownCost = reportedCost !== undefined || (hasUsage && prepassPricing !== undefined);
  const cost = reportedCost ?? (prepassPricing && hasUsage ? costFromUsage(usage, prepassPricing) : 0);

  return { cost, usage, modelId: billingModelId, hasUsage, hasKnownCost };
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
  const billingModelId = modelId && provider ? `${provider}/${modelId}` : modelId;
  if (billingModelId) summary.modelIds.add(billingModelId);
  const reportedCost = usage.reportedCostUsd;
  const hasKnownCost = pricing !== undefined || reportedCost !== undefined;
  const costs = pricing ? costBreakdownFromUsage(usage, pricing) : null;
  const totalCost = reportedCost ?? costs?.total ?? 0;
  if (costs) {
    const scale = reportedCost !== undefined && costs.total > 0 ? reportedCost / costs.total : 1;
    summary.inputCost += costs.input * scale;
    summary.outputCost += costs.output * scale;
    summary.cacheReadCost += costs.cacheRead * scale;
    summary.cacheWriteCost += costs.cacheWrite * scale;
  }
  if (hasKnownCost) {
    summary.totalCost += totalCost;
    summary.pricedTurnCount += 1;
  }
  addModelCost(
    summary.modelCosts,
    normalizeModelId(billingModelId, 'Selected model'),
    usage,
    totalCost,
    hasKnownCost,
    hasKnownCost ? 0 : usage.totalTokens,
  );
}

export function buildCompletedCostSummaryFromSnapshot(
  snapshot: SessionUsageSnapshot,
  fallbackPricing: TokenPricing | undefined,
  pricingForModel: TokenPricingResolver | undefined,
): CompletedCostSummary {
  const completed = emptyCompletedCostSummary();
  for (const sample of snapshot.samples) {
    if (sample.kind !== 'assistant') continue;
    const pricing = sample.modelId
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
  for (const sample of snapshot.samples) {
    if (sample.kind !== 'subagent') continue;
    const pricing = sample.modelId ? pricingForModel?.(sample.modelId, sample.provider) : undefined;
    const usage = assistantUsageFromSample(sample);
    const cost = sample.reportedCostUsd ?? (pricing ? costFromUsage(usage, pricing) : 0);
    const hasKnownCost = sample.reportedCostUsd !== undefined || pricing !== undefined;
    summary.totalCost += cost;
    summary.directCost += cost;
    summary.directResultCount += 1;
    const modelId = normalizeModelId(
      sample.modelId && sample.provider ? `${sample.provider}/${sample.modelId}` : sample.modelId,
      'Unknown subagent model',
    );
    addModelCost(summary.modelCosts, modelId, usage, cost, hasKnownCost, hasKnownCost ? 0 : usage.totalTokens);
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
  completed.pricedTurnCount = fallbackPricing ? usageSummary.reportedTurnCount : 0;
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
      const samplePricing = sample.modelId ? pricingForModel?.(sample.modelId, sample.provider) : undefined;
      const usage = assistantUsageFromSample(sample);
      const cost = sample.reportedCostUsd ?? (samplePricing ? costFromUsage(usage, samplePricing) : 0);
      const hasKnownCost = sample.reportedCostUsd !== undefined || samplePricing !== undefined;
      const modelId = normalizeModelId(
        sample.modelId && sample.provider ? `${sample.provider}/${sample.modelId}` : sample.modelId,
        'Unknown pruning prepass model',
      );
      prepassCost += cost;
      prepassHasUsage ||= usage.totalTokens > 0;
      prepassHasKnownCost ||= hasKnownCost;
      addModelCost(prepassModelCosts, modelId, usage, cost, hasKnownCost, hasKnownCost ? 0 : usage.totalTokens);
    }
  }
  const liveCost = pricing && liveEstimate ? costFromUsage(liveEstimate, pricing) : 0;
  const mainCost = completed.totalCost;
  const totalCost = mainCost + liveCost + subagents.totalCost + prepassCost;

  if (summary.reportedTurnCount === 0 && !liveEstimate && totalCost <= 0 && !prepassHasUsage && !prepassHasKnownCost) return null;

  const modelCosts = new Map<string, ModelCostBreakdown>();
  mergeModelCosts(modelCosts, completed.modelCosts);
  mergeModelCosts(modelCosts, subagents.modelCosts);
  mergeModelCosts(modelCosts, prepassModelCosts);
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
    const liveBillingModelId = selectedModelId && selectedProvider
      ? `${selectedProvider}/${selectedModelId}`
      : selectedModelId;
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
      prepass.hasKnownCost ? 0 : prepass.usage.totalTokens,
    );
  }

  const tooltipLines = formatProviderModelCosts(modelCosts);
  const unpricedTokens = Array.from(modelCosts.values())
    .reduce((total, entry) => total + entry.unpricedTokens, 0);
  const hasIncompleteCost = unpricedTokens > 0;
  const hasAnyKnownCost = Array.from(modelCosts.values()).some((entry) => entry.hasKnownCost);

  if (tooltipLines.length === 0) {
    tooltipLines.push('Session cost by provider / model:', '  No priced usage');
  }
  if (hasIncompleteCost) {
    tooltipLines.push('', `* Excludes ${formatCostTokens(unpricedTokens)} pending billing details or pricing.`);
  }
  tooltipLines.push(
    hasIncompleteCost
      ? hasAnyKnownCost
        ? `Known subtotal: ${formatCostDetail(totalCost)}`
        : 'Total: unavailable'
      : `Total: ${formatCostDetail(totalCost)}`,
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
  };
}
