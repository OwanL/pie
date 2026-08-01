// Analytics logger for the tool-result-pruner extension.
//
// Appends one JSONL event per pruned tool result to `data/tool-result-pruning.jsonl`.
// The rotating, serialized async write infrastructure is shared via
// `shared/jsonl-writer.ts` (JsonlWriter); this module defines the event shape
// and recording API.
//
// The analysis pipeline (analysis/scripts/source.ts readToolResultPruningLog)
// ingests this file. Each event records which rules fired and the before/after
// token counts, so §9.3 ("instrument before/after token counts per rule") is
// answered per-result — the foundation for deciding which lossy rules are worth
// shipping and whether any starved the agent.

import path from "node:path";
import { JsonlWriter } from "../../shared/jsonl-writer.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

const writer = new JsonlWriter({
  defaultLogPath: path.join(CONFIG_ROOT, "data", "tool-result-pruning.jsonl"),
  warnLabel: "[tool-result-pruner] failed to append pruning log",
});

export interface ToolResultPruningEvent {
  event: "tool_result_pruned";
  /** Session id from ctx.sessionManager.getSessionId() — joins to runs by
   *  sessionPathHash in the analysis pipeline (same key skill-pruner uses). */
  sessionId: string;
  /** Tool that produced the output ("bash", "ls", "grep", ...). */
  toolName: string;
  /** Ordered list of rule names that changed content (only those that fired). */
  rules: string[];
  /** Token count of the post-truncation, pre-pruning text pruning received. */
  beforeTokens: number;
  /** Token count of the post-pruning text the model sees. */
  afterTokens: number;
  /** beforeTokens - afterTokens (≥ 0). */
  tokensSaved: number;
  timestamp: string;
}

/** Append a `tool_result_pruned` event to the JSONL log. Best-effort: a write
 *  failure warns and is swallowed so it can never break the tool_result path. */
export function recordPruning(event: ToolResultPruningEvent): void {
  writer.append(JSON.stringify(event));
}

/** Wait for all queued log writes to finish. Tests await this before reading. */
export function flushLog(): Promise<void> {
  return writer.flush();
}

/** Test seam: redirect the log to a temp path and (optionally) shrink the
 *  rotation limit. Pass null to clear the override. */
export function setLogPathOverrideForTesting(logPath: string | null, maxBytes?: number): void {
  writer.setLogPathForTesting(logPath);
  writer.setMaxLogBytesForTesting(maxBytes ?? null);
}
