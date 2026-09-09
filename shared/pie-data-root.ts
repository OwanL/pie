/**
 * Canonical OS-local runtime-data root resolution.
 *
 * This module only resolves paths. It does not create, migrate, delete, or
 * redirect existing data. A relative PIE_DATA_DIR is intentionally rooted at
 * the resolved agent directory so it cannot accidentally become cwd-relative.
 */

import os from 'node:os';
import path from 'node:path';

export const PIE_DATA_DIR_ENV = 'PIE_DATA_DIR' as const;

export const PIE_DATA_SUBDIRECTORIES = {
  analytics: 'analytics',
  sessions: 'sessions',
  artifacts: 'artifacts',
  state: 'state',
  cache: 'cache',
} as const;

export type PieDataSubdirectory = keyof typeof PIE_DATA_SUBDIRECTORIES;

export interface PieDataRootResolutionOptions {
  /** Explicit override. Undefined means read `PIE_DATA_DIR`. */
  dataDir?: string;
  /** Required when `dataDir` is relative. Undefined means read the SDK env. */
  agentDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppDataDir?: string;
  xdgDataHome?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface PieDataRootPaths {
  rootDir: string;
  analyticsDir: string;
  sessionsDir: string;
  artifactsDir: string;
  stateDir: string;
  cacheDir: string;
}

export class PieDataRootResolutionError extends Error {
  readonly code = 'PIE_DATA_ROOT_UNRESOLVED';

  constructor(message: string) {
    super(message);
    this.name = 'PieDataRootResolutionError';
  }
}

function environmentFor(options: PieDataRootResolutionOptions): Readonly<Record<string, string | undefined>> {
  return options.environment ?? process.env;
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  // `path.win32` and `path.posix` expose the same shape for the operations used
  // here. Selecting by target platform keeps resolver tests deterministic when
  // they run on a different host OS.
  return (platform === 'win32' ? path.win32 : path.posix) as typeof path.posix;
}

function cleanConfiguredPath(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new PieDataRootResolutionError(`${name} is configured but empty.`);
  if (trimmed.includes('\u0000')) throw new PieDataRootResolutionError(`${name} contains a NUL byte.`);
  return trimmed;
}

function expandTilde(value: string, homeDir: string, pathApi: typeof path.posix): string {
  if (value === '~') return homeDir;
  const separator = pathApi.sep;
  if (value.startsWith(`~${separator}`)) return pathApi.join(homeDir, value.slice(2));
  // Accept the other common separator in a configuration file without
  // changing the native separator used for the resolved path.
  if (value.startsWith('~/') || value.startsWith('~\\')) return pathApi.join(homeDir, value.slice(2));
  return value;
}

function requireAbsolute(value: string, name: string, pathApi: typeof path.posix): string {
  if (!pathApi.isAbsolute(value)) {
    throw new PieDataRootResolutionError(`${name} must be an absolute path.`);
  }
  return pathApi.normalize(value);
}

function resolveHomeDir(
  options: PieDataRootResolutionOptions,
  env: Readonly<Record<string, string | undefined>>,
  pathApi: typeof path.posix,
): string {
  const configured = cleanConfiguredPath(options.homeDir ?? env.HOME ?? env.USERPROFILE, 'home directory');
  const homeDir = configured ?? os.homedir();
  if (!homeDir) throw new PieDataRootResolutionError('Unable to resolve the user home directory.');
  return requireAbsolute(homeDir, 'home directory', pathApi);
}

function resolveAgentDir(
  options: PieDataRootResolutionOptions,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
  pathApi: typeof path.posix,
): string | undefined {
  const configured = cleanConfiguredPath(options.agentDir ?? env.PI_CODING_AGENT_DIR, 'agent directory');
  if (configured === undefined) return undefined;
  return requireAbsolute(expandTilde(configured, homeDir, pathApi), 'agent directory', pathApi);
}

function defaultRoot(
  options: PieDataRootResolutionOptions,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homeDir: string,
  pathApi: typeof path.posix,
): string {
  if (platform === 'win32') {
    const localAppData = cleanConfiguredPath(
      options.localAppDataDir ?? env.LOCALAPPDATA,
      'LOCALAPPDATA',
    );
    if (localAppData === undefined) {
      throw new PieDataRootResolutionError(
        'LOCALAPPDATA is unavailable; set PIE_DATA_DIR explicitly instead of falling back to another root.',
      );
    }
    return pathApi.join(requireAbsolute(localAppData, 'LOCALAPPDATA', pathApi), 'pie', 'data');
  }
  if (platform === 'darwin') return pathApi.join(homeDir, 'Library', 'Application Support', 'pie', 'data');
  const xdg = cleanConfiguredPath(options.xdgDataHome ?? env.XDG_DATA_HOME, 'XDG_DATA_HOME');
  const base = xdg === undefined ? pathApi.join(homeDir, '.local', 'share') : requireAbsolute(xdg, 'XDG_DATA_HOME', pathApi);
  return pathApi.join(base, 'pie', 'data');
}

/** Resolve only the canonical root. No filesystem operation is performed. */
export function resolvePieDataRoot(options: PieDataRootResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  const env = environmentFor(options);
  const configured = cleanConfiguredPath(
    options.dataDir ?? env[PIE_DATA_DIR_ENV],
    PIE_DATA_DIR_ENV,
  );

  // An absolute override is self-contained: do not make an otherwise valid
  // explicit authority depend on HOME being present in the environment.
  if (configured !== undefined && pathApi.isAbsolute(configured)) return pathApi.normalize(configured);

  const homeDir = resolveHomeDir(options, env, pathApi);
  const agentDir = resolveAgentDir(options, env, homeDir, pathApi);
  if (configured !== undefined) {
    const expanded = expandTilde(configured, homeDir, pathApi);
    if (pathApi.isAbsolute(expanded)) return pathApi.normalize(expanded);
    if (agentDir === undefined) {
      throw new PieDataRootResolutionError(
        'A relative PIE_DATA_DIR requires PI_CODING_AGENT_DIR or an explicit agentDir.',
      );
    }
    return pathApi.resolve(agentDir, expanded);
  }
  return defaultRoot(options, env, platform, homeDir, pathApi);
}

/** Resolve the root and the stable category directories used by later
 * analytics/session cutovers. Directories are not created here. */
export function resolvePieDataPaths(options: PieDataRootResolutionOptions = {}): PieDataRootPaths {
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

export function resolvePieDataSubdirectory(
  rootDir: string,
  subdirectory: PieDataSubdirectory,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = pathApiFor(platform);
  const root = cleanConfiguredPath(rootDir, 'data root');
  if (root === undefined) throw new PieDataRootResolutionError('data root is required.');
  return pathApi.join(requireAbsolute(root, 'data root', pathApi), PIE_DATA_SUBDIRECTORIES[subdirectory]);
}
