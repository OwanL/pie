// Shared auth.json helpers for the pie installers.
//
// Covers the duplicated credential operations:
//   - split-brain merge (in-tree auth.json -> secure PI_CODING_AGENT_AUTH_DIR
//     location, in-tree wins on conflict), previously duplicated as
//       install.ps1: Read-AuthJson / Write-AuthJson + Compare-Object merge
//       install.sh:  inline `node -e` deep-merge
//   - "has real content" detection used by the post-install readiness check,
//     previously duplicated as inline `node -e` snippets in both installers.
//
// The merge compares provider credential blocks by JSON serialisation (the
// install.sh canonical behaviour). install.ps1 previously used Compare-Object,
// which is order/representation-sensitive; JSON-stringify comparison is the
// robust, cross-platform equivalent and produces the same merged result.

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile } from './json.mjs';

/**
 * Read auth.json as a plain object, returning `{}` for missing/unreadable
 * files (matches Read-AuthJson's safe fallback).
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
export function readAuthProviders(filePath) {
  const data = readJsonFile(filePath, { fallback: {} });
  return data && typeof data === 'object' && !Array.isArray(data)
    ? /** @type {Record<string, unknown>} */ (data)
    : {};
}

/**
 * Non-empty provider keys in an auth object (used for readiness reporting).
 * @param {Record<string, unknown>} auth
 * @returns {string[]}
 */
export function authProviderNames(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [];
  return Object.keys(auth).filter((key) => key && key.length > 0);
}

/**
 * True iff the auth object has at least one provider entry (real credentials,
 * not just `{}`).
 * @param {Record<string, unknown>} auth
 * @returns {boolean}
 */
export function authHasContent(auth) {
  return authProviderNames(auth).length > 0;
}

/**
 * Deep-merge in-tree provider credentials into the secure auth object.
 * In-tree wins on conflict (it is the freshest write). Returns the merged
 * secure object and the number of providers added/updated.
 *
 * @param {Record<string, unknown>} inTree
 * @param {Record<string, unknown>} secure
 * @returns {{ secure: Record<string, unknown>, mergedCount: number }}
 */
export function mergeAuthProviders(inTree, secure) {
  const result = { ...secure };
  let mergedCount = 0;
  for (const [provider, creds] of Object.entries(inTree)) {
    if (JSON.stringify(result[provider]) !== JSON.stringify(creds)) {
      result[provider] = creds;
      mergedCount += 1;
    }
  }
  return { secure: result, mergedCount };
}

/**
 * SHA-256 of a file's bytes (node crypto — no `certutil`/`shasum`/`sha256sum`
 * dependency, so it is locale-independent and cross-platform).
 * @param {string} file
 * @returns {string}
 */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Atomically relocate auth.json from the working tree into a secure location:
 * create the target dir, copy, and verify the copy byte-for-byte via SHA-256. On
 * a mismatch the partial target is removed and the move is reported as failed
 * (the source is left untouched either way).
 *
 * This is the testable, side-effect-bounded core of install.bat's first-time
 * credential relocation. The wrapper (install.bat) owns the surrounding steps
 * the Node subprocess cannot or should not do: the interactive prompt, the
 * Windows ACL restriction (icacls), `setx PI_CODING_AGENT_AUTH_DIR`, removing
 * the in-tree file, and writing the `auth.json.removed` breadcrumb — all of
 * which run only after this returns `ok: true`. install.ps1 did the same steps
 * inline in PowerShell; install.sh does the inline `shasum`/`sha256sum` + chmod
 * equivalent. On POSIX the destination is chmod 600 (a no-op concern on
 * Windows, which uses ACLs instead).
 *
 * @param {{ src: string, dest: string, platform?: 'win32' | 'posix' }} input
 * @returns {{ ok: boolean, dest?: string, reason?: 'hash-mismatch' }}
 */
export function relocateAuthFile({ src, dest, platform = process.platform }) {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (sha256File(src) !== sha256File(dest)) {
    rmSync(dest, { force: true });
    return { ok: false, reason: 'hash-mismatch' };
  }
  if (platform !== 'win32') {
    try { chmodSync(dest, 0o600); } catch { /* best-effort; matches install.sh */ }
  }
  return { ok: true, dest };
}
