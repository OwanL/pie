// Shared session-history migration core for the pie installers.
//
// Session JSONL transcripts are kept machine-local under
// `data/outcomes/sessions/<bucket>/<file>.jsonl`, where `<bucket>` is derived
// from the session's recorded cwd. This module migrates (or merges) legacy
// session stores into that checkout-local destination, preserving conflicting
// copies in `.conflict.*.bak` backups when the source and destination differ.
//
// Previously duplicated as:
//   - install.sh:  scripts/migrate-local-sessions.mjs (the canonical Node impl)
//   - install.ps1: Merge-LegacySessionFiles + Get-SessionHeaderCwd +
//                  Get-SessionContentTimestamp + Get-DefaultSessionBucketName
// install.ps1 now delegates to `mergeLegacySessions`; install.sh's runner keeps
// its exact behaviour by calling the same core.
//
// The file-merge semantics are preserved exactly from the original
// migrate-local-sessions.mjs: SHA-256 equality short-circuits; otherwise the
// newer "latest timestamp" (max of file mtime and any parsed `timestamp` field)
// wins, and the loser is preserved as a `.conflict.<uuid>.bak` (or
// `.conflict.<uuid>.incoming.bak` when the incoming source is older).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * List `*.jsonl` files under `root`, recursively by default.
 * Non-existent roots return an empty list (matches the original behaviour).
 * @param {string} root
 * @param {{ recursive?: boolean }} [options]
 * @returns {string[]}
 */
export function listJsonlFiles(root, { recursive = true } = {}) {
  if (!existsSync(root)) return [];
  if (recursive) {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(root, entry.name));
}

/**
 * Does a directory contain any `.jsonl` file? (Used by install.ps1 to decide
 * whether a legacy store is worth importing and to re-check after migration.)
 * @param {string} root
 * @param {{ recursive?: boolean }} [options]
 * @returns {boolean}
 */
export function directoryHasJsonlFiles(root, { recursive = true } = {}) {
  return listJsonlFiles(root, { recursive }).length > 0;
}

/**
 * Bucket name for a session cwd: `--<slug>--` with path separators/colons
 * replaced by `-` and any leading separator stripped. Unknown cwd -> the
 * `--unknown--` bucket (matches the original).
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function defaultSessionBucketName(cwd) {
  if (!cwd) return '--unknown--';
  const trimmed = cwd.replace(/^[\\/]+/, '');
  const safe = trimmed.replace(/[\\/:]/g, '-');
  return `--${safe}--`;
}

/**
 * Read a session JSONL file's header cwd and latest content timestamp.
 * - `bucket` is derived from the first `{"type":"session","cwd":...}` line.
 * - `latest` is the max of the file mtime and any parsed `timestamp` field
 *   (milliseconds since epoch). Malformed lines are skipped, never fatal.
 * @param {string} file
 * @returns {{ bucket: string, latest: number }}
 */
export function sessionInfo(file) {
  let cwd;
  let latest = statSync(file).mtimeMs;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === 'session' && value.cwd) cwd = value.cwd;
      if (value.timestamp) latest = Math.max(latest, Date.parse(value.timestamp) || 0);
    } catch {
      /* malformed legacy lines do not block migration */
    }
  }
  return { bucket: defaultSessionBucketName(cwd), latest };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Merge one legacy source directory into the destination.
 * @param {string} sourceRoot
 * @param {string} destination
 * @param {{ recursive?: boolean }} [options]
 * @returns {{ copied: number, updated: number, identical: number, conflicts: number }}
 */
function mergeSource(sourceRoot, destination, { recursive = true } = {}) {
  let copied = 0;
  let updated = 0;
  let identical = 0;
  let conflicts = 0;

  for (const source of listJsonlFiles(sourceRoot, { recursive })) {
    const info = sessionInfo(source);
    const targetDir = path.join(destination, info.bucket);
    const target = path.join(targetDir, path.basename(source));
    // Ensure the bucket directory exists (mkdirSync is idempotent).
    mkdirSync(targetDir, { recursive: true });

    if (!existsSync(target)) {
      copyFileSync(source, target);
      copied += 1;
      continue;
    }
    if (sha256(source) === sha256(target)) {
      identical += 1;
      continue;
    }
    const targetInfo = sessionInfo(target);
    const suffix = randomUUID().replaceAll('-', '');
    if (info.latest > targetInfo.latest) {
      copyFileSync(target, `${target}.conflict.${suffix}.bak`);
      copyFileSync(source, target);
      updated += 1;
    } else {
      copyFileSync(source, `${target}.conflict.${suffix}.incoming.bak`);
    }
    conflicts += 1;
  }
  return { copied, updated, identical, conflicts };
}

/**
 * Merge multiple legacy session sources into a checkout-local destination.
 *
 * Sources are de-duplicated by resolved path + recursiveness, and any source
 * that resolves to the destination itself is skipped (avoids self-copy). The
 * destination directory is created lazily when there is at least one file to
 * write.
 *
 * @param {{ sources: Array<{ path: string, recursive?: boolean }>, destination: string }} input
 * @returns {{
 *   totals: { copied: number, updated: number, identical: number, conflicts: number },
 *   perSource: Array<{ path: string, recursive: boolean, result: { copied: number, updated: number, identical: number, conflicts: number }, skipped: boolean }>,
 *   migrated: boolean,
 * }}
 */
export function mergeLegacySessions({ sources, destination }) {
  const seen = new Set();
  const totals = { copied: 0, updated: 0, identical: 0, conflicts: 0 };
  const perSource = [];
  const resolvedDestination = path.resolve(destination);

  for (const source of sources) {
    const recursive = source.recursive !== false;
    const resolvedSource = path.resolve(source.path);
    const key = `${resolvedSource}|${recursive}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (resolvedSource === resolvedDestination) {
      perSource.push({ path: source.path, recursive, result: { copied: 0, updated: 0, identical: 0, conflicts: 0 }, skipped: true });
      continue;
    }
    if (!existsSync(resolvedSource)) {
      perSource.push({ path: source.path, recursive, result: { copied: 0, updated: 0, identical: 0, conflicts: 0 }, skipped: true });
      continue;
    }

    const result = mergeSource(resolvedSource, resolvedDestination, { recursive });
    totals.copied += result.copied;
    totals.updated += result.updated;
    totals.identical += result.identical;
    totals.conflicts += result.conflicts;
    perSource.push({ path: source.path, recursive, result, skipped: false });
  }

  return { totals, perSource, migrated: totals.copied + totals.updated + totals.conflicts > 0 };
}
