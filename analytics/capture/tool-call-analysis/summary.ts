import type { ToolCall } from '../../../harness/agent-processes/lib/rpc/message-contract.js';

const TOOL_CALL_SUMMARY_MAX_LENGTH = 300;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function normalizeToolCallName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function truncateText(text: string, maxLength = TOOL_CALL_SUMMARY_MAX_LENGTH): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3).trimEnd()}...`
    : text;
}

function summarizeText(text: string, maxLength = TOOL_CALL_SUMMARY_MAX_LENGTH): string | null {
  const normalized = normalizeText(text);
  return normalized ? truncateText(normalized, maxLength) : null;
}

import { isRecord } from '../../../lib/validation/type-guards';

export function summarizeStringList(value: unknown, maxItems = 3): string | null {
  if (!Array.isArray(value)) return null;

  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeText)
    .filter((item) => item.length > 0);

  if (items.length === 0) return null;

  const preview = items.slice(0, maxItems).join(', ');
  const suffix = items.length > maxItems ? ` +${items.length - maxItems} more` : '';
  return summarizeText(`${preview}${suffix}`);
}

export function summarizeTaskEntries(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const first = value[0];
  if (!isRecord(first)) return null;

  const task = typeof first.task === 'string' ? summarizeText(first.task, 180) : null;
  if (!task) return null;

  const agent = typeof first.agent === 'string' ? normalizeText(first.agent) : '';
  const suffix = value.length > 1 ? ` +${value.length - 1} more` : '';
  return summarizeText(`${agent ? `${agent}: ` : ''}${task}${suffix}`);
}

export function summarizeUnknown(value: unknown): string | null {
  if (typeof value === 'string') return summarizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const listSummary = summarizeStringList(value);
    if (listSummary) return listSummary;

    const firstRecord = value.find(isRecord);
    return firstRecord ? summarizeObject(firstRecord) : null;
  }

  if (isRecord(value)) return summarizeObject(value);
  return null;
}

export function summarizeObject(value: Record<string, unknown>): string | null {
  const multiTaskSummary = summarizeTaskEntries(value.tasks ?? value.chain);
  if (multiTaskSummary) return multiTaskSummary;

  const directFields = [
    value.command,
    value.task,
    value.query,
    value.prompt,
    value.explanation,
    value.text,
    value.goal,
    value.description,
    value.element,
    value.url,
    value.path,
    value.filePath,
    value.dirPath,
    value.fileUri,
    value.includePattern,
    value.workspaceFolder,
    value.symbol,
    value.expression,
    value.commandId,
    value.selector,
    value.question,
  ];

  for (const field of directFields) {
    const preview = summarizeUnknown(field);
    if (preview) return preview;
  }

  const listSummary = summarizeStringList(value.packageList ?? value.urls ?? value.paths ?? value.args);
  if (listSummary) return listSummary;

  for (const entry of Object.values(value)) {
    if (typeof entry === 'string' || Array.isArray(entry) || isRecord(entry)) {
      const preview = summarizeUnknown(entry);
      if (preview) return preview;
    }
  }

  const compact = summarizeText(JSON.stringify(value));
  return compact === '{}' ? null : compact;
}

export function summarizeSubagentToolCallInput(input: unknown): string | null {
  if (!isRecord(input)) return summarizeUnknown(input);

  const multiTaskSummary = summarizeTaskEntries(input.tasks ?? input.chain);
  if (multiTaskSummary) return multiTaskSummary;

  const task = typeof input.task === 'string' ? summarizeText(input.task, 240) : null;
  if (task) {
    const agent = typeof input.agent === 'string' ? summarizeText(input.agent, 24) : null;
    return agent ? summarizeText(`${agent}: ${task}`) : task;
  }

  return summarizeObject(input);
}

function skillNameFromPath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i);
  return match ? match[1] : null;
}

export function getSkillNameFromToolCall(toolCall: ToolCall): string | null {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  if (normalizedToolName !== 'read' && normalizedToolName !== 'read_file') {
    return null;
  }

  if (!isRecord(toolCall.input)) {
    return null;
  }

  const candidatePaths = [toolCall.input.filePath, toolCall.input.path, toolCall.input.fileUri];
  for (const candidatePath of candidatePaths) {
    if (typeof candidatePath !== 'string') {
      continue;
    }

    const skillName = skillNameFromPath(candidatePath);
    if (skillName) {
      return skillName;
    }
  }

  return null;
}
