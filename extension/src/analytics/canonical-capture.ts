import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsActivitySpanFields,
  type AnalyticsDetailSink,
  type AnalyticsEntityKind,
  type AnalyticsExecutionFields,
  type AnalyticsFeatureObservationFields,
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

export type AnalyticsAuthority = 'legacy' | 'canonical';
export type AnalyticsCaptureStatus = 'disabled' | 'submitted' | 'rejected';

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
  onCaptureError?: (error: Error, observation: AnalyticsObservation) => void;
  onDetailCaptureError?: (error: Error, payloadId: string) => void;
}

export interface AnalyticsSessionContext {
  sessionId: string | null;
  sessionPath: string;
  runId?: string | null;
  operationId?: string | null;
}

function timestamp(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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
    pendingOperationId?: string,
  ): Promise<void> {
    if (!this.enabled || privacyMode === 'off') return;
    if (!this.options.lifecycleSink) throw new Error('Canonical deletion sink is not configured.');
    await this.options.lifecycleSink.deleteSession(
      rootSessionId,
      `private-close:${rootSessionId}`,
      observedAtMs,
      pendingOperationId?.trim() || undefined,
    );
  }

  captureProviderSettlement(record: BillableInvocationRecord): AnalyticsCaptureStatus {
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
      startedAtMs: timestamp(record.startedAt, 0),
      endedAtMs: timestamp(record.endedAt, 0),
      settledAtMs: timestamp(record.endedAt, 0),
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
    return this.submit(
      context,
      'providerCall',
      record.invocationId,
      'providerSettlement',
      `provider-settlement:${record.invocationId}`,
      timestamp(record.endedAt, Date.now()),
      fields,
      { invocationId: record.invocationId, toolCallId: record.parentToolId ?? undefined },
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

  captureTool(
    context: AnalyticsSessionContext,
    toolCall: ToolCall,
    phase: 'begin' | 'end' | 'transcriptEvidence',
    sourceKey: string,
    observedAtMs: number,
  ): AnalyticsCaptureStatus {
    const sessionIdentity = context.sessionId?.trim()
      || analyticsPendingOperationId(context.operationId, context.sessionPath);
    const scopedToolCallId = `tool:${createHash('sha256').update(JSON.stringify([
      sessionIdentity,
      toolCall.id,
    ])).digest('hex')}`;
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
        bytes: serialize(sanitizeAnalyticsDetail({
          phase,
          toolDefinitionId: toolCall.name,
          input: toolCall.input,
          argumentsText: toolCall.argumentsText,
          result: toolCall.result,
          detailRef: toolCall.detailRef,
          resultObserved: toolCall.result !== undefined,
          status: toolCall.status,
        })),
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
    const startedAtMs = timestamp(interval.startedAt, 0);
    const endedAtMs = interval.endedAt ? timestamp(interval.endedAt, startedAtMs) : null;
    const fields: AnalyticsActivitySpanFields = {
      spanId: interval.intervalId,
      kind: interval.kind,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs === null ? null : Math.max(0, endedAtMs - startedAtMs),
      clockDomain: 'wall-clock-utc',
      coverage: 'observed',
    };
    return this.submit(context, 'activitySpan', interval.intervalId, interval.endedAt ? 'end' : 'begin',
      `activity:${interval.intervalId}:${interval.endedAt ? 'end' : 'begin'}`,
      endedAtMs ?? startedAtMs, fields, {
        invocationId: interval.invocationId ?? undefined,
        toolCallId: interval.toolId ?? undefined,
      });
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
      const sinkObservation = observation as unknown as AnalyticsObservation;
      const submitted = this.options.sink!.submit(sinkObservation);
      if (submitted && typeof (submitted as Promise<void>).catch === 'function') {
        void (submitted as Promise<void>).catch((error: unknown) => this.report(error, sinkObservation));
      }
      return 'submitted';
    } catch (error) {
      this.report(error, observation as unknown as AnalyticsObservation);
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

  private report(error: unknown, observation: AnalyticsObservation): void {
    this.options.onCaptureError?.(
      error instanceof Error ? error : new Error(String(error)),
      observation,
    );
  }
}
