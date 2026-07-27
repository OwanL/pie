import type { AssistantUsage, ThinkingLevel } from '../../shared/protocol';
import type { LifecycleValueSource, SubagentAttemptPhase, SubagentAttemptSample } from '../../../../shared/run-analytics-contracts.js';
import type { AuxiliaryLlmUsageSample, RetryTimingSample, RunSnapshot, TurnThroughputSample, TurnThroughputStatus } from './types';
import { coerceSessionAnalyticsFactors } from './coercion-factors';
import { coerceFunctionalSettings } from './coercion-functional-settings';
import {
  coerceFileExtensionRollup,
  coerceFileMutationRollup,
  coerceToolUsageRollup,
  coerceTreatmentChangeKinds,
  coerceVerificationRollup,
} from './coercion-rollups';
import {
  isInputKindArray,
  isObjectRecord,
  toNonNegativeInteger,
  toNullableNonNegativeInteger,
} from './coercion-utils';

function coerceAssistantUsage(value: unknown): AssistantUsage | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const inputTokens = toNonNegativeInteger(value.inputTokens);
  const outputTokens = toNonNegativeInteger(value.outputTokens);
  const cacheReadTokens = toNonNegativeInteger(value.cacheReadTokens);
  const cacheWriteTokens = toNonNegativeInteger(value.cacheWriteTokens);
  const reportedTotal = toNonNegativeInteger(value.totalTokens);
  const totalTokens = reportedTotal > 0
    ? reportedTotal
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens === 0) {
    return null;
  }
  // reasoningTokens is a subset of output (never added to totals); clamp to
  // outputTokens defensively so persisted/malformed data can't exceed it.
  const reasoningRaw = toNonNegativeInteger(value.reasoningTokens);
  const reasoningTokens = reasoningRaw > 0 ? Math.min(reasoningRaw, outputTokens) : undefined;
  const reportedCostUsd = typeof value.reportedCostUsd === 'number'
    && Number.isFinite(value.reportedCostUsd) && value.reportedCostUsd >= 0
    ? value.reportedCostUsd
    : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

const THROUGHPUT_STATUSES = new Set<TurnThroughputStatus>(['completed', 'error', 'interrupted']);
const AUXILIARY_LLM_USAGE_KINDS = new Set([
  'skill_pruning_prepass',
  'subagent',
  'history_compaction',
  'branch_summary',
]);

