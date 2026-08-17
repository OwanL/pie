import { LIVE_PIPELINE_LIMITS, type SubagentChildPreview, type ToolPreview } from '../shared/live-pipeline-protocol.js';
import { isLiveSubagentDetailAddress, type LiveSubagentDetailAddress, type SubagentChildIdentity } from '../shared/protocol/subagent-detail.js';
import { estimateTextTokens } from '../shared/tokenize.js';
import { recordBackendLivePipelineTrace, isBackendLivePipelineTraceEnabled } from './live-pipeline-trace-runtime';

const MAX_TAIL_CHARS = 8_192;
const MAX_SUMMARY_CHARS = 1_024;
const MAX_TASK_CHARS = 4_096;
const MAX_PARENT_USER_CONTEXT_CHARS = 12_000;
const SUBAGENT_NORMALIZATION_CACHE_MAX = 64;

export interface ToolProgressRecursiveCounters {
  childCount: number;
  messageCount: number;
  maxRecursiveDepth: number;
  /** False only when a diagnostics-enabled call reuses a preview cached before
   * counters were requested; no telemetry-only traversal is performed. */
  available?: boolean;
}

interface CachedSubagentNormalization {
  preview: ToolPreview;
  counters?: ToolProgressRecursiveCounters;
}

const subagentNormalizationCache = new Map<string, CachedSubagentNormalization>();

export interface SubagentDetailAddressRoot {
  sessionPath: string;
  turnId: string;
  rootToolCallId: string;
  rootAttemptId: string;
}

export function normalizeToolProgress(
  toolName: string,
  value: unknown,
  counters?: ToolProgressRecursiveCounters,
  detailRoot?: SubagentDetailAddressRoot,
): ToolPreview {
  const startedAt = performance.now();
  const preview = normalizeToolProgressMeasured(toolName, value, counters, detailRoot);
  if (isBackendLivePipelineTraceEnabled() && toolName.trim().toLowerCase() === 'subagent') {
    recordBackendLivePipelineTrace({
      stage: 'backend.subagent',
      kind: 'observation',
      phase: 'json_safe_normalization',
      durationMs: Math.max(0, performance.now() - startedAt),
      childCount: counters?.available === false ? undefined : counters?.childCount,
      messageCount: counters?.available === false ? undefined : counters?.messageCount,
      maxRecursiveDepth: counters?.available === false ? undefined : counters?.maxRecursiveDepth,
      processRole: 'coordinator',
      pid: process.pid,
    });
  }
  return preview;
}

function normalizeToolProgressMeasured(
  toolName: string,
  value: unknown,
  counters?: ToolProgressRecursiveCounters,
  detailRoot?: SubagentDetailAddressRoot,
): ToolPreview {
  const normalizedName = toolName.trim().toLowerCase();
  if (normalizedName === 'subagent') return normalizeSubagent(value, counters, detailRoot);
  if (normalizedName === 'ask_user') return normalizeQuestion(value);
  if (normalizedName === 'bash') return normalizeCommand(value);
  if (normalizedName === 'read' || normalizedName === 'write' || normalizedName === 'edit') {
    return normalizeText(value);
  }
  return normalizeGeneric(value);
}

function normalizeText(value: unknown): ToolPreview {
  const text = extractText(value) ?? safeSummary(value);
  const { tail, omittedChars } = boundedTail(text, MAX_TAIL_CHARS);
  return { kind: 'text', tail, omittedChars };
}

function normalizeCommand(value: unknown): ToolPreview {
  const record = asRecord(value);
  const command = stringField(record, ['command', 'commandSummary']) ?? 'Command running';
  const output = stringField(record, ['output', 'stdout', 'text', 'partialResult']);
  const boundedCommand = boundedHead(command, MAX_SUMMARY_CHARS);
  if (!output) {
    return { kind: 'command', commandSummary: boundedCommand, omittedChars: Math.max(0, command.length - boundedCommand.length) };
  }
  const bounded = boundedTail(output, MAX_TAIL_CHARS);
  return {
    kind: 'command',
    commandSummary: boundedCommand,
    outputTail: bounded.tail,
    omittedChars: Math.max(0, command.length - boundedCommand.length) + bounded.omittedChars,
  };
}

