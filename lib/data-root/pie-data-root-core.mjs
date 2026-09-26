// JavaScript implementation shared by the TypeScript runtime API and the
// read-only installer/doctor. This module resolves paths only.

import os from 'node:os';
import path from 'node:path';

export const PIE_DATA_DIR_ENV = 'PIE_DATA_DIR';
export const PIE_DATA_SUBDIRECTORIES = Object.freeze({
  analytics: 'analytics', sessions: 'sessions', artifacts: 'artifacts', state: 'state', cache: 'cache',
});

export class PieDataRootResolutionError extends Error {
  code = 'PIE_DATA_ROOT_UNRESOLVED';
  constructor(message) {
    super(message);
    this.name = 'PieDataRootResolutionError';
  }
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function cleanConfiguredPath(value, name) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new PieDataRootResolutionError(`${name} is configured but empty.`);
  if (trimmed.includes('\u0000')) throw new PieDataRootResolutionError(`${name} contains a NUL byte.`);
  return trimmed;
}

function expandTilde(value, homeDir, pathApi) {
  if (value === '~') return homeDir;
  if (value.startsWith(`~${pathApi.sep}`)) return pathApi.join(homeDir, value.slice(2));
  if (value.startsWith('~/') || value.startsWith('~\\')) return pathApi.join(homeDir, value.slice(2));
  return value;
}

function requireAbsolute(value, name, pathApi) {
  if (!pathApi.isAbsolute(value)) throw new PieDataRootResolutionError(`${name} must be an absolute path.`);
  return pathApi.normalize(value);
}

function resolveHomeDir(options, env, pathApi) {
  const configured = cleanConfiguredPath(options.homeDir ?? env.HOME ?? env.USERPROFILE, 'home directory');
  const homeDir = configured ?? os.homedir();
  if (!homeDir) throw new PieDataRootResolutionError('Unable to resolve the user home directory.');
  return requireAbsolute(homeDir, 'home directory', pathApi);
}

function resolveAgentDir(options, env, homeDir, pathApi) {
  const configured = cleanConfiguredPath(options.agentDir ?? env.PI_CODING_AGENT_DIR, 'agent directory');
  if (configured === undefined) return undefined;
  return requireAbsolute(expandTilde(configured, homeDir, pathApi), 'agent directory', pathApi);
}

function defaultRoot(options, env, platform, homeDir, pathApi) {
  if (platform === 'win32') {
    const localAppData = cleanConfiguredPath(options.localAppDataDir ?? env.LOCALAPPDATA, 'LOCALAPPDATA');
    if (localAppData === undefined) {
      throw new PieDataRootResolutionError('LOCALAPPDATA is unavailable; set PIE_DATA_DIR explicitly instead of falling back to another root.');
    }
    return pathApi.join(requireAbsolute(localAppData, 'LOCALAPPDATA', pathApi), 'pie', 'data');
  }
  if (platform === 'darwin') return pathApi.join(homeDir, 'Library', 'Application Support', 'pie', 'data');
  const xdg = cleanConfiguredPath(options.xdgDataHome ?? env.XDG_DATA_HOME, 'XDG_DATA_HOME');
  const base = xdg === undefined ? pathApi.join(homeDir, '.local', 'share') : requireAbsolute(xdg, 'XDG_DATA_HOME', pathApi);
  return pathApi.join(base, 'pie', 'data');
}

export function resolvePieDataRoot(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const env = options.environment ?? process.env;
  const configured = cleanConfiguredPath(options.dataDir ?? env[PIE_DATA_DIR_ENV], PIE_DATA_DIR_ENV);
  if (configured !== undefined && pathApi.isAbsolute(configured)) return pathApi.normalize(configured);
  const homeDir = resolveHomeDir(options, env, pathApi);
  const agentDir = resolveAgentDir(options, env, homeDir, pathApi);
  if (configured !== undefined) {
    const expanded = expandTilde(configured, homeDir, pathApi);
    if (pathApi.isAbsolute(expanded)) return pathApi.normalize(expanded);
    if (agentDir === undefined) throw new PieDataRootResolutionError('A relative PIE_DATA_DIR requires PI_CODING_AGENT_DIR or an explicit agentDir.');
    return pathApi.resolve(agentDir, expanded);
  }
  return defaultRoot(options, env, platform, homeDir, pathApi);
}

export function resolvePieDataPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const rootDir = resolvePieDataRoot(options);
  return {
    rootDir,
    analyticsDir: pathApi.join(rootDir, PIE_DATA_SUBDIRECTORIES.analytics),
    sessionsDir: pathApi.join(rootDir, PIE_DATA_SUBDIRECTORIES.sessions),
    artifactsDir: pathApi.join(rootDir, PIE_DATA_SUBDIRECTORIES.artifacts),
    stateDir: pathApi.join(rootDir, PIE_DATA_SUBDIRECTORIES.state),
    cacheDir: pathApi.join(rootDir, PIE_DATA_SUBDIRECTORIES.cache),
  };
}

export const resolvePieDataRootFromEnvironment = resolvePieDataRoot;
export const resolvePieDataRootPaths = resolvePieDataPaths;

export function resolvePieDataSubdirectory(rootDir, subdirectory, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  const root = cleanConfiguredPath(rootDir, 'data root');
  if (root === undefined) throw new PieDataRootResolutionError('data root is required.');
  return pathApi.join(requireAbsolute(root, 'data root', pathApi), PIE_DATA_SUBDIRECTORIES[subdirectory]);
}
