import type {
  CustomMessagePayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
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
      if (event.message?.role !== 'assistant' || !context.activeRequest) {
        return;
      }
      context.activeRequest.messageIndex += 1;
      context.activeRequest.currentMessageId = `${context.activeRequest.id}:${context.activeRequest.messageIndex}`;
      context.activeRequest.lastAssistantMessageId = context.activeRequest.currentMessageId;
      context.activeRequest.currentMessageStartedAt = Date.now();
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
      const message = mapAssistantMessage(messageId, event.message as any, durationMs, {
        modelId: context.activeRequest.modelId,
        thinkingLevel: context.activeRequest.thinkingLevel,
        turnLatencyMs,
        overheadMs,
        providerLatencyMs,
      });
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
      const requestId = context.activeRequest?.id;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const modelId = context.activeRequest?.modelId;
      const userInitiated = context.activeRequest?.aborted === true;
      const interruptedWithoutMessage = !!requestId && !messageId;

      deps.emitBusyChanged(context, false);
      deps.emitContextUsageChanged(context);

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
