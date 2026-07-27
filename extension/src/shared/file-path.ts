import * as os from 'node:os';
import * as path from 'node:path';

// ─── Canonical file-path identity ──────────────────────────────────────────
//
// A stable IDENTITY key for a file path so that the same file reached through
// different spellings — relative vs absolute, a leading `./`, `..` segments,
// mixed `/` and `\` separators, and (on case-insensitive filesystems) different
// casing — collapses to a single manifest entry.
//
// This is NOT a display path. Callers keep the original spelling for display
// (see `displayPath` in the session-changes tool) and use `canonicalFilePath`
// only as a Map/Set key and for manifest lookup. The derivation core, the host's
// live/batch paths, and the extension's JSONL path all share this one function
// so file identity is canonicalized consistently across parent/subagent edits
// and across the three derivation surfaces.

/** Whether the running OS uses case-insensitive filesystems by default.
 *  Windows and macOS are case-insensitive (macOS is case-preserving but
 *  case-insensitive for resolution by default); Linux is case-sensitive. */
const CASE_INSENSITIVE_FS = os.platform() === 'win32' || os.platform() === 'darwin';

/** Produce a canonical identity key for `filePath`, resolved against `cwd`
 *  when provided. Normalizes `.`/`..` segments, collapses `/` and `\`
 *  separators to `/`, and lowercases on case-insensitive filesystems so that
 *  `src/X.ts` and `src/x.ts` are the same file on Windows/macOS. */
export function canonicalFilePath(filePath: string, cwd?: string): string {
  if (!filePath) return filePath;
  // Resolve relative to cwd when available (so `src/x.ts` and `/proj/src/x.ts`
  // share a key); otherwise normalize in place (still collapses `./`, `..`,
  // and mixed separators). `path.resolve` with an absolute `filePath` returns
  // it normalized regardless of cwd.
  const resolved = cwd ? path.resolve(cwd, filePath) : path.normalize(filePath);
  // Normalize separators to '/' for cross-platform identity: `src\x.ts` and
  // `src/x.ts` are the same file. `path.resolve` already emits `path.sep`,
  // but input may carry the other separator; split on the platform sep and
  // also replace any literal opposite separators.
  let key = resolved.split(path.sep).join('/');
  if (path.sep !== '/') {
    key = key.split('\\').join('/');
  }
  if (CASE_INSENSITIVE_FS) key = key.toLowerCase();
  return key;
}
