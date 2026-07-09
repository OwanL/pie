import type { FileChangeEntry } from './protocol';
import { isRecord } from './type-guards';
import { parseDeletedPathsFromCommand } from './shell-deletion-parsing';

// ─── Per-tool-call file-change derivation (shared core) ────────────────────
//
// Lifted from host/core/file-change-derivation.ts into shared/ so both the
// host's in-memory derivation (deriveFileChangesFromTranscript, which traverses
// the merged ChatMessage.toolCalls[]) and the session-changes extension's
// JSONL re-derivation (deriveFileChangesFromSessionEntries, which traverses
// raw SessionEntry content parts) call ONE per-tool-call core. This is the
// "shared logic" of option A: same core, two thin traversal adapters, two
// computations — equivalence held by determinism + the equivalence test.
//
// Generic over `{ id, name, input }` (ToolCallLikeInput): neither adapter
// passes a host/ChatMessage-typed object here. Pure (no vscode, no fs, no host
// state) — host- and extension-agnostic.

/** Minimal input shape both adapters map their tool calls onto before calling
 *  the core. The host reads `{id,name,input}` from `ChatMessage.toolCalls`;
 *  the extension maps `{type:'toolCall', id, name, arguments}` → `arguments`
 *  becomes `input`. */
export interface ToolCallLikeInput {
  id: string;
  name: string;
  input: unknown;
}

/** Minimal structural types for subagent result traversal (pi-ai Message shape). */
interface SubagentContentPart {
  type: string;
  name?: string;
  arguments?: unknown;
}

interface SubagentMessage {
  role: string;
  content?: SubagentContentPart[];
}

interface SubagentSingleResult {
  messages?: SubagentMessage[];
}

interface SubagentDetails {
  results?: SubagentSingleResult[];
}

/** Count the number of lines in a string. Empty string → 0, no trailing-newline inflation. */
function countLines(text: string): number {
  if (text === '') return 0;
  // A trailing newline doesn't add an extra logical line
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

function computeLineStats(input: unknown, toolName: string): { additions: number; deletions: number } | null {
  if (!isRecord(input)) return null;

  // write/create: all lines are additions
  if (looksLikeWriteTool(toolName)) {
    const content = input.content ?? input.text ?? input.data;
    if (typeof content === 'string') {
      const lines = countLines(content);
      return lines > 0 ? { additions: lines, deletions: 0 } : null;
    }
    return null;
  }

  // edit with single oldText/newText
  if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
    const oldLines = countLines(input.oldText);
    const newLines = countLines(input.newText);
    if (oldLines === 0 && newLines === 0) return null;
    return { additions: newLines, deletions: oldLines };
  }

  // edit with edits[] array (each entry has oldText/newText)
  if (Array.isArray(input.edits)) {
    let additions = 0;
    let deletions = 0;
    for (const edit of input.edits) {
      if (isRecord(edit)) {
        if (typeof edit.oldText === 'string') {
          deletions += countLines(edit.oldText);
        }
        if (typeof edit.newText === 'string') {
          additions += countLines(edit.newText);
        }
      }
    }
    if (additions > 0 || deletions > 0) return { additions, deletions };
    return null;
  }

  return null;
}

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'string') return input.trim() || null;
  if (!isRecord(input)) return null;
  const pathKeys = ['path', 'filePath', 'file', 'filepath', 'target', 'targetPath'];
  for (const key of pathKeys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function looksLikeFileModifyingTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('create') ||
    n.includes('delete') ||
    n.includes('remove') ||
    n.includes('rename') ||
    n.includes('move') ||
    n === 'bash'
  );
}

function looksLikeWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('write') || n.includes('create') || n === 'write' || n === 'create_file';
}

function looksLikeDeleteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('delete') || n.includes('remove') || n === 'delete_files' || n === 'delete_file';
}

function looksLikeBashTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'bash' || n === 'shell' || n === 'execute_bash' || n === 'run_command' || n === 'execute_command';
}

function looksLikeEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('edit') || n.includes('update') || n.includes('replace') || n.includes('patch');
}

function describeEdit(input: unknown): string {
  if (!isRecord(input)) return 'edited';
  if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
    return 'edited';
  }
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    return `${input.edits.length} edits`;
  }
  return 'edited';
}