function normalizeSubagent(value: unknown, counters?: ToolProgressRecursiveCounters, detailRoot?: SubagentDetailAddressRoot): ToolPreview {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  const rawChildren = Array.isArray(record?.children)
    ? record.children
    : Array.isArray(record?.results)
      ? record.results
      : Array.isArray(details?.results)
        ? details.results
        : Array.isArray(record?.details)
          ? record.details
          : [];
  const mode = normalizeSubagentMode(details?.mode ?? record?.mode);
  // Modern runner snapshots carry a unique attempt id and monotonic progress
  // generation per child. Reuse the already JSON-safe recursive projection for
  // duplicate callbacks instead of cloning multi-megabyte messages again.
  const revisionParts = rawChildren.map((value) => {
    const child = asRecord(value);
    const attemptId = stringField(child, ['attemptId']);
    const generation = numberField(child, 'progressGeneration');
    return attemptId && generation !== undefined ? `${attemptId}:${generation}` : undefined;
  });
  const revision = revisionParts.length > 0 && revisionParts.every((part): part is string => part !== undefined)
    ? `${mode}|${detailRoot ? `${detailRoot.sessionPath}|${detailRoot.turnId}|${detailRoot.rootToolCallId}|${detailRoot.rootAttemptId}|` : ''}${revisionParts.join('|')}`
    : undefined;
  if (revision) {
    const cached = subagentNormalizationCache.get(revision);
    if (cached) {
      if (counters) {
        if (cached.counters) Object.assign(counters, cached.counters, { available: true });
        else counters.available = false;
      }
      return cached.preview;
    }
  }
  const children: SubagentChildPreview[] = [];
  for (let index = 0; index < rawChildren.length; index += 1) {
    const child = asRecord(rawChildren[index]);
    if (!child) continue;
    const agent = boundedOptional(stringField(child, ['agent']), 256);
    const childId = stringField(child, ['childId']);
    const attemptId = stringField(child, ['attemptId']);
    const lineage = normalizeLineage(child.lineage);
    const producerAddressable = child.liveAddressable === true && !!childId && !!attemptId && !!lineage;
    const detailAddress: LiveSubagentDetailAddress | undefined = producerAddressable && detailRoot
      ? {
          sessionPath: detailRoot.sessionPath,
          turnId: detailRoot.turnId,
          rootToolCallId: detailRoot.rootToolCallId,
          rootAttemptId: detailRoot.rootAttemptId,
          lineage,
        }
      : undefined;
    const validDetailAddress = detailAddress && isLiveSubagentDetailAddress(detailAddress) ? detailAddress : undefined;
    const id = childId ?? stringField(child, ['id', 'sessionId']) ?? agent ?? `legacy-child-${index + 1}`;
    const phase = normalizeChildPhase(stringField(child, ['activityPhase', 'phase', 'status']), numberField(child, 'exitCode'));
    const summary = boundedOptional(
      stringField(child, ['summary', 'finalOutput', 'text', 'detail']) ?? latestAssistantText(child.messages),
      MAX_SUMMARY_CHARS,
    );
    children.push({
      id: boundedHead(id, 128),
      childId: childId ? boundedHead(childId, 512) : undefined,
      attemptId: attemptId ? boundedHead(attemptId, 512) : undefined,
      lineage,
      liveAddressable: validDetailAddress !== undefined,
      detailAddress: validDetailAddress,
      phase,
      agent,
      task: boundedOptional(stringField(child, ['task']), MAX_TASK_CHARS),
      parentUserContextMode: normalizeParentUserContextMode(child.parentUserContextMode),
      parentUserContext: boundedOptional(stringField(child, ['parentUserContext']), MAX_PARENT_USER_CONTEXT_CHARS),
      summary,
      exitCode: numberField(child, 'exitCode'),
      model: boundedOptional(stringField(child, ['model']), 256),
      selectedModel: boundedOptional(stringField(child, ['selectedModel']), 256),
      provider: boundedOptional(stringField(child, ['provider']), 256),
      thinkingLevel: boundedOptional(stringField(child, ['thinkingLevel']), 64),
      activityDetail: boundedOptional(stringField(child, ['activityDetail']), 256),
      activitySince: numberField(child, 'activitySince'),
      startedAt: numberField(child, 'startedAt'),
      completedAt: numberField(child, 'completedAt'),
      lastProgressAt: numberField(child, 'lastProgressAt'),
      inactivityBudgetMs: numberField(child, 'inactivityBudgetMs'),
      streaming: typeof child.streaming === 'boolean' ? child.streaming : undefined,
      streamingText: boundedTailOptional(stringField(child, ['streamingText']), MAX_TAIL_CHARS),
      streamingReasoning: boundedTailOptional(stringField(child, ['streamingReasoning']), MAX_TAIL_CHARS),
      cumulativeOutputTokens: estimateCumulativeSubagentTokens(child),
      runningTools: Array.isArray(child.runningTools)
        ? child.runningTools.filter((tool): tool is string => typeof tool === 'string').slice(0, 20).map((tool) => boundedHead(tool, 128))
        : undefined,
      // Complete messages and recursively nested tool details are worker-owned
      // and travel only through an explicit detail subscription.
      finalOutput: boundedTailOptional(stringField(child, ['finalOutput']), MAX_TAIL_CHARS),
      transcriptCompacted: typeof child.transcriptCompacted === 'boolean' ? child.transcriptCompacted : undefined,
      contextWindow: numberField(child, 'contextWindow'),
      usage: normalizeUsage(child.usage),
      selectionPool: Array.isArray(child.selectionPool)
        ? child.selectionPool.filter((model): model is string => typeof model === 'string').slice(0, 20).map((model) => boundedHead(model, 256))
        : undefined,
      retryCount: numberField(child, 'retryCount'),
      stopReason: boundedOptional(stringField(child, ['stopReason']), 256),
      errorMessage: boundedTailOptional(stringField(child, ['errorMessage']), MAX_TAIL_CHARS),
      stderr: boundedTailOptional(stringField(child, ['stderr']), MAX_TAIL_CHARS),
    });
  }
  const measuredCounters: ToolProgressRecursiveCounters | undefined = counters
    ? { childCount: 0, messageCount: 0, maxRecursiveDepth: 0 }
    : undefined;
  const normalized = toJsonSafe({
    kind: 'subagent', mode, children, omittedChildren: Math.max(0, rawChildren.length - children.length),
  }, new WeakSet(), measuredCounters) as ToolPreview;
  if (counters && measuredCounters) Object.assign(counters, measuredCounters, { available: true });
  if (revision) {
    subagentNormalizationCache.set(revision, { preview: normalized, counters: measuredCounters });
    if (subagentNormalizationCache.size > SUBAGENT_NORMALIZATION_CACHE_MAX) {
      const oldest = subagentNormalizationCache.keys().next().value;
      if (oldest !== undefined) subagentNormalizationCache.delete(oldest);
    }
  }
  return normalized;
}

