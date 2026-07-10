import type { ToolCall } from '../protocol';
import { isRecord } from '../type-guards';
import {
  getSkillNameFromToolCall,
  normalizeToolCallName,
  summarizeObject,
  summarizeStringList,
  summarizeSubagentToolCallInput,
  summarizeTaskEntries,
  summarizeUnknown,
} from './summary';
import {
  countTextLines,
  createEmptyFileMutationDelta,
  getFileExtensionFromToolCall,
  getFileMutationFromToolCall,
  getToolCallSizeHint,
  mergeFileMutationDelta,
  type FileExtensionAnalysis,
  type FileMutationDelta,
} from './mutation';
import {
  classifyVerificationCommandKindsFromInput,
  createEmptySubagentTaskScoreRollup,
  extractSubagentUsage,
  type SubagentTaskScoreRollup,
} from './verification';
import type {
  ToolFailureKind,
  ToolResultIssueKind,
  VerificationCommandKind,
} from '../../../../shared/tool-analysis-kinds.js';

export type {
  ToolFailureKind,
  ToolResultIssueKind,
  TreatmentChangeKind,
  VerificationCommandKind,
} from '../../../../shared/tool-analysis-kinds.js';
export type { FileMutationDelta, SubagentTaskScoreRollup, FileExtensionAnalysis };
export {
  countTextLines,
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
  summarizeStringList,
  summarizeTaskEntries,
  summarizeUnknown,
  summarizeObject,
  getSkillNameFromToolCall,
  getToolCallSizeHint,
  getFileExtensionFromToolCall,
  mergeFileMutationDelta,
  createEmptyFileMutationDelta,
  createEmptySubagentTaskScoreRollup,
};

export interface ToolFailureDetails {
  kind: ToolFailureKind;
  exitCode: number | null;
  errorExcerpt: string;
}

export interface ToolResultIssueDetails {
  kind: ToolResultIssueKind;
  exitCode: number | null;
  errorExcerpt: string;
  verificationKinds: VerificationCommandKind[];
}

export interface ToolCallAnalysis {
  normalizedToolName: string;
  skillName: string | null;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  subagentScoredTaskCount: number;
  subagentTaskScores: SubagentTaskScoreRollup;
  /** Cumulative input tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentInputTokens: number;
  /** Cumulative output tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentOutputTokens: number;
  /** Cumulative cache-read tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentCacheReadTokens: number;
  /** Cumulative cache-write tokens consumed by spawned sub-agent sessions (0 when none). */
  subagentCacheWriteTokens: number;
  verificationKinds: VerificationCommandKind[];
  fileMutation: FileMutationDelta;
  fileExtension: FileExtensionAnalysis | null;
  /** Execution failure (the tool could not do its job), or null. */
  failure: ToolFailureDetails | null;
  /** Non-success result (tool ran fine, outcome was not success), or null. */
  resultIssue: ToolResultIssueDetails | null;
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function extractCommandText(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (!isRecord(input)) {
    return '';
  }
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  if (Array.isArray(input.args) && input.args.every((item) => typeof item === 'string')) {
    return input.args.join(' ');
  }
  return '';
}

function stringifyResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const parts = content
        .filter(isRecord)
        .map((part) => typeof part.text === 'string' ? part.text : '')
        .filter((text) => text.length > 0);
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }
    for (const key of ['message', 'error', 'stderr', 'stdout']) {
      const value = result[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result ?? '');
  }
}

/** Strip ANSI CSI escape sequences (colors, cursor moves, etc.) from text.
 *  Used both for failure-analysis excerpts and for terminal/tool-result
 *  display so forced-color tools (e.g. `ls --color=always`, test runners with
 *  `--color`) don't leak raw `\x1b[..m` codes into the UI. */
