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
  releaseAcknowledgementInterest?: (generationId: string, stableOriginId: string, payloadId: string) => void;
  /** Host-injected mapping from the SDK tool-call ID to the canonical parent
   * tool entity. Absent keeps compatibility identity until P7 wiring. */
  resolveParentToolEntityId?: (toolCallId: string) => string;
}

export interface SubagentAnalyticsAttemptCaptureState {
  readonly attemptId: string;
  readonly childId: string;
  readonly parentToolCallId?: string;
  readonly startedAtMs: number;
  factStatus: SubagentCaptureStatus;
  lastSubmittedSequence: number;
  error?: string;
  readonly providerRequests: Array<{
    invocationId: string;
    canonicalInvocationId: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    startedAtMs: number;
  }>;
}

export interface SubagentProviderDispatch {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  observedAtMs: number;
}

const ATTEMPT_CAPTURE_STATE = Symbol.for('pie.subagent.analytics-attempt-capture-state.v1');

/** Attach attempt-local mutable capture state to the AsyncLocalStorage value
 * without making it part of result lineage or any serialized payload. The
 * global symbol is shared by the independently loaded nested extension copy. */
export function bindSubagentAnalyticsAttemptState(
  runtimeContext: object,
  state: Pick<SubagentAnalyticsAttemptCaptureState, 'attemptId' | 'childId' | 'parentToolCallId' | 'startedAtMs'>,
): SubagentAnalyticsAttemptCaptureState {
  const captureState: SubagentAnalyticsAttemptCaptureState = {
    ...state,
    factStatus: 'disabled',
    lastSubmittedSequence: 0,
    providerRequests: [],
  };
  Object.defineProperty(runtimeContext, ATTEMPT_CAPTURE_STATE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: captureState,
  });
  return captureState;
}

