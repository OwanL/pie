import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';

/**
 * The pi SDK (@earendil-works/pi-coding-agent) writes a temp log to the OS
 * tmpdir every time a tool result is truncated — `pi-bash-*.log` for the bash
 * tool, `pi-output-*.log` for find/grep/ls. The SDK never deletes these; they
 * accumulate indefinitely (observed: 139 files / 75 MB over ~11 days, with one
 * 30 MB orphan from a single truncated grep). This is a best-effort, never-
 * throwing reaper run fire-and-forget on extension activation.
 */

const TEMP_LOG_PREFIXES = ['pi-bash-', 'pi-output-'] as const;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_MAX_TOTAL_SIZE_MB = 500;

export interface TempLogReapOptions {
  /** Delete temp logs older than this many days. Default 7. */
  maxAgeDays?: number;
  /** Once files under the age cutoff are kept, evict the oldest until the
   *  combined size of survivors is under this cap (MB). Default 500. */
  maxTotalSizeMb?: number;
  /** Override the tmpdir (tests). */
  tmpDir?: string;
  /** Override the clock (tests). */
  now?: () => number;
}

export interface TempLogReapResult {
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

/** Delete orphaned pi tool-output temp logs by age and total size.
 *  Never throws — best-effort. */
export async function reapTempLogs(
  options: TempLogReapOptions = {},
): Promise<TempLogReapResult> {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxTotalSizeMb = options.maxTotalSizeMb ?? DEFAULT_MAX_TOTAL_SIZE_MB;
  const dir = options.tmpDir ?? tmpdir();
  const now = (options.now ?? Date.now)();
  const result: TempLogReapResult = { scanned: 0, deleted: 0, freedBytes: 0 };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result; // tmpdir unreadable — nothing to do
  }

  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (!TEMP_LOG_PREFIXES.some((p) => name.startsWith(p)) || !name.endsWith('.log')) {
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