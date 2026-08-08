import type { ToolCall } from '../../../../shared/protocol';

const SUMMARY_FIELDS = ['command', 'path', 'action', 'task', 'query'] as const;
const SUMMARY_MAX_CHARS = 180;

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= SUMMARY_MAX_CHARS
    ? compact
    : `${compact.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function displayScalar(value: unknown): string | null {
  if (typeof value === 'string') return compactText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return compactText(value.join(', '));
  }
  return null;
}

function parsedKnownField(argumentsText: string): { field: string; value: string } | null {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const field of SUMMARY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
      const value = displayScalar(record[field]);
      if (value) return { field, value };
    }
  } catch {
    // A ready payload can still be malformed. Display falls back to the same
    // bounded raw-text path as an incomplete drafting payload.
  }
  return null;
}

/** Decode a complete or still-open JSON string enough for display. The return
 * value is presentation-only and is never fed back into tool execution. */
function partialJsonString(text: string, start: number): string {
  let result = '';
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (char === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
        result += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16));
        index += 4;
      } else {
        result += escapes[char] ?? char;
      }
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') break;
    result += char;
  }
  if (escaped) result += '\\';
  return compactText(result);
}

function partialKnownField(argumentsText: string): { field: string; value: string } | null {
  for (const field of SUMMARY_FIELDS) {
    const match = new RegExp(`"${field}"\\s*:\\s*`, 'i').exec(argumentsText);
    if (!match) continue;
    const valueStart = match.index + match[0].length;
    const remainder = argumentsText.slice(valueStart);
    if (remainder.startsWith('"')) {
      const value = partialJsonString(argumentsText, valueStart);
      if (value) return { field, value };
      continue;
    }
    const primitive = compactText((remainder.match(/^[^,}\]]+/)?.[0] ?? '').trim());
    if (primitive) return { field, value: primitive };
  }
  return null;
}

export interface ProvisionalToolSummary {
  field?: string;
  text: string;
}

/** Human-readable, bounded presentation of provider-emitted argument text.
 * JSON parsing is display-only; `ToolCall.input` remains the execution
 * authority once the call starts. */
export function provisionalToolSummary(toolCall: ToolCall): ProvisionalToolSummary | null {
  if (toolCall.status !== 'drafting' && toolCall.status !== 'ready') return null;
  const argumentsText = toolCall.argumentsText ?? '';
  const known = toolCall.status === 'ready'
    ? parsedKnownField(argumentsText) ?? partialKnownField(argumentsText)
    : partialKnownField(argumentsText);
  const fallback = compactText(argumentsText) || '(waiting for arguments)';
  return {
    field: known?.field,
    text: known?.value || fallback,
  };
}
