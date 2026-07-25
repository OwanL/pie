import type {
  ChatMessage,
  ChatMessagePart,
  LazyDetailRef,
  ToolCall,
} from './protocol/messages.js';

/** Details larger than this never ride ordinary full-state snapshots. */
export const LAZY_DETAIL_THRESHOLD_BYTES = 16 * 1024;
export const LAZY_DETAIL_SUMMARY_CHARS = 180;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try { return utf8Bytes(JSON.stringify(value)); }
  catch { return Number.POSITIVE_INFINITY; }
}

function shortSummary(value: unknown): string {
  if (typeof value === 'string') {
    const bounded = value.slice(0, LAZY_DETAIL_SUMMARY_CHARS + 1);
    const first = (bounded.split(/\r?\n/, 1)[0] ?? '').trim();
    return bounded.length > LAZY_DETAIL_SUMMARY_CHARS
      ? `${first.slice(0, LAZY_DETAIL_SUMMARY_CHARS)}…`
      : first || '(empty result)';
  }
  if (value && typeof value === 'object') {
    const candidate = value as { details?: { results?: unknown[] }; children?: unknown[] };
    const children = candidate.details?.results ?? candidate.children;
    if (Array.isArray(children)) return `${children.length} subagent ${children.length === 1 ? 'child' : 'children'}`;
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `Structured result: ${keys.slice(0, 6).join(', ')}` : '(empty result)';
  }
  return String(value ?? '(no result)');
}

