/**
 * Per-event payload type guards for the backend → host stdio boundary.
 *
 * The backend emits `EventEnvelope` lines over stdout; `isEventEnvelope` (in
 * `./core.ts`) only checks the outer envelope shape (`'event' in value`), leaving
 * `payload` as `unknown`. Historically `dispatchSessionBackendEvent` cast each
 * payload with `as XPayload`, propagating any malformed payload unchecked. These
 * guards validate the REQUIRED fields of each payload at the seam so the
 * dispatcher can warn+drop corrupt data instead of cast-and-hope.
 *
 * Thoroughness contract (mirrors `protocol-validation.ts`):
 *   - REQUIRED primitive fields (string/number/boolean) are checked strictly.
 *   - REQUIRED nested object fields are checked to be objects with their own
 *     required primitives shallowly verified.
 *   - OPTIONAL fields are NOT required; an absent optional field is valid.
 *   - terminal `input`/`result` fields remain opaque durable values. Live tool
 *     progress is instead validated as the closed, bounded `ToolPreview` union.
 *
 * Behavior: well-formed payloads pass unchanged; malformed payloads fail the
 * guard and the caller drops them with a loud `console.warn`.
 */

import type {
  AgentSettledPayload,
  AuxiliaryLlmUsagePayload,
  BusyChangedPayload,
  CompactionPayload,
  CompactionStartedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  MessageToolCallDeltaPayload,
  OperationalErrorPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
  RetryStuckPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from './sessions.js';
import type { ExtensionUIRequestPayload } from './webview.js';
import type { ContextWindowUsage } from './models.js';
import { isToolPreview } from '../live-pipeline-protocol.js';

// ─── shared primitives ───────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalSessionCatalogProgress(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)
    || !isBoolean(value.complete)
    || !Number.isInteger(value.processed)
    || (value.total !== undefined && !Number.isInteger(value.total))) {
    return false;
  }
  const processed = value.processed as number;
  const total = value.total as number | undefined;
  return processed >= 0
    && (total === undefined || (total >= 0 && processed <= total));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// ─── nested shared shapes ────────────────────────────────────────────────────

function isSessionSummary(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value)
    && isString(value.path)
    && isString(value.name)
    && isString(value.cwd)
    && isString(value.modifiedAt)
    && isFiniteNumber(value.messageCount)
  );
}

function isTranscriptWindow(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value)
    && isFiniteNumber(value.totalCount)
    && isFiniteNumber(value.loadedStart)
    && isFiniteNumber(value.loadedEnd)
    && isBoolean(value.hasOlder)
    && isBoolean(value.hasNewer)
    && isBoolean(value.isPartial)
    && isBoolean(value.hasUserMessages)
  );
}

function isChatMessage(value: unknown): boolean {
  return (
    isObject(value)
    && isString(value.id)
    && isString(value.role)
    && isString(value.createdAt)
    && isString(value.markdown)
    && isString(value.status)
  );
}

function isChatMessageArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isChatMessage);
}

function isContextWindowUsage(value: unknown): value is ContextWindowUsage {
  return (
    isObject(value)
    && (value.tokens === null || typeof value.tokens === 'number')
    && isFiniteNumber(value.contextWindow)
    && (value.percent === null || typeof value.percent === 'number')
  );
}

function isOptionalInitialContextEstimate(value: unknown): boolean {
  return value === undefined || (
    isObject(value)
    && Number.isSafeInteger(value.tokens)
    && (value.tokens as number) >= 0
    && Number.isSafeInteger(value.contextWindow)
    && (value.contextWindow as number) > 0
  );
}

function isOptionalLiveTurnRecoveryIdentity(value: unknown): boolean {
  return value === undefined || (
    isObject(value)
    && isString(value.turnId)
    && value.turnId.length > 0
    && isString(value.attemptId)
    && value.attemptId.length > 0
  );
}

function isOptionalSnapshotUnavailable(value: unknown): boolean {
  return value === undefined || (
    isObject(value)
    && value.code === 'SESSION_SNAPSHOT_TOO_LARGE'
    && isString(value.message)
    && value.message.length > 0
  );
}

// ─── per-event payload guards ────────────────────────────────────────────────

function isSessionPrimaryOperation(value: unknown): boolean {
  return isObject(value)
    && isString(value.operationId)
    && (value.kind === 'session.create' || value.kind === 'session.duplicate' || value.kind === 'message.send'
      || value.kind === 'message.edit' || value.kind === 'message.interrupt'
      || value.kind === 'message.continue' || value.kind === 'message.compact')
    && (value.phase === 'awaiting-acceptance' || value.phase === 'awaiting-commit' || value.phase === 'ambiguous')
    && Number.isInteger(value.attempt)
    && (value.attempt as number) >= 1
    && isBoolean(value.committed)
    && (value.recovery === null
      || value.recovery === 'retry'
      || value.recovery === 'restart-backend'
      || value.recovery === 'reconcile');
}

function isSessionCapabilities(value: unknown): boolean {
  return isObject(value)
    && isBoolean(value.billableActivity)
    && isBoolean(value.canContinue)
    && isBoolean(value.canInterrupt)
    && isBoolean(value.canCompact)
    && (value.primaryOperation === undefined || isSessionPrimaryOperation(value.primaryOperation));
}

