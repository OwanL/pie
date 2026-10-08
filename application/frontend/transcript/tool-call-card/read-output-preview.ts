import type { ToolCall } from '../../../lib/protocol/index.js';
import { stripAnsiEscapes } from '../tool-call-analysis';
import { normalizeToolCallName } from '../tool-call-summary-model';

export interface ReadOutputPreview {
  start: string;
  end?: string;
}

const SNIPPET_CHARACTERS = 90;
const SCAN_CHARACTERS = 2048;
const SCAN_PARTS = 32;
const SCAN_LINES = 32;

interface Sample {
  text: string;
  complete: boolean;
}

/** Sample the edges without joining, serializing, or traversing the full result. */
function sample(content: string | unknown[], fromEnd: boolean): Sample {
  if (typeof content === 'string') {
    return {
      text: fromEnd ? content.slice(-SCAN_CHARACTERS) : content.slice(0, SCAN_CHARACTERS),
      complete: content.length <= SCAN_CHARACTERS,
    };
  }
  let text = '';
  let visited = 0;
  for (let i = fromEnd ? content.length - 1 : 0;
    i >= 0 && i < content.length && visited < SCAN_PARTS;
    i += fromEnd ? -1 : 1) {
    visited++;
    const part = content[i];
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text) continue;
    const available = SCAN_CHARACTERS - text.length - (text ? 1 : 0);
    if (available <= 0) return { text, complete: false };
    const piece = fromEnd ? block.text.slice(-available) : block.text.slice(0, available);
    text = fromEnd ? piece + (text ? '\n' + text : '') : text + (text ? '\n' : '') + piece;
    if (block.text.length > available) return { text, complete: false };
  }
  return { text, complete: visited === content.length };
}

function cleanSample(text: string): string {
  // ANSI processing and continuation recognition operate only on bounded slices.
  return stripAnsiEscapes(text).replace(
    /(?:\r?\n|^)[ \t]*\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]\r\n]* limit\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/,
    '',
  );
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function edgeLine(text: string, fromEnd: boolean): string {
  let boundary = fromEnd ? text.length : 0;
  let lines = 0;
  for (let i = fromEnd ? text.length - 1 : 0;
    fromEnd ? i >= -1 : i <= text.length;
    i += fromEnd ? -1 : 1) {
    if (i !== -1 && i !== text.length && text[i] !== '\n') continue;
    const line = singleLine(fromEnd ? text.slice(i + 1, boundary) : text.slice(boundary, i));
    if (line) {
      if (line.length <= SNIPPET_CHARACTERS) return line;
      return fromEnd
        ? '…' + line.slice(-(SNIPPET_CHARACTERS - 1))
        : line.slice(0, SNIPPET_CHARACTERS - 1) + '…';
    }
    if (++lines >= SCAN_LINES) break;
    boundary = fromEnd ? i : i + 1;
  }
  return '';
}

/** Lightweight completed-read header text, using only the directly present result.
 * Does not fetch lazy details or inspect result references, summaries, or images.
 * Work is capped at 2048 characters / 32 blocks / 32 lines per edge.
 */
export function readOutputPreview(toolCall: ToolCall): ReadOutputPreview | null {
  if (toolCall.status !== 'completed' || normalizeToolCallName(toolCall.name) !== 'read') return null;
  const result = toolCall.result;
  const content = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
      ? (result as { content?: unknown }).content
      : undefined;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;

  const first = sample(content, false);
  const firstText = cleanSample(first.text);
  const short = singleLine(firstText);
  if (first.complete && short.length <= SNIPPET_CHARACTERS) return short ? { start: short } : null;

  const start = edgeLine(firstText, false);
  const end = edgeLine(cleanSample(sample(content, true).text), true);
  if (!start) return end ? { start: end } : null;
  return end && end !== start ? { start, end } : { start };
}
