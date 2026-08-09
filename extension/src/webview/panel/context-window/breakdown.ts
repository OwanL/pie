import type {
  ChatMessage,
  ContextWindowUsage,
  SystemPromptEntry,
  ToolCall,
} from '../../../shared/protocol';
import { estimateTextTokens } from '../system-prompt-tokens';
import { formatTokens } from '../utils/format-tokens';
import { LruCache } from '../utils/lru-cache';

const MAX_TOOLTIP_ENTRIES = 6;

/**
 * Bounded LRU cache of per-tool-call estimated token counts, keyed by
 * tool-call id. `estimateToolCallTokens` runs real cl100k_base BPE
 * (`gpt-tokenizer`) over each tool result, and `buildContextWindowBreakdown`
 * recomputes whenever contextUsage or the tool-call signature changes (per tool
 * completion / context-window snapshot during an active turn). Without this
 * cache each recompute re-tokenises EVERY accumulated tool result — O(total
 * agent output) per recompute, the dominant cost behind "slow for long sessions
 * with lots of tool output". Completed/failed calls are immutable (results land
 * atomically at status→completed and never change; ids are unique per
 * invocation), so their token count is stable for the call's lifetime. Running
 * calls (no result yet) are cheap and aren't cached. LRU-bounded so a
 * long-lived session with many tool calls can't grow it unbounded.
 */
const TOOL_CALL_TOKEN_CACHE_MAX = 1024;
const toolCallTokenCache = new LruCache<string, number>(TOOL_CALL_TOKEN_CACHE_MAX);

/** Cache capacity, exported so tests can drive the eviction boundary. */
export const TOOL_CALL_TOKEN_CACHE_MAX_ENTRIES = TOOL_CALL_TOKEN_CACHE_MAX;

/** Number of entries currently in the cache. Test-support / diagnostics. */
export function getToolCallTokenCacheSize(): number {
  return toolCallTokenCache.size;
}

/** Reset the per-tool-call token cache. Entries are id-keyed and stable for a
 *  completed call's lifetime, so production never needs to clear this — it
 *  exists for tests that need a deterministic cache state. */
export function clearToolCallTokenCache(): void {
  toolCallTokenCache.clear();
}

export type ContextWindowBreakdownKind = 'exact' | 'estimated' | 'derived' | 'unknown';

export interface ContextWindowBreakdownEntry {
  key: string;
  /** Display label shown in the tooltip. Falls back to `key` when absent. */
  label?: string;
  value: string;
  kind: ContextWindowBreakdownKind;
  /** Raw token count for this entry, used to size bar-chart segments. Null when
   *  the value is unknown (e.g. partial transcript window). */
  tokens?: number | null;
  /** Subtitle text (file path, message preview) or explanatory note rendered below the row. */
  note?: string;
}

export interface ContextWindowSummary {
  usedTokens: number | null;
  usedKind: ContextWindowBreakdownKind;
  remainingTokens: number | null;
  remainingKind: ContextWindowBreakdownKind;
  totalWindow: number;
}

export interface ContextWindowBreakdown {
  /** Top contributor rows, sorted largest first. */
  entries: readonly ContextWindowBreakdownEntry[];
  /** Window summary rows (used / remaining / total). */
  footerEntries: readonly ContextWindowBreakdownEntry[];
  /** Structured summary used by the context badge/indicator. */
  summary: ContextWindowSummary;
  notes: readonly string[];
  title: string;
}

