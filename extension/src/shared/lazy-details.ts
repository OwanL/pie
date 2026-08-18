import type {
  ChatMessage,
  ChatMessagePart,
  LazyDetailRef,
  ToolCall,
} from './protocol/messages.js';
import { deduplicateToolCallResultsForTransport } from './chat-message-parts.js';

/** Details larger than this never ride ordinary full-state snapshots. */
export const LAZY_DETAIL_THRESHOLD_BYTES = 16 * 1024;
export const LAZY_DETAIL_SUMMARY_CHARS = 180;
/** In-memory payload retained for a collapsed subagent card. The recursive
 * transcript remains behind its detailRef; this budget covers only header
 * telemetry and the short activity/output preview. */
export const SUBAGENT_PREVIEW_MAX_BYTES = 64 * 1024;

const SUBAGENT_PREVIEW_TEXT_CHARS = 8 * 1024;
const SUBAGENT_PREVIEW_TASK_CHARS = 2 * 1024;
const SUBAGENT_PREVIEW_LIST_ITEMS = 8;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try { return utf8Bytes(JSON.stringify(value)); }
  catch { return Number.POSITIVE_INFINITY; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedStart(value: unknown, maxChars: number): unknown {
  return typeof value === 'string' ? value.slice(0, maxChars) : value;
}

function boundedTail(value: unknown, maxChars: number): unknown {
  return typeof value === 'string' ? value.slice(-maxChars) : value;
}

function compactUnknownPreview(value: unknown, maxChars = SUBAGENT_PREVIEW_TEXT_CHARS): unknown {
  if (typeof value === 'string') return value.slice(-maxChars);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, SUBAGENT_PREVIEW_LIST_ITEMS)
      .map((item) => compactUnknownPreview(item, Math.max(256, Math.floor(maxChars / 2))));
  }
  if (!isRecord(value)) return undefined;
  const compact: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, SUBAGENT_PREVIEW_LIST_ITEMS)) {
    const bounded = compactUnknownPreview(item, Math.max(256, Math.floor(maxChars / 2)));
    if (bounded !== undefined) compact[key] = bounded;
  }
  return compact;
}

function compactSubagentChild(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child: Record<string, unknown> = {
    id: boundedStart(value.id, 256),
    agent: boundedStart(value.agent, 256),
    task: boundedStart(value.task, SUBAGENT_PREVIEW_TASK_CHARS),
    exitCode: value.exitCode,
    messages: [],
  };
  const copy = (key: string, candidate: unknown = value[key]): void => {
    if (candidate !== undefined) child[key] = candidate;
  };
  copy('childId', boundedStart(value.childId, 512));
  copy('attemptId', boundedStart(value.attemptId, 512));
  copy('lineage', Array.isArray(value.lineage) ? value.lineage.slice(0, 64).map((item) => compactUnknownPreview(item, 1024)) : undefined);
  copy('liveAddressable', value.liveAddressable === true);
  // The immutable live detail address (root identity + lineage) is small and
  // must survive the compact preview so an expanded card can open the Phase 5
  // page-backed subscription without a backend round-trip.
  copy('detailAddress', value.detailAddress);
  copy('parentUserContextMode');
  copy('model', boundedStart(value.model, 256));
  copy('provider', boundedStart(value.provider, 256));
  copy('contextWindow');
  copy('selectedModel', boundedStart(value.selectedModel, 256));
  copy('thinkingLevel', boundedStart(value.thinkingLevel, 64));
  copy('activityPhase');
  copy('phase');
  copy('summary', boundedStart(value.summary, SUBAGENT_PREVIEW_TASK_CHARS));
  copy('activityDetail', boundedStart(value.activityDetail, 1024));
  copy('activitySince');
  copy('startedAt');
  copy('completedAt');
  copy('lastProgressAt');
  copy('inactivityBudgetMs');
  copy('streaming');
  copy('streamingText', boundedTail(value.streamingText, SUBAGENT_PREVIEW_TEXT_CHARS));
  copy('streamingReasoning', boundedTail(value.streamingReasoning, SUBAGENT_PREVIEW_TEXT_CHARS));
  copy('cumulativeOutputTokens');
  copy('finalOutput', boundedStart(value.finalOutput, SUBAGENT_PREVIEW_TEXT_CHARS));
  copy('transcriptCompacted', true);
  copy('stopReason', boundedStart(value.stopReason, 256));
  copy('errorMessage', boundedStart(value.errorMessage, 2048));
  copy('stderr', boundedTail(value.stderr, 2048));
  copy('retryCount');
  copy('usage', compactUnknownPreview(value.usage, 2048));
  copy('runningTools', Array.isArray(value.runningTools)
    ? value.runningTools.slice(0, SUBAGENT_PREVIEW_LIST_ITEMS).map((item) => boundedStart(item, 256))
    : undefined);
  copy('selectionPool', Array.isArray(value.selectionPool)
    ? value.selectionPool.slice(0, SUBAGENT_PREVIEW_LIST_ITEMS).map((item) => boundedStart(item, 256))
    : undefined);
  copy('turnThroughputSamples', Array.isArray(value.turnThroughputSamples)
    ? value.turnThroughputSamples.slice(-1).map((item) => compactUnknownPreview(item, 1024))
    : undefined);
  return child;
}

