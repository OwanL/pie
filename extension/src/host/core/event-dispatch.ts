import type {
  AuxiliaryLlmUsagePayload,
  BusyChangedPayload,
  CompactionPayload,
  CompactionStartedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  EventEnvelope,
  ExtensionUIRequestPayload,
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
} from '../../shared/protocol';
import {
  isAuxiliaryLlmUsagePayload,
  isBusyChangedPayload,
  isCompactionPayload,
  isCompactionStartedPayload,
  isContextUsageChangedPayload,
  isCustomMessagePayload,
  isErrorPayload,
  isExtensionUIRequestPayload,
  isMessageAbortedPayload,
  isMessageDeltaPayload,
  isMessageFinishedPayload,
  isMessageStartedPayload,
  isMessageThinkingPayload,
  isMessageToolCallDeltaPayload,
  isOperationalErrorPayload,
  isPreflightFailedPayload,
  isQueuedDeliveredPayload,
  isRetryEndedPayload,
  isRetryMeasuredPayload,
  isRetryStartedPayload,
  isRetryStuckPayload,
  isSessionListChangedPayload,
  isSessionOpenedPayload,
  isToolFinishedPayload,
  isToolProgressPayload,
  isToolStartedPayload,
} from '../../shared/protocol/event-payloads.js';
import { appendPieLog } from '../util/pie-log.js';
import { isLivePipelineTraceEnabled, recordLivePipelineTrace } from '../util/live-pipeline-trace-runtime.js';
import { isLiveLifecycleWatermark, isTurnSemanticEnvelope, type LiveLifecycleWatermark, type TurnSemanticEnvelope } from '../../shared/live-pipeline-protocol.js';
import { isCoordinatorToHostDetailMessage, type CoordinatorToHostDetailMessage } from '../../shared/protocol/subagent-detail.js';

export interface SessionBackendEventHandlers {
  onSessionOpened(payload: SessionOpenedPayload): void;
  onTurnSemantic(payload: TurnSemanticEnvelope): void;
  onLiveLifecycle(payload: LiveLifecycleWatermark): void;
  onSessionListChanged(payload: SessionListChangedPayload): void;
  onMessageStarted(payload: MessageStartedPayload): void;
  onMessageDelta(payload: MessageDeltaPayload): void;
  onMessageThinking(payload: MessageThinkingPayload): void;
  onMessageToolCallDelta(payload: MessageToolCallDeltaPayload): void;
  onToolStarted(payload: ToolStartedPayload): void;
  onToolFinished(payload: ToolFinishedPayload): void;
  onToolProgress(payload: ToolProgressPayload): void;
  onMessageFinished(payload: MessageFinishedPayload): void;
  onCustomMessage(payload: CustomMessagePayload): void;
  onMessageAborted(payload: MessageAbortedPayload): void;
  onPreflightFailed(payload: PreflightFailedPayload): void;
  onQueuedDelivered(payload: QueuedDeliveredPayload): void;
  onRetryStarted(payload: RetryStartedPayload): void;
  onRetryEnded(payload: RetryEndedPayload): void;
  onRetryMeasured(payload: RetryMeasuredPayload): void;
  onCompactionStarted(payload: CompactionStartedPayload): void;
  onCompaction(payload: CompactionPayload): void;
  onAuxiliaryLlmUsage(payload: AuxiliaryLlmUsagePayload): void;
  onOperationalError(payload: OperationalErrorPayload): void;
  onRetryStuck(payload: RetryStuckPayload): void;
  onBusyChanged(payload: BusyChangedPayload): void;
  onContextUsageChanged(payload: ContextUsageChangedPayload): void;
  onExtensionUIRequest(payload: ExtensionUIRequestPayload): void;
  onError(payload: ErrorPayload): void;
  /** Phase 5: one of the six coordinator→host detail stream variants. */
  onDetailStream(message: CoordinatorToHostDetailMessage): void;
}

/**
 * Validate a backend event payload at the stdio boundary and either hand the
 * narrowed payload to the handler or drop it loudly. Mirrors the `handleLine`
 * precedent in `backend/client.ts`: malformed data is warn+dropped rather than
 * cast-and-hoped. Behavior-preserving for all well-formed payloads.
 */
function dispatch<TPayload>(
  event: EventEnvelope,
  guard: (value: unknown) => value is TPayload,
  handle: (payload: TPayload) => void,
): void {
  const payload = event.payload;
  if (!guard(payload)) {
    tracePayloadValidation(event, false);
    appendPieLog(
      'warn',
      'event-dispatch',
      `dropped malformed backend event '${event.event}' (payload failed validation)`,
    );
    return;
  }
  tracePayloadValidation(event, true);
  handle(payload);
}

