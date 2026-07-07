import type {
  CustomMessagePayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryStartedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../shared/protocol';
import type { SdkSessionEvent } from './sdk';
import { mapAssistantMessage, mapCustomMessage } from './transcript';
import type { SessionContext } from './server-types';

/**
 * Assistant-message streaming event types that count as the provider "replying
 * with anything" — the first of these after a `message_start` stamps
 * `providerFirstDeltaAt`, anchoring the provider-latency side of the turn-latency
 * split. Covers text, thinking, and tool-call content blocks so pure tool-call
 * turns (no text/thinking) are still measured.
 */
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
  }, windowMs);
  return () => {
    if (context.willRetryWatchdogTimer) {
      clearTimeout(context.willRetryWatchdogTimer);
      context.willRetryWatchdogTimer = undefined;
    }
  };
}

function logBackendDiagnostic(event: string, payload: Record<string, unknown>): void {
  process.stderr.write(`[pie:backend] ${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: 'backend-session',
    event,
    ...payload,
  })}\n`);
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
  if (!isGenericTerminalStreamError(direct)) {
    return direct;
  }
  if (direct.includes(upstream)) {
    return direct;
  }
  return `${direct}\n\nUpstream error: ${upstream}`;
}

/** Best-effort extraction of plain text from an injected queued user message's
 *  content. The host promotes 'queued' transcript messages by FIFO order (the
 *  SDK drains the follow-up queue one at a time in enqueue order), so this text
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
  emitContextUsageChanged(context: SessionContext): void;
  emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void>;
  emitSessionListChanged(): Promise<void>;
}

export function handleSdkSessionEvent(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
): void {
  switch (event.type) {
    case 'agent_start': {
      deps.emitBusyChanged(context, true);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'turn_start': {
      // `turn_start` fires at the start of every turn, before request building
      // (`convertToLlm`, auth resolution) and the provider HTTP dispatch. It is
      // the cleanest observable boundary between serial inter-turn work on our
      // side and the provider request: overhead = turnBoundaryAt → turnStartedAt,
      // provider = turnStartedAt → first reply token.
      if (!context.activeRequest) {
        return;
      }
      context.activeRequest.turnStartedAt = Date.now();
      return;
    }

    case 'message_start': {
      // Steering (FollowUp): the agent loop emits `message_start` with
      // role 'user' when it injects a queued follow-up message into a turn.
      // Forward it as `message.queuedDelivered` so the host promotes its
      // optimistic 'queued' transcript message to 'completed'. This fires
      // within the same agent run (context.activeRequest is still the original
      // send's request); the subsequent assistant `message_start` for this
      // follow-up turn appends a new assistant message under the same
      // requestId, reusing the existing streaming path. The normal (non-queued)
      // user prompt does NOT emit a user-role message_start — the host inserts
      // that optimistically — so this branch only fires for injected queued
      // messages.
      if (event.message?.role === 'user') {
        deps.emit('message.queuedDelivered', {
          sessionPath: context.sessionPath,
          text: extractUserMessageText(event.message),
        } satisfies QueuedDeliveredPayload);
        return;
      }
      if (event.message?.role !== 'assistant' || !context.activeRequest) {
        return;
      }
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

      deps.emit('message.started', {
        requestId: context.activeRequest.id,
        messageId: context.activeRequest.currentMessageId,
        sessionPath: context.sessionPath,
        modelId: context.activeRequest.modelId,
        thinkingLevel: context.activeRequest.thinkingLevel,
      } satisfies MessageStartedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'message_update': {
      if (event.message?.role !== 'assistant' || !context.activeRequest?.currentMessageId) {
        return;
      }

      if (event.assistantMessageEvent?.type === 'text_delta') {
        deps.emit('message.delta', {
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
          deps.emit('message.thinking', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId: context.activeRequest.currentMessageId,
            thinking: thinkingContent,
          } satisfies MessageThinkingPayload);
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
        return;
      }

      // Diagnostic: log tool execution start to stderr for debugging file-changes tracking
      process.stderr.write(`[pie:backend] tool_execution_start: ${event.toolName} args=${JSON.stringify(event.args)?.slice(0, 200)}\n`);

      const toolCallId = event.toolCallId ?? '';
      const startedAt = Date.now();
      const toolStartTimes = context.activeRequest.toolStartTimes ?? new Map<string, number>();
      toolStartTimes.set(toolCallId, startedAt);
      context.activeRequest.toolStartTimes = toolStartTimes;

      deps.emit('tool.started', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: event.toolName ?? '',
        input: event.args,
        startedAt,
      } satisfies ToolStartedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'tool_execution_update': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        return;
      }

      deps.emit('tool.progress', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        partialResult: event.partialResult,
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
        return;
      }

      // Advance the turn-latency window origin to this tool's finish time. The
      // most recent `tool_execution_end` wins, so parallel/sequential batches
      // anchor on the last tool to finish.
      context.activeRequest.turnBoundaryAt = Date.now();

      if (event.isError) {
        logBackendDiagnostic('tool.failed', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          toolCallId: event.toolCallId ?? '',
          toolName: event.toolName ?? '',
          result: summarizePayload(event.result),
        });
      }

      deps.emit('tool.finished', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        result: event.result,
        status: event.isError ? 'failed' : 'completed',
        durationMs: resolveToolDurationMs(context, event.toolCallId ?? ''),
      } satisfies ToolFinishedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'message_end': {
      if (!context.activeRequest || !event.message) {
        return;
      }

      if (event.message.role === 'custom') {
        // before_agent_start extensions (like skill-pruner) surface transcript
        // entries as message_end/custom events. Forward them live so the webview
        // can render pruning summaries before the assistant turn starts.
        const customMessageIndex = (context.activeRequest.customMessageIndex ?? 0) + 1;
        context.activeRequest.customMessageIndex = customMessageIndex;
        const message = mapCustomMessage(
          `${context.activeRequest.id}:custom:${customMessageIndex}`,
          event.message,
        );
        if (!message) {
          deps.emitContextUsageChanged(context);
          return;
        }

        deps.emit('message.custom', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          message,
        } satisfies CustomMessagePayload);
        deps.emitContextUsageChanged(context);
        return;
      }

      if (event.message.role !== 'assistant') {
        return;
      }

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
        context.activeRequest.lastRetryErrorMessage,
      );
      const assistantEventMessage = mergedErrorMessage === event.message.errorMessage
        ? event.message
        : { ...event.message, errorMessage: mergedErrorMessage };

      const message = mapAssistantMessage(messageId, assistantEventMessage as any, durationMs, {
        modelId: context.activeRequest.modelId,
        thinkingLevel: context.activeRequest.thinkingLevel,
        turnLatencyMs,
        overheadMs,
        providerLatencyMs,
      });

      if (message.status !== 'error') {
        context.activeRequest.lastRetryErrorMessage = undefined;
      }

      deps.emit('message.finished', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        message,
      } satisfies MessageFinishedPayload);

      if (message.status === 'interrupted') {
        const userInitiated = context.activeRequest.aborted === true;
        if (!userInitiated) {
          logBackendDiagnostic('message.interrupted', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId,
            modelId: context.activeRequest.modelId,
            reason: resolveUnexpectedInterruptReason(message.errorDetail),
          });
        }
        deps.emit('message.aborted', {
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
        return;
      }
      const requestId = context.activeRequest?.id;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const modelId = context.activeRequest?.modelId;
      const userInitiated = context.activeRequest?.aborted === true;
      const interruptedWithoutMessage = !!requestId && !messageId;

      deps.emitBusyChanged(context, false);
      deps.emitContextUsageChanged(context);

      // Bug 6 watchdog: clear on the final (non-retrying) agent_end.
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }

      // Clear activeRequest BEFORE emitting session.opened so the payload
      // sees the final idle state instead of a stale in-progress request.
      context.activeRequest = undefined;

      void deps.emitSessionOpened(context.sessionPath);
      void deps.emitSessionListChanged();

      if (requestId && interruptedWithoutMessage) {
        if (!userInitiated) {
          logBackendDiagnostic('request.interruptedWithoutMessage', {
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

    case 'auto_retry_start': {
      if (context.activeRequest) {
        context.activeRequest.lastRetryErrorMessage = nonEmptyTrimmed(event.errorMessage)
          ?? context.activeRequest.lastRetryErrorMessage;
      }
      // Bug 6 watchdog: re-arm with the SDK's reported backoff delayMs so the
      // window matches the real retry cadence (not the conservative 0 from
      // agent_end willRetry). The grace is added on top.
      if (context.willRetryWatchdogClear !== undefined) {
        context.willRetryWatchdogClear = armWillRetryWatchdog(deps, context, event.delayMs ?? 0);
      }
      deps.emit('retry.started', {
        sessionPath: context.sessionPath,
        attempt: event.attempt ?? 0,
        maxAttempts: event.maxAttempts ?? 0,
        delayMs: event.delayMs ?? 0,
        errorMessage: event.errorMessage ?? '',
      } satisfies RetryStartedPayload);
      return;
    }

    case 'auto_retry_end': {
      if (context.activeRequest) {
        if (event.success === true) {
          context.activeRequest.lastRetryErrorMessage = undefined;
        } else {
          context.activeRequest.lastRetryErrorMessage = nonEmptyTrimmed(event.finalError)
            ?? context.activeRequest.lastRetryErrorMessage;
        }
      }
      // Bug 6 watchdog: clear on retry completion (success or final failure).
      // The subsequent agent_end willRetry:false will re-clear (idempotent).
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      deps.emit('retry.ended', {
        sessionPath: context.sessionPath,
        success: event.success === true,
        attempt: event.attempt ?? 0,
        finalError: event.finalError,
      } satisfies RetryEndedPayload);
      return;
    }

    default:
      return;
  }
}

/**
 * Resolve the wall-clock execution time for a finished tool call using the
 * start timestamp recorded at `tool_execution_start`. Falls back to 0 when the
 * start was never seen (e.g. an end event arrives without a matching start).
 */
function resolveUnexpectedInterruptReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_UNEXPECTED_INTERRUPT_REASON;
}

function resolveToolDurationMs(context: SessionContext, toolCallId: string): number {
  const startedAt = context.activeRequest?.toolStartTimes?.get(toolCallId);
  context.activeRequest?.toolStartTimes?.delete(toolCallId);
  if (startedAt === undefined) {
    return 0;
  }
  return Math.max(0, Date.now() - startedAt);
}
