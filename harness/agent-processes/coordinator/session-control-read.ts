import { createHash } from 'node:crypto';
import type { ToolCall } from '../lib/rpc/message-contract.js';
import type { MessageLike } from '../../session-storage/transcripts/types.js';
import { AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE } from '../lib/rpc/message-contract.js';
import { isSessionControlSender, type SessionControlSender } from '../lib/rpc/session-control-attribution.js';
import { mapTranscript, type SessionEntryLike } from '../../session-storage/transcripts/transcript.js';
import {
  SESSION_CONTROL_READ_DEFAULT_CHARACTERS,
  SESSION_CONTROL_READ_MAX_CHARACTERS,
} from './session-control-read-bounds.js';
export { SESSION_CONTROL_READ_DEFAULT_CHARACTERS, SESSION_CONTROL_READ_MAX_CHARACTERS };

export interface SessionControlReadActivity {
  activity: 'idle' | 'running' | 'waiting-user-input';
  busy: boolean;
  runtimeState?: 'hot' | 'cold';
  runningTools?: number;
  /** Current live names only, never reconstructed from durable tool payloads. */
  runningToolNames?: readonly string[];
  runningToolNamesTruncated?: boolean;
  runningSubagents?: number;
  requestStartedAt?: number;
  elapsedMs?: number;
}

export interface SessionControlReadSource {
  /** Stable durable identity, never the assigned title. */
  sessionId: string;
  /** Exact ordered, complete durable SDK branch. No renderer compaction or
   * assistant/tool-result folding: those projections mutate old rows on append.
   * The caller owns the generation/ownership stable-read fence. */
  entries: readonly SessionEntryLike[];
  activity: SessionControlReadActivity;
}

export interface SessionControlReadOptions {
  direction?: 'latest' | 'older' | 'newer';
  cursor?: string;
  maxCharacters?: number;
  includeReasoning?: boolean;
  includeToolCalls?: boolean;
}

export interface SessionControlReadFragment {
  id: string;
  part: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: 'text' | 'reasoning' | 'tool-input' | 'tool-result' | 'image';
  createdAt: string;
  text: string;
  /** UTF-16 offsets into this immutable projected part; offset > 0 or
   * offset + text.length < totalCharacters identifies a partial part. */
  offset: number;
  totalCharacters: number;
  toolCallId?: string;
  toolName?: string;
  sender?: SessionControlSender;
}

export interface SessionControlReadResult {
  activity: SessionControlReadActivity;
  transcript: SessionControlReadFragment[];
  cursor: string;
  hasOlder: boolean;
  hasNewer: boolean;
}

export class SessionControlReadError extends Error {
  constructor(readonly code: 'INVALID_PARAMS' | 'READ_CURSOR_INVALIDATED' | 'READ_BUDGET_TOO_SMALL', message: string) {
    super(message);
    this.name = 'SessionControlReadError';
  }
}

type Position = [entry: number, part: number, offset: number];
interface ReadCursor {
  v: 1;
  s: string;
  p: number;
  n: number;
  h: string;
  l: Position;
  r: Position;
}
type Segment = Omit<SessionControlReadFragment, 'offset' | 'totalCharacters'>;

const invalid = (message: string): never => { throw new SessionControlReadError('INVALID_PARAMS', message); };
const stale = (message: string): never => {
  throw new SessionControlReadError('READ_CURSOR_INVALIDATED', `${message} Start a fresh latest read without a cursor.`);
};
const hash = (text: string): string => createHash('sha256').update(text).digest('base64url');
const compare = (a: Position, b: Position): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const encodeCursor = (cursor: ReadCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: unknown): ReadCursor {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return invalid('read.cursor must be an opaque cursor returned by read.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { return invalid('read.cursor is malformed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('read.cursor is malformed.');
  const c = parsed as ReadCursor;
  const position = (p: unknown): p is Position => Array.isArray(p) && p.length === 3
    && p.every((v) => Number.isSafeInteger(v) && v >= 0);
  if (c.v !== 1) return stale('The read cursor format changed.');
  if (Object.keys(c).sort().join(',') !== 'h,l,n,p,r,s,v'
    || typeof c.s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.s)
    || typeof c.h !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.h)
    || !Number.isSafeInteger(c.n) || c.n < 0
    || !Number.isInteger(c.p) || c.p < 0 || c.p > 3
    || !position(c.l) || !position(c.r) || compare(c.l, c.r) > 0
    || c.r[0] > c.n || encodeCursor(c) !== value) return invalid('read.cursor is malformed.');
  return c;
}

