// Browser-safe plain tool-result text; no highlighting or YAML dependency.
import { stripAnsiEscapes } from './tool-call-analysis';

export interface ToolResultContentPartLike {
  type?: string;
  text?: string;
}

/**
 * Extract concatenated text from a tool result's `content` parts (the SDK's
 * standard result shape). Returns `undefined` when there is no text content,
 * so callers can fall back to structured formatting.
 *
 * ANSI CSI escape sequences are stripped here so forced-color tool output
 * (e.g. `ls --color=always`, test runners with `--color`) renders as plain
 * text instead of leaking raw `\x1b[..m` codes. This is the single display
 * chokepoint for human-readable tool-result text, so all render paths
 * (terminal pane, error detail, activity tail) get clean text.
 */
export function textFromToolResult(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }
  if (typeof result === 'string') {
    return stripAnsiEscapes(result) || undefined;
  }
  if (typeof result !== 'object') {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') {
    return stripAnsiEscapes(content) || undefined;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is ToolResultContentPartLike =>
          Boolean(part) && typeof part === 'object',
      )
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n\n');
    const cleaned = stripAnsiEscapes(text);
    return cleaned || undefined;
  }
  return undefined;
}

/**
 * True when a result object carries nothing but `content` (+ `details`
 * metadata) — i.e. it is essentially plain text, not structured data worth
 * showing field-by-field as YAML.
 */
export function isTextOnlyToolResult(result: unknown): boolean {
  if (result == null || typeof result !== 'object') {
    return true;
  }
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length === 0) {
    return true;
  }
  return keys.every((key) => key === 'content' || key === 'details');
}
