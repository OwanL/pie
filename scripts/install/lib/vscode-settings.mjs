// Shared VS Code User-settings helper for the Windows installer.
//
// The extension host reads `pie.agentDir` and forwards it to the backend as
// PI_CODING_AGENT_DIR, because VS Code only picks up new User env vars on a
// full restart (not a window reload). Setting `pie.agentDir` in VS Code's own
// settings.json makes the backend use the correct agent dir on the first
// reload after install.
//
// `mergeAgentDirSetting` is pure; `resolveVscodeSettingsDirs` keeps portable
// path resolution for isolated tests and direct helper reuse.

import os from 'node:os';
import path from 'node:path';

/**
 * Candidate VS Code User settings directories for the current platform.
 * The supported Windows installer uses %APPDATA%/Code/User. Portable fallback
 * paths remain available for isolated tests and direct helper reuse. Only
 * directories that actually exist are written to by the runner.
 *
 * @param {{ platform?: 'win32' | 'posix', env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string[]}
 */
export function resolveVscodeSettingsDirs({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const p = path.win32;
    return appData ? [p.join(appData, 'Code', 'User')] : [];
  }
  const p = path.posix;
  const xdg = env.XDG_CONFIG_HOME || p.join(homedir, '.config');
  return [
    p.join(xdg, 'Code', 'User'),
    p.join(homedir, 'Library', 'Application Support', 'Code', 'User'),
    p.join(xdg, 'Code - OSS', 'User'),
  ];
}

/**
 * Pure merge: set `pie.agentDir` to `repoRoot` if it isn't already.
 * @param {Record<string, unknown>} settings
 * @param {string} repoRoot
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function mergeAgentDirSetting(settings, repoRoot) {
  const current = settings && typeof settings === 'object' ? settings['pie.agentDir'] : undefined;
  if (current === repoRoot) return { settings, changed: false };
  return { settings: { ...settings, 'pie.agentDir': repoRoot }, changed: true };
}