export function isSessionOpenedPayload(value: unknown): value is SessionOpenedPayload {
  return (
    isObject(value)
    && isSessionSummary(value.session)
    && isChatMessageArray(value.transcript)
    && isTranscriptWindow(value.transcriptWindow)
    && isBoolean(value.busy)
    && isSessionCapabilities(value.capabilities)
    && (value.runtimeReady === undefined || isBoolean(value.runtimeReady))
    && (value.systemPromptDisabledEntries === undefined
      || (Array.isArray(value.systemPromptDisabledEntries)
        && value.systemPromptDisabledEntries.every(isString)))
    && isOptionalInitialContextEstimate(value.initialContextEstimate)
    && isOptionalLiveTurnRecoveryIdentity(value.liveTurnRecoveryIdentity)
    && isOptionalSnapshotUnavailable(value.snapshotUnavailable)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined
      || (Number.isInteger(value.operationAttempt) && (value.operationAttempt as number) >= 1))
  );
}

export function isSessionListChangedPayload(value: unknown): value is SessionListChangedPayload {
  return (
    isObject(value)
    && Array.isArray(value.sessions)
    && value.sessions.every(isSessionSummary)
    && isOptionalString(value.activeSessionPath)
    && isOptionalSessionCatalogProgress(value.sessionCatalogProgress)
  );
}

export function isMessageStartedPayload(value: unknown): value is MessageStartedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined || (typeof value.operationAttempt === 'number' && Number.isInteger(value.operationAttempt) && value.operationAttempt >= 1))
    && isString(value.messageId)
    && isString(value.sessionPath)
    && isOptionalString(value.modelId)
    && isOptionalString(value.provider)
  );
}

export function isMessageDeltaPayload(value: unknown): value is MessageDeltaPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.delta)
  );
}

export function isMessageThinkingPayload(value: unknown): value is MessageThinkingPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.thinking)
  );
}

export function isMessageToolCallDeltaPayload(value: unknown): value is MessageToolCallDeltaPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
    && isString(value.name)
    && isString(value.delta)
  );
}

export function isMessageFinishedPayload(value: unknown): value is MessageFinishedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined || (typeof value.operationAttempt === 'number' && Number.isInteger(value.operationAttempt) && value.operationAttempt >= 1))
    && isString(value.sessionPath)
    && isChatMessage(value.message)
  );
}

export function isMessageAbortedPayload(value: unknown): value is MessageAbortedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined || (typeof value.operationAttempt === 'number' && Number.isInteger(value.operationAttempt) && value.operationAttempt >= 1))
    && isString(value.sessionPath)
    && isOptionalString(value.messageId)
    && isOptionalString(value.localId)
    && (value.outcome === undefined || value.outcome === 'cancelled' || value.outcome === 'superseded' || value.outcome === 'failed')
    && isOptionalBoolean(value.userInitiated)
    && isOptionalString(value.reason)
  );
}

export function isCustomMessagePayload(value: unknown): value is CustomMessagePayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isOptionalString(value.operationId)
    && isString(value.sessionPath)
    && isChatMessage(value.message)
  );
}

export function isToolStartedPayload(value: unknown): value is ToolStartedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
    && isString(value.name)
    && isFiniteNumber(value.startedAt)
    && (value.parallelGroupId === undefined || isString(value.parallelGroupId))
  );
}

export function isToolFinishedPayload(value: unknown): value is ToolFinishedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
    && (value.name === undefined || isString(value.name))
    && (value.status === 'completed' || value.status === 'failed')
    && isOptionalFiniteNumber(value.startedAt)
    && isOptionalFiniteNumber(value.durationMs)
    && (value.parallelGroupId === undefined || isString(value.parallelGroupId))
    && (value.durableEntryId === undefined || isString(value.durableEntryId))
    && (value.canonicalLive === undefined || typeof value.canonicalLive === 'boolean')
  );
}

export function isToolProgressPayload(value: unknown): value is ToolProgressPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
    && isToolPreview(value.preview)
  );
}

export function isAgentSettledPayload(value: unknown): value is AgentSettledPayload {
  return isObject(value)
    && isString(value.sessionPath)
    && isSessionCapabilities(value.capabilities);
}

export function isBusyChangedPayload(value: unknown): value is BusyChangedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isBoolean(value.busy)
    && isSessionCapabilities(value.capabilities)
    && isOptionalFiniteNumber(value.seq)
  );
}

export function isContextUsageChangedPayload(value: unknown): value is ContextUsageChangedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && (value.contextUsage === null || isContextWindowUsage(value.contextUsage))
  );
}

function isReviewHumanVerificationMetadata(value: unknown): boolean {
  return isObject(value)
    && value.purpose === 'review_human_verification'
    && isString(value.targetSessionId)
    && isString(value.targetSessionPath)
    && isString(value.criterionId)
    && isString(value.domain)
    && isString(value.expectedObservation);
}

