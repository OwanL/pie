import type { ChatMessage, ChatMessagePart, ToolCall } from '../../agent-processes/lib/rpc/message-contract.js';

export function cloneToolCall(toolCall: ToolCall): ToolCall {
  return { ...toolCall };
}

export function isEmptyToolCallInput(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

export function appendAssistantTextPart(
  parts: ChatMessagePart[],
  kind: 'text' | 'reasoning',
  text: string,
  detailRef?: Extract<ChatMessagePart, { kind: 'reasoning' }>['detailRef'],
): void {
  if (!text) return;
  if (kind === 'reasoning' && detailRef) {
    parts.push({ kind, text, detailRef });
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.kind === kind && (last.kind !== 'reasoning' || !last.detailRef)) {
    last.text += text;
    return;
  }
  parts.push({ kind, text });
}

/** Remove provider-internal tool protocol duplicated beside a structured call. */
export function sanitizeProviderToolProtocolParts(
  parts: ChatMessagePart[] | undefined,
): ChatMessagePart[] | undefined {
  if (!parts) return parts;
  const rawProtocolStart = /<tool_calls>\s*<[|｜]DSML[|｜]invoke(?:\s|>)/iu;
  const hasStructuredCall = parts.some((part) => part.kind === 'toolCall');
  const rawProtocolStartCount = parts.reduce((count, part) => {
    if (part.kind !== 'text') return count;
    return count + (part.text.match(/<tool_calls>\s*<[|｜]DSML[|｜]invoke(?:\s|>)/giu)?.length ?? 0);
  }, 0);
  if (!hasStructuredCall && rawProtocolStartCount < 2) return parts;

  let changed = false;
  const sanitized: ChatMessagePart[] = [];
  for (const part of parts) {
    if (part.kind !== 'text') {
      sanitized.push(part);
      continue;
    }
    const protocolIndex = part.text.search(rawProtocolStart);
    const isBareProtocolPrefix = hasStructuredCall && part.text.trim().toLowerCase() === 'curr';
    if (protocolIndex === -1 && !isBareProtocolPrefix) {
      sanitized.push(part);
      continue;
    }
    changed = true;
    if (protocolIndex === -1) continue;
    const prefix = part.text.slice(0, protocolIndex).replace(/\bcurr\s*$/iu, '');
    if (prefix) appendAssistantTextPart(sanitized, 'text', prefix);
  }
  return changed ? sanitized.length > 0 ? sanitized : undefined : parts;
}

export function textFromMessageParts(parts: ChatMessagePart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

export function reasoningFromMessageParts(parts: ChatMessagePart[] | undefined): string | undefined {
  if (!parts) return undefined;
  const text = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'reasoning' }> => part.kind === 'reasoning')
    .map((part) => part.text)
    .join('');
  return text || undefined;
}

export function upsertAssistantToolPart(parts: ChatMessagePart[], toolCall: ToolCall): void {
  const nextToolCall = cloneToolCall(toolCall);
  const index = parts.findIndex((part) => part.kind === 'toolCall' && part.toolCall.id === nextToolCall.id);
  if (index === -1) {
    parts.push({ kind: 'toolCall', toolCall: nextToolCall });
    return;
  }
  const existing = (parts[index] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall;
  const merged: ToolCall = { ...existing };
  if (nextToolCall.name) merged.name = nextToolCall.name;
  if (!isEmptyToolCallInput(nextToolCall.input)) merged.input = nextToolCall.input;
  if (nextToolCall.result !== undefined) merged.result = nextToolCall.result;
  if (nextToolCall.status !== undefined) merged.status = nextToolCall.status;
  if (nextToolCall.startedAt !== undefined) merged.startedAt = nextToolCall.startedAt;
  if (nextToolCall.endedAt !== undefined) merged.endedAt = nextToolCall.endedAt;
  if (nextToolCall.durationMs !== undefined) merged.durationMs = nextToolCall.durationMs;
  if (nextToolCall.durationClockDomain !== undefined) merged.durationClockDomain = nextToolCall.durationClockDomain;
  if (nextToolCall.parallelGroupId !== undefined) merged.parallelGroupId = nextToolCall.parallelGroupId;
  if (nextToolCall.durableEntryId !== undefined) merged.durableEntryId = nextToolCall.durableEntryId;
  parts[index] = { kind: 'toolCall', toolCall: merged };
}

export function toolCallsFromMessageParts(parts: ChatMessagePart[] | undefined): ToolCall[] | undefined {
  if (!parts) return undefined;
  const toolCalls = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => ({ ...part.toolCall }));
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/** Remove the duplicate result mirror from a backend snapshot before JSONL transport. */
export function deduplicateToolCallResultsForTransport(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant' || !message.parts || !message.toolCalls) return message;
  const canonicalResultIds = new Set(message.parts.flatMap((part) => (
    part.kind === 'toolCall' && part.toolCall.result !== undefined ? [part.toolCall.id] : []
  )));
  if (canonicalResultIds.size === 0) return message;
  let changed = false;
  const toolCalls = message.toolCalls.map((toolCall) => {
    if (toolCall.result === undefined || !canonicalResultIds.has(toolCall.id)) return toolCall;
    const { result: _duplicateResult, ...transportMirror } = toolCall;
    changed = true;
    return transportMirror;
  });
  return changed ? { ...message, toolCalls } : message;
}