function coerceAuxiliaryLlmUsage(value: unknown): AuxiliaryLlmUsageSample[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const samples: AuxiliaryLlmUsageSample[] = [];
  for (const entry of value) {
    if (
      !isObjectRecord(entry)
      || typeof entry.kind !== 'string'
      || !AUXILIARY_LLM_USAGE_KINDS.has(entry.kind)
      || typeof entry.sourceId !== 'string'
      || !entry.sourceId
      || typeof entry.occurredAt !== 'string'
      || !entry.occurredAt
    ) {
      continue;
    }
    const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0
      ? Math.trunc(entry.durationMs)
      : undefined;
    const reportedCostUsd = typeof entry.reportedCostUsd === 'number'
      && Number.isFinite(entry.reportedCostUsd) && entry.reportedCostUsd >= 0
      ? entry.reportedCostUsd
      : undefined;
    samples.push({
      kind: entry.kind as AuxiliaryLlmUsageSample['kind'],
      sourceId: entry.sourceId,
      occurredAt: entry.occurredAt,
      modelId: typeof entry.modelId === 'string' && entry.modelId ? entry.modelId : undefined,
      ...(typeof entry.provider === 'string' && entry.provider ? { provider: entry.provider } : {}),
      inputTokens: toNonNegativeInteger(entry.inputTokens),
      outputTokens: toNonNegativeInteger(entry.outputTokens),
      cacheReadTokens: toNonNegativeInteger(entry.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(entry.cacheWriteTokens),
      ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  return samples;
}

/**
 * Coerce per-turn throughput samples from a persisted run snapshot. Malformed
 * samples are dropped; older runs recorded before sampling existed coerce to
 * an empty array.
 */
function coerceRetryTimingSamples(value: unknown): RetryTimingSample[] {
  if (!Array.isArray(value)) return [];
  const samples: RetryTimingSample[] = [];
  for (const entry of value) {
    if (!isObjectRecord(entry) || typeof entry.sourceId !== 'string' || !entry.sourceId
      || typeof entry.occurredAt !== 'string' || !entry.occurredAt) continue;
    samples.push({
      sourceId: entry.sourceId,
      occurredAt: entry.occurredAt,
      attempt: toNonNegativeInteger(entry.attempt),
      scheduledDelayMs: toNonNegativeInteger(entry.scheduledDelayMs),
      measuredDelayMs: toNullableNonNegativeInteger(entry.measuredDelayMs),
      durationMs: toNullableNonNegativeInteger(entry.durationMs),
    });
  }
  return samples;
}

const SUBAGENT_ATTEMPT_PHASES: readonly SubagentAttemptPhase[] = [
  'queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool', 'orphaned_cleanup',
];

function coercePhaseDurations(value: unknown): Partial<Record<SubagentAttemptPhase, number>> | null {
  if (!isObjectRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !SUBAGENT_ATTEMPT_PHASES.includes(key as SubagentAttemptPhase))) return null;
  const durations: Partial<Record<SubagentAttemptPhase, number>> = {};
  for (const phase of SUBAGENT_ATTEMPT_PHASES) {
    if (!(phase in value)) continue;
    const duration = toNullableNonNegativeInteger(value[phase]);
    if (duration === null || duration > Number.MAX_SAFE_INTEGER) return null;
    durations[phase] = duration;
  }
  return durations;
}

function coerceSubagentAttemptSamples(value: unknown): SubagentAttemptSample[] | undefined {
  // Absence (and a malformed collection) means unavailable lifecycle data, not
  // a zero-attempt result. An explicit empty array remains a valid report.
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const sources = new Set<LifecycleValueSource>(['reported', 'measured', 'estimated', 'unknown']);
  const outcomes = new Set(['success', 'failure', 'aborted']);
  const samples: SubagentAttemptSample[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObjectRecord(entry) || typeof entry.sourceId !== 'string' || !entry.sourceId
      || typeof entry.attemptId !== 'string' || !entry.attemptId
      || !outcomes.has(entry.outcome as string)
      || !sources.has(entry.durationSource as LifecycleValueSource)
      || !sources.has(entry.backoffSource as LifecycleValueSource)
      || !sources.has(entry.phaseDurationsSource as LifecycleValueSource)
      || !sources.has(entry.attemptSettlementSource as LifecycleValueSource)
      || entry.parentSettlementSource !== 'unknown'
      || !sources.has(entry.cleanupSource as LifecycleValueSource)
      || seen.has(entry.sourceId)) continue;
    const durationMs = toNullableNonNegativeInteger(entry.durationMs);
    const backoffMs = toNullableNonNegativeInteger(entry.backoffMs);
    const phaseDurationsMs = coercePhaseDurations(entry.phaseDurationsMs);
    // A claimed value without its matching provenance is malformed: preserve
    // uncertainty rather than silently treating it as reported/measured.
    const durationSource = durationMs === null || entry.durationSource === 'unknown'
      ? 'unknown'
      : entry.durationSource as LifecycleValueSource;
    const backoffSource = backoffMs === null || entry.backoffSource === 'unknown'
      ? 'unknown'
      : entry.backoffSource as LifecycleValueSource;
    const attemptSettlementOutcome = typeof entry.attemptSettlementOutcome === 'string' && entry.attemptSettlementOutcome.trim()
      ? entry.attemptSettlementOutcome.trim()
      : null;
    const cleanupOutcome = typeof entry.cleanupOutcome === 'string' && entry.cleanupOutcome.trim()
      ? entry.cleanupOutcome.trim()
      : null;
    seen.add(entry.sourceId);
    samples.push({
      sourceId: entry.sourceId,
      attemptId: entry.attemptId,
      retryIndex: toNonNegativeInteger(entry.retryIndex),
      provider: typeof entry.provider === 'string' && entry.provider ? entry.provider : undefined,
      model: typeof entry.model === 'string' && entry.model ? entry.model : undefined,
      outcome: entry.outcome as SubagentAttemptSample['outcome'],
      failureClass: typeof entry.failureClass === 'string' && entry.failureClass ? entry.failureClass : undefined,
      replaySafety: typeof entry.replaySafety === 'string' && entry.replaySafety ? entry.replaySafety : undefined,
      durationMs,
      durationSource,
      backoffMs,
      backoffSource,
      phaseDurationsMs,
      // Runner phase timing is local elapsed evidence: accept only an explicit
      // measured provenance; any other persisted label remains unavailable.
      phaseDurationsSource: phaseDurationsMs !== null && entry.phaseDurationsSource === 'measured'
        ? 'measured'
        : 'unknown',
      attemptSettlementOutcome,
      attemptSettlementSource: attemptSettlementOutcome ? entry.attemptSettlementSource as LifecycleValueSource : 'unknown',
      parentSettlementSource: 'unknown',
      cleanupOutcome,
      cleanupSource: cleanupOutcome ? entry.cleanupSource as LifecycleValueSource : 'unknown',
    });
  }
  return samples;
}

function coerceTurnThroughputSamples(value: unknown): TurnThroughputSample[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const samples: TurnThroughputSample[] = [];
  for (const entry of value) {
    if (!isObjectRecord(entry)) {
      continue;
    }
    const endedAt = typeof entry.endedAt === 'string' ? entry.endedAt : null;
    if (!endedAt) {
      continue;
    }
    const status: TurnThroughputStatus =
      typeof entry.status === 'string' && THROUGHPUT_STATUSES.has(entry.status as TurnThroughputStatus)
        ? (entry.status as TurnThroughputStatus)
        : 'completed';
    samples.push({
      endedAt,
      outputTokens: toNonNegativeInteger(entry.outputTokens),
      inputTokens: toNonNegativeInteger(entry.inputTokens),
      cacheReadTokens: toNonNegativeInteger(entry.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(entry.cacheWriteTokens),
      contextTokens: toNullableNonNegativeInteger(entry.contextTokens),
      generationDurationMs: toNonNegativeInteger(entry.generationDurationMs),
      concurrentBusySessions: toNonNegativeInteger(entry.concurrentBusySessions),
      status,
      modelId: typeof entry.modelId === 'string' ? entry.modelId : undefined,
      provider: typeof entry.provider === 'string' ? entry.provider : undefined,
      reportedCostUsd: typeof entry.reportedCostUsd === 'number'
        && Number.isFinite(entry.reportedCostUsd) && entry.reportedCostUsd >= 0
        ? entry.reportedCostUsd
        : undefined,
      providerQueueMs: toNullableNonNegativeInteger(entry.providerQueueMs),
      providerQueueAttemptCount: toNonNegativeInteger(entry.providerQueueAttemptCount),
      turnLatencyMs: toNullableNonNegativeInteger(entry.turnLatencyMs),
      overheadMs: toNullableNonNegativeInteger(entry.overheadMs),
      providerLatencyMs: toNullableNonNegativeInteger(entry.providerLatencyMs),
    });
  }
  return samples;
}

/* ---------- Validation helpers ---------- */

function validateIdentity(candidate: Partial<RunSnapshot>): boolean {
  return (
    typeof candidate.sessionPath === 'string' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.taskGroupId === 'string' &&
    (candidate.status === 'open' || candidate.status === 'closed')
  );
}

function validateFlagsAndTimestamps(candidate: Partial<RunSnapshot>): boolean {
  return (
    typeof candidate.startedAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.mixedModelConfig === 'boolean'
  );
}

function validateCounters(candidate: Partial<RunSnapshot>): boolean {
  return (
    typeof candidate.sendCount === 'number' &&
    typeof candidate.assistantTurnCount === 'number' &&
    typeof candidate.assistantTurnDurationMs === 'number' &&
    typeof candidate.interruptedCount === 'number' &&
    typeof candidate.messageEditCount === 'number' &&
    typeof candidate.truncatedAfterCount === 'number'
  );
}

function validateMediaCounts(candidate: Partial<RunSnapshot>): boolean {
  return (
    typeof candidate.filesystemPathRefCount === 'number' &&
    typeof candidate.imageInputCount === 'number' &&
    typeof candidate.imageInputBytes === 'number' &&
    typeof candidate.unsupportedInputCount === 'number'
  );
}

function validateArrays(candidate: Partial<RunSnapshot>): boolean {
  return (
    Array.isArray(candidate.backendErrorCodes) &&
    candidate.backendErrorCodes.every((item) => typeof item === 'string') &&
    isInputKindArray(candidate.inputKindsUsed)
  );
}

function validateOptionalNumbers(candidate: Partial<RunSnapshot>): boolean {
  return (
    (candidate.contextTokens === null || candidate.contextTokens === undefined || typeof candidate.contextTokens === 'number') &&
    (candidate.contextLimit === null || candidate.contextLimit === undefined || typeof candidate.contextLimit === 'number') &&
    (candidate.initialUserMessageChars === undefined || typeof candidate.initialUserMessageChars === 'number')
  );
}

function validateOptionalStrings(candidate: Partial<RunSnapshot>): boolean {
  return (
    (candidate.finalizedAt === undefined || typeof candidate.finalizedAt === 'string') &&
    (candidate.modelId === undefined || typeof candidate.modelId === 'string') &&
    (candidate.thinkingLevel === undefined || typeof candidate.thinkingLevel === 'string')
  );
}

function validateOptionalEnums(candidate: Partial<RunSnapshot>): boolean {
  return (
    candidate.finalizationReason === undefined || candidate.finalizationReason === 'closed' || candidate.finalizationReason === 'new_task'
  );
}

function isValidRunSnapshotCandidate(candidate: Partial<RunSnapshot>): boolean {
  return (
    validateIdentity(candidate) &&
    validateFlagsAndTimestamps(candidate) &&
    validateCounters(candidate) &&
    validateMediaCounts(candidate) &&
    validateArrays(candidate) &&
    validateOptionalNumbers(candidate) &&
    validateOptionalStrings(candidate) &&
    validateOptionalEnums(candidate)
  );
}

/* ---------- Construction helper ---------- */

function buildRunSnapshot(candidate: Partial<RunSnapshot>): RunSnapshot {
  const c = candidate as RunSnapshot;
  const subagentAttemptSamples = coerceSubagentAttemptSamples(candidate.subagentAttemptSamples);
  const unknownSubagentAttemptRecordSourceIds = Array.isArray(candidate.unknownSubagentAttemptRecordSourceIds)
    ? [...new Set(candidate.unknownSubagentAttemptRecordSourceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : undefined;
  const status = c.status;
  const finalizationReason = c.finalizationReason;
  return {
    sessionPath: c.sessionPath,
    runId: c.runId,
    taskGroupId: c.taskGroupId,
    status,
    startedAt: c.startedAt,
    updatedAt: c.updatedAt,
    finalizedAt: c.finalizedAt,
    finalizationReason,
    modelId: c.modelId,
    thinkingLevel: c.thinkingLevel as ThinkingLevel | undefined,
    mixedModelConfig: c.mixedModelConfig,
    mixedTreatmentConfig: candidate.mixedTreatmentConfig === true,
    treatmentChangeKinds: coerceTreatmentChangeKinds(candidate.treatmentChangeKinds),
    experimentAssignment:
      candidate.experimentAssignment === null
        ? null
        : typeof candidate.experimentAssignment === 'string'
          ? candidate.experimentAssignment
          : null,
    analyticsFactors: coerceSessionAnalyticsFactors(candidate.analyticsFactors),
    functionalSettings: coerceFunctionalSettings(candidate.functionalSettings),
    ...(candidate.initialUserMessageChars === undefined
      ? {}
      : { initialUserMessageChars: toNonNegativeInteger(candidate.initialUserMessageChars) }),
    sendCount: Math.trunc(c.sendCount),
    assistantTurnCount: Math.trunc(c.assistantTurnCount),
    assistantTurnDurationMs: Math.trunc(c.assistantTurnDurationMs),
    busyDurationMs: toNonNegativeInteger(candidate.busyDurationMs),
    busyPeriodCount: toNonNegativeInteger(candidate.busyPeriodCount),
    interruptedCount: Math.trunc(c.interruptedCount),
    messageEditCount: Math.trunc(c.messageEditCount),
    truncatedAfterCount: Math.trunc(c.truncatedAfterCount),
    compactionCount: toNonNegativeInteger(candidate.compactionCount),
    autoRetryCount: toNonNegativeInteger(candidate.autoRetryCount),
    retryTimingSamples: coerceRetryTimingSamples(candidate.retryTimingSamples),
    ...(subagentAttemptSamples === undefined ? {} : { subagentAttemptSamples }),
    ...(unknownSubagentAttemptRecordSourceIds === undefined ? {} : { unknownSubagentAttemptRecordSourceIds }),
    backendErrorCodes: [...c.backendErrorCodes],
    contextTokens: candidate.contextTokens ?? null,
    contextLimit: candidate.contextLimit ?? null,
    inputTokens: toNonNegativeInteger(candidate.inputTokens),
    outputTokens: toNonNegativeInteger(candidate.outputTokens),
    cacheReadTokens: toNonNegativeInteger(candidate.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(candidate.cacheWriteTokens),
    auxiliaryLlmUsage: coerceAuxiliaryLlmUsage(candidate.auxiliaryLlmUsage),
    tokenReportedTurnCount: toNonNegativeInteger(candidate.tokenReportedTurnCount),
    lastTurnUsage: coerceAssistantUsage(candidate.lastTurnUsage),
    turnThroughputSamples: coerceTurnThroughputSamples(candidate.turnThroughputSamples),
    filesystemPathRefCount: Math.trunc(c.filesystemPathRefCount),
    imageInputCount: Math.trunc(c.imageInputCount),
    imageInputBytes: Math.trunc(c.imageInputBytes),
    unsupportedInputCount: Math.trunc(c.unsupportedInputCount),
    inputKindsUsed: [...c.inputKindsUsed],
    toolUsage: coerceToolUsageRollup(candidate.toolUsage),
    fileMutation: coerceFileMutationRollup(candidate.fileMutation),
    fileExtensions: coerceFileExtensionRollup(candidate.fileExtensions),
    verification: coerceVerificationRollup(candidate.verification),
  };
}

export function coerceRunSnapshot(value: unknown): RunSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<RunSnapshot>;
  if (!isValidRunSnapshotCandidate(candidate)) {
    return null;
  }

  return buildRunSnapshot(candidate);
}

export function normalizeExperimentAssignment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
