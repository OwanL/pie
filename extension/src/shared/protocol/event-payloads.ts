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
 *   - `unknown`-typed fields (`input`, `result`, `partialResult`) are not
 *     narrowed — any value (including `undefined`) is accepted, matching the
 *     downstream `unknown` contract.
 *
 * Behavior: well-formed payloads pass unchanged; malformed payloads fail the
 * guard and the caller drops them with a loud `console.warn`.
 */

import type {
  BusyChangedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryStartedPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from './sessions.js';
import type { ExtensionUIRequestPayload } from './webview.js';
import type { ContextWindowUsage } from './models.js';

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

// ─── per-event payload guards ────────────────────────────────────────────────

export function isSessionOpenedPayload(value: unknown): value is SessionOpenedPayload {
  return (
    isObject(value)
    && isSessionSummary(value.session)
    && isChatMessageArray(value.transcript)
    && isTranscriptWindow(value.transcriptWindow)
    && isBoolean(value.busy)
  );
}

export function isSessionListChangedPayload(value: unknown): value is SessionListChangedPayload {
  return (
    isObject(value)
    && Array.isArray(value.sessions)
    && value.sessions.every(isSessionSummary)
    && isOptionalString(value.activeSessionPath)
  );
}

export function isMessageStartedPayload(value: unknown): value is MessageStartedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.messageId)
    && isString(value.sessionPath)
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

export function isMessageFinishedPayload(value: unknown): value is MessageFinishedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isChatMessage(value.message)
  );
}

export function isMessageAbortedPayload(value: unknown): value is MessageAbortedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isOptionalString(value.messageId)
    && isOptionalBoolean(value.userInitiated)
    && isOptionalString(value.reason)
  );
}

export function isCustomMessagePayload(value: unknown): value is CustomMessagePayload {
  return (
    isObject(value)
    && isString(value.requestId)
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
  );
}

export function isToolFinishedPayload(value: unknown): value is ToolFinishedPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
    && (value.status === 'completed' || value.status === 'failed')
    && isOptionalFiniteNumber(value.durationMs)
  );
}

export function isToolProgressPayload(value: unknown): value is ToolProgressPayload {
  return (
    isObject(value)
    && isString(value.requestId)
    && isString(value.sessionPath)
    && isString(value.messageId)
    && isString(value.toolCallId)
  );
}

export function isBusyChangedPayload(value: unknown): value is BusyChangedPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isBoolean(value.busy)
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

export function isExtensionUIRequestPayload(value: unknown): value is ExtensionUIRequestPayload {
  if (
    !isObject(value)
    || !isString(value.id)
    || !isString(value.sessionPath)
    || !isOptionalString(value.extensionId)
    || !isOptionalString(value.subagentCallId)
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
    && isString(value.sessionPath)
    && isString(value.error)
  );
}

export function isQueuedDeliveredPayload(value: unknown): value is QueuedDeliveredPayload {
  return (
    isObject(value)
    && isString(value.sessionPath)
    && isString(value.text)
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

