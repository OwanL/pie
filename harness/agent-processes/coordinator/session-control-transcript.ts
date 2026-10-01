import type { ChatMessage, ToolCall } from '../lib/rpc/message-contract.js';

const TOOL_PREVIEW_CHARS = 4000;

/** Coordination reads are not renderer snapshots. Keep conversation content
 * once, omit UI/accounting/debug metadata, and explicitly summarize tool bulk. */
export function projectSessionControlTranscript(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const parts = message.parts?.map((part) => part.kind === 'toolCall'
      ? { kind: 'toolCall' as const, toolCall: projectToolCall(part.toolCall) }
      : part.kind === 'reasoning' && part.detailRef
        ? { kind: 'reasoning' as const, text: part.detailRef.summary }
        : { kind: part.kind, text: part.text });
    const userParts = message.userParts?.map((part) => part.kind === 'image'
      ? { kind: 'image' as const, mimeType: part.mimeType, dataBase64: '', omitted: true,
        ...(part.name ? { name: part.name } : {}),
        ...(part.width !== undefined ? { width: part.width } : {}),
        ...(part.height !== undefined ? { height: part.height } : {}) }
      : { kind: 'text' as const, text: part.text });
    return {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      status: message.status,
      // Ordered assistant parts already carry its text, reasoning and tools.
      markdown: parts?.length || userParts?.length ? '' : message.markdown,
      ...(parts?.length ? { parts } : {}),
      ...(userParts?.length ? { userParts } : {}),
      ...(!parts?.length && message.toolCalls?.length
        ? { toolCalls: message.toolCalls.map(projectToolCall) } : {}),
      ...(!parts?.length && message.thinking
        ? { thinking: message.thinkingDetailRef?.summary ?? message.thinking } : {}),
      ...(message.sender ? { sender: message.sender } : {}),
      ...(message.customType ? { customType: message.customType } : {}),
      ...(message.errorDetail ? { errorDetail: message.errorDetail } : {}),
    };
  });
}

function preview(value: unknown): unknown {
  if (value === undefined) return undefined;
  // SDK tool results often contain both model-facing content and duplicated
  // diagnostics/recursive child histories in details. Only content is useful
  // for coordination. Never serialize the details subtree here.
  const content = value !== null && typeof value === 'object' && 'content' in value
    ? (value as { content: unknown }).content
    : value;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text === undefined) return undefined;
  if (text.length <= TOOL_PREVIEW_CHARS) return content;
  return { preview: text.slice(0, TOOL_PREVIEW_CHARS), truncated: true, originalChars: text.length };
}

function projectToolCall(tool: ToolCall): ToolCall {
  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    input: preview(tool.input),
    ...(tool.result !== undefined ? { result: preview(tool.result) }
      : tool.detailRef ? { result: { preview: tool.detailRef.summary, omitted: true, sizeBytes: tool.detailRef.sizeBytes } }
        : {}),
  };
}
