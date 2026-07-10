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

function formatTokenValue(tokens: number | null, kind: ContextWindowBreakdownKind): string {
  if (tokens === null) return 'unknown';
  const formatted = formatTokenCount(tokens);
  if (kind === 'estimated') return formatted;
  return formatted;
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
  // Completed/failed calls are immutable (see `toolCallTokenCache`), so their
  // estimate is stable — serve from cache to skip the BPE re-tokenisation on
  // breakdown recomputes. Running calls have no result yet (cheap) and aren't
  // cached; they become cacheable once their result lands atomically.
  if (toolCall.status === 'completed' || toolCall.status === 'failed') {
    const cached = toolCallTokenCache.get(toolCall.id);
    if (cached !== undefined) {
      return cached;
    }
  }
  const tokens = estimateTextTokens(toolCall.name)
    + estimateSerializedTokens(toolCall.input)
    + estimateSerializedTokens(toolCall.result);
  if (toolCall.status === 'completed' || toolCall.status === 'failed') {
    toolCallTokenCache.set(toolCall.id, tokens);
  }
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

function buildContributors(
  systemPrompts: readonly SystemPromptEntry[],
  transcript: readonly ChatMessage[],
): { items: ContributorItem[]; otherEstimated: number } {
  const items: ContributorItem[] = [];
  let otherEstimated = 0;
  let index = 0;

  // System prompts — combine all available prompt cards into one entry.
  const systemPromptTokens = systemPrompts.reduce((total, prompt) => {
    if (prompt.availability !== 'available') {
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
      // Assistant prose and reasoning go to "other".
      otherEstimated += typeof message.markdown === 'string' ? estimateTextTokens(message.markdown) : 0;
      otherEstimated += estimateTextTokens(message.thinking ?? '');

      for (const toolCall of message.toolCalls ?? []) {
        const toolName = typeof toolCall.name === 'string' ? toolCall.name.toLowerCase().trim() : '';
        if (toolName === 'read_file' || toolName === 'read') {
          const path = extractToolCallFilePath(toolCall.input);
          if (path) {
            const skillName = extractSkillName(path);
            if (skillName) {
              items.push({ label: 'Skill', note: skillName, tokens: estimateToolCallTokens(toolCall), originalIndex: index++ });
            } else {
              items.push({
                label: 'Read file',
                note: truncateText(path.replace(/\\/g, '/'), 72),
                tokens: estimateToolCallTokens(toolCall),
                originalIndex: index++,
              });
            }
          } else {
            otherEstimated += estimateToolCallTokens(toolCall);
          }
        } else {
          otherEstimated += estimateToolCallTokens(toolCall);
        }
      }
    } else {
      otherEstimated += estimateTextTokens(message.markdown);
    }
  }

  // Sort largest first, using insertion order as a stable tiebreaker.
  items.sort((a, b) => b.tokens - a.tokens || a.originalIndex - b.originalIndex);

  return { items, otherEstimated };
}

function buildFooterEntries(summary: ContextWindowSummary): ContextWindowBreakdownEntry[] {
  return [
    {
      key: 'window.used',
      label: 'Used',
      value: formatTokenValue(summary.usedTokens, summary.usedKind),
      kind: summary.usedKind,
    },
    {
      key: 'window.remaining',
      label: 'Remaining',
      value: formatTokenValue(summary.remainingTokens, summary.remainingKind),
      kind: summary.remainingKind,
    },
    {
      key: 'window.total',
      label: 'Total',
      value: summary.totalWindow > 0 ? formatTokenValue(summary.totalWindow, 'exact') : 'unknown',
      kind: summary.totalWindow > 0 ? 'exact' : 'unknown',
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

function buildFullEntries(
  contributors: ContributorItem[],
  otherTokens: number,
  otherKind: ContextWindowBreakdownKind,
  otherNote: string,
): ContextWindowBreakdownEntry[] {
  return [
    ...contributors.map((item, index) => ({
      key: `contributor:${index}`,
      label: item.label,
      value: formatTokenValue(item.tokens, 'estimated'),
      kind: 'estimated' as ContextWindowBreakdownKind,
      note: item.note,
    })),
    {
      key: 'other',
      label: 'Other',
      value: formatTokenValue(otherTokens, otherKind),
      kind: otherKind,
      note: otherNote,
    },
  ];
}

function buildFullNotes(
  entries: readonly ContextWindowBreakdownEntry[],
  reportedUsedTokens: number | null,
  totalWindow: number,
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
  return notes;
}

function computeUsedKind(reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  return reportedUsedTokens !== null ? 'exact' : 'estimated';
}

function computeRemainingKind(totalWindow: number, reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  if (totalWindow <= 0) return 'unknown';
  return reportedUsedTokens !== null ? 'exact' : 'estimated';
}

function computeOtherTokens(reportedUsedTokens: number | null, explicitTokens: number, otherEstimated: number): number {
  return reportedUsedTokens !== null ? Math.max(reportedUsedTokens - explicitTokens, 0) : otherEstimated;
}

function computeOtherKind(reportedUsedTokens: number | null): ContextWindowBreakdownKind {
  return reportedUsedTokens !== null ? 'derived' : 'estimated';
}

function computeOtherNote(reportedUsedTokens: number | null): string {
  return reportedUsedTokens !== null
    ? 'Unattributed: assistant responses, tool schemas, provider prompt, tokenizer drift.'
    : 'Assistant responses, reasoning, and misc tool calls.';
}

function buildFullBreakdown(options: BuildContextWindowBreakdownOptions): ContextWindowBreakdown {
  const { contextUsage, effectiveContextWindow, systemPrompts, transcript } = options;
  const reportedUsedTokens = contextUsage?.tokens ?? null;
  const totalWindow = contextUsage?.contextWindow ?? effectiveContextWindow;

  const { items: contributors, otherEstimated } = buildContributors(systemPrompts, transcript);
  const explicitTokens = contributors.reduce((sum, item) => sum + item.tokens, 0);
  const estimatedUsedTokens = explicitTokens + otherEstimated;

  const usedTokens = reportedUsedTokens ?? estimatedUsedTokens;
  const usedKind = computeUsedKind(reportedUsedTokens);

  let remainingTokens: number | null = null;
  let remainingKind: ContextWindowBreakdownKind = 'unknown';
  if (totalWindow > 0) {
    remainingTokens = Math.max(totalWindow - usedTokens, 0);
    remainingKind = computeRemainingKind(totalWindow, reportedUsedTokens);
  }

  const otherTokens = computeOtherTokens(reportedUsedTokens, explicitTokens, otherEstimated);
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
  const notes = buildFullNotes(entries, reportedUsedTokens, totalWindow);

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