export function stripAnsiEscapes(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matching ANSI ESC sequences
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export function extractExitCode(result: unknown, text: string): number | null {
  if (isRecord(result)) {
    for (const key of ['exitCode', 'code', 'status']) {
      const value = result[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
      }
    }
  }
  const match = text.match(/(?:Command exited with code|exit code|exited with code)\s+(-?\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function formatErrorExcerpt(text: string, maxLength = 240): string {
  const normalized = stripAnsiEscapes(text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
}

function isProbeNoMatch(command: string, text: string, exitCode: number | null): boolean {
  if (exitCode !== 1) {
    return false;
  }
  const normalizedCommand = command.trim().toLowerCase();
  if (!/(^|\s)(rg|grep|find|ps|test|\[)(\s|$)/.test(normalizedCommand)) {
    return false;
  }
  const normalizedText = text.replace(/Command exited with code\s+1/ig, '').replace(/\(no output\)/ig, '').trim();
  return normalizedText.length === 0;
}

/**
 * Classify a failed tool call into exactly one of:
 *  - an execution `failure` (the tool could not do its job), or
 *  - a `resultIssue` (the tool ran fine but reported a non-success result:
 *    a failing test/build/lint, or an empty search).
 *
 * A failed call is never both. `timeout` is treated as an execution failure
 * even for verification commands, because a killed command did not produce a
 * usable result. Verification commands that ran and exited non-zero become a
 * `verification_failure` result issue; empty probe/search results become a
 * `probe_no_match` result issue.
 */
function classifyToolOutcome(
  toolCall: ToolCall,
  verificationKinds: VerificationCommandKind[],
): { failure: ToolFailureDetails | null; resultIssue: ToolResultIssueDetails | null } {
  if (toolCall.status !== 'failed') {
    return { failure: null, resultIssue: null };
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name) || toolCall.name;
  const command = extractCommandText(toolCall.input);
  const resultText = stringifyResultText(toolCall.result);
  const combinedText = `${command}\n${resultText}`;
  const exitCode = extractExitCode(toolCall.result, resultText);
  const lower = combinedText.toLowerCase();
  const errorExcerpt = formatErrorExcerpt(resultText);

  // Execution failures — the tool could not complete its job.
  if (/tool\s+[^\s]+\s+not found/i.test(resultText)) {
    return { failure: { kind: 'unavailable_tool', exitCode, errorExcerpt }, resultIssue: null };
  }
  if (/command timed out|timed out after|timeout/i.test(resultText)) {
    return { failure: { kind: 'timeout', exitCode, errorExcerpt }, resultIssue: null };
  }

  // Non-success results — the tool ran fine but the outcome was not success.
  if (verificationKinds.length > 0) {
    return {
      failure: null,
      resultIssue: { kind: 'verification_failure', exitCode, errorExcerpt, verificationKinds },
    };
  }
  if (isProbeNoMatch(command, resultText, exitCode)) {
    return {
      failure: null,
      resultIssue: { kind: 'probe_no_match', exitCode, errorExcerpt, verificationKinds: [] },
    };
  }

  // Remaining execution failures.
  if (/enoent|no such file or directory|cannot find path|cannot access|filenotfounderror/.test(lower)) {
    return { failure: { kind: 'missing_file_or_path', exitCode, errorExcerpt }, resultIssue: null };
  }
  if (
    normalizedToolName === 'edit'
    && /validation failed|oldtext|old text|exact text|occurrences|unique|overlap|must not be empty|must be object/.test(lower)
  ) {
    return { failure: { kind: 'invalid_tool_arguments', exitCode, errorExcerpt }, resultIssue: null };
  }
  if (normalizedToolName === 'read' && /offset .* beyond end of file|invalid|must be/.test(lower)) {
    return { failure: { kind: 'invalid_tool_arguments', exitCode, errorExcerpt }, resultIssue: null };
  }
  if (/syntax error|unexpected token|command not found|not recognized|parsererror|parsefile/.test(lower)) {
    return { failure: { kind: 'shell_command_error', exitCode, errorExcerpt }, resultIssue: null };
  }
  if (exitCode !== null) {
    return { failure: { kind: 'nonzero_exit', exitCode, errorExcerpt }, resultIssue: null };
  }
  return { failure: { kind: 'unknown', exitCode, errorExcerpt }, resultIssue: null };
}

export function analyzeToolCall(toolCall: ToolCall): ToolCallAnalysis {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const skillName = getSkillNameFromToolCall(toolCall);
  const verificationKinds = classifyVerificationCommandKindsFromInput(toolCall.input);
  const subagentUsage = normalizedToolName === 'subagent'
    ? extractSubagentUsage(toolCall.input, toolCall.result)
    : { taskCount: 0, agents: [] as string[], scoredTaskCount: 0, taskScores: createEmptySubagentTaskScoreRollup(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const fileMutation = getFileMutationFromToolCall(toolCall);
  const fileExtension = getFileExtensionFromToolCall(toolCall);
  const { failure, resultIssue } = classifyToolOutcome(toolCall, verificationKinds);

  return {
    normalizedToolName,
    skillName,
    subagentCallCount: normalizedToolName === 'subagent' ? 1 : 0,
    subagentTaskCount: subagentUsage.taskCount,
    subagentAgentNames: subagentUsage.agents,
    subagentScoredTaskCount: subagentUsage.scoredTaskCount,
    subagentTaskScores: subagentUsage.taskScores,
    subagentInputTokens: subagentUsage.inputTokens,
    subagentOutputTokens: subagentUsage.outputTokens,
    subagentCacheReadTokens: subagentUsage.cacheReadTokens,
    subagentCacheWriteTokens: subagentUsage.cacheWriteTokens,
    verificationKinds,
    fileMutation,
    fileExtension,
    failure,
    resultIssue,
  };
}

export function incrementNamedCount(record: Record<string, number>, key: string): void {
  incrementCount(record, key);
}