export function deriveFileChangeFromToolCall(
  tool: ToolCallLikeInput,
  messageId: string,
  timestamp: string,
): FileChangeEntry | null {
  const name = (tool.name || '').toLowerCase().trim();
  if (!looksLikeFileModifyingTool(name)) return null;

  const filePath = extractFilePath(tool.input);
  if (!filePath) return null;

  let kind: FileChangeEntry['kind'];
  let description: string;

  if (looksLikeWriteTool(name)) {
    kind = 'created';
    description = 'created';
  } else if (looksLikeDeleteTool(name)) {
    kind = 'deleted';
    description = 'deleted';
  } else if (looksLikeEditTool(name)) {
    kind = 'modified';
    description = describeEdit(tool.input);
  } else {
    kind = 'modified';
    description = `${name}`;
  }

  const stats = computeLineStats(tool.input, name);

  return {
    path: filePath,
    kind,
    toolCallId: tool.id,
    messageId,
    description,
    timestamp,
    ...(stats && { additions: stats.additions, deletions: stats.deletions }),
  };
}

/**
 * Derive zero or more file-change entries from a single tool call.
 *
 * This is the plural counterpart to {@link deriveFileChangeFromToolCall} and is
 * the preferred entry point: a single bash invocation (`rm a b c`) can target
 * multiple files, which the singular helper cannot express. Non-bash tools
 * delegate to the singular helper (0 or 1 entry).
 */
export function deriveFileChangesFromToolCall(
  tool: ToolCallLikeInput,
  messageId: string,
  timestamp: string,
): FileChangeEntry[] {
  const name = (tool.name || '').toLowerCase().trim();

  if (looksLikeBashTool(name)) {
    const command = isRecord(tool.input)
      ? (tool.input.command ?? tool.input.cmd ?? tool.input.command_str)
      : null;
    if (typeof command === 'string') {
      const paths = parseDeletedPathsFromCommand(command);
      return paths.map((p) => ({
        path: p,
        kind: 'deleted' as const,
        toolCallId: tool.id,
        messageId,
        description: 'deleted',
        timestamp,
      }));
    }
    return [];
  }

  const single = deriveFileChangeFromToolCall(tool, messageId, timestamp);
  return single ? [single] : [];
}

export function accumulateFileChange(
  seen: Map<string, FileChangeEntry>,
  createdPaths: Set<string>,
  entry: FileChangeEntry,
): void {
  if (entry.kind === 'created') {
    createdPaths.add(entry.path);
  } else if (entry.kind === 'deleted' && createdPaths.has(entry.path)) {
    // File was created in this session and then deleted — net no-op.
    seen.delete(entry.path);
    return;
  }

  const existing = seen.get(entry.path);
  if (existing) {
    // Accumulate stats across edits to the same file
    const additions = (existing.additions ?? 0) + (entry.additions ?? 0);
    const deletions = (existing.deletions ?? 0) + (entry.deletions ?? 0);
    if (additions > 0) entry.additions = additions;
    else delete entry.additions;
    if (deletions > 0) entry.deletions = deletions;
    else delete entry.deletions;
  }
  seen.set(entry.path, entry);
}

/**
 * Derive file changes from a subagent tool result by scanning the inner
 * subagent transcripts for file-modifying tool calls (edit, write, etc.).
 *
 * `result` is the joined tool-result object (the `{content, details}` shape):
 * the host passes `ChatMessage.toolCalls[i].result` (already merged), the
 * session-changes extension passes the `{details: toolResult.details}` object
 * joined from the JSONL `toolResult` entry. Both carry `result.details.results
 * [].messages[].content[]` with `toolCall` parts.
 */
export function deriveFileChangesFromSubagentResult(
  result: unknown,
  messageId: string,
  timestamp: string,
  toolCallId: string,
): FileChangeEntry[] {
  if (!isRecord(result)) return [];
  const details = result.details as SubagentDetails | undefined;
  if (!details?.results) return [];

  const changes: FileChangeEntry[] = [];

  for (let rIdx = 0; rIdx < details.results.length; rIdx++) {
    const singleResult = details.results[rIdx];
    if (!singleResult?.messages) continue;

    for (let mIdx = 0; mIdx < singleResult.messages.length; mIdx++) {
      const msg = singleResult.messages[mIdx];
      if (msg.role !== 'assistant') continue;
      if (!Array.isArray(msg.content)) continue;

      for (let cIdx = 0; cIdx < msg.content.length; cIdx++) {
        const part = msg.content[cIdx];
        if (part.type !== 'toolCall') continue;

        const syntheticId = `${toolCallId}-sa${rIdx}-m${mIdx}-c${cIdx}`;
        const entries = deriveFileChangesFromToolCall(
          { id: syntheticId, name: part.name ?? '', input: part.arguments },
          messageId,
          timestamp,
        );
        for (const entry of entries) changes.push(entry);
      }
    }
  }

  return changes;
}
