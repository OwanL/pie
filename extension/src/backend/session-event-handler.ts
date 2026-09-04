import { randomUUID } from 'node:crypto';

import type {
  AuxiliaryLlmUsagePayload,
  CompactionOutcome,
  CompactionPayload,
  CompactionReason,
  CompactionStartedPayload,
  CompactionSummaryDetails,
  CustomMessagePayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  MessageToolCallDeltaPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../shared/protocol';
import { COMPACTION_METRICS_CUSTOM_TYPE } from '../shared/protocol';
import { compactSubagentResultPreview } from '../shared/lazy-details';
import type { SdkSessionEvent } from './sdk';
import { BackendLiveTurnAccumulator, type BackendSemanticCandidate } from './live-turn-accumulator';
import { LIVE_PIPELINE_LIMITS, LIVE_PIPELINE_PROTOCOL_VERSION, type TurnSemanticEnvelope } from '../shared/live-pipeline-protocol';
import {
  estimateCumulativeSubagentTokens,
  normalizeToolProgress,
  type SubagentDetailAddressRoot,
  type ToolProgressRecursiveCounters,
} from './tool-progress-normalizer';
import {
  mapAssistantMessage,
  mapCustomMessage,
  mapTranscript,
  providerTransportFailureDiagnostic,
  type SessionEntryLike,
} from './transcript';
import type { ActiveRequest, SessionContext } from './server-types';
import { buildSessionCapabilities, hasBillableSessionActivity } from './session-activity';
import { backendLog, type BackendLogLevel } from './log';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';
import {
  isAllZeroEmptyLengthMessage,
  isEstimatedContextOverflowMessage,
} from './history-compaction';

/**
 * Assistant-message streaming event types that count as the provider "replying
 * with anything" — the first of these after a `message_start` stamps
 * `providerFirstDeltaAt`, anchoring the provider-latency side of the turn-latency
 * split. Covers text, thinking, and tool-call content blocks so pure tool-call
 * turns (no text/thinking) are still measured.
 */
export const TOOL_PROGRESS_MAX_BYTES = 192 * 1024;
/** Keep tool events below the dedicated worker's ordinary-frame ceiling while
 * retaining the larger shared JSONL limit for the legacy backend path. */
export const TOOL_TERMINAL_PAYLOAD_MAX_BYTES = Math.min(
  LIVE_PIPELINE_LIMITS.checkpointBytes,
  TOOL_PROGRESS_MAX_BYTES,
);

const PROVIDER_TOOL_PROTOCOL_LEAK_BLOCK_LIMIT = 4;
const PROVIDER_TOOL_PROTOCOL_LEAK_TAIL_CHARS = 64;

interface ProviderToolProtocolLeakState {
  tail: string;
  rawToolCallContainers: number;
  dsmlInvocations: number;
  interrupted: boolean;
}

/** Per-request state stays outside the protocol contract and is reclaimed with
 * the ActiveRequest. It only retains enough text to recognize a marker split
 * across adjacent provider deltas. */
const providerToolProtocolLeakByRequest = new WeakMap<ActiveRequest, ProviderToolProtocolLeakState>();

function countNewPatternMatches(text: string, previousTailLength: number, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index + match[0].length > previousTailLength) count += 1;
  }
  return count;
}

/** Observe raw provider text without retaining response content. Four paired
 * DSML tool wrappers in one request is not useful assistant prose and closely
 * precedes the runaway behavior seen from affected OpenAI-compatible models. */
function observeProviderToolProtocolText(active: ActiveRequest, delta: string): boolean {
  let state = providerToolProtocolLeakByRequest.get(active);
  if (!state) {
    state = { tail: '', rawToolCallContainers: 0, dsmlInvocations: 0, interrupted: false };
    providerToolProtocolLeakByRequest.set(active, state);
  }
  if (state.interrupted) return true;

  const previousTailLength = state.tail.length;
  const combined = state.tail + delta;
  state.rawToolCallContainers += countNewPatternMatches(combined, previousTailLength, /<tool_calls>/giu);
  state.dsmlInvocations += countNewPatternMatches(
    combined,
    previousTailLength,
    /<[|｜]DSML[|｜]invoke(?:\s|>)/giu,
  );
  state.tail = combined.slice(-PROVIDER_TOOL_PROTOCOL_LEAK_TAIL_CHARS);

  return state.rawToolCallContainers >= PROVIDER_TOOL_PROTOCOL_LEAK_BLOCK_LIMIT
    && state.dsmlInvocations >= PROVIDER_TOOL_PROTOCOL_LEAK_BLOCK_LIMIT;
}

function interruptProviderToolProtocolLeak(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
): boolean {
  const active = context.activeRequest;
  if (!active) return false;
  const state = providerToolProtocolLeakByRequest.get(active);
  if (!state) return false;
  if (!state.interrupted
    && state.rawToolCallContainers >= PROVIDER_TOOL_PROTOCOL_LEAK_BLOCK_LIMIT
    && state.dsmlInvocations >= PROVIDER_TOOL_PROTOCOL_LEAK_BLOCK_LIMIT) {
    state.interrupted = true;
    const message = 'The provider repeated internal tool-call markup, so the response was stopped before it could overwhelm the UI.';
    logBackendDiagnostic('warn', 'provider.toolProtocolLeak', {
      requestId: active.id,
      sessionPath: context.sessionPath,
      provider: active.provider ?? 'unknown',
      modelId: active.modelId ?? 'unknown',
      rawToolCallContainers: state.rawToolCallContainers,
      dsmlInvocations: state.dsmlInvocations,
    });
    deps.emit('operational-error', {
      incidentId: `provider-tool-protocol-leak:${active.id}`,
      code: 'PROVIDER_TOOL_PROTOCOL_LEAK',
      message,
      detail: [
        `Provider: ${active.provider ?? 'unknown'}`,
        `Model: ${active.modelId ?? 'unknown'}`,
        `Observed: ${state.rawToolCallContainers} raw tool-call containers and ${state.dsmlInvocations} DSML invocations.`,
      ].join('\n'),
      sessionPath: context.sessionPath,
      requestId: active.id,
    });
    void context.session.abort().catch(() => undefined);
  }
  return state.interrupted;
}

/** Produce a transport-safe clone only when native JSON serialization fails.
 * Live tool partials can contain BigInts or cycles from nested/custom tools;
 * replacing the whole partial with an opaque marker would discard subagent
 * lifecycle state and leave the parent card stuck at its initial placeholder. */
function serializeToolProgress(value: unknown): { serialized: string; safeValue: unknown } | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : { serialized, safeValue: value };
  } catch {
    const seen = new WeakSet<object>();
    try {
      const serialized = JSON.stringify(value, (_key, candidate) => {
        if (typeof candidate === 'bigint') return `${candidate}n`;
        if (typeof candidate === 'object' && candidate !== null) {
          if (seen.has(candidate)) return '[Circular]';
          seen.add(candidate);
        }
        return candidate;
      });
      return serialized === undefined
        ? undefined
        : { serialized, safeValue: JSON.parse(serialized) as unknown };
    } catch {
      return undefined;
    }
  }
}

/** Keep high-frequency progress events transport-safe. Terminal results use
 * the same renderable fallback only when their complete event would exceed the
 * separate terminal transport budget. */
export function boundToolProgress(value: unknown, maxBytes = TOOL_PROGRESS_MAX_BYTES): unknown {
  const serializedProgress = serializeToolProgress(value);
  if (!serializedProgress) return { $toolProgress: 'unserializable' };
  const { serialized, safeValue } = serializedProgress;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return safeValue;

  // Subagent progress is itself a renderable tool result. Replacing it with a
  // generic truncation marker makes details.results disappear, so the live
  // subagent card (including its expanded transcript and activity state)
  // vanishes until tool.finished. Preserve a compact renderable skeleton and
  // discard old child messages first; the terminal result remains authoritative.
  if (safeValue && typeof safeValue === 'object') {
    const partial = safeValue as Record<string, unknown>;
    const details = partial.details;
    if (details && typeof details === 'object' && Array.isArray((details as Record<string, unknown>).results)) {
      const compactResults = ((details as Record<string, unknown>).results as unknown[]).map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const result = entry as Record<string, unknown>;
        const streamingText = typeof result.streamingText === 'string'
          ? result.streamingText.slice(-32 * 1024)
          : result.streamingText;
        const streamingReasoning = typeof result.streamingReasoning === 'string'
          ? result.streamingReasoning.slice(-32 * 1024)
          : result.streamingReasoning;
        const cumulativeOutputTokens = estimateCumulativeSubagentTokens(result);
        return {
          ...result,
          cumulativeOutputTokens,
          messages: [{
            role: 'assistant',
            content: [{ type: 'text', text: 'Earlier live transcript omitted while progress exceeded the transport limit.' }],
          }],
          streamingText,
          streamingReasoning,
          progressTranscriptTruncated: true,
        };
      });
      const compact = {
        ...partial,
        content: [{ type: 'text', text: '(live subagent transcript compacted; current activity preserved)' }],
        details: { ...(details as Record<string, unknown>), results: compactResults },
        $toolProgress: 'truncated',
        originalBytes: bytes,
      };
      try {
        const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
        if (compactBytes <= maxBytes) return compact;

        // A pathological field outside `messages` can still make the first
        // compact form too large. Keep a strict lifecycle allowlist as a final
        // renderable subagent fallback. With the tree session cap this remains
        // far below the production limit, regardless of transcript/tool data.
        const boundedText = (candidate: unknown, chars: number): unknown =>
          typeof candidate === 'string' ? candidate.slice(0, chars) : candidate;
        const minimalResults = compactResults.map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const result = entry as Record<string, unknown>;
          return {
            agent: boundedText(result.agent, 256),
            task: boundedText(result.task, 2_048),
            exitCode: result.exitCode,
            stopReason: boundedText(result.stopReason, 256),
            errorMessage: boundedText(result.errorMessage, 2_048),
            model: boundedText(result.model, 256),
            provider: boundedText(result.provider, 256),
            activityPhase: result.activityPhase,
            activityDetail: boundedText(result.activityDetail, 1_024),
            activitySince: result.activitySince,
            progressGeneration: result.progressGeneration,
            lastProgressAt: result.lastProgressAt,
            inactivityBudgetMs: result.inactivityBudgetMs,
            streaming: result.streaming,
            streamingText: boundedText(result.streamingText, 8_192),
            streamingReasoning: boundedText(result.streamingReasoning, 8_192),
            cumulativeOutputTokens: result.cumulativeOutputTokens,
            runningTools: Array.isArray(result.runningTools) ? result.runningTools.slice(0, 20) : undefined,
            messages: [{
              role: 'assistant',
              content: [{ type: 'text', text: 'Live transcript omitted while progress exceeded the transport limit.' }],
            }],
            progressTranscriptTruncated: true,
          };
        });
        const minimal = {
          content: [{ type: 'text', text: '(live subagent transcript compacted; current activity preserved)' }],
          details: {
            mode: (details as Record<string, unknown>).mode,
            results: minimalResults,
          },
          $toolProgress: 'truncated',
          originalBytes: bytes,
        };
        if (Buffer.byteLength(JSON.stringify(minimal), 'utf8') <= maxBytes) return minimal;
      } catch {
        // Fall through to the generic bounded marker.
      }
    }
  }

  const prefix = Buffer.from(serialized, 'utf8').subarray(0, Math.max(0, maxBytes - 160)).toString('utf8');
  return {
    $toolProgress: 'truncated',
    originalBytes: bytes,
    preview: prefix,
  };
}

function terminalResultPreview(value: unknown, maxBytes = TOOL_PROGRESS_MAX_BYTES): unknown {
  const bounded = boundToolProgress(value, maxBytes);
  if (!bounded || typeof bounded !== 'object' || Array.isArray(bounded)) return bounded;
  const record = bounded as Record<string, unknown>;
  if (record.$toolProgress === undefined) return bounded;
  const { $toolProgress, ...preview } = record;
  return {
    ...preview,
    $toolResult: $toolProgress,
    transportNotice: 'Complete terminal result omitted because it exceeded the backend transport limit.',
  };
}

/**
 * A persisted SDK tool result may be much larger than its live rendering
 * preview, especially when nested subagents contain both an assistant
 * tool-call snapshot and the matching toolResult message. The JSONL writer is
 * intentionally fatal for an oversized critical event, so enforce the
 * producer-owned bound before `tool.finished` reaches that final invariant.
 * The durable session remains authoritative; this explicit preview is only
 * the event/side-effect representation and never masquerades as complete.
 */