export function readSubagentAnalyticsAttemptState(
  runtimeContext: object,
): SubagentAnalyticsAttemptCaptureState | undefined {
  return (runtimeContext as { [ATTEMPT_CAPTURE_STATE]?: SubagentAnalyticsAttemptCaptureState })[ATTEMPT_CAPTURE_STATE];
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
    ...(invocation.provider ? { provider: invocation.provider } : {}),
    ...(invocation.model ? { dispatchedModel: invocation.model } : {}),
    ...(invocation.attemptId ? { attemptId: invocation.attemptId } : {}),
    ...(invocation.startedAt === undefined ? {} : { startedAtMs: invocation.startedAt }),
    ...(invocation.completedAt === undefined ? {} : {
      endedAtMs: invocation.completedAt,
      settledAtMs: invocation.completedAt,
    }),
    ...(invocation.outcome ? { outcome: invocation.outcome } : {}),
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

function captureError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function observeAsynchronousSubmission(
  result: void | Promise<void>,
  state: SubagentAnalyticsAttemptCaptureState,
): void {
  if (!result || typeof (result as Promise<void>).then !== 'function') return;
  void Promise.resolve(result).catch((error) => {
    state.factStatus = 'rejected';
    state.error = captureError(error);
  });
}

function submitPredispatchFact<Fields extends object>(
  context: SubagentAnalyticsCaptureContext,
  state: SubagentAnalyticsAttemptCaptureState,
  value: AnalyticsObservation<Fields>,
): boolean {
  if (!context.factSink) {
    state.factStatus = 'disabled';
    return false;
  }
  if (state.factStatus === 'rejected') return false;
  try {
    const submitted = context.factSink.submit(value);
    state.factStatus = 'submitted';
    state.lastSubmittedSequence = Number(value.sourceSequence);
    observeAsynchronousSubmission(submitted, state);
    return true;
  } catch (error) {
    state.factStatus = 'rejected';
    state.error = captureError(error);
    return false;
  }
}

/** Observe one real SDK provider request at `before_provider_request`. This
 * callback is deliberately synchronous: recorder queue ownership is handed
 * off if available, but the provider request never waits for acknowledgement
 * or persistence. A low-level adapter retry inside the same request is outside
 * this supported hook and remains explicit unknown coverage. */
export function captureSubagentProviderDispatch(
  context: SubagentAnalyticsCaptureContext | undefined,
  state: SubagentAnalyticsAttemptCaptureState | undefined,
  dispatch: SubagentProviderDispatch,
): void {
  if (!context || !state) return;

  const stableOriginId = stableCaptureOrigin(
    context.generationId,
    context.captureSubject,
    state.parentToolCallId,
    state.attemptId,
  );
  const parentToolEntityId = state.parentToolCallId
    ? context.resolveParentToolEntityId?.(state.parentToolCallId) ?? state.parentToolCallId
    : undefined;
  const executionId = `${stableOriginId}:execution`;

  if (state.providerRequests.length === 0 && state.factStatus !== 'rejected') {
    submitPredispatchFact(context, state, observation<AnalyticsExecutionFields>({
      context,
      stableOriginId,
      sourceSequence: 1,
      sourceKey: `${stableOriginId}:execution:begin`,
      entityKind: 'execution',
      entityKey: executionId,
      observationKind: 'begin',
      observedAtMs: state.startedAtMs,
      executionId,
      childId: state.childId,
      parentToolCallId: parentToolEntityId,
      fields: {
        ...(state.childId ? { childId: state.childId } : {}),
        attemptId: state.attemptId,
        ...(parentToolEntityId ? { parentToolCallId: parentToolEntityId } : {}),
        operationKind: 'subagent-attempt',
        source: 'subagent',
        startedAtMs: state.startedAtMs,
      },
    }));
  }

  const ordinal = state.providerRequests.length + 1;
  const invocationId = `${state.attemptId}:provider:${ordinal}`;
  const canonicalInvocationId = canonicalProviderInvocationId(stableOriginId, invocationId);
  state.providerRequests.push({
    invocationId,
    canonicalInvocationId,
    ...(dispatch.provider ? { provider: dispatch.provider } : {}),
    ...(dispatch.model ? { model: dispatch.model } : {}),
    ...(dispatch.thinkingLevel ? { thinkingLevel: dispatch.thinkingLevel } : {}),
    startedAtMs: dispatch.observedAtMs,
  });
  if (state.factStatus === 'rejected') return;

  const sourceSequence = ordinal + 1;
  submitPredispatchFact(context, state, observation<AnalyticsProviderCallFields>({
    context,
    stableOriginId,
    sourceSequence,
    sourceKey: `${stableOriginId}:provider:${invocationId}:dispatch`,
    entityKind: 'providerCall',
    entityKey: canonicalInvocationId,
    observationKind: 'begin',
    observedAtMs: dispatch.observedAtMs,
    executionId,
    childId: state.childId,
    parentToolCallId: parentToolEntityId,
    invocationId: canonicalInvocationId,
      fields: {
        invocationId: canonicalInvocationId,
        sourceId: invocationId,
        purpose: 'subagent',
        ...(dispatch.provider ? { provider: dispatch.provider } : {}),
        ...(dispatch.model ? { dispatchedModel: dispatch.model } : {}),
        ...(dispatch.thinkingLevel ? { thinkingLevel: dispatch.thinkingLevel } : {}),
        ...(state.childId ? { retryGroupId: state.childId } : {}),
      attemptId: state.attemptId,
      startedAtMs: dispatch.observedAtMs,
      coverage: 'unknown',
    },
  }));
}

/** Snapshot one terminal attempt into independently-owned bytes and submit the
 * attempt/provider facts under the same stable producer origin. Detail and fact
 * handoffs are independent: losing one never fabricates or suppresses the
 * other, and neither blocks child return or failover. */
export function captureSubagentTerminalResult(
  result: SingleResult,
  context: SubagentAnalyticsCaptureContext | undefined,
  parentToolCallId: string | undefined,
  attemptState?: SubagentAnalyticsAttemptCaptureState,
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
  const matchingAttemptState = attemptState?.attemptId === identity
    && attemptState.parentToolCallId === parentToolCallId
    ? attemptState
    : undefined;
  const predispatch = matchingAttemptState && matchingAttemptState.providerRequests.length > 0
    ? {
        factStatus: matchingAttemptState.factStatus,
        providerRequestCount: matchingAttemptState.providerRequests.length,
        providerRequestIds: matchingAttemptState.providerRequests.map((request) => request.invocationId),
        lastSubmittedSequence: matchingAttemptState.lastSubmittedSequence,
        internalRetryCoverage: 'unknown' as const,
      }
    : sealedReceipt?.predispatch;
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

  let factStatus: SubagentCaptureStatus = predispatch?.factStatus
    ?? (context.factSink ? 'submitted' : 'disabled');
  let lastSubmittedSequence = predispatch?.lastSubmittedSequence ?? 0;
  let factError: string | undefined;
  if (matchingAttemptState?.error) factError = matchingAttemptState.error;
  if (context.factSink && factStatus === 'submitted') {
    const observedEnd = terminalObservedAt;
    try {
      if (!predispatch) {
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
            ...(childId ? { childId } : {}),
            ...(attemptId ? { attemptId } : {}),
            ...(parentToolEntityId ? { parentToolCallId: parentToolEntityId } : {}),
            operationKind: 'subagent-attempt',
            source: 'subagent',
            startedAtMs: result.startedAt ?? null,
          },
        });
        context.factSink.submit(begin);
        lastSubmittedSequence = 1;
      }
      let sequence = lastSubmittedSequence + 1;
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
      const providerResponseCount = result.providerInvocations?.length ?? 0;
      const providerRequestCount = predispatch?.providerRequestCount;
      const providerResponseIds = (result.providerInvocations ?? []).map((invocation) => invocation.invocationId);
      const providerRequestIdsMatch = predispatch === undefined
        || (predispatch.providerRequestIds.length === providerResponseIds.length
          && predispatch.providerRequestIds.every((id, index) => id === providerResponseIds[index]));
      const providerCoverageIncomplete = providerResponseCount === 0
        || (providerRequestCount !== undefined && providerRequestCount !== providerResponseCount)
        || !providerRequestIdsMatch;
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
          ...(childId ? { childId } : {}),
          ...(attemptId ? { attemptId } : {}),
          ...(parentToolEntityId ? { parentToolCallId: parentToolEntityId } : {}),
          operationKind: 'subagent-attempt',
          source: 'subagent',
          endedAtMs: result.completedAt ?? null,
          outcome: result.exitCode === 0 ? 'succeeded'
            : result.stopReason === 'aborted' ? 'aborted' : 'failed',
          ...(providerCoverageIncomplete ? {
            captureIncomplete: true,
            reason: predispatch !== undefined && !providerRequestIdsMatch
              ? 'Provider request/response identities did not pair exactly; unmatched calls remain unknown.'
              : providerRequestCount !== undefined && providerRequestCount !== providerResponseCount
              ? `Observed ${providerRequestCount} provider request(s) and ${providerResponseCount} terminal provider response(s); adapter-internal retries remain unknown.`
              : 'The dispatched child attempt ended without an observable provider response.',
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
    ...(predispatch ? { predispatch } : {}),
  };
  result.analyticsCaptureReceipt = receipt;
  context.releaseAcknowledgementInterest?.(context.generationId, stableOriginId, detailPayloadId);
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
