// Analytics logger for the tool-result-pruner extension.
//
// Appends one JSONL event per pruned tool result to `data/tool-result-pruning.jsonl`,
// mirroring skill-pruner/logger.ts: serialized async writes (order preserved
// without blocking the event loop), size-based rotation with backups, best-effort
// (a write failure warns and never breaks the agent).
//
// The analysis pipeline (analysis/scripts/source.ts readToolResultPruningLog)
// ingests this file. Each event records which rules fired and the before/after
// token counts, so §9.3 ("instrument before/after token counts per rule") is
// answered per-result — the foundation for deciding which lossy rules are worth
// shipping and whether any starved the agent.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { toErrorMessage } from "../../shared/error-message.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

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

let logPathOverride: string | null = null;

/** Serializes async writes so concurrent appends preserve line ordering. */
let writeQueue: Promise<void> = Promise.resolve();

/** Rotate the log once it grows past this many bytes (~5MB). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 2;
let maxLogBytesOverride: number | null = null;

function getLogPath(): string {
  return logPathOverride ?? path.join(CONFIG_ROOT, "data", "tool-result-pruning.jsonl");
}

function getLogByteLimit(): number {
  return maxLogBytesOverride ?? MAX_LOG_BYTES;
}

async function writeJsonLine(logPath: string, line: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  if (await shouldRotateLog(logPath)) {
    await rotateLog(logPath);
  }
  await appendFile(logPath, line, "utf-8");
}

async function shouldRotateLog(logPath: string): Promise<boolean> {
  try {
    const stats = await stat(logPath);
    return stats.size >= getLogByteLimit();
  } catch {
    return false; // file doesn't exist yet
  }
}

async function rotateLog(logPath: string): Promise<void> {
  await rm(`${logPath}.${MAX_ROTATIONS}`, { force: true });
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    await safeRename(`${logPath}.${i}`, `${logPath}.${i + 1}`);
  }
  await safeRename(logPath, `${logPath}.1`);
}

async function safeRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isEnoent(error)) throw error; // a backup slot may not exist yet
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Append a `tool_result_pruned` event to the JSONL log. Best-effort: a write
 *  failure warns and is swallowed so it can never break the tool_result path. */
export function recordPruning(event: ToolResultPruningEvent): void {
  const logPath = getLogPath();
  const line = `${JSON.stringify(event)}\n`;
  writeQueue = writeQueue
    .then(() => writeJsonLine(logPath, line))
    .catch((error) => {
      console.warn(`[tool-result-pruner] failed to append pruning log: ${toErrorMessage(error)}`);
    });
}

/** Wait for all queued log writes to finish. Tests await this before reading. */
export function flushLog(): Promise<void> {
  return writeQueue;
}

/** Test seam: redirect the log to a temp path and (optionally) shrink the
 *  rotation limit. Pass null to clear the override. */
export function setLogPathOverrideForTesting(logPath: string | null, maxBytes?: number): void {
  logPathOverride = logPath;
  maxLogBytesOverride = maxBytes ?? null;
}