import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsActivitySpanFields,
  type AnalyticsBranchFields,
  type AnalyticsCopyFields,
  type AnalyticsDetailSink,
  type AnalyticsEntityKind,
  type AnalyticsExecutionFields,
  type AnalyticsFeatureObservationFields,
  type AnalyticsContextObservationFields,
  type AnalyticsLatencyFields,
  type AnalyticsObservation,
  type AnalyticsObservationKind,
  type AnalyticsProviderCallFields,
  type AnalyticsSink,
  type AnalyticsToolCallFields,
} from '../../../shared/analytics/contracts.js';
import type { ActivityIntervalRecord } from '../shared/activity-interval.js';
import type { BillableInvocationRecord } from '../shared/billable-invocation.js';
import type { ToolCall } from '../shared/protocol.js';
import { sanitizeAnalyticsDetail } from '../shared/sensitive-redaction.js';
import { canonicalAnalyticsToolEntityId } from '../../../shared/analytics/transport.js';

export type AnalyticsAuthority = 'legacy' | 'canonical';
export type AnalyticsCaptureStatus = 'disabled' | 'submitted' | 'rejected';

/** Canonical evidence permits absent producer dates, unlike legacy ledger rows. */
export type CanonicalProviderSettlement = Omit<BillableInvocationRecord, 'startedAt' | 'endedAt'> & {
  startedAt?: string | undefined;
  endedAt?: string | undefined;
};

export interface CanonicalAnalyticsLifecycleSink {
  bindPendingCreate(
    pendingOperationId: string,
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
  ): Promise<unknown>;
  deleteSession(
    rootSessionId: string,
    sourceKey: string,
    timestampMs: number | string | bigint,
    pendingOperationId?: string,
  ): Promise<unknown>;
}

export interface CanonicalAnalyticsCaptureOptions {
  authority: AnalyticsAuthority;
  generationId?: string;
  workspaceId: string;
  buildId: string;
  processGeneration: string;
  /** Bounded recent-source replay cache. Older exact redetections receive a
   * new delivery sequence and remain idempotent at the recorder. */
  maxTrackedSourceKeys?: number;
  sink?: AnalyticsSink;
  detailSink?: AnalyticsDetailSink;
  lifecycleSink?: CanonicalAnalyticsLifecycleSink;
  onCaptureError?: (error: Error, observation: AnalyticsObservation<object>) => void;
  onDetailCaptureError?: (error: Error, payloadId: string) => void;
}

export interface AnalyticsSessionContext {
  sessionId: string | null;
  sessionPath: string;
  runId?: string | null;
  operationId?: string | null;
}

function optionalTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestamp(value: string | number | undefined, fallback: number): number {
  return optionalTimestamp(value) ?? fallback;
}

/** Stable fallback only for pre-identity observations. The path itself is not
 * persisted in canonical analytics or source identities. */
export function analyticsRootSessionId(sessionId: string | null, sessionPath: string): string {
  if (sessionId?.trim()) return sessionId.trim();
  return `pending:${createHash('sha256').update(sessionPath).digest('hex')}`;
}

/** Stable pending-create identity prefers the lifecycle operation ID. The
 * session-path hash remains compatibility fallback and never persists a path. */
export function analyticsPendingOperationId(operationId: string | null | undefined, sessionPath: string): string {
  const identity = operationId?.trim() || sessionPath;
  return `pending:${createHash('sha256').update(identity).digest('hex')}`;
}

/**
 * Producer-side adapter for the canonical recorder DTO. It assigns one
 * monotonic source sequence per process generation and never waits for a
 * recorder acknowledgement. A synchronous capacity failure or asynchronous
 * transport rejection is surfaced through onCaptureError; it never falls back
 * to the legacy analytics authority.
 */
export class CanonicalAnalyticsCapture {
  private sequence = 0n;
  private readonly sequenceBySourceKey = new Map<string, string>();
  private readonly stableOriginId: string;