interface BuildContextWindowBreakdownOptions {
  contextUsage: ContextWindowUsage | null;
  effectiveContextWindow: number;
  systemPrompts: readonly SystemPromptEntry[];
  transcript: readonly ChatMessage[];
  isPartial: boolean;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatTokenCount(tokens: number): string {
  return formatTokens(tokens);
}

function formatTokenValue(tokens: number | null): string {
  return tokens === null ? 'unknown' : formatTokenCount(tokens);
}

function formatTooltipEntry(entry: ContextWindowBreakdownEntry): string {
  const label = entry.label ?? entry.key;
  const kindSuffix = entry.kind === 'estimated'
    ? ' estimated'
    : entry.kind === 'derived'
      ? ' derived'
      : '';
  const line = `${label}: ${entry.value}${kindSuffix}`;
  return entry.note ? `${line} - ${entry.note}` : line;
}

function buildTooltipText(
  entries: readonly ContextWindowBreakdownEntry[],
  footerEntries: readonly ContextWindowBreakdownEntry[],
  notes: readonly string[],
): string {
  const lines = ['Context window usage'];
  const visibleEntries = entries.slice(0, MAX_TOOLTIP_ENTRIES);
  const hiddenEntryCount = entries.length - visibleEntries.length;

  for (const entry of footerEntries) {
    lines.push(formatTooltipEntry(entry));
  }

  if (visibleEntries.length > 0) {
    lines.push('', 'Breakdown:');
    for (const entry of visibleEntries) {
      lines.push(formatTooltipEntry(entry));
    }
    if (hiddenEntryCount > 0) {
      lines.push(`... ${hiddenEntryCount} more rows omitted.`);
    }
  }

  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`Note: ${note}`);
    }
  }

  return lines.join('\n');
}

function estimateSerializedTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    // JSON.stringify can fail (e.g. cycles); fall back to a string estimate.
    return estimateTextTokens(String(value));
  }
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  // Terminal calls are immutable. Live semantic calls carry a monotonic seq
  // that advances whenever their assembled preview changes, so the same cache
  // can also avoid repeatedly JSON-serializing and tokenizing a multi-megabyte
  // running subagent preview while unrelated snapshots arrive.
  const terminal = toolCall.status === 'completed' || toolCall.status === 'failed';
  const revision = terminal
    ? 'terminal'
    : typeof toolCall.seq === 'number' && toolCall.seq > 0
      ? String(toolCall.seq)
      : undefined;
  const cacheKey = revision === undefined
    ? undefined
    : `${toolCall.id}:${toolCall.status}:${revision}`;
  if (cacheKey) {
    const cached = toolCallTokenCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const tokens = estimateTextTokens(toolCall.name)
    + estimateSerializedTokens(toolCall.input)
    + estimateSerializedTokens(toolCall.result);
  if (cacheKey) toolCallTokenCache.set(cacheKey, tokens);
  return tokens;
}

function extractToolCallFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['filePath', 'path', 'fileUri']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return undefined;
}

function extractSkillName(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i);
  return match?.[1] ?? null;
}

interface ContributorItem {
  label: string;
  note?: string;
  tokens: number;
  originalIndex: number;
}

interface AttributionTranscriptScope {
  transcript: readonly ChatMessage[];
  compactedHistoryExcluded: boolean;
}

/**
 * The display transcript deliberately retains messages that history compaction
 * removed from the model's prompt. A compaction summary is appended after both
 * the discarded history and the recent messages retained by pi, but the
 * current webview protocol does not expose `firstKeptEntryId`, so those two
 * pre-summary ranges cannot be separated here. Count only the summary and rows
 * appended after it; the PI-reported residual represents retained pre-summary
 * messages and other unattributed prompt content. This is less granular than
 * claiming that the entire historical transcript is still in context.
 */
function scopeTranscriptForAttribution(
  transcript: readonly ChatMessage[],
): AttributionTranscriptScope {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.customType === 'compaction-summary') {
      return {
        transcript: transcript.slice(index),
        compactedHistoryExcluded: true,
      };
    }
  }
  return { transcript, compactedHistoryExcluded: false };
}

interface ReconciledContributors {
  contributors: ContributorItem[];
  reconciledToReportedUsage: boolean;
}

