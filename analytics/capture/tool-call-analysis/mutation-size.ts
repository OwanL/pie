import type { ToolCall } from '../../../harness/agent-processes/lib/rpc/message-contract.js';
import { normalizeToolCallName } from './summary';
import { isRecord } from '../../../lib/validation/type-guards';
import type { EditSizeStats } from './mutation-types';
import {
  TEXT_CONTAINER_KEYS,
  WRITE_CONTENT_KEYS,
  hasToolCallPathInput,
  looksLikeCreateTool,
  looksLikeEditTool,
  looksLikeReadTool,
} from './mutation-tools';

type SizeHintPrefix = '+' | '-' | '';

export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const normalized = text.replace(/\r\n?/g, '\n');
  const withoutTrailingNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return withoutTrailingNewline.split('\n').length;
}

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const integer = Math.floor(value);
  return integer >= 0 ? integer : null;
}

function toPositiveInteger(value: unknown): number | null {
  const integer = toNonNegativeInteger(value);
  return integer && integer > 0 ? integer : null;
}

function lineCountFromRange(start: unknown, end: unknown): number | null {
  const startLine = toNonNegativeInteger(start);
  const endLine = toNonNegativeInteger(end);
  if (startLine === null || endLine === null || endLine < startLine) {
    return null;
  }

  const count = (endLine - startLine) + 1;
  return count > 0 ? count : null;
}

function hasTextLikeValue(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasTextLikeValue(entry, depth + 1));
  }

  if (!isRecord(value) || depth >= 2) {
    return false;
  }

  return TEXT_CONTAINER_KEYS.some((key) => hasTextLikeValue(value[key], depth + 1));
}

function lineCountFromTextLike(value: unknown, depth = 0): number | null {
  if (typeof value === 'string') {
    const lineCount = countTextLines(value);
    return lineCount > 0 ? lineCount : null;
  }

  if (Array.isArray(value)) {
    let total = 0;
    let foundAny = false;
    for (const entry of value) {
      const lineCount = lineCountFromTextLike(entry, depth + 1);
      if (lineCount) {
        total += lineCount;
        foundAny = true;
      }
    }
    return foundAny && total > 0 ? total : null;
  }

  if (!isRecord(value) || depth >= 2) {
    return null;
  }

  for (const key of TEXT_CONTAINER_KEYS) {
    const lineCount = lineCountFromTextLike(value[key], depth + 1);
    if (lineCount) {
      return lineCount;
    }
  }

  return null;
}

export function lineCountFromRecordKeys(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const lineCount = lineCountFromTextLike(record[key]);
    if (lineCount) {
      return lineCount;
    }
  }

  return null;
}

function formatLineHint(prefix: SizeHintPrefix, lineCount: number | null): string | null {
  if (!lineCount || lineCount <= 0) {
    return null;
  }

  const lineLabel = lineCount === 1 ? 'line' : 'lines';
  return `${prefix}${lineCount} ${lineLabel}`;
}

export function combineEditStats(current: EditSizeStats, next: EditSizeStats): EditSizeStats {
  return {
    additions: current.additions + next.additions,
    deletions: current.deletions + next.deletions,
    modifications: current.modifications + next.modifications,
  };
}

function editStatsFromReplacement(oldText: string, newText: string): EditSizeStats {
  const oldLineCount = countTextLines(oldText);
  const newLineCount = countTextLines(newText);

  if (oldLineCount === 0 && newLineCount === 0) {
    return { additions: 0, deletions: 0, modifications: 0 };
  }

  if (oldLineCount === 0) {
    return { additions: newLineCount, deletions: 0, modifications: 0 };
  }

  if (newLineCount === 0) {
    return { additions: 0, deletions: oldLineCount, modifications: 0 };
  }

  return { additions: 0, deletions: 0, modifications: Math.max(oldLineCount, newLineCount) };
}

export function editStatsFromEntry(value: unknown): EditSizeStats | null {
  if (!isRecord(value)) {
    return null;
  }

  const oldText = typeof value.oldText === 'string' ? value.oldText
    : typeof value.old_text === 'string' ? value.old_text
    : null;
  const newText = typeof value.newText === 'string' ? value.newText
    : typeof value.new_text === 'string' ? value.new_text
    : null;

  if (oldText === null && newText === null) {
    return null;
  }

  return editStatsFromReplacement(oldText ?? '', newText ?? '');
}