export interface TerminalTransportMeasurement {
  /** Bytes of the bounded event representation produced for transport. This
   * is not the durable SDK append size. */
  producedPayloadBytes?: number;
  availabilityReason?: 'sdk_durability_boundary_exposes_no_serialized_byte_counter';
}
/** Retain the old type name for focused integrations; the measurement itself
 * now describes terminal transport, never a durable append. */
export type TerminalAppendMeasurement = TerminalTransportMeasurement;

export function boundToolFinishedPayload(
  payload: ToolFinishedPayload,
  maxBytes = TOOL_TERMINAL_PAYLOAD_MAX_BYTES,
  observeMeasurement?: (measurement: TerminalTransportMeasurement) => void,
): ToolFinishedPayload {
  // Subagent terminal detail is already durable at this call site. Ordinary
  // lifecycle transport carries only its compact card projection regardless
  // of size; exact recursive detail switches to the durable authority stream.
  if (payload.name?.trim().toLowerCase() === 'subagent') {
    payload = {
      ...payload,
      result: compactSubagentResultPreview(payload.result) ?? {
        $toolResult: 'detail-available',
        transportNotice: 'Recursive subagent detail is available only through the durable detail authority.',
      },
    };
  }
  const serialized = serializeToolProgress(payload);
  if (serialized && Buffer.byteLength(serialized.serialized, 'utf8') <= maxBytes) {
    recordTerminalTransportMeasurement(payload, {
      producedPayloadBytes: Buffer.byteLength(serialized.serialized, 'utf8'),
    }, observeMeasurement);
    return serialized.safeValue as ToolFinishedPayload;
  }

  const resultPreviewBytes = Math.min(
    TOOL_PROGRESS_MAX_BYTES,
    Math.max(512, Math.floor(maxBytes / 2)),
  );
  let bounded: ToolFinishedPayload = {
    ...payload,
    result: terminalResultPreview(payload.result, resultPreviewBytes),
  };
  const boundedResult = serializeToolProgress(bounded);
  if (boundedResult && Buffer.byteLength(boundedResult.serialized, 'utf8') <= maxBytes) {
    recordTerminalTransportMeasurement(payload, {
      producedPayloadBytes: Buffer.byteLength(boundedResult.serialized, 'utf8'),
    }, observeMeasurement);
    return boundedResult.safeValue as ToolFinishedPayload;
  }

  const input = serializeToolProgress(payload.input);
  bounded = {
    ...bounded,
    input: {
      $toolInput: input ? 'truncated' : 'unserializable',
      ...(input ? { originalBytes: Buffer.byteLength(input.serialized, 'utf8') } : {}),
      transportNotice: 'Complete tool input omitted because the terminal event exceeded the backend transport limit.',
    },
  };
  const finalBounded = serializeToolProgress(bounded);
  if (finalBounded) {
    const finalBytes = Buffer.byteLength(finalBounded.serialized, 'utf8');
    if (finalBytes <= maxBytes) {
      recordTerminalTransportMeasurement(payload, { producedPayloadBytes: finalBytes }, observeMeasurement);
      return finalBounded.safeValue as ToolFinishedPayload;
    }
    const minimal: ToolFinishedPayload = {
      ...payload,
      input: { $toolInput: 'truncated', transportNotice: 'Complete tool input omitted at the terminal transport boundary.' },
      result: { $toolResult: 'truncated', transportNotice: 'Complete tool result omitted at the terminal transport boundary.' },
    };
    const serializedMinimal = serializeToolProgress(minimal);
    if (serializedMinimal) {
      const minimalBytes = Buffer.byteLength(serializedMinimal.serialized, 'utf8');
      if (minimalBytes <= maxBytes) {
        recordTerminalTransportMeasurement(payload, { producedPayloadBytes: minimalBytes }, observeMeasurement);
        return serializedMinimal.safeValue as ToolFinishedPayload;
      }
    }
    throw new RangeError('Terminal tool event identity exceeds the producer transport budget.');
  }
  recordTerminalTransportMeasurement(payload, {
    availabilityReason: 'sdk_durability_boundary_exposes_no_serialized_byte_counter',
  }, observeMeasurement);
  return bounded;
}

function recordTerminalTransportMeasurement(
  payload: ToolFinishedPayload,
  measurement: TerminalTransportMeasurement,
  observer?: (measurement: TerminalTransportMeasurement) => void,
): void {
  observer?.(measurement);
  if (!isBackendLivePipelineTraceEnabled() || payload.name?.trim().toLowerCase() !== 'subagent') return;
  recordBackendLivePipelineTrace({
    stage: 'backend.subagent',
    kind: measurement.producedPayloadBytes === undefined ? 'observation' : 'success',
    phase: 'terminal',
    payloadClass: 'terminal_transport',
    producedPayloadBytes: measurement.producedPayloadBytes,
    availabilityReason: measurement.availabilityReason,
    identifiers: {
      session: payload.sessionPath,
      request: payload.requestId,
      message: payload.durableEntryId,
      tool: payload.toolCallId,
    },
    processRole: 'coordinator',
    pid: process.pid,
  });
}


const FIRST_CONTENT_EVENT_TYPES = new Set([
  'text_start',
  'text_delta',
  'thinking_start',
  'thinking_delta',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
]);

const DEFAULT_UNEXPECTED_INTERRUPT_REASON =
  'The session stopped unexpectedly before the assistant finished responding.';

/** Environment key for the willRetry watchdog grace (added on top of the
 *  SDK's reported backoff `delayMs`). */
const WILLRETRY_WATCHDOG_GRACE_ENV = 'PIE_WILLRETRY_WATCHDOG_GRACE_MS';
/** Default grace added on top of the SDK's backoff delayMs before the
 *  watchdog declares a retry stuck. Generous so a legitimately slow provider
 *  doesn't trip it, but bounded so a backoff that never completes is surfaced. */
const DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS = 60 * 1000;
function resolveWillRetryWatchdogGraceMs(): number {
  const raw = process.env[WILLRETRY_WATCHDOG_GRACE_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS;
}

/** Arm / re-arm the willRetry watchdog. If the watchdog elapses without the
 *  retry completing (auto_retry_end OR agent_end willRetry:false), emit an
 *  operational-error + retry.stuck notice so the user can recover instead of
 *  the session sitting in willRetry forever. Returns a clear function to call
 *  when the retry completes / the turn ends. */
function armWillRetryWatchdog(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  delayMs: number,
): () => void {
  // Clear any existing watchdog so re-arming (e.g. on auto_retry_start) replaces it.
  if (context.willRetryWatchdogTimer) {
    clearTimeout(context.willRetryWatchdogTimer);
    context.willRetryWatchdogTimer = undefined;
  }
  const grace = resolveWillRetryWatchdogGraceMs();
  const windowMs = Math.max(delayMs, 0) + grace;
  context.willRetryWatchdogTimer = setTimeout(() => {
    context.willRetryWatchdogTimer = undefined;
    deps.emit('operational-error', {
      incidentId: `retry-stuck:${context.activeRequest?.id ?? context.sessionPath}:${delayMs}:${grace}`,
      code: 'RETRY_STUCK',
      message: `A retry has not completed within ${windowMs}ms (delayMs=${delayMs} + ${grace}ms grace). The provider may be down mid-backoff or an extension hook blocked the retry. Reload the window if the session stays wedged.`,
      sessionPath: context.sessionPath,
      requestId: context.activeRequest?.id,
    });
    deps.emit('retry.stuck', {
      sessionPath: context.sessionPath,
      delayMs,
      graceMs: grace,
      requestId: context.activeRequest?.id,
    });
    deps.recoverStuckSession?.(
      context,
      `The provider retry made no progress for ${windowMs}ms and was stopped automatically.`,
    );
  }, windowMs);
  return () => {
    if (context.willRetryWatchdogTimer) {
      clearTimeout(context.willRetryWatchdogTimer);
      context.willRetryWatchdogTimer = undefined;
    }
  };
}

/** Emit a structured `backend-session` diagnostic line via the shared backend
 *  logger (explicit `level` field → host reads severity from the structured
 *  field instead of guessing from line text). */
function logBackendDiagnostic(level: BackendLogLevel, event: string, data: Record<string, unknown>): void {
  backendLog(level, 'backend-session', event, data);
}

function summarizePayload(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.slice(0, 500);
  }
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

const TOOL_PAYLOAD_LOGGING_ENV = 'PIE_LOG_TOOL_PAYLOAD';

function isToolPayloadLoggingEnabled(): boolean {
  const raw = process.env[TOOL_PAYLOAD_LOGGING_ENV];
  return raw === '1' || raw === 'true';
}

function safeSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? '').length;
  } catch {
    return String(value ?? '').length;
  }
}

/** Redacted summary of tool arguments for diagnostic logging.
 *  Only key names and serialized length are emitted; values are never logged. */
function summarizeToolArgs(args: unknown): { argKeys: string[]; argsLen: number } {
  const argSource = args !== null && typeof args === 'object' ? args : {};
  return {
    argKeys: Object.keys(argSource),
    argsLen: safeSerializedLength(args),
  };
}

/** Extract a short, sanitized failure reason without putting an entire tool
 * result (which may contain source, credentials, or command output) in logs. */
function toolFailureText(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['error', 'message', 'stderr']) {
    if (typeof record[key] === 'string') return record[key];
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((item) => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : '')
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  const details = record.details;
  return details && typeof details === 'object' ? toolFailureText(details) : undefined;
}

function sanitizeFailureText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

/** Bounded diagnostic summary for failed tools. Shape metadata is always safe;
 * the short reason is best-effort sanitized. Full payload logging remains an
 * explicit environment opt-in. */
export function summarizeToolResult(
  result: unknown,
): { resultType: string; resultLen: number; resultKeys?: string[]; errorSummary?: string } | string | undefined {
  if (isToolPayloadLoggingEnabled()) return summarizePayload(result);
  const summary: { resultType: string; resultLen: number; resultKeys?: string[]; errorSummary?: string } = {
    resultType: typeof result,
    resultLen: safeSerializedLength(result),
  };
  if (result && typeof result === 'object') summary.resultKeys = Object.keys(result).slice(0, 20);
  const failure = toolFailureText(result);
  if (failure) summary.errorSummary = sanitizeFailureText(failure);
  return summary;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isGenericTerminalStreamError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('stream ended without finish_reason')
    || normalized.includes('stream ended before a terminal response event')
    || normalized.includes('stream ended before message_stop')
  );
}

function isGenericConnectionError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized === 'connection error.'
    || normalized === 'connection error'
    || normalized === 'fetch failed';
}

function mergeAssistantErrorDetail(
  messageError: string | undefined,
  retryError: string | undefined,
): string | undefined {
  const direct = nonEmptyTrimmed(messageError);
  const upstream = nonEmptyTrimmed(retryError);

  if (!upstream) {
    return direct;
  }
  if (!direct) {
    return `Upstream error: ${upstream}`;
  }
  if (isGenericConnectionError(direct)) return upstream;
  if (!isGenericTerminalStreamError(direct)) return direct;
  if (direct.includes(upstream)) return direct;
  return `${direct}\n\nUpstream error: ${upstream}`;
}

function clearSettledProviderIncident(context: SessionContext): void {
  const active = context.activeRequest;
  if (!active) return;
  active.latestProviderIncident = undefined;
  if (active.quotaSettlementTimer) clearTimeout(active.quotaSettlementTimer);
  active.quotaSettlementTimer = undefined;
}

/** Best-effort extraction of plain text from an injected queued user message's
 *  content. The host promotes 'queued' transcript messages by FIFO order (the
 *  SDK drains the steering queue one at a time in enqueue order), so this text
 *  is for observability only — not matching — and may differ from what the user
 *  typed if the SDK expanded skill/template commands. */
function extractUserMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && (part as { type?: string }).type === 'text'
          ? String((part as { text?: string }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}

export interface BackendSessionEventHandlerDeps {
  emit(event: string, payload?: unknown): void;
  emitBusyChanged(
    context: SessionContext,
    busy: boolean,
    capabilities?: import('../shared/protocol').SessionCapabilities,
  ): void;
  emitContextUsageChanged(context: SessionContext, postCompactionEstimatedTokens?: number): void;
  emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void>;
  emitSessionListChanged(): Promise<void>;
  /** Terminalize a stuck runtime locally and replace it before the session becomes reusable. */
  recoverStuckSession(context: SessionContext, reason: string): void;
  observeSubagentDetail?(root: SubagentDetailAddressRoot, details: unknown): void;
  terminalizeSubagentDetail?(root: SubagentDetailAddressRoot, durableEntryId: string): void;
}

function subagentDetailRoot(context: SessionContext, rootToolCallId: string): SubagentDetailAddressRoot | undefined {
  if (!rootToolCallId) return undefined;
  const checkpoint = context.activeRequest?.liveTurnAccumulator?.checkpoint();
  if (!checkpoint) return undefined;
  return {
    sessionPath: context.sessionPath,
    turnId: checkpoint.turnId,
    rootToolCallId,
    rootAttemptId: checkpoint.attemptId,
  };
}

function readPostCompactionEstimatedTokens(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as { estimatedTokensAfter?: unknown }).estimatedTokensAfter;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/** Coerce a numeric token count from an untrusted `compaction_end` result
 *  field. Returns `undefined` for non-finite / negative values so the sidecar
 *  omits the field instead of persisting garbage. */
function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/** Mirror the SDK overflow shapes that can only be confirmed after agent_end.
 * Explicit provider errors are candidates; the SDK will later distinguish
 * overflow from ordinary failures. Some providers instead return length with
 * zero output at the configured context-window boundary. */
function mayNeedOverflowRecovery(context: SessionContext, message: SdkSessionEvent['message']): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (message.stopReason === 'error' || (message.errorMessage?.trim().length ?? 0) > 0) return true;
  if (message.stopReason !== 'length') return false;

  const contextWindow = context.session.model?.contextWindow;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const usage = message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown } | undefined;
  const input = readTokenCount(usage?.input) ?? 0;
  const cacheRead = readTokenCount(usage?.cacheRead) ?? 0;
  const output = readTokenCount(usage?.output) ?? 0;
  if (output === 0 && input + cacheRead >= contextWindow * 0.99) return true;
  if (!isAllZeroEmptyLengthMessage(message)) return false;

  const estimatedTokens = context.session.getContextUsage?.()?.tokens;
  return isEstimatedContextOverflowMessage(message, contextWindow, estimatedTokens);
}

/** Minimal slice of the SDK SessionManager's sidecar append surface. The runtime
 *  manager is a fenced `MutableSdkSessionManager` (see `session-manager-fence.ts`)
 *  that proxies `appendCustomEntry`; this local type captures only what
 *  {@link appendCompactionMetricsSidecar} needs without widening
 *  `SdkSessionManager`'s public contract in `sdk.ts`. */
interface SessionManagerSidecarAppender {
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** Find the id of the most recent compaction entry in the session branch. The
 *  SDK appends the compaction entry before emitting `compaction_end`, so this
 *  scan always sees it on a successful compaction. Returns `undefined` when no
 *  compaction entry exists (failed/aborted attempt, or an unexpected SDK shape). */
function latestCompactionEntry(context: SessionContext): SessionEntryLike | undefined {
  const branch = (context.session.sessionManager?.getBranch?.() ?? []) as SessionEntryLike[];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'compaction') return entry;
  }
  return undefined;
}

function readPieCompactionDetails(entry: SessionEntryLike): Record<string, unknown> | undefined {
  if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) return undefined;
  const pie = (entry.details as Record<string, unknown>).pieCompaction;
  return pie && typeof pie === 'object' && !Array.isArray(pie)
    ? pie as Record<string, unknown>
    : undefined;
}

/** Append a non-context `pie.compaction-metrics` sidecar entry after a
 *  successful compaction so the metrics survive transcript reload. The sidecar
 *  is a `custom` entry (via `appendCustomEntry`) — it never participates in LLM
 *  context and never renders as its own transcript row; `mapTranscript` scans
 *  it and attaches typed {@link CompactionSummaryDetails} to the matching
 *  compaction-summary ChatMessage. No-ops when the SDK exposes no
 *  `appendCustomEntry` (older SDK), the compaction entry can't be linked, or no
 *  usable token metric is available. */
