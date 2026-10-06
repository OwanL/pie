import { providerReportedCostUsd } from '../../model-providers/pricing/provider-cost.js';
import type { ChatMessage, ToolCall } from '../../agent-processes/lib/rpc/message-contract.js';
import { formatToolResult } from './tool-result-format.js';
import {
  getSubagentBillingEntries,
  getSubagentResultEntries,
  type RawMessage,
} from '../../agent-processes/workers/subagent-result.js';
import { isRecord } from '../../../lib/validation/type-guards.js';
import type { SubagentBillingCaptureReceipt } from '../../../analytics/contracts/subagent-billing-capture-receipt.js';
import type { SessionUsageSample, SessionUsageSnapshot } from '../../../analytics/usage-accounting/session-usage.js';

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function reportedCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validTokenChannel(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function sampleFromAssistant(message: ChatMessage): SessionUsageSample | null {
  const usage = message.usage;
  if (message.role !== 'assistant' || !usage) return null;
  return {
    sourceId: `assistant:${message.durableEntryId ?? message.id}`,
    kind: 'assistant',
    modelId: message.modelId,
    provider: message.provider,
    ...(message.billingSourceEntryIds?.length ? {
      constituentSourceIds: message.billingSourceEntryIds.map((entryId) => `assistant:${entryId}`),
    } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    providerTotalTokens: usage.totalTokens,
    ...(usage.tokenChannelsKnown !== undefined ? { tokenChannelsKnown: usage.tokenChannelsKnown } : {}),
    ...(usage.tokenChannelPresence ? { tokenChannelPresence: usage.tokenChannelPresence } : {}),
    ...(usage.tokenChannelsKnown === false ? {
      instrumentationGap: true,
      instrumentationGapReason: 'The historical provider response omitted one or more token channels.',
    } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.reportedCostUsd !== undefined ? { reportedCostUsd: usage.reportedCostUsd } : {}),
  };
}

interface PruningUsageInvocation {
  invocationId: string;
  startedAt: string;
  endedAt: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reportedCostUsd?: number;
}

/** Narrow analytics view of the usage facts in a pruning-result custom payload. */
interface PruningUsageDetails {
  prepassModel?: string;
  prepassProvider?: string;
  prepassInputTokens?: number;
  prepassOutputTokens?: number;
  prepassCacheReadTokens?: number;
  prepassCacheWriteTokens?: number;
  prepassTokenChannelsKnown?: boolean;
  prepassTokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
  prepassReportedCostUsd?: number;
  prepassInvocations?: PruningUsageInvocation[];
}

function samplesFromPruning(message: ChatMessage): SessionUsageSample[] {
  if (message.customType !== 'pruning-result' || !isRecord(message.customDetails)) return [];
  const details = message.customDetails as unknown as PruningUsageDetails;
  if (details.prepassInvocations?.length) {
    return details.prepassInvocations.map((invocation) => {
      const tokenChannelPresence = {
        input: validTokenChannel(invocation.input),
        output: validTokenChannel(invocation.output),
        cacheRead: validTokenChannel(invocation.cacheRead),
        cacheWrite: validTokenChannel(invocation.cacheWrite),
      };
      const channelsKnown = Object.values(tokenChannelPresence).every(Boolean);
      const inputTokens = tokenChannelPresence.input ? invocation.input! : 0;
      const outputTokens = tokenChannelPresence.output ? invocation.output! : 0;
      const cacheReadTokens = tokenChannelPresence.cacheRead ? invocation.cacheRead! : 0;
      const cacheWriteTokens = tokenChannelPresence.cacheWrite ? invocation.cacheWrite! : 0;
      const reportedCostUsd = validTokenChannel(invocation.reportedCostUsd)
        ? invocation.reportedCostUsd : undefined;
      return {
        sourceId: invocation.invocationId,
        kind: 'skill_pruning_prepass',
        modelId: details.prepassModel,
        provider: details.prepassProvider,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: channelsKnown
          ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
          : 0,
        ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
        ...(!channelsKnown ? { tokenChannelsKnown: false, tokenChannelPresence } : {}),
        provenance: channelsKnown
          ? reportedCostUsd !== undefined ? 'exact' : 'estimated'
          : 'unknown',
        instrumentationGap: !channelsKnown,
        ...(!channelsKnown ? { instrumentationGapReason: 'The pruning provider invocation exposed no complete usage.' } : {}),
        outcome: invocation.outcome,
        startedAt: invocation.startedAt,
        endedAt: invocation.endedAt,
      };
    });
  }
  const inputTokens = nonNegativeNumber(details.prepassInputTokens);
  const outputTokens = nonNegativeNumber(details.prepassOutputTokens);
  const cacheReadTokens = nonNegativeNumber(details.prepassCacheReadTokens);
  const cacheWriteTokens = nonNegativeNumber(details.prepassCacheWriteTokens);
  const declaredPresence = details.prepassTokenChannelPresence;
  const hasChannelValues = [
    details.prepassInputTokens,
    details.prepassOutputTokens,
    details.prepassCacheReadTokens,
    details.prepassCacheWriteTokens,
  ].some((value) => value !== undefined);
  const inferredPresence = (value: unknown): boolean => details.prepassTokenChannelsKnown === false
    ? false
    : hasChannelValues ? validTokenChannel(value) : true;
  const tokenChannelPresence = {
    input: typeof declaredPresence?.input === 'boolean'
      ? declaredPresence.input && validTokenChannel(details.prepassInputTokens)
      : inferredPresence(details.prepassInputTokens),
    output: typeof declaredPresence?.output === 'boolean'
      ? declaredPresence.output && validTokenChannel(details.prepassOutputTokens)
      : inferredPresence(details.prepassOutputTokens),
    cacheRead: typeof declaredPresence?.cacheRead === 'boolean'
      ? declaredPresence.cacheRead && validTokenChannel(details.prepassCacheReadTokens)
      : inferredPresence(details.prepassCacheReadTokens),
    cacheWrite: typeof declaredPresence?.cacheWrite === 'boolean'
      ? declaredPresence.cacheWrite && validTokenChannel(details.prepassCacheWriteTokens)
      : inferredPresence(details.prepassCacheWriteTokens),
  };
  const channelsKnown = details.prepassTokenChannelsKnown !== false
    && Object.values(tokenChannelPresence).every(Boolean);
  const totalTokens = channelsKnown
    ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    : 0;
  const reportedCostUsd = typeof details.prepassReportedCostUsd === 'number'
    && Number.isFinite(details.prepassReportedCostUsd) && details.prepassReportedCostUsd >= 0
    ? details.prepassReportedCostUsd
    : undefined;
  const hasIncompleteEvidence = !channelsKnown
    && (details.prepassTokenChannelsKnown === false || declaredPresence !== undefined || hasChannelValues);
  if (!details.prepassModel || (totalTokens <= 0 && reportedCostUsd === undefined && !hasIncompleteEvidence)) return [];
  return [{
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
    ...(!channelsKnown ? { tokenChannelsKnown: false, tokenChannelPresence } : {}),
    ...(!channelsKnown ? {
      provenance: 'unknown' as const,
      instrumentationGap: true,
      instrumentationGapReason: 'The pruning provider response omitted one or more token channels.',
    } : {}),
  }];
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
  tokenChannelsKnown?: boolean;
  tokenChannelPresence?: SessionUsageSample['tokenChannelPresence'];
  instrumentationGap?: boolean;
  instrumentationGapReason?: string;
}

function subagentUsage(value: unknown): RawSubagentUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonNegativeNumber(value.input);
  const outputTokens = nonNegativeNumber(value.output);
  const cacheReadTokens = nonNegativeNumber(value.cacheRead);
  const cacheWriteTokens = nonNegativeNumber(value.cacheWrite);
  const channelTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedTotal = nonNegativeNumber(value.totalTokens);
  const totalTokens = Math.max(channelTokens, reportedTotal);
  // The nested SDK `cost.total` estimate is not evidence. A direct numeric
  // `cost` remains a legacy subagent wire alias for explicit provider billing.
  const reportedCostUsd = providerReportedCostUsd(value) ?? reportedCost(value.cost);
  if (totalTokens <= 0 && reportedCostUsd === undefined) return null;
  const declaredPresence = isRecord(value.tokenChannelPresence) ? value.tokenChannelPresence : undefined;
  const declaredIncomplete = value.tokenChannelsKnown === false;
  const channelPresent = (raw: unknown, key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): boolean => {
    if (!validTokenChannel(raw)) return false;
    if (declaredPresence && typeof declaredPresence[key] === 'boolean') return declaredPresence[key] as boolean;
    return !declaredIncomplete;
  };
  const presence = {
    input: channelPresent(value.input, 'input'),
    output: channelPresent(value.output, 'output'),
    cacheRead: channelPresent(value.cacheRead, 'cacheRead'),
    cacheWrite: channelPresent(value.cacheWrite, 'cacheWrite'),
  };
  const channelsKnown = !declaredIncomplete && Object.values(presence).every(Boolean);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    ...(!channelsKnown ? {
      tokenChannelsKnown: false,
      tokenChannelPresence: presence,
      instrumentationGap: true,
      instrumentationGapReason: 'The subagent provider result omitted one or more token channels.',
    } : {}),
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
    totalTokens: Math.max(
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      Math.max(0, total.totalTokens - part.totalTokens),
    ),
    ...(total.tokenChannelsKnown === false || part.tokenChannelsKnown === false ? {
      tokenChannelsKnown: false,
      tokenChannelPresence: {
        input: total.tokenChannelPresence?.input !== false && part.tokenChannelPresence?.input !== false,
        output: total.tokenChannelPresence?.output !== false && part.tokenChannelPresence?.output !== false,
        cacheRead: total.tokenChannelPresence?.cacheRead !== false && part.tokenChannelPresence?.cacheRead !== false,
        cacheWrite: total.tokenChannelPresence?.cacheWrite !== false && part.tokenChannelPresence?.cacheWrite !== false,
      },
      instrumentationGap: true,
      instrumentationGapReason: 'The subagent aggregate residual has incomplete token channels.',
    } : {}),
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
    const groupId = `subagent:${toolCall.id}:${path}${resultIndex}`;
    const attemptRecords = Array.isArray(rawResult.attemptRecords) ? rawResult.attemptRecords : [];
    const parsedResultUsage = subagentUsage(rawResult.usage);
    // A numeric aggregate `cost` is a legacy compatibility field. When
    // per-attempt records exist, do not let a stale aggregate estimate become
    // an exact residual; only an explicitly labelled provider report owns it.
    const resultUsage = parsedResultUsage && attemptRecords.length > 0
      && providerReportedCostUsd(rawResult.usage) === undefined
      ? { ...parsedResultUsage, reportedCostUsd: undefined }
      : parsedResultUsage;
    const resultStartedAt = attemptRecords
      .map((attempt) => isRecord(attempt) ? isoTimestamp(attempt.startedAt) : undefined)
      .find((timestamp) => timestamp !== undefined);
    const resultEndedAt = [...attemptRecords]
      .reverse()
      .map((attempt) => isRecord(attempt)
        ? isoTimestamp(attempt.completedAt) ?? isoTimestamp(attempt.endedAt)
        : undefined)
      .find((timestamp) => timestamp !== undefined);
    const resultOutcome = rawResult.exitCode === 0 ? 'succeeded'
      : typeof rawResult.exitCode === 'number' ? 'failed' : 'unknown';
    // A cost-only/zero-token aggregate must not clip independently captured
    // attempts to zero. Its monetary evidence is reconciled below, while
    // attempt token usage remains authoritative when present.
    let remaining = resultUsage
      && resultUsage.totalTokens > 0
      && resultUsage.tokenChannelsKnown !== false
      ? resultUsage
      : null;
    let attributedReportedCost = 0;

    if (attemptRecords.length > 0) {
      for (const [attemptIndex, attempt] of attemptRecords.entries()) {
        if (!isRecord(attempt)) continue;
        const attemptId = typeof attempt.attemptId === 'string' && attempt.attemptId.trim()
          ? attempt.attemptId.trim()
          : String(attemptIndex);
        const usage = attempt.providerResponseObserved === false
          ? null
          : subagentUsage(attempt.usage);
        const outcome = attempt.outcome === 'success' ? 'succeeded'
          : attempt.outcome === 'aborted' ? 'cancelled'
            : attempt.outcome === 'failure' ? 'failed' : 'unknown';
        const startedAt = isoTimestamp(attempt.startedAt);
        const endedAt = isoTimestamp(attempt.completedAt) ?? isoTimestamp(attempt.endedAt);
        if (!usage) {
          samples.push({
            sourceId: `${groupId}:attempt:${attemptId}`,
            groupId,
            kind: 'subagent',
            modelId: typeof attempt.model === 'string' ? attempt.model : resultModelId,
            provider: typeof attempt.provider === 'string' ? attempt.provider : resultProvider,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            provenance: 'unknown',
            instrumentationGap: true,
            instrumentationGapReason: 'The terminal subagent attempt exposed no provider usage.',
            outcome,
            ...(startedAt ? { startedAt } : {}),
            ...(endedAt ? { endedAt } : {}),
          });
          continue;
        }
        const bounded = remaining ? {
          ...usage,
          inputTokens: Math.min(remaining.inputTokens, usage.inputTokens),
          outputTokens: Math.min(remaining.outputTokens, usage.outputTokens),
          cacheReadTokens: Math.min(remaining.cacheReadTokens, usage.cacheReadTokens),
          cacheWriteTokens: Math.min(remaining.cacheWriteTokens, usage.cacheWriteTokens),
          totalTokens: Math.min(remaining.totalTokens, usage.totalTokens),
        } : usage;
        bounded.totalTokens = Math.max(
          bounded.inputTokens + bounded.outputTokens + bounded.cacheReadTokens + bounded.cacheWriteTokens,
          bounded.totalTokens,
        );
        if (bounded.totalTokens <= 0 && bounded.reportedCostUsd === undefined) continue;
        samples.push({
          sourceId: `${groupId}:attempt:${attemptId}`,
          groupId,
          kind: 'subagent',
          modelId: typeof attempt.model === 'string' ? attempt.model : resultModelId,
          provider: typeof attempt.provider === 'string' ? attempt.provider : resultProvider,
          ...bounded,
          // When only the result aggregate reports an exact cost, its residual
          // sample below owns that cost. Keep attempts explicitly unpriced so
          // catalog pricing cannot be added on top of the exact aggregate;
          // absence is not fabricated free billing.
          ...(bounded.reportedCostUsd === undefined && resultUsage?.reportedCostUsd !== undefined
            ? { provenance: 'unpriced' as const }
            : {}),
          outcome,
          ...(startedAt ? { startedAt } : {}),
          ...(endedAt ? { endedAt } : {}),
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
        outcome: resultOutcome,
        ...(resultStartedAt ? { startedAt: resultStartedAt } : {}),
        ...(resultEndedAt ? { endedAt: resultEndedAt } : {}),
      });
    } else if (residualReportedCost !== undefined) {
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
        provenance: 'exact',
        outcome: resultOutcome,
        ...(resultStartedAt ? { startedAt: resultStartedAt } : {}),
        ...(resultEndedAt ? { endedAt: resultEndedAt } : {}),
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

function sampleFromBillingUsage(
  sourceId: string,
  groupId: string,
  modelId: string | undefined,
  provider: string | undefined,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
    tokenChannelsKnown?: boolean;
    tokenChannelPresence?: SessionUsageSample['tokenChannelPresence'];
    /** Legacy direct numeric provider-cost alias; never a nested cost.total. */
    cost?: number;
    reportedCostUsd?: number;
    providerReportedCostUsd?: number;
  } | undefined,
  outcome: SessionUsageSample['outcome'],
  startedAt?: number,
  completedAt?: number,
  producer?: {
    canonicalInvocationId?: string;
    captureReceipt?: SubagentBillingCaptureReceipt;
    attemptId?: string;
    evidenceKind: NonNullable<SessionUsageSample['producerEvidenceKind']>;
  },
): SessionUsageSample {
  const channelsKnown = usage !== undefined
    && usage.tokenChannelsKnown !== false
    && (!usage.tokenChannelPresence || Object.values(usage.tokenChannelPresence).every(Boolean));
  return {
    sourceId,
    groupId,
    kind: 'subagent',
    modelId,
    provider,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    totalTokens: usage ? Math.max(
      usage.totalTokens ?? 0,
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    ) : 0,
    ...(usage?.tokenChannelPresence ? { tokenChannelPresence: usage.tokenChannelPresence } : {}),
    ...(providerReportedCostUsd(usage) !== undefined
      ? { reportedCostUsd: providerReportedCostUsd(usage) }
      : usage?.cost !== undefined ? { reportedCostUsd: usage.cost } : {}),
    tokenChannelsKnown: channelsKnown,
    ...(!channelsKnown ? {
      provenance: 'unknown' as const,
      instrumentationGap: true,
      instrumentationGapReason: usage
        ? 'The subagent provider response omitted one or more token channels.'
        : 'The observable subagent provider invocation exposed no usage.',
    } : {}),
    outcome,
    ...(startedAt !== undefined ? { startedAt: new Date(startedAt).toISOString() } : {}),
    ...(completedAt !== undefined ? { endedAt: new Date(completedAt).toISOString() } : {}),
    ...(producer?.canonicalInvocationId ? { canonicalInvocationId: producer.canonicalInvocationId } : {}),
    ...(producer?.captureReceipt ? { producerCaptureReceipt: producer.captureReceipt } : {}),
    ...(producer?.attemptId ? { producerAttemptId: producer.attemptId } : {}),
    ...(producer ? { producerEvidenceKind: producer.evidenceKind } : {}),
  };
}

/** Build one row per observable subagent provider invocation. The compact
 * terminal billing sideband is authoritative when present; render transcript
 * aggregates are compatibility input only. */
export function buildSubagentUsageSamples(toolCall: Pick<ToolCall, 'id' | 'result' | 'status'>): SessionUsageSample[] {
  const billing = getSubagentBillingEntries(toolCall.result);
  if (billing.length > 0) {
    const samples: SessionUsageSample[] = [];
    for (const entry of billing) {
      const groupId = `subagent:${toolCall.id}:${entry.path}`;
      const representedAttempts = new Set<string>();
      for (const invocation of entry.invocations ?? []) {
        representedAttempts.add(invocation.attemptId);
        const captureReceipt = entry.attempts?.find(
          (attempt) => attempt.attemptId === invocation.attemptId,
        )?.analyticsCaptureReceipt;
        samples.push(sampleFromBillingUsage(
          `${groupId}:invocation:${invocation.invocationId}`,
          groupId,
          invocation.model ?? entry.model ?? entry.selectedModel,
          invocation.provider ?? entry.provider,
          invocation.usage,
          invocation.outcome === 'failure' ? 'failed' : invocation.outcome === 'aborted' ? 'cancelled' : 'succeeded',
          invocation.startedAt,
          invocation.completedAt,
          {
            canonicalInvocationId: invocation.canonicalInvocationId ?? invocation.invocationId,
            captureReceipt,
            attemptId: invocation.attemptId,
            evidenceKind: 'providerInvocation',
          },
        ));
      }
      for (let omittedIndex = 0; omittedIndex < (entry.omittedInvocationCount ?? 0); omittedIndex += 1) {
        const captureReceipt = entry.attempts?.find(
          (attempt) => attempt.analyticsCaptureReceipt?.factStatus !== 'disabled',
        )?.analyticsCaptureReceipt ?? entry.attempts?.find(
          (attempt) => attempt.analyticsCaptureReceipt?.factStatus === 'disabled',
        )?.analyticsCaptureReceipt;
        samples.push(sampleFromBillingUsage(
          `${groupId}:invocation:omitted:${omittedIndex}`,
          groupId,
          entry.model ?? entry.selectedModel,
          entry.provider,
          undefined,
          'unknown',
          undefined,
          entry.occurredAt,
          {
            captureReceipt,
            evidenceKind: 'omittedGap',
          },
        ));
      }
      for (const attempt of entry.attempts ?? []) {
        if (representedAttempts.has(attempt.attemptId)) continue;
        const sample = sampleFromBillingUsage(
          `${groupId}:attempt:${attempt.attemptId}`,
          groupId,
          attempt.model ?? entry.model ?? entry.selectedModel,
          attempt.provider ?? entry.provider,
          attempt.providerResponseObserved === false ? undefined : attempt.usage,
          attempt.outcome === 'failure' ? 'failed' : attempt.outcome === 'aborted' ? 'cancelled' : 'succeeded',
          attempt.startedAt,
          attempt.completedAt,
          {
            captureReceipt: attempt.analyticsCaptureReceipt,
            attemptId: attempt.attemptId,
            evidenceKind: 'attemptGap',
          },
        );
        // The aggregate report owns the cost when an attempt did not expose
        // independent provider billing. Do not synthesize a reported zero;
        // mark the attempt unpriced so catalog pricing is also withheld.
        if (sample.reportedCostUsd === undefined
          && providerReportedCostUsd(entry.usage) !== undefined) {
          sample.provenance = 'unpriced';
        }
        samples.push(sample);
      }
      const representedAttemptCount = (entry.invocations?.length ?? 0)
        + (entry.attempts?.length ?? 0) + (entry.omittedInvocationCount ?? 0);
      // Numeric aggregate `cost` is retained only for a compact result with
      // no attempt/invocation split. The direct numeric `cost` is a legacy
      // provider-cost alias; nested SDK cost.total is never read here.
      const aggregateReportedCost = providerReportedCostUsd(entry.usage)
        ?? (representedAttemptCount === 0 && typeof entry.usage?.cost === 'number'
          && Number.isFinite(entry.usage.cost) && entry.usage.cost >= 0 ? entry.usage.cost : undefined);
      if (aggregateReportedCost !== undefined && representedAttemptCount > 0) {
        const representedSamples = samples.filter((sample) => sample.groupId === groupId);
        const attemptReportedCost = representedSamples.reduce(
          (total, sample) => total + (sample.reportedCostUsd ?? 0),
          0,
        );
        const attemptReportedCount = representedSamples.filter((sample) => sample.reportedCostUsd !== undefined).length;
        if (aggregateReportedCost > attemptReportedCost || attemptReportedCount === 0) {
          const residualCost = Math.max(0, aggregateReportedCost - attemptReportedCost);
          samples.push(sampleFromBillingUsage(
            `${groupId}:residual-cost`,
            groupId,
            entry.model ?? entry.selectedModel,
            entry.provider,
            {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              reportedCostUsd: residualCost,
            },
            'succeeded',
            undefined,
            entry.occurredAt,
            { evidenceKind: 'aggregate' },
          ));
        }
      }
      if ((entry.invocations?.length ?? 0) === 0 && (entry.attempts?.length ?? 0) === 0
        && (entry.omittedInvocationCount ?? 0) === 0) {
        const aggregateHasEvidence = !!entry.usage && (entry.usage.input > 0 || entry.usage.output > 0
          || entry.usage.cacheRead > 0 || entry.usage.cacheWrite > 0 || (entry.usage.totalTokens ?? 0) > 0
          || providerReportedCostUsd(entry.usage) !== undefined
          || (typeof entry.usage?.cost === 'number' && Number.isFinite(entry.usage.cost) && entry.usage.cost >= 0));
        samples.push(sampleFromBillingUsage(
          groupId,
          groupId,
          entry.model ?? entry.selectedModel,
          entry.provider,
          aggregateHasEvidence ? entry.usage : undefined,
          toolCall.status === 'failed' ? 'failed' : 'succeeded',
          undefined,
          entry.occurredAt,
          { evidenceKind: 'aggregate' },
        ));
      }
    }
    return samples;
  }

  const samples: SessionUsageSample[] = [];
  addSubagentToolSamples(samples, toolCall, '', 1);
  // A terminal child result with no usage and no attempt/provider sideband is
  // itself observable dispatch evidence and must not disappear as known zero.
  if (samples.length === 0 && getSubagentResultEntries(toolCall.result).length > 0) {
    for (const [index, result] of getSubagentResultEntries(toolCall.result).entries()) {
      samples.push(sampleFromBillingUsage(
        `subagent:${toolCall.id}:${index}:instrumentation-gap`,
        `subagent:${toolCall.id}:${index}`,
        typeof result.model === 'string' ? result.model : undefined,
        typeof result.provider === 'string' ? result.provider : undefined,
        undefined,
        toolCall.status === 'failed' ? 'failed' : 'unknown',
      ));
    }
  }
  return samples;
}

export function buildSessionUsageSnapshot(transcript: ChatMessage[], branchId?: string): SessionUsageSnapshot {
  const samples: SessionUsageSample[] = [];
  for (const message of transcript) {
    const assistant = sampleFromAssistant(message);
    if (assistant) samples.push(assistant);
    samples.push(...samplesFromPruning(message));
    if (message.role !== 'assistant') continue;
    for (const toolCall of toolCallsFromMessage(message)) {
      if (typeof toolCall.name !== 'string' || toolCall.name.trim().toLowerCase() !== 'subagent') continue;
      samples.push(...buildSubagentUsageSamples(toolCall));
    }
  }
  return { samples, ...(branchId ? { branchId } : {}) };
}
