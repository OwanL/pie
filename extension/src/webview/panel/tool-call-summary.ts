import type { ToolCall } from '../../shared/protocol';
import {
  getSkillNameFromToolCall as getSharedSkillNameFromToolCall,
  getToolCallSizeHint as getSharedToolCallSizeHint,
  normalizeToolCallName,
  summarizeSubagentToolCallInput as summarizeSharedSubagentToolCallInput,
  summarizeUnknown,
} from '../../shared/tool-call-analysis';
import { DIRECT_FILE_PATH_KEYS, GENERIC_PATH_KEYS } from '../../shared/tool-call-analysis/mutation-tools';
import {
  relativePathFromBase,
  truncatePathText,
} from '../../shared/path-utils.js';

export interface ToolCallPresentation {
  name: string;
  summary: string | null;
  summaryPath?: string;
  sizeHint?: string;
  variant?: 'skill-load';
}

export interface ToolCallPresentationOptions {
  workingDirectory?: string | null;
}

import { isRecord } from '../../shared/type-guards';


function isAbsoluteFsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.startsWith('//');
}

function toFileSystemPath(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      return null;
    }

    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }

    return parsed.host ? `//${parsed.host}${pathname}` : pathname;
  } catch {
    // Not a valid file: URL; no path to extract.
    return null;
  }
}

function joinFileSystemPath(basePath: string, relativePath: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/, '');
  const relative = relativePath.replace(/^[\\/]+/, '');

  if (!base) {
    return basePath.startsWith('/') ? `/${relative}` : relative;
  }

  return `${base}${separator}${relative}`;
}

function convertPathSeparators(value: string, separator: string): string {
  return separator === '\\' ? value.replace(/\//g, '\\') : value;
}

function summarizePathCandidate(rawValue: string, workingDirectory?: string | null): { summary: string; summaryPath?: string } | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  const fileSystemPath = toFileSystemPath(value);
  if (fileSystemPath) {
    const relativePath = workingDirectory ? relativePathFromBase(fileSystemPath, workingDirectory) : null;
    return {
      summary: truncatePathText(relativePath ?? fileSystemPath),
      summaryPath: fileSystemPath,
    };
  }

  if (isAbsoluteFsPath(value)) {
    const separator = value.includes('\\') ? '\\' : '/';
    const relativePath = workingDirectory ? relativePathFromBase(value, workingDirectory) : null;
    return {
      summary: truncatePathText(relativePath ? convertPathSeparators(relativePath, separator) : value),
      summaryPath: value,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }

  return {
    summary: truncatePathText(value),
    summaryPath: workingDirectory ? joinFileSystemPath(workingDirectory, value) : undefined,
  };
}

function firstStringInList(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      return entry;
    }
  }

  return null;
}

function summarizeFieldPathCandidate(
  fieldValue: unknown,
  workingDirectory?: string | null,
): { summary: string; summaryPath?: string } | null {
  if (typeof fieldValue === 'string') {
    return summarizePathCandidate(fieldValue, workingDirectory);
  }

  const firstEntry = firstStringInList(fieldValue);
  return firstEntry ? summarizePathCandidate(firstEntry, workingDirectory) : null;
}

function looksLikeDirectFileTool(toolName: string): boolean {
  return /(?:^|[_-])(read|open|create|write|update|rename|delete|edit)(?:$|[_-])/.test(toolName);
}

function summarizeToolCallPath(toolCall: ToolCall, workingDirectory?: string | null): { summary: string; summaryPath?: string } | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name);
  for (const key of DIRECT_FILE_PATH_KEYS) {
    const summary = summarizeFieldPathCandidate(toolCall.input[key], workingDirectory);
    if (summary) {
      return summary;
    }
  }

  if (normalizedToolName === 'read' || looksLikeDirectFileTool(normalizedToolName)) {
    for (const key of GENERIC_PATH_KEYS) {
      const summary = summarizeFieldPathCandidate(toolCall.input[key], workingDirectory);
      if (summary) {
        return summary;
      }
    }
  }

  return null;
}

function formatPresentationSizeHint(sizeHint: string | null | undefined): string | undefined {
  if (!sizeHint) {
    return undefined;
  }

  return sizeHint.replace(/^~/, '');
}

export function getToolCallPresentation(
  toolCall: ToolCall,
  options: ToolCallPresentationOptions = {},
): ToolCallPresentation {
  const sizeHint = formatPresentationSizeHint(getSharedToolCallSizeHint(toolCall));
  const skillName = getSharedSkillNameFromToolCall(toolCall);
  if (skillName) {
    return {
      name: `Load skill ${skillName}`,
      summary: null,
      ...(sizeHint ? { sizeHint } : {}),
      variant: 'skill-load',
    };
  }

  const pathSummary = summarizeToolCallPath(toolCall, options.workingDirectory);
  if (pathSummary) {
    return {
      name: toolCall.name,
      summary: pathSummary.summary,
      ...(pathSummary.summaryPath ? { summaryPath: pathSummary.summaryPath } : {}),
      ...(sizeHint ? { sizeHint } : {}),
    };
  }

  return {
    name: toolCall.name,
    summary: summarizeToolCall(toolCall),
    ...(sizeHint ? { sizeHint } : {}),
  };
}

export function summarizeToolCall(toolCall: ToolCall): string | null {
  return toolCall.name === 'subagent'
    ? summarizeSharedSubagentToolCallInput(toolCall.input)
    : summarizeUnknown(toolCall.input);
}
