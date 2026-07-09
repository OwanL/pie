import type { FileChangeEntry, ChatMessage } from '../../shared/protocol';
import { isRecord } from '../../shared/type-guards';
import {
  deriveFileChangesFromToolCall,
  deriveFileChangesFromSubagentResult,
  accumulateFileChange,
} from '../../shared/file-change-derivation';

// ─── Derive file changes from existing transcript ──────────────────────────
//
// The per-tool-call core lives in shared/file-change-derivation.ts so the
// session-changes extension can re-derive from JSONL through the same logic
// (option A: shared logic, two traversal adapters). Re-export the core here so
// existing host callers (attach.ts, tools.ts) and tests keep their import paths
// unchanged. Only the ChatMessage-typed wrapper (deriveFileChangesFromTranscript)
// is host-local — it traverses the merged `message.toolCalls[]` view.

export {
  deriveFileChangeFromToolCall,
  deriveFileChangesFromToolCall,
  accumulateFileChange,
  deriveFileChangesFromSubagentResult,
} from '../../shared/file-change-derivation';
export type { ToolCallLikeInput } from '../../shared/file-change-derivation';

export function deriveFileChangesFromTranscript(
  transcript: ChatMessage[],
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>();
  const createdPaths = new Set<string>();

  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    const toolCalls = message.toolCalls ?? [];
    for (const tool of toolCalls) {
      if (tool.status === 'failed') continue;

      if (tool.name === 'subagent' && isRecord(tool.result)) {
        const subagentChanges = deriveFileChangesFromSubagentResult(
          tool.result,
          message.id,
          message.createdAt,
          tool.id,
        );
        for (const entry of subagentChanges) {
          accumulateFileChange(seen, createdPaths, entry);
        }
        continue;
      }

      const entries = deriveFileChangesFromToolCall(
        { id: tool.id, name: tool.name, input: tool.input },
        message.id,
        message.createdAt,
      );
      for (const entry of entries) {
        accumulateFileChange(seen, createdPaths, entry);
      }
    }
  }

  return [...seen.values()];
}