export function editStatsFromPatchText(patchText: string): EditSizeStats | null {
  let additions = 0;
  let deletions = 0;
  let modifications = 0;
  let runAdditions = 0;
  let runDeletions = 0;

  const flushRun = () => {
    if (runAdditions > 0 && runDeletions > 0) {
      modifications += Math.max(runAdditions, runDeletions);
    } else if (runAdditions > 0) {
      additions += runAdditions;
    } else if (runDeletions > 0) {
      deletions += runDeletions;
    }

    runAdditions = 0;
    runDeletions = 0;
  };

  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\+\+\+[ \t]/.test(line) || /^---[ \t]/.test(line)) {
      flushRun();
      continue;
    }

    if (line.startsWith('+')) {
      runAdditions += 1;
      continue;
    }

    if (line.startsWith('-')) {
      runDeletions += 1;
      continue;
    }

    flushRun();
  }

  flushRun();

  if (additions === 0 && deletions === 0 && modifications === 0) {
    return null;
  }

  return { additions, deletions, modifications };
}

function formatEditSizeHint(stats: EditSizeStats | null): string | null {
  if (!stats) {
    return null;
  }

  const total = stats.additions + stats.deletions + stats.modifications;
  if (total <= 0) {
    return null;
  }

  if (stats.additions > 0 && stats.deletions === 0 && stats.modifications === 0) {
    return formatLineHint('+', stats.additions);
  }

  if (stats.deletions > 0 && stats.additions === 0 && stats.modifications === 0) {
    return formatLineHint('-', stats.deletions);
  }

  return formatLineHint('', total);
}

export function getPatchTextFromInput(input: Record<string, unknown>): string | null {
  return typeof input.input === 'string' ? input.input
    : typeof input.patch === 'string' ? input.patch
    : typeof input.diff === 'string' ? input.diff
    : null;
}

export function getEditStatsFromInput(input: Record<string, unknown>): EditSizeStats | null {
  const directEditStats = editStatsFromEntry(input);
  if (directEditStats) {
    return directEditStats;
  }

  const editEntries = Array.isArray(input.edits) ? input.edits
    : Array.isArray(input.changes) ? input.changes
    : Array.isArray(input.replacements) ? input.replacements
    : null;
  if (editEntries) {
    let combinedStats: EditSizeStats = { additions: 0, deletions: 0, modifications: 0 };
    let foundAny = false;

    for (const entry of editEntries) {
      const stats = editStatsFromEntry(entry);
      if (!stats) {
        continue;
      }

      combinedStats = combineEditStats(combinedStats, stats);
      foundAny = true;
    }

    if (foundAny) {
      return combinedStats;
    }
  }

  const patchText = getPatchTextFromInput(input);
  return patchText ? editStatsFromPatchText(patchText) : null;
}

function readSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const requestedLineCount =
    lineCountFromRange(toolCall.input.startLine, toolCall.input.endLine)
    ?? lineCountFromRange(toolCall.input.start_line, toolCall.input.end_line)
    ?? toPositiveInteger(toolCall.input.limit)
    ?? toPositiveInteger(toolCall.input.maxLines)
    ?? toPositiveInteger(toolCall.input.max_lines)
    ?? toPositiveInteger(toolCall.input.lineCount)
    ?? toPositiveInteger(toolCall.input.line_count);
  const hasResolvedResultText = toolCall.status !== 'failed' && hasTextLikeValue(toolCall.result);
  const resultLineCount = toolCall.status === 'failed' ? null : lineCountFromTextLike(toolCall.result);
  if (hasResolvedResultText && !resultLineCount) {
    return null;
  }

  const lineCount =
    requestedLineCount && resultLineCount
      ? Math.min(requestedLineCount, resultLineCount)
      : requestedLineCount ?? resultLineCount;

  return formatLineHint('', lineCount);
}

function createSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const inputLineCount = lineCountFromRecordKeys(toolCall.input, WRITE_CONTENT_KEYS);
  return formatLineHint('+', inputLineCount);
}

function editSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  return formatEditSizeHint(getEditStatsFromInput(toolCall.input));
}

export function getToolCallSizeHint(toolCall: ToolCall): string | null {
  if (toolCall.status === 'failed') {
    return null;
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const hasPathInput = hasToolCallPathInput(toolCall);

  if (looksLikeReadTool(normalizedToolName) && hasPathInput) {
    return readSizeHintFromToolCall(toolCall);
  }

  if (looksLikeCreateTool(normalizedToolName) && hasPathInput) {
    return createSizeHintFromToolCall(toolCall);
  }

  if (looksLikeEditTool(normalizedToolName)) {
    return editSizeHintFromToolCall(toolCall);
  }

  return null;
}
