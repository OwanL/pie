import type { ToolCall } from '../../../lib/protocol/index.js';
import { normalizeToolCallName } from '../tool-call-summary-model';
import { isRecord } from '../../../../lib/validation/type-guards';
import { looksLikePathToken, splitQuotedToken, unwrapQuotedToken } from '../../lib/formatting/looks-like-path-token';

import type {
  ToolCallHeaderCommandSummaryModel,
  ToolCallHeaderSummaryModel,
} from './types';

const SHELL_WRAPPER_TOKENS = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nohup',
  'sudo',
  'time',
]);

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenizeShellSnippet(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function isCommandSummaryTool(name: string): boolean {
  const normalizedName = normalizeToolCallName(name);
  return normalizedName === 'bash'
    || normalizedName === 'cmd'
    || normalizedName === 'powershell'
    || normalizedName === 'shell'
    || normalizedName === 'sh';
}

function isShellAssignmentToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(unwrapQuotedToken(value));
}


function createCommandSummaryModel(commandText: string): ToolCallHeaderCommandSummaryModel | null {
  const normalized = normalizeInlineText(commandText);
  if (!normalized) {
    return null;
  }

  const tokens = tokenizeShellSnippet(normalized);
  if (tokens.length === 0) {
    return null;
  }

  let commandIndex = 0;
  while (commandIndex < tokens.length - 1) {
    const token = unwrapQuotedToken(tokens[commandIndex] ?? '');
    if (SHELL_WRAPPER_TOKENS.has(token) || isShellAssignmentToken(token)) {
      commandIndex += 1;
      continue;
    }
    break;
  }

  const prefix = tokens.slice(0, commandIndex).join(' ');
  const command = tokens[commandIndex] ?? tokens[0];
  const remainder = tokens.slice(commandIndex + 1);
  const pathIndex = remainder.findIndex(looksLikePathToken);
  const detail = (pathIndex >= 0 ? remainder.slice(0, pathIndex) : remainder).join(' ');
  const pathToken = pathIndex >= 0 ? remainder[pathIndex] : undefined;
  const splitPath = pathToken ? splitQuotedToken(pathToken) : null;
  const suffix = pathIndex >= 0 ? remainder.slice(pathIndex + 1).join(' ') : undefined;

  return {
    kind: 'command',
    command,
    title: normalized,
    ...(prefix ? { prefix } : {}),
    ...(detail ? { detail } : {}),
    ...(splitPath?.leadingQuote ? { pathLeadingQuote: splitPath.leadingQuote } : {}),
    ...(splitPath?.text ? { pathText: splitPath.text } : {}),
    ...(splitPath?.trailingQuote ? { pathTrailingQuote: splitPath.trailingQuote } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

function extractCommandText(toolCall: ToolCall | undefined): string | null {
  if (!toolCall || !isCommandSummaryTool(toolCall.name) || !isRecord(toolCall.input)) {
    return null;
  }

  return typeof toolCall.input.command === 'string'
    ? normalizeInlineText(toolCall.input.command) || null
    : null;
}

export function buildToolCallHeaderSummaryModel(
  name: string,
  summary: string | null,
  summaryPath?: string,
  toolCall?: ToolCall,
): ToolCallHeaderSummaryModel | null {
  const commandText = extractCommandText(toolCall);
  const commandSummary = commandText && isCommandSummaryTool(toolCall?.name ?? name)
    ? createCommandSummaryModel(commandText)
    : (!commandText && summary && isCommandSummaryTool(name)
      ? createCommandSummaryModel(summary)
      : null);

  if (commandSummary) {
    return commandSummary;
  }

  if (summary && (summaryPath || looksLikePathToken(summary))) {
    return {
      kind: 'path',
      text: summary,
      ...(summaryPath ? { title: summaryPath } : {}),
    };
  }

  return summary
    ? { kind: 'text', text: summary }
    : null;
}