function appendCompactionMetricsSidecar(context: SessionContext, event: SdkSessionEvent): void {
  const result = event.result;
  if (!result || typeof result !== 'object') return;
  const compactionEntry = latestCompactionEntry(context);
  const compactionEntryId = compactionEntry?.id;
  if (!compactionEntryId || !compactionEntry) return;

  const resultRecord = result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown };
  const tokensBefore = readTokenCount(resultRecord.tokensBefore);
  const estimatedTokensAfter = readPostCompactionEstimatedTokens(result);
  // Need at least one token metric for the sidecar to be useful.
  if (tokensBefore === undefined && estimatedTokensAfter === undefined) return;

  const manager = context.session.sessionManager as
    (typeof context.session.sessionManager) & Partial<SessionManagerSidecarAppender>;
  if (typeof manager.appendCustomEntry !== 'function') return;

  const startedAt = context.compactionStartedAt;
  const durationMs = typeof startedAt === 'number'
    ? Math.max(0, Date.now() - startedAt)
    : undefined;

  const sidecar: CompactionSummaryDetails & { compactionEntryId: string } = {
    compactionEntryId,
    reason: typeof event.reason === 'string' ? event.reason : '',
  };
  if (tokensBefore !== undefined) sidecar.tokensBefore = tokensBefore;
  if (estimatedTokensAfter !== undefined) sidecar.estimatedTokensAfter = estimatedTokensAfter;
  if (durationMs !== undefined) sidecar.durationMs = durationMs;

  const customDetails = readPieCompactionDetails(compactionEntry);
  const modelId = typeof customDetails?.modelId === 'string'
    ? customDetails.modelId
    : context.session.model?.id;
  const provider = typeof customDetails?.provider === 'string'
    ? customDetails.provider
    : context.session.model?.provider;
  const thinkingLevel = typeof customDetails?.thinkingLevel === 'string'
    ? customDetails.thinkingLevel
    : context.session.thinkingLevel;
  if (typeof modelId === 'string' && modelId.length > 0) sidecar.modelId = modelId;
  if (typeof provider === 'string' && provider.length > 0) sidecar.provider = provider;
  if (typeof thinkingLevel === 'string' && thinkingLevel.length > 0) sidecar.thinkingLevel = thinkingLevel;

  try {
    manager.appendCustomEntry(COMPACTION_METRICS_CUSTOM_TYPE, sidecar);
  } catch (error) {
    logBackendDiagnostic('warn', 'compaction.metricsSidecarAppendFailed', {
      sessionPath: context.sessionPath,
      compactionEntryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function emitLatestPruningResult(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  finalAttempt = false,
): void {
  const active = context.activeRequest;
  if (!active || active.pruningResultLookupComplete || active.emittedPruningResultEntryId) return;
  const branch = (context.session.sessionManager?.getBranch?.() ?? []) as SessionEntryLike[];
  let entry: SessionEntryLike | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (candidate.type === 'custom_message' && candidate.customType === 'pruning-result') {
      entry = candidate;
      break;
    }
  }
  if (!entry) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  // Do not replay the previous turn's summary while the current prepass is
  // still running and its custom entry has not been appended yet.
  const entryTimestamp = Date.parse(entry.timestamp);
  if (active.turnBoundaryAt !== undefined && Number.isFinite(entryTimestamp) && entryTimestamp < active.turnBoundaryAt) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  const message = mapCustomMessage(entry.id, {
    content: entry.content,
    timestamp: entry.timestamp,
    customType: entry.customType,
    display: entry.display,
    details: entry.details,
  });
  if (!message) {
    if (finalAttempt) active.pruningResultLookupComplete = true;
    return;
  }
  active.emittedPruningResultEntryId = entry.id;
  active.pruningResultLookupComplete = true;
  deps.emit('message.custom', {
    requestId: active.id,
    ...(active.operationId ? { operationId: active.operationId } : {}),
    sessionPath: context.sessionPath,
    message,
  } satisfies CustomMessagePayload);
}

// Some providers keep extended reasoning private, so a healthy response may be
// semantically silent until the reasoning phase completes. Keep the default
// long enough for those healthy responses while retaining an operator override
// for diagnostics and environments that need a different global policy.
const PROVIDER_SEMANTIC_INACTIVITY_MS = 18 * 60_000;
const TOOL_INACTIVITY_MS = 30 * 60_000;
function configuredLeaseMs(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveProviderSemanticInactivityMs(_provider?: string): number {
  return configuredLeaseMs('PIE_PROVIDER_SEMANTIC_INACTIVITY_MS', PROVIDER_SEMANTIC_INACTIVITY_MS);
}

function clearSemanticLease(context: SessionContext): void {
  const active = context.activeRequest;
  if (!active?.semanticLeaseTimer) return;
  clearTimeout(active.semanticLeaseTimer);
  active.semanticLeaseTimer = undefined;
}

function renewSemanticLease(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  budgetMs = resolveProviderSemanticInactivityMs(context.activeRequest?.provider),
  leaseKind: 'provider' | 'tool' = 'provider',
): void {
  const active = context.activeRequest;
  if (!active) return;
  clearSemanticLease(context);
  const generation = (active.semanticLeaseGeneration ?? 0) + 1;
  active.semanticLeaseGeneration = generation;
  const requestId = active.id;
  active.semanticLeaseTimer = setTimeout(() => {
    const current = context.activeRequest;
    if (!current || current.id !== requestId || current.semanticLeaseGeneration !== generation) return;
    current.semanticLeaseTimer = undefined;
    emitSemanticCandidate(deps, context, {
      kind: 'turn.phase', phase: 'aborting', inactivityBudgetMs: 5_000,
    });
    const reason = leaseKind === 'tool'
      ? 'The running tool stopped producing progress.'
      : 'The provider stopped producing semantic response events.';
    const lastProviderError = nonEmptyTrimmed(
      current.lastProviderErrorForDiagnostics ?? current.lastRetryErrorMessage,
    );
    const detail = leaseKind === 'tool'
      ? [
          `Inactivity threshold: ${budgetMs} ms`,
          'Observed: the running tool emitted no progress update before the threshold expired.',
        ].join('\n')
      : [
          `Provider: ${current.provider ?? 'unknown'}`,
          `Model: ${current.modelId ?? 'unknown'}`,
          `Inactivity threshold: ${budgetMs} ms`,
          'Observed: no text, reasoning, or tool-call event arrived before the threshold expired.',
          lastProviderError
            ? `Last provider error: ${lastProviderError.slice(0, 4_096)}`
            : 'Last provider error: none was emitted before the response went silent.',
        ].join('\n');
    logBackendDiagnostic('warn', 'semantic.inactivityTimeout', {
      requestId,
      sessionPath: context.sessionPath,
      leaseKind,
      budgetMs,
      provider: current.provider ?? 'unknown',
      modelId: current.modelId ?? 'unknown',
      ...(lastProviderError ? { lastProviderError: lastProviderError.slice(0, 4_096) } : {}),
    });
    deps.emit('operational-error', {
      incidentId: `semantic-timeout:${requestId}:${leaseKind}`,
      code: leaseKind === 'tool' ? 'TOOL_INACTIVITY_TIMEOUT' : 'PROVIDER_SEMANTIC_TIMEOUT',
      message: reason,
      detail,
      sessionPath: context.sessionPath,
      requestId,
    });
    deps.recoverStuckSession(context, reason);
  }, budgetMs);
  active.semanticLeaseTimer.unref?.();
}

function emitSemanticCandidate(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  candidate: BackendSemanticCandidate,
  occurredAt = Date.now(),
): TurnSemanticEnvelope | undefined {
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (!accumulator) return undefined;
  const mappingStartedAt = performance.now();
  const envelope = accumulator.observe(candidate, occurredAt);
  if (isBackendLivePipelineTraceEnabled()) {
    const canonical = envelope as (Record<string, unknown> & {
      kind?: string;
      turnId?: string;
      attemptId?: string;
      executionId?: string;
      seq?: number;
      progressRevision?: number;
      previewBytes?: number;
    }) | undefined;
    recordBackendLivePipelineTrace({
      stage: canonical?.kind === 'observation.rejected' ? 'backend.observation.rejected' : 'backend.mapped',
      kind: canonical ? (canonical.kind === 'observation.rejected' ? 'rejected' : 'success') : 'false',
      phase: 'backend_mapping',
      durationMs: Math.max(0, performance.now() - mappingStartedAt),
      identifiers: {
        session: context.sessionPath,
        ...(context.activeRequest?.id ? { request: context.activeRequest.id } : {}),
        ...(canonical?.turnId ? { turn: canonical.turnId } : {}),
        ...(canonical?.attemptId ? { attempt: canonical.attemptId } : {}),
        ...(canonical?.executionId ? { tool: canonical.executionId } : {}),
      },
      eventKind: canonicalTraceEventKind(candidate.kind),
      eventSeq: canonical?.seq,
      checkpointSeq: canonical?.seq,
      revision: canonical?.progressRevision,
      toolStateRevision: canonical?.progressRevision,
      snapshotBytes: canonical?.previewBytes,
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
  if (!envelope) return undefined;
  deps.emit('live.semantic', envelope);
  if (envelope.kind === 'observation.rejected' && envelope.reason === 'payload_oversize') {
    logBackendDiagnostic('warn', 'semantic.payloadOversize', { candidateKind: candidate.kind });
    deps.emit('operational-error', {
      incidentId: `turn-too-large:${context.activeRequest?.id ?? context.sessionPath}`,
      code: 'TURN_TOO_LARGE',
      message: 'The active response exceeded the bounded live-pipeline record limit and was interrupted.',
      sessionPath: context.sessionPath,
      requestId: context.activeRequest?.id,
    });
    void context.session.abort().catch(() => undefined);
  }
  return envelope;
}

function finishRetryTiming(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  endedAt: number,
): void {
  const active = context.activeRequest;
  const timing = active?.retryTiming;
  if (!active || !timing) return;
  deps.emit('retry.measured', {
    sessionPath: context.sessionPath,
    requestId: active.id,
    retryId: timing.retryId,
    ...(timing.providerAttemptStartedAt === undefined
      ? {}
      : { measuredDelayMs: Math.max(0, timing.providerAttemptStartedAt - timing.startedAt) }),
    durationMs: Math.max(0, endedAt - timing.startedAt),
  } satisfies RetryMeasuredPayload);
  active.retryTiming = undefined;
}

function emitRejectedObservation(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  reason: 'unsupported_observation' | 'malformed_observation' | 'malformed_payload' | 'owner_missing',
): void {
  const accumulator = context.activeRequest?.liveTurnAccumulator;
  if (accumulator) deps.emit('live.semantic', accumulator.reject(reason, Date.now()));
}

function liveExecutionId(context: SessionContext, toolCallId: string): string {
  const attemptId = context.activeRequest?.liveTurnAccumulator?.attemptId;
  return `${attemptId ?? 'unknown'}:${toolCallId}`;
}

/** Close the live reply that precedes an injected queued user message, then
 * allocate a fresh semantic owner for the assistant output that follows it.
 * The SDK keeps both segments inside one agent run, but the transcript has a
 * real user-message boundary and therefore must expose two assistant rows. */
function startQueuedFollowUpSegment(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  occurredAt: number,
): void {
  const active = context.activeRequest;
  const previousAccumulator = active?.liveTurnAccumulator;
  if (!active || !previousAccumulator) return;

  if (!previousAccumulator.lifecycleWatermark()) {
    const pending = active.pendingQueuedBoundaryTerminal;
    if (!pending) {
      emitRejectedObservation(deps, context, 'owner_missing');
      return;
    }
    const branch = context.session.sessionManager?.getBranch?.() as SessionEntryLike[] | undefined;
    const refreshed = branch
      ? [...mapTranscript(branch)].reverse().find((entry) =>
          entry.role === 'assistant' && entry.durableEntryId === pending.durableEntryId)
      : undefined;
    const runtime = pending.durableMessage;
    const durableMessage = {
      ...(refreshed ?? runtime),
      modelId: runtime.modelId ?? refreshed?.modelId,
      provider: runtime.provider ?? refreshed?.provider,
      thinkingLevel: runtime.thinkingLevel ?? refreshed?.thinkingLevel,
      durationMs: runtime.durationMs ?? refreshed?.durationMs,
      turnLatencyMs: runtime.turnLatencyMs,
      overheadMs: runtime.overheadMs,
      providerLatencyMs: runtime.providerLatencyMs,
      providerQueueMs: runtime.providerQueueMs,
      providerQueueAttemptCount: runtime.providerQueueAttemptCount,
      errorDetail: runtime.errorDetail ?? refreshed?.errorDetail,
      durableEntryId: pending.durableEntryId,
    };
    emitSemanticCandidate(deps, context, {
      kind: 'turn.terminal',
      terminalKind: durableMessage.status === 'interrupted' ? 'interrupted' : 'completed',
      userInitiated: durableMessage.status === 'interrupted' ? active.aborted === true : undefined,
      ...pending,
      durableMessage,
    }, occurredAt);
  }

  // Do not introduce a second owner unless the old one was successfully
  // terminalized. The oversize/rejected path will abort and repair normally.
  if (!previousAccumulator.lifecycleWatermark()) return;
  context.terminalLiveTurn = {
    accumulator: previousAccumulator,
    expiresAt: occurredAt + 10_000,
  };
  active.liveTurnAccumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath: context.sessionPath,
    requestId: active.id,
    ...(active.operationId ? { operationId: active.operationId } : {}),
    turnId: randomUUID(),
    attemptId: randomUUID(),
    canonicalMessageId: `${active.id}:${active.messageIndex + 1}`,
    modelId: active.modelId,
    provider: active.provider,
    thinkingLevel: active.thinkingLevel,
    startedAt: occurredAt,
  });
  active.pendingQueuedBoundaryTerminal = undefined;
  active.pendingErrorTerminal = undefined;
  active.pendingDurableToolTerminals?.clear();
  active.toolStartTimes?.clear();
  active.toolStartMetadata?.clear();
  active.toolParallelGroupByCallId?.clear();
  active.providerQueueByTurn?.clear();
  active.turnBoundaryAt = occurredAt;
  // The SDK emitted turn_start before it injected the queued user row. That
  // earlier timestamp belongs to the closed segment; delivery is the first
  // truthful provider-boundary timestamp available for this new reply.
  active.turnStartedAt = occurredAt;
  active.currentMessageId = undefined;
  active.currentMessageStartedAt = undefined;
  active.providerFirstDeltaAt = undefined;
}

/** Restore request correlation after successful provider-overflow recovery.
 * Pi emits agent_end(willRetry=false) before it identifies the overflow. Keep
 * or restore the same public request owner before agent.continue() starts so
 * continuation events retain their correlation. */
function rearmPostAgentCompactionRequest(
  context: SessionContext,
  active: ActiveRequest | undefined,
  occurredAt: number,
): boolean {
  if (!active || active.aborted || (context.activeRequest && context.activeRequest !== active)) return false;

  active.liveTurnAccumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath: context.sessionPath,
    requestId: active.id,
    ...(active.operationId ? { operationId: active.operationId } : {}),
    turnId: randomUUID(),
    attemptId: randomUUID(),
    canonicalMessageId: `${active.id}:${active.messageIndex + 1}`,
    modelId: active.modelId,
    provider: active.provider,
    thinkingLevel: active.thinkingLevel,
    startedAt: occurredAt,
  });
  active.pendingQueuedBoundaryTerminal = undefined;
  active.pendingErrorTerminal = undefined;
  active.mayNeedOverflowRecovery = false;
  active.pendingDurableToolTerminals?.clear();
  active.toolStartTimes?.clear();
  active.toolStartMetadata?.clear();
  active.toolParallelGroupByCallId?.clear();
  active.providerQueueByTurn?.clear();
  active.providerNetworkPendingAttemptId = undefined;
  active.providerNetworkPending = false;
  active.retryTiming = undefined;
  active.currentMessageId = undefined;
  active.currentMessageStartedAt = undefined;
  active.providerFirstDeltaAt = undefined;
  active.turnStartedAt = undefined;
  active.turnBoundaryAt = occurredAt;
  active.aborted = false;
  context.activeRequest = active;
  if (context.overflowRecoveryCandidate === active) context.overflowRecoveryCandidate = undefined;
  return true;
}

export function handleSdkSessionEvent(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
): void {
  if (isBackendLivePipelineTraceEnabled()) {
    const active = context.activeRequest;
    recordBackendLivePipelineTrace({
      stage: 'sdk.observed',
      kind: 'observation',
      identifiers: {
        session: context.sessionPath,
        ...(active?.id ? { request: active.id } : {}),
        ...(active?.currentMessageId ? { message: active.currentMessageId } : {}),
      },
      eventKind: sdkTraceEventKind(event.type),
      phase: sdkTracePhase(event.type),
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
  switch (event.type) {
    case 'agent_start': {
      // A later ordinary request supersedes any finalized error that did not
      // lead to overflow compaction. Successful overflow recovery clears the
      // candidate while re-arming it before this event arrives.
      if (context.activeRequest && context.overflowRecoveryCandidate !== context.activeRequest) {
        context.overflowRecoveryCandidate = undefined;
      }
      // before_agent_start extensions persist their injected custom message
      // before agent_start. Read it from the authoritative branch so pruning
      // summaries do not depend on the SDK also producing message_end/custom.
      emitLatestPruningResult(deps, context);
      deps.emitBusyChanged(context, hasBillableSessionActivity(context));
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'turn_start': {
      // Some SDK versions append the before_agent_start custom entry just after
      // agent_start. Re-check at turn_start; stable-id dedupe makes this cheap.
      emitLatestPruningResult(deps, context);
      // `turn_start` fires at the start of every turn, before request building
      // (`convertToLlm`, auth resolution) and the provider HTTP dispatch. It is
      // the cleanest observable boundary between serial inter-turn work on our
      // side and the provider request: overhead = turnBoundaryAt → turnStartedAt,
      // provider = turnStartedAt → first reply token.
      if (!context.activeRequest) {
        return;
      }
      context.activeRequest.turnStartedAt = Date.now();
      context.activeRequest.semanticStarted = true;
      context.activeRequest.providerTurnSequence = (context.activeRequest.providerTurnSequence ?? 0) + 1;
      // message_start is too late to own provider hangs before the first
      // assistant event (for example, no response headers after a tool result).
      // Start the semantic lease at the SDK's provider-turn boundary and renew
      // it again at message_start/semantic deltas.
      const providerLeaseMs = resolveProviderSemanticInactivityMs(context.activeRequest.provider);
      renewSemanticLease(deps, context, providerLeaseMs, 'provider');
      const accumulator = context.activeRequest.liveTurnAccumulator;
      const liveSeq = accumulator?.currentSeq ?? 0;
      if (liveSeq === 0) {
        // The first semantic provider-turn boundary is commit evidence even if
        // the following event is delayed or dropped before reaching the host.
        context.sendOperationLedger?.markCommitted(context.activeRequest.operationId);
        emitSemanticCandidate(deps, context, { kind: 'turn.started' }, context.activeRequest.turnStartedAt);
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'preparing', inactivityBudgetMs: providerLeaseMs,
        }, context.activeRequest.turnStartedAt);
      } else if (!accumulator?.lifecycleWatermark()) {
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: providerLeaseMs,
        }, context.activeRequest.turnStartedAt);
      }
      return;
    }

    case 'message_start': {
      // Steering/follow-up delivery occurs inside the same SDK agent run, but
      // it is still a real transcript boundary. Terminalize the reply above the
      // queued row and create a fresh live owner so subsequent assistant output
      // renders as a separate reply below the now-delivered user message.
      // The normal (non-queued) prompt does not emit user-role message_start in
      // this subscribed stream, so this branch only handles injected messages.
      if (event.message?.role === 'user') {
        const deliveredAt = Date.now();
        // Shift both delivery identities before opening the next segment so
        // that its semantic events own this queued follow-up operation.
        const queuedLocalIds = context.queuedLocalIds;
        const localId = queuedLocalIds && queuedLocalIds.length > 0
          ? queuedLocalIds.shift()
          : undefined;
        const queuedOperationIds = context.queuedOperationIds;
        const operationId = queuedOperationIds && queuedOperationIds.length > 0
          ? queuedOperationIds.shift()
          : undefined;
        if (operationId) {
          context.sendOperationLedger?.markCommitted(operationId);
          if (context.activeRequest) context.activeRequest.operationId = operationId;
        }
        startQueuedFollowUpSegment(deps, context, deliveredAt);
        deps.emit('message.queuedDelivered', {
          sessionPath: context.sessionPath,
          text: extractUserMessageText(event.message),
          ...(operationId ? { operationId } : {}),
          localId: localId || undefined,
        } satisfies QueuedDeliveredPayload);
        return;
      }
      if (event.message?.role !== 'assistant' || !context.activeRequest) {
        if (context.activeRequest && event.message?.role === 'assistant') emitRejectedObservation(deps, context, 'malformed_observation');
        return;
      }
      // Last pre-commit opportunity to recover an injected pruning result if
      // this SDK did not expose it at agent_start/turn_start. After this point
      // the prepass is complete, so later turns must not rescan the branch.
      emitLatestPruningResult(deps, context, true);
      context.activeRequest.messageIndex += 1;
      context.activeRequest.currentMessageId = `${context.activeRequest.id}:${context.activeRequest.messageIndex}`;
      context.activeRequest.lastAssistantMessageId = context.activeRequest.currentMessageId;
      context.activeRequest.currentMessageStartedAt = Date.now();
      context.activeRequest.lastRetryErrorMessage = undefined;
      // Reset the per-message first-content marker so each assistant message
      // measures its own provider TTFT.
      context.activeRequest.providerFirstDeltaAt = undefined;
      // Commit point (first assistant message of this request): clear the
      // pre-commit safety-net timer armed in `handleMessageSend`. The timer is
      // a PRE-COMMIT guard only — without this clear it would act as a
      // whole-run ceiling (it is otherwise only cleared on `session.prompt()`
      // settle) and abort any healthy multi-turn agentic run exceeding
      // `PROMPT_TIMEOUT_MS` mid-stream. Only the first message_start clears
      // (subsequent turns re-enter with `promptSafetyTimer === undefined`).
      if (context.activeRequest.messageIndex === 1) {
        context.sendOperationLedger?.markCommitted(context.activeRequest.operationId);
        if (context.activeRequest.promptSafetyTimer) {
          clearTimeout(context.activeRequest.promptSafetyTimer);
          context.activeRequest.promptSafetyTimer = undefined;
        }
      }

      if ((context.activeRequest.liveTurnAccumulator?.currentSeq ?? 0) === 0) {
        emitSemanticCandidate(deps, context, { kind: 'turn.started' }, context.activeRequest.currentMessageStartedAt);
      }
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: PROVIDER_SEMANTIC_INACTIVITY_MS,
      }, context.activeRequest.currentMessageStartedAt);
      renewSemanticLease(deps, context);

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.started', {
        requestId: context.activeRequest.id,
        ...(context.activeRequest.operationId ? { operationId: context.activeRequest.operationId } : {}),
        ...(context.activeRequest.operationAttempt !== undefined
          ? { operationAttempt: context.activeRequest.operationAttempt } : {}),
        messageId: context.activeRequest.currentMessageId,
        sessionPath: context.sessionPath,
        modelId: context.activeRequest.modelId,
        ...(context.activeRequest.provider ? { provider: context.activeRequest.provider } : {}),
        thinkingLevel: context.activeRequest.thinkingLevel,
      } satisfies MessageStartedPayload);
      // Context usage is based on the latest completed assistant usage and has
      // not changed at message_start. Avoid an O(branch) SDK walk here.
      return;
    }

    case 'message_update': {
      if (event.message?.role !== 'assistant' || !context.activeRequest?.currentMessageId) {
        if (context.activeRequest && event.message?.role === 'assistant') emitRejectedObservation(deps, context, 'owner_missing');
        return;
      }

      if (event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta ?? '';
        if (observeProviderToolProtocolText(context.activeRequest, delta)) {
          interruptProviderToolProtocolLeak(deps, context);
          return;
        }
        context.activeRequest.lastProviderErrorForDiagnostics = undefined;
        clearSettledProviderIncident(context);
        renewSemanticLease(deps, context);
        emitSemanticCandidate(deps, context, {
          kind: 'turn.text', delta,
        });
        if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.delta', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.currentMessageId,
          delta,
        } satisfies MessageDeltaPayload);
      }

      if (event.assistantMessageEvent?.type === 'thinking_delta') {
        const thinkingContent: string =
          event.assistantMessageEvent.thinking ?? event.assistantMessageEvent.delta ?? '';
        if (thinkingContent) {
          context.activeRequest.lastProviderErrorForDiagnostics = undefined;
          clearSettledProviderIncident(context);
          renewSemanticLease(deps, context);
          emitSemanticCandidate(deps, context, {
            kind: 'turn.reasoning',
            delta: event.assistantMessageEvent.delta ?? thinkingContent,
          });
          if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.thinking', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId: context.activeRequest.currentMessageId,
            thinking: thinkingContent,
          } satisfies MessageThinkingPayload);
        }
      }

      const toolCallEvent = event.assistantMessageEvent;
      if (toolCallEvent?.type === 'toolcall_start'
        || toolCallEvent?.type === 'toolcall_delta'
        || toolCallEvent?.type === 'toolcall_end') {
        const contentIndex = toolCallEvent.contentIndex;
        const partialContent = Number.isSafeInteger(contentIndex) && (contentIndex as number) >= 0
          ? toolCallEvent.partial?.content?.[contentIndex as number]
          : undefined;
        const finalized = toolCallEvent.type === 'toolcall_end' ? toolCallEvent.toolCall : undefined;
        const observed = finalized ?? partialContent;
        const toolCallId = observed?.id?.trim() ?? '';
        const name = observed?.name?.trim() ?? '';
        const validShape = Number.isSafeInteger(contentIndex) && (contentIndex as number) >= 0
          && observed?.type === 'toolCall' && toolCallId.length > 0 && name.length > 0
          && (toolCallEvent.type !== 'toolcall_delta' || typeof toolCallEvent.delta === 'string');
        let finalizedArgumentsJson: string | undefined;
        if (validShape && toolCallEvent.type === 'toolcall_end') {
          try {
            finalizedArgumentsJson = JSON.stringify(finalized?.arguments);
          } catch {
            finalizedArgumentsJson = undefined;
          }
        }
        if (!validShape || (toolCallEvent.type === 'toolcall_end' && finalizedArgumentsJson === undefined)) {
          emitRejectedObservation(deps, context, 'malformed_payload');
        } else {
          context.activeRequest.lastProviderErrorForDiagnostics = undefined;
          clearSettledProviderIncident(context);
          renewSemanticLease(deps, context);
          if (toolCallEvent.type === 'toolcall_start') {
            emitSemanticCandidate(deps, context, {
              kind: 'turn.toolDraft', action: 'start', toolCallId, name,
            });
          } else if (toolCallEvent.type === 'toolcall_delta') {
            emitSemanticCandidate(deps, context, {
              kind: 'turn.toolDraft', action: 'delta', toolCallId, name,
              argumentsJsonDelta: toolCallEvent.delta!,
            });
          } else {
            emitSemanticCandidate(deps, context, {
              kind: 'turn.toolDraft', action: 'end', toolCallId, name,
              argumentsJson: finalizedArgumentsJson!,
            });
          }
          if (!context.activeRequest.liveTurnAccumulator && toolCallEvent.type !== 'toolcall_end') {
            deps.emit('message.toolCallDelta', {
              requestId: context.activeRequest.id,
              sessionPath: context.sessionPath,
              messageId: context.activeRequest.currentMessageId,
              toolCallId,
              name,
              delta: toolCallEvent.type === 'toolcall_delta' ? toolCallEvent.delta! : '',
            } satisfies MessageToolCallDeltaPayload);
          }
        }
      }

      // Stamp the provider's first reply token for turn-latency measurement —
      // the first content-block event (text/thinking/toolcall) after this turn's
      // `message_start`. Stamped once per message (`message_start` resets it).
      const assistantMessageEvent = event.assistantMessageEvent;
      if (
        assistantMessageEvent
        && context.activeRequest.providerFirstDeltaAt === undefined
        && FIRST_CONTENT_EVENT_TYPES.has(assistantMessageEvent.type)
      ) {
        context.activeRequest.providerFirstDeltaAt = Date.now();
      }

      // Do NOT emitContextUsageChanged here. Deriving the context-window
      // footprint resolves the full session branch (sessionManager.getBranch()),
      // which is O(branch length) per call — and quadratic in the SDK today
      // (repeated Array.unshift). Calling it on every text/thinking delta made
      // streaming O(n²) per token: replies stalled on long conversations
      // regardless of provider. The footprint only steps forward when a new
      // assistant usage lands, which happens at message_end (and agent_start /
      // tool_execution_end) — those call emitContextUsageChanged. Usage never
      // arrives on a message_update, so recomputing here is pure waste.
      return;
    }

    case 'tool_execution_start': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        if (context.activeRequest) emitRejectedObservation(deps, context, 'owner_missing');
        return;
      }

      clearSemanticLease(context);
      renewSemanticLease(deps, context, configuredLeaseMs('PIE_TOOL_INACTIVITY_MS', TOOL_INACTIVITY_MS), 'tool');
      // Diagnostic: log tool execution start to stderr for debugging file-changes tracking.
      // Raw argument values are intentionally omitted to avoid leaking secrets/PII.
      logBackendDiagnostic('debug', 'tool_execution_start', {
        toolName: event.toolName ?? '',
        toolCallId: event.toolCallId ?? '',
        args: summarizeToolArgs(event.args),
      });

      const toolCallId = event.toolCallId?.trim() ?? '';
      if (!toolCallId) {
        emitRejectedObservation(deps, context, 'malformed_observation');
        return;
      }
      const startedAt = Date.now();
      const toolStartTimes = context.activeRequest.toolStartTimes ?? new Map<string, number>();
      const parallelGroups = context.activeRequest.toolParallelGroupByCallId ?? new Map<string, string>();
      const runningSiblingId = toolStartTimes.keys().next().value as string | undefined;
      const parallelGroupId = runningSiblingId
        ? parallelGroups.get(runningSiblingId) ?? randomUUID()
        : randomUUID();
      const boundedInput = event.args === undefined
        ? undefined
        : boundToolProgress(event.args, TOOL_PROGRESS_MAX_BYTES);
      toolStartTimes.set(toolCallId, startedAt);
      parallelGroups.set(toolCallId, parallelGroupId);
      context.activeRequest.toolStartTimes = toolStartTimes;
      context.activeRequest.toolParallelGroupByCallId = parallelGroups;
      const toolStartMetadata = context.activeRequest.toolStartMetadata
        ?? new Map<string, { name: string; input: unknown }>();
      toolStartMetadata.set(toolCallId, { name: event.toolName ?? '', input: boundedInput });
      context.activeRequest.toolStartMetadata = toolStartMetadata;

      const executionId = liveExecutionId(context, toolCallId);
      emitSemanticCandidate(deps, context, {
        kind: 'tool.started',
        executionId,
        parentExecutionId: null,
        rootExecutionId: executionId,
        toolCallId,
        name: event.toolName ?? '',
        input: boundedInput,
        startedAt,
        parallelGroupId,
      }, startedAt);

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('tool.started', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: event.toolName ?? '',
        input: boundedInput,
        startedAt,
        parallelGroupId,
      } satisfies ToolStartedPayload);
      // Starting a tool does not change the latest completed assistant usage.
      return;
    }

    case 'tool_execution_update': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        if (context.activeRequest) emitRejectedObservation(deps, context, 'owner_missing');
        return;
      }

      renewSemanticLease(deps, context, configuredLeaseMs('PIE_TOOL_INACTIVITY_MS', TOOL_INACTIVITY_MS), 'tool');
      const detailRoot = subagentDetailRoot(context, event.toolCallId ?? '');
      if (detailRoot && (event.toolName ?? '').trim().toLowerCase() === 'subagent') {
        deps.observeSubagentDetail?.(detailRoot, event.partialResult);
      }
      const recursiveCounters: ToolProgressRecursiveCounters | undefined = isBackendLivePipelineTraceEnabled()
        ? { childCount: 0, messageCount: 0, maxRecursiveDepth: 0 }
        : undefined;
      // Normalize once and share the complete JSON-safe recursive preview with
      // both publication paths. Counter collection is folded into that same
      // traversal and is disabled without diagnostics.
      const preview = normalizeToolProgress(event.toolName ?? '', event.partialResult, recursiveCounters, detailRoot);
      emitSemanticCandidate(deps, context, {
        kind: 'tool.progress',
        executionId: liveExecutionId(context, event.toolCallId ?? ''),
        preview,
        recursiveCounters,
      });

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('tool.progress', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        preview,
      } satisfies ToolProgressPayload);
      // Same rationale as message_update above: the context-window footprint
      // is static during tool execution (no new assistant usage until
      // message_end), and tool_execution_update can fire repeatedly for
      // streaming-output tools (e.g. long bash output) — each call would
      // re-resolve the O(n) getBranch() for no benefit. message_end refreshes it.
      return;
    }

    case 'tool_execution_end': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        if (context.activeRequest) emitRejectedObservation(deps, context, 'owner_missing');
        return;
      }

      const toolCallId = event.toolCallId?.trim() ?? '';
      if (!toolCallId) {
        emitRejectedObservation(deps, context, 'malformed_observation');
        return;
      }
      const executionStatus = event.isError ? 'failed' as const : 'completed' as const;
      const pending = context.activeRequest.pendingDurableToolTerminals
        ?? new Map<string, ToolFinishedPayload>();
      const existingPending = pending.get(toolCallId);
      if (existingPending) {
        // SDK adapters may replay the execution boundary before the durable
        // toolResult append arrives. Preserve the first observed result/timing
        // so the later terminal upgrade still matches `tool.executionEnded`.
        if (existingPending.status !== executionStatus) {
          emitRejectedObservation(deps, context, 'malformed_observation');
        }
        return;
      }

      // Advance the turn-latency window origin to this tool's finish time. The
      // most recent distinct `tool_execution_end` wins, so parallel/sequential
      // batches anchor on the last tool to finish.
      context.activeRequest.turnBoundaryAt = Date.now();

      const startMetadata = context.activeRequest.toolStartMetadata?.get(toolCallId);
      context.activeRequest.toolStartMetadata?.delete(toolCallId);
      const toolName = event.toolName?.trim() || startMetadata?.name || '';

      if (event.isError) {
        logBackendDiagnostic('warn', 'tool.failed', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          toolCallId,
          toolName,
          result: summarizeToolResult(event.result),
        });
      }

      const timing = resolveToolTiming(context, toolCallId);
      // A tool lease must never disappear while the agent prepares its next
      // provider turn. Previously tool_execution_end only cleared the lease,
      // leaving the post-tool/pre-message_start gap unbounded. If the provider
      // then emitted no message_start, the session appeared to stop for no
      // reason (or was eventually retired by a stale 30-minute tool lease).
      // Parallel siblings retain the tool budget; the final tool switches to
      // the shorter provider-semantic budget until message_start renews it.
      const runningTools = context.activeRequest.toolStartTimes?.size ?? 0;
      const nextLeaseKind = runningTools > 0 ? 'tool' as const : 'provider' as const;
      const nextLeaseMs = nextLeaseKind === 'tool'
        ? configuredLeaseMs('PIE_TOOL_INACTIVITY_MS', TOOL_INACTIVITY_MS)
        : resolveProviderSemanticInactivityMs(context.activeRequest.provider);
      renewSemanticLease(deps, context, nextLeaseMs, nextLeaseKind);

      const terminal: ToolFinishedPayload = {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: toolName,
        input: event.args !== undefined ? event.args : startMetadata?.input,
        result: event.result,
        status: executionStatus,
        startedAt: timing?.startedAt,
        durationMs: timing?.durationMs,
      };
      pending.set(toolCallId, terminal);
      context.activeRequest.pendingDurableToolTerminals = pending;
      // Execution completion is a transient semantic boundary: it immediately
      // settles the rendered spinner, but does not claim result durability.
      // The later persisted toolResult boundary upgrades this same lifecycle.
      emitSemanticCandidate(deps, context, {
        kind: 'tool.executionEnded',
        executionId: liveExecutionId(context, toolCallId),
        status: terminal.status,
        durationMs: terminal.durationMs,
      });
      // Parallel siblings still executing keep the turn in running_tool; only
      // the last execution enters the inter-turn preparation phase.
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase',
        phase: runningTools > 0 ? 'running_tool' : 'preparing',
        inactivityBudgetMs: nextLeaseMs,
      });
      // Publication is deliberately withheld until the SDK's persisted
      // toolResult message_end arrives with its stable sessionEntryId.
      // Tool results do not change the prompt footprint until the next
      // assistant usage lands at message_end. This call used to perform an
      // O(branch) SDK walk directly on the inter-turn critical path.
      return;
    }

    case 'message_end': {
      if (!context.activeRequest || !event.message) {
        if (context.activeRequest) emitRejectedObservation(deps, context, 'malformed_observation');
        return;
      }

      if (event.message.role === 'assistant') {
        context.activeRequest.mayNeedOverflowRecovery = mayNeedOverflowRecovery(context, event.message);
      }

      // SDK adapters can replay a durable assistant boundary after the first
      // message_end. The live accumulator owns the accepted terminal identity;
      // pending error/steering terminals cover the two durability-gated paths.
      if (event.message.role === 'assistant' && event.sessionEntryId) {
        const active = context.activeRequest;
        if (active.liveTurnAccumulator?.terminalDurableEntryId() === event.sessionEntryId
          || context.terminalLiveTurn?.accumulator.terminalDurableEntryId() === event.sessionEntryId
          || active.pendingErrorTerminal?.durableEntryId === event.sessionEntryId
          || active.pendingQueuedBoundaryTerminal?.durableEntryId === event.sessionEntryId) {
          return;
        }
      }

      if (event.message.role === 'custom') {
        if ((event.message as { customType?: string }).customType === 'pruning-result' && context.activeRequest.emittedPruningResultEntryId) {
          return;
        }
        // before_agent_start extensions (like skill-pruner) surface transcript
        // entries as message_end/custom events. Forward them live so the webview
        // can render pruning summaries before the assistant turn starts.
        const customMessageIndex = (context.activeRequest.customMessageIndex ?? 0) + 1;
        context.activeRequest.customMessageIndex = customMessageIndex;
        const message = mapCustomMessage(
          event.sessionEntryId ?? `${context.activeRequest.id}:custom:${customMessageIndex}`,
          event.message,
        );
        if (!message) {
          return;
        }

        deps.emit('message.custom', {
          requestId: context.activeRequest.id,
          ...(context.activeRequest.operationId ? { operationId: context.activeRequest.operationId } : {}),
          sessionPath: context.sessionPath,
          message,
        } satisfies CustomMessagePayload);
        // Custom messages carry no assistant usage, so context usage is stable.
        return;
      }

      if (event.message.role === 'toolResult') {
        const toolCallId = typeof (event.message as { toolCallId?: unknown }).toolCallId === 'string'
          ? (event.message as { toolCallId: string }).toolCallId
          : '';
        const terminal = context.activeRequest.pendingDurableToolTerminals?.get(toolCallId);
        if (!terminal || !event.sessionEntryId) {
          if (isBackendLivePipelineTraceEnabled()) {
            recordBackendLivePipelineTrace({
              stage: 'backend.observation.rejected',
              kind: 'failure',
              identifiers: {
                session: context.sessionPath,
                request: context.activeRequest.id,
                ...(toolCallId ? { tool: toolCallId } : {}),
              },
              eventKind: 'tool_terminal',
              reasonCode: terminal ? 'durability_mismatch' : 'owner_missing',
            });
          }
          emitRejectedObservation(deps, context, terminal ? 'malformed_payload' : 'owner_missing');
          return;
        }
        context.activeRequest.pendingDurableToolTerminals?.delete(toolCallId);
        const terminalDetailRoot = subagentDetailRoot(context, toolCallId);
        if (terminalDetailRoot && terminal.name?.trim().toLowerCase() === 'subagent') {
          deps.terminalizeSubagentDetail?.(terminalDetailRoot, event.sessionEntryId);
        }
        const transportTerminal = boundToolFinishedPayload({
          ...terminal,
          durableEntryId: event.sessionEntryId,
          ...(context.activeRequest.liveTurnAccumulator ? { canonicalLive: true } : {}),
        } satisfies ToolFinishedPayload);
        if (transportTerminal.result !== terminal.result || transportTerminal.input !== terminal.input) {
          logBackendDiagnostic('warn', 'tool.terminalTransportBounded', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            toolCallId,
            toolName: terminal.name,
          });
        }
        emitSemanticCandidate(deps, context, {
          kind: 'tool.terminal',
          executionId: liveExecutionId(context, toolCallId),
          status: terminal.status,
          result: transportTerminal.result,
          durationMs: terminal.durationMs,
          durableEntryId: event.sessionEntryId,
        });
        deps.emit('tool.finished', transportTerminal);
        if (isBackendLivePipelineTraceEnabled()) {
          const persistenceTrace = {
            stage: 'backend.persistence.confirmed' as const,
            kind: 'success' as const,
            identifiers: {
              session: context.sessionPath,
              request: context.activeRequest.id,
              message: event.sessionEntryId,
              tool: toolCallId,
            },
            eventKind: 'tool_terminal' as const,
          };
          if (terminal.name?.trim().toLowerCase() === 'subagent') {
            // The SDK has confirmed the durable entry, but exposes no serialized
            // append-byte counter. The bounded event above is transport bytes,
            // not evidence for this durability boundary.
            recordBackendLivePipelineTrace({
              ...persistenceTrace,
              payloadClass: 'terminal_append',
              availabilityReason: 'sdk_durability_boundary_exposes_no_serialized_byte_counter',
            });
          } else {
            recordBackendLivePipelineTrace(persistenceTrace);
          }
        }
        return;
      }

      if (event.message.role !== 'assistant' || !event.sessionEntryId) {
        if (event.message.role === 'assistant' && isBackendLivePipelineTraceEnabled()) {
          recordBackendLivePipelineTrace({
            stage: 'backend.observation.rejected',
            kind: 'failure',
            identifiers: { session: context.sessionPath, request: context.activeRequest.id },
            eventKind: 'turn_terminal',
            reasonCode: 'durability_mismatch',
          });
        }
        if (event.message.role === 'assistant') emitRejectedObservation(deps, context, 'malformed_payload');
        return;
      }

      clearSemanticLease(context);
      const messageId =
        context.activeRequest.currentMessageId
        ?? context.activeRequest.lastAssistantMessageId
        ?? `${context.activeRequest.id}:${context.activeRequest.messageIndex + 1}`;

      context.activeRequest.lastAssistantMessageId = messageId;
      context.activeRequest.currentMessageId = undefined;

      const durationMs = context.activeRequest.currentMessageStartedAt !== undefined
        ? Date.now() - context.activeRequest.currentMessageStartedAt
        : undefined;
      // Turn-latency breakdown, anchored on turnBoundaryAt (last tool end, or
      // prompt-send for the first turn) and turnStartedAt (SDK `turn_start`).
      // The provider boundary is the first content delta (providerFirstDeltaAt).
      // Each component is undefined when its anchoring event wasn't observed.
      const turnBoundaryAt = context.activeRequest.turnBoundaryAt;
      const turnStartedAt = context.activeRequest.turnStartedAt;
      const providerFirstDeltaAt = context.activeRequest.providerFirstDeltaAt;
      const turnLatencyMs =
        providerFirstDeltaAt !== undefined && turnBoundaryAt !== undefined
          ? Math.max(0, providerFirstDeltaAt - turnBoundaryAt)
          : undefined;
      const overheadMs =
        turnStartedAt !== undefined && turnBoundaryAt !== undefined
          ? Math.max(0, turnStartedAt - turnBoundaryAt)
          : undefined;
      const providerLatencyMs =
        providerFirstDeltaAt !== undefined && turnStartedAt !== undefined
          ? Math.max(0, providerFirstDeltaAt - turnStartedAt)
          : undefined;
      context.activeRequest.currentMessageStartedAt = undefined;
      const mergedErrorMessage = mergeAssistantErrorDetail(
        event.message.errorMessage,
        context.activeRequest.latestProviderIncident?.userMessage
          ?? context.activeRequest.lastRetryErrorMessage,
      );
      const assistantEventMessage = mergedErrorMessage === event.message.errorMessage
        ? event.message
        : { ...event.message, errorMessage: mergedErrorMessage };
      const transportFailure = providerTransportFailureDiagnostic(assistantEventMessage);
      if (transportFailure) {
        const transportDetails = transportFailure.details ?? {};
        logBackendDiagnostic('warn', 'provider.transportFailure', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          modelId: context.activeRequest.modelId,
          provider: context.activeRequest.provider,
          error: transportFailure.error?.message ?? mergedErrorMessage ?? 'provider transport failure',
          ...(transportFailure.error?.code !== undefined ? { closeCode: transportFailure.error.code } : {}),
          configuredTransport: transportDetails.configuredTransport,
          fallbackTransport: transportDetails.fallbackTransport,
          eventsEmitted: transportDetails.eventsEmitted,
          phase: transportDetails.phase,
          requestBytes: transportDetails.requestBytes,
        });
      }

      // A persisted assistant message may represent several provider turns when
      // intermediate tool-use messages are folded into the final durable turn.
      // Aggregate every queue observation retained since the previous emitted
      // terminal rather than attributing only the final provider turn.
      const providerQueueEntries = [...(context.activeRequest.providerQueueByTurn?.values() ?? [])];
      const providerQueue = providerQueueEntries.length === 0
        ? undefined
        : providerQueueEntries.reduce(
          (total, entry) => ({
            durationMs: total.durationMs + entry.durationMs,
            attemptCount: total.attemptCount + entry.attemptCount,
          }),
          { durationMs: 0, attemptCount: 0 },
        );
      const message = mapAssistantMessage(messageId, assistantEventMessage as any, durationMs, {
        modelId: context.activeRequest.modelId,
        provider: context.activeRequest.provider,
        thinkingLevel: context.activeRequest.thinkingLevel,
        turnLatencyMs,
        overheadMs,
        providerLatencyMs,
        providerQueueMs: providerQueue?.durationMs,
        providerQueueAttemptCount: providerQueue?.attemptCount,
      });

      message.durableEntryId = event.sessionEntryId;
      // Meter every durability-confirmed provider response, including the
      // tool-use intermediates deliberately folded into a later UI terminal.
      // This keeps active and interrupted long-running turns current without
      // publishing their heavy transcript state. Aggregate accounting
      // reconciles these samples against the eventual terminal run totals.
      deps.emit('auxiliary-llm.usage', {
        sessionPath: context.sessionPath,
        kind: 'assistant_message',
        sourceId: `assistant:${event.sessionEntryId ?? message.id}`,
        occurredAt: message.createdAt,
        ...(message.modelId ? { modelId: message.modelId } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        ...(context.activeRequest.operationId ? { parentOperationId: context.activeRequest.operationId } : {}),
        ...(message.usage ? {
          ...(message.usage.tokenChannelPresence?.input !== false
            ? { inputTokens: message.usage.inputTokens } : {}),
          ...(message.usage.tokenChannelPresence?.output !== false
            ? { outputTokens: message.usage.outputTokens } : {}),
          ...(message.usage.tokenChannelPresence?.cacheRead !== false
            ? { cacheReadTokens: message.usage.cacheReadTokens } : {}),
          ...(message.usage.tokenChannelPresence?.cacheWrite !== false
            ? { cacheWriteTokens: message.usage.cacheWriteTokens } : {}),
          providerTotalTokens: message.usage.totalTokens,
          ...(message.usage.reportedCostUsd !== undefined
            ? { reportedCostUsd: message.usage.reportedCostUsd }
            : {}),
        } : {
          instrumentationGap: true,
          instrumentationGapReason: 'The durable assistant response exposed no provider usage.',
        }),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(message.status === 'error' ? { outcome: 'failed' as const }
          : message.status === 'interrupted' ? { outcome: 'cancelled' as const } : {}),
      } satisfies AuxiliaryLlmUsagePayload);
      if (isBackendLivePipelineTraceEnabled()) {
        recordBackendLivePipelineTrace({
          stage: 'backend.persistence.confirmed',
          kind: 'success',
          identifiers: {
            session: context.sessionPath,
            request: context.activeRequest.id,
            message: event.sessionEntryId,
          },
          eventKind: 'turn_terminal',
        });
      }

      if (message.status !== 'error') {        context.activeRequest.lastRetryErrorMessage = undefined;
      }

      const stopReason = typeof event.message.stopReason === 'string' ? event.message.stopReason : '';
      const expectsToolExecution = stopReason === 'toolUse' || stopReason === 'tool_use';
      if (expectsToolExecution && context.activeRequest.liveTurnAccumulator) {
        // Steering is injected only after these tools settle. Retain the
        // durability-confirmed assistant candidate so that user-message
        // boundary can close this reply even though ordinary tool-use
        // intermediates remain folded while no queued message intervenes.
        context.activeRequest.pendingQueuedBoundaryTerminal = {
          durableMessage: message,
          durableEntryId: event.sessionEntryId,
        };
      } else if (!expectsToolExecution) {
        context.activeRequest.pendingQueuedBoundaryTerminal = undefined;
        // The queue observations above now belong to this emitted terminal.
        // Tool-use intermediates are not emitted, so retain their observations
        // until the later terminal that represents the complete durable turn.
        context.activeRequest.providerQueueByTurn?.clear();
      }
      if (!expectsToolExecution && context.activeRequest.liveTurnAccumulator) {
        const branch = context.session.sessionManager?.getBranch?.() as SessionEntryLike[] | undefined;
        const durableTurnFromBranch = branch
          ? [...mapTranscript(branch)].reverse().find((entry) => entry.role === 'assistant') ?? message
          : message;
        // The branch projection owns complete durable text/tool history, while
        // the just-finished message owns runtime-only timing/model metadata.
        const durableTurn = {
          ...durableTurnFromBranch,
          modelId: message.modelId ?? durableTurnFromBranch.modelId,
          provider: message.provider ?? durableTurnFromBranch.provider,
          thinkingLevel: message.thinkingLevel ?? durableTurnFromBranch.thinkingLevel,
          durationMs: message.durationMs ?? durableTurnFromBranch.durationMs,
          turnLatencyMs: message.turnLatencyMs,
          overheadMs: message.overheadMs,
          providerLatencyMs: message.providerLatencyMs,
          providerQueueMs: message.providerQueueMs,
          providerQueueAttemptCount: message.providerQueueAttemptCount,
          errorDetail: message.errorDetail ?? durableTurnFromBranch.errorDetail,
          durableEntryId: event.sessionEntryId,
        };
        const terminalCandidate = {
          durableMessage: durableTurn,
          durableEntryId: event.sessionEntryId,
          reason: message.status === 'interrupted' && context.activeRequest.aborted !== true
            ? resolveUnexpectedInterruptReason(message.errorDetail)
            : undefined,
        };
        if (message.status === 'error') {
          // message_end precedes agent_end, which alone tells us whether this
          // error is terminal or merely the failed attempt before an automatic
          // retry. Tombstoning here would make every later retry event stale.
          context.activeRequest.pendingErrorTerminal = terminalCandidate;
        } else {
          context.activeRequest.pendingErrorTerminal = undefined;
          emitSemanticCandidate(deps, context, {
            kind: 'turn.terminal',
            terminalKind: message.status === 'interrupted' ? 'interrupted' : 'completed',
            userInitiated: message.status === 'interrupted' ? context.activeRequest.aborted === true : undefined,
            ...terminalCandidate,
          });
        }
      }

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.finished', {
        requestId: context.activeRequest.id,
        ...(context.activeRequest.operationId ? { operationId: context.activeRequest.operationId } : {}),
        ...(context.activeRequest.operationAttempt !== undefined
          ? { operationAttempt: context.activeRequest.operationAttempt } : {}),
        sessionPath: context.sessionPath,
        message,
      } satisfies MessageFinishedPayload);

      if (message.status === 'interrupted') {
        const userInitiated = context.activeRequest.aborted === true;
        if (!userInitiated) {
          logBackendDiagnostic('info', 'message.interrupted', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId,
            modelId: context.activeRequest.modelId,
            reason: resolveUnexpectedInterruptReason(message.errorDetail),
          });
        }
        if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.aborted', {
          requestId: context.activeRequest.id,
          ...(context.activeRequest.operationId ? { operationId: context.activeRequest.operationId } : {}),
          ...(context.activeRequest.operationAttempt !== undefined
            ? { operationAttempt: context.activeRequest.operationAttempt } : {}),
          sessionPath: context.sessionPath,
          messageId,
          userInitiated,
          reason: userInitiated ? undefined : resolveUnexpectedInterruptReason(message.errorDetail),
        } satisfies MessageAbortedPayload);
      }

      deps.emitContextUsageChanged(context);
      return;
    }

    case 'agent_end': {
      // The SDK re-emits `agent_end` mid-retry with `willRetry: true` (after a
      // transient error, before the backoff sleep + retry turn). Finalizing
      // here would clear `activeRequest` — breaking the retry turn's streaming,
      // since `message_start` / `message_end` are gated on it — and flicker
      // `busy` false (then true again on the retry's `agent_start`). Skip
      // finalization on a will-retry `agent_end`; the final `agent_end`
      // (`willRetry: false`) performs the normal idle cleanup below.
      if (event.willRetry) {
        // Bug 6 watchdog: arm a watchdog bounding the willRetry window. If the
        // SDK's backoff/retry never completes (provider dies mid-backoff, or an
        // extension hook blocks the retry), `activeRequest` would stay set
        // forever with no observable failure. The watchdog emits
        // `operational-error` + `retry.stuck` after the backoff delay + grace so
        // the user can recover instead of reloading the window. Re-armed with
        // the real delayMs on `auto_retry_start`; cleared on `auto_retry_end` /
        // the final `agent_end willRetry:false`.
        // delayMs is unknown here (the SDK doesn't carry it on agent_end); use
        // 0 until auto_retry_start refines it (the grace alone bounds it).
        context.willRetryWatchdogClear = armWillRetryWatchdog(deps, context, 0);
        if (context.activeRequest) context.activeRequest.pendingErrorTerminal = undefined;
        return;
      }
      // agent_end closes one low-level attempt only. Pi may still perform
      // post-run compaction, retry, queued continuation, or tool/bash work;
      // retain request/busy ownership until the pinned agent_settled boundary.
      clearSemanticLease(context);
      deps.emitContextUsageChanged(context);
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      context.overflowRecoveryCandidate = context.activeRequest?.mayNeedOverflowRecovery
        ? context.activeRequest
        : undefined;
      return;
    }

    case 'agent_settled': {
      clearSemanticLease(context);
      const settledRequest = context.activeRequest;
      const requestId = context.activeRequest?.id;
      const operationId = context.activeRequest?.operationId;
      const operationAttempt = context.activeRequest?.operationAttempt;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const modelId = context.activeRequest?.modelId;
      const userInitiated = context.activeRequest?.aborted === true;
      const interruptedWithoutMessage = !!requestId && !messageId;
      const pendingExtensionCommand = context.pendingExtensionCommand;
      const extensionCommandWithoutAgent = (
        context.activeRequest?.extensionCommand === true && interruptedWithoutMessage
      ) || (
        pendingExtensionCommand !== undefined
        && pendingExtensionCommand.session === context.session
        && pendingExtensionCommand.sessionPath === context.sessionPath
        && pendingExtensionCommand.sessionOwnershipEpoch === (context.sessionOwnershipEpoch ?? 0)
        && (requestId === undefined || requestId === pendingExtensionCommand.requestId)
        && !messageId
      );
      const extensionCommandRequestId = pendingExtensionCommand?.requestId ?? requestId;
      const liveAccumulator = context.activeRequest?.liveTurnAccumulator;
      const pendingErrorTerminal = context.activeRequest?.pendingErrorTerminal;
      if (liveAccumulator && pendingErrorTerminal) {
        emitSemanticCandidate(deps, context, {
          kind: 'turn.terminal',
          terminalKind: 'error',
          ...pendingErrorTerminal,
        });
        context.activeRequest!.pendingErrorTerminal = undefined;
      }
      const watermark = liveAccumulator?.lifecycleWatermark();
      if (watermark) deps.emit('live.lifecycle', watermark);
      if (liveAccumulator) {
        context.terminalLiveTurn = { accumulator: liveAccumulator, expiresAt: Date.now() + 10_000 };
      }

      if (extensionCommandWithoutAgent && extensionCommandRequestId) {
        context.sendOperationLedger?.markFailed(operationId, 'MESSAGE_SEND_PRECOMMIT_FAILED', 'Extension command ended without starting an agent turn.');
        deps.emit('preflight.failed', {
          requestId: extensionCommandRequestId,
          ...(operationId ? { operationId } : {}),
          sessionPath: pendingExtensionCommand?.sessionPath ?? context.sessionPath,
          error: 'Extension command ended without starting an agent turn.',
        } satisfies PreflightFailedPayload);
      }
      if (pendingExtensionCommand?.requestId === extensionCommandRequestId) {
        context.pendingExtensionCommand = undefined;
      }
      deps.emitContextUsageChanged(context);

      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      if (context.activeRequest?.quotaSettlementTimer) {
        clearTimeout(context.activeRequest.quotaSettlementTimer);
        context.activeRequest.quotaSettlementTimer = undefined;
      }

      context.overflowRecoveryCandidate = undefined;
      // Clear activeRequest only at full SDK settlement. agent_end above is not
      // sufficient evidence because Pi can continue automatically afterwards.
      context.activeRequest = undefined;

      if (requestId && interruptedWithoutMessage && !settledRequest?.terminalWithoutMessageEmitted) {
        if (settledRequest) settledRequest.terminalWithoutMessageEmitted = true;
        if (!userInitiated) {
          logBackendDiagnostic('info', 'request.interruptedWithoutMessage', {
            requestId,
            sessionPath: context.sessionPath,
            modelId,
            reason: DEFAULT_UNEXPECTED_INTERRUPT_REASON,
          });
        }
        context.sendOperationLedger?.markFailed(
          operationId,
          'MESSAGE_OPERATION_ABORTED_BEFORE_COMMIT',
          userInitiated ? 'The message operation was cancelled before it started.' : DEFAULT_UNEXPECTED_INTERRUPT_REASON,
          userInitiated ? 'cancelled' : 'failed',
        );
        deps.emit('message.aborted', {
          requestId,
          ...(operationId ? { operationId } : {}),
          ...(operationAttempt !== undefined ? { operationAttempt } : {}),
          sessionPath: context.sessionPath,
          ...(operationId ? { outcome: userInitiated ? 'cancelled' as const : 'failed' as const } : {}),
          userInitiated,
          reason: userInitiated ? undefined : DEFAULT_UNEXPECTED_INTERRUPT_REASON,
        } satisfies MessageAbortedPayload);
      }

      const capabilities = buildSessionCapabilities(context);
      deps.emit('agent.settled', { sessionPath: context.sessionPath, capabilities });
      deps.emitBusyChanged(context, capabilities.billableActivity, capabilities);
      void deps.emitSessionOpened(context.sessionPath);
      void deps.emitSessionListChanged();
      return;
    }

    case 'compaction_start': {
      // Auto/manual compaction is a billable LLM call. Automatic compaction can
      // run after `agent_end`, while manual compaction has no active request;
      // the shared activity classifier keeps both paths interruptible until the
      // SDK reaches its terminal activity boundary.
      //
      // Capture the start time so `compaction_end` can compute `durationMs`
      // for the `pie.compaction-metrics` sidecar. Cleared on `compaction_end`
      // (whether successful or not).
      context.compactionStartedAt = Date.now();
      const manualOperation = event.reason === 'manual' ? context.manualCompactionRequest : undefined;
      // Manual compact first awaits agent abort and only then creates the SDK
      // compaction controller. Stop can win that gap; replay its cancellation
      // intent now that abortCompaction has an authoritative controller to hit,
      // before provider auth/hooks can advance to the billable request.
      if (event.reason === 'manual' && context.manualCompactionRequest?.cancelled) {
        context.session.abortCompaction?.();
      }
      const compactionCapabilities = buildSessionCapabilities(context, { compacting: true });
      deps.emitBusyChanged(context, true, compactionCapabilities);
      // Host-facing signal so the UI can show a live "Compacting…" indicator
      // (compaction emits no message_start/message_end, so busy alone reads as
      // a generic run).
      deps.emit('compaction.started', {
        sessionPath: context.sessionPath,
        ...(manualOperation?.operationId ? { operationId: manualOperation.operationId } : {}),
        ...(manualOperation?.operationAttempt !== undefined
          ? { operationAttempt: manualOperation.operationAttempt } : {}),
      } satisfies CompactionStartedPayload);
      return;
    }
    case 'compaction_end': {
      // The SDK's result/aborted fields are the terminal authority: a result is
      // success, an aborted event is cancellation, and a result-less event is
      // failure. Keep this mapping explicit instead of inferring success from
      // compaction_end itself, since the SDK emits the same boundary for all
      // three outcomes.
      const outcome: CompactionOutcome = event.aborted === true
        ? 'aborted'
        : event.result !== undefined && event.result !== null
          ? 'succeeded'
          : 'failed';
      const reason: CompactionReason | undefined = event.reason === 'manual'
        || event.reason === 'threshold'
        || event.reason === 'overflow'
        ? event.reason
        : undefined;
      const succeeded = outcome === 'succeeded';
      const manualOperation = event.reason === 'manual' ? context.manualCompactionRequest : undefined;
      if (manualOperation?.operationId) {
        if (succeeded) {
          context.sendOperationLedger?.markCommitted(manualOperation.operationId);
        } else {
          context.sendOperationLedger?.markFailed(
            manualOperation.operationId,
            outcome === 'aborted' ? 'MESSAGE_COMPACT_ABORTED' : 'MESSAGE_COMPACT_FAILED',
            event.errorMessage ?? `Manual history compaction ${outcome}.`,
            outcome === 'aborted' ? 'aborted' : 'failed',
          );
        }
      }

      // Native provider-overflow recovery reports agent_end(willRetry=false)
      // before compaction, then resumes with agent.continue() after a successful
      // compaction. Restore the finalized request before publishing the
      // refreshed snapshot or receiving continuation events.
      if (event.reason === 'overflow' && event.willRetry) {
        rearmPostAgentCompactionRequest(
          context,
          context.activeRequest ?? context.overflowRecoveryCandidate,
          Date.now(),
        );
        context.overflowRecoveryCandidate = undefined;
      } else {
        context.overflowRecoveryCandidate = undefined;
      }
      // SDK emits compaction_end before clearing its compaction controller.
      // Ignore only that ending window; retained request/queue/retry/bash
      // activity keeps the session busy until agent_settled. The manual marker
      // ends at the same authoritative event so it cannot keep capabilities
      // artificially busy until the request-handler promise resumes.
      if (event.reason === 'manual') context.manualCompactionRequest = undefined;
      const postCompactionCapabilities = buildSessionCapabilities(context, { compacting: false });
      deps.emitBusyChanged(
        context,
        postCompactionCapabilities.billableActivity,
        postCompactionCapabilities,
      );
      // A successful compaction has now appended the CompactionEntry. Refresh
      // both the context indicator and transcript so manual and automatic
      // compaction visibly surface the generated summary instead of only
      // appearing after reopen. Failed/aborted attempts append nothing.
      if (succeeded) {
        // Append the durable `pie.compaction-metrics` sidecar BEFORE
        // `emitSessionOpened` so the refreshed transcript scan picks it up and
        // attaches typed `CompactionSummaryDetails` to the compaction-summary
        // row. No-op when the SDK exposes no `appendCustomEntry` or the
        // compaction entry / token metrics can't be linked.
        appendCompactionMetricsSidecar(context, event);
        // The new prompt has not produced assistant usage yet, but the SDK
        // supplies its post-compaction token estimate. Publish that immediately
        // instead of clearing the indicator until the next user message.
        deps.emitContextUsageChanged(context, readPostCompactionEstimatedTokens(event.result));
        void deps.emitSessionOpened(context.sessionPath);
        void deps.emitSessionListChanged();
      }
      // Clear the captured start time whether the compaction succeeded or not,
      // so a later `compaction_start` (re-arm) does not inherit a stale mark.
      context.compactionStartedAt = undefined;
      // Emit a host-facing signal so run-analytics can count this billable
      // compaction LLM call against the run, and so the UI can clear its
      // "Compacting…" indicator and surface a "Compacted" chip. Token metrics
      // come from the SDK result when the compaction produced one.
      deps.emit('compaction.ended', {
        sessionPath: context.sessionPath,
        ...(manualOperation?.operationId ? { operationId: manualOperation.operationId } : {}),
        ...(manualOperation?.operationAttempt !== undefined
          ? { operationAttempt: manualOperation.operationAttempt } : {}),
        ...(reason !== undefined ? { reason } : {}),
        outcome,
        occurredAt: Date.now(),
        ...(succeeded ? {
          tokensBefore: readTokenCount((event.result as { tokensBefore?: unknown }).tokensBefore),
          estimatedTokensAfter: readPostCompactionEstimatedTokens(event.result),
        } : {}),
      } satisfies CompactionPayload);
      return;
    }
    case 'auto_retry_start': {
      clearSemanticLease(context);
      const startedAt = Date.now();
      finishRetryTiming(deps, context, startedAt);
      const incidentMessage = context.activeRequest?.latestProviderIncident?.userMessage;
      const surfacedErrorMessage = incidentMessage
        ?? nonEmptyTrimmed(event.errorMessage)
        ?? '';
      if (context.activeRequest) {
        const errorMessage = nonEmptyTrimmed(surfacedErrorMessage);
        context.activeRequest.lastRetryErrorMessage = errorMessage
          ?? context.activeRequest.lastRetryErrorMessage;
        context.activeRequest.lastProviderErrorForDiagnostics = errorMessage
          ?? context.activeRequest.lastProviderErrorForDiagnostics;
      }
      // Bug 6 watchdog: re-arm with the SDK's reported backoff delayMs so the
      // window matches the real retry cadence (not the conservative 0 from
      // agent_end willRetry). The grace is added on top.
      if (context.willRetryWatchdogClear !== undefined) {
        context.willRetryWatchdogClear = armWillRetryWatchdog(deps, context, event.delayMs ?? 0);
      }
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase',
        phase: 'retry_wait',
        inactivityBudgetMs: (event.delayMs ?? 0) + resolveWillRetryWatchdogGraceMs(),
      });
      const requestId = context.activeRequest?.id;
      const attempt = event.attempt ?? 0;
      const retryId = requestId ? `${requestId}:${attempt}` : undefined;
      if (context.activeRequest && retryId) {
        context.activeRequest.retryTiming = {
          retryId,
          attempt,
          startedAt,
          scheduledDelayMs: Math.max(0, event.delayMs ?? 0),
        };
      }
      deps.emit('retry.started', {
        sessionPath: context.sessionPath,
        attempt,
        maxAttempts: event.maxAttempts ?? 0,
        delayMs: event.delayMs ?? 0,
        errorMessage: surfacedErrorMessage,
        ...(requestId && retryId ? { requestId, retryId, startedAt } : {}),
      } satisfies RetryStartedPayload);
      return;
    }

    case 'auto_retry_end': {
      finishRetryTiming(deps, context, Date.now());
      if (context.activeRequest) {
        if (event.success === true) {
          context.activeRequest.lastRetryErrorMessage = undefined;
          context.activeRequest.pendingErrorTerminal = undefined;
          clearSettledProviderIncident(context);
        } else {
          const finalError = nonEmptyTrimmed(event.finalError);
          context.activeRequest.lastRetryErrorMessage = finalError
            ?? context.activeRequest.lastRetryErrorMessage;
          context.activeRequest.lastProviderErrorForDiagnostics = finalError
            ?? context.activeRequest.lastProviderErrorForDiagnostics;
        }
      }
      // Bug 6 watchdog: clear on retry completion (success or final failure).
      // The subsequent agent_end willRetry:false will re-clear (idempotent).
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase', phase: event.success === true ? 'waiting_provider' : 'aborting', inactivityBudgetMs: 120_000,
      });
      deps.emit('retry.ended', {
        sessionPath: context.sessionPath,
        success: event.success === true,
        attempt: event.attempt ?? 0,
        finalError: event.finalError,
      } satisfies RetryEndedPayload);
      return;
    }

    case 'turn_end':
      return;

    default:
      emitRejectedObservation(deps, context, 'unsupported_observation');
      return;
  }
}