export function dispatchSessionBackendEvent(
  event: EventEnvelope,
  handlers: SessionBackendEventHandlers,
): void {
  switch (event.event) {
    case 'live.semantic':
      dispatch(event, isTurnSemanticEnvelope, handlers.onTurnSemantic);
      return;
    case 'live.lifecycle':
      dispatch(event, isLiveLifecycleWatermark, handlers.onLiveLifecycle);
      return;
    case 'session.opened':
      dispatch(event, isSessionOpenedPayload, handlers.onSessionOpened);
      return;
    case 'session.list.changed':
      dispatch(event, isSessionListChangedPayload, handlers.onSessionListChanged);
      return;
    case 'message.started':
      dispatch(event, isMessageStartedPayload, handlers.onMessageStarted);
      return;
    case 'message.delta':
      dispatch(event, isMessageDeltaPayload, handlers.onMessageDelta);
      return;
    case 'message.thinking':
      dispatch(event, isMessageThinkingPayload, handlers.onMessageThinking);
      return;
    case 'message.toolCallDelta':
      dispatch(event, isMessageToolCallDeltaPayload, handlers.onMessageToolCallDelta);
      return;
    case 'tool.started':
      dispatch(event, isToolStartedPayload, handlers.onToolStarted);
      return;
    case 'tool.finished':
      dispatch(event, isToolFinishedPayload, handlers.onToolFinished);
      return;
    case 'tool.progress':
      dispatch(event, isToolProgressPayload, handlers.onToolProgress);
      return;
    case 'message.finished':
      dispatch(event, isMessageFinishedPayload, handlers.onMessageFinished);
      return;
    case 'message.custom':
      dispatch(event, isCustomMessagePayload, handlers.onCustomMessage);
      return;
    case 'message.aborted':
      dispatch(event, isMessageAbortedPayload, handlers.onMessageAborted);
      return;
    case 'preflight.failed':
      dispatch(event, isPreflightFailedPayload, handlers.onPreflightFailed);
      return;
    case 'message.queuedDelivered':
      dispatch(event, isQueuedDeliveredPayload, handlers.onQueuedDelivered);
      return;
    case 'retry.started':
      dispatch(event, isRetryStartedPayload, handlers.onRetryStarted);
      return;
    case 'retry.ended':
      dispatch(event, isRetryEndedPayload, handlers.onRetryEnded);
      return;
    case 'retry.measured':
      dispatch(event, isRetryMeasuredPayload, handlers.onRetryMeasured);
      return;
    case 'compaction.started':
      dispatch(event, isCompactionStartedPayload, handlers.onCompactionStarted);
      return;
    case 'compaction.ended':
      dispatch(event, isCompactionPayload, handlers.onCompaction);
      return;
    case 'auxiliary-llm.usage':
      dispatch(event, isAuxiliaryLlmUsagePayload, handlers.onAuxiliaryLlmUsage);
      return;
    case 'operational-error':
      dispatch(event, isOperationalErrorPayload, handlers.onOperationalError);
      return;
    case 'retry.stuck':
      dispatch(event, isRetryStuckPayload, handlers.onRetryStuck);
      return;
    case 'busy.changed':
      dispatch(event, isBusyChangedPayload, handlers.onBusyChanged);
      return;
    case 'contextUsage.changed':
      dispatch(event, isContextUsageChangedPayload, handlers.onContextUsageChanged);
      return;
    case 'extension_ui.request':
      dispatch(event, isExtensionUIRequestPayload, handlers.onExtensionUIRequest);
      return;
    case 'error':
      dispatch(event, isErrorPayload, handlers.onError);
      return;
    case 'detail.stream':
      dispatch(event, isCoordinatorToHostDetailMessage, handlers.onDetailStream);
      return;
  }
  tracePayloadValidation(event, false, 'unsupported_observation');
}

function tracePayloadValidation(
  event: EventEnvelope,
  valid: boolean,
  reasonCode: 'malformed_payload' | 'unsupported_observation' = 'malformed_payload',
): void {
  if (!isLivePipelineTraceEnabled()) return;
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : undefined;
  recordLivePipelineTrace({
    process: 'host',
    stage: 'host.payload.validated',
    kind: valid ? 'success' : 'failure',
    identifiers: {
      ...(typeof payload?.sessionPath === 'string' ? { session: payload.sessionPath } : {}),
      ...(typeof payload?.requestId === 'string' ? { request: payload.requestId } : {}),
      ...(typeof payload?.turnId === 'string' ? { turn: payload.turnId } : {}),
      ...(typeof payload?.attemptId === 'string' ? { attempt: payload.attemptId } : {}),
      ...(typeof payload?.messageId === 'string' ? { message: payload.messageId } : {}),
      ...(typeof payload?.toolCallId === 'string' ? { tool: payload.toolCallId } : {}),
    },
    eventKind: traceEventKind(event.event),
    eventSeq: typeof payload?.seq === 'number' && Number.isSafeInteger(payload.seq) && payload.seq >= 0
      ? payload.seq
      : undefined,
    reasonCode: valid ? undefined : reasonCode,
  });
}

function traceEventKind(event: string) {
  if (event === 'message.delta') return 'text' as const;
  if (event === 'message.thinking') return 'reasoning' as const;
  if (event === 'message.toolCallDelta') return 'tool_draft' as const;
  if (event === 'tool.started') return 'tool_start' as const;
  if (event === 'tool.progress') return 'tool_progress' as const;
  if (event === 'tool.finished') return 'tool_terminal' as const;
  if (event === 'message.started') return 'turn_start' as const;
  if (event === 'message.finished' || event === 'message.aborted') return 'turn_terminal' as const;
  return 'control' as const;
}