export function isExtensionUIRequestPayload(value: unknown): value is ExtensionUIRequestPayload {
  if (
    !isObject(value)
    || !isString(value.id)
    || !isString(value.sessionPath)
    || !isOptionalString(value.extensionId)
    || !isOptionalString(value.subagentCallId)
    || !isOptionalString(value.toolCallId)
    || (value.reviewMeta !== undefined && !isReviewHumanVerificationMetadata(value.reviewMeta))
    || (value.timeout !== undefined && (!isFiniteNumber(value.timeout) || value.timeout <= 0))
  ) {
    return false;
  }
  switch (value.method) {
    case 'confirm':
      return isString(value.title) && isString(value.message);
    case 'select':
      return isString(value.title) && isStringArray(value.options);
    case 'input':
      return isString(value.title) && isOptionalString(value.placeholder);
    case 'notify':
      return (
        isString(value.message)
        && (
          value.notifyType === undefined
          || value.notifyType === 'info'
          || value.notifyType === 'warning'
          || value.notifyType === 'error'
        )
      );
    default:
      return false;
  }
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  return (
    isObject(value)
    && isString(value.code)
    && isString(value.message)
    && isOptionalString(value.requestId)
  );
}

export function isPreflightFailedPayload(value: unknown): value is PreflightFailedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isOptionalString(value.operationId)
    && isString(value.sessionPath)
    && isString(value.error)
  );
}

export function isQueuedDeliveredPayload(value: unknown): value is QueuedDeliveredPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isString(value.text)
    && isOptionalString(value.operationId)
    && isOptionalString(value.localId)
  );
}

export function isRetryStartedPayload(value: unknown): value is RetryStartedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isFiniteNumber(value.attempt)
    && isFiniteNumber(value.maxAttempts)
    && isFiniteNumber(value.delayMs)
    && isString(value.errorMessage)
    && isOptionalString(value.requestId)
    && isOptionalString(value.retryId)
    && isOptionalFiniteNumber(value.startedAt)
  );
}

export function isRetryEndedPayload(value: unknown): value is RetryEndedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isBoolean(value.success)
    && isFiniteNumber(value.attempt)
    && isOptionalString(value.finalError)
  );
}

export function isRetryMeasuredPayload(value: unknown): value is RetryMeasuredPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isString(value.requestId)
    && isString(value.retryId)
    && isOptionalFiniteNumber(value.measuredDelayMs)
    && isFiniteNumber(value.durationMs)
  );
}

export function isCompactionStartedPayload(value: unknown): value is CompactionStartedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined || (typeof value.operationAttempt === 'number' && Number.isInteger(value.operationAttempt) && value.operationAttempt >= 1))
  );
}

export function isCompactionPayload(value: unknown): value is CompactionPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isOptionalString(value.operationId)
    && (value.operationAttempt === undefined || (typeof value.operationAttempt === 'number' && Number.isInteger(value.operationAttempt) && value.operationAttempt >= 1))
    && (value.reason === undefined || value.reason === 'manual' || value.reason === 'threshold' || value.reason === 'overflow')
    && (value.outcome === 'succeeded' || value.outcome === 'failed' || value.outcome === 'aborted')
    && isOptionalFiniteNumber(value.occurredAt)
    && isOptionalFiniteNumber(value.tokensBefore)
    && isOptionalFiniteNumber(value.estimatedTokensAfter)
  );
}

export function isAuxiliaryLlmUsagePayload(value: unknown): value is AuxiliaryLlmUsagePayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && (value.kind === 'assistant_message' || value.kind === 'history_compaction'
      || value.kind === 'branch_summary' || value.kind === 'session_title' || value.kind === 'other')
    && isString(value.sourceId)
    && isString(value.occurredAt)
    && isOptionalString(value.modelId)
    && isOptionalString(value.provider)
    && isOptionalString(value.parentOperationId)
    && isOptionalFiniteNumber(value.inputTokens)
    && isOptionalFiniteNumber(value.outputTokens)
    && isOptionalFiniteNumber(value.cacheReadTokens)
    && isOptionalFiniteNumber(value.cacheWriteTokens)
    && isOptionalFiniteNumber(value.providerTotalTokens)
    && isOptionalFiniteNumber(value.reportedCostUsd)
    && isOptionalFiniteNumber(value.durationMs)
    && isOptionalString(value.startedAt)
    && (value.outcome === undefined || value.outcome === 'succeeded' || value.outcome === 'failed'
      || value.outcome === 'cancelled' || value.outcome === 'unknown')
    && (value.instrumentationGap === undefined || typeof value.instrumentationGap === 'boolean')
    && isOptionalString(value.instrumentationGapReason)
  );
}

export function isOperationalErrorPayload(value: unknown): value is OperationalErrorPayload {
  return (
    isObject(value)
    && isOptionalString(value.incidentId)
    && isString(value.code)
    && isString(value.message)
    && isOptionalString(value.detail)
    && isString(value.sessionPath)
    && isOptionalString(value.requestId)
  );
}

export function isRetryStuckPayload(value: unknown): value is RetryStuckPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isFiniteNumber(value.delayMs)
    && isFiniteNumber(value.graceMs)
    && isOptionalString(value.requestId)
  );
}
