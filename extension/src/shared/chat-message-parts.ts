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

  return part.kind === 'reasoning' && part.detailRef
    ? { kind: part.kind, text: part.text, detailRef: part.detailRef }
    : { kind: part.kind, text: part.text };
}

export function appendAssistantTextPart(
  parts: ChatMessagePart[],
  kind: 'text' | 'reasoning',
  text: string,
  detailRef?: Extract<ChatMessagePart, { kind: 'reasoning' }>['detailRef'],
): void {
  if (!text) {
    return;
  }

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

  if (nextToolCall.durableEntryId !== undefined) {
    merged.durableEntryId = nextToolCall.durableEntryId;
  }

  parts[index] = { kind: 'toolCall', toolCall: merged };
}

export function buildAssistantParts(message: ChatMessage): ChatMessagePart[] {
  const parts: ChatMessagePart[] = [];

  if (message.thinking) {
    parts.push(message.thinkingDetailRef
      ? { kind: 'reasoning', text: message.thinking, detailRef: message.thinkingDetailRef }
      : { kind: 'reasoning', text: message.thinking });
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
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text, nextPart.kind === 'reasoning' ? nextPart.detailRef : undefined);
    }
  }

  for (const part of appendedParts ?? []) {
    const nextPart = cloneMessagePart(part);
    if (nextPart.kind === 'toolCall') {
      upsertAssistantToolPart(merged, nextPart.toolCall);
    } else {
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text, nextPart.kind === 'reasoning' ? nextPart.detailRef : undefined);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

/**
 * Remove provider-internal tool protocol that was duplicated into assistant
 * text alongside an authoritative structured tool call. Some OpenAI-compatible
 * providers can emit both native `tool_calls` deltas and their model's raw DSML
 * wrapper. Rendering that wrapper is redundant and, when the provider loops,
 * can grow one transcript row enough to make the entire UI unresponsive.
 *
 * This is deliberately narrow: the strong suppression path requires both the
 * raw `<tool_calls><|DSML|invoke ...>` shape and either a structured tool call
 * or repetition of that raw shape. A bare `curr` token is suppressed only next
 * to a structured call because it is the leaked prefix produced by the same
 * provider protocol.
 */
export function sanitizeProviderToolProtocolParts(
  parts: ChatMessagePart[] | undefined,
): ChatMessagePart[] | undefined {
  if (!parts) {
    return parts;
  }

  const rawProtocolStart = /<tool_calls>\s*<[|｜]DSML[|｜]invoke(?:\s|>)/iu;
  const hasStructuredCall = parts.some((part) => part.kind === 'toolCall');
  const rawProtocolStartCount = parts.reduce((count, part) => {
    if (part.kind !== 'text') return count;
    return count + (part.text.match(/<tool_calls>\s*<[|｜]DSML[|｜]invoke(?:\s|>)/giu)?.length ?? 0);
  }, 0);
  if (!hasStructuredCall && rawProtocolStartCount < 2) {
    return parts;
  }

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
    if (protocolIndex === -1) {
      continue;
    }

    const prefix = part.text.slice(0, protocolIndex).replace(/\bcurr\s*$/iu, '');
    if (prefix) {
      appendAssistantTextPart(sanitized, 'text', prefix);
    }
  }

  if (!changed) {
    return parts;
  }
  return sanitized.length > 0 ? sanitized : undefined;
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

/**
 * Remove tool results from the legacy flat mirror when the ordered `parts`
 * representation already carries the authoritative result for the same call.
 *
 * Backend transcript snapshots cross a JSON transport, so shared object
 * references are serialized twice. Large, recursively nested subagent results
 * can otherwise make one snapshot more than twice as large as its actual
 * content. Only the redundant mirror field is removed; `parts` retains the
 * complete result without truncation.
 */
export function deduplicateToolCallResultsForTransport(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant' || !message.parts || !message.toolCalls) {
    return message;
  }

  const canonicalResultIds = new Set(
    message.parts.flatMap((part) => (
      part.kind === 'toolCall' && part.toolCall.result !== undefined
        ? [part.toolCall.id]
        : []
    )),
  );
  if (canonicalResultIds.size === 0) {
    return message;
  }

  let changed = false;
  const toolCalls = message.toolCalls.map((toolCall) => {
    if (toolCall.result === undefined || !canonicalResultIds.has(toolCall.id)) {
      return toolCall;
    }
    const { result: _duplicateResult, ...transportMirror } = toolCall;
    changed = true;
    return transportMirror;
  });

  return changed ? { ...message, toolCalls } : message;
}

/**
 * Remove the complete legacy tool-call mirror when ordered `parts` already
 * carries the authoritative tool calls.
 *
 * Renderer state snapshots are full snapshots, so retaining both collections
 * makes every tool input and compact result cross the host→webview boundary
 * twice. The webview renders assistant tools from `parts`; legacy messages
 * without ordered parts retain `toolCalls` unchanged.
 */
export function omitRedundantToolCallMirrorForTransport(message: ChatMessage): ChatMessage {
  if (
    message.role !== 'assistant'
    || !message.toolCalls
    || !message.parts?.some((part) => part.kind === 'toolCall')
  ) {
    return message;
  }

  const { toolCalls: _redundantToolCalls, ...transportMessage } = message;
  return transportMessage;
}

/**
 * Rehydrate the in-memory compatibility mirror after a deduplicated transcript
 * crosses the backend/host transport. Consumers that still read
 * `message.toolCalls` retain their existing behavior, while renderers continue
 * to use the full ordered `parts` representation.
 */
export function restoreToolCallResultsFromParts(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant' || !message.parts || !message.toolCalls) {
    return message;
  }

  const canonicalById = new Map(
    message.parts.flatMap((part) => (
      part.kind === 'toolCall' ? [[part.toolCall.id, part.toolCall] as const] : []
    )),
  );
  let changed = false;
  const toolCalls = message.toolCalls.map((toolCall) => {
    const canonical = canonicalById.get(toolCall.id);
    if (!canonical || canonical.result === undefined || toolCall.result === canonical.result) {
      return toolCall;
    }
    changed = true;
    return { ...toolCall, result: canonical.result };
  });

  return changed ? { ...message, toolCalls } : message;
}