function normalizeLineage(value: unknown): SubagentChildIdentity[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  const lineage: SubagentChildIdentity[] = [];
  for (const entry of value) {
    const identity = asRecord(entry);
    const childId = stringField(identity, ['childId']);
    const spawningToolCallId = stringField(identity, ['spawningToolCallId']);
    const attemptId = stringField(identity, ['attemptId']);
    if (!childId || !spawningToolCallId || !attemptId) return undefined;
    lineage.push({ childId, spawningToolCallId, attemptId });
  }
  return lineage;
}

function normalizeUsage(value: unknown): SubagentChildPreview['usage'] {
  const usage = asRecord(value);
  if (!usage) return undefined;
  return {
    input: numberField(usage, 'input') ?? 0,
    output: numberField(usage, 'output') ?? 0,
    cacheRead: numberField(usage, 'cacheRead') ?? 0,
    cacheWrite: numberField(usage, 'cacheWrite') ?? 0,
    contextTokens: numberField(usage, 'contextTokens'),
    cost: numberField(usage, 'cost'),
    turns: numberField(usage, 'turns'),
  };
}

/**
 * Live cumulative output tokens for a child: provider-reported completed output
 * plus text, reasoning, and tool-call output still streaming in the current
 * (not-yet-reported) turn. A
 * pre-computed `cumulativeOutputTokens` (set by the transport compactor) is
 * reused as-is so high-frequency progress deltas do not re-tokenize the
 * complete stream on every update.
 */
export function estimateCumulativeSubagentTokens(child: Record<string, unknown>): number {
  const preserved = numberField(child, 'cumulativeOutputTokens');
  if (preserved !== undefined && preserved >= 0) return preserved;

  const usage = asRecord(child.usage);
  const reportedOutput = numberField(usage, 'output') ?? 0;
  const streamingText = typeof child.streamingText === 'string' ? child.streamingText : '';
  const streamingReasoning = typeof child.streamingReasoning === 'string' ? child.streamingReasoning : '';
  const draftingToolCall = asRecord(child.draftingToolCall);
  const draftingToolName = stringField(draftingToolCall, ['name']) ?? '';
  const draftingToolArguments = stringField(draftingToolCall, ['argumentsText']) ?? '';
  const streamedTokens = estimatePossiblyLongTextTokens(streamingText)
    + estimatePossiblyLongTextTokens(streamingReasoning)
    + estimatePossiblyLongTextTokens(draftingToolName)
    + estimatePossiblyLongTextTokens(draftingToolArguments);
  return Math.max(0, reportedOutput + streamedTokens);
}

const TOKEN_SAMPLE_CHARS = 8_192;

/** Bound tokenizer work for high-frequency progress deltas. For a long stream,
 * sample its tail's token density and scale by total characters; this remains
 * cumulative without re-tokenizing an ever-growing buffer on every delta. */
