import type { AssistantUsage, ChatMessage, PruningDetails, ToolCall } from './protocol';
import { formatToolResult } from './tool-result-format';
import { getSubagentResultEntries, type RawMessage } from './subagent-result';
import { isRecord } from './type-guards';

export type SessionUsageKind = 'assistant' | 'subagent' | 'skill_pruning_prepass';

/** One independently billable model invocation retained outside transcript windows. */
export interface SessionUsageSample {
  sourceId: string;
  /** Stable subagent-result group shared by its aggregate and attempt samples. */
  groupId?: string;
  kind: SessionUsageKind;
  modelId?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  /** Exact provider-reported cost. Absent means catalog pricing must be used. */
  reportedCostUsd?: number;
}

/** Complete durable accounting for a session branch. */
export interface SessionUsageSnapshot {
  samples: SessionUsageSample[];
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function reportedPositiveCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sampleFromAssistant(message: ChatMessage): SessionUsageSample | null {
  const usage = message.usage;
  if (message.role !== 'assistant' || !usage) return null;
  return {
    sourceId: `assistant:${message.durableEntryId ?? message.id}`,
    kind: 'assistant',
    modelId: message.modelId,
    provider: message.provider,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.reportedCostUsd !== undefined ? { reportedCostUsd: usage.reportedCostUsd } : {}),
  };
}

function sampleFromPruning(message: ChatMessage): SessionUsageSample | null {
  if (message.customType !== 'pruning-result' || !isRecord(message.customDetails)) return null;
  const details = message.customDetails as unknown as PruningDetails;
  const inputTokens = nonNegativeNumber(details.prepassInputTokens);
  const outputTokens = nonNegativeNumber(details.prepassOutputTokens);
  const cacheReadTokens = nonNegativeNumber(details.prepassCacheReadTokens);
  const cacheWriteTokens = nonNegativeNumber(details.prepassCacheWriteTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedCostUsd = typeof details.prepassReportedCostUsd === 'number'
    && Number.isFinite(details.prepassReportedCostUsd) && details.prepassReportedCostUsd >= 0
    ? details.prepassReportedCostUsd
    : undefined;
  if (!details.prepassModel || (totalTokens <= 0 && reportedCostUsd === undefined)) return null;
  return {
    sourceId: `skill-pruning:${message.durableEntryId ?? message.id}`,
    kind: 'skill_pruning_prepass',
    modelId: details.prepassModel,
    provider: details.prepassProvider,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

function toolCallsFromMessage(message: ChatMessage): ToolCall[] {
  if (message.toolCalls?.length) return message.toolCalls;
  return message.parts
    ?.filter((part) => part.kind === 'toolCall')
    .map((part) => part.toolCall) ?? [];
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
      map.set(String(part.id), { result: part.result, status: 'completed' });
    }
  }
  return map;
}

interface RawSubagentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reportedCostUsd?: number;
}

function subagentUsage(value: unknown): RawSubagentUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonNegativeNumber(value.input);
  const outputTokens = nonNegativeNumber(value.output);
  const cacheReadTokens = nonNegativeNumber(value.cacheRead);
  const cacheWriteTokens = nonNegativeNumber(value.cacheWrite);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedCostUsd = reportedPositiveCost(value.cost);
  if (totalTokens <= 0 && reportedCostUsd === undefined) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

