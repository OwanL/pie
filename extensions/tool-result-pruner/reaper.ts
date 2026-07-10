import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";

/**
 * Reaper for the tool-result-pruner's recall stashes (audit item P1-7).
 *
 * writeStash() in index.ts writes the pre-pruning text of every lossy rewrite
 * to `pruned-raw-<hex>.txt` in the OS tmpdir so the agent can recall the raw
 * via the `read` tool. These stashes are never cleaned up — a new orphan
 * stream that accumulates one file per lossy pruned result. This is a
 * best-effort, never-throwing reaper run fire-and-forget on extension load.
 *
 * Mirrors extension/src/host/util/temp-log-reaper.ts (which reaps the SDK's
 * `pi-bash-*.log` / `pi-output-*.log`) but scoped to the `pruned-raw-` prefix
 * + `.txt` suffix. The tool-result-pruner is a separate pi extension (loaded
 * by the pi agent runtime, not the VS Code extension) and cannot import from
 * extension/src/, so this is implemented locally.
 */

const STASH_PREFIX = "pruned-raw-";
const STASH_SUFFIX = ".txt";
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_MAX_TOTAL_SIZE_MB = 500;

export interface PrunedRawReapOptions {
  /** Delete stashes older than this many days. Default 7. */
  maxAgeDays?: number;
  /** Once stashes under the age cutoff are kept, evict the oldest until the
   *  combined size of survivors is under this cap (MB). Default 500. */
  maxTotalSizeMb?: number;
  /** Override the tmpdir (tests). */
  tmpDir?: string;
  /** Override the clock (tests). */
  now?: () => number;
}

export interface PrunedRawReapResult {
  scanned: number;
  deleted: number;
  freedBytes: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Candidate {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Delete orphaned pruned-raw recall stashes by age and total size.
 *  Never throws — best-effort. */
export async function reapPrunedRawStashes(
  options: PrunedRawReapOptions = {},
): Promise<PrunedRawReapResult> {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxTotalSizeMb = options.maxTotalSizeMb ?? DEFAULT_MAX_TOTAL_SIZE_MB;
  const dir = options.tmpDir ?? tmpdir();
  const now = (options.now ?? Date.now)();
  const result: PrunedRawReapResult = { scanned: 0, deleted: 0, freedBytes: 0 };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result; // tmpdir unreadable/missing — nothing to do
  }

  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (!name.startsWith(STASH_PREFIX) || !name.endsWith(STASH_SUFFIX)) {
      continue;
    }
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      candidates.push({ name, path: full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // stat failed (race / permissions) — skip
    }
  }
  result.scanned = candidates.length;

  const ageCutoff = now - maxAgeDays * MS_PER_DAY;

  // 1. Delete stashes older than the age cutoff. `maxAgeDays: 0` disables
  //    age-based deletion (otherwise cutoff == now would delete everything).
  let agedOut: Candidate[] = [];
  let survivors = candidates;
  if (maxAgeDays > 0) {
    agedOut = candidates.filter((c) => c.mtimeMs < ageCutoff);
    survivors = candidates.filter((c) => c.mtimeMs >= ageCutoff);
  }

  // 2. Cap total size of survivors: evict oldest until under the cap.
  //    `maxTotalSizeMb: 0` disables the size cap (otherwise maxBytes == 0
  //    would evict every survivor).
  const sizeEvicted: Candidate[] = [];
  if (maxTotalSizeMb > 0) {
    const maxBytes = maxTotalSizeMb * 1024 * 1024;
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    let total = survivors.reduce((s, c) => s + c.size, 0);
    while (total > maxBytes && survivors.length > 0) {
      const ev = survivors.shift()!;
      sizeEvicted.push(ev);
      total -= ev.size;
    }
  }

  const toDelete = [...agedOut, ...sizeEvicted];
  for (const c of toDelete) {
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
