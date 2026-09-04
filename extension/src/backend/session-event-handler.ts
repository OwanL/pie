import type { SdkSessionEvent } from './sdk';
import type { SessionContext } from './server-types';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';
import { CONTENT_TOOL_SDK_EVENT_HANDLERS } from './session-event-content-tool';
import { LIFECYCLE_SDK_EVENT_HANDLERS } from './session-event-lifecycle';
import {
  emitRejectedObservation,
  sdkTraceEventKind,
  sdkTracePhase,
  type BackendSessionEventHandlerDeps,
} from './session-event-shared';

export {
  boundToolFinishedPayload,
  boundToolProgress,
  summarizeToolResult,
  TOOL_PROGRESS_MAX_BYTES,
  TOOL_TERMINAL_PAYLOAD_MAX_BYTES,
  type TerminalAppendMeasurement,
  type TerminalTransportMeasurement,
} from './session-event-content-tool';
export { resolveProviderSemanticInactivityMs, type BackendSessionEventHandlerDeps } from './session-event-shared';

export const SDK_SESSION_EVENT_TYPES = [
  'agent_start',
  'turn_start',
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'message_end',
  'agent_end',
  'agent_settled',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'turn_end',
] as const;

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
    case 'agent_start':
      return LIFECYCLE_SDK_EVENT_HANDLERS.agent_start(deps, context, event);
    case 'turn_start':
      return LIFECYCLE_SDK_EVENT_HANDLERS.turn_start(deps, context, event);
    case 'message_start':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.message_start(deps, context, event);
    case 'message_update':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.message_update(deps, context, event);
    case 'tool_execution_start':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.tool_execution_start(deps, context, event);
    case 'tool_execution_update':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.tool_execution_update(deps, context, event);
    case 'tool_execution_end':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.tool_execution_end(deps, context, event);
    case 'message_end':
      return CONTENT_TOOL_SDK_EVENT_HANDLERS.message_end(deps, context, event);
    case 'agent_end':
      return LIFECYCLE_SDK_EVENT_HANDLERS.agent_end(deps, context, event);
    case 'agent_settled':
      return LIFECYCLE_SDK_EVENT_HANDLERS.agent_settled(deps, context, event);
    case 'compaction_start':
      return LIFECYCLE_SDK_EVENT_HANDLERS.compaction_start(deps, context, event);
    case 'compaction_end':
      return LIFECYCLE_SDK_EVENT_HANDLERS.compaction_end(deps, context, event);
    case 'auto_retry_start':
      return LIFECYCLE_SDK_EVENT_HANDLERS.auto_retry_start(deps, context, event);
    case 'auto_retry_end':
      return LIFECYCLE_SDK_EVENT_HANDLERS.auto_retry_end(deps, context, event);
    case 'turn_end':
      return LIFECYCLE_SDK_EVENT_HANDLERS.turn_end(deps, context, event);
    default:
      emitRejectedObservation(deps, context, 'unsupported_observation');
  }
}
