/**
 * Side-channel analytics log for warm-bash.
 *
 * Appends an append-only JSONL file at `<configRoot>/data/warm-bash.jsonl`.
 * The rotating, serialized async write infrastructure is shared via
 * `shared/jsonl-writer.ts` (JsonlWriter); this module defines the event shapes
 * and recording API. Two record kinds:
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

import path from "node:path";
import { JsonlWriter } from "../../../shared/jsonl-writer.js";

/** Root of the pi-config repo, resolved from this extension's known position
 *  (this file lives in extensions/warm-bash/src/, so three `..` reach the repo root). */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const writer = new JsonlWriter({
  defaultLogPath: path.join(CONFIG_ROOT, "data", "warm-bash.jsonl"),
  warnLabel: "[warm-bash] failed to append analytics log",
});

/** Wait for all queued log writes to finish. Tests await this before reading
 *  the JSONL file; production may call it to drain on shutdown. */
export function flushLog(): Promise<void> {
  return writer.flush();
}

/** Record one transparent auto-prune command rewrite (point-in-time event). */
export function logAutoPruneRewrite(sessionId: string, before: string, after: string): void {
  writer.append(JSON.stringify({
    event: "auto_prune_rewrite",
    sessionId,
    timestamp: new Date().toISOString(),
    before,
    after,
  }));
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
  writer.append(JSON.stringify({
    event: "session_summary",
    sessionId,
    timestamp: new Date().toISOString(),
    ...summary,
  }));
}

/** Test seam: redirect the log to a temp path. */
export function setLogPathForTesting(logPath: string | null): void {
  writer.setLogPathForTesting(logPath);
}

/** Test seam: lower the rotation threshold so tests can exercise rotation. */
export function setMaxLogBytesForTesting(bytes: number | null): void {
  writer.setMaxLogBytesForTesting(bytes);
}
