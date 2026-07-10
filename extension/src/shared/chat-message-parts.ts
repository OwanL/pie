import type { ChatMessage, ChatMessagePart, ToolCall } from './protocol';

export function cloneToolCall(toolCall: ToolCall): ToolCall {
  return { ...toolCall };
}

/**
 * True when a tool-call input carries no meaningful content: missing,
 * null, an empty string, an empty array, or an empty object.
 *
 * Used when merging updates so that a placeholder `{}` or `undefined`
 * from a later message doesn't clobber arguments that arrived earlier
 * via `tool.started`.
 */
export function isEmptyToolCallInput(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim().length === 0;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }

  return false;
}

export function cloneMessagePart(part: ChatMessagePart): ChatMessagePart {
  if (part.kind === 'toolCall') {
    return { kind: 'toolCall', toolCall: cloneToolCall(part.toolCall) };
  }

  return { kind: part.kind, text: part.text };
}

export function appendAssistantTextPart(
  parts: ChatMessagePart[],
  kind: 'text' | 'reasoning',
  text: string,
): void {
  if (!text) {
    return;
  }

  const last = parts[parts.length - 1];
  if (last?.kind === kind) {
    last.text += text;
    return;
  }

  parts.push({ kind, text });
}

export function upsertAssistantToolPart(parts: ChatMessagePart[], toolCall: ToolCall): void {
  const nextToolCall = cloneToolCall(toolCall);
  const index = parts.findIndex(
    (part) => part.kind === 'toolCall' && part.toolCall.id === nextToolCall.id,
  );

  if (index === -1) {
    parts.push({ kind: 'toolCall', toolCall: nextToolCall });
    return;
  }

  const existing = (parts[index] as Extract<ChatMessagePart, { kind: 'toolCall' }>).toolCall;
  const merged: ToolCall = { ...existing };

  if (nextToolCall.name) {
    merged.name = nextToolCall.name;
  }

  if (!isEmptyToolCallInput(nextToolCall.input)) {
    merged.input = nextToolCall.input;
  }

  if (nextToolCall.result !== undefined) {
    merged.result = nextToolCall.result;
  }

  if (nextToolCall.status !== undefined) {
    merged.status = nextToolCall.status;
  }

  if (nextToolCall.startedAt !== undefined) {
    merged.startedAt = nextToolCall.startedAt;
  }

  if (nextToolCall.durationMs !== undefined) {
    merged.durationMs = nextToolCall.durationMs;
  }

  if (nextToolCall.parallelGroupId !== undefined) {
    merged.parallelGroupId = nextToolCall.parallelGroupId;
  }

  parts[index] = { kind: 'toolCall', toolCall: merged };
}

export function buildAssistantParts(message: ChatMessage): ChatMessagePart[] {
  const parts: ChatMessagePart[] = [];

  if (message.thinking) {
    parts.push({ kind: 'reasoning', text: message.thinking });
  }
  for (const toolCall of message.toolCalls ?? []) {
    parts.push({ kind: 'toolCall', toolCall: cloneToolCall(toolCall) });
  }
  if (message.markdown) {
    parts.push({ kind: 'text', text: message.markdown });
  }

  return parts;
}

export function legacyAssistantParts(message: ChatMessage): ChatMessagePart[] {
  return buildAssistantParts(message);
}

export function assistantPartsFromMessage(message: ChatMessage): ChatMessagePart[] | undefined {
  if (message.role !== 'assistant') {
    return undefined;
  }

  return message.parts && message.parts.length > 0 ? message.parts : legacyAssistantParts(message);
}

export function mergeAssistantParts(
  baseParts: ChatMessagePart[] | undefined,
  appendedParts: ChatMessagePart[] | undefined,
): ChatMessagePart[] | undefined {
  const merged: ChatMessagePart[] = [];

  for (const part of baseParts ?? []) {
    const nextPart = cloneMessagePart(part);
    if (nextPart.kind === 'toolCall') {
      upsertAssistantToolPart(merged, nextPart.toolCall);
    } else {
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text);
    }
  }

  for (const part of appendedParts ?? []) {
    const nextPart = cloneMessagePart(part);
    if (nextPart.kind === 'toolCall') {
      upsertAssistantToolPart(merged, nextPart.toolCall);
    } else {
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

export function textFromMessageParts(parts: ChatMessagePart[] | undefined): string {
  if (!parts) {
    return '';
  }

  return parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

export function reasoningFromMessageParts(parts: ChatMessagePart[] | undefined): string | undefined {
  if (!parts) {
    return undefined;
  }

  const text = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'reasoning' }> => part.kind === 'reasoning')
    .map((part) => part.text)
    .join('');

  return text || undefined;
}

export function toolCallsFromMessageParts(parts: ChatMessagePart[] | undefined): ToolCall[] | undefined {
  if (!parts) {
    return undefined;
  }

  const toolCalls = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => cloneToolCall(part.toolCall));

  return toolCalls.length > 0 ? toolCalls : undefined;
}