function subtractUsage(total: RawSubagentUsage, part: RawSubagentUsage): RawSubagentUsage {
  const inputTokens = Math.max(0, total.inputTokens - part.inputTokens);
  const outputTokens = Math.max(0, total.outputTokens - part.outputTokens);
  const cacheReadTokens = Math.max(0, total.cacheReadTokens - part.cacheReadTokens);
  const cacheWriteTokens = Math.max(0, total.cacheWriteTokens - part.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function addSubagentToolSamples(
  samples: SessionUsageSample[],
  toolCall: Pick<ToolCall, 'id' | 'result' | 'status'>,
  path: string,
  depth: number,
): void {
  // A failed outer call can still contain child attempts that reached the
  // provider and incurred billable usage. Status must not erase that cost.
  if (depth > 8) return;
  const results = getSubagentResultEntries(toolCall.result);
  if (results.length === 0) return;

  for (const [resultIndex, result] of results.entries()) {
    const rawResult = result as unknown;
    if (!isRecord(rawResult)) continue;
    const resultModelId = typeof rawResult.model === 'string'
      ? rawResult.model
      : typeof rawResult.selectedModel === 'string' ? rawResult.selectedModel : undefined;
    const resultProvider = typeof rawResult.provider === 'string' ? rawResult.provider : undefined;
    const resultUsage = subagentUsage(rawResult.usage);
    const groupId = `subagent:${toolCall.id}:${path}${resultIndex}`;
    let remaining = resultUsage;
    let attributedReportedCost = 0;

    if (Array.isArray(rawResult.attemptRecords)) {
      for (const [attemptIndex, attempt] of rawResult.attemptRecords.entries()) {
        if (!isRecord(attempt)) continue;
        const usage = subagentUsage(attempt.usage);
        if (!usage) continue;
        const bounded = remaining ? {
          ...usage,
          inputTokens: Math.min(remaining.inputTokens, usage.inputTokens),
          outputTokens: Math.min(remaining.outputTokens, usage.outputTokens),
          cacheReadTokens: Math.min(remaining.cacheReadTokens, usage.cacheReadTokens),
          cacheWriteTokens: Math.min(remaining.cacheWriteTokens, usage.cacheWriteTokens),
          totalTokens: 0,
        } : usage;
        bounded.totalTokens = bounded.inputTokens + bounded.outputTokens + bounded.cacheReadTokens + bounded.cacheWriteTokens;
        if (bounded.totalTokens <= 0 && bounded.reportedCostUsd === undefined) continue;
        const attemptId = typeof attempt.attemptId === 'string' && attempt.attemptId.trim()
          ? attempt.attemptId.trim()
          : String(attemptIndex);
        samples.push({
          sourceId: `${groupId}:attempt:${attemptId}`,
          groupId,
          kind: 'subagent',
          modelId: typeof attempt.model === 'string' ? attempt.model : resultModelId,
          provider: typeof attempt.provider === 'string' ? attempt.provider : resultProvider,
          ...bounded,
          // When only the result aggregate reports an exact cost, its residual
          // sample below owns that cost. Mark unpriced attempts as known-zero
          // so catalog pricing cannot be added on top of the exact aggregate.
          ...(bounded.reportedCostUsd === undefined && resultUsage?.reportedCostUsd !== undefined
            ? { reportedCostUsd: 0 }
            : {}),
        });
        attributedReportedCost += bounded.reportedCostUsd ?? 0;
        if (remaining) remaining = subtractUsage(remaining, bounded);
      }
    }

    const residualReportedCost = resultUsage?.reportedCostUsd !== undefined
      ? Math.max(0, resultUsage.reportedCostUsd - attributedReportedCost)
      : undefined;
    if (remaining && remaining.totalTokens > 0) {
      const { reportedCostUsd: _aggregateCost, ...remainingUsage } = remaining;
      samples.push({
        sourceId: groupId,
        groupId,
        kind: 'subagent',
        modelId: resultModelId,
        provider: resultProvider,
        ...remainingUsage,
        ...(residualReportedCost !== undefined ? { reportedCostUsd: residualReportedCost } : {}),
      });
    } else if (residualReportedCost !== undefined && residualReportedCost > 0) {
      samples.push({
        sourceId: `${groupId}:residual-cost`,
        groupId,
        kind: 'subagent',
        modelId: resultModelId,
        provider: resultProvider,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        reportedCostUsd: residualReportedCost,
      });
    }

    if (!Array.isArray(result.messages)) continue;
    const toolResults = collectRawToolResultMap(result.messages);
    for (const message of result.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall' || part.name !== 'subagent' || !part.id) continue;
        const nestedResult = toolResults.get(String(part.id));
        addSubagentToolSamples(samples, {
          id: String(part.id),
          result: nestedResult?.result ?? part.result,
          status: nestedResult?.status ?? 'running',
        }, `${path}${resultIndex}.`, depth + 1);
      }
    }
  }
}

/** Build price-independent accounting from every renderable message supplied. */
export function buildSessionUsageSnapshot(transcript: ChatMessage[]): SessionUsageSnapshot {
  const samples: SessionUsageSample[] = [];
  for (const message of transcript) {
    const assistant = sampleFromAssistant(message);
    if (assistant) samples.push(assistant);
    const pruning = sampleFromPruning(message);
    if (pruning) samples.push(pruning);
    if (message.role !== 'assistant') continue;
    for (const toolCall of toolCallsFromMessage(message)) {
      if (typeof toolCall.name !== 'string' || toolCall.name.trim().toLowerCase() !== 'subagent') continue;
      addSubagentToolSamples(samples, toolCall, '', 1);
    }
  }
  return { samples };
}

/**
 * Flat, deterministic accounting fingerprint. Structured-cloned snapshots get
 * fresh references on every host post; this lets the webview gate expensive
 * transcript/subagent walks on content rather than reference identity.
 */
export function sessionUsageSignature(snapshot: SessionUsageSnapshot | null | undefined): string {
  return JSON.stringify((snapshot?.samples ?? []).map((sample) => [
    sample.sourceId,
    sample.groupId ?? '',
    sample.kind,
    sample.modelId ?? '',
    sample.provider ?? '',
    sample.inputTokens,
    sample.outputTokens,
    sample.cacheReadTokens,
    sample.cacheWriteTokens,
    sample.totalTokens,
    sample.reasoningTokens ?? '',
    sample.reportedCostUsd ?? '',
  ]));
}

function sessionUsageGroupId(sample: SessionUsageSample): string {
  if (sample.groupId) return sample.groupId;
  if (sample.kind !== 'subagent' || !sample.sourceId.startsWith('subagent:')) return sample.sourceId;

  // Before groupId existed, attempt and residual source ids retained the
  // aggregate result id as a prefix. Recover that group for cross-version
  // baseline/overlay replacement while keeping sourceId as the fallback.
  for (const marker of [':attempt:', ':residual-cost']) {
    const markerIndex = sample.sourceId.lastIndexOf(marker);
    if (markerIndex > 0) return sample.sourceId.slice(0, markerIndex);
  }
  return sample.sourceId;
}

/** Merge a durable full-session baseline with fresher loaded/live rows.
 * Exact sources replace exact sources; a fresher subagent result replaces every
 * aggregate/attempt representation from the same stable result group. */
export function mergeSessionUsageSnapshots(
  baseline: SessionUsageSnapshot | null | undefined,
  overlay: SessionUsageSnapshot | null | undefined,
): SessionUsageSnapshot {
  const overlaySamples = overlay?.samples ?? [];
  const overlayGroups = new Set(overlaySamples.map(sessionUsageGroupId));
  const merged = new Map<string, SessionUsageSample>();
  for (const sample of baseline?.samples ?? []) {
    if (overlayGroups.has(sessionUsageGroupId(sample))) continue;
    merged.set(sample.sourceId, sample);
  }
  for (const sample of overlaySamples) merged.set(sample.sourceId, sample);
  return { samples: [...merged.values()] };
}

export function mergeAssistantUsage(
  current: AssistantUsage | undefined,
  incoming: AssistantUsage | undefined,
): AssistantUsage | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  const hasReasoning = current.reasoningTokens !== undefined || incoming.reasoningTokens !== undefined;
  const hasReportedCost = current.reportedCostUsd !== undefined || incoming.reportedCostUsd !== undefined;
  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
    cacheReadTokens: current.cacheReadTokens + incoming.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + incoming.cacheWriteTokens,
    totalTokens: current.totalTokens + incoming.totalTokens,
    ...(hasReasoning ? { reasoningTokens: (current.reasoningTokens ?? 0) + (incoming.reasoningTokens ?? 0) } : {}),
    ...(hasReportedCost ? { reportedCostUsd: (current.reportedCostUsd ?? 0) + (incoming.reportedCostUsd ?? 0) } : {}),
  };
}

export function assistantUsageFromSample(sample: SessionUsageSample): AssistantUsage {
  return {
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    cacheReadTokens: sample.cacheReadTokens,
    cacheWriteTokens: sample.cacheWriteTokens,
    totalTokens: sample.totalTokens,
    ...(sample.reasoningTokens !== undefined ? { reasoningTokens: sample.reasoningTokens } : {}),
    ...(sample.reportedCostUsd !== undefined ? { reportedCostUsd: sample.reportedCostUsd } : {}),
  };
}
