import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsCaptureSubject,
  type AnalyticsDetailCapture,
  type AnalyticsDetailSink,
  type AnalyticsExecutionFields,
  type AnalyticsObservation,
  type AnalyticsProducerIdentity,
  type AnalyticsProviderCallFields,
  type AnalyticsSink,
  type Int64Value,
} from '../../../shared/analytics/contracts.js';
import { redactSensitiveText, sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import type {
  SingleResult,
  SubagentAnalyticsCaptureReceipt,
  SubagentProviderInvocationRecord,
} from '../types.js';
import { recordRuntimeTrace } from './runtime-trace.js';

export interface SubagentAnalyticsCaptureContext {
  generationId: string;
  captureSubject: AnalyticsCaptureSubject;
  workspaceId?: string;
  producer?: AnalyticsProducerIdentity;
  sink: AnalyticsDetailSink;
  /** Optional canonical fact transport. Its synchronous return transfers queue
   * ownership but is not a recorder durability acknowledgement. */
  factSink?: AnalyticsSink;
  /** Read only acknowledgement seams. Values are sampled before the terminal
   * result is sealed; their absence remains explicit pending coverage. */
  readFactAcknowledgement?: (generationId: string, stableOriginId: string) => Int64Value | undefined;
  isDetailComplete?: (payloadId: string) => boolean;
  /** Host-injected mapping from the SDK tool-call ID to the canonical parent
   * tool entity. Absent keeps compatibility identity until P7 wiring. */
  resolveParentToolEntityId?: (toolCallId: string) => string;
}

function stableCaptureOrigin(
  generationId: string,
  subject: AnalyticsCaptureSubject,
  parentToolCallId: string | undefined,
  attemptId: string,
): string {
  const subjectIdentity = subject.kind === 'session'
    ? subject.rootSessionId
    : subject.kind === 'pendingCreate'
      ? subject.operationId
      : subject.hostId;
  const digest = createHash('sha256').update(JSON.stringify([
    generationId,
    subject.kind,
    subjectIdentity,
    parentToolCallId ?? null,
    attemptId,
  ])).digest('hex');
  return `subagent-origin:${digest}`;
}

function canonicalProviderInvocationId(stableOriginId: string, invocationId: string): string {
  return `subagent-provider:${createHash('sha256').update(JSON.stringify([
    stableOriginId,
    invocationId,
  ])).digest('hex')}`;
}

function terminalDetailValue(result: SingleResult): SingleResult {
  const value = { ...result };
  delete value.analyticsCaptureStatus;
  delete value.analyticsCaptureError;
  delete value.analyticsCaptureReceipt;
  return value;
}

function captureScope(
  context: SubagentAnalyticsCaptureContext,
  executionId: string,
  childId: string | undefined,
  parentToolCallId: string | undefined,
) {
  return {
    workspaceCoverage: context.workspaceId ? 'known' as const : 'unknown' as const,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.captureSubject.kind === 'session'
      ? { rootSessionId: context.captureSubject.rootSessionId }
      : {}),
    ...(childId ? { sessionId: childId } : {}),
    executionId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function observation<Fields extends object>(options: {
  context: SubagentAnalyticsCaptureContext;
  stableOriginId: string;
  sourceSequence: number;
  sourceKey: string;
  entityKind: AnalyticsObservation['entityKind'];
  entityKey: string;
  observationKind: AnalyticsObservation['observationKind'];
  observedAtMs: number;
  executionId: string;
  childId?: string;
  parentToolCallId?: string;
  invocationId?: string;
  fields: Fields;
}): AnalyticsObservation<Fields> {
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.context.generationId,
    producerKind: 'subagent' as const,
    stableOriginId: options.stableOriginId,
    sourceSequence: options.sourceSequence,
    sourceKey: options.sourceKey,
    entityKind: options.entityKind,
    entityKey: options.entityKey,
    observationKind: options.observationKind,
    observedAtMs: options.observedAtMs,
    scope: {
      ...captureScope(options.context, options.executionId, options.childId, options.parentToolCallId),
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    },
    captureSubject: options.context.captureSubject,
    producer: options.context.producer ?? {
      buildId: 'pie-subagent-capture-v2',
      processId: process.pid,
    },
    fields: options.fields,
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function acknowledgedSequence(
  context: SubagentAnalyticsCaptureContext,
  stableOriginId: string,
): number | string | undefined {
  const value = context.readFactAcknowledgement?.(context.generationId, stableOriginId);
  return typeof value === 'bigint' ? value.toString() : value;
}

function providerObservation(
  context: SubagentAnalyticsCaptureContext,
  stableOriginId: string,
  executionId: string,
  childId: string | undefined,
  parentToolCallId: string | undefined,
  invocation: SubagentProviderInvocationRecord,
  sourceSequence: number,
): AnalyticsObservation<AnalyticsProviderCallFields> {
  const canonicalInvocationId = canonicalProviderInvocationId(stableOriginId, invocation.invocationId);
  invocation.canonicalInvocationId = canonicalInvocationId;
  const usage = invocation.usage;
  const completeChannels = usage !== undefined
    && typeof usage.input === 'number'
    && typeof usage.output === 'number'
    && typeof usage.cacheRead === 'number'
    && typeof usage.cacheWrite === 'number';
  const fields: AnalyticsProviderCallFields = {
    invocationId: canonicalInvocationId,
    sourceId: invocation.invocationId,
    purpose: 'subagent',
    provider: invocation.provider,
    dispatchedModel: invocation.model,
    attemptId: invocation.attemptId,
    startedAtMs: invocation.startedAt,
    endedAtMs: invocation.completedAt,
    settledAtMs: invocation.completedAt,
    outcome: invocation.outcome,
    coverage: completeChannels ? 'known' : 'unknown',
    ...(usage?.input === undefined ? {} : { inputTokens: usage.input }),
    ...(usage?.output === undefined ? {} : { outputTokens: usage.output }),
    ...(usage?.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead }),
    ...(usage?.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite }),
    ...(completeChannels ? {
      providerTotalTokens: usage.input! + usage.output! + usage.cacheRead! + usage.cacheWrite!,
    } : {}),
    ...(usage?.cost === undefined ? {} : { reportedCostUsd: usage.cost }),
    inputIncludesCache: false,
    outputIncludesReasoning: true,
    cacheChannelsOmittedAsZero: false,
  };
  return observation({
    context,
    stableOriginId,
    sourceSequence,
    sourceKey: `${stableOriginId}:provider:${invocation.invocationId}`,
    entityKind: 'providerCall',
    entityKey: canonicalInvocationId,
    observationKind: 'providerSettlement',
    observedAtMs: invocation.completedAt,
    executionId,
    childId,
    parentToolCallId,
    invocationId: canonicalInvocationId,
    fields,
  });
}

export type SubagentCaptureStatus = 'disabled' | 'submitted' | 'rejected';

/** Snapshot one terminal attempt into independently-owned bytes and submit the
 * attempt/provider facts under the same stable producer origin. Detail and fact
 * handoffs are independent: losing one never fabricates or suppresses the
 * other, and neither blocks child return or failover. */
export function captureSubagentTerminalResult(
  result: SingleResult,
  context: SubagentAnalyticsCaptureContext | undefined,
  parentToolCallId: string | undefined,
): SubagentCaptureStatus {
  if (!context) return 'disabled';

  const startedAt = performance.now();
  const attemptId = result.attemptId;
  const childId = result.childId;
  const identity = attemptId ?? childId;
  if (!identity) {
    result.analyticsCaptureError = 'Subagent terminal capture requires an attempt or child identity.';
    return 'rejected';
  }
  const stableOriginId = stableCaptureOrigin(
    context.generationId,
    context.captureSubject,
    parentToolCallId,
    identity,
  );
  const parentToolEntityId = parentToolCallId
    ? context.resolveParentToolEntityId?.(parentToolCallId) ?? parentToolCallId
    : undefined;
  const executionId = `${stableOriginId}:execution`;
  const detailPayloadId = `${stableOriginId}:terminal`;
  const sealedReceipt = result.analyticsCaptureReceipt?.generationId === context.generationId
    && result.analyticsCaptureReceipt.stableOriginId === stableOriginId
    && result.analyticsCaptureReceipt.executionId === executionId
    ? result.analyticsCaptureReceipt
    : undefined;
  const producer = context.producer ?? {
    buildId: 'pie-subagent-capture-v2',
    processId: process.pid,
  };
  for (const invocation of result.providerInvocations ?? []) {
    invocation.canonicalInvocationId = canonicalProviderInvocationId(stableOriginId, invocation.invocationId);
  }
  const terminalObservedAt = result.completedAt ?? result.startedAt ?? 0;
  let bytes: Uint8Array | undefined;
  let detailStatus: SubagentCaptureStatus = 'rejected';
  let detailError: string | undefined;
  try {
    const detailValue = terminalDetailValue(result);
    context.sink.preflightDetail?.(detailValue);
    bytes = serialize(sanitizeAnalyticsDetail(detailValue));
    const capture: AnalyticsDetailCapture = {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      generationId: context.generationId,
      stableOriginId,
      producerKind: 'subagent',
      producer,
      payloadId: detailPayloadId,
      sourceKey: detailPayloadId,
      observedAtMs: terminalObservedAt,
      captureSubject: context.captureSubject,
      mediaType: 'application/x-pie-subagent-result',
      encoding: 'node-v8',
      complete: true,
      bytes,
      metadata: {
        ...(childId ? { childId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(parentToolEntityId ? { parentToolCallId: parentToolEntityId } : {}),
        ...(result.stopReason ? { outcome: result.stopReason } : {}),
        captureStage: 'terminal',
        sourceVersion: 'subagent-terminal-v2',
      },
    };
    context.sink.submitDetail(capture);
    detailStatus = 'submitted';
  } catch (error) {
    detailError = redactSensitiveText(error instanceof Error ? error.message : String(error));
  }

  let factStatus: SubagentCaptureStatus = context.factSink ? 'submitted' : 'disabled';
  let lastSubmittedSequence = 0;
  let factError: string | undefined;
  if (context.factSink) {
    const observedEnd = terminalObservedAt;
    try {
      const begin = observation<AnalyticsExecutionFields>({
        context,
        stableOriginId,
        sourceSequence: 1,
        sourceKey: `${stableOriginId}:execution:begin`,
        entityKind: 'execution',
        entityKey: executionId,
        observationKind: 'begin',
        observedAtMs: result.startedAt ?? observedEnd,
        executionId,
        childId,
        parentToolCallId: parentToolEntityId,
        fields: {
          childId,
          attemptId,
          parentToolCallId: parentToolEntityId,
          operationKind: 'subagent-attempt',
          source: 'subagent',
          startedAtMs: result.startedAt ?? null,
        },
      });
      context.factSink.submit(begin);
      lastSubmittedSequence = 1;
      let sequence = 2;
      for (const invocation of result.providerInvocations ?? []) {
        context.factSink.submit(providerObservation(
          context,
          stableOriginId,
          executionId,
          childId,
          parentToolEntityId,
          invocation,
          sequence,
        ));
        lastSubmittedSequence = sequence;
        sequence += 1;
      }
      const providerResponseObserved = (result.providerInvocations?.length ?? 0) > 0;
      const end = observation<AnalyticsExecutionFields>({
        context,
        stableOriginId,
        sourceSequence: sequence,
        sourceKey: `${stableOriginId}:execution:end`,
        entityKind: 'execution',
        entityKey: executionId,
        observationKind: 'end',
        observedAtMs: observedEnd,
        executionId,
        childId,
        parentToolCallId: parentToolEntityId,
        fields: {
          childId,
          attemptId,
          parentToolCallId: parentToolEntityId,
          operationKind: 'subagent-attempt',
          source: 'subagent',
          endedAtMs: result.completedAt ?? null,
          outcome: result.exitCode === 0 ? 'succeeded'
            : result.stopReason === 'aborted' ? 'aborted' : 'failed',
          ...(!providerResponseObserved ? {
            captureIncomplete: true,
            reason: 'The dispatched child attempt ended without an observable provider response.',
          } : {}),
          lastSubmittedSequence: sequence,
          terminalDetailPayloadId: detailPayloadId,
        },
      });
      context.factSink.submit(end);
      lastSubmittedSequence = sequence;
    } catch (error) {
      factStatus = 'rejected';
      factError = redactSensitiveText(error instanceof Error ? error.message : String(error));
    }
  }

  const currentAcknowledgement = sealedReceipt?.lastAcknowledgedSequence
    ?? acknowledgedSequence(context, stableOriginId);
  const receipt: SubagentAnalyticsCaptureReceipt = {
    factStatus: sealedReceipt?.factStatus ?? factStatus,
    generationId: context.generationId,
    stableOriginId,
    executionId,
    attemptId: identity,
    terminalDetailPayloadId: detailPayloadId,
    lastSubmittedSequence,
    ...(currentAcknowledgement === undefined ? {} : {
      lastAcknowledgedSequence: currentAcknowledgement,
    }),
    terminalDetailComplete: sealedReceipt?.terminalDetailComplete
      ?? context.isDetailComplete?.(detailPayloadId) === true,
  };
  result.analyticsCaptureReceipt = receipt;
  const errors = [detailError, factError].filter((value): value is string => !!value);
  if (errors.length > 0) result.analyticsCaptureError = errors.join('; ');

  recordRuntimeTrace({
    phase: 'clone',
    durationMs: Math.max(0, performance.now() - startedAt),
    sourcePayloadBytes: bytes?.byteLength,
    producedPayloadBytes: bytes?.byteLength,
    childCount: 1,
    messageCount: result.messages.length,
    payloadClass: 'detail_terminal',
    detailDelivery: detailStatus === 'submitted' ? 'terminal' : 'none',
    identifiers: {
      attempt: attemptId,
      tool: parentToolCallId,
    },
  });
  return detailStatus;
}