/**
 * Retain the existing top-level subagent card without retaining its recursive
 * transcript. The returned value intentionally matches the raw result shapes
 * already understood by getRenderableSubagentResult().
 */
export function compactSubagentResultPreview(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const typedChildren = value.kind === 'subagent' && Array.isArray(value.children)
    ? value.children
    : undefined;
  const directResults = Array.isArray(value.results) ? value.results : undefined;
  const nestedDetails = isRecord(value.details) ? value.details : undefined;
  const nestedResults = Array.isArray(nestedDetails?.results) ? nestedDetails.results : undefined;
  const source = typedChildren ?? directResults ?? nestedResults;
  if (!source) return undefined;

  const children = source
    .map(compactSubagentChild)
    .filter((child): child is Record<string, unknown> => child !== undefined);
  if (children.length === 0) return undefined;

  const compact = typedChildren
    ? { kind: 'subagent', mode: value.mode, children }
    : directResults
      ? { mode: value.mode, results: children }
      : { details: { mode: nestedDetails?.mode, results: children } };
  if (jsonBytes(compact) <= SUBAGENT_PREVIEW_MAX_BYTES) return compact;

  // Many parallel children can exceed the rich-preview budget even after
  // recursive messages are removed. Preserve every card's identity/status and
  // a proportionally-sized task/live tail rather than dropping siblings.
  const perChildChars = Math.max(160, Math.floor(24 * 1024 / children.length));
  const minimalChildren = children.map((child) => ({
    agent: boundedStart(child.agent, 128),
    task: boundedStart(child.task, perChildChars),
    exitCode: child.exitCode,
    model: boundedStart(child.model, 128),
    provider: boundedStart(child.provider, 128),
    activityPhase: child.activityPhase,
    activityDetail: boundedStart(child.activityDetail, perChildChars),
    startedAt: child.startedAt,
    completedAt: child.completedAt,
    streaming: child.streaming,
    streamingText: boundedTail(child.streamingText, perChildChars),
    streamingReasoning: boundedTail(child.streamingReasoning, perChildChars),
    runningTools: child.runningTools,
    usage: child.usage,
    messages: [],
  }));
  return typedChildren
    ? { kind: 'subagent', mode: value.mode, children: minimalChildren }
    : directResults
      ? { mode: value.mode, results: minimalChildren }
      : { details: { mode: nestedDetails?.mode, results: minimalChildren } };
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
    /** Override the shared 16 KiB retention threshold for a byte-capped transport. */
    thresholdBytes?: number;
  },
): ToolCall {
  if (tool.result === undefined || tool.detailRef) return tool;
  const sizeBytes = options.sizeBytes ?? jsonBytes(tool.result);
  const isSubagent = tool.name.trim().toLowerCase() === 'subagent';
  if (!isSubagent && sizeBytes <= (options.thresholdBytes ?? LAZY_DETAIL_THRESHOLD_BYTES)) return tool;
  const preview = isSubagent ? compactSubagentResultPreview(tool.result) : undefined;
  return {
    ...tool,
    result: preview,
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
 * `thresholdBytes` overrides the shared 16 KiB per-item threshold for
 * byte-capped transports.
 */
export function compactDurableMessageDetails(
  message: ChatMessage,
  sessionPath: string,
  thresholdBytes: number = LAZY_DETAIL_THRESHOLD_BYTES,
): ChatMessage {
  let changed = false;
  const compactedPartTools = new Map<string, ToolCall>();
  const parts = message.parts?.map((part, partIndex): ChatMessagePart => {
    if (part.kind === 'reasoning' && utf8Bytes(part.text) > thresholdBytes) {
      changed = true;
      const detailRef = reasoningRef(sessionPath, message, partIndex, part.text);
      return { kind: 'reasoning', text: detailRef.summary, detailRef };
    }
    if (part.kind === 'toolCall') {
      const compacted = compactToolCallDetail(part.toolCall, {
        sessionPath,
        messageId: message.id,
        source: 'durable',
        thresholdBytes,
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
      ? { ...tool, result: partTool.result, detailRef: partTool.detailRef }
      : compactToolCallDetail(tool, {
          sessionPath,
          messageId: message.id,
          source: 'durable',
          thresholdBytes,
        });
    if (compacted !== tool) changed = true;
    return compacted;
  });

  let thinking = message.thinking;
  let thinkingDetailRef = message.thinkingDetailRef;
  if (thinking && utf8Bytes(thinking) > thresholdBytes) {
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

/** Retention thresholds stepped down until a durable message fits its transport budget. */
const TRANSPORT_RESULT_THRESHOLDS = [8 * 1024, 4 * 1024, 2 * 1024, 1024, 512] as const;
/** Per-part text/reasoning tail budget for the final pathological fallback. */
const TRANSPORT_TEXT_PART_BUDGET = 8 * 1024;

/**
 * Budgeted transport projection of one durable assistant message for a
 * byte-capped live event (the worker IPC ordinary-frame ceiling). The shared
 * per-item compaction runs first; then the redundant legacy mirrors are
 * removed (`parts` is authoritative for rendering), then per-result retention
 * is tightened until the whole projection fits `maxBytes`, and finally
 * text/reasoning tails are bounded. The durable session remains lossless and
 * authoritative; this projection only rides the live terminal event, and big
 * bodies stay retrievable through their detailRefs.
 */
export function compactDurableMessageForTransport(
  message: ChatMessage,
  sessionPath: string,
  maxBytes: number,
): ChatMessage {
  // Common case: the shared per-item compaction already fits the budget, and
  // the projection is byte-identical to the ordinary durable projection.
  let projected = compactDurableMessageDetails(message, sessionPath);
  if (jsonBytes(projected) <= maxBytes) return projected;

  // Over budget: remove the redundant legacy mirrors (`parts` is
  // authoritative for rendering; the host restores the toolCalls mirror on
  // receipt), then tighten per-result retention until the projection fits.
  const dropLegacyMirrors = (candidate: ChatMessage): ChatMessage => {
    const withoutMirror = deduplicateToolCallResultsForTransport(candidate);
    return withoutMirror.parts && withoutMirror.parts.length > 0
      ? { ...withoutMirror, markdown: '', thinking: undefined }
      : withoutMirror;
  };
  projected = dropLegacyMirrors(projected);
  for (const threshold of TRANSPORT_RESULT_THRESHOLDS) {
    projected = dropLegacyMirrors(compactDurableMessageDetails(projected, sessionPath, threshold));
    if (jsonBytes(projected) <= maxBytes) return projected;
  }
  return boundMessageTextTails(projected, maxBytes);
}

/** Bound text/reasoning part tails (and legacy flat mirrors) to fit the budget. */
function boundMessageTextTails(message: ChatMessage, maxBytes: number): ChatMessage {
  if (message.parts && message.parts.length > 0) {
    const boundedParts = message.parts.map((part): ChatMessagePart => {
      if ((part.kind === 'text' || part.kind === 'reasoning') && utf8Bytes(part.text) > TRANSPORT_TEXT_PART_BUDGET) {
        return { ...part, text: part.text.slice(-TRANSPORT_TEXT_PART_BUDGET) };
      }
      return part;
    });
    const projected = { ...message, parts: boundedParts };
    if (jsonBytes(projected) <= maxBytes) return projected;
  }

  // Pathological: keep only identity and a bounded text tail. The durable
  // session remains the complete authority for any omitted content. The tail
  // lives once, in `parts` (the authoritative rendering representation).
  const tail = (message.parts ?? [])
    .filter((part): part is Extract<ChatMessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    || (typeof message.markdown === 'string' ? message.markdown : '');
  const boundedTail = tail.slice(-Math.max(1024, Math.min(maxBytes - 1024, TRANSPORT_TEXT_PART_BUDGET)));
  return {
    id: message.id,
    role: 'assistant',
    createdAt: message.createdAt,
    status: message.status,
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(message.errorDetail !== undefined ? { errorDetail: message.errorDetail } : {}),
    ...(message.durableEntryId ? { durableEntryId: message.durableEntryId } : {}),
    markdown: '',
    parts: [{ kind: 'text', text: boundedTail }],
  };
}