/**
 * Contributor rows are estimates, while `reportedUsedTokens` is the provider's
 * authoritative prompt footprint. Tokenizer drift, a newly completed tool call,
 * or unavailable compaction-boundary metadata can make the estimates exceed
 * that footprint. Proportionally reconcile only the overage case so legend
 * values remain an actual partition of Used instead of displaying impossible
 * totals above 100%.
 */
function reconcileContributorsToReportedUsage(
  contributors: readonly ContributorItem[],
  reportedUsedTokens: number | null,
): ReconciledContributors {
  if (reportedUsedTokens === null) {
    return { contributors: [...contributors], reconciledToReportedUsage: false };
  }

  const reported = Math.max(0, Math.trunc(reportedUsedTokens));
  const explicit = contributors.reduce((sum, item) => sum + item.tokens, 0);
  if (explicit <= reported || explicit <= 0) {
    return { contributors: [...contributors], reconciledToReportedUsage: false };
  }

  const allocations = contributors.map((item, index) => {
    const exact = (item.tokens / explicit) * reported;
    const tokens = Math.floor(exact);
    return { item, index, tokens, fraction: exact - tokens };
  });
  const remainder = reported - allocations.reduce((sum, item) => sum + item.tokens, 0);
  const byLargestRemainder = [...allocations].sort((a, b) =>
    b.fraction - a.fraction || a.index - b.index,
  );
  for (let index = 0; index < remainder; index += 1) {
    byLargestRemainder[index]!.tokens += 1;
  }

  return {
    contributors: allocations.map(({ item, tokens }) => ({ ...item, tokens })),
    reconciledToReportedUsage: true,
  };
}

