import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../shared/protocol/messages.js';
import type {
  LivePipelineState,
  LiveToolRecord,
  LiveTurnRecord,
  TranscriptView,
} from '../../../shared/live-pipeline-protocol.js';
import { toolsForTurn } from './model.js';

export function projectTranscriptView(
  durableMessages: readonly ChatMessage[],
  state: LivePipelineState,
  sessionPath: string,
): TranscriptView {
  const turn = state.turnsBySession[sessionPath];
  if (!turn) return { messages: [...durableMessages], activeTurn: null, liveTools: [] };
  const tools = toolsForTurn(state, turn);
  const activeTurn = projectLiveTurn(turn, tools, 'streaming');
  return {
    messages: [...durableMessages, activeTurn],
    activeTurn,
    liveTools: activeTurn.toolCalls ?? [],
  };
}

export function projectLiveTurn(
  turn: LiveTurnRecord,
  tools: readonly LiveToolRecord[],
  status: Extract<ChatMessage['status'], 'streaming' | 'interrupted'>,
): ChatMessage {
  const toolByCallId = new Map(tools.map((tool) => [tool.transcriptToolCallId, tool]));
  const parts: ChatMessagePart[] = [];
  let markdown = '';
  let thinking = '';
  for (const part of turn.parts) {
    if (part.kind === 'text') {
      markdown += part.text;
      parts.push({ kind: 'text', text: part.text });
    } else if (part.kind === 'reasoning') {
      thinking += part.text;
      parts.push({ kind: 'reasoning', text: part.text });
    } else {
      const tool = toolByCallId.get(part.toolCallId);
      if (tool) parts.push({ kind: 'toolCall', toolCall: projectLiveTool(tool) });
    }
  }
  const toolCalls = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall);
  return {
    id: turn.canonicalMessageId,
    role: 'assistant',
    createdAt: new Date(turn.startedAt).toISOString(),
    markdown,
    thinking: thinking || undefined,
    parts,
    toolCalls,
    toolStateRevision: turn.seq,
    status,
  };
}

export function projectLiveTool(tool: LiveToolRecord): ToolCall {
  const terminal = tool.terminal;
  return {
    id: tool.transcriptToolCallId,
    name: tool.name,
    input: tool.immutableInput,
    result: terminal?.result ?? tool.preview,
    status: terminal?.status ?? 'running',
    startedAt: tool.startedAt,
    durationMs: terminal?.durationMs,
    parallelGroupId: tool.parallelGroupId,
    executionId: tool.executionId,
    seq: tool.seq,
    phase: terminal ? terminal.status : tool.phase,
    durableEntryId: terminal?.durableEntryId,
  };
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
