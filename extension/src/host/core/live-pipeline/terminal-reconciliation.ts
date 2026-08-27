import type { LiveToolRecord, LiveTurnRecord } from '../../../shared/live-pipeline-protocol.js';
import type { ChatMessage, ToolCall } from '../../../shared/protocol/messages.js';
import {
  reconstructSubagentDetailAddresses,
  retainSubagentDetailAddresses,
} from './subagent-detail-addresses.js';

const SAFE_TOOL_RENDER_FIELDS = [
  'parallelGroupId',
  'executionId',
  'startedAt',
  'durationMs',
  'seq',
] as const satisfies readonly (keyof ToolCall)[];

/** Carry only host render metadata from a previously reconciled durable row. */
export function reconcileDurableMessageRenderMetadata(
  durable: ChatMessage,
  previous: ChatMessage,
): ChatMessage {
  if (durable.role !== 'assistant' || previous.role !== 'assistant') return durable;

  const previousByCallId = Object.create(null) as Record<string, ToolCall>;
  for (const part of previous.parts ?? []) {
    if (part.kind === 'toolCall') previousByCallId[part.toolCall.id] = part.toolCall;
  }
  for (const call of previous.toolCalls ?? []) {
    if (!previousByCallId[call.id]) previousByCallId[call.id] = call;
  }

  const reconcileCall = (call: ToolCall): ToolCall => {
    const prior = previousByCallId[call.id];
    if (!prior) return call;
    const metadata: Partial<ToolCall> = {};
    for (const field of SAFE_TOOL_RENDER_FIELDS) {
      if (call[field] === undefined && prior[field] !== undefined) {
        Object.assign(metadata, { [field]: prior[field] });
      }
    }
    const result = call.name.trim().toLowerCase() === 'subagent'
      ? retainSubagentDetailAddresses(call.result, prior.result)
      : call.result;
    return Object.keys(metadata).length > 0 || result !== call.result
      ? { ...call, ...metadata, ...(result !== call.result ? { result } : {}) }
      : call;
  };

  const parts = durable.parts?.map((part) => part.kind === 'toolCall'
    ? { kind: 'toolCall' as const, toolCall: reconcileCall(part.toolCall) }
    : part);
  const partCallsById = Object.create(null) as Record<string, ToolCall>;
  for (const part of parts ?? []) {
    if (part.kind === 'toolCall') partCallsById[part.toolCall.id] = part.toolCall;
  }
  const sourceMirror = durable.toolCalls
    ?? parts?.flatMap((part) => part.kind === 'toolCall' ? [part.toolCall] : []);
  const toolCalls = sourceMirror?.map((call) => partCallsById[call.id] ?? reconcileCall(call));

  return {
    ...durable,
    ...(previous.renderIdentity !== undefined ? { renderIdentity: previous.renderIdentity } : {}),
    ...(parts ? { parts } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/**
 * Carry safe live render identity onto matching durability-confirmed calls.
 * Durable input/result/status/name remain authoritative, and provisional calls
 * absent from the durable message are deliberately not materialized.
 */
export function reconcileDurableTerminalToolMetadata(
  durable: ChatMessage,
  turn: LiveTurnRecord,
  tools: readonly LiveToolRecord[],
): ChatMessage {
  if (durable.role !== 'assistant') return durable;

  const liveByCallId = Object.create(null) as Record<string, LiveToolRecord>;
  for (const tool of tools) liveByCallId[tool.transcriptToolCallId] = tool;
  const draftIds = turn.toolDraftsByCallId;

  const reconcileCall = (call: ToolCall): ToolCall => {
    const live = liveByCallId[call.id];
    // Reading the draft record makes the matching policy explicit: drafts may
    // establish ordered/stable identity, but never contribute unvalidated input
    // or lifecycle state to a durable call.
    const matchesDraft = Object.prototype.hasOwnProperty.call(draftIds, call.id);
    if (!live && !matchesDraft) return call;
    if (!live) return call;
    const result = call.name.trim().toLowerCase() === 'subagent'
      ? reconstructSubagentDetailAddresses(call.result, {
          sessionPath: turn.sessionPath,
          turnId: live.turnId,
          rootToolCallId: live.transcriptToolCallId,
          rootAttemptId: live.attemptId,
        })
      : call.result;
    return {
      ...call,
      ...(call.parallelGroupId === undefined && live.parallelGroupId !== undefined
        ? { parallelGroupId: live.parallelGroupId }
        : {}),
      ...(call.startedAt === undefined ? { startedAt: live.startedAt } : {}),
      ...(call.durationMs === undefined && live.terminal?.durationMs !== undefined
        ? { durationMs: live.terminal.durationMs }
        : {}),
      ...(call.executionId === undefined ? { executionId: live.executionId } : {}),
      ...(call.seq === undefined ? { seq: live.seq } : {}),
      ...(result !== call.result ? { result } : {}),
    };
  };

  const parts = durable.parts?.map((part) => part.kind === 'toolCall'
    ? { kind: 'toolCall' as const, toolCall: reconcileCall(part.toolCall) }
    : part);
  const partCallsById = Object.create(null) as Record<string, ToolCall>;
  for (const part of parts ?? []) {
    if (part.kind === 'toolCall') partCallsById[part.toolCall.id] = part.toolCall;
  }
  const partMirror = (parts ?? [])
    .filter((part): part is Extract<NonNullable<ChatMessage['parts']>[number], { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall);
  const sourceMirror = durable.toolCalls ?? (partMirror.length > 0 ? partMirror : undefined);
  const toolCalls = sourceMirror?.map((call) => {
    const reconciledPart = partCallsById[call.id];
    return reconciledPart ?? reconcileCall(call);
  });

  return {
    ...durable,
    // Preserve the live row's UI-only identity without replacing the durable
    // SDK message id or durability evidence.
    renderIdentity: turn.canonicalMessageId,
    ...(parts ? { parts } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}
