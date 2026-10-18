import type { ToolCall } from '../../../lib/protocol/index.js';
import { isRecord } from '../../../../lib/validation/type-guards';
import { textFromToolResult } from '../tool-result-text';
import { normalizeToolCallName } from '../tool-call-summary-model';
import { provisionalToolSummary } from './provisional';

/** Omit only stock acknowledgements whose useful content is already visualized.
 * This is a display decision: the original result remains available to inspection. */
export function isRedundantToolConfirmation(toolCall: ToolCall): boolean {
  if (toolCall.status !== 'completed' || !isRecord(toolCall.input)) return false;
  const name = normalizeToolCallName(toolCall.name);
  if (name !== 'edit' && name !== 'write') return false;
  const path = toolCall.input.path;
  if (typeof path !== 'string' || !path) return false;
  if (name === 'write' && typeof toolCall.input.content !== 'string') return false;

  const result = toolCall.result;
  let text: string;
  let details: Record<string, unknown> | undefined;
  if (typeof result === 'string') text = result;
  else {
    if (!isRecord(result)
      || Object.keys(result).some((key) => !['content', 'details', 'isError'].includes(key))
      || (result.isError !== undefined && result.isError !== false)) return false;
    if (!Array.isArray(result.content) || result.content.length !== 1) return false;
    const part = result.content[0];
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string'
      || Object.keys(part).some((key) => key !== 'type' && key !== 'text')) return false;
    text = part.text;
    if (result.details !== undefined) {
      if (!isRecord(result.details)) return false;
      details = result.details;
    }
  }

  if (name === 'edit') {
    // A requested replacement is not proof of the applied change. Retain the
    // acknowledgement unless ToolCallBody can show the actual result diff.
    if (!details || typeof details.diff !== 'string' || !details.diff.trim()) return false;
    if (Object.keys(details).some((key) => !['diff', 'patch', 'firstChangedLine'].includes(key))
      || (details.patch !== undefined && typeof details.patch !== 'string')
      || (details.firstChangedLine !== undefined && typeof details.firstChangedLine !== 'number')) return false;
    const legacy = `Successfully replaced text in ${path}.`;
    const prefix = 'Successfully replaced ';
    const suffix = ` block(s) in ${path}.`;
    return text === legacy || (text.startsWith(prefix) && text.endsWith(suffix)
      && /^\d+$/.test(text.slice(prefix.length, -suffix.length)));
  }
  if (details && Object.keys(details).length !== 0) return false;
  const prefix = 'Successfully wrote ';
  const suffix = ` bytes to ${path}`;
  return [suffix, `${suffix}.`].some((ending) => text.startsWith(prefix) && text.endsWith(ending)
    && /^\d+$/.test(text.slice(prefix.length, -ending.length)));
}

/** Display-only repair of an unfinished JSON string/container. Never used for
 * execution or treated as an applied edit. Invalid prefixes fall back to text. */
export function visualToolInput(toolCall: ToolCall): unknown {
  if (toolCall.status !== 'drafting' && toolCall.status !== 'ready') return toolCall.input;
  const text = toolCall.argumentsText ?? (typeof toolCall.input === 'string' ? toolCall.input : '');
  if (!text) return toolCall.input;
  try { return JSON.parse(text); } catch { /* provisional prefix */ }
  const closing: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') closing.push('}');
    else if (char === '[') closing.push(']');
    else if (char === '}' || char === ']') {
      if (closing.pop() !== char) return toolCall.input;
    }
  }
  let repaired = text;
  if (inString) {
    if (escaped) repaired = repaired.slice(0, -1);
    // Only an odd backslash run starts an escape; paired slashes are literal.
    repaired = repaired.replace(/(\\+)u[\da-fA-F]{0,3}$/, (suffix, slashes: string) =>
      slashes.length % 2 === 1 ? slashes.slice(0, -1) : suffix);
    repaired += '"';
  } else repaired = repaired.trimEnd().replace(/,$/, '').replace(/:$/, ':null');
  repaired += closing.reverse().join('');
  try { return JSON.parse(repaired); } catch { return toolCall.input; }
}

export interface Replacement { oldText: string; newText: string }
export function requestedReplacements(input: unknown): Replacement[] {
  if (!isRecord(input)) return [];
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  return edits.filter((edit): edit is Replacement => isRecord(edit) && typeof edit.oldText === 'string' && typeof edit.newText === 'string');
}

export function liveToolPreview(toolCall: ToolCall, lineBudget = 2): { text: string; provisional: boolean; truncated: boolean; lines: number; editIndex?: number } | null {
  const provisional = toolCall.status === 'drafting' || toolCall.status === 'ready';
  if (!provisional && toolCall.status !== 'running') return null;
  let text = textFromToolResult(toolCall.result) ?? '';
  let editIndex: number | undefined;
  if (provisional) {
    const input = visualToolInput(toolCall);
    const edits = requestedReplacements(input);
    const lastEdit = edits[edits.length - 1];
    if (lastEdit && normalizeToolCallName(toolCall.name) === 'edit') editIndex = edits.length;
    const content = isRecord(input) ? input.content ?? input.command : undefined;
    // Only omit an exact, short bash command already present in the header.
    // Keep whitespace-sensitive, multiline, long, and malformed drafts visible.
    const command = isRecord(input) ? input.command : undefined;
    const summary = provisionalToolSummary(toolCall);
    if (normalizeToolCallName(toolCall.name) === 'bash' && input !== toolCall.input
      && typeof command === 'string' && command.length <= 180
      && !/[\r\n]/.test(command) && content === command && !lastEdit
      && summary?.field === 'command' && summary.text === command) return null;
    text = lastEdit?.newText ?? (typeof content === 'string' ? content : toolCall.argumentsText ?? '');
  }
  if (!text.trim()) return null;
  const lines = Math.max(1, Math.min(3, Math.floor(lineBudget) || 2));
  const tail = text.slice(-4000).replace(/(?:\r?\n)+$/, '').split('\n');
  const clipped = tail.slice(-lines).map((line) => line.length > 240 ? `${line.slice(0, 239)}…` : line).join('\n');
  // Short drafts/output use only their actual rows, not an empty reserved
  // budget. Growth remains bounded by the same compact preview limit.
  return { text: clipped, provisional, truncated: tail.length > lines || text.length > 4000, lines: Math.min(lines, tail.length), ...(editIndex === undefined ? {} : { editIndex }) };
}
