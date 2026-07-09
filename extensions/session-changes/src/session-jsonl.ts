/**
 * Minimal session-JSONL reader + the toolCall↔toolResult join for the
 * `session_changes` tool.
 *
 * Re-derives file changes from the session JSONL ON DISK (option A) through
 * the SAME per-tool-call core the host uses (shared/file-change-derivation),
 * rather than querying host state at runtime — exactly the precedent
 * `session_review` sets (read-from-disk, self-contained, works for any session
 * file). Compaction appends a cursor and never deletes entries, so parsing the
 * JSONL is non-lossy even after compaction.
 *
 * THE JOIN (the substantive divergence from the host's already-merged
 * ChatMessage[]). pie's `ChatMessage.toolCalls[]` is a MERGED view: each entry
 * is `{id, name, input, result, status}` — pie joins the assistant's tool call
 * with its later result. The raw JSONL does NOT merge; it stores two separate
 * entries:
 *   - assistant content part `{type:'toolCall', id, name, arguments}` — carries
 *     the INPUTS as `arguments` (not `input`), but NO result/status;
 *   - a separate `{role:'toolResult', toolCallId, toolName, content, details,
 *     isError}` entry — carries the RESULT (subagent inner transcripts live in
 *     its `details`) and the error flag.
 * So this is a TWO-PASS JOIN keyed by `toolCallId`, not a single content-parts
 * scan: (1) index `toolResult` entries by `toolCallId`; (2) walk assistant
 * `toolCall` parts, mapping `arguments`→`input`, skipping calls whose joined
 * `toolResult.isError` is set (the JSONL equivalent of the host's
 * `status==='failed'` skip), and — for `subagent` calls — feeding the joined
 * `toolResult.details` to `deriveFileChangesFromSubagentResult`. A plain
 * content-parts scan alone would silently drop all subagent-attributed changes
 * and include failed edits.
 *
 * Deliberately self-contained (only node:fs + the shared core) so the extension
 * stays decoupled from the host build. Needs tool-call INPUTS, so it's distinct
 * from session-reviewer/src/transcript.ts (which renders to compact Turn[] and
 * drops inputs).
 */

import * as fs from 'node:fs';

import type { FileChange } from './types.js';
import {
  deriveFileChangesFromToolCall,
  deriveFileChangesFromSubagentResult,
  accumulateFileChange,
} from '../../../extension/src/shared/file-change-derivation.js';

// ─── Minimal structural types for the JSONL entries we read ────────────────
//
// Intentionally permissive (`unknown` content, optional everything): the JSONL
// is written by the SDK and may carry fields we don't model. We read only what
// the derivation needs.

interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: MessageLike;
  /** Present on the `session` header entry (first line): the session's cwd. */
  cwd?: string;
}

interface MessageLike {
  role?: string;
  /** string or array of content parts ({type, text, thinking, toolCall, ...}). */
  content?: unknown;
  /** toolResult entries carry the id of the assistant toolCall they answer. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** subagent toolResult entries carry inner transcripts in `details`. */
  details?: unknown;
}

/** What the join produces for one assistant toolCall, plus its joined result. */
interface JoinedToolCall {
  id: string;
  name: string;
  input: unknown;
  isError: boolean;
  details: unknown;
}

/**
 * Derive file changes from already-parsed session entries (the two-pass join).
 *
 * Exported separately from `parseSessionFileChanges` so the equivalence test
 * can feed a fixture's `SessionEntry[]` form directly and assert it equals the
 * host's `deriveFileChangesFromTranscript` over the same fixture's
 * `ChatMessage[]` form.
 */
export function deriveFileChangesFromSessionEntries(
  entries: SessionEntryLike[],
): FileChange[] {
  const seen = new Map<string, FileChange>();
  const createdPaths = new Set<string>();

  // Pass 1: index toolResult entries by toolCallId (the join's right side).
  const resultsByCallId = new Map<string, { isError: boolean; details: unknown }>();
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || msg.role !== 'toolResult') continue;
    const callId = msg.toolCallId;
    if (typeof callId !== 'string' || !callId) continue;
    // First result wins (a toolCallId should map to exactly one result).
    if (!resultsByCallId.has(callId)) {
      resultsByCallId.set(callId, { isError: !!msg.isError, details: msg.details });
    }
  }

  // Pass 2: walk assistant toolCall parts, join with their results, derive.
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const messageId = entry.id ?? '';
    const timestamp = entry.timestamp ?? '';

    for (const part of msg.content) {
      const joined = joinToolCallPart(part, resultsByCallId);
      if (!joined) continue;

      // Skip calls whose result errored (the JSONL equivalent of the host's
      // `status === 'failed'` skip). A toolCall with no joined result is NOT
      // skipped — it maps to a non-failed (running/completed) tool, matching
      // the host, which only skips 'failed'.
      if (joined.isError) continue;

      // Subagent: feed the joined details to the subagent recursion. The host
      // passes the merged `tool.result` ({content, details}); here we synthesise
      // the same shape from the joined toolResult entry's `details`.
      if (joined.name === 'subagent' && joined.details !== undefined) {
        const subagentChanges = deriveFileChangesFromSubagentResult(
          { details: joined.details },
          messageId,
          timestamp,
          joined.id,
        );
        for (const e of subagentChanges) accumulateFileChange(seen, createdPaths, e);
        continue;
      }

      const changes = deriveFileChangesFromToolCall(
        { id: joined.id, name: joined.name, input: joined.input },
        messageId,
        timestamp,
      );
      for (const e of changes) accumulateFileChange(seen, createdPaths, e);
    }
  }

  return [...seen.values()];
}

/** Map an assistant content part to a joined tool call (input from the part,
 *  result/error/details from the indexed toolResult entry), or null if the
 *  part isn't a toolCall. */
function joinToolCallPart(
  part: unknown,
  resultsByCallId: Map<string, { isError: boolean; details: unknown }>,
): JoinedToolCall | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as Record<string, unknown>;
  if (p['type'] !== 'toolCall') return null;
  const id = typeof p['id'] === 'string' ? p['id'] : '';
  const name = typeof p['name'] === 'string' ? p['name'] : '';
  const input = p['arguments'];
  const joined = id ? resultsByCallId.get(id) : undefined;
  return {
    id,
    name,
    input,
    isError: joined?.isError ?? false,
    details: joined?.details,
  };
}

/** Read the session cwd from the `session` header entry (first line), if any.
 *  Used to resolve relative manifest paths for the `diff` action. */
export function readSessionCwd(entries: SessionEntryLike[]): string | undefined {
  for (const entry of entries) {
    if (entry.type === 'session' && typeof entry.cwd === 'string' && entry.cwd) {
      return entry.cwd;
    }
  }
  return undefined;
}

export interface ParsedSession {
  sessionPath: string;
  cwd: string | undefined;
  changes: FileChange[];
}

/** Parse a session JSONL file into its derived file changes + the session cwd.
 *  Throws on read failure (the tool surfaces the message). */
export function parseSessionFileChanges(sessionPath: string): ParsedSession {
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read session file ${sessionPath}: ${(err as Error).message}`);
  }

  const entries: SessionEntryLike[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: SessionEntryLike;
    try {
      entry = JSON.parse(trimmed) as SessionEntryLike;
    } catch {
      continue;
    }
    entries.push(entry);
  }

  return {
    sessionPath,
    cwd: readSessionCwd(entries),
    changes: deriveFileChangesFromSessionEntries(entries),
  };
}