function buildContributors(
  systemPrompts: readonly SystemPromptEntry[],
  transcript: readonly ChatMessage[],
): ContributorItem[] {
  const items: ContributorItem[] = [];
  let readFileTokens = 0;
  let readFileCount = 0;
  let assistantResponseTokens = 0;
  let assistantResponseCount = 0;
  let reasoningTokens = 0;
  let reasoningCount = 0;
  let systemMessageTokens = 0;
  let systemMessageCount = 0;
  const toolTokensByName = new Map<string, { tokens: number; count: number }>();
  const skillTokensByName = new Map<string, { tokens: number; count: number }>();
  let index = 0;

  // System prompts — combine all available prompt cards into one entry.
  const systemPromptTokens = systemPrompts.reduce((total, prompt) => {
    if (prompt.availability !== 'available' || prompt.disabled === true) {
      return total;
    }

    return total + estimateTextTokens(prompt.text);
  }, 0);
  if (systemPromptTokens > 0) {
    items.push({ label: 'System prompt', tokens: systemPromptTokens, originalIndex: index++ });
  }

  // Transcript messages.
  for (const message of transcript) {
    if (message.role === 'user') {
      const tokens = typeof message.markdown === 'string' ? estimateTextTokens(message.markdown) : 0;
      const raw = typeof message.markdown === 'string' ? message.markdown.replace(/\n+/g, ' ').trim() : '';
      const note = raw.length > 0
        ? truncateText(raw, 60)
        : undefined;
      items.push({ label: 'User message', note, tokens, originalIndex: index++ });
    } else if (message.role === 'assistant') {
      const responseTokens = typeof message.markdown === 'string' ? estimateTextTokens(message.markdown) : 0;
      if (responseTokens > 0) {
        assistantResponseTokens += responseTokens;
        assistantResponseCount += 1;
      }

      const messageReasoningTokens = estimateTextTokens(message.thinking ?? '');
      if (messageReasoningTokens > 0) {
        reasoningTokens += messageReasoningTokens;
        reasoningCount += 1;
      }

      for (const toolCall of message.toolCalls ?? []) {
        const toolName = typeof toolCall.name === 'string' ? toolCall.name.toLowerCase().trim() : '';
        if (toolName === 'read_file' || toolName === 'read') {
          const path = extractToolCallFilePath(toolCall.input);
          if (path) {
            const skillName = extractSkillName(path);
            if (skillName) {
              const current = skillTokensByName.get(skillName) ?? { tokens: 0, count: 0 };
              current.tokens += estimateToolCallTokens(toolCall);
              current.count += 1;
              skillTokensByName.set(skillName, current);
            } else {
              // Aggregate every read_file call into a single contributor row
              // (one total) instead of one row per file — a long session can
              // read dozens of files, and a per-file breakdown bloats the
              // tooltip without aiding the at-a-glance context picture.
              readFileTokens += estimateToolCallTokens(toolCall);
              readFileCount += 1;
            }
            continue;
          }
        }

        // Keep non-file tools visible by name rather than hiding their often
        // substantial inputs/results in the residual "Other" segment.
        const displayName = toolName || 'unknown';
        const current = toolTokensByName.get(displayName) ?? { tokens: 0, count: 0 };
        current.tokens += estimateToolCallTokens(toolCall);
        current.count += 1;
        toolTokensByName.set(displayName, current);
      }
    } else {
      const tokens = estimateTextTokens(message.markdown);
      if (tokens > 0) {
        systemMessageTokens += tokens;
        systemMessageCount += 1;
      }
    }
  }

  if (assistantResponseTokens > 0) {
    items.push({
      label: 'Assistant responses',
      note: `${assistantResponseCount} response${assistantResponseCount === 1 ? '' : 's'}`,
      tokens: assistantResponseTokens,
      originalIndex: index++,
    });
  }
  if (reasoningTokens > 0) {
    items.push({
      label: 'Reasoning',
      note: `${reasoningCount} response${reasoningCount === 1 ? '' : 's'}`,
      tokens: reasoningTokens,
      originalIndex: index++,
    });
  }
  if (systemMessageTokens > 0) {
    items.push({
      label: 'System messages',
      note: `${systemMessageCount} message${systemMessageCount === 1 ? '' : 's'}`,
      tokens: systemMessageTokens,
      originalIndex: index++,
    });
  }
  if (readFileCount > 0) {
    items.push({
      label: 'Read file',
      note: `${readFileCount} file${readFileCount === 1 ? '' : 's'}`,
      tokens: readFileTokens,
      originalIndex: index++,
    });
  }
  for (const [skillName, aggregate] of skillTokensByName) {
    items.push({
      label: `Skill: ${skillName}`,
      note: `${aggregate.count} load${aggregate.count === 1 ? '' : 's'}`,
      tokens: aggregate.tokens,
      originalIndex: index++,
    });
  }
  for (const [toolName, aggregate] of toolTokensByName) {
    items.push({
      label: `Tool: ${toolName}`,
      note: `${aggregate.count} call${aggregate.count === 1 ? '' : 's'}`,
      tokens: aggregate.tokens,
      originalIndex: index++,
    });
  }

  // Sort largest first, using insertion order as a stable tiebreaker.
  items.sort((a, b) => b.tokens - a.tokens || a.originalIndex - b.originalIndex);

  return items;
}

function buildFooterEntries(summary: ContextWindowSummary): ContextWindowBreakdownEntry[] {
  return [
    {
      key: 'window.used',
      label: 'Used',
      value: formatTokenValue(summary.usedTokens),
      kind: summary.usedKind,
      tokens: summary.usedTokens,
    },
    {
      key: 'window.remaining',
      label: 'Remaining',
      value: formatTokenValue(summary.remainingTokens),
      kind: summary.remainingKind,
      tokens: summary.remainingTokens,
    },
    {
      key: 'window.total',
      label: 'Total',
      value: summary.totalWindow > 0 ? formatTokenValue(summary.totalWindow) : 'unknown',
      kind: summary.totalWindow > 0 ? 'exact' : 'unknown',
      tokens: summary.totalWindow > 0 ? summary.totalWindow : null,
    },
  ];
}

