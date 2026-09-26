import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_SESSION_DIR = path.join('data', 'outcomes', 'sessions');

export interface HostSessionStoragePathOptions {
  /** Injectable for deterministic tests; production resolves relative agent dirs from the host cwd. */
  cwd?: string;
  /** Injectable for deterministic tests; production mirrors the SDK's homedir fallback. */
  homeDir?: string;
}

export interface HostSessionStoragePaths {
  agentDir?: string;
  sessionDir?: string;
  reviewsDir?: string;
  triggersDir?: string;
}

function expandTilde(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function resolveAbsolute(value: string, baseDir: string, homeDir: string): string {
  return path.resolve(baseDir, expandTilde(value, homeDir));
}

export function resolveSessionStorageDir(
  agentDir: string,
  configured: string | undefined,
): string | undefined {
  const value = configured?.trim();
  return value ? resolveAbsolute(value, agentDir, os.homedir()) : undefined;
}

/**
 * Resolve the host's single absolute authority for backend session storage.
 *
 * An explicit agent dir is trimmed, tilde-expanded, and resolved from the host
 * cwd. Its default configured-store path remains relative so it is applied
 * exactly once. When only an explicit relative session dir exists, the SDK's
 * default agent directory supplies the otherwise-missing base. With neither
 * setting present, no paths are synthesized and the child keeps SDK defaults.
 */
export function resolveHostSessionStoragePaths(
  configuredAgentDir: string | undefined,
  configuredSessionDir: string | undefined,
  options: HostSessionStoragePathOptions = {},
): HostSessionStoragePaths {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const agentValue = configuredAgentDir?.trim();
  const sessionValue = configuredSessionDir?.trim();

  let agentDir = agentValue
    ? resolveAbsolute(agentValue, cwd, homeDir)
    : undefined;
  const expandedSession = sessionValue ? expandTilde(sessionValue, homeDir) : undefined;

  if (!agentDir && expandedSession && !path.isAbsolute(expandedSession)) {
    agentDir = path.join(homeDir, '.pi', 'agent');
  }

  const requestedSessionDir = expandedSession ?? (agentDir ? DEFAULT_SESSION_DIR : undefined);
  if (!requestedSessionDir) return {};

  const sessionDir = path.isAbsolute(requestedSessionDir)
    ? path.resolve(requestedSessionDir)
    : path.resolve(agentDir ?? cwd, requestedSessionDir);
  return {
    ...(agentDir ? { agentDir } : {}),
    sessionDir,
    ...resolveSessionSidecarDirs(sessionDir),
  };
}

export function resolveSessionSidecarDirs(sessionDir: string | undefined): {
  reviewsDir?: string;
  triggersDir?: string;
} {
  if (!sessionDir) return {};
  const parent = path.dirname(sessionDir);
  return {
    reviewsDir: path.join(parent, 'session-reviews'),
    triggersDir: path.join(parent, 'deferred-triggers'),
  };
}
