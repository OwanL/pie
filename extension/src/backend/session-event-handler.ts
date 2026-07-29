import { randomUUID } from 'node:crypto';

import type {
  CompactionSummaryDetails,
  CustomMessagePayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  MessageToolCallDeltaPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../shared/protocol';
import { COMPACTION_METRICS_CUSTOM_TYPE } from '../shared/protocol';
import type { SdkSessionEvent } from './sdk';
import type { BackendSemanticCandidate } from './live-turn-accumulator';
import type { TurnSemanticEnvelope } from '../shared/live-pipeline-protocol';
import { estimateCumulativeSubagentTokens, normalizeToolProgress } from './tool-progress-normalizer';
import {
  mapAssistantMessage,
  mapCustomMessage,
  mapTranscript,
  providerTransportFailureDiagnostic,
  type SessionEntryLike,
} from './transcript';
import type { SessionContext } from './server-types';
import { backendLog, type BackendLogLevel } from './log';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';

/**
 * Assistant-message streaming event types that count as the provider "replying
 * with anything" — the first of these after a `message_start` stamps
 * `providerFirstDeltaAt`, anchoring the provider-latency side of the turn-latency
 * split. Covers text, thinking, and tool-call content blocks so pure tool-call
 * turns (no text/thinking) are still measured.
 */
export const TOOL_PROGRESS_MAX_BYTES = 256 * 1024;

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

/** Keep high-frequency progress events transport-safe. The terminal
 * tool.finished result remains authoritative and is never bounded here. */
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

const FIRST_CONTENT_EVENT_TYPES = new Set([
  'text_start',
  'text_delta',
  'thinking_start',
  'thinking_delta',
  'toolcall_start',
  'toolcall_delta',
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
  emitBusyChanged(context: SessionContext, busy: boolean): void;
  emitContextUsageChanged(context: SessionContext, postCompactionEstimatedTokens?: number): void;
  emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void>;
  emitSessionListChanged(): Promise<void>;
  /** Terminalize a stuck runtime locally and replace it before the session becomes reusable. */
  recoverStuckSession(context: SessionContext, reason: string): void;
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
    sessionPath: context.sessionPath,
    message,
  } satisfies CustomMessagePayload);
}