function buildPartialNotes(reportedUsedTokens: number | null): string[] {
  const notes: string[] = [];
  notes.push('Only a partial transcript window is loaded; contributor rows are hidden to avoid misleading attribution.');
  if (reportedUsedTokens !== null) {
    notes.push('Used tokens come from PI’s live context-window snapshot, not just the loaded transcript window.');
  } else {
    notes.push('Exact used/remaining values are unavailable until PI reports a live context-window snapshot.');
  }
  return notes;
}

function buildPartialBreakdown(
  reportedUsedTokens: number | null,
  totalWindow: number,
): ContextWindowBreakdown {
  const usedTokens = reportedUsedTokens;
  const usedKind: ContextWindowBreakdownKind = reportedUsedTokens !== null ? 'exact' : 'unknown';

  let remainingTokens: number | null = null;
  let remainingKind: ContextWindowBreakdownKind = 'unknown';
  if (totalWindow > 0 && usedTokens !== null) {
    remainingTokens = Math.max(totalWindow - usedTokens, 0);
    remainingKind = 'exact';
  }

  const notes = buildPartialNotes(reportedUsedTokens);

  const summary: ContextWindowSummary = {
    usedTokens,
    usedKind,
    remainingTokens,
    remainingKind,
    totalWindow,
  };

  const footerEntries = buildFooterEntries(summary);

  return {
    entries: [],
    footerEntries,
    summary,
    notes,
    title: buildTooltipText([], footerEntries, notes),
  };
}

function buildCompactedUnknownBreakdown(totalWindow: number): ContextWindowBreakdown {
  const summary: ContextWindowSummary = {
    usedTokens: null,
    usedKind: 'unknown',
    remainingTokens: null,
    remainingKind: 'unknown',
    totalWindow,
  };
  const footerEntries = buildFooterEntries(summary);
  const notes = [
    'Contributor rows are unavailable because the display transcript does not expose which pre-summary messages PI retained.',
    'Exact used/remaining values are unavailable until PI reports a live context-window snapshot.',
  ];
  return {
    entries: [],
    footerEntries,
    summary,
    notes,
    title: buildTooltipText([], footerEntries, notes),
  };
}

function buildFullEntries(
  contributors: ContributorItem[],
  otherTokens: number,
  otherKind: ContextWindowBreakdownKind,
  otherNote: string,
): ContextWindowBreakdownEntry[] {
  const entries: ContextWindowBreakdownEntry[] = contributors.map((item, index) => ({
    key: `contributor:${index}`,
    label: item.label,
    value: formatTokenValue(item.tokens),
    kind: 'estimated',
    tokens: item.tokens,
    note: item.note,
  }));
  if (otherTokens > 0) {
    entries.push({
      key: 'other',
      label: 'Other',
      value: formatTokenValue(otherTokens),
      kind: otherKind,
      tokens: otherTokens,
      note: otherNote,
    });
  }
  return entries;
}

function buildFullNotes(
  entries: readonly ContextWindowBreakdownEntry[],
  reportedUsedTokens: number | null,
  totalWindow: number,
  compactedHistoryExcluded: boolean,
  reconciledToReportedUsage: boolean,
): string[] {
  const notes: string[] = [];
  if (reportedUsedTokens !== null) {
    notes.push('Used tokens come from PI’s live context-window snapshot, not just the next prompt.');
  } else if (totalWindow > 0) {
    notes.push('Used and remaining values are estimated until PI reports a live context-window snapshot.');
  }
  if (entries.some((entry) => entry.kind === 'estimated')) {
    notes.push('Estimated rows are tokenized with cl100k_base where exact attribution is unavailable.');
  }
  if (entries.some((entry) => entry.kind === 'derived')) {
    notes.push('Derived rows are the PI-reported remainder after subtracting explicit rows.');
  }
  if (compactedHistoryExcluded && reportedUsedTokens !== null) {
    notes.push('Compacted history is excluded; retained pre-summary messages are included in the unattributed PI-reported remainder.');
  }
  if (reconciledToReportedUsage) {
    notes.push('Contributor estimates were proportionally reconciled to PI’s reported used-token total.');
  }
  return notes;
}