  constructor(private readonly options: CanonicalAnalyticsCaptureOptions) {
    this.stableOriginId = `host-origin:${createHash('sha256').update(JSON.stringify([
      options.generationId ?? null,
      options.workspaceId,
      options.buildId,
      options.processGeneration,
    ])).digest('hex')}`;
    if (options.authority === 'canonical'
      && (!options.generationId || !options.sink || !options.detailSink || !options.lifecycleSink)) {
      throw new Error('Canonical analytics authority requires generation, fact/detail, and lifecycle sinks.');
    }
  }

  get authority(): AnalyticsAuthority {
    return this.options.authority;
  }

  get enabled(): boolean {
    return this.options.authority === 'canonical';
  }

  /** Test/diagnostic surface proving producer replay memory is history-independent. */
  get trackedSourceKeyCount(): number {
    return this.sequenceBySourceKey.size;
  }

  scopedBranchId(context: AnalyticsSessionContext, sourceEntryId: string): string {
    const sessionIdentity = context.sessionId?.trim()
      || analyticsPendingOperationId(context.operationId, context.sessionPath);
    return `branch:${createHash('sha256').update(JSON.stringify([
      sessionIdentity,
      sourceEntryId,
    ])).digest('hex')}`;
  }

  async bindPendingCreate(
    sessionPath: string,
    rootSessionId: string,
    observedAtMs = Date.now(),
    operationId?: string,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!this.options.lifecycleSink) throw new Error('Canonical pending-create binding sink is not configured.');
    const pendingOperationId = analyticsPendingOperationId(operationId, sessionPath);
    await this.options.lifecycleSink.bindPendingCreate(
      pendingOperationId,
      rootSessionId,
      `bind:${pendingOperationId}:${rootSessionId}`,
      observedAtMs,
    );
  }

  async closeSession(
    rootSessionId: string,
    privacyMode: 'on' | 'off',
    observedAtMs = Date.now(),
    pendingCreateOperationId?: string,
  ): Promise<void> {
    if (!this.enabled || privacyMode === 'off') return;
    if (!this.options.lifecycleSink) throw new Error('Canonical deletion sink is not configured.');
    const pendingSubjectId = pendingCreateOperationId?.trim()
      ? analyticsPendingOperationId(pendingCreateOperationId, '')
      : undefined;
    await this.options.lifecycleSink.deleteSession(
      rootSessionId,
      `private-close:${rootSessionId}`,
      observedAtMs,
      pendingSubjectId,
    );
  }

  captureProviderSettlement(record: CanonicalProviderSettlement): AnalyticsCaptureStatus {
    if (!record.sessionPath && !record.sessionId) return 'rejected';
    const sessionPath = record.sessionPath ?? `session-id:${record.sessionId}`;
    const context: AnalyticsSessionContext = {
      sessionId: record.sessionId,
      sessionPath,
      runId: record.parentRunId,
      operationId: record.parentOperationId,
    };
    const rates = record.pricing?.rateSnapshot;
    const fields: AnalyticsProviderCallFields = {
      invocationId: record.invocationId,
      sourceId: record.sourceId,
      purpose: record.kind,
      provider: record.provider,
      dispatchedModel: record.model,
      startedAtMs: optionalTimestamp(record.startedAt),
      endedAtMs: optionalTimestamp(record.endedAt),
      // Missing source time belongs to the undated bucket. Receipt time and
      // the Unix epoch are not substitutes for a settlement's calendar date.
      settledAtMs: optionalTimestamp(record.endedAt),
      outcome: record.outcome,
      coverage: record.instrumentationGap ? 'unknown' : 'known',
      ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
      ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
      ...(record.cacheReadTokens === undefined ? {} : { cacheReadTokens: record.cacheReadTokens }),
      ...(record.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: record.cacheWriteTokens }),
      ...(record.reasoningTokens === undefined ? {} : { reasoningTokens: record.reasoningTokens }),
      ...(record.providerTotalTokens === undefined ? {} : { providerTotalTokens: record.providerTotalTokens }),
      // BillableInvocationRecord channels are normalized upstream as disjoint
      // input/cache channels; reasoning is a subset of output.
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: false,
      ...(record.providerReportedCostUsd === undefined ? {} : { reportedCostUsd: record.providerReportedCostUsd }),
      ...(record.pricing === undefined ? {} : {
        calculatedCostUsd: record.pricing.calculatedCostUsd,
        calculatedCostComplete: true,
        pricing: {
          normalizationVersion: 'oracle-v1',
          catalogVersion: record.pricing.catalogVersion,
          currency: 'USD',
          inputUsdPerMillionTokens: rates?.inputTokensUsdPerMillion ?? null,
          outputUsdPerMillionTokens: rates?.outputTokensUsdPerMillion ?? null,
          cacheReadUsdPerMillionTokens: rates?.cacheReadTokensUsdPerMillion ?? null,
          cacheWriteUsdPerMillionTokens: rates?.cacheWriteTokensUsdPerMillion ?? null,
        },
      }),
    };
    const branchId = record.branchId
      ? this.scopedBranchId(context, record.branchId)
      : undefined;
    return this.submit(
      context,
      'providerCall',
      record.invocationId,
      'providerSettlement',
      `provider-settlement:${record.invocationId}`,
      // This required envelope time must be stable across exact redelivery.
      // Zero denotes unavailable source time here; nullable settledAtMs above
      // remains the sole calendar authority. Recorder receipt time is separate.
      timestamp(record.endedAt, 0),
      fields,
      {
        invocationId: record.invocationId,
        toolCallId: record.parentToolId ?? undefined,
        ...(branchId ? { branchId } : {}),
      },
    );
  }

  captureBranchEdge(
    context: AnalyticsSessionContext,
    sourceEntryId: string,
    parentSourceEntryId: string | null | undefined,
    observedAtMs: number,
    evidence: 'durable' | 'snapshot' = 'durable',
  ): AnalyticsCaptureStatus {
    const branchId = this.scopedBranchId(context, sourceEntryId);
    const parentBranchId = parentSourceEntryId === undefined
      ? undefined
      : parentSourceEntryId === null
        ? null
        : this.scopedBranchId(context, parentSourceEntryId);
    const fields: AnalyticsBranchFields = {
      branchId,
      ...(parentBranchId !== undefined ? { parentBranchId } : {}),
      sourceEntryId,
    };
    return this.submit(
      context,
      'branch',
      branchId,
      'observation',
      `branch-edge:${evidence}:${branchId}`,
      observedAtMs,
      fields,
      { branchId },
    );
  }

  captureBranchSelection(
    context: AnalyticsSessionContext,
    sourceEntryId: string,
    sourceSelectionId: string,
    observedAtMs: number,
  ): AnalyticsCaptureStatus {
    const branchId = this.scopedBranchId(context, sourceEntryId);
    const fields: AnalyticsBranchFields = { branchId, sourceSelectionId, sourceEntryId };
    return this.submit(
      context,
      'branch',
      branchId,
      'phase',
      `branch-selection:${sourceSelectionId}`,
      observedAtMs,
      fields,
      { branchId },
    );
  }

  captureCopy(
    destination: AnalyticsSessionContext,
    source: AnalyticsSessionContext,
    sourceEntryId: string | undefined,
    operationId: string,
    observedAtMs: number,
  ): AnalyticsCaptureStatus {
    if (!destination.sessionId?.trim() || !source.sessionId?.trim()) return 'rejected';
    const fields: AnalyticsCopyFields = {
      copySessionId: destination.sessionId.trim(),
      sourceSessionId: source.sessionId.trim(),
      sourceBranchId: sourceEntryId ? this.scopedBranchId(source, sourceEntryId) : null,
      operationId,
      inheritanceCoverage: sourceEntryId ? 'known' : 'unknown',
    };
    return this.submit(
      destination,
      'copy',
      destination.sessionId.trim(),
      'observation',
      `session-copy:${operationId}`,
      observedAtMs,
      fields,
    );
  }

  captureExecution(
    context: AnalyticsSessionContext,
    executionId: string,
    phase: 'begin' | 'phase' | 'end' | 'transcriptEvidence',
    sourceKey: string,
    observedAtMs: number,
    fields: AnalyticsExecutionFields,
  ): AnalyticsCaptureStatus {
    return this.submit(context, 'execution', executionId, phase, sourceKey, observedAtMs, fields, {
      executionId,
      toolCallId: fields.parentToolCallId ?? undefined,
    });
  }

  /** Capture the latest provider context footprint as a point observation.
   * This is deliberately separate from provider settlements: input tokens are
   * state at one observed boundary and must never be summed as historical
   * usage. Equal values at different source observations remain distinct;
   * replay uses the original source identity and timestamp. */
  captureContextObservation(
    context: AnalyticsSessionContext,
    observationId: string,
    observedAtMs: number,
    fields: Omit<AnalyticsContextObservationFields, 'observedAtMs'>,
  ): AnalyticsCaptureStatus {
    const subjectId = analyticsRootSessionId(context.sessionId, context.sessionPath);
    if (!observationId.trim()) return 'rejected';
    const sourceKey = `context-observation:${createHash('sha256').update(JSON.stringify([
      subjectId, observationId,
    ])).digest('hex')}`;
    const observationFields: AnalyticsContextObservationFields = {
      ...fields,
      observedAtMs,
    };
    return this.submit(
      context,
      'contextObservation',
      `context:${subjectId}`,
      'observation',
      sourceKey,
      observedAtMs,
      observationFields,
    );
  }

  /** Attach measured latency facets to one canonical assistant execution.
   * Provider/header/full-operation boundaries remain independently nullable;
   * callers must supply only timestamps measured by their owning source. */
  captureLatency(
    context: AnalyticsSessionContext,
    executionId: string,
    turnId: string | undefined,
    sourceKey: string,
    observedAtMs: number,
    fields: AnalyticsLatencyFields,
  ): AnalyticsCaptureStatus {
    const normalizedExecutionId = executionId.trim();
    if (!normalizedExecutionId || !sourceKey.trim()) return 'rejected';
    return this.submit(
      context,
      'execution',
      normalizedExecutionId,
      'phase',
      sourceKey,
      observedAtMs,
      {
        operationId: normalizedExecutionId,
        ...(context.runId ? { runId: context.runId } : {}),
        ...(turnId?.trim() ? { turnId: turnId.trim() } : {}),
        operationKind: 'assistant-turn',
        source: 'host-latency',
        latency: fields,
      },
      { executionId: normalizedExecutionId },
    );
  }

  captureTool(
    context: AnalyticsSessionContext,
    toolCall: ToolCall,
    phase: 'begin' | 'end' | 'transcriptEvidence',
    sourceKey: string,
    observedAtMs: number,
  ): AnalyticsCaptureStatus {
    const sessionIdentity = context.sessionId?.trim()
      || analyticsPendingOperationId(context.operationId, context.sessionPath);
    const scopedToolCallId = canonicalAnalyticsToolEntityId(sessionIdentity, toolCall.id);
    const payloadId = `${scopedToolCallId}:${phase}`;
    const fields: AnalyticsToolCallFields = {
      toolCallId: scopedToolCallId,
      toolDefinitionId: toolCall.name,
      startedAtMs: toolCall.startedAt ?? null,
      executionEndedAtMs: toolCall.startedAt !== undefined && toolCall.durationMs !== undefined
        ? toolCall.startedAt + toolCall.durationMs : null,
      outcome: toolCall.status,
      ...(phase === 'begin' ? { argumentsPayloadId: payloadId } : { resultPayloadId: payloadId }),
      durableEntryId: toolCall.durableEntryId ?? null,
    };
    const scopedSourceKey = `${scopedToolCallId}:${sourceKey}`;
    const factStatus = this.submit(context, 'toolCall', scopedToolCallId, phase, scopedSourceKey, observedAtMs, fields, {
      toolCallId: scopedToolCallId,
    });
    if (!this.enabled || !this.options.detailSink) return factStatus;
    const stableSessionId = context.sessionId?.trim() || undefined;
    try {
      const detail = {
        phase,
        toolDefinitionId: toolCall.name,
        input: toolCall.input,
        argumentsText: toolCall.argumentsText,
        result: toolCall.result,
        detailRef: toolCall.detailRef,
        resultObserved: toolCall.result !== undefined,
        status: toolCall.status,
      };
      // Reject an already over-capacity rich value before making sanitized
      // and encoded copies. Ownership transfer still performs its final check.
      this.options.detailSink.preflightDetail?.(detail);
      this.options.detailSink.submitDetail({
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        generationId: this.options.generationId!,
        stableOriginId: `${this.stableOriginId}:detail:${scopedToolCallId}`,
        producerKind: 'host',
        producer: {
          buildId: this.options.buildId,
          processId: process.pid,
          processGeneration: this.options.processGeneration,
        },
        payloadId,
        sourceKey: `${scopedSourceKey}:detail`,
        observedAtMs,
        captureSubject: stableSessionId
          ? { kind: 'session', rootSessionId: stableSessionId }
          : { kind: 'pendingCreate', operationId: analyticsPendingOperationId(context.operationId, context.sessionPath) },
        mediaType: 'application/x-pie-tool-observation',
        encoding: 'node-v8',
        complete: true,
        bytes: serialize(sanitizeAnalyticsDetail(detail)),
        metadata: {
          parentToolCallId: scopedToolCallId,
          outcome: toolCall.status,
          captureStage: phase,
          sourceVersion: 'tool-call-v1',
        },
      });
      return factStatus === 'rejected' ? 'rejected' : 'submitted';
    } catch (error) {
      this.options.onDetailCaptureError?.(
        error instanceof Error ? error : new Error(String(error)),
        payloadId,
      );
      return 'rejected';
    }
  }

  captureActivity(context: AnalyticsSessionContext, interval: ActivityIntervalRecord): AnalyticsCaptureStatus {
    const startedAtMs = optionalTimestamp(interval.startedAt);
    const hasEndEvidence = interval.endedAt !== undefined;
    const endedAtMs = optionalTimestamp(interval.endedAt);
    const orderedBounds = startedAtMs !== null && endedAtMs !== null && endedAtMs >= startedAtMs;
    const fields: AnalyticsActivitySpanFields = {
      spanId: interval.intervalId,
      kind: interval.kind,
      startedAtMs,
      endedAtMs,
      durationMs: orderedBounds ? endedAtMs - startedAtMs : null,
      clockDomain: 'wall-clock-utc',
      coverage: startedAtMs !== null && (!hasEndEvidence || orderedBounds) ? 'observed' : 'unknown',
    };
    return this.submit(context, 'activitySpan', interval.intervalId, hasEndEvidence ? 'end' : 'begin',
      `activity:${interval.intervalId}:${hasEndEvidence ? 'end' : 'begin'}`,
      endedAtMs ?? startedAtMs ?? 0, fields, {
        invocationId: interval.invocationId ?? undefined,
        toolCallId: interval.toolId ?? undefined,
      });
  }

  /** Retry wait and full retry episode are different measured intervals. A
   * terminal episode duration cannot fill a missing provider-attempt wait. */
  captureRetryTiming(
    context: AnalyticsSessionContext,
    retryId: string,
    timing: {
      startedAt?: number;
      providerAttemptStartedAt?: number;
      endedAt?: number;
      measuredDelayMs?: number;
      durationMs: number;
    },
  ): AnalyticsCaptureStatus {
    if (!retryId.trim()) return 'rejected';
    const startedAtMs = optionalTimestamp(timing.startedAt);
    const endedAtMs = optionalTimestamp(timing.endedAt);
    const waitEndedAtMs = optionalTimestamp(timing.providerAttemptStartedAt);
    const observedAtMs = endedAtMs ?? waitEndedAtMs ?? startedAtMs ?? 0;
    const subjectId = analyticsRootSessionId(context.sessionId, context.sessionPath);
    const retryKey = createHash('sha256').update(JSON.stringify([subjectId, retryId])).digest('hex');
    let status: AnalyticsCaptureStatus = 'disabled';
    for (const [kind, end, duration] of [
      ['retry_wait', waitEndedAtMs, timing.measuredDelayMs],
      ['retry_episode', endedAtMs, timing.durationMs],
    ] as const) {
      const reversed = startedAtMs !== null && end !== null && end < startedAtMs;
      const durationMs = !reversed && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? duration : null;
      const spanId = `activity:${kind}:${retryKey}`;
      const result = this.submit(context, 'activitySpan', spanId, 'end', `${spanId}:end`, observedAtMs, {
        spanId,
        kind,
        startedAtMs,
        endedAtMs: end,
        durationMs,
        clockDomain: 'wall-clock-utc',
        coverage: !reversed && startedAtMs !== null && end !== null && durationMs !== null ? 'observed' : 'unknown',
      } satisfies AnalyticsActivitySpanFields);
      if (status !== 'rejected') status = result;
    }
    return status;
  }

  captureFeature(
    context: AnalyticsSessionContext,
    entityKey: string,
    sourceKey: string,
    observedAtMs: number,
    fields: AnalyticsFeatureObservationFields,
  ): AnalyticsCaptureStatus {
    return this.submit(context, 'featureObservation', entityKey, 'observation', sourceKey, observedAtMs, fields);
  }

  private submit<Fields extends object>(
    context: AnalyticsSessionContext,
    entityKind: AnalyticsEntityKind,
    entityKey: string,
    observationKind: AnalyticsObservationKind,
    sourceKey: string,
    observedAtMs: number,
    fields: Fields,
    scope: Partial<AnalyticsObservation['scope']> = {},
  ): AnalyticsCaptureStatus {
    if (!this.enabled) return 'disabled';
    const stableSessionId = context.sessionId?.trim() || undefined;
    const pendingOperationId = analyticsPendingOperationId(context.operationId, context.sessionPath);
    const base = {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      generationId: this.options.generationId!,
      producerKind: 'host',
      stableOriginId: this.stableOriginId,
      sourceSequence: this.sourceSequence(sourceKey),
      sourceKey,
      entityKind,
      entityKey,
      observationKind,
      observedAtMs,
      scope: {
        workspaceCoverage: 'known' as const,
        workspaceId: this.options.workspaceId,
        ...(stableSessionId ? { rootSessionId: stableSessionId } : {}),
        sessionId: stableSessionId,
        executionId: context.operationId ?? context.runId ?? undefined,
        ...scope,
      },
      captureSubject: stableSessionId
        ? { kind: 'session' as const, rootSessionId: stableSessionId }
        : { kind: 'pendingCreate' as const, operationId: pendingOperationId },
      producer: {
        buildId: this.options.buildId,
        processId: process.pid,
        processGeneration: this.options.processGeneration,
      },
      fields,
    };
    const observation: AnalyticsObservation<Fields> = {
      ...base,
      idempotencyKey: deriveAnalyticsIdempotencyKey(base),
    };
    try {
      const submitted = this.options.sink!.submit(observation);
      if (submitted) {
        void submitted.catch((error: unknown) => this.report(error, observation));
      }
      return 'submitted';
    } catch (error) {
      this.report(error, observation);
      return 'rejected';
    }
  }

  private sourceSequence(sourceKey: string): string {
    const existing = this.sequenceBySourceKey.get(sourceKey);
    if (existing) {
      // Refresh insertion order so the bounded cache behaves as an LRU.
      this.sequenceBySourceKey.delete(sourceKey);
      this.sequenceBySourceKey.set(sourceKey, existing);
      return existing;
    }
    const assigned = (++this.sequence).toString();
    const maximum = Math.max(0, Math.trunc(this.options.maxTrackedSourceKeys ?? 4_096));
    if (maximum > 0) {
      this.sequenceBySourceKey.set(sourceKey, assigned);
      while (this.sequenceBySourceKey.size > maximum) {
        const oldest = this.sequenceBySourceKey.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.sequenceBySourceKey.delete(oldest);
      }
    }
    return assigned;
  }

  private report(error: unknown, observation: AnalyticsObservation<object>): void {
    this.options.onCaptureError?.(
      error instanceof Error ? error : new Error(String(error)),
      observation,
    );
  }
}