function sdkTracePhase(eventType: string) {
  if (eventType.startsWith('tool_execution')) return 'tool_execution' as const;
  if (eventType.includes('retry')) return 'retry_backoff' as const;
  return 'semantic_stream' as const;
}

function sdkTraceEventKind(eventType: string) {
  if (eventType === 'message_update') return 'text' as const;
  if (eventType === 'tool_execution_start') return 'tool_start' as const;
  if (eventType === 'tool_execution_update') return 'tool_progress' as const;
  if (eventType === 'tool_execution_end') return 'tool_terminal' as const;
  if (eventType === 'message_start') return 'turn_start' as const;
  if (eventType === 'message_end' || eventType === 'agent_settled') return 'turn_terminal' as const;
  return 'control' as const;
}

function canonicalTraceEventKind(candidate: BackendSemanticCandidate['kind']) {
  if (candidate === 'turn.text') return 'text' as const;
  if (candidate === 'turn.reasoning') return 'reasoning' as const;
  if (candidate === 'turn.toolDraft') return 'tool_draft' as const;
  if (candidate === 'tool.started') return 'tool_start' as const;
  if (candidate === 'tool.progress') return 'tool_progress' as const;
  if (candidate === 'tool.executionEnded' || candidate === 'tool.terminal') return 'tool_terminal' as const;
  if (candidate === 'turn.started') return 'turn_start' as const;
  if (candidate === 'turn.terminal') return 'turn_terminal' as const;
  return 'control' as const;
}

/**
 * Resolve a finished tool's measured execution interval. Missing starts stay
 * unknown; they must not be converted into plausible zero-duration calls.
 */
function resolveUnexpectedInterruptReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_UNEXPECTED_INTERRUPT_REASON;
}

function resolveToolTiming(
  context: SessionContext,
  toolCallId: string,
): { startedAt: number; durationMs: number } | undefined {
  const startedAt = context.activeRequest?.toolStartTimes?.get(toolCallId);
  context.activeRequest?.toolStartTimes?.delete(toolCallId);
  context.activeRequest?.toolParallelGroupByCallId?.delete(toolCallId);
  if (startedAt === undefined) return undefined;
  return { startedAt, durationMs: Math.max(0, Date.now() - startedAt) };
}
