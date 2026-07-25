import type { ToolCall } from '../../../../shared/protocol';
import { textFromToolResult } from '../highlight';
import { hasImageToolResult } from './tool-result-content';

export function formatToolCallResultForDisplay(toolCall: Pick<ToolCall, 'name' | 'result'>): string {
  if (toolCall.result === undefined) {
    return '';
  }

  const readableText = textFromToolResult(toolCall.result);
  if (readableText !== undefined) {
    return readableText;
  }
  // No readable text. A result carrying image-typed parts would leak raw
  // base64 through `JSON.stringify` — return a bounded placeholder so the
  // display/summary formatter never emits image data as text/YAML.
  if (hasImageToolResult(toolCall.result)) {
    return '';
  }
  return JSON.stringify(toolCall.result, null, 2);
}