// Some providers keep extended reasoning private, so a healthy response may be
// semantically silent until the reasoning phase completes. Umans is routinely
// much slower than other providers and does not always expose reasoning deltas;
// give it a provider-specific lease rather than weakening the stuck-session
// guard for every provider. The environment override remains authoritative for
// diagnostics and operators who need a different global policy.
const PROVIDER_SEMANTIC_INACTIVITY_MS = 360_000;
const UMANS_SEMANTIC_INACTIVITY_MS = 15 * 60_000;
const TOOL_INACTIVITY_MS = 30 * 60_000;
function configuredLeaseMs(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveProviderSemanticInactivityMs(provider?: string): number {
  const fallback = provider?.toLowerCase() === 'umans'
    ? UMANS_SEMANTIC_INACTIVITY_MS
    : PROVIDER_SEMANTIC_INACTIVITY_MS;
  return configuredLeaseMs('PIE_PROVIDER_SEMANTIC_INACTIVITY_MS', fallback);
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
    deps.emit('operational-error', {
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
  const envelope = accumulator.observe(candidate, occurredAt);
  if (!envelope) return undefined;
  deps.emit('live.semantic', envelope);
  if (envelope.kind === 'observation.rejected' && envelope.reason === 'payload_oversize') {
    logBackendDiagnostic('warn', 'semantic.payloadOversize', { candidateKind: candidate.kind });
    deps.emit('operational-error', {
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
    });
  }
  switch (event.type) {
    case 'agent_start': {
      // before_agent_start extensions persist their injected custom message
      // before agent_start. Read it from the authoritative branch so pruning
      // summaries do not depend on the SDK also producing message_end/custom.
      emitLatestPruningResult(deps, context);
      deps.emitBusyChanged(context, true);
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
      context.activeRequest.providerTurnSequence = (context.activeRequest.providerTurnSequence ?? 0) + 1;
      const liveSeq = context.activeRequest.liveTurnAccumulator?.currentSeq ?? 0;
      if (liveSeq === 0) {
        emitSemanticCandidate(deps, context, { kind: 'turn.started' }, context.activeRequest.turnStartedAt);
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'preparing', inactivityBudgetMs: 120_000,
        }, context.activeRequest.turnStartedAt);
      } else {
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: 120_000,
        }, context.activeRequest.turnStartedAt);
      }
      return;
    }

    case 'message_start': {
      // Steering: the agent loop emits `message_start` with role 'user'
      // when it injects a queued steering message into the current turn
      // (delivered after the in-flight tool calls finish, before the next LLM
      // call). Forward it as `message.queuedDelivered` so the host promotes its
      // optimistic 'queued' transcript message to 'completed'. This fires
      // within the same agent run (context.activeRequest is still the original
      // send's request); the subsequent assistant `message_start` for this turn
      // appends a new assistant message under the same requestId, reusing the
      // existing streaming path. The normal (non-queued) user prompt does NOT
      // emit a user-role message_start — the host inserts that optimistically
      // — so this branch only fires for injected queued messages.
      if (event.message?.role === 'user') {
        // Handoff §F: correlate this delivery to the host's optimistic localId
        // by shifting the next id from the FIFO queue we built in
        // `handleMessageSend`. An empty sentinel means the original send carried
        // no localId (legacy host) — fall back to FIFO matching in the reducer.
        const queuedLocalIds = context.queuedLocalIds;
        const localId = queuedLocalIds && queuedLocalIds.length > 0
          ? queuedLocalIds.shift()
          : undefined;
        deps.emit('message.queuedDelivered', {
          sessionPath: context.sessionPath,
          text: extractUserMessageText(event.message),
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
      if (context.activeRequest.messageIndex === 1 && context.activeRequest.promptSafetyTimer) {
        clearTimeout(context.activeRequest.promptSafetyTimer);
        context.activeRequest.promptSafetyTimer = undefined;
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
        context.activeRequest.lastProviderErrorForDiagnostics = undefined;
        clearSettledProviderIncident(context);
        renewSemanticLease(deps, context);
        emitSemanticCandidate(deps, context, {
          kind: 'turn.text', delta: event.assistantMessageEvent.delta ?? '',
        });
        if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.delta', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.currentMessageId,
          delta: event.assistantMessageEvent.delta ?? '',
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
      if (toolCallEvent?.type === 'toolcall_start' || toolCallEvent?.type === 'toolcall_delta') {
        const contentIndex = toolCallEvent.contentIndex;
        const content = contentIndex === undefined
          ? undefined
          : toolCallEvent.partial?.content?.[contentIndex];
        if (content?.type === 'toolCall' && content.id && content.name) {
          context.activeRequest.lastProviderErrorForDiagnostics = undefined;
          clearSettledProviderIncident(context);
          renewSemanticLease(deps, context);
          emitSemanticCandidate(deps, context, {
            kind: 'turn.toolDraft',
            toolCallId: content.id,
            name: content.name,
            argumentsJson: toolCallEvent.type === 'toolcall_delta' ? toolCallEvent.delta ?? '' : '',
          });
          if (!context.activeRequest.liveTurnAccumulator) deps.emit('message.toolCallDelta', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId: context.activeRequest.currentMessageId,
            toolCallId: content.id,
            name: content.name,
            delta: toolCallEvent.type === 'toolcall_delta' ? toolCallEvent.delta ?? '' : '',
          } satisfies MessageToolCallDeltaPayload);
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
      toolStartTimes.set(toolCallId, startedAt);
      parallelGroups.set(toolCallId, parallelGroupId);
      context.activeRequest.toolStartTimes = toolStartTimes;
      context.activeRequest.toolParallelGroupByCallId = parallelGroups;
      const toolStartMetadata = context.activeRequest.toolStartMetadata
        ?? new Map<string, { name: string; input: unknown }>();
      toolStartMetadata.set(toolCallId, { name: event.toolName ?? '', input: event.args });
      context.activeRequest.toolStartMetadata = toolStartMetadata;

      const executionId = liveExecutionId(context, toolCallId);
      emitSemanticCandidate(deps, context, {
        kind: 'tool.started',
        executionId,
        parentExecutionId: null,
        rootExecutionId: executionId,
        toolCallId,
        name: event.toolName ?? '',
        input: event.args,
        startedAt,
        parallelGroupId,
      }, startedAt);

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('tool.started', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: event.toolName ?? '',
        input: event.args,
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
      emitSemanticCandidate(deps, context, {
        kind: 'tool.progress',
        executionId: liveExecutionId(context, event.toolCallId ?? ''),
        preview: normalizeToolProgress(event.toolName ?? '', event.partialResult),
      });

      if (!context.activeRequest.liveTurnAccumulator) deps.emit('tool.progress', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        preview: normalizeToolProgress(event.toolName ?? '', event.partialResult),
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

      clearSemanticLease(context);
      // Advance the turn-latency window origin to this tool's finish time. The
      // most recent `tool_execution_end` wins, so parallel/sequential batches
      // anchor on the last tool to finish.
      context.activeRequest.turnBoundaryAt = Date.now();

      const toolCallId = event.toolCallId?.trim() ?? '';
      if (!toolCallId) {
        emitRejectedObservation(deps, context, 'malformed_observation');
        return;
      }
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
      const terminal: ToolFinishedPayload = {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: toolName,
        input: event.args !== undefined ? event.args : startMetadata?.input,
        result: event.result,
        status: event.isError ? 'failed' : 'completed',
        startedAt: timing?.startedAt,
        durationMs: timing?.durationMs,
      };
      const pending = context.activeRequest.pendingDurableToolTerminals
        ?? new Map<string, ToolFinishedPayload>();
      pending.set(toolCallId, terminal);
      context.activeRequest.pendingDurableToolTerminals = pending;
      // The observed end consumes a semantic sequence immediately while its
      // terminal remains durability-gated. Parallel siblings still executing
      // keep the turn in running_tool; only the last execution enters the
      // inter-turn preparation phase.
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase',
        phase: (context.activeRequest.toolStartTimes?.size ?? 0) > 0 ? 'running_tool' : 'preparing',
        inactivityBudgetMs: 120_000,
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
        emitSemanticCandidate(deps, context, {
          kind: 'tool.terminal',
          executionId: liveExecutionId(context, toolCallId),
          status: terminal.status,
          result: terminal.result,
          durationMs: terminal.durationMs,
          durableEntryId: event.sessionEntryId,
        });
        deps.emit('tool.finished', {
          ...terminal,
          durableEntryId: event.sessionEntryId,
          ...(context.activeRequest.liveTurnAccumulator ? { canonicalLive: true } : {}),
        } satisfies ToolFinishedPayload);
        if (isBackendLivePipelineTraceEnabled()) {
          recordBackendLivePipelineTrace({
            stage: 'backend.persistence.confirmed',
            kind: 'success',
            identifiers: {
              session: context.sessionPath,
              request: context.activeRequest.id,
              message: event.sessionEntryId,
              tool: toolCallId,
            },
            eventKind: 'tool_terminal',
          });
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
      if (!expectsToolExecution) {
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
      // `busy` false (then true again on the retry's `agent_start`), which
      // also prematurely fires `session_finished` deferred triggers. Skip
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
      clearSemanticLease(context);
      const requestId = context.activeRequest?.id;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const modelId = context.activeRequest?.modelId;
      const userInitiated = context.activeRequest?.aborted === true;
      const interruptedWithoutMessage = !!requestId && !messageId;
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

      deps.emitBusyChanged(context, false);
      deps.emitContextUsageChanged(context);

      // Bug 6 watchdog: clear on the final (non-retrying) agent_end.
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      if (context.activeRequest?.quotaSettlementTimer) {
        clearTimeout(context.activeRequest.quotaSettlementTimer);
        context.activeRequest.quotaSettlementTimer = undefined;
      }

      // Clear activeRequest BEFORE emitting session.opened so the payload
      // sees the final idle state instead of a stale in-progress request.
      context.activeRequest = undefined;

      void deps.emitSessionOpened(context.sessionPath);
      void deps.emitSessionListChanged();

      if (requestId && interruptedWithoutMessage) {
        if (!userInitiated) {
          logBackendDiagnostic('info', 'request.interruptedWithoutMessage', {
            requestId,
            sessionPath: context.sessionPath,
            modelId,
            reason: DEFAULT_UNEXPECTED_INTERRUPT_REASON,
          });
        }
        deps.emit('message.aborted', {
          requestId,
          sessionPath: context.sessionPath,
          userInitiated,
          reason: userInitiated ? undefined : DEFAULT_UNEXPECTED_INTERRUPT_REASON,
        } satisfies MessageAbortedPayload);
      }

      return;
    }

    case 'compaction_start': {
      // Auto/manual compaction is a billable LLM call the SDK runs AFTER
      // `agent_end` (in `_handlePostAgentRun`) — by which point `agent_end`
      // already emitted busy=false (Stop button gone) and cleared
      // `activeRequest`. Without re-arming busy here, the session reads idle
      // while compaction still bills ("appears stopped but burning money") and
      // cannot be interrupted. Re-arm running so the Stop button stays
      // available; `activeRequest` is intentionally NOT re-armed (compaction
      // emits no message_start/message_end, which require it). `compaction_end`
      // (or a continuation turn's `agent_start`) restores idle.
      //
      // `session_finished` deferred triggers are unaffected: they already
      // fired at `agent_end`'s busy=false; the `compaction_end` re-fire is a
      // no-op (`DeferredTriggerRegistry.fire` is idempotent once consumed).
      //
      // Capture the start time so `compaction_end` can compute `durationMs`
      // for the `pie.compaction-metrics` sidecar. Cleared on `compaction_end`
      // (whether successful or not).
      context.compactionStartedAt = Date.now();
      deps.emitBusyChanged(context, true);
      return;
    }
    case 'compaction_end': {
      // `willRetry` also marks Pie's hard-threshold between-turn continuation:
      // the current agent loop resumes directly after this awaited compaction,
      // without another `agent_start`. Keep busy asserted in that case. Native
      // overflow recovery does emit another `agent_start`, so retaining busy
      // also removes its transient idle flicker. A terminal/manual/soft
      // compaction clears busy as before.
      if (!event.willRetry) deps.emitBusyChanged(context, false);
      // A successful compaction has now appended the CompactionEntry. Refresh
      // both the context indicator and transcript so manual and automatic
      // compaction visibly surface the generated summary instead of only
      // appearing after reopen. Failed/aborted attempts append nothing.
      if (event.result) {
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
      // compaction LLM call against the run.
      deps.emit('compaction.ended', { sessionPath: context.sessionPath });
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

function sdkTraceEventKind(eventType: string) {
  if (eventType === 'message_update') return 'text' as const;
  if (eventType === 'tool_execution_start') return 'tool_start' as const;
  if (eventType === 'tool_execution_update') return 'tool_progress' as const;
  if (eventType === 'tool_execution_end') return 'tool_terminal' as const;
  if (eventType === 'message_start') return 'turn_start' as const;
  if (eventType === 'message_end' || eventType === 'agent_end') return 'turn_terminal' as const;
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
