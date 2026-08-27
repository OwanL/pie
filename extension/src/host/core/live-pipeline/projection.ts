import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../shared/protocol/messages.js';
import type {
  LivePipelineState,
  LiveToolRecord,
  LiveTurnRecord,
  TranscriptView,
} from '../../../shared/live-pipeline-protocol.js';
import { compactLiveReasoningPart, compactToolCallDetail } from '../../../shared/lazy-details.js';
import {
  reasoningFromMessageParts,
  sanitizeProviderToolProtocolParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
} from '../../../shared/chat-message-parts.js';
import { toolsForTurn } from './model.js';
import { reconstructSubagentDetailAddresses } from './subagent-detail-addresses.js';

export function projectTranscriptView(
  durableMessages: readonly ChatMessage[],
  state: LivePipelineState,
  sessionPath: string,
): TranscriptView {
  const turn = state.turnsBySession[sessionPath];
  if (!turn) return { messages: [...durableMessages], activeTurn: null, liveTools: [] };
  const tools = toolsForTurn(state, turn);
  const activeTurn = projectLiveTurn(turn, tools, 'streaming');
  const messagesBeforeActiveTurn: ChatMessage[] = [];
  const queuedFollowUps: ChatMessage[] = [];
  for (const message of durableMessages) {
    if (message.role === 'user' && message.status === 'queued') queuedFollowUps.push(message);
    else messagesBeforeActiveTurn.push(message);
  }
  return {
    messages: [...messagesBeforeActiveTurn, activeTurn, ...queuedFollowUps],
    activeTurn,
    liveTools: activeTurn.toolCalls ?? [],
  };
}

export function projectLiveTurn(
  turn: LiveTurnRecord,
  tools: readonly LiveToolRecord[],
  status: Extract<ChatMessage['status'], 'streaming' | 'interrupted'>,
): ChatMessage {
  const toolByCallId = Object.create(null) as Record<string, LiveToolRecord>;
  for (const tool of tools) {
    const existing = toolByCallId[tool.transcriptToolCallId];
    // A duplicate running execution must not shadow a durability-confirmed terminal.
    if (existing?.terminal && !tool.terminal) continue;
    toolByCallId[tool.transcriptToolCallId] = tool;
  }
  const parts: ChatMessagePart[] = [];
  for (const [partIndex, part] of turn.parts.entries()) {
    if (part.kind === 'text') {
      parts.push({ kind: 'text', text: part.text });
    } else if (part.kind === 'reasoning') {
      const projected = compactLiveReasoningPart(part.text, {
        sessionPath: turn.sessionPath,
        messageId: turn.canonicalMessageId,
        partIndex,
        sourceRevision: turn.reasoningBytes,
        sizeBytes: turn.reasoningBytes,
      });
      parts.push(projected);
    } else {
      const tool = toolByCallId[part.toolCallId];
      const draft = Object.prototype.hasOwnProperty.call(turn.toolDraftsByCallId, part.toolCallId)
        ? turn.toolDraftsByCallId[part.toolCallId]
        : undefined;
      if (tool) parts.push({
        kind: 'toolCall',
        toolCall: projectLiveTool(tool, turn.sessionPath, turn.canonicalMessageId),
      });
      else if (draft) parts.push({
        kind: 'toolCall',
        toolCall: {
          id: draft.toolCallId,
          name: draft.name,
          // Keep the raw JSON text intact. Incomplete JSON is not parsed into a
          // synthetic authoritative input object.
          input: draft.argumentsJson,
          argumentsText: draft.argumentsJson,
          status: draft.phase,
          phase: draft.phase,
          seq: turn.seq,
        },
      });
    }
  }
  const sanitizedParts = sanitizeProviderToolProtocolParts(parts) ?? [];
  const toolCalls = toolCallsFromMessageParts(sanitizedParts) ?? [];
  return {
    id: turn.canonicalMessageId,
    // Render-only continuity survives a terminal handoff even when the durable
    // SDK message id is different. Protocol and transcript ownership continue
    // to use `id`.
    renderIdentity: turn.canonicalMessageId,
    role: 'assistant',
    createdAt: new Date(turn.startedAt).toISOString(),
    modelId: turn.modelId,
    thinkingLevel: turn.thinkingLevel,
    markdown: textFromMessageParts(sanitizedParts),
    thinking: reasoningFromMessageParts(sanitizedParts),
    parts: sanitizedParts,
    toolCalls,
    toolStateRevision: turn.seq,
    status,
  };
}

export function projectLiveTool(tool: LiveToolRecord, sessionPath: string, messageId: string): ToolCall {
  const terminal = tool.terminal;
  const executionEnd = tool.executionEnd;
  const lifecycle = terminal ?? executionEnd;
  const terminalResult = terminal && tool.name.trim().toLowerCase() === 'subagent'
    ? reconstructSubagentDetailAddresses(terminal.result, {
        sessionPath,
        turnId: tool.turnId,
        rootToolCallId: tool.transcriptToolCallId,
        rootAttemptId: tool.attemptId,
      })
    : terminal?.result;
  const projected: ToolCall = {
    id: tool.transcriptToolCallId,
    name: tool.name,
    input: tool.immutableInput,
    result: terminalResult ?? tool.preview,
    status: lifecycle?.status ?? 'running',
    startedAt: tool.startedAt,
    durationMs: lifecycle?.durationMs,
    parallelGroupId: tool.parallelGroupId,
    executionId: tool.executionId,
    seq: tool.seq,
    phase: lifecycle?.status ?? tool.phase,
    durableEntryId: terminal?.durableEntryId,
  };
  return compactToolCallDetail(projected, {
    sessionPath,
    messageId,
    source: 'live',
    sizeBytes: terminal?.resultBytes ?? tool.previewBytes,
    sourceRevision: tool.progressRevision ?? tool.seq,
  });
}

/**
 * Controlled restart/cleanup materialization. Runtime-only previews are removed;
 * only durability-confirmed terminal tool evidence survives interruption.
 */
export function materializeInterruptedLiveTurn(
  state: LivePipelineState,
  sessionPath: string,
): ChatMessage | null {
  const turn = state.turnsBySession[sessionPath];
  if (!turn) return null;
  const durabilityConfirmedTools = toolsForTurn(state, turn).filter((tool) => tool.terminal);
  const confirmedCallIds = new Set(durabilityConfirmedTools.map((tool) => tool.transcriptToolCallId));
  return projectLiveTurn({
    ...turn,
    parts: turn.parts.filter((part) => part.kind !== 'tool' || confirmedCallIds.has(part.toolCallId)),
  }, durabilityConfirmedTools, 'interrupted');
}