function legacyProvenance(entries: readonly SessionEntryLike[]): Record<string, SessionEntryLike> {
  const markers: Record<string, SessionEntryLike> = Object.create(null);
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE) continue;
    const data = entry.data as { userEntryId?: unknown; sender?: unknown } | undefined;
    if (!data || typeof data.userEntryId !== 'string') continue;
    if (isSessionControlSender(data.sender) || !markers[data.userEntryId]) markers[data.userEntryId] = entry;
  }
  return markers;
}

/** Bind durable ancestry plus the complete projected prefix. Ordinary appends
 * preserve it; branch changes and rewritten included content do not. Excluded
 * images/details never need serialization or hashing. Stream full part text
 * directly into the digest rather than building another giant escaped mirror. */
function prefixHash(entries: readonly SessionEntryLike[], count: number, entryParts: (index: number) => Segment[]): string {
  const digest = createHash('sha256');
  const update = (text: string): void => { digest.update(`${text.length}:`).update(text); };
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index]!;
    update(JSON.stringify([entry.id, entry.parentId, entry.timestamp, entry.type]));
    for (const segment of entryParts(index)) {
      const { text, ...metadata } = segment;
      update(JSON.stringify(metadata));
      update(text);
    }
  }
  return digest.digest('base64url');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    const block = item as Record<string, unknown>;
    if (block.type !== 'image' && block.kind !== 'image') return item;
    return {
      ...(block.type === 'image' ? { type: 'image' } : { kind: 'image' }),
      mimeType: block.mimeType, name: block.name, width: block.width, height: block.height, omitted: true,
    };
  }) ?? '';
}

function toolInput(tool: ToolCall): string {
  return stringify(tool.input);
}

function toolResultContent(content: MessageLike['content']): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => part.type === 'image' ? {
    type: 'image', mimeType: part.mimeType,
    ...(part.width !== undefined ? { width: part.width } : {}),
    ...(part.height !== undefined ? { height: part.height } : {}),
    omitted: true,
  } : part);
}

/** Only whole durability-confirmed entries are projected. Each SDK entry is
 * mapped independently, preserving immutable positions through ordinary tool
 * and assistant appends. Tool results remain separate from their call entry. */
function projectEntry(entry: SessionEntryLike, projection: number, provenance?: SessionEntryLike): Segment[] {
  const segments: Segment[] = [];
  const tools = (projection & 1) !== 0;
  const reasoning = (projection & 2) !== 0;
  const add = (row: Pick<Segment, 'role' | 'createdAt' | 'sender'>, kind: Segment['kind'], text: string,
    tool?: { toolCallId?: string; toolName?: string }): void => {
    if (!text) return;
    segments.push({ id: entry.id, part: segments.length, ...row, kind, text, ...tool });
  };
  if (entry.type === 'message' && entry.message?.role === 'toolResult') {
    if (tools) {
      const message = entry.message;
      // Page complete model-facing text, including ask_user decisions. SDK
      // details (diagnostics, duplicate mirrors, recursive child histories)
      // stay excluded; image blocks retain only explicit omission metadata.
      add({ role: 'tool', createdAt: entry.timestamp }, 'tool-result', stringify({
        content: toolResultContent(message.content),
        ...(message.isError ? { isError: true } : {}),
      }), { toolCallId: message.toolCallId, toolName: message.toolName });
    }
    return segments;
  }
  if (entry.type === 'message' && entry.message?.role === 'bashExecution') {
    if (tools) {
      const message = entry.message;
      const row = { role: 'tool' as const, createdAt: entry.timestamp };
      const tool = { toolName: 'bash' };
      add(row, 'tool-input', message.command ?? '', tool);
      add(row, 'tool-result', stringify({ output: message.output ?? '', exitCode: message.exitCode,
        cancelled: message.cancelled, truncated: message.truncated }), tool);
    }
    return segments;
  }
  const rows = mapTranscript(provenance ? [entry, provenance] : [entry]);
  for (const message of rows) {
    if (message.status !== 'completed') continue;
    const row = { role: message.role, createdAt: message.createdAt,
      ...(message.sender ? { sender: message.sender } : {}) };
    if (message.userParts?.length) {
      for (const part of message.userParts) {
        add(row, part.kind === 'text' ? 'text' : 'image', part.kind === 'text' ? part.text : stringify({
          mimeType: part.mimeType, name: part.name, width: part.width, height: part.height, omitted: true,
        }));
      }
    } else if (message.parts?.length) {
      for (const part of message.parts) {
        if (part.kind === 'text') add(row, 'text', part.text);
        else if (part.kind === 'reasoning' && reasoning) add(row, 'reasoning', part.text);
        else if (part.kind === 'toolCall' && tools) add(row, 'tool-input', toolInput(part.toolCall), {
          toolCallId: part.toolCall.id, toolName: part.toolCall.name,
        });
      }
    } else {
      add(row, 'text', message.markdown);
      if (reasoning && message.thinking) add(row, 'reasoning', message.thinking);
      if (tools) for (const tool of message.toolCalls ?? []) {
        add(row, 'tool-input', toolInput(tool), { toolCallId: tool.id, toolName: tool.name });
      }
    }
  }
  return segments;
}

