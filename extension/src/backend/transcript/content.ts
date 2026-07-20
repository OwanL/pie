import type {
  AssistantUsage,
  ChatMessage,
  ChatMessagePart,
  ToolCall,
  UserContentPart,
} from '../../shared/protocol';
import {
  appendAssistantTextPart,
  toolCallsFromMessageParts,
  upsertAssistantToolPart,
} from '../../shared/chat-message-parts';

import type { ContentPart, MessageLike } from './types';

export function isoDate(entryTimestamp: string, messageTimestamp?: number): string {
  if (typeof messageTimestamp === 'number') {
    return new Date(messageTimestamp).toISOString();
  }
  return new Date(entryTimestamp).toISOString();
}

export function textFromParts(parts: ContentPart[] | undefined): string {
  if (!parts) {
    return '';
  }

  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

export function thinkingFromParts(parts: ContentPart[] | undefined): string | undefined {
  if (!parts) {
    return undefined;
  }

  const thinking = parts
    .filter((part) => part.type === 'thinking' && typeof part.thinking === 'string')
    .map((part) => part.thinking ?? '')
    .join('');
  return thinking || undefined;
}

export function userPartsFromContent(content: string | ContentPart[] | undefined): UserContentPart[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const userParts: UserContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      userParts.push({ kind: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image'
      && typeof part.data === 'string'
      && part.data.length > 0
      && typeof part.mimeType === 'string'
      && part.mimeType.length > 0
    ) {
      userParts.push({
        kind: 'image',
        mimeType: part.mimeType,
        dataBase64: part.data,
        name: typeof part.name === 'string' ? part.name : undefined,
        width: typeof part.width === 'number' ? part.width : undefined,
        height: typeof part.height === 'number' ? part.height : undefined,
      });
    }
  }

  return userParts.length > 0 ? userParts : undefined;
}

export { normalizeThinkingLevel } from '../../shared/thinking-level.js';

export function assistantPartsFromContent(
  parts: ContentPart[] | undefined,
  toolCallStatus: ToolCall['status'] = 'running',
): ChatMessagePart[] | undefined {
  if (!parts) {
    return undefined;
  }

  const orderedParts: ChatMessagePart[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      appendAssistantTextPart(orderedParts, 'text', part.text);
      continue;
    }

    if (part.type === 'thinking' && typeof part.thinking === 'string') {
      appendAssistantTextPart(orderedParts, 'reasoning', part.thinking);
      continue;
    }

    if (part.type === 'toolCall' && part.id && part.name) {
      upsertAssistantToolPart(orderedParts, {
        id: part.id,
        name: part.name,
        input: part.arguments ?? {},
        status: toolCallStatus,
      });
    }
  }

  return orderedParts.length > 0 ? orderedParts : undefined;
}

export function appendAssistantParts(
  target: ChatMessage,
  incoming: ChatMessagePart[] | undefined,
  preserveLeadingBoundary = false,
): void {
  if (!incoming || incoming.length === 0) {
    return;
  }

  const targetParts = (target.parts ??= []);
  let shouldPreserveBoundary = preserveLeadingBoundary;
  for (const part of incoming) {
    if (part.kind === 'toolCall') {
      upsertAssistantToolPart(targetParts, part.toolCall);
      shouldPreserveBoundary = false;
      continue;
    }

    const last = targetParts[targetParts.length - 1];
    const text =
      shouldPreserveBoundary && last?.kind === part.kind && !part.text.startsWith('\n\n')
        ? `\n\n${part.text}`
        : part.text;

    appendAssistantTextPart(targetParts, part.kind, text);
    shouldPreserveBoundary = false;
  }
}

export function applyToolResultToParts(
  parts: ChatMessagePart[] | undefined,
  toolCallId: string | undefined,
  result: unknown,
  status: ToolCall['status'],
  durableEntryId?: string,
): void {
  if (!parts || !toolCallId) {
    return;
  }

  const part = parts.find(
    (item): item is Extract<ChatMessagePart, { kind: 'toolCall' }> =>
      item.kind === 'toolCall' && item.toolCall.id === toolCallId,
  );
  if (!part) {
    return;
  }

  part.toolCall.result = result;
  part.toolCall.status = status;
  if (durableEntryId) part.toolCall.durableEntryId = durableEntryId;
}

