/**
 * Side-channel analytics log for warm-bash.
 *
 * Mirrors `extensions/skill-pruner/logger.ts`: an append-only JSONL file at
 * `<configRoot>/data/warm-bash.jsonl` with size-based rotation + serialized
 * async writes. Two record kinds:
 *
 *   - `auto_prune_rewrite` — one per transparent command rewrite (point-in-time,
 *     joinable to a run by sessionPathHash + timestamp, exactly like pruning
 *     signals).
 *   - `session_summary` — one per session at session_shutdown, carrying the
 *     session-cumulative routing counters (fast-path / warm / fallback) + config
 *     context. Per-session (warm-bash has no run-boundary signal; per-run
 *     attribution would need baseline+delta + a host-side RPC and is deliberately
 *     out of scope).
 *
 * The analytics pipeline reads this with `readWarmBashLog` (analysis/scripts/
 * source.ts) and joins rewrite events to runs via `hashToPrefix(sessionId, 16)`,
 * the same mechanism pruning signals use.
 *
 * Note: before/after command text may include sensitive search patterns/paths —
 * the same trade-off existing pruning/tool-result-pruning logs already accept.
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Root of the pi-config repo, resolved from this extension's known position
 *  (this file lives in extensions/warm-bash/src/, so three `..` reach the repo root). */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** Rotate the log once it grows past this many bytes (~5MB) so it can't grow unbounded. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Number of rotated backups to keep (newest first: .1, .2, ...). */
const MAX_ROTATIONS = 2;

let logPathOverride: string | null = null;
let maxLogBytesOverride: number | null = null;

/** Serializes async writes so concurrent appends preserve line ordering. Each
 *  call chains onto this promise; an error in one write doesn't break the next. */
let writeQueue: Promise<void> = Promise.resolve();

function getLogPath(): string {
  return logPathOverride ?? path.join(CONFIG_ROOT, "data", "warm-bash.jsonl");
}

function getLogByteLimit(): number {
  return maxLogBytesOverride ?? MAX_LOG_BYTES;
}

/** Append one JSON record. Non-blocking: serializes the line and chains an async
 *  append onto the write queue (preserves ordering without blocking the event loop). */
function appendJsonLine(record: Record<string, unknown>): void {
  const logPath = getLogPath();
  const line = `${JSON.stringify(record)}\n`;
  writeQueue = writeQueue
    .then(() => writeJsonLine(logPath, line))
    .catch((error) => {
      console.warn(`[warm-bash] failed to append analytics log: ${(error as Error).message}`);
    });
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
    // File doesn't exist yet — nothing to rotate.
    return false;
  }
}

/** Rename the current log to `.1` (shifting older backups down) so the next
 *  append starts a fresh file. Keeps the newest `MAX_ROTATIONS` backups. */
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
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

/** Wait for all queued log writes to finish. Tests await this before reading
 *  the JSONL file; production may call it to drain on shutdown. */
export function flushLog(): Promise<void> {
  return writeQueue;
}

/** Record one transparent auto-prune command rewrite (point-in-time event). */
export function logAutoPruneRewrite(sessionId: string, before: string, after: string): void {
  appendJsonLine({
    event: "auto_prune_rewrite",
    sessionId,
    timestamp: new Date().toISOString(),
    before,
    after,
  });
}

export interface WarmBashSessionSummary {
  fastPath: number;
  warm: number;
  fallback: number;
  poolSize: number;
  warmupFailures: number;
  autoPruneEnabled: boolean;
  fastPathEnabled: boolean;
  gnuGrep: boolean;
}

/** Record a session's cumulative routing counters + config context at
 *  session_shutdown. One line per session that used the bash tool. */
export function logSessionSummary(sessionId: string, summary: WarmBashSessionSummary): void {
  appendJsonLine({
    event: "session_summary",
    sessionId,
    timestamp: new Date().toISOString(),
    ...summary,
  });
}

/** Test seam: redirect the log to a temp path. */
export function setLogPathForTesting(logPath: string | null): void {
  logPathOverride = logPath;
}

/** Test seam: lower the rotation threshold so tests can exercise rotation. */
export function setMaxLogBytesForTesting(bytes: number | null): void {
  maxLogBytesOverride = bytes;
}