function childCount(value: unknown): number | undefined {
  const candidate = value && typeof value === 'object'
    ? value as { details?: { results?: unknown[] }; children?: unknown[] }
    : undefined;
  const children = candidate?.details?.results ?? candidate?.children;
  return Array.isArray(children) ? children.length : undefined;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function toolDetailRef(
  sessionPath: string,
  messageId: string,
  tool: ToolCall,
  sizeBytes: number,
  source: 'durable' | 'live',
  sourceRevision?: number,
): LazyDetailRef {
  const durableIdentity = tool.durableEntryId || messageId;
  return {
    key: `${source}:tool:${sessionPath}:${durableIdentity}:${tool.id}:${sourceRevision ?? 0}`,
    kind: 'tool-result',
    source,
    sessionPath,
    messageId,
    toolCallId: tool.id,
    executionId: tool.executionId,
    sourceRevision,
    sizeBytes,
    summary: shortSummary(tool.result),
    childCount: childCount(tool.result),
    available: source === 'live' || Boolean(tool.durableEntryId || messageId),
  };
}

export function compactToolCallDetail(
  tool: ToolCall,
  options: {
    sessionPath: string;
    messageId: string;
    source: 'durable' | 'live';
    sizeBytes?: number;
    sourceRevision?: number;
  },
): ToolCall {
  if (tool.result === undefined || tool.detailRef) return tool;
  const sizeBytes = options.sizeBytes ?? jsonBytes(tool.result);
  if (sizeBytes <= LAZY_DETAIL_THRESHOLD_BYTES) return tool;
  return {
    ...tool,
    result: undefined,
    detailRef: toolDetailRef(
      options.sessionPath,
      options.messageId,
      tool,
      sizeBytes,
      options.source,
      options.sourceRevision,
    ),
  };
}

function reasoningRef(
  sessionPath: string,
  message: ChatMessage,
  partIndex: number,
  text: string,
): LazyDetailRef {
  return {
    key: `durable:reasoning:${sessionPath}:${message.durableEntryId || message.id}:${partIndex}`,
    kind: 'reasoning',
    source: 'durable',
    sessionPath,
    messageId: message.id,
    partIndex,
    sizeBytes: utf8Bytes(text),
    summary: shortSummary(text),
    lineCount: lineCount(text),
    available: true,
  };
}

export function compactLiveReasoningPart(
  text: string,
  options: { sessionPath: string; messageId: string; partIndex: number; sourceRevision: number; sizeBytes?: number },
): Extract<ChatMessagePart, { kind: 'reasoning' }> {
  const sizeBytes = options.sizeBytes ?? utf8Bytes(text);
  if (sizeBytes <= LAZY_DETAIL_THRESHOLD_BYTES) return { kind: 'reasoning', text };
  const detailRef: LazyDetailRef = {
    key: `live:reasoning:${options.sessionPath}:${options.messageId}:${options.partIndex}:${options.sourceRevision}`,
    kind: 'reasoning',
    source: 'live',
    sessionPath: options.sessionPath,
    messageId: options.messageId,
    partIndex: options.partIndex,
    sourceRevision: options.sourceRevision,
    sizeBytes,
    summary: shortSummary(text),
    available: true,
  };
  return { kind: 'reasoning', text: detailRef.summary, detailRef };
}

/**
 * Build the transport projection of one durable row. The source message is
 * untouched and remains in the backend display cache for bounded retrieval.
 */
export function compactDurableMessageDetails(message: ChatMessage, sessionPath: string): ChatMessage {
  let changed = false;
  const compactedPartTools = new Map<string, ToolCall>();
  const parts = message.parts?.map((part, partIndex): ChatMessagePart => {
    if (part.kind === 'reasoning' && utf8Bytes(part.text) > LAZY_DETAIL_THRESHOLD_BYTES) {
      changed = true;
      const detailRef = reasoningRef(sessionPath, message, partIndex, part.text);
      return { kind: 'reasoning', text: detailRef.summary, detailRef };
    }
    if (part.kind === 'toolCall') {
      const compacted = compactToolCallDetail(part.toolCall, {
        sessionPath,
        messageId: message.id,
        source: 'durable',
      });
      if (compacted !== part.toolCall) changed = true;
      compactedPartTools.set(part.toolCall.id, compacted);
      return compacted === part.toolCall ? part : { kind: 'toolCall', toolCall: compacted };
    }
    return part;
  });

  const toolCalls = message.toolCalls?.map((tool) => {
    const partTool = compactedPartTools.get(tool.id);
    const compacted = partTool?.detailRef && tool.result !== undefined
      ? { ...tool, result: undefined, detailRef: partTool.detailRef }
      : compactToolCallDetail(tool, {
          sessionPath,
          messageId: message.id,
          source: 'durable',
        });
    if (compacted !== tool) changed = true;
    return compacted;
  });

  let thinking = message.thinking;
  let thinkingDetailRef = message.thinkingDetailRef;
  if (thinking && utf8Bytes(thinking) > LAZY_DETAIL_THRESHOLD_BYTES) {
    changed = true;
    thinkingDetailRef = reasoningRef(sessionPath, message, -1, thinking);
    thinking = thinkingDetailRef.summary;
  }

  return changed ? { ...message, parts, toolCalls, thinking, thinkingDetailRef } : message;
}

export function findDurableDetail(
  transcript: readonly ChatMessage[],
  ref: LazyDetailRef,
): { status: 'loaded'; value: unknown; sizeBytes: number } | { status: 'unavailable' } {
  const message = transcript.find((candidate) => candidate.id === ref.messageId);
  if (!message) return { status: 'unavailable' };
  if (ref.kind === 'reasoning') {
    const value = ref.partIndex === -1
      ? message.thinking
      : message.parts?.[ref.partIndex ?? -1]?.kind === 'reasoning'
        ? (message.parts[ref.partIndex ?? -1] as Extract<ChatMessagePart, { kind: 'reasoning' }>).text
        : undefined;
    return typeof value === 'string'
      ? { status: 'loaded', value, sizeBytes: utf8Bytes(value) }
      : { status: 'unavailable' };
  }
  const tool = message.parts
    ?.filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall)
    .find((candidate) => candidate.id === ref.toolCallId)
    ?? message.toolCalls?.find((candidate) => candidate.id === ref.toolCallId);
  return tool?.result !== undefined
    ? { status: 'loaded', value: tool.result, sizeBytes: jsonBytes(tool.result) }
    : { status: 'unavailable' };
}
