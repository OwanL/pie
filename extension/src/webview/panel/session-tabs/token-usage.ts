import type { AssistantUsage, ChatMessage, ContextWindowUsage, PruningDetails, ToolCall } from '../../../shared/protocol';
import { formatToolResult } from '../../../shared/tool-result-format';
import { getRenderableSubagentResult, type RawMessage } from '../../../shared/subagent-result';
import { estimateTextTokens } from '../system-prompt-tokens';
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let reportedTurnCount = 0;
  let lastTurn: AssistantUsage | null = null;

  for (const message of transcript) {
    if (message.role !== 'assistant' || !message.usage) continue;
    const usage = message.usage;
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
}

export type TokenPricingResolver = (modelId: string) => TokenPricing | undefined;

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
};

interface ModelCostBreakdown extends CostUsage {
  modelId: string;
  cost: number;
  sources: Map<string, number>;
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
  source: string,
  usage: CostUsage,
  cost: number,
): void {
  const existing = models.get(modelId) ?? {
    modelId,
    ...emptyCostUsage(),
    cost: 0,
    sources: new Map<string, number>(),
  };

  existing.inputTokens += usage.inputTokens;
  existing.outputTokens += usage.outputTokens;
  existing.cacheReadTokens += usage.cacheReadTokens;
  existing.cacheWriteTokens += usage.cacheWriteTokens;
  existing.totalTokens += usage.totalTokens;
  existing.cost += cost;
  existing.sources.set(source, (existing.sources.get(source) ?? 0) + cost);
  models.set(modelId, existing);
}

function mergeModelCosts(target: Map<string, ModelCostBreakdown>, source: Map<string, ModelCostBreakdown>): void {
  for (const entry of source.values()) {
    const existing = target.get(entry.modelId) ?? {
      modelId: entry.modelId,
      ...emptyCostUsage(),
      cost: 0,
      sources: new Map<string, number>(),
    };
    existing.inputTokens += entry.inputTokens;
    existing.outputTokens += entry.outputTokens;
    existing.cacheReadTokens += entry.cacheReadTokens;
    existing.cacheWriteTokens += entry.cacheWriteTokens;
    existing.totalTokens += entry.totalTokens;
    existing.cost += entry.cost;
    for (const [sourceName, sourceCost] of entry.sources) {
      existing.sources.set(sourceName, (existing.sources.get(sourceName) ?? 0) + sourceCost);
    }
    target.set(entry.modelId, existing);
  }
}

function formatModelCostBreakdown(models: Map<string, ModelCostBreakdown>): string[] {
  const entries = Array.from(models.values())
    .filter((entry) => entry.cost > 0)
    .sort((a, b) => b.cost - a.cost || a.modelId.localeCompare(b.modelId));

  if (entries.length === 0) return [];

  const lines = ['Cost by model:'];
  for (const entry of entries) {
    lines.push(`  ${entry.modelId}: ${formatCostDetail(entry.cost)} (↑ ${formatReadableTokens(entry.inputTokens)} ↓ ${formatReadableTokens(entry.outputTokens)})`);
    const sources = Array.from(entry.sources.entries())
      .filter(([, cost]) => cost > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (sources.length > 1) {
      lines.push(`    ${sources.map(([name, cost]) => `${name} ${formatCostDetail(cost)}`).join(' · ')}`);
    }
  }
  return lines;
}

function formatCostDetail(cost: number): string {
  return `$${Math.max(0, cost).toFixed(4)}`;
}

function formatCostTokens(tokens: number): string {
  return `${formatReadableTokens(tokens)} token${tokens === 1 ? '' : 's'}`;
}

function costFromUsage(usage: CostUsage, pricing: TokenPricing): number {
  return ((usage.inputTokens / 1_000_000) * pricing.input)
    + ((usage.outputTokens / 1_000_000) * pricing.output)
    + ((usage.cacheReadTokens / 1_000_000) * pricing.cacheRead)
    + ((usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite);
}

function costBreakdownFromUsage(usage: CostUsage, pricing: TokenPricing) {
  const input = (usage.inputTokens / 1_000_000) * pricing.input;
  const output = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheRead = (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
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
    outputTokens += estimateTextTokens(message.markdown);
    outputTokens += estimateTextTokens(message.thinking ?? '');
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
): void {
  if (toolCall.status === 'failed') return;
  const subagentResult = getRenderableSubagentResult(toolCall.result);
  if (!subagentResult) return;

  for (const result of subagentResult.results) {
    const rawResult = result as unknown;
    if (!isRecord(rawResult)) continue;

    const usage = usageFromSubagentUsage(rawResult.usage);
    if (usage) {
      const source = depth <= 1 ? 'Sub-agents' : 'Nested sub-agents';
      const modelId = normalizeModelId(
        typeof rawResult.model === 'string' ? rawResult.model : (typeof rawResult.selectedModel === 'string' ? rawResult.selectedModel : undefined),
        depth <= 1 ? 'Unknown subagent model' : 'Unknown nested subagent model',
      );
      summary.totalCost += usage.cost;
      if (depth <= 1) {
        summary.directCost += usage.cost;
        summary.directResultCount += 1;
      } else {
        summary.nestedCost += usage.cost;
        summary.nestedResultCount += 1;
      }
      addModelCost(summary.modelCosts, modelId, source, usage, usage.cost);
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
        }, depth + 1);
      }
    }
  }
}

