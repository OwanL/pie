import type { ToolCall } from '../../../lib/protocol/index.js';
import { isRecord } from '../../../../lib/validation/type-guards';
import { normalizeToolCallName } from '../tool-call-summary-model';
import { visualToolInput, requestedReplacements } from './display-model';
import { isCommandSummaryTool } from './summary-model';

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/** Compact details explicitly supplied with a tool request; never describes
 * inferred defaults or claims that a requested operation was applied. */
export function toolHeaderDetail(toolCall: ToolCall): string | null {
  const name = normalizeToolCallName(toolCall.name);
  const input = toolCall.status === 'drafting' || toolCall.status === 'ready'
    ? visualToolInput(toolCall)
    : toolCall.input;
  if (!isRecord(input)) return null;

  if (name === 'read' || name === 'cat') {
    return isPositiveInteger(input.offset) ? `from line ${input.offset}` : null;
  }

  if (name === 'edit') {
    const count = requestedReplacements(input).length;
    if (count <= 1) return null;
    if (toolCall.status === 'drafting' || toolCall.status === 'ready') return `${count} replacements so far`;
    if (toolCall.status === 'running' || toolCall.status === 'completed' || toolCall.status === 'failed') return `${count} replacements`;
    return null;
  }

  if (isCommandSummaryTool(toolCall.name)) {
    return isPositiveInteger(input.timeout) ? `timeout ${input.timeout}s` : null;
  }

  if (name !== 'grep' && name !== 'search') return null;
  const modifiers: string[] = [];
  if (input.ignoreCase === true) modifiers.push('ignore case');
  if (input.literal === true) modifiers.push('literal');
  if (isPositiveInteger(input.context)) modifiers.push(`${input.context} context lines`);
  if (typeof input.glob === 'string') {
    const glob = input.glob.replace(/\s+/g, ' ').trim();
    if (glob) modifiers.push(`glob ${glob}`);
  }

  let detail = '';
  for (const modifier of modifiers.slice(0, 2)) {
    const separator = detail ? ', ' : '';
    const available = 80 - detail.length - separator.length;
    if (available <= 0) break;
    const bounded = modifier.length <= available ? modifier : `${modifier.slice(0, Math.max(0, available - 1))}…`;
    if (!bounded) break;
    detail += separator + bounded;
  }
  return detail || null;
}