/** No boundary inside a Unicode surrogate pair is ever returned. */
function safeBoundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
}

function activityHeader(activity: SessionControlReadActivity): SessionControlReadActivity {
  // Explicit projection: never copy unknown live-state fields or tool bodies.
  const names = [...new Set(activity.runningToolNames ?? [])];
  const boundedNames = names.slice(0, 8).map((name) => {
    const edge = safeBoundary(name, Math.min(name.length, 80)) ? 80 : 79;
    return name.slice(0, edge);
  });
  const namesTruncated = activity.runningToolNamesTruncated
    || names.length > boundedNames.length || names.some((name) => name.length > 80);
  return {
    activity: activity.activity, busy: activity.busy,
    ...(activity.runtimeState !== undefined ? { runtimeState: activity.runtimeState } : {}),
    ...(activity.runningTools !== undefined ? { runningTools: activity.runningTools } : {}),
    ...(activity.runningToolNames !== undefined ? { runningToolNames: boundedNames } : {}),
    ...(namesTruncated ? { runningToolNamesTruncated: true } : {}),
    ...(activity.runningSubagents !== undefined ? { runningSubagents: activity.runningSubagents } : {}),
    ...(activity.requestStartedAt !== undefined ? { requestStartedAt: activity.requestStartedAt } : {}),
    ...(activity.elapsedMs !== undefined ? { elapsedMs: activity.elapsedMs } : {}),
  };
}

/** One supported transcript workflow: fresh latest, then returned opaque
 * cursor for older/newer. The cursor carries the UNION of coverage, not the
 * last page, so alternating directions or increasing budgets never repeats
 * body text. All successful responses fit the complete serialized budget. */
