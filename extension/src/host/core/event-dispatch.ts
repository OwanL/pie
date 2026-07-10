import type {
  BusyChangedPayload,
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
  OperationalErrorPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryStartedPayload,
  RetryStuckPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../../shared/protocol';
import {
  isBusyChangedPayload,
  isContextUsageChangedPayload,
  isCustomMessagePayload,
  isErrorPayload,
  isExtensionUIRequestPayload,
  isMessageAbortedPayload,
  isMessageDeltaPayload,
  isMessageFinishedPayload,
  isMessageStartedPayload,
  isMessageThinkingPayload,
  isOperationalErrorPayload,
  isPreflightFailedPayload,
  isQueuedDeliveredPayload,
  isRetryEndedPayload,
  isRetryStartedPayload,
  isRetryStuckPayload,
  isSessionListChangedPayload,
  isSessionOpenedPayload,
  isToolFinishedPayload,
  isToolProgressPayload,
  isToolStartedPayload,
} from '../../shared/protocol/event-payloads.js';
import { appendPieLog } from '../util/pie-log.js';

export interface SessionBackendEventHandlers {
  onSessionOpened(payload: SessionOpenedPayload): void;
  onSessionListChanged(payload: SessionListChangedPayload): void;
  onMessageStarted(payload: MessageStartedPayload): void;
  onMessageDelta(payload: MessageDeltaPayload): void;
  onMessageThinking(payload: MessageThinkingPayload): void;
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
  onOperationalError(payload: OperationalErrorPayload): void;
  onRetryStuck(payload: RetryStuckPayload): void;
  onBusyChanged(payload: BusyChangedPayload): void;
  onContextUsageChanged(payload: ContextUsageChangedPayload): void;
  onExtensionUIRequest(payload: ExtensionUIRequestPayload): void;
  onError(payload: ErrorPayload): void;
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
    appendPieLog(
      'warn',
      'event-dispatch',
      `dropped malformed backend event '${event.event}' (payload failed validation)`,
    );
    return;
  }
  handle(payload);
}

export function dispatchSessionBackendEvent(
  event: EventEnvelope,
  handlers: SessionBackendEventHandlers,
): void {
  switch (event.event) {
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
  }
}
