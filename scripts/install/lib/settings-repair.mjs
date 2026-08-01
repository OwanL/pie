// Shared "repair extension paths" logic for the pie installers.
//
// settings.json is git-tracked and may reference extension packages via
// absolute paths into ANOTHER machine's npm global node_modules tree (e.g.
// C:/Users/<other-user>/AppData/Roaming/npm/node_modules/<pkg>). On a fresh
// machine those paths don't exist, so `pi update --extensions` breaks. This
// module rewrites each such entry to THIS machine's `npm config get prefix` so
// pi can load them, preserving entries that already point at the right place
// (idempotent: a second run produces no diff).
//
// Previously duplicated as:
//   - install.ps1: Repair-SettingsExtensionPaths
//   - install.sh:  inline `node - <<'NODE_SCRIPT'` repair_settings_extension_paths
// Both are now thin callers of `repairExtensionPaths` below.

import { existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';

const EXTENSION_PATH_TAIL = /[\\/]node_modules[\\/]+([^\\/]+)$/;

/**
 * Decide whether a string entry is an absolute path that ends inside a
 * `node_modules/<pkg>` tree (the only entries we rewrite).
 * @param {string} entry
 * @param {'win32' | 'posix'} platform
 * @returns {boolean}
 */
function isRewritableAbsoluteExtensionPath(entry, platform) {
  if (typeof entry !== 'string') return false;
  const sep = platform === 'win32' ? '\\' : '/';
  // Match install.sh's check exactly: normalise forward slashes to the native
  // separator before testing absoluteness. On POSIX this is a no-op; on Windows
  // it lets `path.win32.isAbsolute` see `C:\...` instead of `C:/...`.
  if (!path[platform].isAbsolute(entry.replace(/\//g, sep))) return false;
  return EXTENSION_PATH_TAIL.test(entry);
}

/**
 * Pure, side-effect-free extension-path repair.
 *
 * @param {unknown} settings - parsed settings.json object
 * @param {{ npmPrefix: string, platform?: 'win32' | 'posix', existsSync?: (p: string) => boolean }} options
 * @returns {{
 *   settings: unknown,
 *   changed: boolean,
 *   rewritten: Array<{ from: string, to: string, pkg: string }>,
 *   missing: string[],
 * }}
 */
export function repairExtensionPaths(settings, { npmPrefix, platform = process.platform, existsSync }) {
  const checkExists = existsSync ?? fsExistsSync;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { settings, changed: false, rewritten: [], missing: [] };
  }
  const extensions = settings.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return { settings, changed: false, rewritten: [], missing: [] };
  }
  if (!npmPrefix) return { settings, changed: false, rewritten: [], missing: [] };

  const sep = platform === 'win32' ? '\\' : '/';
  const rewritten = [];
  const missing = [];
  let changed = false;

  const normalized = extensions.map((entry) => {
    if (!isRewritableAbsoluteExtensionPath(entry, platform)) return entry;
    const entryStr = String(entry);
    const pkg = EXTENSION_PATH_TAIL.exec(entryStr)[1];
    const candidate = `${npmPrefix}${sep}node_modules${sep}${pkg}`;
    // Case-insensitive, slash-normalised comparison so we don't rewrite an
    // entry that already points at the right place (idempotent). Matches both
    // install.ps1 (-ne is case-insensitive) and install.sh (.toLowerCase()).
    const same =
      entryStr.replace(/\\/g, '/').toLowerCase() ===
      candidate.replace(/\\/g, '/').toLowerCase();
    if (same) return entryStr;
    changed = true;
    rewritten.push({ from: entryStr, to: candidate, pkg });
    if (!checkExists(candidate)) missing.push(pkg);
    return candidate;
  });

  if (!changed) return { settings, changed: false, rewritten: [], missing: [] };
  return { settings: { ...settings, extensions: normalized }, changed: true, rewritten, missing };
}