export function readSessionControlTranscript(
  source: SessionControlReadSource,
  options: SessionControlReadOptions = {},
): SessionControlReadResult {
  const direction = options.direction ?? 'latest';
  if (direction !== 'latest' && direction !== 'older' && direction !== 'newer') invalid('read.direction must be latest, older, or newer.');
  const maxCharacters = options.maxCharacters ?? SESSION_CONTROL_READ_DEFAULT_CHARACTERS;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > SESSION_CONTROL_READ_MAX_CHARACTERS) {
    invalid(`read.maxCharacters must be an integer from 1 through ${SESSION_CONTROL_READ_MAX_CHARACTERS}.`);
  }
  for (const key of ['includeReasoning', 'includeToolCalls'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') invalid(`read.${key} must be a boolean.`);
  }
  if (direction === 'latest' && options.cursor !== undefined) invalid('A fresh latest read must omit read.cursor.');
  if (direction !== 'latest' && options.cursor === undefined) invalid(`${direction} read requires the returned read.cursor.`);
  const projection = (options.includeToolCalls ? 1 : 0) | (options.includeReasoning ? 2 : 0);
  const identity = hash(source.sessionId);
  const count = source.entries.length;
  const projected: Array<Segment[] | undefined> = new Array(count);
  const markers = legacyProvenance(source.entries);
  const entryParts = (index: number): Segment[] => {
    const entry = source.entries[index]!;
    return projected[index] ??= projectEntry(entry, projection, markers[entry.id]);
  };
  const validPosition = (position: Position, issuedCount: number): boolean => {
    const [entry, part, offset] = position;
    if (entry === issuedCount) return part === 0 && offset === 0;
    if (entry > issuedCount) return false;
    const segment = entryParts(entry)[part];
    return !!segment && offset <= segment.text.length && safeBoundary(segment.text, offset);
  };
  let cursor: ReadCursor;
  if (direction === 'latest') {
    cursor = { v: 1, s: identity, p: projection, n: count, h: prefixHash(source.entries, count, entryParts),
      l: [count, 0, 0], r: [count, 0, 0] };
  } else {
    cursor = decodeCursor(options.cursor);
    if (cursor.s !== identity) stale('The title now addresses a different session.');
    if (cursor.p !== projection) stale('The transcript projection options changed.');
    if (cursor.n > count || prefixHash(source.entries, cursor.n, entryParts) !== cursor.h) stale('The session branch or history was replaced.');
    if (!validPosition(cursor.l, cursor.n) || !validPosition(cursor.r, cursor.n)) invalid('read.cursor contains an invalid content offset.');
    cursor = { ...cursor, n: count,
      h: cursor.n === count ? cursor.h : prefixHash(source.entries, count, entryParts) };
  }
  const activity = activityHeader(source.activity);
  const transcript: SessionControlReadFragment[] = [];
  const backward = direction !== 'newer';

  const adjacent = (position: Position, older: boolean): { position: Position; segment: Segment } | undefined => {
    let [entry, part, offset] = position;
    if (older) {
      if (entry < count && offset > 0) return { position, segment: entryParts(entry)[part]! };
      part -= 1;
      while (entry >= 0) {
        const parts = entry < count ? entryParts(entry) : [];
        if (part >= 0 && parts[part]) return { position: [entry, part, parts[part]!.text.length], segment: parts[part]! };
        entry -= 1;
        if (entry >= 0) part = entryParts(entry).length - 1;
      }
    } else {
      while (entry < count) {
        const parts = entryParts(entry);
        if (parts[part] && offset < parts[part]!.text.length) return { position: [entry, part, offset], segment: parts[part]! };
        if (part + 1 < parts.length) { part += 1; offset = 0; }
        else { entry += 1; part = 0; offset = 0; }
      }
    }
    return undefined;
  };
  const result = (next: ReadCursor, fragments: SessionControlReadFragment[]): SessionControlReadResult => ({
    activity, transcript: fragments, cursor: encodeCursor(next),
    hasOlder: !!adjacent(next.l, true), hasNewer: !!adjacent(next.r, false),
  });
  if (JSON.stringify(result(cursor, transcript)).length > maxCharacters) {
    throw new SessionControlReadError('READ_BUDGET_TOO_SMALL', 'read.maxCharacters cannot fit the activity header and cursor. Increase the character budget.');
  }

  while (true) {
    const next = adjacent(backward ? cursor.l : cursor.r, backward);
    if (!next) break;
    const { position: [entry, part, edge], segment } = next;
    const available = backward ? edge : segment.text.length - edge;
    const candidate = (characters: number): { nextCursor: ReadCursor; fragments: SessionControlReadFragment[] } => {
      const start = backward ? edge - characters : edge;
      const end = backward ? edge : edge + characters;
      const fragment = { ...segment, text: segment.text.slice(start, end), offset: start, totalCharacters: segment.text.length };
      const nextCursor = { ...cursor, ...(backward ? { l: [entry, part, start] as Position } : { r: [entry, part, end] as Position }) };
      return { nextCursor, fragments: backward ? [fragment, ...transcript] : [...transcript, fragment] };
    };
    const fits = (characters: number): boolean => {
      const start = backward ? edge - characters : edge + characters;
      if (!safeBoundary(segment.text, start)) return false;
      const value = candidate(characters);
      return JSON.stringify(result(value.nextCursor, value.fragments)).length <= maxCharacters;
    };
    let characters = available;
    if (characters > maxCharacters || !fits(characters)) {
      let low = 0;
      let high = Math.min(available, maxCharacters);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        // Fit the preceding safe boundary rather than treating a surrogate
        // split as an over-budget candidate (which would break monotonicity).
        const safe = safeBoundary(segment.text, backward ? edge - mid : edge + mid) ? mid : mid - 1;
        if (fits(safe)) low = mid;
        else high = mid - 1;
      }
      characters = safeBoundary(segment.text, backward ? edge - low : edge + low) ? low : low - 1;
      // Cursor/base64 digit changes can make serialized cost locally flat.
      // Always recheck the actual final envelope, never assume the estimate.
      while (characters > 0 && !fits(characters)) characters -= safeBoundary(segment.text, backward ? edge - characters + 1 : edge + characters - 1) ? 1 : 2;
    }
    if (characters <= 0) {
      if (transcript.length === 0) throw new SessionControlReadError('READ_BUDGET_TOO_SMALL', 'read.maxCharacters cannot fit the next transcript fragment. Increase the character budget.');
      break;
    }
    const value = candidate(characters);
    cursor = value.nextCursor;
    transcript.splice(0, transcript.length, ...value.fragments);
    if (characters < available) break;
  }
  return result(cursor, transcript);
}
