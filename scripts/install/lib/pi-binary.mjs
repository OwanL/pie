// Shared `pi` CLI binary resolution for the pie installers.
//
// After `npm i -g @earendil-works/pi-coding-agent`, the `pi` executable is not
// on PATH until a new shell opens. Both installers therefore resolve `pi` by
// preferring PATH, then probing the npm global prefix. Previously duplicated
// as:
//   - install.ps1: Resolve-PiBinary (pi.cmd / pi.ps1 / pi under the prefix)
//   - install.sh:  resolve_pi        ($prefix/bin/pi / $prefix/pi)
//
// `resolvePiBinary` is pure given injected probes so it is unit-testable; the
// CLI runner performs the real PATH/prefix discovery.

import { existsSync as fsExistsSync, statSync as fsStatSync } from 'node:fs';
import path from 'node:path';

/**
 * Search PATH manually for an executable, with no external `which`/`where.exe`
 * dependency (some minimal POSIX images lack `which`). On Windows, honours
 * PATHEXT so `pi` resolves to `pi.cmd` (the runnable shim), skipping any
 * extensionless shebang script that `where.exe` would list first. On POSIX the
 * candidate must be executable.
 *
 * @param {{ name?: string, platform?: 'win32' | 'posix', env?: Record<string, string | undefined>, existsSync?: (p: string) => boolean, isExecutable?: (p: string) => boolean }} [options]
 * @returns {string | null}
 */
export function lookupOnPath({
  name = 'pi',
  platform = process.platform,
  env = process.env,
  existsSync,
  isExecutable,
} = {}) {
  const checkExists = existsSync ?? fsExistsSync;
  const checkExec = isExecutable ?? ((file) => {
    try { return (fsStatSync(file).mode & 0o111) !== 0; } catch { return false; }
  });
  const p = platform === 'win32' ? path.win32 : path.posix;
  const pathVar = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC').split(';').filter(Boolean)
    : [''];
  for (const dir of pathVar) {
    for (const ext of exts) {
      const candidate = p.join(dir, `${name}${ext}`);
      if (checkExists(candidate) && (platform === 'win32' || checkExec(candidate))) return candidate;
    }
  }
  return null;
}

/**
 * @param {{
 *   platform?: 'win32' | 'posix',
 *   prefix?: string,
 *   onPath?: string | null,
 *   existsSync?: (p: string) => boolean,
 *   isExecutable?: (p: string) => boolean,
 * }} [options]
 * @returns {string | null} absolute path to the pi binary, or null if not found
 */
export function resolvePiBinary({
  platform = process.platform,
  prefix = '',
  onPath = null,
  existsSync,
  isExecutable,
} = {}) {
  if (onPath) return onPath;
  if (!prefix) return null;

  const checkExists = existsSync ?? fsExistsSync;
  // On POSIX the candidate must be executable; default to "exists" when no
  // executable probe is injected (Windows .cmd/.ps1 have no exec bit).
  const checkExec = isExecutable ?? (() => true);

  // Use the platform-specific path module so probing is correct even when the
  // `platform` option differs from the host (e.g. unit tests on Windows probing
  // POSIX layouts). In production platform defaults to process.platform, so
  // this is equivalent to native path.join on the host.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const candidates = platform === 'win32'
    ? [p.join(prefix, 'pi.cmd'), p.join(prefix, 'pi.ps1'), p.join(prefix, 'pi')]
    : [p.join(prefix, 'bin', 'pi'), p.join(prefix, 'pi')];

  for (const candidate of candidates) {
    if (checkExists(candidate) && checkExec(candidate)) return candidate;
  }
  return null;
}
