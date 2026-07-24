/** Compact, blinded rendering of session JSONL evidence. */
import * as fs from 'node:fs';

interface EntryLike {
  type?: string;
  message?: MessageLike;
}
interface MessageLike {
  role?: string;
  content?: unknown;
  isError?: boolean;
  toolName?: string;
  command?: string;
  output?: string;
}
export interface TranscriptTurn {
  index: number;
  role: string;
  text: string;
  tools: string[];
  isError?: boolean;
  toolName?: string;
}
export interface ParsedTranscript {
  path: string;
  totalEntries: number;
  turnCount: number;
  truncated: boolean;
  truncationReasons: string[];
  turns: TranscriptTurn[];
}

const MAX_MSG_CHARS = 1_600;
const MAX_TOTAL_CHARS = 32_000;

interface TruncationCounts { messages: number; thinking: number; toolHints: number }
function truncate(value: string, length: number, count: () => void): string {
  if (value.length <= length) return value;
  count();
  return `${value.slice(0, length)} …(+${value.length - length} chars)`;
}
function extractText(content: unknown, counts: TruncationCounts): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.['type'] === 'text' && typeof part['text'] === 'string') parts.push(part['text']);
    else if (part?.['type'] === 'thinking' && typeof part['thinking'] === 'string') {
      parts.push(`[thinking: ${truncate(part['thinking'], 200, () => { counts.thinking += 1; })}]`);
    }
  }
  return parts.join('\n');
}
function extractToolNames(content: unknown, counts: TruncationCounts): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.['type'] !== 'toolCall' || typeof part['name'] !== 'string') continue;
    let detail = '';
    const args = part['arguments'];
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>;
      const hint = record['path'] ?? record['command'] ?? record['action'] ?? record['url'] ?? record['query'];
      if (typeof hint === 'string') detail = `(${truncate(hint, 60, () => { counts.toolHints += 1; })})`;
    }
    names.push(detail ? `${part['name']}${detail}` : part['name']);
  }
  return names;
}
function extractToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((part) => typeof part?.['text'] === 'string')
    .map((part) => part['text'] as string)
    .join('\n');
}

/** Parses already-snapshotted bytes; no filesystem reads occur here. */
export function parseSessionTranscriptBytes(sessionPath: string, raw: Buffer | string, maxTurns = 40): ParsedTranscript {
  const content = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const turns: TranscriptTurn[] = [];
  const counts: TruncationCounts = { messages: 0, thinking: 0, toolHints: 0 };
  let totalEntries = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: EntryLike;
    try { entry = JSON.parse(trimmed) as EntryLike; } catch { continue; }
    totalEntries += 1;
    if (entry.type === 'model_change' || entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    const role = message.role ?? 'unknown';
    let turn: TranscriptTurn | undefined;
    if (role === 'user') {
      turn = { index: 0, role: 'USER', text: extractText(message.content, counts).trim(), tools: [] };
    } else if (role === 'assistant') {
      turn = { index: 0, role: 'ASSISTANT', text: extractText(message.content, counts).trim(), tools: extractToolNames(message.content, counts) };
    } else if (role === 'toolResult') {
      turn = { index: 0, role: 'TOOL_RESULT', text: extractToolResult(message.content).trim(), tools: [], isError: !!message.isError, toolName: typeof message.toolName === 'string' ? message.toolName : undefined };
    } else if (role === 'bashExecution') {
      const command = typeof message.command === 'string' ? message.command : '';
      const output = typeof message.output === 'string' ? message.output : '';
      turn = { index: 0, role: 'BASH', text: `$ ${command}\n${output}`.trim(), tools: [] };
    }
    if (turn) {
      turn.text = truncate(turn.text, MAX_MSG_CHARS, () => { counts.messages += 1; });
      turn.index = turns.length + 1;
      turns.push(turn);
    }
  }

  const firstUser = turns.find((turn) => turn.role === 'USER');
  const recent = turns.slice(-maxTurns);
  let kept = firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
  const turnExcerpted = recent.length < turns.length;
  kept = kept.map((turn, index) => ({ ...turn, index: index + 1 }));
  const truncationReasons: string[] = [];
  if (turnExcerpted) truncationReasons.push(`Transcript turn selection omitted ${turns.length - recent.length} earlier turn(s).`);
  if (counts.messages) truncationReasons.push(`${counts.messages} rendered turn body/bodies exceeded ${MAX_MSG_CHARS} characters.`);
  if (counts.thinking) truncationReasons.push(`${counts.thinking} thinking block(s) exceeded 200 characters.`);
  if (counts.toolHints) truncationReasons.push(`${counts.toolHints} tool argument hint(s) exceeded 60 characters.`);
  return { path: sessionPath, totalEntries, turnCount: turns.length, truncated: truncationReasons.length > 0, truncationReasons, turns: kept };
}

/** Compatibility helper for direct transcript consumers. Evidence building uses the byte-snapshot parser above. */
export function parseSessionTranscript(sessionPath: string, maxTurns = 40): ParsedTranscript {
  let raw: Buffer;
  try { raw = fs.readFileSync(sessionPath); }
  catch (error) { throw new Error(`Could not read session file ${sessionPath}: ${(error as Error).message}`); }
  return parseSessionTranscriptBytes(sessionPath, raw, maxTurns);
}

export function renderTranscriptDetailed(parsed: ParsedTranscript): { text: string; truncated: boolean; limitation?: string } {
  const lines = [
    `Session: ${parsed.path}`,
    `Entries: ${parsed.totalEntries} | turns: ${parsed.turnCount}${parsed.truncated ? ' (excerpted)' : ''}`,
    '---',
  ];
  let budget = MAX_TOTAL_CHARS;
  let renderTruncated = false;
  for (const turn of parsed.turns) {
    const toolTag = turn.tools.length ? ` [tools: ${turn.tools.join(', ')}]` : '';
    const errorTag = turn.isError ? ' (ERROR)' : '';
    const roleTag = turn.role === 'TOOL_RESULT' && turn.toolName ? `${turn.role}(${turn.toolName})` : turn.role;
    const line = `[${turn.index}] ${roleTag}${errorTag}${toolTag}${turn.text ? `: ${turn.text}` : ''}`;
    if (budget <= 0) { renderTruncated = true; break; }
    if (line.length > budget) {
      lines.push(`${line.slice(0, budget)}…`);
      renderTruncated = true;
      budget = 0;
      break;
    }
    lines.push(line);
    budget -= line.length + 1;
  }
  if (renderTruncated) lines.push('…(transcript truncated to stay within the 32000-character rendered-output budget)');
  return {
    text: lines.join('\n'),
    truncated: renderTruncated,
    ...(renderTruncated ? { limitation: 'Rendered transcript exceeded the 32000-character output budget.' } : {}),
  };
}

export function renderTranscript(parsed: ParsedTranscript): string {
  return renderTranscriptDetailed(parsed).text;
}