function estimatePossiblyLongTextTokens(text: string): number {
  if (text.length <= TOKEN_SAMPLE_CHARS) return estimateTextTokens(text);
  const tail = text.slice(-TOKEN_SAMPLE_CHARS);
  const tailTokens = estimateTextTokens(tail);
  return Math.round(tailTokens * (text.length / tail.length));
}

function normalizeSubagentMode(value: unknown): 'single' | 'parallel' | 'chain' {
  return value === 'parallel' || value === 'chain' ? value : 'single';
}

function normalizeParentUserContextMode(value: unknown): 'latest' | 'all' | undefined {
  return value === 'latest' || value === 'all' ? value : undefined;
}

function normalizeQuestion(value: unknown): ToolPreview {
  const record = asRecord(value);
  const prompt = stringField(record, ['question', 'prompt', 'text']) ?? 'Waiting for input';
  const options = Array.isArray(record?.options) ? record.options.length : 0;
  return { kind: 'question', promptSummary: boundedHead(prompt, MAX_SUMMARY_CHARS), optionCount: options };
}

function normalizeGeneric(value: unknown): ToolPreview {
  return { kind: 'generic', summary: boundedHead(safeSummary(value), MAX_SUMMARY_CHARS) };
}

function normalizeChildPhase(value: string | undefined, exitCode?: number): SubagentChildPreview['phase'] {
  switch (value) {
    case 'queued': case 'running': case 'completed': case 'failed': case 'cancelled': return value;
    case 'error': return 'failed';
    case 'aborted': return 'cancelled';
    default: return exitCode === 0 ? 'completed' : typeof exitCode === 'number' && exitCode !== -1 ? 'failed' : 'running';
  }
}

function latestAssistantText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = asRecord(value[index]);
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => {
        const record = asRecord(part);
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return stringField(record, ['text', 'output', 'content', 'partialResult']);
}

function safeSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'No progress detail';
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function' || typeof item === 'symbol') return `[${typeof item}]`;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    return json ?? Object.prototype.toString.call(value);
  } catch {
    return '[Unserializable progress]';
  }
}

/**
 * Recursively clone a value into a JSON-safe equivalent: cycles, BigInt,
 * functions, symbols and throwing getters become stable markers so the
 * renderable transcript survives `JSON.stringify` without losing the
 * surrounding structure. The live transport's byte guard runs later; this only
 * makes values serializable, it never truncates them.
 */
function toJsonSafe(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  counters?: ToolProgressRecursiveCounters,
  recursiveDepth = 0,
  childResult = false,
): unknown {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.description ? `[symbol:${value.description}]` : '[symbol]';
  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return null;
  if (value === null) return null;
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date) {
    try { return value.toISOString(); } catch { return '[Date]'; }
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (entry) => toJsonSafe(entry, seen, counters, recursiveDepth, childResult));
    }
    if (childResult && counters) {
      counters.childCount += 1;
      counters.maxRecursiveDepth = Math.max(counters.maxRecursiveDepth, recursiveDepth);
      const messages = (value as Record<string, unknown>).messages;
      if (Array.isArray(messages)) counters.messageCount += messages.length;
    }
    const result: Record<string, unknown> = {};
    let keys: string[];
    try { keys = Object.keys(value); } catch { return '[unserializable]'; }
    for (const key of keys) {
      const safeKey = ['__proto__', 'prototype', 'constructor'].includes(key) ? `[${key}]` : key;
      let entry: unknown;
      try { entry = (value as Record<string, unknown>)[key]; } catch { result[safeKey] = '[unserializable]'; continue; }
      if (entry === undefined) continue;
      const childCollection = (key === 'children' || key === 'results') && Array.isArray(entry);
      result[safeKey] = childCollection
        ? Array.from(entry as unknown[], (item) => toJsonSafe(
            item,
            seen,
            counters,
            recursiveDepth + 1,
            key === 'children' || isSubagentChildResult(item),
          ))
        : toJsonSafe(entry, seen, counters, recursiveDepth, false);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function isSubagentChildResult(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && typeof record.agent === 'string' && Array.isArray(record.messages);
}

function boundedTail(value: string, maxChars: number): { tail: string; omittedChars: number } {
  if (value.length <= maxChars) return { tail: value, omittedChars: 0 };
  return { tail: value.slice(-maxChars), omittedChars: value.length - maxChars };
}

function boundedHead(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : boundedHead(value, maxChars);
}

function boundedTailOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : boundedTail(value, maxChars).tail;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string') return record[key];
  return undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  return record && typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined;
}

/** Defensive protocol assertion used by the accumulator before publication. */
export function isBoundedToolPreview(preview: ToolPreview): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(preview), 'utf8') <= LIVE_PIPELINE_LIMITS.previewBytes;
  } catch {
    return false;
  }
}