export function assistantStatus(message: MessageLike): ChatMessage['status'] {
  if (message.stopReason === 'aborted') {
    return 'interrupted';
  }

  if (message.stopReason === 'error' || message.errorMessage) {
    return 'error';
  }

  return 'completed';
}

function toNonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Extract a normalised `AssistantUsage` block from a raw assistant message.
 * Returns `undefined` for messages without usage (aborted/errored turns, or
 * legacy entries from before the provider reported usage).
 */
export function usageFromMessage(message: MessageLike): AssistantUsage | undefined {
  const usage = message.usage;
  if (!usage) {
    return undefined;
  }

  const promptDetails = usage.prompt_tokens_details;
  const promptTokens = toNonNegativeInt(firstNumber(usage.prompt_tokens, usage.prompt_eval_count));
  const output = toNonNegativeInt(firstNumber(usage.output, usage.output_tokens, usage.completion_tokens, usage.eval_count));
  const cacheWrite = toNonNegativeInt(firstNumber(
    usage.cacheWrite,
    usage.cache_creation_input_tokens,
    promptDetails?.cache_creation_input_tokens,
    promptDetails?.cache_write_input_tokens,
    promptDetails?.cache_write_tokens,
  ));
  const cacheRead = toNonNegativeInt(firstNumber(
    usage.cacheRead,
    usage.cache_read_input_tokens,
    promptDetails?.cache_read_input_tokens,
    usage.prompt_cache_hit_tokens,
    promptDetails?.cached_tokens,
  ));
  const input = usage.input !== undefined
    ? toNonNegativeInt(usage.input)
    : usage.input_tokens !== undefined
      ? toNonNegativeInt(usage.input_tokens)
      : promptTokens > 0
        ? Math.max(0, promptTokens - cacheRead - cacheWrite)
        : 0;
  const reportedTotal = toNonNegativeInt(firstNumber(usage.totalTokens, usage.total_tokens));
  const total = reportedTotal > 0 ? reportedTotal : input + output + cacheRead + cacheWrite;

  // Reasoning tokens are a SUBSET of output (never added to totals/cost).
  // Clamp to `output` so a misreported value can never exceed the output count.
  const reasoningRaw = toNonNegativeInt(firstNumber(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  ));
  const reasoningTokens = reasoningRaw > 0 ? Math.min(reasoningRaw, output) : undefined;
  const reportedCostRaw = usage.cost?.total;
  const reportedCostUsd = typeof reportedCostRaw === 'number'
    && Number.isFinite(reportedCostRaw) && reportedCostRaw >= 0
    ? reportedCostRaw
    : undefined;

  if (total === 0) {
    return undefined;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: total,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

/** Sum two optional usage blocks. Returns `undefined` when both are undefined.
 *  `reasoningTokens` is summed only when present on at least one operand
 *  (omitted when both are undefined) and never alters the token/cost totals —
 *  it is a subset of `outputTokens`, already covered by pricing. */
export function addAssistantUsage(
  a: AssistantUsage | undefined,
  b: AssistantUsage | undefined,
): AssistantUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const aReasoning = typeof a.reasoningTokens === 'number' ? a.reasoningTokens : undefined;
  const bReasoning = typeof b.reasoningTokens === 'number' ? b.reasoningTokens : undefined;
  const reasoningTokens = aReasoning !== undefined || bReasoning !== undefined
    ? Math.max(0, (aReasoning ?? 0) + (bReasoning ?? 0))
    : undefined;
  const reportedCostUsd = a.reportedCostUsd !== undefined || b.reportedCostUsd !== undefined
    ? Math.max(0, (a.reportedCostUsd ?? 0) + (b.reportedCostUsd ?? 0))
    : undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

export function systemMessage(id: string, createdAt: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'system',
    createdAt,
    markdown,
    status: 'completed',
  };
}

export { toolCallsFromMessageParts };
