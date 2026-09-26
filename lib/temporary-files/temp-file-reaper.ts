/**
 * Shared age + total-size eviction algorithm for temporary files in the OS
 * tmpdir.
 *
 * Both the VS Code extension host (which reaps the SDK's `pi-bash-*.log` /
 * `pi-output-*.log`) and the tool-result-pruner pi extension (which reaps
 * `pruned-raw-*.txt` recall stashes) use the identical two-phase algorithm:
 *
 *   1. Delete files older than `maxAgeDays`.
 *   2. Cap the total size of survivors at `maxTotalSizeMb` by evicting oldest
 *      first.
 *
 * This module provides that algorithm; each caller supplies a `matches`
 * predicate that selects its own file pattern. Session-scoped reaping (e.g.
 * deleting one session's stashes at shutdown) is NOT shared — it stays in the
 * extension that needs it.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ReapOptions {
  /** Delete files older than this many days. Default 7. */
  maxAgeDays?: number;
  /** Once files under the age cutoff are kept, evict the oldest until the
   *  combined size of survivors is under this cap (MB). Default 500. */
  maxTotalSizeMb?: number;
  /** Override the tmpdir (tests). */
  tmpDir?: string;
  /** Override the clock (tests). */
  now?: () => number;
}

export interface ReapResult {
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

/** Default age cutoff (days) and total-size cap (MB). Callers may override. */
export const DEFAULT_MAX_AGE_DAYS = 7;
export const DEFAULT_MAX_TOTAL_SIZE_MB = 500;

/** Delete orphaned temp files by age and total size. Never throws — best-effort.
 *
 *  @param matches Predicate that returns true for filenames this caller owns
 *                 (e.g. `name.startsWith("pi-bash-") && name.endsWith(".log")`).
 *  @param options Age/size limits and test seams. */
export async function reapTempFiles(
  matches: (name: string) => boolean,
  options: ReapOptions = {},
): Promise<ReapResult> {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxTotalSizeMb = options.maxTotalSizeMb ?? DEFAULT_MAX_TOTAL_SIZE_MB;
  const dir = options.tmpDir ?? tmpdir();
  const now = (options.now ?? Date.now)();
  const result: ReapResult = { scanned: 0, deleted: 0, freedBytes: 0 };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result; // tmpdir unreadable/missing — nothing to do
  }

  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (!matches(name)) continue;
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

  // 1. Delete files older than the age cutoff. `maxAgeDays: 0` disables
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
