import type { AssistantUsage, ThinkingLevel } from '../../shared/protocol';
import { RUN_ANALYTICS_SCHEMA_VERSION } from './types';
import type { AgentReviewEntry, OutcomeHistoryLogEntry, RunSnapshot, TurnThroughputSample, TurnThroughputStatus } from './types';
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
  isRunOutcome,
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
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

const THROUGHPUT_STATUSES = new Set<TurnThroughputStatus>(['completed', 'error', 'interrupted']);

/**
 * Coerce per-turn throughput samples from a persisted run snapshot. Malformed
 * samples are dropped; older runs recorded before sampling existed coerce to
 * an empty array.
 */
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
      generationDurationMs: toNonNegativeInteger(entry.generationDurationMs),
      concurrentBusySessions: toNonNegativeInteger(entry.concurrentBusySessions),
      status,
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
    (candidate.status === 'open' || candidate.status === 'scored' || candidate.status === 'closed_unscored')
  );
}

function validateFlagsAndTimestamps(candidate: Partial<RunSnapshot>): boolean {
  return (
    typeof candidate.scored === 'boolean' &&
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
    (candidate.contextLimit === null || candidate.contextLimit === undefined || typeof candidate.contextLimit === 'number')
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
    (candidate.finalizationReason === undefined || candidate.finalizationReason === 'scored' || candidate.finalizationReason === 'closed_unscored' || candidate.finalizationReason === 'new_task') &&
    (candidate.outcome === undefined || isRunOutcome(candidate.outcome))
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
  return {
    sessionPath: c.sessionPath,
    runId: c.runId,
    taskGroupId: c.taskGroupId,
    status: c.status,
    scored: c.scored,
    startedAt: c.startedAt,
    updatedAt: c.updatedAt,
    finalizedAt: c.finalizedAt,
    finalizationReason: c.finalizationReason,
    outcome: c.outcome,
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
    sendCount: Math.trunc(c.sendCount),
    assistantTurnCount: Math.trunc(c.assistantTurnCount),
    assistantTurnDurationMs: Math.trunc(c.assistantTurnDurationMs),
    busyDurationMs: toNonNegativeInteger(candidate.busyDurationMs),
    busyPeriodCount: toNonNegativeInteger(candidate.busyPeriodCount),
    interruptedCount: Math.trunc(c.interruptedCount),
    messageEditCount: Math.trunc(c.messageEditCount),
    truncatedAfterCount: Math.trunc(c.truncatedAfterCount),
    backendErrorCodes: [...c.backendErrorCodes],
    contextTokens: candidate.contextTokens ?? null,
    contextLimit: candidate.contextLimit ?? null,
    inputTokens: toNonNegativeInteger(candidate.inputTokens),
    outputTokens: toNonNegativeInteger(candidate.outputTokens),
    cacheReadTokens: toNonNegativeInteger(candidate.cacheReadTokens),
    cacheWriteTokens: toNonNegativeInteger(candidate.cacheWriteTokens),
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

export function coerceOutcomeHistoryLogEntry(value: unknown): OutcomeHistoryLogEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION
    || value.kind !== 'run_outcome'
    || typeof value.recordedAt !== 'string'
    || typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || !isRunOutcome(value.outcome)
  ) {
    return null;
  }

  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_outcome',
    recordedAt: value.recordedAt,
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    outcome: value.outcome,
  };
}

export function coerceAgentReviewEntry(value: unknown): AgentReviewEntry | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    value.schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION
    || value.kind !== 'agent_review'
    || typeof value.recordedAt !== 'string'
    || typeof value.sessionPath !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.taskGroupId !== 'string'
    || typeof value.done !== 'boolean'
    || typeof value.rating !== 'number'
    || !Number.isFinite(value.rating)
    || (value.completion !== 'fully' && value.completion !== 'partial' && value.completion !== 'setback')
    || typeof value.reason !== 'string'
    || typeof value.evaluatedAt !== 'string'
    || !Array.isArray(value.reviewerBuckets)
    || !value.reviewerBuckets.every((v) => typeof v === 'string')
    || typeof value.reviewerCount !== 'number'
    || !Number.isFinite(value.reviewerCount)
  ) {
    return null;
  }
  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'agent_review',
    recordedAt: value.recordedAt,
    sessionPath: value.sessionPath,
    runId: value.runId,
    taskGroupId: value.taskGroupId,
    done: value.done,
    rating: value.rating,
    completion: value.completion,
    reason: value.reason,
    evaluatedAt: value.evaluatedAt,
    reviewerBuckets: value.reviewerBuckets as string[],
    reviewerCount: Math.trunc(value.reviewerCount),
  };
}

export function normalizeExperimentAssignment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