function computeUsedKind(reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  return reportedUsedTokens !== null ? 'exact' : 'estimated';
}

function computeRemainingKind(totalWindow: number, reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  if (totalWindow <= 0) return 'unknown';
  return reportedUsedTokens !== null ? 'exact' : 'estimated';
}

function computeOtherTokens(reportedUsedTokens: number | null, explicitTokens: number): number {
  return reportedUsedTokens !== null ? Math.max(reportedUsedTokens - explicitTokens, 0) : 0;
}

function computeOtherKind(reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  return reportedUsedTokens !== null ? 'derived' : 'estimated';
}

function computeOtherNote(reportedUsedTokens: number | null): string {
  return reportedUsedTokens !== null
    ? 'Unattributed: tool schemas, provider prompt, hidden content, and tokenizer drift.'
    : 'Content unavailable for explicit attribution.';
}

function buildFullBreakdown(options: BuildContextWindowBreakdownOptions): ContextWindowBreakdown {
  const { contextUsage, effectiveContextWindow, systemPrompts, transcript } = options;
  const reportedUsedTokens = contextUsage?.tokens ?? null;
  const totalWindow = contextUsage?.contextWindow ?? effectiveContextWindow;

  const attributionScope = scopeTranscriptForAttribution(transcript);
  if (attributionScope.compactedHistoryExcluded && reportedUsedTokens === null) {
    return buildCompactedUnknownBreakdown(totalWindow);
  }

  const rawContributors = buildContributors(systemPrompts, attributionScope.transcript);
  const {
    contributors,
    reconciledToReportedUsage,
  } = reconcileContributorsToReportedUsage(rawContributors, reportedUsedTokens);
  const explicitTokens = contributors.reduce((sum, item) => sum + item.tokens, 0);
  const estimatedUsedTokens = explicitTokens;

  const usedTokens = reportedUsedTokens ?? estimatedUsedTokens;
  const usedKind = computeUsedKind(reportedUsedTokens);

  let remainingTokens: number | null = null;
  let remainingKind: ContextWindowBreakdownKind = 'unknown';
  if (totalWindow > 0) {
    remainingTokens = Math.max(totalWindow - usedTokens, 0);
    remainingKind = computeRemainingKind(totalWindow, reportedUsedTokens);
  }

  const otherTokens = computeOtherTokens(reportedUsedTokens, explicitTokens);
  const otherKind = computeOtherKind(reportedUsedTokens);
  const otherNote = computeOtherNote(reportedUsedTokens);

  const entries = buildFullEntries(contributors, otherTokens, otherKind, otherNote);

  const summary: ContextWindowSummary = {
    usedTokens,
    usedKind,
    remainingTokens,
    remainingKind,
    totalWindow,
  };

  const footerEntries = buildFooterEntries(summary);
  const notes = buildFullNotes(
    entries,
    reportedUsedTokens,
    totalWindow,
    attributionScope.compactedHistoryExcluded,
    reconciledToReportedUsage,
  );

  return {
    entries,
    footerEntries,
    summary,
    notes,
    title: buildTooltipText(entries, footerEntries, notes),
  };
}

export function buildContextWindowBreakdown({
  contextUsage,
  effectiveContextWindow,
  systemPrompts,
  transcript,
  isPartial,
}: BuildContextWindowBreakdownOptions): ContextWindowBreakdown {
  const reportedUsedTokens = contextUsage?.tokens ?? null;
  const totalWindow = contextUsage?.contextWindow ?? effectiveContextWindow;

  if (isPartial) {
    return buildPartialBreakdown(reportedUsedTokens, totalWindow);
  }

  return buildFullBreakdown({
    contextUsage,
    effectiveContextWindow,
    systemPrompts,
    transcript,
    isPartial,
  });
}
