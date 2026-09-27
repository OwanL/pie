import type { FileChangeEntry, ChatMessage, SessionSummary } from '../../lib/protocol/index.js';
import { isRecord } from '../../../lib/validation/type-guards';
import {
  deriveFileChangesFromToolCall,
  deriveFileChangesFromSubagentResult,
  accumulateFileChange,
} from '../../../lib/file-changes/derivation';

// ─── Derive file changes from existing transcript ──────────────────────────
//
// The per-tool-call core lives in the neutral root lib so the session-changes
// tool can re-derive from JSONL through the same logic
// (option A: shared logic, two traversal adapters). Re-export the core here so
// existing host callers (attach.ts, tools.ts) and tests keep their import paths
// unchanged. Only the ChatMessage-typed wrapper (deriveFileChangesFromTranscript)
// is host-local — it traverses the merged `message.toolCalls[]` view.

export {
  deriveFileChangeFromToolCall,
  deriveFileChangesFromToolCall,
  accumulateFileChange,
  mergeFileChangeKind,
  deriveFileChangesFromSubagentResult,
} from '../../../lib/file-changes/derivation';
export type { ToolCallLikeInput } from '../../../lib/file-changes/derivation';

/** Resolve the cwd to canonicalize file-change identities for a session: the
 *  session's own cwd, falling back to the workspace cwd. Mirrors
 *  `FileDiffService.resolveFileChangePath`'s base-path resolution (minus the
 *  vscode workspace-folder fallback, which the pure derivation core does not
 *  need). Returns `undefined` when no cwd is known — canonicalization then
 *  degrades to separator/case/dot normalization only. */
export function resolveSessionCwd(
  sessions: SessionSummary[],
  workspaceCwd: string | null,
  sessionPath: string,
): string | undefined {
  return sessions.find((s) => s.path === sessionPath)?.cwd ?? workspaceCwd ?? undefined;
}

export function deriveFileChangesFromTranscript(
  transcript: ChatMessage[],
  cwd?: string,
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>();

  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    const toolCalls = message.toolCalls ?? [];
    for (const tool of toolCalls) {
      if (tool.name === 'subagent') {
        // A provisional result may be present while a child is still running.
        // Only terminal child-task outcomes have durable mutation evidence.
        if ((tool.status !== 'completed' && tool.status !== 'failed') || !isRecord(tool.result)) continue;
        // A child task can fail after making successful edits. Attribute its
        // completed descendants from the result instead of treating the parent
        // subagent status as an individual mutation's success/failure.
        const owningCwd = isRecord(tool.input) && typeof tool.input.cwd === 'string' && tool.input.cwd.trim()
          ? tool.input.cwd
          : undefined;
        const subagentChanges = deriveFileChangesFromSubagentResult(
          tool.result,
          message.id,
          message.createdAt,
          tool.id,
          cwd,
          owningCwd,
        );
        for (const entry of subagentChanges) {
          accumulateFileChange(seen, entry, cwd);
        }
        continue;
      }

      // Only terminal success is evidence of a completed mutation. Failed,
      // running, and provisional calls must not be presented as changed files.
      if (tool.status !== 'completed') continue;

      const entries = deriveFileChangesFromToolCall(
        { id: tool.id, name: tool.name, input: tool.input },
        message.id,
        message.createdAt,
      );
      for (const entry of entries) {
        accumulateFileChange(seen, entry, cwd);
      }
    }
  }

  return [...seen.values()];
}
