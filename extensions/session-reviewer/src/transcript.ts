/**
 * Minimal session-JSONL parser for the `session_review` tool's `getTranscript`
 * action. Reads a session file (one JSON entry per line; first line is the
 * `session` header) and returns a compact, token-budgeted rendering of the
 * user inputs and assistant outputs so the agent can evaluate whether a
 * session's task is done.
 *
 * Deliberately self-contained (no import from pie's transcript mapper) so the
 * extension stays decoupled from the host build.
 */

import * as fs from 'node:fs';

interface EntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: MessageLike;
  customType?: string;
  modelId?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  model?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  timestamp?: string | number;
}

interface Turn {
  index: number;
  role: string;
  text: string;
  tools: string[];
  isError?: boolean;
  toolName?: string;
}

const MAX_MSG_CHARS = 1600;
const MAX_TOTAL_CHARS = 32_000;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + ` …(+${s.length - n} chars)`;
}

/** Extract text from a message content (string or array of parts). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    const t = part?.['type'];
    if (t === 'text' && typeof part['text'] === 'string') parts.push(part['text'] as string);
    else if (t === 'thinking' && typeof part['thinking'] === 'string') {
      // Include a short thinking marker so the agent sees reasoning happened,
      // but don't dump full thinking (it's verbose and rarely needed for
      // done-ness evaluation).
      parts.push(`[thinking: ${truncate(part['thinking'] as string, 200)}]`);
    }
  }
  return parts.join('\n');
}

/** Extract tool-call names from assistant content parts.
 *  Session JSONL stores tool calls as `{type:'toolCall', name, arguments}`
 *  parts inside the assistant content array (NOT `tool_use`/`input`). */
function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.['type'] !== 'toolCall') continue;
    if (typeof part['name'] !== 'string') continue;
    const name = part['name'] as string;
    let detail = '';
    const args = part['arguments'];
    if (args && typeof args === 'object') {
      // Surface a tiny hint of the arguments (path/command/action/url/query)
      // so the evaluator sees what the call targeted, without dumping input.
      const r = args as Record<string, unknown>;
      const hint = r['path'] ?? r['command'] ?? r['action'] ?? r['url'] ?? r['query'];
      if (typeof hint === 'string') detail = `(${truncate(hint, 60)})`;
    }
    names.push(detail ? `${name}${detail}` : name);
  }
  return names;
}

function extractToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (typeof part?.['text'] === 'string') parts.push(part['text'] as string);
  }
  return parts.join('\n');
}

/** Parse a session JSONL file into a compact list of turns. */
export function parseSessionTranscript(sessionPath: string, maxTurns = 40): {
  path: string;
  totalEntries: number;
  turnCount: number;
  truncated: boolean;
  turns: Turn[];
} {
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read session file ${sessionPath}: ${(err as Error).message}`);
  }

  const turns: Turn[] = [];
  let modelId: string | undefined;
  let totalEntries = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: EntryLike;
    try {
      entry = JSON.parse(trimmed) as EntryLike;
    } catch {
      continue;
    }
    totalEntries += 1;

    if (entry.type === 'model_change') {
      modelId = entry.modelId;
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    const role = msg.role ?? 'unknown';

    if (role === 'user') {
      turns.push({
        index: turns.length + 1,
        role: 'USER',
        text: truncate(extractText(msg.content).trim(), MAX_MSG_CHARS),
        tools: [],
      });
    } else if (role === 'assistant') {
      turns.push({
        index: turns.length + 1,
        role: 'ASSISTANT',
        text: truncate(extractText(msg.content).trim(), MAX_MSG_CHARS),
        tools: extractToolNames(msg.content),
      });
    } else if (role === 'toolResult') {
      turns.push({
        index: turns.length + 1,
        role: 'TOOL_RESULT',
        text: truncate(extractToolResult(msg.content).trim(), MAX_MSG_CHARS),
        tools: [],
        isError: !!msg.isError,
        toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
      });
    } else if (role === 'bashExecution') {
      const cmd = typeof msg.command === 'string' ? msg.command : '';
      const out = typeof msg.output === 'string' ? msg.output : '';
      turns.push({
        index: turns.length + 1,
        role: 'BASH',
        text: truncate(`$ ${cmd}\n${out}`.trim(), MAX_MSG_CHARS),
        tools: [],
      });
    }
    // other roles (custom, etc.) are skipped — they rarely affect done-ness.
  }

  // Keep the first user message (the original task/intent) + the most-recent
  // turns so the agent can compare intent vs. final state without reading a
  // huge transcript.
  const firstUser = turns.find((t) => t.role === 'USER');
  const recent = turns.slice(-maxTurns);
  let kept = recent;
  let truncated = false;
  if (firstUser && !recent.includes(firstUser)) {
    kept = [firstUser, ...recent];
    truncated = true;
  }
  if (recent.length < turns.length) truncated = true;

  // Renumber after selection.
  kept = kept.map((t, i) => ({ ...t, index: i + 1 }));

  return {
    path: sessionPath,
    totalEntries,
    turnCount: turns.length,
    truncated,
    turns: kept,
  };
}

/** Render a parsed transcript to a readable, size-capped text block. */
export function renderTranscript(parsed: {
  path: string;
  totalEntries: number;
  turnCount: number;
  truncated: boolean;
  turns: Turn[];
}): string {
  const lines: string[] = [];
  lines.push(`Session: ${parsed.path}`);
  lines.push(`Entries: ${parsed.totalEntries} | turns: ${parsed.turnCount}${parsed.truncated ? ' (excerpted — call with higher maxTurns for more)' : ''}`);
  lines.push('---');
  let budget = MAX_TOTAL_CHARS;
  for (const t of parsed.turns) {
    const toolTag = t.tools.length ? ` [tools: ${t.tools.join(', ')}]` : '';
    const errTag = t.isError ? ' (ERROR)' : '';
    const roleTag = t.role === 'TOOL_RESULT' && t.toolName ? `${t.role}(${t.toolName})` : t.role;
    const header = `[${t.index}] ${roleTag}${errTag}${toolTag}`;
    const body = t.text ? `: ${t.text}` : '';
    const line = `${header}${body}`;
    if (budget <= 0) {
      lines.push('…(transcript truncated to stay within the tool-result size budget)');
      break;
    }
    lines.push(budget >= line.length ? line : `${line.slice(0, budget)}…`);
    budget -= line.length + 1;
  }
  return lines.join('\n');
}