export function extractSubagentCostSummary(transcript: ChatMessage[]): SubagentCostSummary {
  const summary = emptySubagentCostSummary();
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of toolCallsFromMessage(message)) {
      if (typeof toolCall.name !== 'string') continue;
      if (toolCall.name.trim().toLowerCase() !== 'subagent') continue;
      addSubagentToolCallCost(summary, toolCall, 1);
    }
  }
  return summary;
}

export function extractSubagentDirectCost(transcript: ChatMessage[]): number {
  return extractSubagentCostSummary(transcript).directCost;
}

function buildPruningPrepassSummary(
  details: PruningCostDetails | undefined,
  pricing: TokenPricing | undefined,
  pricingForModel?: TokenPricingResolver,
): { cost: number; usage: CostUsage; modelId?: string; lines: string[] } {
  const empty = { cost: 0, usage: emptyCostUsage(), lines: [] };
  if (!details?.prepassModel) return empty;
  // Resolve the prepass model's OWN pricing — do NOT fall back to the
  // selected model's pricing. The prepass model is usually a different
  // (often cheaper/local) model; pricing it at the selected model's rate
  // would silently over-state the prepass cost. When no pricing is known for
  // the prepass model, fall through to the "unavailable" branch.
  const prepassPricing = pricingForModel?.(details.prepassModel);
  const usage = {
    inputTokens: numberValue(details.prepassInputTokens),
    outputTokens: numberValue(details.prepassOutputTokens),
    cacheReadTokens: numberValue(details.prepassCacheReadTokens),
    cacheWriteTokens: numberValue(details.prepassCacheWriteTokens),
    totalTokens: 0,
  };
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const hasUsage = usage.totalTokens > 0;
  if (!hasUsage) {
    return { cost: 0, usage, modelId: details.prepassModel, lines: ['Pruning prepass:', `  Model: ${details.prepassModel}`] };
  }

  const cost = prepassPricing ? costFromUsage(usage, prepassPricing) : 0;

  return {
    cost,
    usage,
    modelId: details.prepassModel,
    lines: [
      'Pruning prepass:',
      `  Model: ${details.prepassModel}`,
      `  Tokens: \u2191 ${formatReadableTokens(usage.inputTokens)} \u2193 ${formatReadableTokens(usage.outputTokens)}`,
      ...(usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0 ? [`  Cache: read ${formatReadableTokens(usage.cacheReadTokens)} · write ${formatReadableTokens(usage.cacheWriteTokens)}`] : []),
      ...(prepassPricing ? [`  Cost: ${formatCostDetail(cost)}`] : ['  Cost: unavailable (no pricing)']),
    ],
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
): void {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.cacheReadTokens += usage.cacheReadTokens;
  summary.cacheWriteTokens += usage.cacheWriteTokens;
  summary.totalTokens += usage.totalTokens;
  if (modelId) summary.modelIds.add(modelId);
  if (!pricing) return;

  const costs = costBreakdownFromUsage(usage, pricing);
  summary.inputCost += costs.input;
  summary.outputCost += costs.output;
  summary.cacheReadCost += costs.cacheRead;
  summary.cacheWriteCost += costs.cacheWrite;
  summary.totalCost += costs.total;
  summary.pricedTurnCount += 1;
  addModelCost(summary.modelCosts, normalizeModelId(modelId, 'Selected model'), 'Main turns', usage, costs.total);
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
    const messagePricing = message.modelId ? pricingForModel?.(message.modelId) ?? fallbackPricing : fallbackPricing;
    addCompletedUsageCost(completed, message.usage, messagePricing, message.modelId);
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
): SessionCostIndicatorState | null {
  const labelModel = modelName ?? 'Selected model';
  // Key the in-flight live-turn estimate by the selected model's *id* (not its
  // display name) so it merges with that model's completed turns in the
  // "Cost by model" rollup instead of spawning a duplicate display-name row
  // every time a turn streams.
  const subagents = typeof subagentCostOrSummary === 'number'
    ? { ...emptySubagentCostSummary(), totalCost: subagentCostOrSummary, directCost: subagentCostOrSummary }
    : subagentCostOrSummary;
  const prepass = buildPruningPrepassSummary(pruningDetails, pricing, pricingForModel);
  const liveCost = pricing && liveEstimate ? costFromUsage(liveEstimate, pricing) : 0;
  const hasUnclassifiedLiveContext = (liveEstimate?.unclassifiedContextTokens ?? 0) > 0;
  const mainCost = completed.totalCost;
  const totalCost = mainCost + liveCost + subagents.totalCost + prepass.cost;

  if (summary.reportedTurnCount === 0 && !liveEstimate && totalCost <= 0 && prepass.lines.length === 0) return null;

  const modelCosts = new Map<string, ModelCostBreakdown>();
  mergeModelCosts(modelCosts, completed.modelCosts);
  mergeModelCosts(modelCosts, subagents.modelCosts);
  if (pricing && liveEstimate && liveCost > 0) {
    addModelCost(modelCosts, normalizeModelId(selectedModelId, labelModel), 'Live estimate', liveEstimate, liveCost);
  }
  if (prepass.modelId && prepass.cost > 0) {
    addModelCost(modelCosts, prepass.modelId, 'Pruning prepass', prepass.usage, prepass.cost);
  }

  const tooltipLines = [
    `${labelModel}`,
    pricing
      ? `Completed subtotal: ${formatCostDetail(mainCost)}`
      : `Completed subtotal: unavailable (${formatReadableTokens(summary.totalTokens)} tokens (no pricing))`,
    `  Input:  ${pricing ? formatCostDetail(completed.inputCost) : 'unpriced'} (${formatCostTokens(completed.inputTokens)})`,
    `  Output: ${pricing ? formatCostDetail(completed.outputCost) : 'unpriced'} (${formatCostTokens(completed.outputTokens)})`,
  ];

  if (completed.modelIds.size > 1) {
    tooltipLines.push(`  Models: ${Array.from(completed.modelIds).join(', ')}`);
  } else if (completed.modelIds.size === 1) {
    tooltipLines.push(`  Model id: ${Array.from(completed.modelIds)[0]}`);
  }

  if (completed.cacheReadTokens > 0 || completed.cacheWriteTokens > 0) {
    tooltipLines.push(
      `  Cache read:  ${pricing ? formatCostDetail(completed.cacheReadCost) : 'unpriced'} (${formatCostTokens(completed.cacheReadTokens)})`,
      `  Cache write: ${pricing ? formatCostDetail(completed.cacheWriteCost) : 'unpriced'} (${formatCostTokens(completed.cacheWriteTokens)})`,
    );
  }

  if (liveEstimate) {
    const liveCosts = pricing ? costBreakdownFromUsage(liveEstimate, pricing) : null;
    tooltipLines.push(
      '',
      `Live turn ${hasUnclassifiedLiveContext ? 'partial ' : ''}estimate: ${pricing ? formatCostDetail(liveCost) : 'unavailable (no pricing)'}`,
      ...(hasUnclassifiedLiveContext
        ? [`  Context footprint: cost pending provider cache split (${formatCostTokens(liveEstimate.unclassifiedContextTokens)})`]
        : []),
      `  Output estimate: ${liveCosts ? formatCostDetail(liveCosts.output) : 'unpriced'} (${formatCostTokens(liveEstimate.outputTokens)})`,
    );
  }

  if (subagents.totalCost > 0) {
    const directCount = subagents.directResultCount > 0 ? ` (${subagents.directResultCount} result${subagents.directResultCount === 1 ? '' : 's'})` : '';
    tooltipLines.push('', 'Sub-agents:', `  Direct cost: ${formatCostDetail(subagents.directCost)}${directCount}`);
    if (subagents.nestedCost > 0) {
      tooltipLines.push(`  Nested cost: ${formatCostDetail(subagents.nestedCost)} (${subagents.nestedResultCount} result${subagents.nestedResultCount === 1 ? '' : 's'})`);
    }
  }

  if (prepass.lines.length > 0) {
    tooltipLines.push('', ...prepass.lines);
  }

  const modelCostLines = formatModelCostBreakdown(modelCosts);
  if (modelCostLines.length > 0) {
    tooltipLines.push('', ...modelCostLines);
  }

  tooltipLines.push(hasUnclassifiedLiveContext
    ? `Known subtotal: ${formatCostDetail(totalCost)} (live context cost excluded)`
    : `Total: ${formatCostDetail(totalCost)}`);

  const label = hasUnclassifiedLiveContext ? `${formatCostUsd(totalCost)}*` : formatCostUsd(totalCost);
  const ariaLabel = hasUnclassifiedLiveContext
    ? `Known estimated session cost ${formatCostUsd(totalCost)}; live context cost is pending the provider cache split.`
    : `Estimated session cost ${formatCostUsd(totalCost)}.`;

  return {
    label,
    ariaLabel,
    tooltip: tooltipLines.join('\n'),
  };
}
