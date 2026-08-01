import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import {
  reapTempFiles,
  type ReapOptions,
  type ReapResult,
} from "../../shared/temp-file-reaper.js";

/**
 * Reaper for the tool-result-pruner's recall stashes (audit item P1-7).
 *
 * writeStash() in index.ts writes the pre-pruning text of every lossy rewrite
 * to `pruned-raw-<sessionId>-<hex>.txt` in the OS tmpdir so the agent can recall
 * the raw via the `read` tool. Two cleanup layers keep these from accumulating:
 *
 *   1. Session-scoped (P1-7 follow-up, this file's `reapSessionStashes`):
 *      on `session_shutdown` the extension deletes the stashes that session
 *      wrote — matched by the session id embedded in the filename, so a live
 *      session with a different id is never touched.
 *   2. Load-time safety net (`reapPrunedRawStashes`): on extension load, evict
 *      stashes older than 7 days and cap the total size. This mops up anything
 *      the session-scoped path missed (crashed sessions, pre-namespace stashes
 *      from older builds, sessions whose id could not be resolved).
 *
 * Both are best-effort, never-throwing. The age + total-size eviction algorithm
 * is shared via `shared/temp-file-reaper.ts` (same algorithm the VS Code
 * extension host uses for SDK temp logs); `reapPrunedRawStashes` selects the
 * `pruned-raw-` prefix + `.txt` suffix. Session-scoped cleanup is unique to this
 * extension and stays here.
 */

const STASH_PREFIX = "pruned-raw-";
const STASH_SUFFIX = ".txt";

export type PrunedRawReapOptions = ReapOptions;
export type PrunedRawReapResult = ReapResult;

/** A session id that is safe to embed in a stash filename and glob-match on at
 *  shutdown. pi session ids are UUIDs (`[0-9a-f-]+`), which qualify. The guard
 *  rejects the `"unknown"` fallback (no reliable session identity → skip
 *  session-scoped cleanup rather than risk deleting another live session's
 *  recall raw) and anything containing path separators / dots (defence
 *  against path traversal or a glob that escapes the stash dir). */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeSessionId(sessionId: string | undefined | null): boolean {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId !== "unknown" &&
    SAFE_SESSION_ID.test(sessionId)
  );
}

export interface SessionReapResult {
  scanned: number;
  deleted: number;
  freedBytes: number;
}

interface Candidate {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Delete the recall stashes written by one session. Stashes are namespaced at
 *  write time as `pruned-raw-<sessionId>-<hex>.txt` (see stashPath() in
 *  index.ts), so this only ever touches files that session created — a live
 *  session with a different id is never affected. Best-effort, never-throwing.
 *
 *  Returns an empty result when the id is missing/unsafe (e.g. `"unknown"`):
 *  those stashes are left for the load-time age/size reaper, so a session whose
 *  id could not be resolved never has its recall raw evicted early. */
export async function reapSessionStashes(
  sessionId: string | undefined | null,
  options: { tmpDir?: string } = {},
): Promise<SessionReapResult> {
  const result: SessionReapResult = { scanned: 0, deleted: 0, freedBytes: 0 };
  if (!isSafeSessionId(sessionId)) return result;
  const id = sessionId as string;
  const dir = options.tmpDir ?? tmpdir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result; // tmpdir unreadable/missing — nothing to do
  }

  const prefix = `${STASH_PREFIX}${id}-`;
  const targets: Candidate[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(STASH_SUFFIX)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      targets.push({ name, path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // stat failed (race / permissions) — skip
    }
  }
  result.scanned = targets.length;

  for (const c of targets) {
    try {
      await unlink(c.path);
      result.deleted++;
      result.freedBytes += c.size;
    } catch {
      // already gone / locked — skip
    }
  }
  return result;
}

/** Delete orphaned pruned-raw recall stashes by age and total size.
 *  Never throws — best-effort. */
export async function reapPrunedRawStashes(
  options: PrunedRawReapOptions = {},
): Promise<PrunedRawReapResult> {
  return reapTempFiles(
    (name) => name.startsWith(STASH_PREFIX) && name.endsWith(STASH_SUFFIX),
    options,
  );
}
